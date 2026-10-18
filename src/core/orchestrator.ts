import type { Config } from "../config.ts";
import type { Adapter, AgentId, QuotaStatus, SessionRef } from "../adapters/types.ts";
import { listAdapters, getAdapter } from "../adapters/index.ts";
import { Ledger } from "./ledger.ts";
import { AgentProcess } from "./pty.ts";
import { Menu, type MenuRow } from "./menu.ts";
import { OutputScanner, isExhausted } from "./quota.ts";
import { buildBrief } from "./brief.ts";
import { diffStat } from "./git.ts";
import { CLEAR_SEQ, PASTE_END, PASTE_START, RESET_SEQ, out, termSize } from "./terminal.ts";
import { findHotkey, parseHotkeys, type HotkeySpec } from "./hotkey.ts";

interface Running {
  adapter: Adapter;
  /** True while the agent has the alternate screen active (tracked from its output). */
  altScreen: boolean;
  proc: AgentProcess;
  ref: SessionRef | null;
  scanner: OutputScanner;
  sessionId?: string;
  pendingPrompt?: string;
  lastOutputAt: number;
  firstOutputAt: number;
  timers: ReturnType<typeof setInterval>[];
}

/**
 * Owns the host terminal. Runs one agent TUI at a time inside a PTY, passes
 * bytes through, opens the codemax menu on the hotkey, and performs switches.
 */
export class Orchestrator {
  private running: Running | null = null;
  private menu: Menu | null = null;
  private detect = new Map<AgentId, { installed: boolean; version?: string }>();
  private quota = new Map<AgentId, QuotaStatus>();
  private switching = false;
  private resolveDone!: () => void;
  readonly done: Promise<void>;
  private decoder = new TextDecoder();
  private hotkeys: HotkeySpec[];

  constructor(
    private config: Config,
    private ledger: Ledger,
    private cwd: string,
  ) {
    this.done = new Promise((r) => (this.resolveDone = r));
    this.hotkeys = parseHotkeys(config.hotkeys);
    for (const [id, q] of Object.entries(ledger.quota())) this.quota.set(id as AgentId, q);
  }

  async start(agent: AgentId, fresh: boolean) {
    this.attachHost();
    await this.refreshDetect();
    const first = this.detect.get(agent)?.installed ? agent : this.firstInstalled();
    if (!first) {
      this.teardownHost();
      throw new Error("no supported agent CLI found on PATH");
    }
    if (first !== agent) out(`codemax: ${agent} not found, starting ${first}\r\n`);
    await this.launch(getAdapter(first), { fresh, reason: undefined });
    return this.done;
  }

  // ---------- host terminal ----------

  private onStdin = (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk);
    if (this.menu) {
      const action = this.menu.handleKey(bytes);
      if (action) void this.onMenuAction(action);
      return;
    }
    // The hotkey may share a chunk with other keys when typed quickly: forward
    // what came before it, open the menu, and let the menu see what followed.
    const hit = findHotkey(bytes, this.hotkeys);
    if (hit) {
      if (hit.index > 0) this.running?.proc.write(bytes.subarray(0, hit.index));
      this.openMenu("switch agent", true);
      const rest = bytes.subarray(hit.index + hit.length);
      const menu = this.menu as Menu | null; // openMenu() just set it; TS keeps the stale null narrowing
      if (rest.length && menu) {
        const action = menu.handleKey(rest);
        if (action) void this.onMenuAction(action);
      }
      return;
    }
    this.running?.proc.write(bytes);
  };

  private onResize = () => {
    const { cols, rows } = termSize();
    this.running?.proc.resize(cols, rows);
    this.menu?.render();
  };

  private attachHost() {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", this.onStdin);
    process.on("SIGWINCH", this.onResize);
    process.on("SIGINT", () => {}); // Ctrl+C is forwarded as a byte in raw mode
  }

  private teardownHost() {
    process.stdin.off("data", this.onStdin);
    process.off("SIGWINCH", this.onResize);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    out(RESET_SEQ);
  }

  // ---------- agent lifecycle ----------

  private async launch(adapter: Adapter, o: { fresh: boolean; reason?: string; from?: AgentId }) {
    const stale = this.quota.get(adapter.id);
    if (stale?.source === "output") {
      this.quota.delete(adapter.id);
      this.ledger.clearQuota(adapter.id);
    }
    const saved = this.ledger.sessions()[adapter.id];
    const resume = !o.fresh && saved ? saved : undefined;
    const sessionId = resume ? undefined : adapter.newSessionId?.();
    const hasHistory = this.ledger.turns().length > 0 || !!o.from;
    const brief = hasHistory ? await buildBrief({ ledger: this.ledger, cwd: this.cwd, to: adapter.id, from: o.from, reason: o.reason, config: this.config }) : undefined;

    const spec = adapter.launch({ cwd: this.cwd, resume, sessionId, prompt: brief, extraArgs: this.config.agentArgs[adapter.id] });
    out(RESET_SEQ + CLEAR_SEQ);

    const scanner = new OutputScanner(adapter.id, adapter.quotaPatterns, (q) => this.onQuota(q));
    const run: Running = {
      adapter,
      ref: resume ?? null,
      scanner,
      sessionId,
      pendingPrompt: spec.promptConsumed ? undefined : brief,
      lastOutputAt: 0,
      firstOutputAt: 0,
      altScreen: false,
      timers: [],
      proc: null as unknown as AgentProcess,
    };
    // Subscriptions only: an API key in the environment is never passed to an agent.
    const dropEnv = adapter.apiKeyEnv.filter((k) => process.env[k]);
    if (dropEnv.length) out(`codemax: unset ${dropEnv.join(", ")} for ${adapter.name} — codemax only uses subscription logins, never API keys\r\n`);
    run.proc = new AgentProcess({
      cmd: spec.cmd,
      cwd: this.cwd,
      env: spec.env,
      dropEnv,
      onData: (chunk) => {
        const now = Date.now();
        if (!run.firstOutputAt) run.firstOutputAt = now;
        run.lastOutputAt = now;
        if (!this.menu) process.stdout.write(chunk);
        const text = this.decoder.decode(chunk, { stream: true });
        trackAltScreen(run, text);
        scanner.feed(text);
      },
      onExit: (code) => void this.onAgentExit(run, code),
    });
    this.running = run;
    this.ledger.addEvent({ kind: o.from ? "switch" : "start", agent: o.from, to: adapter.id, detail: o.reason });

    run.timers.push(setInterval(() => void this.sync(run), 2000));
    if (run.pendingPrompt) run.timers.push(setInterval(() => this.maybeTypePrompt(run), 250));
    void this.locate(run);
  }

  /** Find the vendor session (transcript) for a freshly launched agent. Polls until the agent exits. */
  private async locate(run: Running) {
    if (run.ref) return;
    while (this.running === run && !run.proc.exited) {
      const ref = await run.adapter.locateSession({ cwd: this.cwd, startedAt: run.proc.startedAt, sessionId: run.sessionId });
      if (ref) {
        run.ref = ref;
        this.ledger.saveSession(ref);
        return;
      }
      await Bun.sleep(1000);
    }
  }

  /** Pull new turns + quota from the vendor transcript into the ledger. */
  private async sync(run: Running) {
    if (!run.ref) return;
    try {
      if (run.adapter.readTranscript) {
        const turns = await run.adapter.readTranscript(run.ref);
        if (this.ledger.addTurns(turns) > 0) {
          run.ref.lastUsedAt = Date.now();
          this.ledger.saveSession(run.ref);
        }
      }
      if (run.adapter.probeQuota) {
        const q = await run.adapter.probeQuota(run.ref);
        if (q) this.onQuota(q, true);
      }
    } catch {
      /* transcript mid-write; retry next tick */
    }
  }

  /** Type the handoff brief into TUIs that do not take a prompt argument. */
  private maybeTypePrompt(run: Running) {
    if (!run.pendingPrompt || !run.firstOutputAt) return;
    const now = Date.now();
    const quiet = now - run.lastOutputAt > 700;
    const old = now - run.proc.startedAt > 1500;
    const timeout = now - run.proc.startedAt > 15_000;
    if ((quiet && old) || timeout) {
      const text = run.pendingPrompt;
      run.pendingPrompt = undefined;
      run.proc.write(PASTE_START + text + PASTE_END);
      setTimeout(() => run.proc.write("\r"), 200);
    }
  }

  private onQuota(q: QuotaStatus, silent = false) {
    const prev = this.quota.get(q.agent);
    this.quota.set(q.agent, q);
    this.ledger.saveQuota(q);
    if (isExhausted(q) && !isExhausted(prev)) {
      this.ledger.addEvent({ kind: "quota", agent: q.agent, detail: q.detail });
      if (this.config.autoSwitch && !silent) this.offerSwitchWhenIdle(q);
    }
  }

  /** Open the menu for a quota hit only once the agent has stopped printing, so a stream is never cut. */
  private offerSwitchWhenIdle(q: QuotaStatus) {
    const run = this.running;
    const tick = setInterval(() => {
      if (this.running !== run || this.menu) return clearInterval(tick);
      if (Date.now() - (run?.lastOutputAt ?? 0) < 2000) return;
      clearInterval(tick);
      const guess = q.source === "output";
      this.openMenu(
        guess ? `${q.agent} may be out of quota — pick the next agent, or Esc if this is a false alarm` : `${q.agent} is out of quota — pick the next agent`,
        true,
        `${q.agent}: ${q.detail ?? "limit reached"}${guess ? " (screen text, not confirmed; forgotten in 30 min or when you relaunch it)" : ""}`,
      );
    }, 500);
  }

  private async onAgentExit(run: Running, code: number | null) {
    run.timers.forEach(clearInterval);
    if (this.running !== run) return; // killed by a switch; switch handles the rest
    await this.sync(run);
    this.ledger.addEvent({ kind: "exit", agent: run.adapter.id, detail: `exit ${code}`, diffStat: await diffStat(this.cwd) });
    this.running = null;
    out(RESET_SEQ);
    if (this.switching) return;
    this.openMenu(`${run.adapter.name} exited (${code}) — switch agent or quit`, false);
  }

  // ---------- menu ----------

  private async refreshDetect() {
    await Promise.all(
      listAdapters(this.config.order).map(async (a) => {
        const d = await a.detect();
        this.detect.set(a.id, { installed: d.installed, version: d.version });
      }),
    );
  }

  private firstInstalled(): AgentId | undefined {
    return listAdapters(this.config.order).find((a) => this.detect.get(a.id)?.installed)?.id;
  }

  private rows(): MenuRow[] {
    const sessions = this.ledger.sessions();
    return listAdapters(this.config.order).map((a) => ({
      adapter: a,
      installed: this.detect.get(a.id)?.installed ?? false,
      version: this.detect.get(a.id)?.version,
      session: sessions[a.id],
      quota: this.quota.get(a.id),
    }));
  }

  private openMenu(title: string, canClose: boolean, notice?: string) {
    if (this.menu) return;
    this.menu = new Menu({ title, rows: this.rows(), current: this.running?.adapter.id, notice, canClose, hotkeys: this.config.hotkeys });
    // If the agent already owns the alternate screen, draw over it instead of
    // nesting another alt-screen switch the terminal cannot unwind cleanly.
    this.menu.open(!this.running?.altScreen);
    void this.refreshDetect().then(() => this.menu?.update({ rows: this.rows() }));
  }

  private closeMenu() {
    this.menu?.close(!this.running?.altScreen);
    this.menu = null;
    this.running?.proc.jiggle();
  }

  private async onMenuAction(action: { kind: string; agent?: AgentId; fresh?: boolean }) {
    if (action.kind === "close") return this.closeMenu();
    if (action.kind === "quit") return this.quit();
    if (action.kind === "switch" && action.agent) {
      const target = getAdapter(action.agent);
      const current = this.running;
      if (current && current.adapter.id === target.id && !action.fresh) return this.closeMenu();
      this.menu?.update({ notice: `switching to ${target.name}…` });
      await this.switchTo(target, !!action.fresh);
    }
  }

  private async switchTo(target: Adapter, fresh: boolean) {
    this.switching = true;
    const prev = this.running;
    let from: AgentId | undefined;
    if (prev) {
      from = prev.adapter.id;
      prev.timers.forEach(clearInterval);
      this.running = null;
      await prev.proc.kill();
      await this.sync(prev);
      this.ledger.addEvent({ kind: "note", agent: from, detail: "stopped for switch", diffStat: await diffStat(this.cwd) });
    }
    this.menu?.close(false);
    this.menu = null;
    out(RESET_SEQ + CLEAR_SEQ + `codemax: handing off to ${target.name}…\r\n`);
    const fromQ = from ? this.quota.get(from) : undefined;
    const reason = fromQ && isExhausted(fromQ) ? (fromQ.source === "output" ? `${from} appeared to hit its usage limit` : `${from} ran out of quota`) : undefined;
    await this.launch(target, { fresh, from, reason });
    this.switching = false;
  }

  private async quit() {
    this.switching = true;
    const run = this.running;
    this.menu?.close(false);
    this.menu = null;
    if (run) {
      run.timers.forEach(clearInterval);
      this.running = null;
      await run.proc.kill();
      await this.sync(run);
      this.ledger.addEvent({ kind: "exit", agent: run.adapter.id, detail: "codemax quit", diffStat: await diffStat(this.cwd) });
    }
    this.teardownHost();
    out(`codemax: bye. ledger at ${this.ledger.dir}\n`);
    this.resolveDone();
  }
}

const ALT_RE = /\x1b\[\?(?:1049|1047|47)([hl])/g;
function trackAltScreen(run: Running, text: string) {
  let m: RegExpExecArray | null;
  while ((m = ALT_RE.exec(text))) run.altScreen = m[1] === "h";
}

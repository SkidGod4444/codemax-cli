import { BoxRenderable, TextRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import type { Config } from "../config.ts";
import { hotkeyLabel } from "../config.ts";
import type { Adapter, AgentId, QuotaStatus, SessionRef } from "../adapters/types.ts";
import { getAdapter, listAdapters } from "../adapters/index.ts";
import { Ledger } from "../core/ledger.ts";
import { buildBrief } from "../core/brief.ts";
import { diffStat } from "../core/git.ts";
import { OutputScanner, isExhausted, quotaLabel } from "../core/quota.ts";
import { findHotkey, parseHotkeys, type HotkeySpec } from "../core/hotkey.ts";
import type { MenuRow } from "../core/menu.ts";
import { AgentPane } from "./pane.ts";
import { MenuOverlay } from "./menu.ts";

interface Running {
  adapter: Adapter;
  pane: AgentPane;
  ref: SessionRef | null;
  scanner: OutputScanner;
  sessionId?: string;
  pendingPrompt?: string;
  lastOutputAt: number;
  firstOutputAt: number;
  timers: ReturnType<typeof setInterval>[];
}

const HOTKEY_NAMES: Record<string, string[]> = { "/": ["/", "_", "?"], "^": ["^", "6"] };

/**
 * codemax's own screen: an agent pane (embedded virtual terminal) above a
 * one-line status bar, with the agent menu as an overlay. Owns one agent at a
 * time and performs switches with handoff briefs.
 */
export class App {
  private running: Running | null = null;
  private menu: MenuOverlay | null = null;
  private detect = new Map<AgentId, { installed: boolean; version?: string }>();
  private quota = new Map<AgentId, QuotaStatus>();
  private hotkeys: HotkeySpec[];
  private paneHost: BoxRenderable;
  private statusText: TextRenderable;
  private statusMessage = "";
  private switching = false;
  private resolveDone!: () => void;
  readonly done: Promise<void>;

  constructor(
    readonly renderer: CliRenderer,
    private config: Config,
    private ledger: Ledger,
    private cwd: string,
  ) {
    this.done = new Promise((r) => (this.resolveDone = r));
    this.hotkeys = parseHotkeys(config.hotkeys);
    for (const [id, q] of Object.entries(ledger.quota())) this.quota.set(id as AgentId, q);

    const root = new BoxRenderable(renderer, { id: "codemax-root", width: "100%", height: "100%", flexDirection: "column" });
    this.paneHost = new BoxRenderable(renderer, { id: "codemax-pane-host", width: "100%", flexGrow: 1, flexShrink: 1, flexDirection: "column" });
    const bar = new BoxRenderable(renderer, { id: "codemax-status", width: "100%", height: 1, backgroundColor: "#3a0d25", paddingX: 1 });
    this.statusText = new TextRenderable(renderer, { id: "codemax-status-text", content: "", fg: "#ffffff" });
    bar.add(this.statusText);
    root.add(this.paneHost);
    root.add(bar);
    renderer.root.add(root);

    renderer.keyInput.on("keypress", this.onKey);
    renderer.on("resize", () => this.menu?.render());
    this.setStatus("");
  }

  /** `explicit`: the user named this agent (--agent), so never start a different one. */
  async start(agent: AgentId, fresh: boolean, o: { explicit?: boolean } = {}) {
    await this.refreshDetect();
    const installed = this.detect.get(agent)?.installed;
    if (!installed && o.explicit) throw new Error(`${agent} is not installed. Installed: ${this.installedList() || "none"}`);
    const first = installed ? agent : this.firstInstalled();
    if (!first) throw new Error("no supported agent CLI found on PATH");
    // Under tests a fallback must never reach a real agent (no logins, no quota).
    if (first !== agent && process.env.NODE_ENV === "test") throw new Error(`test asked for ${agent}, which is not available; refusing to fall back to ${first}`);
    if (first !== agent) this.setStatus(`${agent} not found, starting ${first}`);
    await this.launch(getAdapter(first), { fresh });
    return this.done;
  }

  // ---------- input ----------

  private onKey = (key: KeyEvent) => {
    if (this.menu) {
      const action = this.menu.handleKey(key);
      key.stopPropagation();
      if (action) void this.onMenuAction(action);
      return;
    }
    if (this.isHotkey(key)) {
      key.stopPropagation();
      this.openMenu("switch agent", true);
    }
  };

  private isHotkey(key: KeyEvent): boolean {
    if (key.eventType === "release") return false;
    if (key.raw && findHotkey(new TextEncoder().encode(key.raw), this.hotkeys)) return true;
    if (!key.ctrl) return false;
    return this.hotkeys.some((h) => {
      const k = h.name.slice("ctrl+".length);
      return (HOTKEY_NAMES[k] ?? [k]).includes(key.name);
    });
  }

  // ---------- status bar ----------

  private setStatus(message: string) {
    this.statusMessage = message;
    this.renderStatus();
  }

  private renderStatus() {
    const r = this.running;
    const parts: string[] = ["codemax"];
    if (r) {
      const sess = r.ref ? ` · session ${r.ref.id.slice(0, 8)}` : "";
      parts.push(`${r.adapter.name}${sess}`);
    }
    const quotas = [...this.quota.values()]
      .map((q) => `${q.agent} ${quotaLabel(q)}`.trim())
      .filter((s) => !s.endsWith(" "))
      .filter((s) => quotaLabel(this.quota.get(s.split(" ")[0] as AgentId)))
      .slice(0, 3);
    if (quotas.length) parts.push(quotas.join(", "));
    if (this.statusMessage) parts.push(this.statusMessage);
    parts.push(`${hotkeyLabel(this.config.hotkeys)} menu`);
    this.statusText.content = parts.join("  │  ");
  }

  // ---------- agent lifecycle ----------

  private paneSize() {
    return { cols: Math.max(20, this.renderer.width), rows: Math.max(5, this.renderer.height - 1) };
  }

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

    // Subscriptions only: an API key in the environment is never passed to an agent.
    const dropEnv = adapter.apiKeyEnv.filter((k) => process.env[k]);
    const scanner = new OutputScanner(adapter.id, adapter.quotaPatterns, (q) => this.onQuota(q));
    const { cols, rows } = this.paneSize();
    const run: Running = {
      adapter,
      ref: resume ?? null,
      scanner,
      sessionId,
      pendingPrompt: spec.promptConsumed ? undefined : brief,
      lastOutputAt: 0,
      firstOutputAt: 0,
      timers: [],
      pane: null as unknown as AgentPane,
    };
    run.pane = new AgentPane(this.renderer, {
      id: `pane-${adapter.id}-${Date.now()}`,
      cmd: spec.cmd,
      cwd: this.cwd,
      env: spec.env,
      dropEnv,
      cols,
      rows,
      onOutput: (text) => {
        const now = Date.now();
        if (!run.firstOutputAt) run.firstOutputAt = now;
        run.lastOutputAt = now;
        scanner.feed(text);
      },
      onExit: (code) => void this.onAgentExit(run, code),
    });
    this.paneHost.add(run.pane.terminal);
    run.pane.terminal.focus();
    this.running = run;
    this.ledger.addEvent({ kind: o.from ? "switch" : "start", agent: o.from, to: adapter.id, detail: o.reason });
    this.setStatus(dropEnv.length ? `unset ${dropEnv.join(", ")} (subscription login only)` : "");

    run.timers.push(setInterval(() => void this.sync(run), 2000));
    if (run.pendingPrompt) run.timers.push(setInterval(() => this.maybeTypePrompt(run), 250));
    void this.locate(run);
  }

  private async locate(run: Running) {
    if (run.ref) return;
    while (this.running === run && !run.pane.exited) {
      const ref = await run.adapter.locateSession({ cwd: this.cwd, startedAt: run.pane.startedAt, sessionId: run.sessionId });
      if (ref) {
        run.ref = ref;
        this.ledger.saveSession(ref);
        this.renderStatus();
        return;
      }
      await Bun.sleep(1000);
    }
  }

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

  private maybeTypePrompt(run: Running) {
    if (!run.pendingPrompt || !run.firstOutputAt) return;
    const now = Date.now();
    const quiet = now - run.lastOutputAt > 700;
    const old = now - run.pane.startedAt > 1500;
    const timeout = now - run.pane.startedAt > 15_000;
    if ((quiet && old) || timeout) {
      const text = run.pendingPrompt;
      run.pendingPrompt = undefined;
      run.pane.paste(text);
    }
  }

  private onQuota(q: QuotaStatus, silent = false) {
    const prev = this.quota.get(q.agent);
    this.quota.set(q.agent, q);
    this.ledger.saveQuota(q);
    this.renderStatus();
    if (isExhausted(q) && !isExhausted(prev)) {
      this.ledger.addEvent({ kind: "quota", agent: q.agent, detail: q.detail });
      if (this.config.autoSwitch && !silent) this.offerSwitchWhenIdle(q);
    }
  }

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
    if (this.running !== run) return;
    await this.sync(run);
    this.ledger.addEvent({ kind: "exit", agent: run.adapter.id, detail: `exit ${code}`, diffStat: await diffStat(this.cwd) });
    this.running = null;
    this.renderStatus();
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

  private installedList(): string {
    return [...this.detect.entries()].filter(([, d]) => d.installed).map(([id]) => id).join(", ");
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
    this.menu = new MenuOverlay(this.renderer, { title, rows: this.rows(), current: this.running?.adapter.id, notice, canClose, hotkeys: this.config.hotkeys });
    this.renderer.root.add(this.menu.box);
    void this.refreshDetect().then(() => this.menu?.update({ rows: this.rows() }));
  }

  private closeMenu() {
    this.menu?.destroy();
    this.menu = null;
    this.running?.pane.terminal.focus();
  }

  private async onMenuAction(action: { kind: string; agent?: AgentId; fresh?: boolean }) {
    if (action.kind === "close") return this.closeMenu();
    if (action.kind === "quit") return this.quit();
    if (action.kind === "switch" && action.agent) {
      const target = getAdapter(action.agent);
      if (this.running && this.running.adapter.id === target.id && !action.fresh) return this.closeMenu();
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
      await prev.pane.destroy();
      await this.sync(prev);
      this.ledger.addEvent({ kind: "note", agent: from, detail: "stopped for switch", diffStat: await diffStat(this.cwd) });
    }
    this.menu?.destroy();
    this.menu = null;
    this.setStatus(`handing off to ${target.name}…`);
    const fromQ = from ? this.quota.get(from) : undefined;
    const reason = fromQ && isExhausted(fromQ) ? (fromQ.source === "output" ? `${from} appeared to hit its usage limit` : `${from} ran out of quota`) : undefined;
    await this.launch(target, { fresh, from, reason });
    this.switching = false;
  }

  async quit() {
    this.switching = true;
    const run = this.running;
    this.menu?.destroy();
    this.menu = null;
    if (run) {
      run.timers.forEach(clearInterval);
      this.running = null;
      await run.pane.destroy();
      await this.sync(run);
      this.ledger.addEvent({ kind: "exit", agent: run.adapter.id, detail: "codemax quit", diffStat: await diffStat(this.cwd) });
    }
    this.renderer.keyInput.off("keypress", this.onKey);
    this.resolveDone();
  }
}

/** Run codemax on the real terminal until the user quits. */
export async function runApp(config: Config, ledger: Ledger, cwd: string, agent: AgentId, fresh: boolean, explicit = false) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: ["SIGTERM", "SIGHUP"], useMouse: true, targetFps: 60 });
  const app = new App(renderer, config, ledger, cwd);
  try {
    await app.start(agent, fresh, { explicit });
  } finally {
    renderer.destroy();
    try {
      await renderer.closed;
    } catch {
      /* output already gone */
    }
  }
  process.stdout.write(`codemax: to continue this thread, run: codemax --resume ${ledger.threadId}\n`);
}

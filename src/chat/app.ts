import { BoxRenderable, TextRenderable, TextareaRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import type { Config } from "../config.ts";
import { hotkeyLabel } from "../config.ts";
import type { AgentId, QuotaStatus, SessionRef } from "../adapters/types.ts";
import { listAdapters, getAdapter } from "../adapters/index.ts";
import { Ledger } from "../core/ledger.ts";
import { buildBrief } from "../core/brief.ts";
import { diffStat } from "../core/git.ts";
import { isExhausted, quotaLabel } from "../core/quota.ts";
import { findHotkey, parseHotkeys, type HotkeySpec } from "../core/hotkey.ts";
import type { MenuRow } from "../core/menu.ts";
import { MenuOverlay } from "../tui/menu.ts";
import { createEngine, hasEngine, NO_PERMISSION_PROMPTS, engineFactories, grokPermissionNote } from "../engines/index.ts";
import type { Engine, EngineEvent, PermissionRequest } from "../engines/types.ts";
import { strippedKeys } from "../engines/env.ts";
import { blockers } from "../core/doctor.ts";
import { Transcript, type MessageHandle } from "./transcript.ts";
import { PermissionOverlay } from "./permission.ts";

const HOTKEY_NAMES: Record<string, string[]> = { "/": ["/", "_", "?"], "^": ["^", "6"] };

interface Active {
  agent: AgentId;
  name: string;
  engine: Engine;
  turn: { handle: MessageHandle; tools: Set<string>; startedAt: number } | null;
  /** Where history replayed by a resumed session is rendered (ACP agents stream it before any turn). */
  replay: MessageHandle | null;
  unsubscribe: () => void;
  mode?: string;
}

/**
 * codemax's own chat UI. One agent engine at a time; the transcript, tool rows,
 * permission prompts and the agent menu are all codemax's. Switching agents
 * closes the engine, hands a brief to the next one, and keeps talking.
 */
export class ChatApp {
  private active: Active | null = null;
  private menu: MenuOverlay | null = null;
  private permission: PermissionOverlay | null = null;
  private permissionQueue: { request: PermissionRequest; engine: Engine }[] = [];
  private detect = new Map<AgentId, { installed: boolean; version?: string; engine: boolean }>();
  private quota = new Map<AgentId, QuotaStatus>();
  private hotkeys: HotkeySpec[];
  private transcript: Transcript;
  private input: TextareaRenderable;
  private statusText: TextRenderable;
  private statusMessage = "";
  private lastCtrlC = 0;
  private switching = false;
  private resolveDone!: () => void;
  readonly done: Promise<void>;
  /** Test hooks: build engines differently; skip machine-specific auth checks. */
  engineFactory: (agent: AgentId) => Engine = createEngine;
  checkBlockers: (agent: AgentId) => ReturnType<typeof blockers> = blockers;

  constructor(
    readonly renderer: CliRenderer,
    private config: Config,
    private ledger: Ledger,
    private cwd: string,
  ) {
    this.done = new Promise((r) => (this.resolveDone = r));
    this.hotkeys = parseHotkeys(config.hotkeys);
    for (const [id, q] of Object.entries(ledger.quota())) this.quota.set(id as AgentId, q);

    const root = new BoxRenderable(renderer, { id: "chat-root", width: "100%", height: "100%", flexDirection: "column" });
    this.transcript = new Transcript(renderer);
    root.add(this.transcript.box);
    const inputBox = new BoxRenderable(renderer, { id: "chat-input-box", width: "100%", height: 5, border: true, borderStyle: "rounded", borderColor: "#334155", paddingX: 1 });
    this.input = new TextareaRenderable(renderer, {
      id: "chat-input",
      width: "100%",
      height: 3,
      placeholder: "Message the agent · Enter to send · Shift+Enter newline · /switch /mode /quit",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "j", ctrl: true, action: "newline" },
      ],
      onSubmit: () => void this.submit(),
    });
    inputBox.add(this.input);
    root.add(inputBox);
    const bar = new BoxRenderable(renderer, { id: "chat-status", width: "100%", height: 1, backgroundColor: "#1e293b", paddingX: 1 });
    this.statusText = new TextRenderable(renderer, { id: "chat-status-text", content: "", fg: "#e2e8f0" });
    bar.add(this.statusText);
    root.add(bar);
    renderer.root.add(root);

    renderer.keyInput.on("keypress", this.onKey);
    renderer.on("resize", () => this.menu?.render());
    this.input.focus();
    this.renderStatus();
  }

  async start(agent: AgentId, fresh: boolean) {
    await this.refreshDetect();
    const ok = (a: AgentId) => this.detect.get(a)?.installed && this.detect.get(a)?.engine;
    const first = ok(agent) ? agent : listAdapters(this.config.order).find((a) => ok(a.id))?.id;
    if (!first) throw new Error("no agent with a protocol engine found (need claude, codex, opencode, grok or gemini on PATH)");
    if (first !== agent) this.transcript.system(`${agent} has no protocol engine here; starting ${first}`);
    const stripped = strippedKeys();
    if (stripped.length) this.transcript.system(`unset ${stripped.join(", ")} for agents — codemax only uses subscription logins`);
    await this.launch(first, { fresh });
    return this.done;
  }

  // ---------- input ----------

  private onKey = (key: KeyEvent) => {
    if (this.permission) {
      key.stopPropagation();
      this.permission.handleKey(key);
      return;
    }
    if (this.menu) {
      key.stopPropagation();
      const action = this.menu.handleKey(key);
      if (action) void this.onMenuAction(action);
      return;
    }
    if (this.isHotkey(key)) {
      key.stopPropagation();
      this.openMenu("switch agent", true);
      return;
    }
    if (key.name === "escape" && this.active?.turn) {
      key.stopPropagation();
      void this.active.engine.cancel();
      this.setStatus("cancelling…");
      return;
    }
    if (key.name === "c" && key.ctrl) {
      key.stopPropagation();
      if (this.active?.turn) {
        void this.active.engine.cancel();
        this.setStatus("cancelling… (Ctrl+C again to quit)");
      }
      const now = Date.now();
      if (now - this.lastCtrlC < 2000) void this.quit();
      else {
        this.lastCtrlC = now;
        if (!this.active?.turn) this.setStatus("Ctrl+C again to quit");
      }
    }
  };

  private isHotkey(key: KeyEvent): boolean {
    if (key.eventType === "release") return false;
    if (key.raw && findHotkey(new TextEncoder().encode(key.raw), this.hotkeys)) return true;
    if (!key.ctrl) return false;
    return this.hotkeys.some((h) => (HOTKEY_NAMES[h.name.slice(5)] ?? [h.name.slice(5)]).includes(key.name));
  }

  private async submit() {
    const text = this.input.plainText.trim();
    if (!text) return;
    this.input.clear();
    if (text.startsWith("/")) return this.command(text);
    if (!this.active) return this.transcript.system("no agent running — open the menu to start one");
    if (this.active.turn) return this.transcript.system("the agent is still working; Esc cancels");
    this.transcript.user(text);
    this.ledger.addTurns([{ ts: Date.now(), agent: this.active.agent, sessionId: this.active.engine.session?.id ?? "?", role: "user", text }]);
    await this.runTurn(this.active, text);
  }

  private async command(line: string) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    switch (cmd) {
      case "quit":
      case "exit":
      case "q":
        return this.quit();
      case "switch":
      case "agents":
        if (rest[0]) {
          const id = rest[0] as AgentId;
          if (!this.detect.get(id)?.engine) return this.transcript.system(`no engine for "${id}"`);
          return this.switchTo(id, rest.includes("--fresh"));
        }
        return this.openMenu("switch agent", true);
      case "mode": {
        if (!this.active) return;
        const modes = this.active.engine.info?.modes ?? [];
        if (!rest[0]) return this.transcript.system(`modes: ${modes.map((m) => (m.id === this.active?.mode ? `[${m.id}]` : m.id)).join(", ") || "(none)"}`);
        if (!this.active.engine.setMode) return this.transcript.system("this agent has no modes");
        await this.active.engine.setMode(rest[0]);
        return;
      }
      case "status":
        return this.transcript.system(`ledger: ${this.ledger.dir}\nturns: ${this.ledger.turns().length}\nsession: ${this.active?.engine.session?.id ?? "-"}`);
      case "help":
        return this.transcript.system("/switch [agent] [--fresh] · /mode [id] · /status · /quit · Esc cancels a turn · hotkey opens the menu");
      default:
        return this.transcript.system(`unknown command /${cmd}`);
    }
  }

  // ---------- engine lifecycle ----------

  private async launch(agent: AgentId, o: { fresh: boolean; from?: AgentId; reason?: string }) {
    const adapter = getAdapter(agent);
    const blocked = this.checkBlockers(agent);
    if (blocked.length) {
      for (const b of blocked) this.transcript.error(`${adapter.name} not started: ${b.message}${b.fix ? `
Fix: ${b.fix.description} — run \`codemax doctor --fix\`` : ""}`);
      this.openMenu(`${adapter.name} would bill an API key — pick another agent or run codemax doctor --fix`, !!this.active);
      return;
    }
    const engine = this.engineFactory(agent);
    const saved = this.ledger.sessions()[agent];
    const resume = !o.fresh && saved ? { agent, id: saved.id, cwd: this.cwd, startedAt: saved.startedAt, lastUsedAt: saved.lastUsedAt } : undefined;
    const active: Active = { agent, name: adapter.name, engine, turn: null, replay: null, unsubscribe: () => {} };
    active.unsubscribe = engine.onEvent((e) => this.onEngineEvent(active, e));
    this.active = active;
    this.setStatus(`starting ${adapter.name}…`);
    try {
      const info = await engine.start({ cwd: this.cwd, resume });
      active.mode = info.currentMode;
      if (engine.session) this.ledger.saveSession({ agent, id: engine.session.id, cwd: this.cwd, startedAt: engine.session.startedAt, lastUsedAt: Date.now() } as SessionRef);
      this.ledger.addEvent({ kind: o.from ? "switch" : "start", agent: o.from, to: agent, detail: o.reason });
      const resumed = !!resume && engine.session?.id === resume.id;
      active.replay = null; // anything replayed from here on belongs to the resumed history block
      const shownVersion = this.detect.get(agent)?.version ?? info.version;
      this.transcript.system(`${adapter.name}${shownVersion ? ` ${shownVersion}` : ""}${info.currentModel ? ` · ${info.currentModel}` : ""}${resumed ? " · resumed session" : " · new session"}${NO_PERMISSION_PROMPTS.has(agent) ? " · WARNING: acts without asking permission" : ""}`);
      if (agent === "grok" && grokPermissionNote()) this.transcript.system(grokPermissionNote()!, "#fca5a5");
      this.setStatus("");
      const hasHistory = this.ledger.turns().length > 0 || !!o.from;
      if (hasHistory && (o.from || !resumed)) {
        const brief = await buildBrief({ ledger: this.ledger, cwd: this.cwd, to: agent, from: o.from, reason: o.reason, config: this.config });
        this.transcript.system(`handoff brief sent to ${adapter.name} (${brief.length} chars)`, "#64748b");
        await this.runTurn(active, brief, { record: false });
      }
    } catch (e: any) {
      this.transcript.error(`${adapter.name} failed to start: ${e?.message ?? e}`);
      this.setStatus("");
      if (this.active === active) {
        active.unsubscribe();
        await engine.close().catch(() => {});
        this.active = null;
        this.openMenu(`${adapter.name} failed to start — pick another agent`, false);
      }
    }
  }

  private async runTurn(active: Active, text: string, o: { record?: boolean } = {}) {
    const handle = this.transcript.agent(active.agent, active.name);
    active.turn = { handle, tools: new Set(), startedAt: Date.now() };
    this.renderStatus();
    const stop = await active.engine.prompt(text);
    const turn = active.turn;
    active.turn = null;
    this.renderStatus();
    if (turn && o.record !== false) {
      const reply = turn.handle.text().trim();
      if (reply || turn.tools.size) {
        this.ledger.addTurns([{ ts: Date.now(), agent: active.agent, sessionId: active.engine.session?.id ?? "?", role: "assistant", text: reply, tools: turn.tools.size ? [...turn.tools] : undefined }]);
      }
    }
    if (stop === "cancelled") this.transcript.system("turn cancelled", "#64748b");
  }

  private onEngineEvent(active: Active, e: EngineEvent) {
    if (this.active !== active && e.type !== "permission_request") return;
    const target = () => active.turn?.handle ?? (active.replay ??= this.transcript.agent(active.agent, `${active.name} (earlier in this session)`));
    switch (e.type) {
      case "text_delta":
        target().append(e.text);
        break;
      case "tool_call":
        active.turn?.tools.add(e.title.split(" ")[0] ?? e.title);
        target().tool(e.id, e.title, e.status, e.detail);
        break;
      case "tool_update":
        target().toolUpdate(e.id, e.status, e.title, e.detail);
        break;
      case "permission_request":
        this.permissionQueue.push({ request: e.request, engine: active.engine });
        this.showNextPermission();
        break;
      case "mode":
        active.mode = e.modeId;
        this.renderStatus();
        break;
      case "usage":
        if (typeof e.usedPercent === "number") this.onQuota({ agent: active.agent, usedPercent: e.usedPercent, exhausted: e.usedPercent >= 100, source: "probe", at: Date.now() });
        break;
      case "session":
        this.ledger.saveSession({ agent: active.agent, id: e.ref.id, cwd: this.cwd, startedAt: e.ref.startedAt, lastUsedAt: Date.now() } as SessionRef);
        this.renderStatus();
        break;
      case "error":
        this.transcript.error(`${active.name}: ${e.message.slice(0, 500)}`);
        if (e.kind === "quota") this.onQuota({ agent: active.agent, exhausted: true, source: "probe", detail: e.message.slice(0, 120), at: Date.now() });
        if (e.kind === "crashed" && this.active === active && !this.switching) {
          active.turn = null;
          this.openMenu(`${active.name} exited — switch agent or quit`, false);
        }
        break;
      case "log":
        // Engine lifecycle warnings (e.g. "resume failed, starting fresh") must be visible; stderr noise is info.
        if (e.level !== "info") this.transcript.system(`${active.name}: ${e.message}`, e.level === "error" ? "#f87171" : "#94a3b8");
        break;
      default:
        break;
    }
  }

  private showNextPermission() {
    if (this.permission || !this.permissionQueue.length) return;
    const { request, engine } = this.permissionQueue.shift()!;
    const name = this.active?.engine === engine ? this.active.name : "agent";
    this.permission = new PermissionOverlay(this.renderer, request, name, (optionId) => {
      this.permission?.destroy();
      this.permission = null;
      const opt = request.options.find((o) => o.id === optionId);
      engine.answerPermission(request.id, optionId ?? request.options.find((o) => o.kind.startsWith("reject"))?.id ?? request.options[0]!.id);
      this.transcript.system(`${opt?.kind.startsWith("allow") ? "allowed" : "denied"}: ${request.title}`, opt?.kind.startsWith("allow") ? "#64748b" : "#fca5a5");
      this.input.focus();
      this.showNextPermission();
    });
    this.renderer.root.add(this.permission.box);
  }

  private onQuota(q: QuotaStatus) {
    const prev = this.quota.get(q.agent);
    this.quota.set(q.agent, q);
    this.ledger.saveQuota(q);
    this.renderStatus();
    if (isExhausted(q) && !isExhausted(prev)) {
      this.ledger.addEvent({ kind: "quota", agent: q.agent, detail: q.detail });
      if (this.config.autoSwitch && !this.menu) this.openMenu(`${q.agent} is out of quota — pick the next agent`, true, q.detail);
    }
  }

  // ---------- status / menu ----------

  private setStatus(message: string) {
    this.statusMessage = message;
    this.renderStatus();
  }

  private renderStatus() {
    const a = this.active;
    const parts = ["codemax"];
    if (a) {
      const bits = [a.name];
      if (a.engine.info?.currentModel) bits.push(a.engine.info.currentModel);
      if (a.mode) bits.push(`mode ${a.mode}`);
      if (a.turn) bits.push("working… (Esc cancels)");
      parts.push(bits.join(" · "));
    }
    const quotas = [...this.quota.values()].map((q) => [q.agent, quotaLabel(q)] as const).filter(([, l]) => l).map(([a, l]) => `${a} ${l}`).slice(0, 3);
    if (quotas.length) parts.push(quotas.join(", "));
    if (this.statusMessage) parts.push(this.statusMessage);
    parts.push(`${hotkeyLabel(this.config.hotkeys)} menu`);
    this.statusText.content = parts.join("  │  ");
  }

  private async refreshDetect() {
    await Promise.all(
      listAdapters(this.config.order).map(async (a) => {
        const d = await a.detect();
        const f = engineFactories[a.id];
        const engine = !!f && (await f.available().catch(() => false));
        this.detect.set(a.id, { installed: d.installed, version: d.version, engine });
      }),
    );
  }

  private rows(): MenuRow[] {
    const sessions = this.ledger.sessions();
    return listAdapters(this.config.order).map((a) => {
      const d = this.detect.get(a.id);
      const noEngine = d?.installed && !d.engine;
      return {
        adapter: noEngine ? { ...a, name: `${a.name} (no protocol — use codemax --tui)` } : NO_PERMISSION_PROMPTS.has(a.id) ? { ...a, name: `${a.name} (no permission prompts)` } : a,
        installed: !!d?.installed && !!d?.engine,
        version: d?.version,
        session: sessions[a.id],
        quota: this.quota.get(a.id),
      };
    });
  }

  private openMenu(title: string, canClose: boolean, notice?: string) {
    if (this.menu) return;
    this.menu = new MenuOverlay(this.renderer, { title, rows: this.rows(), current: this.active?.agent, notice, canClose, hotkeys: this.config.hotkeys });
    this.renderer.root.add(this.menu.box);
    void this.refreshDetect().then(() => this.menu?.update({ rows: this.rows() }));
  }

  private closeMenu() {
    this.menu?.destroy();
    this.menu = null;
    this.input.focus();
  }

  private async onMenuAction(action: { kind: string; agent?: AgentId; fresh?: boolean }) {
    if (action.kind === "close") return this.closeMenu();
    if (action.kind === "quit") return this.quit();
    if (action.kind === "switch" && action.agent) {
      if (!hasEngine(action.agent)) return this.menu?.update({ notice: `${action.agent} has no protocol engine; run codemax --tui for it` });
      if (this.active?.agent === action.agent && !action.fresh) return this.closeMenu();
      this.menu?.update({ notice: `switching to ${action.agent}…` });
      await this.switchTo(action.agent, !!action.fresh);
    }
  }

  private async switchTo(agent: AgentId, fresh: boolean) {
    this.switching = true;
    const prev = this.active;
    let from: AgentId | undefined;
    if (prev) {
      from = prev.agent;
      if (prev.turn) await prev.engine.cancel().catch(() => {});
      prev.unsubscribe();
      this.active = null;
      await prev.engine.close().catch(() => {});
      this.ledger.addEvent({ kind: "note", agent: from, detail: "stopped for switch", diffStat: await diffStat(this.cwd) });
    }
    this.menu?.destroy();
    this.menu = null;
    this.input.focus();
    const fromQ = from ? this.quota.get(from) : undefined;
    const reason = fromQ && isExhausted(fromQ) ? `${from} ran out of quota` : undefined;
    await this.launch(agent, { fresh, from, reason });
    this.switching = false;
  }

  async quit() {
    this.switching = true;
    const a = this.active;
    this.menu?.destroy();
    this.menu = null;
    this.permission?.destroy();
    this.permission = null;
    if (a) {
      this.active = null;
      a.unsubscribe();
      if (a.turn) await a.engine.cancel().catch(() => {});
      await a.engine.close().catch(() => {});
      this.ledger.addEvent({ kind: "exit", agent: a.agent, detail: "codemax quit", diffStat: await diffStat(this.cwd) });
    }
    this.renderer.keyInput.off("keypress", this.onKey);
    this.resolveDone();
  }
}

export async function runChat(config: Config, ledger: Ledger, cwd: string, agent: AgentId, fresh: boolean) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: ["SIGTERM", "SIGHUP"], useMouse: true, targetFps: 60 });
  const app = new ChatApp(renderer, config, ledger, cwd);
  try {
    await app.start(agent, fresh);
  } finally {
    renderer.destroy();
    try {
      await renderer.closed;
    } catch {
      /* output already gone */
    }
  }
  process.stdout.write(`codemax: bye. ledger at ${ledger.dir}\n`);
}

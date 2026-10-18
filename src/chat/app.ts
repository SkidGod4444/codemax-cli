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
import { createEngine, hasEngine, NO_PERMISSION_PROMPTS, engineFactories, grokPermissionNote } from "../engines/index.ts";
import type { Engine, EngineEvent, PermissionRequest } from "../engines/types.ts";
import { strippedKeys } from "../engines/env.ts";
import { blockers } from "../core/doctor.ts";
import { Transcript, type AgentBlock } from "./transcript.ts";
import { PermissionDialog } from "./permission.ts";
import { Palette, type PaletteItem } from "./palette.ts";
import { C, DONE_VERBS, G, VERBS, fmtDuration, fmtTime, modeLabel, pick } from "./theme.ts";
import { priceRecord, recordCost, renderUsageTable, sumCost } from "../core/usage.ts";
import { fmtUsd, resetPriceCache } from "../core/pricing.ts";
import { refreshLivePricesIfStale } from "../core/prices-live.ts";

const HOTKEY_NAMES: Record<string, string[]> = { "/": ["/", "_", "?"], "^": ["^", "6"] };
const VERSION = "0.3.1";
const MODE_CYCLE = ["default", "acceptEdits", "plan"];

interface Active {
  agent: AgentId;
  name: string;
  engine: Engine;
  turn: { block: AgentBlock; tools: Set<string>; startedAt: number; tokens: number; chars: number; verb: string } | null;
  replay: AgentBlock | null;
  unsubscribe: () => void;
  mode?: string;
  commands: { name: string; description?: string }[];
}

interface Builtin {
  name: string;
  description: string;
  run: (args: string) => void | Promise<void>;
}

/**
 * codemax's chat. One engine at a time; everything on screen is codemax's:
 * transcript, working line, prompt, footer, palette, permission dialog.
 */
export class ChatApp {
  private active: Active | null = null;
  private palette: Palette | null = null;
  private permission: PermissionDialog | null = null;
  private permissionQueue: { request: PermissionRequest; engine: Engine }[] = [];
  private detect = new Map<AgentId, { installed: boolean; version?: string; engine: boolean }>();
  private quota = new Map<AgentId, QuotaStatus>();
  private hotkeys: HotkeySpec[];
  private transcript: Transcript;
  private working: TextRenderable;
  private input: TextareaRenderable;
  private inputWrap: BoxRenderable;
  private dialogHost: BoxRenderable;
  private footerText: TextRenderable;
  private shortcuts: BoxRenderable;
  private flash = "";
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private history: string[] = [];
  /** API-equivalent USD spent since codemax started (all agents). */
  private sessionCost = 0;
  private sessionTokens = 0;
  private historyIdx = -1;
  private draft = "";
  private queue: string[] = [];
  private lastCtrlC = 0;
  private switching = false;
  private resolveDone!: () => void;
  readonly done: Promise<void>;
  /** Test hooks. */
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
    this.working = new TextRenderable(renderer, { id: "working", content: "", fg: C.dim, height: 1, width: "100%", flexShrink: 0, wrapMode: "none", truncate: true });
    this.working.visible = false;
    root.add(this.working);
    this.dialogHost = new BoxRenderable(renderer, { id: "dialog-host", width: "100%", flexShrink: 0, flexDirection: "column" });
    root.add(this.dialogHost);
    this.inputWrap = new BoxRenderable(renderer, { id: "input-wrap", width: "100%", flexShrink: 0, flexDirection: "column", border: ["top", "bottom"], borderStyle: "single", borderColor: C.dimmer });
    const inputRow = new BoxRenderable(renderer, { id: "input-row", width: "100%", flexDirection: "row" });
    inputRow.add(new TextRenderable(renderer, { id: "input-prompt", content: `${G.prompt} `, width: 2, fg: C.accent }));
    this.input = new TextareaRenderable(renderer, {
      id: "chat-input",
      flexGrow: 1,
      height: 1,
      placeholder: 'Try "fix the failing test" · / for commands',
      placeholderColor: C.dim,
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "j", ctrl: true, action: "newline" },
      ],
      onSubmit: () => void this.submit(),
    } as any);
    this.input.onContentChange = () => this.onInputChanged();
    inputRow.add(this.input);
    this.inputWrap.add(inputRow);
    root.add(this.inputWrap);
    this.shortcuts = new BoxRenderable(renderer, { id: "shortcuts", width: "100%", flexShrink: 0, flexDirection: "column", paddingX: 2 });
    this.shortcuts.visible = false;
    for (const l of [
      "/ for commands            shift + tab to cycle permission mode     esc to interrupt a turn",
      "/switch to change agent   ↑ for history                             ctrl + c twice to quit",
      "/mode to set permissions  shift + ⏎ for newline                     ? to toggle this help",
    ])
      this.shortcuts.add(new TextRenderable(renderer, { content: l, fg: C.dim, wrapMode: "none", truncate: true }));
    root.add(this.shortcuts);
    const footer = new BoxRenderable(renderer, { id: "footer", width: "100%", height: 1, flexShrink: 0, paddingX: 2 });
    this.footerText = new TextRenderable(renderer, { id: "footer-text", content: "", width: "100%", wrapMode: "none", truncate: true, fg: C.dim });
    footer.add(this.footerText);
    root.add(footer);
    renderer.root.add(root);

    renderer.keyInput.on("keypress", this.onKey);
    renderer.on("resize", () => this.palette?.render());
    this.input.focus();
    this.renderFooter();
  }

  async start(agent: AgentId, fresh: boolean) {
    await this.refreshDetect();
    const ok = (a: AgentId) => this.detect.get(a)?.installed && this.detect.get(a)?.engine;
    const first = ok(agent) ? agent : listAdapters(this.config.order).find((a) => ok(a.id))?.id;
    if (!first) throw new Error("no agent with a protocol engine found (need claude, codex, opencode, grok or gemini on PATH)");
    const notes: string[] = [];
    if (first !== agent) notes.push(`${agent} has no protocol engine here; starting ${first}`);
    const stripped = strippedKeys();
    if (stripped.length) notes.push(`${stripped.join(", ")} unset for agents · subscription logins only`);
    this.transcript.header({ title: `codemax v${VERSION}`, subtitle: "one terminal, every coding agent", path: this.cwd, notes });
    if ((this.config as any).priceUpdates !== false) void refreshLivePricesIfStale().then((l) => l && resetPriceCache());
    await this.launch(first, { fresh });
    return this.done;
  }

  // ---------- keys ----------

  private onKey = (key: KeyEvent) => {
    if (key.eventType === "release") return;
    if (this.permission) {
      key.stopPropagation();
      this.permission.handleKey(key);
      return;
    }
    if (this.palette) {
      if (this.palette.handleKey(key)) {
        key.stopPropagation();
        return;
      }
      // other keys fall through to the input; the palette re-filters on content change
    }
    if (this.isHotkey(key)) {
      key.stopPropagation();
      this.openSwitch();
      return;
    }
    if (this.isShiftTab(key)) {
      key.stopPropagation();
      void this.cycleMode();
      return;
    }
    if (key.name === "escape") {
      if (this.active?.turn) {
        key.stopPropagation();
        void this.active.engine.cancel();
        this.setFlash("interrupting…");
      } else if (this.input.plainText) {
        key.stopPropagation();
        this.input.clear();
      }
      return;
    }
    if (key.name === "c" && key.ctrl) {
      key.stopPropagation();
      const now = Date.now();
      if (this.active?.turn) {
        void this.active.engine.cancel();
        this.setFlash("interrupting… (ctrl+c again to quit)");
      } else if (this.input.plainText) {
        this.draft = this.input.plainText;
        this.input.clear();
        this.setFlash("prompt cleared · ↑ to restore · ctrl+c again to quit");
      } else if (now - this.lastCtrlC < 2000) {
        void this.quit();
        return;
      } else this.setFlash("ctrl+c again to quit");
      this.lastCtrlC = now;
      return;
    }
    if (key.name === "up" && !this.input.plainText.includes("\n") && (this.history.length || this.draft)) {
      if (this.input.plainText === "" || this.historyIdx >= 0) {
        key.stopPropagation();
        this.recall(-1);
        return;
      }
    }
    if (key.name === "down" && this.historyIdx >= 0) {
      key.stopPropagation();
      this.recall(1);
      return;
    }
    if (key.name === "?" && this.input.plainText === "" && !this.palette) {
      key.stopPropagation();
      this.shortcuts.visible = !this.shortcuts.visible;
      return;
    }
  };

  private isHotkey(key: KeyEvent): boolean {
    if (key.raw && findHotkey(new TextEncoder().encode(key.raw), this.hotkeys)) return true;
    if (!key.ctrl) return false;
    return this.hotkeys.some((h) => (HOTKEY_NAMES[h.name.slice(5)] ?? [h.name.slice(5)]).includes(key.name));
  }

  private isShiftTab(key: KeyEvent): boolean {
    return (key.name === "tab" && key.shift) || key.name === "backtab" || key.raw === "\x1b[Z";
  }

  private recall(dir: -1 | 1) {
    if (this.historyIdx < 0) {
      this.draft = this.input.plainText;
      if (dir === 1) return;
      if (!this.history.length) {
        if (this.draft === "" && this.lastDraft) this.input.setText(this.lastDraft);
        return;
      }
      this.historyIdx = this.history.length - 1;
    } else {
      this.historyIdx += dir;
    }
    if (this.historyIdx >= this.history.length) {
      this.historyIdx = -1;
      this.input.setText(this.draft);
      return;
    }
    if (this.historyIdx < 0) this.historyIdx = 0;
    this.input.setText(this.history[this.historyIdx]!);
  }
  private lastDraft = "";

  private onInputChanged() {
    const text = this.input.plainText;
    if (this.historyIdx >= 0 && text !== this.history[this.historyIdx]) this.historyIdx = -1;
    if (text.startsWith("/") && !text.includes("\n") && !text.includes(" ")) {
      if (!this.palette) this.openCommandPalette(text.slice(1));
      else this.palette.setFilter(text.slice(1));
    } else if (this.palette && this.paletteKind === "commands") {
      this.closePalette();
    }
    if (this.shortcuts.visible && text) this.shortcuts.visible = false;
  }

  // ---------- submit / commands ----------

  private async submit() {
    const text = this.input.plainText.trim();
    if (!text) return;
    if (this.palette && this.paletteKind === "commands") {
      // Enter on an exact or highlighted command runs it; Enter on a typo does nothing dangerous.
      const cur = this.palette.current;
      const exact = cur && cur.label.toLowerCase() === text.toLowerCase();
      if (cur && (exact || text.length > 1)) {
        this.closePalette();
        this.input.clear();
        return this.runCommandValue(cur.value, "");
      }
    }
    this.closePalette();
    this.input.clear();
    this.pushHistory(text);
    if (text.startsWith("/")) return this.command(text);
    if (!this.active) {
      this.transcript.note("no agent running — /switch to start one", C.warn);
      return;
    }
    if (this.active.turn) {
      this.queue.push(text);
      this.transcript.note(`queued: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`, C.dim);
      return;
    }
    await this.send(this.active, text);
  }

  private async send(active: Active, text: string) {
    this.transcript.user(text);
    this.ledger.addTurns([{ ts: Date.now(), agent: active.agent, sessionId: active.engine.session?.id ?? "?", role: "user", text }]);
    await this.runTurn(active, text);
    const next = this.queue.shift();
    if (next && this.active === active) await this.send(active, next);
  }

  private pushHistory(text: string) {
    if (this.history.at(-1) !== text) this.history.push(text);
    if (this.history.length > 200) this.history.shift();
    this.historyIdx = -1;
    this.draft = "";
  }

  private builtins(): Builtin[] {
    return [
      { name: "/switch", description: "Switch to another agent (keeps the conversation)", run: () => this.openSwitch() },
      { name: "/mode", description: "Set how often the agent asks permission", run: (a) => this.openModes(a) },
      { name: "/agents", description: "Show agents, sessions and quota", run: () => this.openSwitch() },
      { name: "/usage", description: "Tokens and API-equivalent cost per agent (like /cost)", run: () => this.showUsage() },
      { name: "/cost", description: "Alias of /usage", run: () => this.showUsage() },
      { name: "/status", description: "Session, ledger and quota details", run: () => this.showStatus() },
      { name: "/clear", description: "Clear the screen (history stays in the ledger)", run: () => this.clearScreen() },
      { name: "/help", description: "Keyboard shortcuts and commands", run: () => void (this.shortcuts.visible = true) },
      { name: "/quit", description: "Quit codemax", run: () => void this.quit() },
    ];
  }

  private async command(line: string) {
    const [raw, ...rest] = line.split(/\s+/);
    const name = raw!.toLowerCase();
    const b = this.builtins().find((x) => x.name === name || x.name === name.replace(/^\/(exit|q)$/, "/quit"));
    if (b) return b.run(rest.join(" "));
    if (name === "/exit" || name === "/q") return this.quit();
    if (this.active?.commands.some((c) => `/${c.name}` === name)) {
      if (this.active.turn) {
        this.queue.push(line);
        this.transcript.note(`queued ${name} until the turn ends`, C.dim);
        return;
      }
      return this.send(this.active, line);
    }
    this.transcript.note(`Unknown command: ${name}`, C.warn);
  }

  private runCommandValue(value: string, args: string) {
    if (value.startsWith("builtin:")) return this.builtins().find((b) => b.name === value.slice(8))?.run(args);
    if (value.startsWith("agentcmd:")) return this.command(`/${value.slice(9)}${args ? " " + args : ""}`);
  }

  private showUsage() {
    const all = this.ledger.usage();
    for (const l of renderUsageTable(all, { title: "Usage for this project" })) this.transcript.note(l);
    this.transcript.note(`this codemax session: ${fmtUsd(this.sessionCost)} · all time here: ${fmtUsd(sumCost(all))} · prices in ~/.codemax/prices.json`);
  }

  private showStatus() {
    const a = this.active;
    const lines = [
      `agent: ${a ? `${a.name}${a.engine.info?.currentModel ? ` · ${a.engine.info.currentModel}` : ""}` : "none"}`,
      `session: ${a?.engine.session?.id ?? "-"}  mode: ${a?.mode ?? "-"}`,
      `ledger: ${this.ledger.dir} (${this.ledger.turns().length} turns)`,
    ];
    const q = [...this.quota.values()].map((x) => `${x.agent} ${quotaLabel(x)}`.trim()).filter((s) => !/\s$/.test(s) && s.includes(" "));
    if (q.length) lines.push(`quota: ${q.join(", ")}`);
    for (const l of lines) this.transcript.note(l);
  }

  private clearScreen() {
    const old = this.transcript;
    const parent = old.box.parent;
    const fresh = new Transcript(this.renderer);
    parent?.add(fresh.box, 0);
    old.box.destroyRecursively();
    this.transcript = fresh;
  }

  // ---------- palette ----------

  private paletteKind: "commands" | "switch" | "modes" | null = null;

  private paletteAnchor = () => ({ top: this.inputWrap.y, width: this.renderer.width });

  private openCommandPalette(filter: string) {
    this.closePalette();
    const builtinNames = new Set(this.builtins().map((b) => b.name));
    const items: PaletteItem[] = [
      ...this.builtins().map((b) => ({ label: b.name, description: b.description, value: `builtin:${b.name}`, weight: 1 })),
      ...(this.active?.commands ?? [])
        .filter((c) => !builtinNames.has(`/${c.name}`))
        .map((c) => ({ label: `/${c.name}`, description: c.description ?? `${this.active!.name} command`, value: `agentcmd:${c.name}` })),
    ];
    this.paletteKind = "commands";
    this.palette = new Palette(this.renderer, {
      items,
      filter,
      onPick: (it) => {
        this.closePalette();
        this.input.clear();
        void this.runCommandValue(it.value, "");
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  openSwitch() {
    this.closePalette();
    const sessions = this.ledger.sessions();
    const items: PaletteItem[] = listAdapters(this.config.order).map((a) => {
      const d = this.detect.get(a.id);
      const s = sessions[a.id];
      const q = this.quota.get(a.id);
      const usable = !!d?.installed && !!d?.engine;
      const bits: string[] = [];
      if (!d?.installed) bits.push("not installed");
      else if (!d.engine) bits.push("no protocol · use codemax --tui");
      else {
        if (d.version) bits.push(d.version);
        bits.push(s ? `session ${ago(s.lastUsedAt)}` : "new session");
        if (q && quotaLabel(q)) bits.push(quotaLabel(q));
        if (NO_PERMISSION_PROMPTS.has(a.id)) bits.push("acts without asking");
      }
      return { label: a.name + (a.id === this.active?.agent ? " (current)" : ""), description: bits.join(" · "), value: a.id, disabled: !usable };
    });
    this.paletteKind = "switch";
    this.palette = new Palette(this.renderer, {
      title: "Switch agent · Enter to hand off the conversation · Esc to cancel",
      items,
      onPick: (it) => {
        this.closePalette();
        const id = it.value as AgentId;
        if (id === this.active?.agent) return;
        void this.switchTo(id, false);
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
    void this.refreshDetect().then(() => this.paletteKind === "switch" && this.openSwitch());
  }

  private openModes(arg: string) {
    const a = this.active;
    if (!a) return;
    const modes = a.engine.info?.modes ?? [];
    if (!modes.length || !a.engine.setMode) return this.transcript.note(`${a.name} has no permission modes to switch`, C.dim);
    if (arg) {
      const m = modes.find((x) => x.id === arg || x.name.toLowerCase() === arg.toLowerCase());
      if (m) return void a.engine.setMode(m.id);
      return this.transcript.note(`unknown mode "${arg}" (${modes.map((x) => x.id).join(", ")})`, C.warn);
    }
    this.closePalette();
    this.paletteKind = "modes";
    this.palette = new Palette(this.renderer, {
      title: "Permission mode · shift+tab cycles these",
      items: modes.map((m) => ({ label: m.id, description: `${m.name}${m.id === a.mode ? "  (current)" : ""}${m.description ? " · " + m.description : ""}`, value: m.id })),
      onPick: (it) => {
        this.closePalette();
        void a.engine.setMode!(it.value);
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  private closePalette() {
    this.palette?.destroy();
    this.palette = null;
    this.paletteKind = null;
    this.input.focus();
  }

  private async cycleMode() {
    const a = this.active;
    if (!a?.engine.setMode) return this.setFlash("this agent has no permission modes");
    const ids = (a.engine.info?.modes ?? []).map((m) => m.id);
    const cycle = MODE_CYCLE.filter((m) => ids.includes(m));
    const order = cycle.length ? cycle : ids;
    if (!order.length) return;
    const next = order[(order.indexOf(a.mode ?? "") + 1) % order.length]!;
    await a.engine.setMode(next);
  }

  // ---------- engine lifecycle ----------

  private async launch(agent: AgentId, o: { fresh: boolean; from?: AgentId; reason?: string }) {
    const adapter = getAdapter(agent);
    const blocked = this.checkBlockers(agent);
    if (blocked.length) {
      for (const b of blocked) this.transcript.error(`${adapter.name} not started: ${b.message}${b.fix ? ` Fix: ${b.fix.description} (codemax doctor --fix)` : ""}`);
      this.openSwitch();
      return;
    }
    const engine = this.engineFactory(agent);
    const saved = this.ledger.sessions()[agent];
    const resume = !o.fresh && saved ? { agent, id: saved.id, cwd: this.cwd, startedAt: saved.startedAt, lastUsedAt: saved.lastUsedAt } : undefined;
    const active: Active = { agent, name: adapter.name, engine, turn: null, replay: null, unsubscribe: () => {}, commands: [] };
    active.unsubscribe = engine.onEvent((e) => this.onEngineEvent(active, e));
    this.active = active;
    this.setWorking(`${pick(G.spinner, 0)} Starting ${adapter.name}…`);
    try {
      const info = await engine.start({ cwd: this.cwd, resume });
      active.mode = info.currentMode;
      if (engine.session) this.ledger.saveSession({ agent, id: engine.session.id, cwd: this.cwd, startedAt: engine.session.startedAt, lastUsedAt: Date.now() } as SessionRef);
      this.ledger.addEvent({ kind: o.from ? "switch" : "start", agent: o.from, to: agent, detail: o.reason });
      const resumed = !!resume && engine.session?.id === resume.id;
      active.replay = null;
      const version = this.detect.get(agent)?.version ?? info.version;
      const model = info.currentModel ? ` · ${info.currentModel}` : "";
      this.transcript.divider(`${adapter.name}${version ? ` ${version}` : ""}${model} · ${resumed ? "resumed" : "new session"}`);
      if (NO_PERMISSION_PROMPTS.has(agent)) this.transcript.note(grokPermissionNote() ?? `${adapter.name} acts without asking permission`, C.warn);
      this.setWorking(null);
      this.renderFooter();
      const hasHistory = this.ledger.turns().length > 0 || !!o.from;
      if (hasHistory && (o.from || !resumed)) {
        const brief = await buildBrief({ ledger: this.ledger, cwd: this.cwd, to: agent, from: o.from, reason: o.reason, config: this.config });
        this.transcript.note(`handing over ${this.ledger.turns().length} earlier turns and the repo state (${brief.length} chars)`);
        await this.runTurn(active, brief, { record: false });
      }
      const next = this.queue.shift();
      if (next && this.active === active) await this.send(active, next);
    } catch (e: any) {
      this.setWorking(null);
      this.transcript.error(`${adapter.name} failed to start: ${e?.message ?? e}`);
      if (this.active === active) {
        active.unsubscribe();
        await engine.close().catch(() => {});
        this.active = null;
        this.renderFooter();
        this.openSwitch();
      }
    }
  }

  private async runTurn(active: Active, text: string, o: { record?: boolean } = {}) {
    const block = this.transcript.agent();
    active.turn = { block, tools: new Set(), startedAt: Date.now(), tokens: 0, chars: 0, verb: pick(VERBS) };
    this.startSpinner(active);
    const stop = await active.engine.prompt(text);
    const turn = active.turn;
    active.turn = null;
    this.stopSpinner();
    if (turn) {
      const dur = fmtDuration(Date.now() - turn.startedAt);
      block.footer(stop === "cancelled" ? `Interrupted after ${dur}` : `${pick(DONE_VERBS, turn.startedAt)} for ${dur} · done ${fmtTime(Date.now())}`);
      if (o.record !== false) {
        const reply = block.text().trim();
        if (reply || turn.tools.size) {
          this.ledger.addTurns([{ ts: Date.now(), agent: active.agent, sessionId: active.engine.session?.id ?? "?", role: "assistant", text: reply, tools: turn.tools.size ? [...turn.tools] : undefined }]);
        }
      }
    }
    this.renderFooter();
  }

  private onEngineEvent(active: Active, e: EngineEvent) {
    if (this.active !== active && e.type !== "permission_request") return;
    const target = () => active.turn?.block ?? (active.replay ??= this.transcript.agent());
    switch (e.type) {
      case "text_delta":
        if (active.turn) active.turn.chars += e.text.length;
        target().append(e.text);
        break;
      case "tool_call":
        active.turn?.tools.add(e.title.split(/[\s(]/)[0] ?? e.title);
        target().tool(e.id, e.title, e.status, e.detail);
        break;
      case "tool_update":
        target().toolUpdate(e.id, e.status, e.title, e.detail);
        break;
      case "permission_request":
        this.permissionQueue.push({ request: e.request, engine: active.engine });
        this.showNextPermission();
        break;
      case "mode": {
        active.mode = e.modeId;
        this.renderFooter();
        break;
      }
      case "commands":
        active.commands = e.commands.filter((c) => !c.name.startsWith("__"));
        break;
      case "usage": {
        if (active.turn && typeof e.outputTokens === "number") active.turn.tokens += e.outputTokens;
        if (typeof e.usedPercent === "number") this.onQuota({ agent: active.agent, usedPercent: e.usedPercent, exhausted: e.usedPercent >= 100, source: "probe", at: Date.now() });
        const hasTokens = (e.inputTokens ?? 0) + (e.outputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheWriteTokens ?? 0) > 0;
        if (hasTokens || typeof e.costUsd === "number") {
          const rec = priceRecord({
            ts: Date.now(),
            agent: active.agent,
            sessionId: active.engine.session?.id ?? "?",
            model: e.model ?? active.engine.info?.currentModel,
            input: e.inputTokens ?? 0,
            output: e.outputTokens ?? 0,
            cacheRead: e.cacheReadTokens ?? 0,
            cacheWrite: e.cacheWriteTokens ?? 0,
            agentCostUsd: typeof e.costUsd === "number" ? e.costUsd : undefined,
          });
          this.ledger.addUsage(rec);
          this.sessionCost += recordCost(rec).usd;
          this.sessionTokens += rec.input + rec.output + rec.cacheRead + rec.cacheWrite;
          this.renderFooter();
        }
        break;
      }
      case "session":
        this.ledger.saveSession({ agent: active.agent, id: e.ref.id, cwd: this.cwd, startedAt: e.ref.startedAt, lastUsedAt: Date.now() } as SessionRef);
        break;
      case "error":
        this.transcript.error(`${active.name}: ${e.message.slice(0, 500)}`);
        if (e.kind === "quota") this.onQuota({ agent: active.agent, exhausted: true, source: "probe", detail: e.message.slice(0, 120), at: Date.now() });
        if (e.kind === "crashed" && this.active === active && !this.switching) {
          active.turn = null;
          this.stopSpinner();
          this.openSwitch();
        }
        break;
      case "log":
        if (e.level !== "info") this.transcript.note(`${active.name}: ${e.message}`, e.level === "error" ? C.error : C.dim);
        break;
      default:
        break;
    }
  }

  private showNextPermission() {
    if (this.permission || !this.permissionQueue.length) return;
    const { request, engine } = this.permissionQueue.shift()!;
    const name = this.active?.engine === engine ? this.active.name : "the agent";
    this.permission = new PermissionDialog(this.renderer, request, name, (choice) => {
      this.permission?.destroy();
      this.permission = null;
      const opt = request.options.find((o) => o.id === choice.optionId);
      const fallbackReject = request.options.find((o) => o.kind.startsWith("reject"))?.id ?? request.options[0]!.id;
      engine.answerPermission(request.id, choice.optionId ?? fallbackReject);
      const allowed = !!opt && opt.kind.startsWith("allow");
      if (!allowed) this.transcript.note(`declined: ${request.title.length > 70 ? request.title.slice(0, 67) + "…" : request.title}`, C.warn);
      if (choice.tellAgent) {
        this.input.placeholder = `Tell ${name} what to do differently…`;
        setTimeout(() => (this.input.placeholder = 'Try "fix the failing test" · / for commands'), 15000);
      }
      this.input.focus();
      this.showNextPermission();
    });
    this.dialogHost.add(this.permission.box);
  }

  private onQuota(q: QuotaStatus) {
    const prev = this.quota.get(q.agent);
    this.quota.set(q.agent, q);
    this.ledger.saveQuota(q);
    this.renderFooter();
    if (isExhausted(q) && !isExhausted(prev)) {
      this.ledger.addEvent({ kind: "quota", agent: q.agent, detail: q.detail });
      this.transcript.note(`${q.agent} is out of quota${q.resetsAt ? ` · resets ${fmtTime(q.resetsAt)}` : ""} — /switch to continue elsewhere`, C.warn);
      if (this.config.autoSwitch && !this.palette && !this.permission) this.openSwitch();
    }
  }

  // ---------- working line, footer ----------

  private startSpinner(active: Active) {
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      const t = active.turn;
      if (!t) return this.stopSpinner();
      this.spinnerFrame++;
      const glyph = G.spinner[this.spinnerFrame % G.spinner.length];
      const secs = fmtDuration(Date.now() - t.startedAt);
      const approx = t.tokens || Math.round(t.chars / 4);
      const tok = approx ? ` · ↓ ${t.tokens ? "" : "~"}${approx} tokens` : "";
      if (this.permission) this.setWorking(`${glyph} Waiting for your approval (${secs}) · esc to say no`);
      else this.setWorking(`${glyph} ${t.verb}… (${secs}${tok}) · esc to interrupt`);
    }, 120);
  }

  private stopSpinner() {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    this.setWorking(null);
  }

  private setWorking(text: string | null) {
    this.working.visible = !!text;
    this.working.content = text ?? "";
  }

  private setFlash(text: string) {
    this.flash = text;
    this.renderFooter();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = "";
      this.renderFooter();
    }, 4000);
  }

  private renderFooter() {
    const a = this.active;
    const width = Math.max(20, this.renderer.width - 4);
    let color: string = C.dim;
    const mode = a ? modeLabel(a.name, a.mode) : null;
    if (mode) color = mode.color;
    const canCycle = !!a?.engine.setMode && (a.engine.info?.modes.length ?? 0) > 1;
    // Pieces in priority order; low-priority ones are dropped until the line fits.
    const left: { text: string; prio: number }[] = [];
    if (mode) left.push({ text: `${mode.glyph} ${mode.text}`, prio: 0 });
    else left.push({ text: "no agent · /switch", prio: 0 });
    if (canCycle) left.push({ text: "shift+tab to cycle", prio: 3 });
    if (this.flash) left.push({ text: this.flash, prio: 1 });
    else if (this.queue.length) left.push({ text: `${this.queue.length} queued`, prio: 1 });
    else if (!this.shortcuts.visible) left.push({ text: "? for shortcuts", prio: 2 });
    const right: { text: string; prio: number }[] = [];
    if (a) right.push({ text: `${a.name}${a.engine.info?.currentModel ? ` · ${shortModelName(a.engine.info.currentModel)}` : ""}`, prio: 2 });
    if (this.sessionCost > 0 || this.sessionTokens > 0) right.push({ text: `${fmtUsd(this.sessionCost)} /usage`, prio: 1 });
    const quotas = [...this.quota.values()].map((q) => [q.agent, quotaLabel(q)] as const).filter(([, l]) => l).map(([ag, l]) => `${ag} ${l}`).slice(0, 2);
    if (quotas.length) right.push({ text: quotas.join(" · "), prio: 2 });
    right.push({ text: `${this.config.hotkeys.map((h) => h.toLowerCase()).join(" · ")} agents`, prio: 4 });
    const compose = (l: typeof left, r: typeof right) => {
      const ls = l.map((x) => x.text).join(" · ");
      const rs = r.map((x) => x.text).join("  ·  ");
      return { ls, rs, gap: width - ls.length - rs.length };
    };
    let L = left, R = right;
    let c = compose(L, R);
    for (const prio of [4, 3, 2, 1]) {
      if (c.gap >= 2) break;
      L = L.filter((x) => x.prio !== prio);
      R = R.filter((x) => x.prio !== prio);
      c = compose(L, R);
    }
    this.footerText.content = c.gap >= 2 ? c.ls + " ".repeat(c.gap) + c.rs : `${c.ls}  ${c.rs}`.slice(0, width);
    this.footerText.fg = this.flash ? C.dim : color;
  }

  // ---------- detection / switching / quit ----------

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

  private async switchTo(agent: AgentId, fresh: boolean) {
    if (!hasEngine(agent)) return this.transcript.note(`${agent} has no protocol engine; run codemax --tui for it`, C.warn);
    this.switching = true;
    const prev = this.active;
    let from: AgentId | undefined;
    if (prev) {
      from = prev.agent;
      if (prev.turn) await prev.engine.cancel().catch(() => {});
      prev.unsubscribe();
      this.active = null;
      this.stopSpinner();
      await prev.engine.close().catch(() => {});
      this.ledger.addEvent({ kind: "note", agent: from, detail: "stopped for switch", diffStat: await diffStat(this.cwd) });
    }
    const fromQ = from ? this.quota.get(from) : undefined;
    const reason = fromQ && isExhausted(fromQ) ? `${from} ran out of quota` : undefined;
    await this.launch(agent, { fresh, from, reason });
    this.switching = false;
  }

  async quit() {
    this.switching = true;
    const a = this.active;
    this.closePalette();
    this.permission?.destroy();
    this.permission = null;
    this.stopSpinner();
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

function shortModelName(m: string): string {
  return m.replace(/^claude-/, "").replace(/^(anthropic|openai|xai|google)\//, "");
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
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

import { BoxRenderable, TextRenderable, TextareaRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import type { Config } from "../config.ts";
import { hotkeyLabel, saveConfigKey } from "../config.ts";
import type { AgentId, QuotaStatus, SessionRef } from "../adapters/types.ts";
import { listAdapters, getAdapter } from "../adapters/index.ts";
import { Ledger } from "../core/ledger.ts";
import { buildBrief, buildCatchup } from "../core/brief.ts";
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
import { C, DONE_VERBS, G, TIPS, VERBS, applyTheme, fmtDuration, fmtTime, modeLabel, pick } from "./theme.ts";
import { priceRecord, recordCost, renderUsageTable, sumCost } from "../core/usage.ts";
import { fmtUsd, resetPriceCache } from "../core/pricing.ts";
import { refreshLivePricesIfStale } from "../core/prices-live.ts";
import { addSpend, budgetLevel, spendToday, type BudgetKey } from "../core/budget.ts";
import { createCheckpoint, listCheckpoints, restoreCheckpoint, checkpointDiffStat, type Checkpoint } from "../core/checkpoint.ts";
import { MENTION_RE, attachFiles, listProjectFiles, mentionedFiles } from "../core/files.ts";
import pkg from "../../package.json" with { type: "json" };
import { platformArgv, shellArgv } from "../core/spawn.ts";
import { cleanError, isLimitNotice, parseResetTime } from "../engines/errors.ts";
import { TurnRecorder } from "../core/journal.ts";
import { Awake, defaultAwakeDeps, recoverAwake } from "../core/awake.ts";
import { buildReviewPrompt, forwardMessage, parseNote } from "../core/review.ts";

const HOTKEY_NAMES: Record<string, string[]> = { "/": ["/", "_", "?"], "^": ["^", "6"] };
const VERSION = pkg.version;
const MODE_CYCLE = ["default", "acceptEdits", "plan"];

interface Active {
  agent: AgentId;
  name: string;
  engine: Engine;
  turn: { block: AgentBlock; tools: Set<string>; startedAt: number; tokens: number; chars: number; verb: string; rec?: TurnRecorder } | null;
  replay: AgentBlock | null;
  unsubscribe: () => void;
  mode?: string;
  commands: { name: string; description?: string }[];
  /** Context window fill, when the agent reports it. */
  context?: { used: number; size: number };
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
  private today = new Map<BudgetKey, number>();
  private budgetNotified = new Map<BudgetKey, "warn" | "over">();
  private checkpoints: (Checkpoint & { agent: AgentId })[] = [];
  private projectFiles: string[] | null = null;
  private side = new Set<Active>();
  private sessionTokens = 0;
  private historyIdx = -1;
  private draft = "";
  private queue: string[] = [];
  private lastCtrlC = 0;
  private switching = false;
  /** Set by quit(); async work that resumes afterwards (a handoff being built) stops. */
  private closed = false;
  /** Side agent (/side): reviews the main agent's work after each turn. */
  private reviewer: { agent: AgentId; name: string; engine: Engine; busy: boolean; pending: boolean; since: number; primed: boolean } | null = null;
  private notes: { ts: number; agent: AgentId; name: string; text: string }[] = [];
  /** Keep-awake (/awake). Tests swap its system runner. */
  awake = new Awake({ ...defaultAwakeDeps(), interactive: (fn) => this.withTerminal(fn) });
  private resolveDone!: () => void;
  readonly done: Promise<void>;
  /** Test hooks. */
  engineFactory: (agent: AgentId) => Engine = createEngine;
  checkBlockers: (agent: AgentId) => ReturnType<typeof blockers> = blockers;
  /** Copy-on-select target (tests swap it to keep the real clipboard untouched). */
  copyText: (text: string) => Promise<boolean> = (text) => copyToClipboard(this.renderer, text);

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
    this.inputWrap = new BoxRenderable(renderer, { id: "input-wrap", width: "100%", flexShrink: 0, flexDirection: "column", border: ["top", "bottom"], borderStyle: "single", borderColor: C.accent });
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
      "! to run a shell command  /model to pick a model                    /compact for a handoff summary",
      "@ to attach a file        /undo reverts the last turn's edits        /ask <agent> <msg> for a one-off",
      "ctrl + o expands output   ctrl + ^ switches agent                    /theme dark | light | auto",
    ])
      this.shortcuts.add(new TextRenderable(renderer, { content: l, fg: C.dim, wrapMode: "none", truncate: true }));
    root.add(this.shortcuts);
    const footer = new BoxRenderable(renderer, { id: "footer", width: "100%", height: 1, flexShrink: 0, paddingX: 2 });
    this.footerText = new TextRenderable(renderer, { id: "footer-text", content: "", width: "100%", wrapMode: "none", truncate: true, fg: C.dim });
    footer.add(this.footerText);
    root.add(footer);
    renderer.root.add(root);
    // Select text with the mouse to copy it (like a terminal's copy-on-select).
    renderer.on("selection", (sel: { getSelectedText(): string } | null) => {
      const text = sel?.getSelectedText?.() ?? "";
      if (!text.trim()) return;
      void this.copyText(text).then((ok) => this.setFlash(ok ? `copied ${text.length} chars` : "could not copy: no clipboard available"));
    });

    renderer.keyInput.on("keypress", this.onKey);
    renderer.on("resize", () => this.palette?.render());
    this.input.focus();
    this.renderFooter();
  }

  async start(agent: AgentId, fresh: boolean, o: { pick?: boolean } = {}) {
    try {
      this.today = spendToday();
    } catch {
      /* no usage yet */
    }
    await this.refreshDetect();
    const ok = (a: AgentId) => this.detect.get(a)?.installed && this.detect.get(a)?.engine;
    const first = ok(agent) ? agent : listAdapters(this.config.order).find((a) => ok(a.id))?.id;
    if (!first) throw new Error("no agent with a protocol engine found (need claude, codex, opencode, grok or gemini on PATH)");
    const notes: string[] = [];
    if (first !== agent) notes.push(`${agent} has no protocol engine here; starting ${first}`);
    for (const n of await recoverAwake({ ...defaultAwakeDeps(), interactive: (fn) => this.withTerminal(fn) }).catch(() => [])) notes.push(n);
    if (this.config.awake && this.config.awake !== "off") {
      const st = await this.awake.set(this.config.awake).catch(() => null);
      if (st) notes.push(st.mode === "off" ? "keep-awake could not be turned on" : `keeping this machine awake${st.lid ? ", lid closed included" : ""} (/awake off to stop)`, ...st.notes);
    }
    const stripped = strippedKeys();
    if (stripped.length) notes.push(`${stripped.join(", ")} unset for agents · subscription logins only`);
    this.transcript.header({ title: `codemax v${VERSION}`, subtitle: "one terminal, every coding agent", path: this.cwd, notes });
    if ((this.config as any).priceUpdates !== false) void refreshLivePricesIfStale().then((l) => l && resetPriceCache());
    if (o.pick && !fresh && this.openPicker(first)) return this.done;
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
    if (key.name === "o" && key.ctrl) {
      key.stopPropagation();
      this.setFlash(this.transcript.toggleExpanded() ? "showing full output · ctrl+o to collapse" : "output collapsed");
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
    const mention = text.match(MENTION_RE);
    if (mention && !text.startsWith("/")) {
      void this.openFilePalette(mention[2]!);
      return;
    } else if (this.paletteKind === "files") this.closePalette();
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
    const busy = !!this.active?.turn;
    const immediate = /^\/(quit|exit|q|help|status|usage|cost|diff|clear|switch|agents)\b/.test(text);
    if (busy && !immediate && (text.startsWith("/") || text.startsWith("!"))) {
      this.queue.push(text);
      this.transcript.note(`queued until the turn ends: ${text.slice(0, 60)}`, C.dim);
      this.renderFooter();
      return;
    }
    if (text.startsWith("/")) return this.command(text);
    if (text.startsWith("!")) return this.shell(text.slice(1).trim());
    if (!this.active) {
      this.transcript.note("no agent running — /switch to start one", C.warn);
      return;
    }
    const route = this.routeFor(text);
    if (route && route !== this.active.agent && !this.active.turn) return this.askAgent(route, text, `routed to ${route} by rule`);
    if (this.active.turn) {
      this.queue.push(text);
      this.transcript.note(`queued: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`, C.dim);
      return;
    }
    await this.send(this.active, text);
  }

  /** Append @file contents and pending shell output to an outgoing message. */
  private withAttachments(text: string): string {
    const files = mentionedFiles(text, this.cwd);
    if (files.length) {
      text += attachFiles(files, this.cwd);
      this.transcript.note(`attached ${files.join(", ")}`, C.dimmer);
    }
    if (this.pendingShell.length) {
      text = `${text}\n\n[shell output the user ran in this repo]\n${this.pendingShell.join("\n\n")}`;
      this.pendingShell = [];
    }
    return text;
  }

  private async checkpoint(active: Active, text: string): Promise<Checkpoint | null> {
    if (!this.config.checkpoints) return null;
    const cp = await createCheckpoint(this.cwd, `before ${active.agent}: ${text.slice(0, 60).replace(/\s+/g, " ")}`).catch(() => null);
    if (cp) this.checkpoints.push({ ...cp, agent: active.agent });
    return cp;
  }

  private async undo() {
    if (this.active?.turn) return this.transcript.note("the agent is working; Esc first, then /undo", C.warn);
    const cp = this.checkpoints.pop() ?? (await listCheckpoints(this.cwd, 1))[0];
    if (!cp) return this.transcript.note("no checkpoint to restore (checkpoints need a git repo)", C.warn);
    const stat = await checkpointDiffStat(this.cwd, cp.sha);
    if (!stat.trim()) {
      this.transcript.note(`nothing changed since the checkpoint "${cp.label}"`);
      return;
    }
    const r = await restoreCheckpoint(this.cwd, cp.sha);
    this.transcript.note(`reverted to the snapshot ${cp.label}`, C.warn);
    for (const l of stat.split("\n")) this.transcript.note(l);
    if (r.removed.length) this.transcript.note(`removed ${r.removed.length} new file(s): ${r.removed.slice(0, 5).join(", ")}${r.removed.length > 5 ? "…" : ""}`);
    this.pendingShell.push("[codemax] The user reverted the file changes from the last turn with /undo. The working tree is back to the state before that turn.");
  }

  private async showCheckpoints() {
    const list = await listCheckpoints(this.cwd, 10);
    if (!list.length) return this.transcript.note("no checkpoints yet");
    for (const c of list) this.transcript.note(`${fmtTime(c.ts)}  ${c.sha.slice(0, 8)}  ${c.label}`);
    this.transcript.note("/undo restores the most recent one");
  }

  private routeFor(text: string): AgentId | null {
    for (const r of this.config.routes ?? []) {
      try {
        if (new RegExp(r.match, "i").test(text) && this.detect.get(r.agent)?.engine) return r.agent;
      } catch {
        /* bad regex in config */
      }
    }
    return null;
  }

  private async ask(args: string) {
    const [id, ...rest] = args.trim().split(/\s+/);
    const msg = rest.join(" ");
    if (!id || !msg) return this.transcript.note("usage: /ask <agent> <message>  e.g. /ask codex review the last commit", C.warn);
    if (!this.detect.get(id as AgentId)?.engine) return this.transcript.note(`no protocol engine for "${id}"`, C.warn);
    await this.askAgent(id as AgentId, msg, `asked ${id}`);
  }

  /** One message to another agent in a throwaway session; the current agent stays active. */
  private async askAgent(agent: AgentId, text: string, why: string) {
    const blocked = this.checkBlockers(agent);
    if (blocked.length) return this.transcript.error(`${agent} not started: ${blocked[0]!.message}`);
    const adapter = getAdapter(agent);
    const engine = this.engineFactory(agent);
    const side: Active = { agent, name: adapter.name, engine, turn: null, replay: null, unsubscribe: () => {}, commands: [] };
    this.side.add(side);
    side.unsubscribe = engine.onEvent((e) => this.onEngineEvent(side, e));
    this.transcript.divider(`${why} · ${adapter.name}`);
    this.transcript.user(text);
    try {
      await engine.start({ cwd: this.cwd });
      const brief = this.ledger.turns().length ? await buildBrief({ ledger: this.ledger, cwd: this.cwd, to: agent, from: this.active?.agent, config: this.config, purpose: "context" }) : "";
      const body = this.withAttachments(text);
      await this.checkpoint(side, text);
      this.ledger.addTurns([{ ts: Date.now(), agent, sessionId: engine.session?.id ?? "?", role: "user", text }]);
      // One-off answers are not task work: they stay out of the journal (a "done" turn here
      // would split the current task in two).
      await this.runTurn(side, brief ? `${brief}\n\n## This message (answer it; the user stays with ${this.active?.name ?? "another agent"})\n${body}` : body, { journal: false });
    } catch (e: any) {
      this.transcript.error(`${adapter.name}: ${e?.message ?? e}`);
    } finally {
      side.unsubscribe();
      this.side.delete(side);
      await engine.close().catch(() => {});
      if (this.active) this.transcript.divider(`back to ${this.active.name}`);
    }
  }

  private showBudget() {
    const b = this.config.budgets ?? {};
    const keys = Object.keys(b) as BudgetKey[];
    if (!keys.length) return this.transcript.note('no budgets set · add "budgets": {"claude": 20, "all": 50} (USD per day) to ~/.codemax/config.json');
    for (const k of keys) {
      const spent = this.today.get(k) ?? 0;
      this.transcript.note(`${k.padEnd(8)} ${fmtUsd(spent)} of ${fmtUsd(b[k])} today (${Math.round((spent / b[k]!) * 100)}%)`);
    }
  }

  private checkBudget(agent: AgentId) {
    const b = this.config.budgets ?? {};
    for (const k of [agent, "all"] as BudgetKey[]) {
      const level = budgetLevel(this.today.get(k) ?? 0, b[k]);
      if (level === "ok" || this.budgetNotified.get(k) === level || (level === "warn" && this.budgetNotified.get(k) === "over")) continue;
      this.budgetNotified.set(k, level);
      const spent = fmtUsd(this.today.get(k) ?? 0);
      const label = k === "all" ? "all agents" : getAdapter(k).name;
      if (level === "warn") this.transcript.note(`${label} has used ${spent} of its ${fmtUsd(b[k])} daily budget (80%+)`, C.warn);
      else this.offerHandoff(agent, `${label} reached its ${fmtUsd(b[k])} daily budget (${spent})`, k === "all");
    }
  }

  /** Best agent to continue on: config order, installed with an engine, not exhausted or over budget. */
  private nextAgent(from: AgentId): AgentId | null {
    const b = this.config.budgets ?? {};
    for (const a of listAdapters(this.config.order)) {
      if (a.id === from) continue;
      const d = this.detect.get(a.id);
      if (!d?.installed || !d.engine) continue;
      if (isExhausted(this.quota.get(a.id))) continue;
      if (budgetLevel(this.today.get(a.id) ?? 0, b[a.id]) === "over") continue;
      return a.id;
    }
    return null;
  }

  /** One-key handoff offer: Enter continues the task in the next agent. */
  private pendingOffer: { from: AgentId; reason: string; allAgents: boolean } | null = null;

  private offerHandoff(from: AgentId, reason: string, allAgents = false) {
    // Never interrupt a running turn: show the offer when it ends.
    if (this.active?.turn || this.permission) {
      if (!this.pendingOffer) this.transcript.note(`${reason} · you'll be offered a handoff when this turn ends`, C.warn);
      this.pendingOffer = { from, reason, allAgents };
      return;
    }
    if (this.paletteKind === "handoff") return;
    const next = allAgents ? null : this.nextAgent(from);
    this.transcript.note(reason, C.warn);
    if (!next) {
      this.transcript.note(allAgents ? "every agent shares that budget · raise it in ~/.codemax/config.json to continue" : "no other agent is available · /switch to pick one anyway", C.warn);
      return;
    }
    this.closePalette();
    const items: PaletteItem[] = [
      { label: `Continue in ${getAdapter(next).name}`, description: "hand over the conversation and the unfinished request", value: next },
      ...listAdapters(this.config.order)
        .filter((a) => a.id !== next && a.id !== from && this.detect.get(a.id)?.engine)
        .map((a) => ({ label: `Continue in ${a.name}`, description: isExhausted(this.quota.get(a.id)) ? "out of quota" : "", value: a.id, disabled: isExhausted(this.quota.get(a.id)) })),
      { label: `Stay on ${getAdapter(from).name}`, description: "keep going here anyway", value: "__stay" },
    ];
    this.paletteKind = "handoff";
    this.palette = new Palette(this.renderer, {
      title: `${reason} · Enter to continue in ${getAdapter(next).name}`,
      items,
      onPick: (it) => {
        this.closePalette();
        if (it.value !== "__stay") void this.switchTo(it.value as AgentId, false, { resumeTask: true });
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    // keep the offered order (Continue first), not alphabetical
    (this.palette as any).opts.items.forEach((it: PaletteItem, i: number) => (it.weight = 100 - i));
    this.palette.setFilter("");
    this.renderer.root.add(this.palette.box);
  }

  private async openFilePalette(filter: string) {
    if (!this.projectFiles) this.projectFiles = await listProjectFiles(this.cwd).catch(() => []);
    if (this.paletteKind === "files" && this.palette) return this.palette.setFilter(filter);
    this.closePalette(false);
    this.paletteKind = "files";
    this.palette = new Palette(this.renderer, {
      title: "Attach a file · Tab or Enter to insert · Esc to cancel",
      items: this.projectFiles.map((f) => ({ label: f, value: f })),
      filter,
      tabAccepts: true,
      onPick: (it) => {
        const text = this.input.plainText.replace(MENTION_RE, (_m, pre) => `${pre}@${it.value} `);
        this.closePalette();
        this.input.setText(text);
        try {
          (this.input as any).gotoBufferEnd?.();
        } catch {
          /* cursor helper missing */
        }
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  /** Startup picker: resume a recent session or start fresh. Returns false when there is nothing to pick. */
  private openPicker(defaultAgent: AgentId): boolean {
    const sessions = Object.values(this.ledger.sessions()).filter((s): s is SessionRef => !!s && !!this.detect.get(s.agent)?.engine);
    if (!sessions.length) return false;
    sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    const turns = this.ledger.turns();
    const items: PaletteItem[] = sessions.map((s, i) => {
      const last = [...turns].reverse().find((t) => t.agent === s.agent && t.role === "user");
      return {
        label: `Resume ${getAdapter(s.agent).name}`,
        description: `${ago(s.lastUsedAt)}${last ? ` · "${last.text.replace(/\s+/g, " ").slice(0, 60)}"` : ""}`,
        value: `resume:${s.agent}`,
        weight: 100 - i,
      };
    });
    items.push({ label: `New session with ${getAdapter(defaultAgent).name}`, description: "start fresh (history stays in the ledger)", value: `new:${defaultAgent}`, weight: 0 });
    this.paletteKind = "picker";
    this.palette = new Palette(this.renderer, {
      title: "Resume a session · Enter to continue · Esc for the most recent",
      items,
      onPick: (it) => {
        this.closePalette();
        const [kind, agent] = it.value.split(":") as ["resume" | "new", AgentId];
        void this.launch(agent, { fresh: kind === "new" });
      },
      onClose: () => {
        this.closePalette();
        void this.launch(sessions[0]!.agent, { fresh: false });
      },
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
    return true;
  }

  /** Run one queued entry the same way as if it had just been typed. */
  private async dispatch(active: Active, text: string) {
    if (text.startsWith("!")) return this.shell(text.slice(1).trim());
    if (text.startsWith("/")) return this.command(text);
    return this.send(active, text);
  }

  private async drainQueue(active: Active) {
    while (this.queue.length && this.active === active && !active.turn) await this.dispatch(active, this.queue.shift()!);
    this.renderFooter();
  }

  private async send(active: Active, text: string) {
    this.transcript.user(text);
    text = this.withAttachments(text);
    const cp = await this.checkpoint(active, text);
    this.ledger.addTurns([{ ts: Date.now(), agent: active.agent, sessionId: active.engine.session?.id ?? "?", role: "user", text }]);
    const rec = new TurnRecorder(this.ledger.journal, active.agent);
    rec.user(text, cp?.sha);
    await this.runTurn(active, text, { rec });
    await this.drainQueue(active);
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
      { name: "/model", description: "Pick the model for the current agent", run: (a) => this.openModels(a) },
      { name: "/effort", description: "Reasoning effort for the current agent, when it offers one", run: (a) => this.openEffort(a) },
      { name: "/task", description: "The shared task: request, plan, who did what, where it stopped, files changed", run: () => void this.showTask() },
      { name: "/compact", description: "Have the agent write a project summary used in every handoff", run: () => void this.compact() },
      { name: "/diff", description: "Uncommitted changes in this repo", run: () => void this.showDiff() },
      { name: "/agents", description: "Show agents, sessions and quota", run: () => this.openSwitch() },
      { name: "/usage", description: "Tokens and API-equivalent cost per agent (like /cost)", run: () => this.showUsage() },
      { name: "/cost", description: "Alias of /usage", run: () => this.showUsage() },
      { name: "/status", description: "Session, ledger and quota details", run: () => this.showStatus() },
      { name: "/clear", description: "Clear the screen (history stays in the ledger)", run: () => this.clearScreen() },
      { name: "/help", description: "Keyboard shortcuts and commands", run: () => void (this.shortcuts.visible = true) },
      { name: "/new", description: "Start a fresh session with the current agent", run: () => void (this.active && this.switchTo(this.active.agent, true)) },
      { name: "/undo", description: "Revert the files changed by the last agent turn", run: () => void this.undo() },
      { name: "/checkpoints", description: "List working-tree snapshots taken before each turn", run: () => void this.showCheckpoints() },
      { name: "/ask", description: "Send one message to another agent without switching: /ask codex <msg>", run: (a) => void this.ask(a) },
      { name: "/budget", description: "Today's spend against your daily budgets", run: () => this.showBudget() },
      { name: "/side", description: "Side agent that reviews each turn: /side codex | /side codex auto | /side off", run: (a) => void this.setSide(a) },
      { name: "/notes", description: "Notes the side agent left", run: () => this.showNotes() },
      { name: "/forward", description: "Send the side agent's latest note (or /forward <n>) to the main agent", run: (a) => this.forwardNote(a.trim() ? Number(a) - 1 : undefined) },
      { name: "/awake", description: "Keep the machine awake while agents work: /awake on | lid | off", run: (a) => void this.setAwake(a) },
      { name: "/theme", description: "Colour theme: /theme dark | light | auto (saved; restart to apply everywhere)", run: (a) => this.setThemePref(a) },
      { name: "/quit", description: "Quit codemax", run: () => void this.quit() },
    ];
  }

  /** Run something that needs the real terminal (a sudo password prompt): pause the screen around it. */
  private async withTerminal<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await this.renderer.suspend();
    } catch {
      /* test renderer */
    }
    try {
      return await fn();
    } finally {
      try {
        await this.renderer.resume();
      } catch {
        /* test renderer */
      }
    }
  }

  private async setAwake(arg: string) {
    const v = arg.trim().toLowerCase();
    if (v !== "on" && v !== "lid" && v !== "off") {
      const s = this.awake.status;
      this.transcript.note(`awake: ${s.mode}${s.lid ? " (lid closed included)" : ""} · /awake on keeps the machine from sleeping · /awake lid also keeps working with the lid closed · /awake off`);
      return;
    }
    const st = await this.awake.set(v);
    try {
      saveConfigKey("awake", st.mode);
    } catch {
      /* read-only home */
    }
    this.config.awake = st.mode;
    this.transcript.note(st.mode === "off" ? (v === "off" ? "awake off: the machine can sleep normally again" : "keep-awake could not be turned on") : `awake ${st.mode}: this machine will not sleep while codemax runs${st.lid ? ", even with the lid closed" : ""}`, st.mode === "off" ? C.dim : C.accent);
    for (const n of st.notes) this.transcript.note(n, C.warn);
    this.renderFooter();
  }

  private setThemePref(arg: string) {
    const v = arg.trim().toLowerCase();
    if (v !== "dark" && v !== "light" && v !== "auto") {
      this.transcript.note(`theme is ${this.config.theme ?? "auto"} · use /theme dark, /theme light or /theme auto`);
      return;
    }
    this.config.theme = v;
    try {
      saveConfigKey("theme", v);
    } catch {
      /* read-only home: still applies for this run */
    }
    if (v !== "auto") applyTheme(v);
    this.transcript.note(`theme set to ${v}; new lines use it now, everything after a restart`, C.accent);
    this.renderFooter();
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

  private pendingShell: string[] = [];

  /** `!cmd`: run locally, show output, and attach it to the next prompt as context. */
  private async shell(cmd: string) {
    if (!cmd) return;
    this.transcript.user(`! ${cmd}`);
    const p = Bun.spawn(shellArgv(cmd), { cwd: this.cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    const body = (out + (err ? `\n${err}` : "")).trimEnd() || "(no output)";
    const block = this.transcript.agent();
    block.tool(`sh-${Date.now()}`, `$ ${cmd}${code ? `  (exit ${code})` : ""}`, code ? "failed" : "completed", body);
    this.pendingShell.push(`$ ${cmd}\n${body.slice(0, 4000)}`);
    this.transcript.note("output will be sent with your next message", C.dimmer);
  }

  private async showDiff() {
    const { diffStat } = await import("../core/git.ts");
    for (const l of (await diffStat(this.cwd)).split("\n")) this.transcript.note(l);
  }

  private openModels(arg: string) {
    const a = this.active;
    if (!a) return;
    const models = a.engine.info?.models ?? [];
    if (!a.engine.setModel || !models.length) return this.transcript.note(`${a.name} does not expose model choice over its protocol`, C.dim);
    if (models.length === 1 && !arg) {
      const effort = this.effortOption(a);
      return this.transcript.note(`${a.name} offers one model on your plan: ${models[0]!.name}${effort ? ` · /effort changes its reasoning effort (now ${effort.current})` : ""}`);
    }
    const apply = async (id: string) => {
      try {
        await a.engine.setModel!(id);
        this.transcript.note(`model: ${id}`);
        if (a.agent === "cursor") this.transcript.note("Cursor saves this as its default model, so Cursor uses it outside codemax too", C.warn);
        this.renderFooter();
      } catch (e: any) {
        this.transcript.error(`could not switch model: ${e?.message ?? e}`);
      }
    };
    if (arg) return void apply(arg);
    this.closePalette();
    this.paletteKind = "modes";
    this.palette = new Palette(this.renderer, {
      title: `Model for ${a.name}`,
      items: models.map((m) => ({ label: m.id, description: `${m.name !== m.id ? m.name : ""}${m.id === a.engine.info?.currentModel ? "  (current)" : ""}`, value: m.id })),
      onPick: (it) => {
        this.closePalette();
        void apply(it.value);
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  private effortOption(a: Active) {
    return a.engine.info?.options?.find((o) => o.category === "thought_level" || /effort|reasoning/i.test(o.id));
  }

  /** /effort: reasoning effort, for agents that expose it (Grok, Cursor variants). */
  private openEffort(arg: string) {
    const a = this.active;
    if (!a) return;
    const o = this.effortOption(a);
    if (!o || !a.engine.setOption) return this.transcript.note(`${a.name} does not expose reasoning effort`, C.dim);
    const apply = async (value: string) => {
      try {
        await a.engine.setOption!(o.id, value);
        this.transcript.note(`${o.name.toLowerCase()}: ${value}`);
        this.renderFooter();
      } catch (e: any) {
        this.transcript.error(`could not change ${o.name.toLowerCase()}: ${e?.message ?? e}`);
      }
    };
    const want = arg.trim().toLowerCase();
    if (want) {
      const v = o.values.find((x) => x.value.toLowerCase() === want || x.name.toLowerCase() === want);
      if (v) return void apply(v.value);
      return this.transcript.note(`unknown ${o.name.toLowerCase()} "${arg}" (${o.values.map((x) => x.value).join(", ")})`, C.warn);
    }
    this.closePalette();
    this.paletteKind = "modes";
    this.palette = new Palette(this.renderer, {
      title: `${o.name} for ${a.name}`,
      items: o.values.map((v) => ({ label: v.value, description: `${v.name !== v.value ? v.name : ""}${v.value === o.current ? "  (current)" : ""}${v.description ? ` · ${v.description}` : ""}`, value: v.value })),
      onPick: (it) => {
        this.closePalette();
        void apply(it.value);
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  /** Ask the active agent for a compact project summary and store it for every future handoff. */
  async compact(o: { quiet?: boolean } = {}): Promise<boolean> {
    const a = this.active;
    if (!a) return false;
    if (a.turn) {
      if (!o.quiet) this.transcript.note("the agent is busy; run /compact when the turn ends", C.warn);
      return false;
    }
    const prompt =
      "[codemax] Write a compact project summary for another coding agent that will take over this repository. " +
      "Max 250 words, plain markdown: goal, what is done (files touched), what is in progress, open problems, next step. " +
      "Do not use any tools. Reply with the summary only.";
    this.transcript.note(o.quiet ? `asking ${a.name} for a handoff summary before switching · esc to skip` : `asking ${a.name} for a handoff summary…`);
    const block = this.transcript.agent();
    a.turn = { block, tools: new Set(), startedAt: Date.now(), tokens: 0, chars: 0, verb: "Summarizing" };
    this.startSpinner(a);
    const stop = await a.engine.prompt(prompt);
    a.turn = null;
    this.stopSpinner();
    const text = block.text().trim();
    if (stop === "end_turn" && text.length > 40) {
      this.ledger.writeSummary(`_${a.name}, ${new Date().toISOString().slice(0, 16).replace("T", " ")}_\n\n${text}`);
      block.footer("summary saved · used in every handoff");
      return true;
    }
    block.footer("no summary saved");
    return false;
  }

  private async showTask() {
    const j = this.ledger.journal;
    const steps = j.steps();
    const task = j.task(steps);
    if (!task.request) return this.transcript.note("no task yet · send a request and every agent's steps are recorded here");
    const t = (ts: number) => fmtTime(ts);
    const lastEnd = [...task.steps].reverse().find((s) => s.kind === "end") as Extract<typeof steps[number], { kind: "end" }> | undefined;
    const plan = [...task.steps].reverse().find((s) => s.kind === "plan") as Extract<typeof steps[number], { kind: "plan" }> | undefined;
    const tools = task.steps.filter((s) => s.kind === "tool");
    const byAgent = new Map<string, number>();
    for (const s of tools) byAgent.set(s.agent, (byAgent.get(s.agent) ?? 0) + 1);
    const status = !lastEnd ? "just started"
      : lastEnd.outcome === "done" ? (plan?.entries.some((e) => e.status !== "completed") ? `in progress · ${lastEnd.agent} finished a turn at ${t(lastEnd.ts)}` : `done · ${lastEnd.agent} at ${t(lastEnd.ts)}`)
      : lastEnd.outcome === "limit" ? `stopped · ${lastEnd.agent} hit its limit at ${t(lastEnd.ts)} · /switch to continue elsewhere`
      : lastEnd.outcome === "cancelled" ? `paused · interrupted at ${t(lastEnd.ts)}`
      : `stopped · ${lastEnd.agent} hit an error at ${t(lastEnd.ts)}`;
    this.transcript.note(`task: "${task.request.text.replace(/\s+/g, " ").slice(0, 120)}" · started ${t(task.request.ts)}`, C.accent);
    this.transcript.note(`status: ${status}`);
    if (task.followUps.length) this.transcript.note(`follow-ups: ${task.followUps.length}`);
    this.transcript.note(`steps: ${[...byAgent].map(([a, n]) => `${a} ${n}`).join(" · ") || "none yet"}`);
    if (plan) for (const e of plan.entries) this.transcript.note(`${e.status === "completed" ? G.done_ : e.status === "in_progress" ? G.doing : G.todo} ${e.content}`, e.status === "in_progress" ? C.accent : C.dim);
    const inFlight = (lastEnd?.inFlight ?? []).map((id) => tools.find((s) => s.id === id)).filter(Boolean) as { title: string }[];
    for (const f of inFlight) this.transcript.note(`in flight when it stopped: ${f.title}`, C.warn);
    const stat = task.request.checkpoint ? await checkpointDiffStat(this.cwd, task.request.checkpoint).catch(() => "") : "";
    if (!task.request.checkpoint) this.transcript.note("file changes unknown: snapshots are off (checkpoints: false) or this is not a git repo");
    else this.transcript.note(stat.trim() ? `changed since the task started:\n${stat.trim()}` : "no file changes since the task started");
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

  private paletteKind: "commands" | "switch" | "modes" | "files" | "handoff" | "picker" | null = null;

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

  private switchItems(): PaletteItem[] {
    const sessions = this.ledger.sessions();
    return listAdapters(this.config.order).map((a) => {
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
  }

  openSwitch() {
    this.closePalette();
    const items = this.switchItems();
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
    const p = this.palette;
    void this.refreshDetect().then(() => this.palette === p && p.setItems(this.switchItems()));
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

  private closePalette(_focus = true) {
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
      this.setTitle();
      // Only brief the agent when there is something to hand over: a brief with
      // nothing in it costs a turn (and quota) for no context.
      const hasHistory = this.ledger.turns().length > 0 || this.ledger.journal.steps().some((s) => s.kind === "user");
      if (hasHistory) {
        const input = { ledger: this.ledger, cwd: this.cwd, to: agent, from: o.from, reason: o.reason, config: this.config };
        // A resumed session already remembers its own work: tell it only what others did since.
        const catchup = resumed ? await buildCatchup(input) : null;
        const packet = resumed ? catchup : await buildBrief(input);
        if (this.closed || this.active !== active) return;
        if (packet) {
          const task = this.ledger.journal.task();
          const what = resumed ? "catching it up on what the other agents did" : task.request ? `handing over the task: ${task.steps.filter((s) => s.kind === "tool").length} steps, the plan and the code diff` : "handing over the conversation and the repo state";
          this.transcript.note(`${what} (${packet.length} chars)`);
          // Snapshot first: the new agent may edit files in this turn, and both /undo and a
          // later catch-up need the state from before it started.
          const cp = await this.checkpoint(active, `handoff to ${agent}`);
          const rec = new TurnRecorder(this.ledger.journal, agent);
          rec.handoff({ from: o.from, reason: o.reason, mode: resumed ? "catchup" : "packet", chars: packet.length, checkpoint: cp?.sha });
          await this.runTurn(active, packet, { record: false, rec });
        }
      }
      await this.drainQueue(active);
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

  private async runTurn(active: Active, text: string, o: { record?: boolean; rec?: TurnRecorder; journal?: boolean } = {}) {
    const block = this.transcript.agent();
    const rec = o.journal === false ? undefined : (o.rec ?? new TurnRecorder(this.ledger.journal, active.agent));
    active.turn = { block, tools: new Set(), startedAt: Date.now(), tokens: 0, chars: 0, verb: pick(VERBS), rec };
    this.startSpinner(active);
    this.setTitle(`✳ ${active.name} working`);
    const stop = await active.engine.prompt(text);
    if (this.closed) {
      active.turn?.rec?.end(stop);
      active.turn = null;
      return;
    }
    const turn = active.turn;
    active.turn = null;
    this.stopSpinner();
    this.setTitle();
    if (turn && this.config.bellAfterSeconds > 0 && Date.now() - turn.startedAt > this.config.bellAfterSeconds * 1000) process.stdout.write("\x07");
    if (turn) {
      const dur = fmtDuration(Date.now() - turn.startedAt);
      block.footer(stop === "cancelled" ? `Interrupted after ${dur}` : `${pick(DONE_VERBS, turn.startedAt)} for ${dur} · done ${fmtTime(Date.now())}`);
      const reply = block.text().trim();
      if (isLimitNotice(reply)) turn.rec?.markLimit(reply);
      turn.rec?.end(stop);
      // The side agent reviews main-agent turns that did work (not /ask, not summaries).
      if (turn.rec && this.active === active && !this.side.has(active) && (turn.tools.size > 0 || reply.length > 0)) void this.review();
      if (isLimitNotice(reply)) {
        // The agent ended the turn with only a limit notice: treat it as running out, and leave
        // the user's request unanswered in the ledger so the next agent is asked to finish it.
        this.onQuota({ agent: active.agent, exhausted: true, source: "probe", detail: reply.slice(0, 120), resetsAt: parseResetTime(reply), at: Date.now() });
      } else if (o.record !== false) {
        if (reply || turn.tools.size) {
          this.ledger.addTurns([{ ts: Date.now(), agent: active.agent, sessionId: active.engine.session?.id ?? "?", role: "assistant", text: reply, tools: turn.tools.size ? [...turn.tools] : undefined }]);
        }
      }
    }
    this.renderFooter();
    const offer = this.pendingOffer;
    if (offer && this.active === active) {
      this.pendingOffer = null;
      this.offerHandoff(offer.from, offer.reason, offer.allAgents);
    }
  }

  private onEngineEvent(active: Active, e: EngineEvent) {
    if (this.active !== active && !this.side.has(active) && e.type !== "permission_request") return;
    const target = () => active.turn?.block ?? (active.replay ??= this.transcript.agent());
    switch (e.type) {
      case "text_delta":
        if (active.turn) active.turn.chars += e.text.length;
        active.turn?.rec?.textDelta(e.text, e.messageId);
        target().append(e.text, e.messageId);
        break;
      case "thought_delta":
        if (active.turn) {
          active.turn.chars += e.text.length;
          active.turn.verb = "Thinking";
        }
        active.turn?.rec?.thoughtDelta(e.text);
        target().thought(e.text, e.messageId);
        break;
      case "plan":
        active.turn?.rec?.plan(e.entries);
        target().plan(e.entries);
        break;
      case "tool_call":
        active.turn?.tools.add(e.title.split(/[\s(]/)[0] ?? e.title);
        active.turn?.rec?.tool(e.id, { title: e.title, kind: e.kind, status: e.status, input: e.input, output: e.output, files: e.files });
        target().tool(e.id, e.title, e.status, e.detail);
        break;
      case "tool_update":
        active.turn?.rec?.tool(e.id, { title: e.title, status: e.status, input: e.input, output: e.output, files: e.files });
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
        if (typeof e.contextUsed === "number" && typeof e.contextSize === "number" && e.contextSize > 0) {
          active.context = { used: e.contextUsed, size: e.contextSize };
          this.renderFooter();
        }
        if (typeof e.usedPercent === "number") this.onQuota({ agent: active.agent, usedPercent: e.usedPercent, exhausted: e.usedPercent >= 100, source: "probe", at: Date.now() });
        this.recordUsage(active.agent, active.engine, e);
        break;
      }
      case "session":
        if (this.side.has(active)) break; // /ask sessions are throwaway, not resumable
        this.ledger.saveSession({ agent: active.agent, id: e.ref.id, cwd: this.cwd, startedAt: e.ref.startedAt, lastUsedAt: Date.now() } as SessionRef);
        break;
      case "error":
        this.transcript.error(`${active.name}: ${e.message.slice(0, 500)}`);
        if (e.kind === "quota") active.turn?.rec?.markLimit(cleanError(e.message));
        else active.turn?.rec?.markError(cleanError(e.message));
        if (e.kind === "quota") this.onQuota({ agent: active.agent, exhausted: true, source: "probe", detail: e.message.slice(0, 120), resetsAt: parseResetTime(e.message), at: Date.now() });
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
      if (this.config.autoSwitch && (!this.active || this.active.agent === q.agent)) this.offerHandoff(q.agent, `${getAdapter(q.agent).name} is out of quota${q.resetsAt ? ` until ${fmtTime(q.resetsAt)}` : ""}`);
    }
  }

  // ---------- working line, footer ----------

  /** Price and record a usage event (main, /ask and side-agent sessions alike). */
  private recordUsage(agent: AgentId, engine: Engine, e: Extract<EngineEvent, { type: "usage" }>) {
    const hasTokens = (e.inputTokens ?? 0) + (e.outputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheWriteTokens ?? 0) > 0;
    // A zero cost with no tokens (free models report cost 0 on every update) is not usage.
    if (!hasTokens && !((e.costUsd ?? 0) > 0)) return;
    const rec = priceRecord({
      ts: Date.now(),
      agent,
      sessionId: engine.session?.id ?? "?",
      model: e.model ?? engine.info?.currentModel,
      input: e.inputTokens ?? 0,
      output: e.outputTokens ?? 0,
      cacheRead: e.cacheReadTokens ?? 0,
      cacheWrite: e.cacheWriteTokens ?? 0,
      agentCostUsd: typeof e.costUsd === "number" ? e.costUsd : undefined,
    });
    this.ledger.addUsage(rec);
    this.sessionCost += recordCost(rec).usd;
    this.sessionTokens += rec.input + rec.output + rec.cacheRead + rec.cacheWrite;
    addSpend(this.today, rec);
    this.renderFooter();
    this.checkBudget(agent);
  }

  // ---------- side agent ----------

  private async setSide(arg: string) {
    const [who, mode] = arg.trim().toLowerCase().split(/\s+/);
    const cfg = this.config.sideAgent ?? { agent: null, forward: "ask" as const };
    if (!who) {
      this.transcript.note(cfg.agent ? `side agent: ${cfg.agent} · notes ${cfg.forward === "auto" ? "go to the main agent automatically" : "wait for /forward"} · /side off to stop` : "no side agent · /side codex adds one that reviews each turn (/side codex auto forwards its notes by itself)");
      return;
    }
    if (who === "off") {
      await this.closeReviewer();
      this.config.sideAgent = { ...cfg, agent: null };
    } else {
      if (!this.detect.get(who as AgentId)?.engine) return this.transcript.note(`no protocol engine for "${who}"`, C.warn);
      await this.closeReviewer();
      this.config.sideAgent = { agent: who as AgentId, forward: mode === "auto" ? "auto" : "ask" };
    }
    try {
      saveConfigKey("sideAgent", this.config.sideAgent);
    } catch {
      /* read-only home */
    }
    const s = this.config.sideAgent;
    this.transcript.note(s.agent ? `side agent: ${getAdapter(s.agent).name} reviews each turn and speaks up only when something needs attention${s.forward === "auto" ? "; its notes go to the main agent automatically" : " · /forward sends a note to the main agent"}` : "side agent off", s.agent ? C.accent : C.dim);
    this.renderFooter();
  }

  private async closeReviewer() {
    const r = this.reviewer;
    this.reviewer = null;
    if (r) await r.engine.close().catch(() => {});
  }

  /** After a main turn: let the side agent review the new steps (in the background). */
  private async review() {
    const cfg = this.config.sideAgent;
    if (!cfg?.agent || this.closed) return;
    let r = this.reviewer;
    if (r?.busy) {
      r.pending = true;
      return;
    }
    if (!r || r.agent !== cfg.agent) {
      await this.closeReviewer();
      if (this.checkBlockers(cfg.agent).length) return;
      const engine = this.engineFactory(cfg.agent);
      r = { agent: cfg.agent, name: getAdapter(cfg.agent).name, engine, busy: true, pending: false, since: this.lastReviewBaseline(), primed: false };
      this.reviewer = r;
      try {
        await engine.start({ cwd: this.cwd });
      } catch (e: any) {
        this.reviewer = null;
        this.transcript.note(`side agent ${r.name} could not start: ${e?.message ?? e}`, C.warn);
        return;
      }
    }
    r.busy = true;
    this.renderFooter();
    try {
      do {
        r.pending = false;
        const steps = this.ledger.journal.steps();
        const startedAt = Date.now();
        const context = r.primed ? undefined : await buildBrief({ ledger: this.ledger, cwd: this.cwd, to: r.agent, config: this.config, purpose: "context" }).catch(() => undefined);
        const prompt = buildReviewPrompt({ steps, since: r.since, mainAgent: this.active?.name ?? "the main agent", reviewer: r.agent, context });
        if (!prompt) break;
        let reply = "";
        let limited = false;
        const engine = r.engine;
        const off = engine.onEvent((e) => {
          if (e.type === "text_delta") reply += e.text;
          else if (e.type === "permission_request") {
            // A reviewer never acts: refuse anything it asks to do.
            const no = e.request.options.find((o) => /reject|deny|decline/i.test(`${o.kind} ${o.id}`)) ?? e.request.options.at(-1);
            if (no) engine.answerPermission(e.request.id, no.id);
          } else if (e.type === "usage") this.recordUsage(r!.agent, engine, e);
          else if (e.type === "error" && e.kind === "quota") limited = true;
        });
        await engine.prompt(prompt).catch(() => "error");
        off();
        r.primed = true;
        r.since = startedAt;
        if (limited || isLimitNotice(reply)) {
          this.transcript.note(`side agent ${r.name} hit its usage limit; turning it off for this session`, C.warn);
          await this.closeReviewer();
          this.renderFooter();
          return;
        }
        const note = parseNote(reply);
        if (note && !this.closed) this.addNote(r.agent, r.name, note);
      } while (r.pending && this.reviewer === r && !this.closed);
    } finally {
      if (this.reviewer === r) r.busy = false;
      this.renderFooter();
    }
  }

  /** Review from the start of the current task the first time. */
  private lastReviewBaseline(): number {
    const req = this.ledger.journal.task().request;
    return req ? req.ts - 1 : Date.now();
  }

  private addNote(agent: AgentId, name: string, text: string) {
    this.notes.push({ ts: Date.now(), agent, name, text });
    this.ledger.addEvent({ kind: "note", agent, detail: `side agent note: ${text.slice(0, 2000)}` });
    const main = this.active?.name ?? "the main agent";
    const auto = this.config.sideAgent?.forward === "auto";
    this.transcript.noteCard(`⚑ Note from ${name} (side agent)`, text, auto ? `sent to ${main} automatically` : `/forward sends this to ${main} · /notes lists all notes`);
    if (auto) this.forwardNote(this.notes.length - 1);
  }

  private forwardNote(index = this.notes.length - 1) {
    const n = this.notes[index];
    const a = this.active;
    if (!n) return this.transcript.note("no side-agent notes yet");
    if (!a) return this.transcript.note("no main agent to forward to", C.warn);
    const msg = forwardMessage(n.text, n.name);
    if (a.turn || this.switching) {
      this.queue.push(msg);
      this.transcript.note(`note queued for ${a.name} until its turn ends`);
      this.renderFooter();
      return;
    }
    void this.send(a, msg);
  }

  private showNotes() {
    if (!this.notes.length) return this.transcript.note(this.config.sideAgent?.agent ? "no notes yet: the side agent only speaks up when something needs attention" : "no side agent · /side codex adds one");
    this.notes.forEach((n, i) => this.transcript.note(`${i + 1}. ${fmtTime(n.ts)} ${n.name}: ${n.text.split("\n")[0]!.slice(0, 140)}`));
    this.transcript.note("/forward <n> sends a note to the main agent");
  }

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
      else {
        const elapsed = Date.now() - t.startedAt;
        const tip = elapsed > 8000 ? `  ⎿  tip: ${pick(TIPS, Math.floor(t.startedAt / 1000))}` : "";
        this.setWorking(`${glyph} ${t.verb}… (${secs}${tok}) · esc to interrupt${tip}`);
      }
    }, 120);
  }

  private setTitle(text?: string) {
    const base = `codemax · ${this.active?.name ?? "no agent"} · ${this.cwd.split("/").pop()}`;
    try {
      this.renderer.setTerminalTitle(text ? `${text} · ${this.cwd.split("/").pop()}` : base);
    } catch {
      /* test renderer */
    }
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
    if (this.config.sideAgent?.agent) left.push({ text: `◆ side ${this.config.sideAgent.agent}${this.reviewer?.busy ? " reviewing…" : ""}`, prio: 2 });
    // Narrow glyph: the footer is measured in characters, and an emoji takes two columns.
    if (this.awake.mode !== "off") left.push({ text: `● awake${this.awake.status.lid ? " · lid" : ""}`, prio: 1 });
    const effort = a ? this.effortOption(a)?.current : undefined;
    if (a) right.push({ text: `${a.name}${a.engine.info?.currentModel ? ` · ${shortModelName(a.engine.info.currentModel)}` : ""}${effort ? ` ${effort}` : ""}`, prio: 2 });
    if (a?.context) right.push({ text: `ctx ${Math.min(100, Math.round((a.context.used / a.context.size) * 100))}%`, prio: 1 });
    const bk: BudgetKey | null = a && this.config.budgets?.[a.agent] ? a.agent : this.config.budgets?.all ? "all" : null;
    if (bk) right.push({ text: `${fmtUsd(this.today.get(bk) ?? 0)}/${fmtUsd(this.config.budgets[bk])} today`, prio: 1 });
    else if (this.sessionCost > 0 || this.sessionTokens > 0) right.push({ text: `${fmtUsd(this.sessionCost)} /usage`, prio: 1 });
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

  private async switchTo(agent: AgentId, fresh: boolean, o: { resumeTask?: boolean } = {}) {
    if (!hasEngine(agent)) return this.transcript.note(`${agent} has no protocol engine; run codemax --tui for it`, C.warn);
    this.switching = true;
    const prev = this.active;
    let from: AgentId | undefined;
    const pq = prev ? this.quota.get(prev.agent) : undefined;
    const nearLimit = o.resumeTask || isExhausted(pq) || (typeof pq?.usedPercent === "number" && pq.usedPercent >= 85);
    // The step journal hands over the whole task; a summary turn would only spend the
    // outgoing agent's quota. Summaries are still written for older, journal-less ledgers.
    const journaled = this.ledger.journal.steps().some((s) => s.kind === "user");
    if (prev && !prev.turn && this.config.summarizeOnSwitch && !nearLimit && !journaled && this.ledger.turns().length >= 4) {
      const timer = setTimeout(() => void prev.engine.cancel(), 30_000);
      await this.compact({ quiet: true }).catch(() => false);
      clearTimeout(timer);
    }
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
    const overBudget = from && budgetLevel(this.today.get(from) ?? 0, this.config.budgets?.[from]) === "over";
    // Only ask the next agent to finish a request when one is actually unanswered.
    const lastTurn = this.ledger.turns().at(-1);
    const pending = lastTurn?.role === "user" ? "; finish the last user request" : "";
    const reason = fromQ && isExhausted(fromQ) ? `${from} ran out of quota${pending ? " mid-task" : ""}${pending}` : overBudget ? `${from} hit its daily budget${pending}` : o.resumeTask ? `${from} stopped${pending}` : undefined;
    await this.launch(agent, { fresh, from, reason });
    this.switching = false;
  }

  async quit() {
    this.closed = true;
    await this.awake.release().catch(() => []);
    await this.closeReviewer();
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
  // Cursor appends settings in brackets: "claude-opus-5-5[context=300k,effort=medium]".
  const name = m.replace(/\[.*\]$/, "").replace(/^claude-/, "").replace(/^(anthropic|openai|xai|google|opencode)\//, "");
  return !name || name === "default" ? "auto" : name;
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export async function runChat(config: Config, ledger: Ledger, cwd: string, agent: AgentId, fresh: boolean, pick = false) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: ["SIGTERM", "SIGHUP"], useMouse: true, targetFps: 60 });
  const pref = config.theme ?? "auto";
  applyTheme(pref === "auto" ? ((await renderer.waitForThemeMode(250).catch(() => null)) ?? "dark") : pref);
  const app = new ChatApp(renderer, config, ledger, cwd);
  process.once("exit", () => app.awake.releaseSync());
  try {
    await app.start(agent, fresh, { pick });
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

/** Copy text: the OS clipboard tool when there is one, plus OSC 52 (works over SSH and in most terminals). */
async function copyToClipboard(renderer: CliRenderer, text: string): Promise<boolean> {
  let osc = false;
  try {
    osc = renderer.copyToClipboardOSC52(text);
  } catch {
    /* terminal without OSC 52 */
  }
  const tools: string[][] =
    process.platform === "darwin" ? [["pbcopy"]]
    : process.platform === "win32" ? [["clip"]]
    : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
  for (const cmd of tools) {
    if (!Bun.which(cmd[0]!)) continue;
    try {
      const p = Bun.spawn(platformArgv(cmd), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      p.stdin.write(text);
      await p.stdin.end();
      if ((await p.exited) === 0) return true;
    } catch {
      /* try the next tool */
    }
  }
  return osc;
}

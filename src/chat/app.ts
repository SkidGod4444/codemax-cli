import { BoxRenderable, TextRenderable, TextareaRenderable, createCliRenderer, type CliRenderer, type KeyEvent, type PasteEvent } from "@opentui/core";
import type { Config } from "../config.ts";
import { CONFIG_PATH, hotkeyLabel, saveConfigKey } from "../config.ts";
import { homedir, tmpdir } from "node:os";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AgentId, QuotaStatus, SessionRef } from "../adapters/types.ts";
import { listAdapters, getAdapter } from "../adapters/index.ts";
import { Ledger } from "../core/ledger.ts";
import { buildBrief, buildCatchup } from "../core/brief.ts";
import { diffStat } from "../core/git.ts";
import { isExhausted, quotaLabel } from "../core/quota.ts";
import { findHotkey, parseHotkeys, type HotkeySpec } from "../core/hotkey.ts";
import { createEngine, EDITS_WITHOUT_ASKING, hasEngine, NO_PERMISSION_PROMPTS, engineFactories, grokPermissionNote } from "../engines/index.ts";
import type { Engine, EngineEvent, PermissionRequest, PromptImage, QuestionRequest, RewindPoint, StopReason } from "../engines/types.ts";
import { droppedContents, droppedFiles, imageType, splitDropped } from "./drop.ts";
import { CODEMAX_HOME, ensureDir, insideDir } from "../core/paths.ts";
import { threadMarkdown } from "../core/export.ts";
import { basename, join, relative, resolve } from "node:path";
import { strippedKeys } from "../engines/env.ts";
import { blockers } from "../core/doctor.ts";
import { Transcript, type AgentBlock } from "./transcript.ts";
import { PermissionDialog } from "./permission.ts";
import { QuestionDialog } from "./question.ts";
import { Palette, type PaletteItem } from "./palette.ts";
import { TaskPanel } from "./tasks.ts";
import { styleMarkdown } from "./markdown.ts";
import { PerfLog, perfEnabled } from "./perf.ts";
import { debugEvent, debugLogOn, debugLogPath, errorFields, exportDebugLog, setDebugLog } from "../core/debuglog.ts";
import { ThreadPicker } from "./threadpicker.ts";
import { C, COLORS, COLOR_THEMES, DONE_VERBS, G, THEME, VERBS, applyTheme, fmtDuration, fmtTime, isColorTheme, modeLabel, pick } from "./theme.ts";
import { priceRecord, recordCost, renderUsageTable, sumCost } from "../core/usage.ts";
import { fmtUsd, resetPriceCache } from "../core/pricing.ts";
import { refreshLivePricesIfStale } from "../core/prices-live.ts";
import { addSpend, budgetLevel, spendToday, type BudgetKey } from "../core/budget.ts";
import { createCheckpoint, listCheckpoints, restoreCheckpoint, checkpointDiffStat, checkpointChangeCounts, type Checkpoint } from "../core/checkpoint.ts";
import { appendHistory, loadHistory } from "../core/history.ts";
import { VERIFY_FIX_CAP, VERIFY_TIMEOUT_MS, runVerify, tail, verifyCandidates } from "../core/verify.ts";
import { MENTION_RE, attachFiles, listProjectFiles, mentionedFiles } from "../core/files.ts";
import pkg from "../../package.json" with { type: "json" };
import { platformArgv, SHELL_SPAWN, shellArgv, stopChildrenOnExit } from "../core/spawn.ts";
import { safeDeep } from "../core/terminal.ts";
import { agentSetupFailure, cleanError, isLimitNotice, parseResetTime } from "../engines/errors.ts";
import { TurnRecorder } from "../core/journal.ts";
import { Awake, defaultAwakeDeps, recoverAwake } from "../core/awake.ts";
import { buildReviewPrompt, forwardMessage, isForwardedNote, parseNote } from "../core/review.ts";
import { critiquePrompt, debateCost, finalPlan, judgePrompt, parseSettled, proposalPrompt, roundsLabel, settledPrompt, UNTIL_SETTLED_MAX, type DebateRounds } from "../core/debate.ts";
import { logoLines } from "./logo.ts";
import { checkForUpdate, relaunch, UPDATED_FROM_ENV, UPDATED_TO_ENV, updatePlan } from "../core/update.ts";
import { whatsNew } from "../core/whatsnew.ts";
import { displayModelName, sortModels } from "./models.ts";
import { fmtDateTime12, fmtTime12 } from "../core/time.ts";
import { TerminalStatus } from "../core/termstatus.ts";
import { NotePanel, splitNote } from "./notes.ts";
import { Onboarding, type OnboardingStep } from "./onboarding.ts";
import { nextTip, TIPS } from "./tips.ts";
import { SubagentPanel } from "./subagents.ts";
import { agyOnlyModels, antigravityInstallPlan, installAntigravityServer, type InstallPlan } from "../engines/antigravity.ts";

const HOTKEY_NAMES: Record<string, string[]> = { "/": ["/", "_", "?"], "^": ["^", "6"] };
const VERSION = pkg.version;
/** First re-check for a codemax update in a long session; each later one waits twice as long. */
const UPDATE_RECHECK_FIRST_MS = 30 * 60_000;
/** Shift+Tab's order (Claude Code's: default → accept edits → plan → auto); other agents' own modes follow. */
const MODE_CYCLE = ["default", "acceptEdits", "plan", "auto"];
/** Modes that skip every prompt stay out of Shift+Tab (pick them with /mode): one key press must never turn prompts off for good. */
const NO_CYCLE = new Set(["bypassPermissions", "dontAsk", "yolo", "never"]);
/**
 * Claude Code's own rule for keeping the user informed, in as few words as it takes (it costs a
 * few dozen tokens: once per new session, or per turn where the agent caches its prompt). Claude
 * Code already has it, so it is never sent there.
 */
export const NARRATE = "codemax shows the user your messages, not your reasoning or raw tool output. Before your first tool call, say in one sentence what you are about to do. While working, add a one-sentence update when you find something important, change direction or hit a blocker. End with one or two sentences: what changed or what you found, and what is next.";

/** What a turn did, for the debug log: counts and timings only, never content. */
interface TurnStats {
  firstAt?: number;
  lastAt: number;
  maxGapMs: number;
  events: number;
  textChunks: number;
  thoughtChunks: number;
  tools: Record<string, number>;
  failedTools: number;
  permissions: { asked: number; allowed: number; denied: number };
  questions: number;
  subagents: number;
  inTokens: number;
  outTokens: number;
  costUsd: number;
}

/** How long the "what's new" box stays after /update. */
const WHATS_NEW_MS = 5000;

/** How long an agent's notice stays on the prompt's border (it stays in the transcript). */
const NOTICE_MS = 8000;

/** Claude Code's names for its windows; Codex's 5-hour and weekly windows use the same keys. */
const WINDOW_NAMES: Record<string, string> = { five_hour: "session limit", seven_day: "weekly limit", seven_day_opus: "Opus limit", seven_day_sonnet: "Sonnet limit", seven_day_overage_included: "Fable limit", overage: "usage credit limit" };

/** "warning" when a window is near its end: the agent says so (allowed_warning), or 80% is used. */
function limitLevel(pl: { usedPercent?: number; status?: string }): "warning" | null {
  return pl.status === "allowed_warning" || (typeof pl.usedPercent === "number" && pl.usedPercent >= 80) ? "warning" : null;
}

/** Claude Code's wording: "You've used 91% of your weekly limit · resets Fri 3:00 PM", "Approaching session limit", "Weekly limit reached". */
export function limitText(pl: { window: string; usedPercent?: number; resetsAt?: number; status?: string }): string {
  const name = WINDOW_NAMES[pl.window] ?? (pl.window === "plan" ? "usage limit" : `${pl.window} limit`);
  const pct = typeof pl.usedPercent === "number" ? Math.min(100, Math.floor(pl.usedPercent)) : undefined;
  const head = pl.status === "rejected" || pct === 100 ? `${name.charAt(0).toUpperCase()}${name.slice(1)} reached` : pct !== undefined ? `You've used ${pct}% of your ${name}` : `Approaching ${name}`;
  return pl.resetsAt ? `${head} · resets ${fmtReset(pl.resetsAt)}` : head;
}

function fmtReset(ts: number): string {
  if (ts - Date.now() < 20 * 3600_000) return fmtTime12(ts);
  return `${new Date(ts).toLocaleDateString("en-US", { weekday: "short" })} ${fmtTime12(ts)}`;
}

/** The window to warn about on the prompt's border: a reached one first, else the fullest one near its end. */
function limitWarning(m: Map<string, { usedPercent?: number; resetsAt?: number; status?: string; at: number }> | undefined): { text: string; reached: boolean } | null {
  if (!m) return null;
  const live = [...m.entries()].filter(([, v]) => !v.resetsAt || v.resetsAt > Date.now()).map(([window, v]) => ({ window, ...v }));
  const reached = live.find((w) => w.status === "rejected" || (w.usedPercent ?? 0) >= 100);
  if (reached) return { text: limitText(reached), reached: true };
  const near = live.filter((w) => limitLevel(w)).sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
  return near ? { text: limitText(near), reached: false } : null;
}

/** Built-in commands that start agent work or replace the session: they wait for the agent to finish. */
const WAITS_FOR_AGENT = /^\/(task|compact|new|undo|rewind|verify|ask|debate|update|setup)\b/i;
/** How long a lone 0 / 1 / 2 must sit in the prompt before it acts on the side agent's note. */
const NOTE_ARM_MS = 800;
/** A question left unanswered this long is skipped when `questions` is "timeout". */
const QUESTION_TIMEOUT_MS = 5 * 60_000;
/** Most side-agent notes sent automatically per task; more wait above the prompt. */
const AUTO_FORWARD_CAP = 2;

interface Active {
  agent: AgentId;
  name: string;
  engine: Engine;
  /** `model`: the model the agent reported for this turn (usage), when it does. */
  turn: { block: AgentBlock; tools: Set<string>; startedAt: number; tokens: number; chars: number; verb: string; rec?: TurnRecorder; model?: string; edited?: boolean; step?: string; stats?: TurnStats } | null;
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
  /** The open dialog (a permission prompt or an agent's question); one at a time, the rest queue. */
  private permission: PermissionDialog | QuestionDialog | null = null;
  /** First-run setup (or /setup), shown where permission prompts go. */
  private onboarding: Onboarding | null = null;
  /** Ends the setup screen (Esc, the last step, or Ctrl+C). */
  private endOnboarding: ((skipped: boolean, done?: boolean) => void) | null = null;
  /** A setup step opened its own picker (the handoff order editor): keys go there meanwhile. */
  private onboardingAside = false;
  private permissionQueue: ({ request: PermissionRequest; engine: Engine } | { question: QuestionRequest; engine: Engine })[] = [];
  /** `engine` implies `installed`: every check on `engine` also means the CLI really runs. */
  private detect = new Map<AgentId, { installed: boolean; version?: string; engine: boolean; problem?: string }>();
  private quota = new Map<AgentId, QuotaStatus>();
  private hotkeys: HotkeySpec[];
  private transcript: Transcript;
  private working: TextRenderable;
  private input: TextareaRenderable;
  private inputWrap: BoxRenderable;
  private dialogHost: BoxRenderable;
  private queueBox!: BoxRenderable;
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
  /** Snapshots taken this session, oldest first; `message` is what you typed (for /rewind). */
  /** `fork`: where the agent's conversation stood at this snapshot, for /rewind (agents that can fork). */
  private checkpoints: (Checkpoint & { agent: AgentId; message?: string; fork?: RewindPoint })[] = [];
  private projectFiles: string[] | null = null;
  private projectFilesLoading: Promise<string[]> | null = null;
  private side = new Set<Active>();
  private sessionTokens = 0;
  private historyIdx = -1;
  /** A queued message pulled back into the prompt with ↑: where it sat, and its text before editing. */
  private queueEdit: { index: number; original: string } | null = null;
  private draft = "";
  private queue: string[] = [];
  private lastCtrlC = 0;
  private lastEsc = 0;
  /** The checks running after a turn (Esc stops them); messages sent meanwhile are queued. */
  private verifying: { cmd: string; stop: () => void } | null = null;
  /** Failures sent back to the agent for the current task ("fix" mode), capped by VERIFY_FIX_CAP. */
  private verifyFixes = 0;
  private switching = false;
  /** Set by quit(); async work that resumes afterwards (a handoff being built) stops. */
  private closed = false;
  /** Side agent (set up in /config): reviews the main agent's work after each turn. */
  private reviewer: { agent: AgentId; name: string; engine: Engine; busy: boolean; pending: boolean; since: number; primed: boolean } | null = null;
  private notes: { ts: number; agent: AgentId; name: string; text: string }[] = [];
  private notePanel: NotePanel;
  private subagents: SubagentPanel;
  private samePlanNoted = false;
  private noteArmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Plan limits each agent reported, by window ("five_hour", "seven_day"…). */
  private planLimits = new Map<AgentId, Map<string, { usedPercent?: number; resetsAt?: number; status?: string; at: number }>>();
  /** Working turns since the side agent last reviewed (for `sideAgent.every`). */
  private turnsSinceReview = 0;
  /** Notes sent automatically per task (auto mode is capped so the two agents cannot loop). */
  private autoForwards = new Map<string, number>();
  /** A newer codemax on npm, when the update check found one. */
  private updateAvailable: string | null = null;
  /** Set by a successful /update: after quitting, runChat starts the new version resuming this agent. */
  restartAfterQuit: { agent?: AgentId; version: string | null } | null = null;
  /** Update check (tests swap it; it never runs under `bun test`). */
  updateChecker: (current: string, force?: boolean) => Promise<string | null> = (current, force) => (process.env.NODE_ENV === "test" ? Promise.resolve(null) : checkForUpdate(current, { force }));
  /**
   * Long sessions look for a new codemax again: 30 minutes in, then an hour after that, then
   * two hours, doubling, each time asking npm / GitHub directly (the 12-hour cache is skipped).
   */
  updateRecheckMs = UPDATE_RECHECK_FIRST_MS;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Keep-awake (/awake). Tests swap its system runner. */
  awake = new Awake({ ...defaultAwakeDeps(), interactive: (fn) => this.withTerminal(fn) });
  /** Terminal tab status (Warp badge, OSC 7501) and desktop notifications; swapped in tests. */
  term: TerminalStatus;
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
    this.history = loadHistory(cwd, 200);
    for (const [id, q] of Object.entries(ledger.quota())) this.quota.set(id as AgentId, q);

    const root = new BoxRenderable(renderer, { id: "chat-root", width: "100%", height: "100%", flexDirection: "column" });
    this.transcript = new Transcript(renderer);
    root.add(this.transcript.box);
    // Claude Code's spacing: a blank line between the transcript and the spinner, and again above the prompt.
    this.working = new TextRenderable(renderer, { id: "working", content: "", fg: C.dim, height: 1, width: "100%", flexShrink: 0, wrapMode: "none", truncate: true, marginTop: 1 } as any);
    this.working.visible = false;
    root.add(this.working);
    this.dialogHost = new BoxRenderable(renderer, { id: "dialog-host", width: "100%", flexShrink: 0, flexDirection: "column" });
    root.add(this.dialogHost);
    // Side-agent notes wait here, above the queue, until you expand, discuss or dismiss them.
    this.notePanel = new NotePanel(renderer, () => this.active?.name ?? "the main agent");
    root.add(this.notePanel.box);
    // The agent's plan, pinned above the prompt like Claude Code's task list.
    this.tasks = new TaskPanel(renderer);
    root.add(this.tasks.box);
    // Queued messages wait here, pinned just above the prompt, until they are sent.
    this.queueBox = new BoxRenderable(renderer, { id: "queue", width: "100%", flexShrink: 0, flexDirection: "column", paddingX: 1 });
    this.queueBox.visible = false;
    root.add(this.queueBox);
    this.inputWrap = new BoxRenderable(renderer, { id: "input-wrap", width: "100%", flexShrink: 0, flexDirection: "column", border: ["top", "bottom"], borderStyle: "rounded", borderColor: C.promptBorder, marginTop: 1 } as any);
    const inputRow = new BoxRenderable(renderer, { id: "input-row", width: "100%", flexDirection: "row" });
    this.promptGlyph = new TextRenderable(renderer, { id: "input-prompt", content: `${G.prompt} `, width: 2, fg: C.dim });
    inputRow.add(this.promptGlyph);
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
      onSubmit: () => this.safelyAsync("sending", this.submit()),
    } as any);
    this.input.onContentChange = () => this.onInputChanged();
    inputRow.add(this.input);
    this.inputWrap.add(inputRow);
    root.add(this.inputWrap);
    // Subagents the main agent spawned, under the prompt like Claude Code's agent list.
    this.subagents = new SubagentPanel(renderer);
    root.add(this.subagents.box);
    this.shortcuts = new BoxRenderable(renderer, { id: "shortcuts", width: "100%", flexShrink: 0, flexDirection: "column", paddingX: 2 });
    this.shortcuts.visible = false;
    for (const l of [
      "/ for commands            shift + tab to cycle permission mode     esc to interrupt a turn",
      "/switch to change agent   ↑ for history (or to edit the queue)      ctrl + c twice to quit",
      "/mode to set permissions  shift + ⏎ for newline                     ? to toggle this help",
      "! to run a shell command  /model to pick a model                    /compact for a handoff summary",
      "@ to attach a file        /undo reverts the last turn's edits        /ask <agent> <msg> for a one-off",
      "ctrl + o expands output   ctrl + ^ switches agent                    /theme dark | light | auto",
      "ctrl + r searches history esc twice rewinds to an earlier message    /verify runs your checks",
    ])
      this.shortcuts.add(new TextRenderable(renderer, { content: l, fg: C.dim, wrapMode: "none", truncate: true }));
    root.add(this.shortcuts);
    const footer = new BoxRenderable(renderer, { id: "footer", width: "100%", height: 1, flexShrink: 0, paddingX: 2 });
    this.footerText = new TextRenderable(renderer, { id: "footer-text", content: "", width: "100%", wrapMode: "none", truncate: true, fg: C.dim });
    footer.add(this.footerText);
    root.add(footer);
    renderer.root.add(root);
    this.chatRoot = root;
    // Select text with the mouse to copy it (like a terminal's copy-on-select).
    renderer.on("selection", (sel: { getSelectedText(): string } | null) => {
      const text = sel?.getSelectedText?.() ?? "";
      if (!text.trim()) return;
      void this.copyText(text).then((ok) => this.setFlash(ok ? `copied ${text.length} chars` : "could not copy: no clipboard available"));
    });

    this.term = new TerminalStatus(
      { status: (st) => void this.renderer.setProgramStatus(st as any), notify: (m, t) => void this.renderer.triggerNotification(m, t) },
      { cwd, enabled: () => this.config.terminalStatus !== false, notify: () => this.config.notifications !== false },
    );
    renderer.on("focus", () => (this.term.focused = true));
    renderer.on("blur", () => (this.term.focused = false));
    renderer.keyInput.on("keypress", this.onKey);
    if (debugLogOn()) this.startHealth();
    if (perfEnabled() || debugLogOn()) {
      this.perf = new PerfLog(renderer, () => ({
        palette: this.palette ? this.paletteKind : undefined,
        paletteItems: this.palette ? (this.palette as any).opts?.items?.length : undefined,
        transcriptRows: this.transcript.box.getChildren().length,
        working: !!this.active?.turn,
        agent: this.active?.agent,
        agentCommands: this.active?.commands.length,
        promptChars: this.input.plainText.length,
      }));
    }
    renderer.keyInput.on("paste", this.onPaste);
    renderer.on("resize", () => this.safely("resize", () => {
      if (Date.now() - this.lastResizeLog > 1000) {
        this.lastResizeLog = Date.now();
        debugEvent("resize", { cols: renderer.width, rows: renderer.height });
      }
      this.fitInput();
      this.palette?.render();
      this.threadPicker?.render();
      if (this.permission instanceof PermissionDialog) this.permission.relayout();
      this.renderFooter();
    }));
    this.input.focus();
    this.renderFooter();
  }

  /** `explicit`: the user named this agent (--agent), so never start a different one. */
  /** This conversation thread (`codemax --resume <id>`). */
  get threadId(): string {
    return this.ledger.threadId;
  }

  /** Whether this thread has anything to come back to. */
  get threadUsed(): boolean {
    return this.ledger.journal.steps().some((s) => s.kind === "user") || this.ledger.turns().length > 0;
  }

  async start(agent: AgentId, fresh: boolean, o: { pick?: boolean; explicit?: boolean; pickThread?: boolean; onboard?: boolean } = {}) {
    try {
      this.today = spendToday();
    } catch {
      /* no usage yet */
    }
    await this.refreshDetect();
    // Until setup has been done once (new users, and everyone updating to it): set everything up
    // first, then carry on into the thread as usual. A default agent changed there is used.
    if (o.onboard) {
      const before = this.config.order[0];
      await this.runOnboarding();
      if (this.closed) return this.done; // Ctrl+C during the setup
      if (!o.explicit && this.config.order[0] !== before) agent = this.config.order[0] ?? agent;
    }
    const ok = (a: AgentId) => this.detect.get(a)?.installed && this.detect.get(a)?.engine;
    if (!ok(agent) && o.explicit) throw new Error(`${agent} is ${this.detect.get(agent)?.installed ? "installed but has no protocol engine (try codemax --tui --agent " + agent + ")" : "not installed"}. Available: ${listAdapters(this.config.order).filter((a) => ok(a.id)).map((a) => a.id).join(", ") || "none"}`);
    const first = ok(agent) ? agent : listAdapters(this.config.order).find((a) => ok(a.id))?.id;
    if (!first) throw new Error("no agent with a protocol engine found (need claude, codex, opencode, cursor-agent, grok or agy on PATH)");
    const notes: string[] = [];
    if (first !== agent) notes.push(`${agent} has no protocol engine here; starting ${first}`);
    for (const n of await recoverAwake({ ...defaultAwakeDeps(), interactive: (fn) => this.withTerminal(fn) }).catch(() => [])) notes.push(n);
    if (this.config.awake && this.config.awake !== "off") {
      const st = await this.awake.set(this.config.awake).catch(() => null);
      if (st) notes.push(st.mode === "off" ? "keep-awake could not be turned on" : `keeping this machine awake${st.lid ? ", lid closed included" : ""} (/awake off to stop)`, ...st.notes);
    }
    const updatedTo = process.env[UPDATED_TO_ENV];
    if (updatedTo !== undefined) {
      const from = process.env[UPDATED_FROM_ENV];
      delete process.env[UPDATED_TO_ENV];
      delete process.env[UPDATED_FROM_ENV];
      notes.push(updatedTo ? `updated to v${updatedTo} and restarted` : "updated and restarted");
      this.showWhatsNew(VERSION, from);
    }
    debugEvent("app-start", this.debugInfo());
    // The debug log is on by default: say so once, with what it can contain and how to stop it.
    if (debugLogOn() && !this.config.debugNotified) {
      notes.push("debug log on: errors and odd behaviour (never your messages or replies; error lines can name files and commands) · /debug export to send it · /debug off");
      this.config.debugNotified = true;
      try {
        saveConfigKey("debugNotified", true);
      } catch {
        /* read-only home */
      }
    }
    if (process.env.CODEMAX_USAGE_RESET) {
      notes.push("usage history cleared once: earlier figures counted Claude twice or more · /usage counts from now");
      delete process.env.CODEMAX_USAGE_RESET;
    }
    const stripped = strippedKeys();
    if (stripped.length) notes.push(`${stripped.join(", ")} unset for agents · subscription logins only`);
    // Card border (2) + padding (2) + transcript padding (2): the logo must fit inside without wrapping.
    this.transcript.header({ title: `codemax v${VERSION}`, subtitle: "one terminal, every coding agent", path: this.cwd, notes, logo: logoLines(this.renderer.width - 6) });
    if ((this.config as any).priceUpdates !== false) void refreshLivePricesIfStale().then((l) => l && resetPriceCache());
    if (this.config.updateCheck !== false) {
      void this.updateChecker(VERSION)
        .then((v) => v && this.announceUpdate(v))
        .catch(() => {});
      this.scheduleUpdateCheck(this.updateRecheckMs);
    }
    // Warm the markdown, code and diff styling while nothing is happening, so the first code
    // block or diff of the session is not the one that pays for it (about 60 ms, once).
    setTimeout(() => this.safely("warm-up", () => {
      styleMarkdown("**a** `b`\n```ts\nconst a: number = 1;\n```\n```diff\n@@ -1 +1 @@\n-a\n+b\n```");
    }), 1500);
    if (o.pickThread && this.openThreadPicker(first)) return this.done;
    if (o.pick && !fresh && this.openPicker(first)) return this.done;
    await this.launch(first, { fresh });
    return this.done;
  }

  // ---------- keys ----------

  /**
   * The UI must never break: a failure while handling one event, key or redraw is
   * shown as a short line and codemax carries on.
   */
  private uiErrors = 0;
  /** The same for async work started from a key or command: a failure is one line, never a crash. */
  private safelyAsync(where: string, p: Promise<unknown>) {
    p.catch((e: any) => this.safely(where, () => {
      throw e;
    }));
  }

  private safely(where: string, fn: () => void) {
    try {
      fn();
    } catch (e: any) {
      this.uiErrors++;
      debugEvent("display-glitch", { where, ...errorFields(e) });
      if (this.uiErrors <= 5) {
        try {
          this.transcript.error(`display glitch in ${where}: ${String(e?.message ?? e).slice(0, 160)} (codemax keeps going)`);
        } catch {
          /* the screen itself is gone */
        }
      }
    }
  }

  private onKey = (key: KeyEvent) => {
    const t0 = this.perf ? performance.now() : 0;
    this.safely("key handling", () => this.handleKey(key));
    this.perf?.key(key.name, performance.now() - t0);
  };

  private lastResizeLog = 0;
  private bornAt = Date.now();
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /** Once a minute while the debug log is on: memory and sizes, so leaks and slow growth show. */
  private startHealth() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => this.safely("health", () => {
      if (!debugLogOn()) return;
      const m = process.memoryUsage();
      debugEvent("health", { uptimeMin: Math.round((Date.now() - this.bornAt) / 60000), rssMB: Math.round(m.rss / 1e6), heapMB: Math.round(m.heapUsed / 1e6), transcriptRows: this.transcript.box.getChildren().length, queue: this.queue.length || undefined, checkpoints: this.checkpoints.length, pendingPermissions: this.permissionQueue.length || undefined, agent: this.active?.agent, working: !!this.active?.turn || undefined });
    }), 60_000);
    (this.healthTimer as any).unref?.();
  }

  /** CODEMAX_PERF=1: what made the UI slow, in ~/.codemax/perf.log (src/chat/perf.ts). */
  private perf: PerfLog | null = null;

  /** The empty prompt's text: the welcome line, then a different feature tip after each message (tips.ts). */
  private placeholderText = 'Try "fix the failing test" · / for commands';
  private tipIndex = Math.floor(Math.random() * TIPS.length);

  private rotateTip() {
    if (this.config.tips === false) {
      this.placeholderText = "/ for commands";
    } else {
      const agents = listAdapters(this.config.order).filter((a) => this.detect.get(a.id)?.installed && this.detect.get(a.id)?.engine).length;
      const t = nextTip(this.tipIndex, { agents, checks: !!this.config.verify?.[this.cwd] || verifyCandidates(this.cwd).length > 0, hotkey: this.config.hotkeys[this.config.hotkeys.length - 1] ?? "ctrl+^" }, TIPS, Math.max(20, this.renderer.width - 4));
      this.tipIndex = t.index;
      this.placeholderText = t.text;
    }
    this.input.placeholder = this.placeholderText;
  }

  /** Files and images dropped into the prompt (or pasted as paths), by their number. */
  private dropped: { n: number; path: string; name: string; mimeType?: string }[] = [];
  private dropSeq = 0;

  /**
   * Drag and drop: the terminal pastes a dropped file as its path. A paste that is only
   * paths to existing files becomes attachments: `[Image #1]` for an image (sent to the
   * agent as an image), `@path` for a file in the project, `[File #2: name]` for one outside.
   */
  private onPaste = (e: PasteEvent) =>
    this.safely("paste", () => {
      if (this.permission || this.onboarding || this.closed) return;
      const files = droppedFiles(new TextDecoder().decode(e.bytes));
      if (!files) return;
      e.preventDefault();
      const marks = files.map((path) => this.dropFile(path));
      this.input.insertText(`${marks.join(" ")} `);
      this.input.focus();
    });

  private dropFile(path: string): string {
    const mimeType = imageType(path);
    if (!mimeType && insideDir(this.cwd, path)) return `@${relative(this.cwd, path)}`;
    const n = ++this.dropSeq;
    const name = basename(path);
    this.dropped.push({ n, path, name, mimeType });
    return mimeType ? `[Image #${n}]` : `[File #${n}: ${name}]`;
  }

  /**
   * The dropped attachments a message refers to: images to send with it, and notes (and the
   * contents of dropped files) for its text. A plain image path typed into the message
   * (terminals that type a drop instead of pasting it) is attached too.
   */
  private takeDropped(text: string): { text: string; images: PromptImage[] } {
    const images: PromptImage[] = [];
    const notes: string[] = [];
    for (const d of this.dropped) {
      const mark = d.mimeType ? `[Image #${d.n}]` : `[File #${d.n}: ${d.name}]`;
      if (!text.includes(mark)) continue;
      if (d.mimeType) {
        images.push({ path: d.path, mimeType: d.mimeType });
        notes.push(`${mark} is the attached image ${d.path}`);
      } else notes.push(`${mark} is ${d.path}:${droppedContents(d.path)}`);
    }
    for (const m of text.matchAll(/(?:^|\s)((?:\/|~\/)(?:\\ |[^\s])+\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi)) {
      const path = splitDropped(m[1]!)[0]!;
      if (images.some((i) => i.path === path) || !droppedFiles(m[1]!)) continue;
      images.push({ path, mimeType: imageType(path)! });
    }
    // Only what this message used: another queued message keeps its own attachments.
    this.dropped = this.dropped.filter((d) => !text.includes(d.mimeType ? `[Image #${d.n}]` : `[File #${d.n}: ${d.name}]`));
    if (!notes.length) return { text, images };
    return { text: `${text}\n\n[attached by the user]\n${notes.join("\n")}`, images };
  }

  private handleKey(key: KeyEvent) {
    if (key.eventType === "release") return;
    // The prompt always has the keyboard (a click elsewhere, like selecting text in the
    // transcript, must not leave typing going nowhere); dialogs take their keys below.
    if (!this.input.focused && !this.closed) this.input.focus();
    if (this.threadPicker) {
      key.stopPropagation();
      if (key.name === "c" && key.ctrl) return void this.quit();
      this.threadPicker.handleKey(key);
      return;
    }
    if (this.onboarding && !this.onboardingAside) {
      key.stopPropagation();
      // Ctrl+C leaves the setup and quits, as everywhere else.
      if (key.name === "c" && key.ctrl) {
        this.endOnboarding?.(true, false); // not marked done: it comes back next start
        void this.quit();
        return;
      }
      this.onboarding.handleKey(key);
      return;
    }
    if (this.permission instanceof PermissionDialog) {
      // The prompt stays usable while an agent asks: typing goes to the prompt, Enter on text
      // sends it (a /command runs, a message queues). With the prompt empty, arrows, digits,
      // Enter and Esc answer the dialog. Shift+Tab still cycles the mode.
      const text = this.input.plainText;
      const typed = text.length > 0;
      // A digit is typed into the prompt like any text ("2 more tests please" must never pick
      // "don't ask again"); a lone digit answers: Enter at once, or on its own after NOTE_ARM_MS.
      if (/^[1-9]$/.test(text) && key.name === "return" && !key.shift) {
        key.stopPropagation();
        this.input.clear();
        this.permission.handleKey({ name: text } as KeyEvent);
        return;
      }
      const dialogKey = (key.ctrl && key.name === "o") || key.name === "pageup" || key.name === "pagedown" || (!typed && /^(up|down|tab|return|escape)$/.test(key.name) && !key.ctrl && !key.meta && !key.shift);
      if (dialogKey) {
        key.stopPropagation();
        this.permission.handleKey(key);
        return;
      }
      if (typed && key.name === "escape") {
        // Esc with text clears the prompt; it never interrupts the agent while it is asking.
        key.stopPropagation();
        this.input.clear();
        return;
      }
      if (this.isShiftTab(key)) {
        key.stopPropagation();
        void this.cycleMode();
        return;
      }
      // Anything else: the prompt (and the usual keys below) get it.
    } else if (this.permission) {
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
    if (key.name === "escape" && this.queueEdit) {
      // Cancel the edit: the queued message goes back exactly as it was.
      key.stopPropagation();
      const { index, original } = this.queueEdit;
      this.queueEdit = null;
      this.queue.splice(index, 0, original);
      this.input.clear();
      this.renderQueue();
      this.renderFooter();
      return;
    }
    if (key.name === "escape" && this.debate && !this.permission) {
      key.stopPropagation();
      this.debate.stopped = true;
      for (const a of this.debate.actives) void a.engine.cancel().catch(() => {});
      this.setFlash("stopping the debate…");
      return;
    }
    if (key.name === "escape" && this.shellRun && !this.active?.turn) {
      key.stopPropagation();
      this.shellRun.stop();
      this.setFlash("stopping the ! command…");
      return;
    }
    if (key.name === "escape" && this.verifying && !this.active?.turn) {
      key.stopPropagation();
      this.verifying.stop();
      this.setFlash("stopping the checks…");
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
      } else {
        // Esc twice on an empty prompt: pick an earlier message to rewind to (Claude Code's idiom).
        const now = Date.now();
        if (now - this.lastEsc < 600) {
          key.stopPropagation();
          this.lastEsc = 0;
          this.safelyAsync("rewind", this.openRewind());
          return;
        }
        this.lastEsc = now;
      }
      return;
    }
    if (key.name === "r" && key.ctrl) {
      key.stopPropagation();
      this.openHistorySearch();
      return;
    }
    if (key.name === "o" && key.ctrl) {
      key.stopPropagation();
      this.setFlash(this.transcript.toggleExpanded() ? "showing full output · ctrl+o to collapse" : "output collapsed");
      return;
    }
    // Ctrl+G: write the message in your own editor (Claude Code's and OpenCode's key).
    if (key.name === "g" && key.ctrl && !this.palette) {
      key.stopPropagation();
      void this.composeInEditor();
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
    if (key.name === "up" && !this.palette && this.historyIdx < 0 && (this.input.plainText === "" || this.queueEdit) && (this.queue.length || this.queueEdit)) {
      key.stopPropagation();
      this.editQueued();
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
  }

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

  /**
   * The prompt grows with what you type (wrapped lines and newlines), up to 10
   * lines or a third of the screen, and scrolls after that. A fixed one-line box
   * made a full line look like a fresh, empty prompt.
   */
  private fitInput() {
    if (this.closed) return;
    const max = Math.max(1, Math.min(10, Math.floor(this.renderer.height / 3)));
    // Counted from the text: the textarea's own virtual line count lags behind typing.
    const width = Math.max(1, this.renderer.width - 2);
    const lines = Math.max(1, Math.min(max, wrappedLines(this.input.plainText, width)));
    if (this.input.height !== lines) this.input.height = lines;
  }

  private onInputChanged() {
    this.fitInput();
    // Wrapping is measured at layout: check again once the frame has the new text.
    setTimeout(() => this.safely("input size", () => this.fitInput()), 0);
    const text = this.input.plainText;
    // "!" runs a shell command: the prompt says so in pink, as Claude Code's bash mode does.
    const shell = text.startsWith("!");
    if (shell !== this.shellLook) {
      this.shellLook = shell;
      this.inputWrap.borderColor = shell ? C.accent : C.promptBorder;
      this.promptGlyph.content = shell ? "! " : `${G.prompt} `;
      this.promptGlyph.fg = shell ? C.accent : C.dim;
    }
    this.armNote(text);
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
    } else if (this.palette && this.paletteKind !== "handoff" && this.paletteKind !== "files" && !text.includes("\n")) {
      // Every picker filters as you type (agents, models, settings…), like Claude Code's.
      this.palette.setFilter(text);
      this.paletteFiltered = text.length > 0;
    }
    if (this.shortcuts.visible && text) this.shortcuts.visible = false;
  }

  // ---------- submit / commands ----------

  private async submit() {
    const text = this.input.plainText.trim();
    if (!text && this.queueEdit) {
      const { original } = this.queueEdit;
      this.queueEdit = null;
      this.renderQueue();
      this.renderFooter();
      return this.transcript.note(`removed from the queue: ${original.replace(/\s+/g, " ").slice(0, 80)}`, C.dim);
    }
    if (!text) return;
    // The agent finished meanwhile: the edited message is sent now, not queued.
    if (this.queueEdit && !this.active?.turn) {
      this.queueEdit = null;
      this.renderQueue();
    }
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
    this.rotateTip();
    // Busy also while the agent is still starting or a message is on its way (its snapshot):
    // a second message then queues instead of reaching a half-started agent or racing the first.
    const busy = !!this.active?.turn || !!this.verifying || !!this.debate || this.starting || this.sending;
    // Built-in commands run at once, even mid-turn (/config, /model, /theme…); only those that
    // start agent work wait. The agent's own commands are messages to it, so they queue.
    const name = text.split(/\s+/)[0]!.toLowerCase();
    const builtin = text.startsWith("/") && this.builtins().some((b) => b.name === name || b.name === name.replace(/^\/(exit|q)$/, "/quit"));
    const immediate = builtin && !WAITS_FOR_AGENT.test(text);
    if (busy && !immediate && (text.startsWith("/") || text.startsWith("!"))) {
      this.enqueue(text);
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
    if (this.active.turn || this.verifying || this.debate || this.starting || this.sending) {
      this.enqueue(text);
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

  private async checkpoint(active: Active, text: string, message?: string): Promise<Checkpoint | null> {
    if (!this.config.checkpoints) return null;
    const point = active.engine.rewindPoint?.() ?? undefined;
    const t0 = Date.now();
    const cp = await createCheckpoint(this.cwd, `before ${active.agent}: ${(message ?? text).slice(0, 60).replace(/\s+/g, " ")}`, point && { agent: active.agent, ...point }, this.ledger.threadId).catch((e) => {
      debugEvent("checkpoint-failed", errorFields(e));
      return null;
    });
    if (Date.now() - t0 > 1500) debugEvent("checkpoint-slow", { ms: Date.now() - t0 });
    if (cp) this.checkpoints.push({ ...cp, agent: active.agent, message, fork: point });
    return cp;
  }

  /**
   * /rewind (or Esc twice): pick one of your earlier messages and put the files
   * back the way they were before it, then edit and resend it if you like. The
   * current state is snapshotted first, so /undo reverses a rewind (the files).
   * Claude's conversation is cut back too (a fork at its reply before that
   * message); other agents keep theirs and are told what was rewound.
   */
  private async openRewind() {
    if (this.active?.turn) return this.transcript.note("the agent is working; Esc first, then /rewind", C.warn);
    if (this.verifying) return this.transcript.note("the checks are running; Esc first, then /rewind", C.warn);
    if (this.debate) return this.transcript.note("a debate is reading the code; Esc stops it, then /rewind", C.warn);
    if (!this.config.checkpoints) return this.transcript.note("rewind needs snapshots: /config → Snapshots for /undo → on", C.warn);
    const mine = [...this.checkpoints].reverse().filter((c) => c.message !== undefined && !c.label.startsWith("before rewind: "));
    // Older snapshots of this thread (ones from before threads carry none and are kept).
    const older = (await listCheckpoints(this.cwd, 30)).filter((c) => !this.checkpoints.some((m) => m.sha === c.sha) && (!c.thread || c.thread === this.ledger.threadId) && /^before \w+: /.test(c.label) && !/^before (rewind: |\w+: handoff to )/.test(c.label));
    const all = [...mine.map((c) => ({ ...c, text: c.message! })), ...older.map((c) => ({ ...c, agent: c.label.match(/^before (\w+):/)![1] as AgentId, text: c.label.replace(/^before \w+: /, "") }))];
    if (!all.length) return this.transcript.note("nothing to rewind to yet (snapshots need a git repo)", C.warn);
    const counts = await checkpointChangeCounts(this.cwd, all.map((c) => c.sha)).catch(() => new Map<string, number>());
    this.closePalette();
    this.paletteKind = "picker";
    this.palette = new Palette(this.renderer, {
      title: "Rewind the files to before which message? · Enter to pick · Esc to cancel",
      items: all.map((c, i) => {
        const n = counts.get(c.sha);
        return {
          label: c.text.replace(/\s+/g, " ").trim() || "(empty)",
          description: `${fmtDateTime12(c.ts)} · ${listAdapters(this.config.order).find((a) => a.id === c.agent)?.name ?? c.agent}`,
          hint: n === undefined ? undefined : n === 0 ? "no changes since" : `${n} file${n === 1 ? "" : "s"} changed since`,
          value: String(i),
          weight: all.length - i,
        };
      }),
      maxRows: 10,
      onPick: (it) => {
        const c = all[Number(it.value)]!;
        this.closePalette();
        this.openRewindChoice(c);
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  /** The current agent can cut its conversation back to this snapshot (same agent, same session). */
  private conversationRewind(c: { agent: AgentId; fork?: RewindPoint }): Active | null {
    const a = this.active;
    if (!a || !c.fork || a.agent !== c.agent || a.engine.session?.id !== c.fork.sessionId || !a.engine.rewindConversation) return null;
    return a;
  }

  private openRewindChoice(c: Checkpoint & { agent: AgentId; text: string; fork?: RewindPoint }) {
    this.paletteKind = "picker";
    const short = c.text.replace(/\s+/g, " ").slice(0, 50);
    const convo = this.conversationRewind(c);
    this.palette = new Palette(this.renderer, {
      title: convo
        ? `Rewind to before "${short}" · files and ${convo.name}'s conversation · /undo brings the files back`
        : `Rewind to before "${short}" · code only: the agent keeps its conversation and is told · /undo reverses it`,
      items: [
        { label: "Restore files and edit the message", description: "puts the message back in the prompt", value: "edit", weight: 2 },
        { label: "Restore files only", value: "files", weight: 1 },
      ],
      onPick: (it) => {
        this.closePalette();
        this.safelyAsync("rewind", this.rewindTo(c, it.value === "edit"));
      },
      onClose: () => this.safelyAsync("rewind", this.openRewind()),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  private async rewindTo(c: Checkpoint & { agent: AgentId; text: string; fork?: RewindPoint }, edit: boolean) {
    if (this.active?.turn || this.verifying || this.debate) return this.transcript.note("the agent is working; Esc first, then /rewind", C.warn);
    debugEvent("rewind", { agent: c.agent, active: this.active?.agent, conversation: !!this.conversationRewind(c) || undefined, edit: edit || undefined, ageMin: Math.round((Date.now() - c.ts) / 60000) });
    const short = c.text.replace(/\s+/g, " ").slice(0, 60);
    // The conversation first: when it cannot be cut, the agent is told instead.
    const convo = this.conversationRewind(c);
    let cut = false;
    if (convo) {
      try {
        const old = c.fork!.sessionId;
        await convo.engine.rewindConversation!(c.fork!);
        cut = true;
        // The copy keeps the earlier messages (and their ids), so earlier snapshots can still rewind it.
        const now = convo.engine.session?.id;
        if (now) for (const m of this.checkpoints) if (m.fork?.sessionId === old) m.fork = { ...m.fork, sessionId: now };
        this.transcript.note(`${convo.name}'s conversation is back to before "${short}": it no longer remembers the later turns`, C.warn);
      } catch (e: any) {
        this.transcript.note(`could not rewind ${convo.name}'s conversation (${String(e?.message ?? e).slice(0, 120)}); it is told about the rewind instead`, C.warn);
      }
    }
    const stat = await checkpointDiffStat(this.cwd, c.sha).catch(() => "");
    // Snapshots after the rewind point describe undone work.
    const at = this.checkpoints.findIndex((m) => m.sha === c.sha);
    if ((stat.trim() || cut) && at >= 0) this.checkpoints.splice(at);
    if (stat.trim()) {
      // Snapshot what is there now, so /undo can bring it back.
      const back = await createCheckpoint(this.cwd, `before rewind: ${c.text.slice(0, 50).replace(/\s+/g, " ")}`).catch(() => null);
      const r = await restoreCheckpoint(this.cwd, c.sha);
      if (back) this.checkpoints.push({ ...back, agent: this.active?.agent ?? c.agent });
      this.transcript.note(`rewound the files to before "${short}" (${fmtDateTime12(c.ts)}) · /undo brings them back`, C.warn);
      for (const l of stat.split("\n")) this.transcript.note(l);
      if (r.removed.length) this.transcript.note(`removed ${r.removed.length} new file(s): ${r.removed.slice(0, 5).join(", ")}${r.removed.length > 5 ? "…" : ""}`);
      if (!cut) this.pendingShell.push(`[codemax] The user rewound the working tree to how it was before their message "${c.text.slice(0, 200)}" (sent ${fmtDateTime12(c.ts)}). Every file change made after that point is undone; treat that later work as not done.`);
    } else this.transcript.note(`no file changes since "${short}"`);
    // Handoffs and catch-ups must not present the undone turns as done.
    if (stat.trim() || cut) this.ledger.journal.rewind(this.active?.agent ?? c.agent, c.sha, c.text);
    if (edit) {
      this.input.setText(c.text);
      this.input.gotoBufferEnd?.();
    }
    this.input.focus();
  }

  /** Ctrl+R: search this project's earlier messages (kept across restarts); Enter puts one in the prompt. */
  private openHistorySearch() {
    if (this.permission) return;
    const entries = [...this.history].reverse();
    if (!entries.length) return this.setFlash("no earlier messages in this project yet");
    const draft = this.input.plainText;
    this.closePalette();
    this.input.clear();
    this.paletteKind = "picker";
    this.palette = new Palette(this.renderer, {
      title: "Search your messages · type to filter · Enter to use · Esc to cancel",
      items: entries.map((t, i) => ({ label: t.replace(/\s*\n\s*/g, " ⏎ "), value: String(i), weight: entries.length - i })),
      maxRows: 10,
      onPick: (it) => {
        this.closePalette();
        this.input.setText(entries[Number(it.value)]!);
        this.input.gotoBufferEnd?.();
      },
      onClose: () => {
        this.closePalette();
        if (draft) this.input.setText(draft);
      },
    }, this.paletteAnchor);
    this.paletteFiltered = true;
    this.renderer.root.add(this.palette.box);
  }

  private async undo() {
    if (this.active?.turn) return this.transcript.note("the agent is working; Esc first, then /undo", C.warn);
    if (this.verifying) return this.transcript.note("the checks are running; Esc first, then /undo", C.warn);
    if (this.debate) return this.transcript.note("a debate is reading the code; Esc stops it, then /undo", C.warn);
    // Look before taking it: an undo that finds nothing changed keeps the snapshot for later.
    const cp = this.checkpoints.at(-1) ?? (await listCheckpoints(this.cwd, 1))[0];
    if (!cp) return this.transcript.note("no checkpoint to restore (checkpoints need a git repo)", C.warn);
    const stat = await checkpointDiffStat(this.cwd, cp.sha);
    if (!stat.trim()) {
      this.transcript.note(`nothing changed since the checkpoint "${cp.label}"`);
      return;
    }
    if (this.checkpoints.at(-1) === cp) this.checkpoints.pop();
    const r = await restoreCheckpoint(this.cwd, cp.sha);
    debugEvent("undo", { restored: r.restored, removed: r.removed.length });
    this.transcript.note(`reverted to the snapshot ${cp.label}`, C.warn);
    for (const l of stat.split("\n")) this.transcript.note(l);
    if (r.removed.length) this.transcript.note(`removed ${r.removed.length} new file(s): ${r.removed.slice(0, 5).join(", ")}${r.removed.length > 5 ? "…" : ""}`);
    this.pendingShell.push(
      cp.label.startsWith("before rewind: ")
        ? "[codemax] The user undid a rewind with /undo: the files are back as they were before it, including changes from turns that may no longer be in your conversation. Check the working tree before relying on what you remember."
        : "[codemax] The user reverted the file changes from the last turn with /undo. The working tree is back to the state before that turn.",
    );
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
    side.unsubscribe = engine.onEvent((e) => this.onEngineEvent(side, safeDeep(e)));
    this.transcript.divider(`${why} · ${adapter.name}`);
    this.transcript.user(text);
    try {
      await engine.start({ cwd: this.cwd, questions: this.config.questions !== "off", instructions: this.narration(agent) });
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

  /** The editor for Ctrl+G and /editor: $VISUAL, $EDITOR, else vi (Notepad on Windows). */
  editorCommand = () => process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");

  /** Ctrl+G / /editor: edit the prompt's text in your editor; what you save comes back into the prompt. */
  private async composeInEditor() {
    const file = join(tmpdir(), `codemax-message-${process.pid}-${Date.now()}.md`);
    writeFileSync(file, this.input.plainText, { mode: 0o600 });
    const editor = this.editorCommand();
    let code = 1;
    await this.withTerminal(async () => {
      const p = Bun.spawn(shellArgv(`${editor} ${JSON.stringify(file)}`), { ...SHELL_SPAWN, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      code = await p.exited;
    });
    try {
      const text = readFileSync(file, "utf8").replace(/\s+$/, "");
      if (code === 0) {
        this.input.setText(text);
        this.input.gotoBufferEnd?.();
      } else this.setFlash(`${editor} exited with ${code}; the prompt is unchanged`);
    } catch {
      this.setFlash("could not read the message back from the editor");
    } finally {
      rmSync(file, { force: true });
    }
    this.input.focus();
  }

  /** /copy: the last reply (or the last N back) onto the clipboard. */
  private async copyLastReply(arg: string) {
    const back = Math.max(1, Number(arg) || 1);
    const replies = this.ledger.turns().filter((t) => t.role === "assistant" && t.text.trim());
    const t = replies[replies.length - back];
    if (!t) return this.transcript.note("no reply to copy yet", C.warn);
    const ok = await this.copyText(t.text);
    this.transcript.note(ok ? `copied ${back === 1 ? "the last reply" : `the reply ${back} back`} (${t.text.length} chars)` : "could not copy: no clipboard available", ok ? C.ok : C.warn);
  }

  /**
   * /export [path]: this conversation as Markdown: your messages, the agents' replies and
   * the steps they took. Saved under ~/.codemax/exports (yours only) unless you name a path.
   */
  private exportThread(arg: string) {
    const md = threadMarkdown(this.ledger, listAdapters(this.config.order));
    const target = arg.trim() ? resolve(this.cwd, arg.trim()) : join(ensureDir(join(CODEMAX_HOME, "exports")), `${this.ledger.threadId}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`);
    try {
      writeFileSync(target, md, { mode: 0o600 });
      this.transcript.note(`exported this conversation (${md.split("\n").length} lines) to ${target}`, C.ok);
    } catch (e: any) {
      this.transcript.error(`could not export: ${e?.message ?? e}`);
    }
  }

  /** A running /debate: its sessions, and whether you stopped it (Esc). */
  private debate: { actives: Active[]; stopped: boolean } | null = null;

  /**
   * /debate <goal>: choose 2-3 debaters, each an agent and the model it debates on (the
   * same agent twice on different models is fine), then start.
   */
  private openDebate(goal: string) {
    goal = goal.trim();
    if (!goal) return this.transcript.note("usage: /debate <goal> · 2-3 agents each propose a plan, argue it out, and a judge merges the best", C.warn);
    if (this.debate) return this.transcript.note("a debate is already running · Esc stops it", C.warn);
    const ok = (a: AgentId) => !!this.detect.get(a)?.installed && !!this.detect.get(a)?.engine;
    const usable = listAdapters(this.config.order).filter((a) => ok(a.id));
    if (!usable.length) return this.transcript.note("no agent is installed", C.warn);
    // To start with: your agent, then the next ones in your handoff order, with their models.
    const entries: { agent: AgentId; model?: string; modelName?: string }[] = [];
    const add = (e: { agent: AgentId; model?: string; modelName?: string }) => {
      if (entries.length < 2 && ok(e.agent) && !entries.some((x) => x.agent === e.agent && x.model === e.model)) entries.push(e);
    };
    if (this.active) add(this.chainEntry(this.active.agent) ?? { agent: this.active.agent });
    for (const e of this.chain()) add(e);
    // This debate's rounds (Enter cycles them); /config sets where it starts.
    const ROUNDS: DebateRounds[] = [1, 2, 3, 5, "auto"];
    let rounds: DebateRounds = this.config.debateRounds ?? 1;
    const show = () => {
      this.closePalette();
      this.paletteKind = "modes";
      const items: PaletteItem[] = [
        ...entries.map((e, i) => ({ label: `${i + 1}. ${this.entryLabel(e)}`, description: "Enter removes it", value: `e:${i}` })),
        ...(entries.length < 3 ? [{ label: "+ Add a debater", description: "an agent, then its model", value: "add" }] : []),
        { label: `Rounds: ${roundsLabel(rounds)}`, description: "Enter changes it: 1, 2, 3, 5, or until the judge is satisfied", value: "rounds" },
        { label: `Start the debate (${entries.length})`, description: entries.length < 2 ? "add at least two" : debateCost(entries.length, rounds), value: "start", disabled: entries.length < 2 },
      ].map((it, i) => ({ ...it, weight: 100 - i }));
      this.palette = new Palette(this.renderer, {
        title: "Debate: who argues? · 2 or 3 agents, each on a model you choose · Esc cancels",
        items,
        onPick: (it) => {
          if (it.value === "start") {
            this.closePalette();
            return void this.runDebate([...entries], goal, rounds);
          }
          if (it.value === "rounds") {
            rounds = ROUNDS[(ROUNDS.indexOf(rounds) + 1) % ROUNDS.length]!;
            return show();
          }
          if (it.value.startsWith("e:")) {
            entries.splice(Number(it.value.slice(2)), 1);
            return show();
          }
          this.closePalette();
          this.paletteKind = "modes";
          this.palette = new Palette(this.renderer, {
            title: "Which agent? · Esc back",
            items: usable.map((a, i) => ({ label: a.name, value: a.id, weight: 100 - i })),
            onPick: (pick) =>
              void this.pickModelFor(pick.value as AgentId, (m) => {
                const e = { agent: pick.value as AgentId, ...m };
                if (!entries.some((x) => x.agent === e.agent && x.model === e.model)) entries.push(e);
                show();
              }),
            onClose: () => show(),
          }, this.paletteAnchor);
          this.renderer.root.add(this.palette.box);
        },
        onClose: () => this.closePalette(),
      }, this.paletteAnchor);
      this.renderer.root.add(this.palette.box);
    };
    show();
  }

  /**
   * Run a debate (see core/debate.ts). Each debater has its own session, in plan mode where
   * the agent has one; every permission it asks for is refused. Proposals and critiques run
   * side by side; the judge is your current agent when it debates, else the first one.
   */
  private async runDebate(entries: { agent: AgentId; model?: string; modelName?: string }[], goal: string, rounds: DebateRounds = this.config.debateRounds ?? 1) {
    if (this.debate || entries.length < 2) return;
    const actives: Active[] = [];
    this.debate = { actives, stopped: false };
    // "Claude Code · Opus 5.5": the same agent on two models stays two debaters.
    const names = entries.map((e) => this.entryLabel(e));
    this.transcript.divider(`debate · ${names.join(" vs ")}`);
    this.transcript.note(`${debateCost(entries.length, rounds)} · they read the code but change nothing · Esc stops`, C.dim);
    this.renderFooter();
    try {
      const models = new Map<Active, string | undefined>();
      for (const [i, entry] of entries.entries()) {
        const { agent } = entry;
        const blocked = this.checkBlockers(agent);
        if (blocked.length) {
          this.transcript.error(`${getAdapter(agent).name} not started: ${blocked[0]!.message}`);
          continue;
        }
        const engine = this.engineFactory(agent);
        const a: Active = { agent, name: names[i]!, engine, turn: null, replay: null, unsubscribe: () => {}, commands: [] };
        models.set(a, entry.model);
        this.side.add(a);
        a.unsubscribe = engine.onEvent((e) => this.onEngineEvent(a, safeDeep(e)));
        actives.push(a);
      }
      await Promise.all(actives.map(async (a) => {
        await a.engine.start({ cwd: this.cwd, questions: false });
        const model = models.get(a);
        if (model && a.engine.setModel && a.engine.info?.currentModel !== model) await a.engine.setModel(model).catch((e: any) => this.transcript.note(`${a.name}: could not switch model (${String(e?.message ?? e).slice(0, 100)})`, C.warn));
        if (a.engine.setMode && a.engine.info?.modes.some((m) => m.id === "plan")) await a.engine.setMode("plan").catch(() => {});
      }));
      if (actives.length < 2) throw new Error("fewer than two agents could start");
      const ask = (a: Active, prompt: string) => new Promise<string>((done) => {
        let reply = "";
        void this.runTurn(a, prompt, { record: false, journal: false, onReply: (r) => (reply = r) })
          .catch((e: any) => this.transcript.error(`${a.name}: ${String(e?.message ?? e).slice(0, 200)}`))
          .finally(() => done(reply));
      });
      const me = (a: Active) => ({ name: a.name });
      const others = (a: Active) => actives.filter((x) => x !== a).map(me);
      this.transcript.divider("round 1 · each proposes a plan");
      let plans = await Promise.all(actives.map(async (a) => ({ name: a.name, plan: await ask(a, proposalPrompt(goal, me(a), others(a))) })));
      const judge = actives.find((a) => a.agent === this.active?.agent) ?? actives[0]!;
      // "Until the judge is satisfied": after each round the judge says SETTLED, or what is
      // still open (the next round argues that first). UNTIL_SETTLED_MAX rounds at most.
      const last = rounds === "auto" ? UNTIL_SETTLED_MAX : rounds;
      let focus: string | undefined;
      for (let r = 1; r <= last && !this.debate.stopped; r++) {
        this.transcript.divider(`round ${r + 1} · each attacks the others' plans and defends its own`);
        const current = plans;
        plans = await Promise.all(actives.map(async (a) => ({ name: a.name, plan: (await ask(a, critiquePrompt(goal, me(a), current, r, rounds, focus))) || current.find((p) => p.name === a.name)!.plan })));
        if (rounds !== "auto" || this.debate.stopped) continue;
        if (r === last) {
          this.transcript.note(`${UNTIL_SETTLED_MAX} argument rounds: that is the most a debate goes on · the judge decides now`, C.dim);
          break;
        }
        const call = parseSettled(await ask(judge, settledPrompt(goal, plans, r)));
        if (call.settled) {
          this.transcript.note(`${judge.name}: settled after ${r} argument round${r === 1 ? "" : "s"}`, C.ok);
          break;
        }
        focus = call.focus;
        this.transcript.note(`${judge.name}: not settled yet${focus ? ` · next: ${focus.slice(0, 160)}` : ""}`, C.dim);
      }
      if (this.debate.stopped) return this.transcript.note("debate stopped", C.warn);
      this.transcript.divider(`verdict · ${judge.name} merges the strongest parts`);
      const verdict = await ask(judge, judgePrompt(goal, plans));
      if (this.debate.stopped || !verdict) return this.transcript.note("debate stopped before a verdict", C.warn);
      this.offerDebatePlan(goal, finalPlan(verdict), names);
    } catch (e: any) {
      this.transcript.error(`debate: ${e?.message ?? e}`);
    } finally {
      for (const a of actives) {
        a.unsubscribe();
        this.side.delete(a);
        void a.engine.close().catch(() => {});
      }
      this.debate = null;
      if (this.active) this.transcript.divider(`back to ${this.active.name}`);
      this.renderFooter();
      if (this.active) void this.drainQueue(this.active);
    }
  }

  /** After a verdict: build the agreed plan with your agent, or keep it for later. */
  private offerDebatePlan(goal: string, plan: string, names: string[]) {
    const a = this.active;
    if (!a) return;
    this.closePalette();
    this.paletteKind = "handoff";
    this.palette = new Palette(this.renderer, {
      title: `The debate agreed on a plan · Enter to build it with ${a.name}`,
      items: [
        { label: `Build it with ${a.name}`, description: "sends the goal and the agreed plan as your next message", value: "build", weight: 2 },
        { label: "Not now", description: "the plan stays in the transcript", value: "no", weight: 1 },
      ],
      onPick: (it) => {
        this.closePalette();
        if (it.value === "build" && this.active === a) void this.send(a, `${goal}\n\nCarry out this plan, agreed in a debate between ${names.join(", ")}:\n\n${plan}`, { shown: `build the debated plan: ${goal}` });
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
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
      // A handoff only for the agent you are on (an /ask or a debater going over does not move you).
      else if (this.active?.agent === agent && !this.debate) this.offerHandoff(agent, `${label} reached its ${fmtUsd(b[k])} daily budget (${spent})`, k === "all");
      else this.transcript.note(`${label} reached its ${fmtUsd(b[k])} daily budget (${spent})`, C.warn);
    }
  }

  /**
   * The handoff order: your list of agents (each with an optional model), else every agent
   * in `order` on its default model.
   */
  private chain(): { agent: AgentId; model?: string; modelName?: string }[] {
    const c = this.config.handoffChain;
    return c?.length ? c : this.config.order.map((agent) => ({ agent }));
  }

  private chainEntry(agent: AgentId) {
    return this.config.handoffChain?.find((e) => e.agent === agent);
  }

  /** The entry to continue on: the next in the handoff order after `from`, installed, not out of quota or over budget. */
  private nextAgent(from: AgentId): { agent: AgentId; model?: string; modelName?: string } | null {
    const b = this.config.budgets ?? {};
    const list = this.chain();
    const at = list.findIndex((e) => e.agent === from);
    // After the current one first, then from the top (an earlier agent's limit may have reset).
    const ordered = at >= 0 ? [...list.slice(at + 1), ...list.slice(0, at)] : list;
    for (const e of ordered) {
      if (e.agent === from || e.agent === this.active?.agent || this.broken.has(e.agent)) continue;
      const d = this.detect.get(e.agent);
      if (!d?.installed || !d.engine) continue;
      if (isExhausted(this.quota.get(e.agent))) continue;
      if (budgetLevel(this.today.get(e.agent) ?? 0, b[e.agent]) === "over") continue;
      return e;
    }
    return null;
  }

  /** "Cursor Agent · Opus 5.5" (or just the agent on its default model). */
  private entryLabel(e: { agent: AgentId; model?: string; modelName?: string }): string {
    const name = listAdapters(this.config.order).find((a) => a.id === e.agent)?.name ?? e.agent;
    return e.model ? `${name} · ${e.modelName ?? displayModelName(e.model)}` : name;
  }

  /** Agents that refused to work this run (their own setup is broken); handoffs skip them until you switch to one. */
  private broken = new Set<AgentId>();

  /** One-key handoff offer: Enter continues the task in the next agent. */
  private pendingOffer: { from: AgentId; reason: string; allAgents: boolean } | null = null;

  private offerHandoff(from: AgentId, reason: string, allAgents = false) {
    debugEvent("handoff-offer", { from, reason, allAgents: allAgents || undefined, busy: !!this.active?.turn || undefined });
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
    // "Hand off automatically": the next agent in your order takes over without asking. Not an
    // agent that edits files without asking (Cursor): nobody would approve its edits, so you
    // confirm that one with Enter.
    const unasked = EDITS_WITHOUT_ASKING.has(next.agent);
    if (this.config.autoHandoff && unasked) this.transcript.note(`${getAdapter(next.agent).name} edits files without asking, so this handoff waits for your Enter`, C.warn);
    if (this.config.autoHandoff && !unasked) {
      this.transcript.note(`handing off to ${this.entryLabel(next)} (next in your handoff order) · /switch to pick another`, C.accent);
      void this.switchTo(next.agent, false, { resumeTask: true, model: next.model });
      return;
    }
    this.closePalette();
    // The rest of the order, then any other agent, each once.
    const rest = [...this.chain(), ...listAdapters(this.config.order).map((a): { agent: AgentId; model?: string; modelName?: string } => ({ agent: a.id }))].filter((e, i, all) => e.agent !== next.agent && e.agent !== from && e.agent !== this.active?.agent && !this.broken.has(e.agent) && all.findIndex((x) => x.agent === e.agent) === i && this.detect.get(e.agent)?.engine);
    const entries = [next, ...rest];
    const items: PaletteItem[] = [
      { label: `Continue in ${this.entryLabel(next)}`, description: "next in your handoff order: hand over the conversation and the unfinished request", value: "0" },
      ...rest.map((e, i) => ({ label: `Continue in ${this.entryLabel(e)}`, description: isExhausted(this.quota.get(e.agent)) ? "out of quota" : "", value: String(i + 1), disabled: isExhausted(this.quota.get(e.agent)) })),
      { label: `Stay on ${getAdapter(from).name}`, description: "keep going here anyway", value: "__stay" },
    ];
    this.paletteKind = "handoff";
    this.palette = new Palette(this.renderer, {
      title: `${reason} · Enter to continue in ${this.entryLabel(next)}`,
      items,
      onPick: (it) => {
        this.closePalette();
        const e = entries[Number(it.value)];
        if (it.value !== "__stay" && e) void this.switchTo(e.agent, false, { resumeTask: true, model: e.model });
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    // keep the offered order (Continue first), not alphabetical
    (this.palette as any).opts.items.forEach((it: PaletteItem, i: number) => (it.weight = 100 - i));
    this.palette.setFilter("");
    this.renderer.root.add(this.palette.box);
  }

  private async openFilePalette(filter: string) {
    if (!this.projectFiles) {
      // One listing for every keystroke after "@", and a listing that finishes late (slow git
      // on Windows) must not reopen the picker after a file was already picked.
      this.projectFilesLoading ??= listProjectFiles(this.cwd).catch(() => []);
      this.projectFiles = await this.projectFilesLoading;
      const now = this.input.plainText.match(MENTION_RE)?.[2];
      if (now === undefined) return;
      filter = now;
    }
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
  /**
   * Startup: choose the agent to continue with. One row per usable agent, most
   * recently used first, resuming its saved session when there is one.
   */
  private openPicker(defaultAgent: AgentId): boolean {
    const sessions = this.ledger.sessions();
    const turns = this.ledger.turns();
    const usable = listAdapters(this.config.order).filter((a) => this.detect.get(a.id)?.installed && this.detect.get(a.id)?.engine);
    if (!usable.length) return false;
    const recent = [...usable].sort((a, b) => (sessions[b.id]?.lastUsedAt ?? 0) - (sessions[a.id]?.lastUsedAt ?? 0));
    const items: PaletteItem[] = recent.map((a, i) => {
      const s = sessions[a.id];
      const last = [...turns].reverse().find((t) => t.agent === a.id && t.role === "user");
      const q = this.quota.get(a.id);
      const bits = [s ? `resume · ${ago(s.lastUsedAt)}${last ? ` · "${last.text.replace(/\s+/g, " ").slice(0, 50)}"` : ""}` : "new session"];
      if (q && quotaLabel(q)) bits.push(quotaLabel(q));
      return { label: a.name, description: bits.join(" · "), value: `resume:${a.id}`, weight: 100 - i };
    });
    const fresh = recent[0]!;
    const used = this.threadUsed;
    items.push({ label: `New thread with ${fresh.name}`, description: used ? `this one stays: codemax --resume ${this.ledger.threadId}` : "a new conversation", value: `new:${fresh.id}`, weight: 0 });
    defaultAgent = sessions[fresh.id] ? fresh.id : defaultAgent;
    this.paletteKind = "picker";
    this.palette = new Palette(this.renderer, {
      title: `Choose an agent to continue with · Enter to start · Esc for ${getAdapter(defaultAgent).name}`,
      items,
      onPick: (it) => {
        this.closePalette();
        const [kind, agent] = it.value.split(":") as ["resume" | "new", AgentId];
        if (kind === "new" && used) this.ledger = new Ledger(this.cwd, undefined, "new");
        void this.launch(agent, { fresh: kind === "new" });
      },
      onClose: () => {
        this.closePalette();
        void this.launch(defaultAgent, { fresh: false });
      },
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
    return true;
  }

  /**
   * `codemax --resume` without an id: pick one of this project's threads (newest first), or
   * start a new one. The chosen thread continues with the agent that last worked in it.
   */
  private openThreadPicker(defaultAgent: AgentId): boolean {
    const threads = Ledger.threads(this.ledger.dir).filter((t) => t.title);
    if (!threads.length) {
      this.transcript.note("no earlier threads in this project; starting a new one");
      return false;
    }
    const ok = (a?: AgentId) => !!a && !!this.detect.get(a)?.installed && !!this.detect.get(a)?.engine;
    const name = (a?: string) => (a ? (listAdapters(this.config.order).find((x) => x.id === a)?.name ?? a) : "");
    this.threadPicker = new ThreadPicker(this.renderer, {
      threads,
      agentName: name,
      newWith: name(defaultAgent),
      preview: (id) => Ledger.threadPreview(this.ledger.dir, id),
      onPick: (id) => {
        this.threadPicker?.destroy();
        this.threadPicker = null;
        this.chatRoot.visible = true;
        this.input.focus();
        const t = threads.find((x) => x.id === id);
        this.ledger = new Ledger(this.cwd, undefined, t ? t.id : "new");
        void this.launch(t && ok(t.agent) ? t.agent! : defaultAgent, { fresh: !t });
      },
    });
    // Claude Code's resume list takes the whole screen; the chat comes back with the thread.
    this.chatRoot.visible = false;
    this.renderer.root.add(this.threadPicker.box);
    return true;
  }

  /** Queue a message (or command) until the agent's turn ends; it shows above the prompt. */
  private enqueue(text: string) {
    // An edited queued message goes back to the place it came from.
    if (this.queueEdit) {
      this.queue.splice(Math.min(this.queueEdit.index, this.queue.length), 0, text);
      this.queueEdit = null;
    } else this.queue.push(text);
    this.renderQueue();
    this.renderFooter();
  }

  private renderQueue() {
    this.safely("queue", () => {
      for (const child of this.queueBox.getChildren()) child.destroyRecursively();
      const show = this.queue.slice(0, 3);
      for (const [i, q] of show.entries()) {
        const line = q.startsWith("A side agent (") ? "side-agent note for the main agent" : q.replace(/\s+/g, " ");
        this.queueBox.add(new TextRenderable(this.renderer, { id: `queue-${Date.now()}-${i}`, content: `${G.prompt} ${line}`, fg: C.dim, wrapMode: "none", truncate: true, width: "100%" } as any));
      }
      if (this.queue.length > show.length) this.queueBox.add(new TextRenderable(this.renderer, { id: `queue-more-${Date.now()}`, content: `  + ${this.queue.length - show.length} more queued`, fg: C.dimmer }));
      const hint = this.queueEdit
        ? "editing a queued message · Enter puts it back · clear it and Enter to remove it · Esc cancels"
        : this.queue.length ? "↑ to edit or remove a queued message" : "";
      if (hint) this.queueBox.add(new TextRenderable(this.renderer, { id: `queue-hint-${Date.now()}`, content: `  ${hint}`, fg: this.queueEdit ? C.accent : C.dimmer, wrapMode: "word", width: "100%" } as any));
      this.queueBox.visible = this.queue.length > 0 || !!this.queueEdit;
    });
  }

  /**
   * ↑ on an empty prompt pulls the last queued message back for editing; ↑ again (text
   * unchanged or not) puts it back and moves to the one before it.
   */
  private editQueued() {
    let index = this.queue.length;
    if (this.queueEdit) {
      const cur = this.input.plainText;
      index = this.queueEdit.index;
      this.queue.splice(index, 0, cur.trim() ? cur : this.queueEdit.original);
      this.queueEdit = null;
    }
    const at = index - 1;
    if (at < 0) {
      // Already at the oldest: keep editing it.
      if (!this.queue.length) return;
      return this.takeQueued(0);
    }
    this.takeQueued(at);
  }

  private takeQueued(at: number) {
    const [text] = this.queue.splice(at, 1);
    this.queueEdit = { index: at, original: text! };
    this.input.setText(text!);
    this.input.cursorOffset = text!.length;
    this.renderQueue();
    this.renderFooter();
  }

  /** Run one queued entry the same way as if it had just been typed. */
  private async dispatch(active: Active, text: string) {
    if (text.startsWith("!")) return this.shell(text.slice(1).trim());
    if (text.startsWith("/")) return this.command(text);
    return this.send(active, text);
  }

  private async drainQueue(active: Active) {
    while (this.queue.length && this.active === active && !active.turn) {
      const next = this.queue.shift()!;
      this.renderQueue();
      await this.dispatch(active, next);
    }
    this.renderFooter();
  }

  private async send(active: Active, text: string, o: { shown?: string; verifyFix?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    if (!this.side.has(active)) this.notePanel.setPaused(false);
    // A new request from you starts a new task for the automatic check fixes.
    if (!o.verifyFix && !isForwardedNote(text)) this.verifyFixes = 0;
    const typed = o.shown ?? text;
    this.transcript.user(typed);
    this.sending = true;
    const drop = this.takeDropped(text);
    if (drop.images.length) this.transcript.note(`attached ${drop.images.length} image${drop.images.length === 1 ? "" : "s"}: ${drop.images.map((i) => basename(i.path)).join(", ")}`, C.dimmer);
    text = this.withAttachments(drop.text);
    let cp: Checkpoint | null;
    try {
      cp = await this.checkpoint(active, text, typed);
    } finally {
      this.sending = false;
    }
    this.ledger.addTurns([{ ts: Date.now(), agent: active.agent, sessionId: active.engine.session?.id ?? "?", role: "user", text }]);
    const rec = new TurnRecorder(this.ledger.journal, active.agent);
    rec.user(text, cp?.sha);
    const r = await this.runTurn(active, text, { rec, images: drop.images });
    const fix = r ? await this.verifyAfterTurn(active, r, cp) : null;
    if (fix) return this.send(active, fix.text, { shown: fix.shown, verifyFix: true });
    await this.drainQueue(active);
  }

  /**
   * Checks after edits: when this project has a check command and the turn
   * changed files, run it. A failure is shown and goes with your next message,
   * or ("fix" mode) is sent straight back to the agent, at most VERIFY_FIX_CAP
   * times per task so a check the agent cannot fix never loops.
   */
  private async verifyAfterTurn(active: Active, r: { stop: StopReason; edited: boolean }, cp: Checkpoint | null): Promise<{ text: string; shown: string } | null> {
    const cmd = this.config.verify?.[this.cwd];
    if (!cmd || this.closed || this.active !== active || r.stop === "cancelled" || r.stop === "error") return null;
    const changed = cp ? !!(await checkpointDiffStat(this.cwd, cp.sha).catch(() => "")).trim() : r.edited;
    if (!changed) return null;
    const res = await this.runChecks(cmd, active.agent);
    if (!res || res.code === 0 || res.stopped || this.closed) return null;
    const why = res.timedOut ? "timed out" : `exit ${res.code}`;
    const body = `[codemax checks] \`${cmd}\` failed after your changes (${why}). Output (end):\n${tail(res.output, 120).slice(-6000)}`;
    if (this.config.verifyOnFail === "fix" && this.verifyFixes < VERIFY_FIX_CAP && this.active === active) {
      this.verifyFixes++;
      this.transcript.note(`sending the failure to ${active.name} to fix (${this.verifyFixes}/${VERIFY_FIX_CAP} for this task)`, C.dim);
      return { text: `${body}\n\nFix the cause, then stop; codemax runs the checks again.`, shown: `fix the failing checks (\`${cmd}\`, ${why})` };
    }
    this.pendingShell.push(body);
    this.transcript.note(
      this.config.verifyOnFail === "fix" ? `not sent automatically again (${VERIFY_FIX_CAP} tries for this task) · the output goes with your next message` : "the output goes with your next message · /config → When checks fail → send to the agent",
      C.dimmer,
    );
    return null;
  }

  /** Run the project's checks with a live line under the transcript; Esc stops them. */
  private async runChecks(cmd: string, agent?: AgentId) {
    if (this.verifying) {
      this.transcript.note("the checks are already running", C.dim);
      return null;
    }
    const run = runVerify(cmd, this.cwd);
    this.verifying = { cmd, stop: run.stop };
    const t0 = Date.now();
    const tick = setInterval(() => this.safely("checks", () => this.setWorking(`${pick(G.spinner, Math.floor((Date.now() - t0) / 100))} Running checks · ${cmd} · ${fmtDuration(Date.now() - t0)} · esc to stop`)), 100);
    this.setWorking(`${pick(G.spinner, 0)} Running checks · ${cmd} · esc to stop`);
    this.renderFooter();
    try {
      const res = await run.done;
      if (this.closed) return res;
      const ok = res.code === 0 && !res.stopped;
      // The exit and timing, not the command or its output (both are the project's).
      debugEvent("checks", { exit: res.code, ms: res.ms, stopped: res.stopped || undefined, timedOut: res.timedOut || undefined, outputLines: res.output.split("\n").length });
      const block = this.transcript.agent();
      const status = res.stopped ? `stopped after ${fmtDuration(res.ms)}` : res.timedOut ? `timed out after ${fmtDuration(res.ms)}` : ok ? `passed in ${fmtDuration(res.ms)}` : `failed (exit ${res.code}) after ${fmtDuration(res.ms)}`;
      block.tool(`checks-${t0}`, `Checks · $ ${cmd} · ${status}`, ok ? "completed" : "failed", ok ? undefined : tail(res.output, 15) || "(no output)");
      // The next agent's resume packet shows whether the work passed its checks.
      const rec = new TurnRecorder(this.ledger.journal, agent ?? this.active?.agent ?? "claude");
      rec.tool(`checks-${t0}`, { title: `checks: $ ${cmd}`, kind: "execute", status: ok ? "completed" : "failed", output: tail(res.output, 60) });
      rec.end("end_turn");
      return res;
    } finally {
      clearInterval(tick);
      this.verifying = null;
      this.setWorking(null);
      this.renderFooter();
    }
  }

  /** /verify: run the checks now · /verify <command> sets them for this project · /verify off. */
  private async verifyCommand(arg: string) {
    const a = arg.trim();
    const cur = this.config.verify?.[this.cwd];
    if (a === "off") {
      this.setVerify(null);
      return this.transcript.note("checks after edits: off for this project");
    }
    if (a) {
      this.setVerify(a);
      return this.transcript.note(`checks after edits: \`${a}\` runs after each turn that changes files · /verify off to stop`);
    }
    if (!cur) {
      const found = verifyCandidates(this.cwd);
      return this.transcript.note(found.length ? `no checks set for this project · /config → Checks after edits, or /verify <command> (found: ${found.join(" · ")})` : "no checks set for this project · /verify <command>, e.g. /verify npm test", C.warn);
    }
    if (this.active?.turn) return this.transcript.note("the agent is working; the checks run when it finishes a turn that changes files", C.warn);
    const res = await this.runChecks(cur);
    if (res && res.code !== 0 && !res.stopped) this.pendingShell.push(`[codemax checks] \`${cur}\` failed (exit ${res.code}). Output (end):\n${tail(res.output, 120).slice(-6000)}`);
  }

  private setVerify(cmd: string | null) {
    const map = { ...(this.config.verify ?? {}) };
    if (cmd) map[this.cwd] = cmd;
    else delete map[this.cwd];
    this.config.verify = map;
    saveConfigKey("verify", map);
  }

  private pushHistory(text: string) {
    if (this.history.at(-1) !== text) {
      this.history.push(text);
      appendHistory(this.cwd, text);
    }
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
      { name: "/undo", description: "Revert the files changed by the last agent turn", run: () => this.safelyAsync("undo", this.undo()) },
      { name: "/rewind", description: "Put the files back to before an earlier message (Esc twice)", run: () => this.safelyAsync("rewind", this.openRewind()) },
      { name: "/verify", description: "Run this project's checks now · /verify <command> sets them · /verify off", run: (a) => void this.verifyCommand(a) },
      { name: "/checkpoints", description: "List working-tree snapshots taken before each turn", run: () => void this.showCheckpoints() },
      { name: "/ask", description: "Send one message to another agent without switching: /ask codex <msg>", run: (a) => void this.ask(a) },
      { name: "/debate", description: "2-3 agents each propose a plan, argue it out, and a judge merges the best: /debate <goal>", run: (a) => this.openDebate(a) },
      { name: "/budget", description: "Today's spend against your daily budgets", run: () => this.showBudget() },
      { name: "/update", description: "Update codemax to the latest version", run: () => void this.runUpdate() },
      { name: "/config", description: "Settings: theme, keep awake, side agent and model, handoffs, checkpoints…", run: () => this.openConfig() },
      { name: "/editor", description: "Write your message in your editor ($EDITOR) · also Ctrl+G", run: () => void this.composeInEditor() },
      { name: "/copy", description: "Copy the last reply to the clipboard · /copy 2 for the one before", run: (a) => void this.copyLastReply(a) },
      { name: "/export", description: "Save this conversation as Markdown · /export <path> to choose where", run: (a) => this.exportThread(a) },
      { name: "/setup", description: "Go through every setting one by one, as on first run", run: () => void this.runOnboarding() },
      { name: "/awake", description: "Keep the machine awake while agents work: /awake on | lid | off", run: (a) => void this.setAwake(a) },
      { name: "/debug", description: "Debug log of what codemax did not expect (never your chat): /debug on | off | export", run: (a) => this.debugCommand(a) },
      { name: "/theme", description: `Colours: /theme ${COLOR_THEMES.map((t) => t.id).join(" | ")}, or dark | light | auto (saved)`, run: (a) => this.setThemePref(a) },
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
      this.transcript.note(`awake: ${s.mode}${s.lid ? " (lid closed included)" : ""} · /awake on keeps the machine and screen awake (no screen saver) · /awake lid also keeps working with the lid closed · /awake off`);
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

  /** /theme: dark | light | auto, or a colour theme (codemax, claude, ocean, teal, mono). Saved, and applied at once. */
  private setThemePref(arg: string) {
    const v = arg.trim().toLowerCase();
    const save = (k: "theme" | "colors", val: any) => {
      try {
        saveConfigKey(k, val);
      } catch {
        /* read-only home: still applies for this run */
      }
    };
    if (isColorTheme(v)) {
      this.config.colors = v;
      save("colors", v);
      applyTheme(THEME, v);
    } else if (v === "dark" || v === "light" || v === "auto") {
      this.config.theme = v;
      save("theme", v);
      if (v !== "auto") applyTheme(v, COLORS);
    } else {
      const now = COLOR_THEMES.find((t) => t.id === COLORS)!;
      this.transcript.note(`colours: ${now.name} (${this.config.theme ?? "auto"}) · /theme ${COLOR_THEMES.map((t) => t.id).join(", ")} · or /theme dark, light, auto`);
      return;
    }
    this.recolor();
    const name = COLOR_THEMES.find((t) => t.id === COLORS)!.name;
    this.transcript.note(`colours: ${name}, ${THEME} · the prompt, footer and new lines use it now; earlier lines keep theirs until a restart`, C.accent);
  }

  /** Repaint what stays on screen (prompt, spinner, panels, footer) in the colours just applied. */
  private recolor() {
    this.safely("theme", () => {
      this.inputWrap.borderColor = this.shellLook ? C.accent : C.promptBorder;
      this.promptGlyph.fg = this.shellLook ? C.accent : C.dim;
      (this.input as any).placeholderColor = C.dim;
      this.working.fg = C.dim;
      this.tasks.set(this.tasks.current);
      this.renderQueue();
      this.renderFooter();
      this.showUpdateBadge();
    });
  }

  private async command(line: string) {
    const [raw, ...rest] = line.split(/\s+/);
    const name = raw!.toLowerCase();
    // The command's name only: what follows it can be the user's own words.
    debugEvent("command", { name: name.slice(0, 40), builtin: this.builtins().some((x) => x.name === name) || undefined, args: rest.length || undefined });
    const b = this.builtins().find((x) => x.name === name || x.name === name.replace(/^\/(exit|q)$/, "/quit"));
    if (b) return b.run(rest.join(" "));
    // /<agent>:<cmd> runs the active agent's own command even when codemax has one of that name.
    const ns = name.match(/^\/([a-z]+):(.+)$/);
    if (ns && this.active && ns[1] === this.active.agent && this.active.commands.some((c) => c.name === ns[2])) {
      const forward = `/${ns[2]}${rest.length ? " " + rest.join(" ") : ""}`;
      if (this.active.turn) return this.enqueue(forward);
      return this.send(this.active, forward);
    }
    if (name === "/exit" || name === "/q") return this.quit();
    if (this.active?.commands.some((c) => `/${c.name}` === name)) {
      if (this.active.turn) {
        this.enqueue(line);
        return;
      }
      return this.send(this.active, line);
    }
    this.transcript.note(`Unknown command: ${name}`, C.warn);
  }

  private runCommandValue(value: string, args: string) {
    if (value.startsWith("builtin:")) return this.builtins().find((b) => b.name === value.slice(8))?.run(args);
    if (value.startsWith("agentcmd:")) {
      const name = value.slice(9);
      // A name codemax also uses goes through /<agent>:<name> so the agent's own command runs.
      const clash = this.builtins().some((b) => b.name === `/${name}`) && this.active;
      return this.command(`/${clash ? `${this.active!.agent}:` : ""}${name}${args ? " " + args : ""}`);
    }
  }

  private pendingShell: string[] = [];
  private tasks: TaskPanel;
  private chatRoot!: BoxRenderable;
  /** `codemax --resume`: the full-screen thread list (the chat is hidden meanwhile). */
  private threadPicker: ThreadPicker | null = null;
  private promptGlyph: TextRenderable;
  /** The prompt is drawn in "!" shell mode (changed only when that flips, not on every key). */
  private shellLook = false;
  /** An agent is starting (launch), or a message is being prepared (send): new messages queue. */
  private starting = false;
  private sending = false;
  /** A running `!` command (stopped by Esc and on quit). */
  private shellRun: { stop: () => void } | null = null;
  /** Agents started for a moment (to list their models): closed on quit. */
  private tempEngines = new Set<Engine>();

  /** `!cmd`: run locally, show output, and attach it to the next prompt as context. */
  private async shell(cmd: string) {
    if (!cmd) return;
    if (this.shellRun) return this.transcript.note("a ! command is still running · Esc stops it", C.warn);
    this.transcript.user(`! ${cmd}`);
    // Bounded like the checks: the last 200 KB of output, a 10-minute limit, Esc or quitting stops it.
    const run = runVerify(cmd, this.cwd, VERIFY_TIMEOUT_MS, { ci: false });
    this.shellRun = run;
    this.setFlash(`running ! ${cmd.slice(0, 40)} · esc to stop`);
    const r = await run.done.finally(() => (this.shellRun = null));
    if (this.closed) return;
    const code = r.code;
    const end = r.stopped ? "stopped" : r.timedOut ? "timed out after 10 min" : "";
    const body = `${r.output || "(no output)"}${end ? `\n(${end})` : ""}`;
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
        this.transcript.note(`model: ${displayModelName(id, a.engine.info?.models)}`);
        if (a.agent === "cursor") this.transcript.note("Cursor saves this as its default model, so Cursor uses it outside codemax too", C.warn);
        this.renderFooter();
      } catch (e: any) {
        this.transcript.error(`could not switch model: ${e?.message ?? e}`);
      }
    };
    if (arg) return void apply(arg);
    // Antigravity's ACP server offers only Gemini on a Google sign-in; the models its own app
    // adds (Claude, GPT-OSS) are listed, greyed, with where to use them.
    if (a.agent === "antigravity" && !this.agyChecked) {
      this.agyChecked = true;
      void this.agyOnly(models).then((extra) => {
        this.agyExtra = extra;
        if (this.active === a) this.openModels("");
      });
      return;
    }
    const extra = a.agent === "antigravity" ? this.agyExtra : [];
    this.closePalette();
    this.paletteKind = "modes";
    this.palette = new Palette(this.renderer, {
      title: extra.length ? `Model for ${a.name} · greyed ones: its ACP server offers only Gemini on a Google sign-in` : `Model for ${a.name}`,
      // The agent's own list, newest first, by its display name (e.g. "Opus 5.5" for the id "opus").
      items: [
        ...sortModels(models).map((m, i) => ({ label: `${m.name}${m.id === a.engine.info?.currentModel ? "  (current)" : ""}`, value: m.id, weight: 1000 - i })),
        ...extra.map((m, i) => ({ label: m.name, description: "codemax --tui --agent antigravity (its own app)", value: m.id, disabled: true, weight: 100 - i })),
      ],
      onPick: (it) => {
        this.closePalette();
        void apply(it.value);
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  /** Antigravity: the models its own CLI lists that its ACP server does not offer (swapped in tests). */
  agyOnly: (acp: { id: string }[]) => Promise<{ id: string; name: string }[]> = (acp) => agyOnlyModels(acp);
  private agyChecked = false;
  private agyExtra: { id: string; name: string }[] = [];

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
    let saved = false;
    try {
      const stop = await a.engine.prompt(prompt);
      const text = block.text().trim();
      if (stop === "end_turn" && text.length > 40) {
        this.ledger.writeSummary(`_${a.name}, ${new Date().toISOString().slice(0, 16).replace("T", " ")}_\n\n${text}`);
        block.footer("summary saved · used in every handoff");
        saved = true;
      } else block.footer("no summary saved");
    } catch (e: any) {
      block.footer(`no summary saved: ${e?.message ?? e}`);
    } finally {
      // Never leave the agent marked busy: everything typed afterwards would queue forever.
      a.turn = null;
      this.stopSpinner();
    }
    // Messages typed during the summary were queued: send them now (a quiet summary before a
    // switch leaves them for the next agent, whose start sends them).
    if (!o.quiet && this.active === a) await this.drainQueue(a);
    return saved;
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
    // Plan limits, as the agents report them (Claude Code's own /usage is terminal-only, so this is where it shows).
    const label: Record<string, string> = { five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet", overage: "extra usage", seven_day_overage_included: "weekly incl. extra" };
    for (const [agent, m] of this.planLimits) {
      const parts = [...m].map(([w, v]) => `${label[w] ?? w} ${typeof v.usedPercent === "number" ? `${Math.round(v.usedPercent)}%` : v.status ?? "?"}${v.status === "rejected" ? " (used up)" : ""}${v.resetsAt ? ` · resets ${fmtDateTime12(v.resetsAt)}` : ""}`);
      this.transcript.note(`${getAdapter(agent).name} plan: ${parts.join("; ")}`, C.accent);
    }
    if (!this.planLimits.size) this.transcript.note("plan limits appear here once an agent reports them (Claude Code does after a turn)");
  }

  private showStatus() {
    const a = this.active;
    const lines = [
      `agent: ${a ? `${a.name}${a.engine.info?.currentModel ? ` · ${displayModelName(a.engine.info.currentModel, a.engine.info.models)}` : ""}` : "none"}`,
      `session: ${a?.engine.session?.id ?? "-"}  mode: ${a?.mode ?? "-"}`,
      `thread: ${this.ledger.threadId} (codemax --resume ${this.ledger.threadId}) · ${this.ledger.turns().length} turns · ${this.ledger.threadDir}`,
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
      // An agent command that shares a built-in's name stays reachable as /<agent>:<name>.
      ...(this.active?.commands ?? []).map((c) => {
        const clash = builtinNames.has(`/${c.name}`);
        const label = clash ? `/${this.active!.agent}:${c.name}` : `/${c.name}`;
        return { label, description: `${c.description ?? `${this.active!.name} command`}${clash ? ` (${this.active!.name}'s own /${c.name})` : ""}`, value: `agentcmd:${c.name}` };
      }),
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
      const installable = a.id === "antigravity" && !!d?.installed && !d.engine;
      if (!d?.installed) bits.push(d?.problem ? "found but does not run" : "not installed");
      else if (installable) bits.push(`${d.version ?? ""} · Enter to install Google's ACP server for it (about 110 MB, once)`.replace(/^ · /, ""));
      else if (!d.engine) bits.push("no protocol · use codemax --tui");
      else {
        if (d.version) bits.push(d.version);
        bits.push(s ? `session ${ago(s.lastUsedAt)}` : "new session");
        if (q && quotaLabel(q)) bits.push(quotaLabel(q));
        if (NO_PERMISSION_PROMPTS.has(a.id)) bits.push("acts without asking");
      }
      return { label: a.name + (a.id === this.active?.agent ? " (current)" : ""), description: bits.join(" · "), value: a.id, disabled: !usable && !installable };
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
        if (id === "antigravity" && !this.detect.get(id)?.engine) return void this.offerAntigravityInstall();
        void this.switchTo(id, false);
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
    const p = this.palette;
    void this.refreshDetect().then(() => this.palette === p && p.setItems(this.switchItems()));
  }

  /**
   * Antigravity CLI has no ACP mode; Google's ACP server for it is a separate download
   * (from the ACP registry, dl.google.com only). Ask first, with the size, then install and switch.
   */
  private async offerAntigravityInstall() {
    let plan: InstallPlan;
    try {
      plan = await antigravityInstallPlan();
    } catch (e: any) {
      return this.transcript.error(`Antigravity: ${e?.message ?? e}`);
    }
    if (this.closed) return;
    const size = plan.bytes ? `${Math.round(plan.bytes / 1e6)} MB` : "about 110 MB";
    this.closePalette();
    this.paletteKind = "modes";
    this.palette = new Palette(this.renderer, {
      title: `Antigravity needs Google's ACP server (${plan.version}, ${size} from dl.google.com) · it signs in with your Google account`,
      items: [
        { label: "Download and switch", description: `into ~/.codemax/agents/antigravity-acp/${plan.version}`, value: "yes" },
        { label: "Not now", description: "stay on the current agent", value: "no" },
      ],
      onPick: (it) => {
        this.closePalette();
        if (it.value === "yes") void this.installAntigravity(plan);
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  private async installAntigravity(plan: InstallPlan) {
    this.setWorking(`${pick(G.spinner, 0)} Installing Antigravity's ACP server…`);
    try {
      await installAntigravityServer(plan, (m) => this.transcript.note(m, C.dim));
      this.transcript.note(`Antigravity ACP server ${plan.version} installed`, C.ok);
      await this.refreshDetect();
      this.setWorking(null);
      if (!this.closed) await this.switchTo("antigravity", false);
    } catch (e: any) {
      this.setWorking(null);
      this.transcript.error(`could not install the Antigravity ACP server: ${e?.message ?? e}`);
    }
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

  /** True while text in the prompt is only filtering a picker; it is cleared when the picker closes. */
  private paletteFiltered = false;

  private closePalette(_focus = true) {
    this.palette?.destroy();
    this.palette = null;
    this.paletteKind = null;
    if (this.paletteFiltered) this.input.clear();
    this.paletteFiltered = false;
    this.input.focus();
  }

  /**
   * The running cost total an agent last reported for a session, so a resumed session's total
   * counts only what it adds now. Older records kept only the figure (then the total itself, the
   * bug this replaces), so the largest one is the best guess.
   */
  private costBaseline(agent: AgentId, sessionId: string): number | undefined {
    let best: number | undefined;
    try {
      for (const r of this.ledger.usage()) {
        if (r.agent !== agent || r.sessionId !== sessionId) continue;
        const v = r.agentTotalUsd ?? r.agentCostUsd;
        if (typeof v === "number" && (best === undefined || v > best)) best = v;
      }
    } catch {
      /* no usage yet */
    }
    return best;
  }

  /** /debug on | off | export [path]: the debug log (src/core/debuglog.ts). */
  private debugCommand(arg: string) {
    const [sub, ...rest] = arg.trim().split(/\s+/);
    const v = (sub ?? "").toLowerCase();
    if (v === "on" || v === "off") {
      const on = v === "on";
      this.config.debugLog = on;
      try {
        saveConfigKey("debugLog", on);
      } catch {
        /* read-only home: this run only */
      }
      setDebugLog(on);
      if (on) {
        debugEvent("debug-on", this.debugInfo());
        this.startHealth();
        if (!this.perf) this.perf = new PerfLog(this.renderer, () => ({ palette: this.palette ? this.paletteKind : undefined, transcriptRows: this.transcript.box.getChildren().length, working: !!this.active?.turn, agent: this.active?.agent }));
      }
      this.transcript.note(on ? `debug log on: errors and odd behaviour go to ${debugLogPath()} · never your messages or replies, but error lines can name files, paths and commands, or quote a line of code · /debug export makes a file to send` : "debug log off (what it has stays until /debug export or you delete it)", on ? C.accent : C.dim);
      return;
    }
    if (v === "export") {
      try {
        const path = exportDebugLog(this.debugInfo(), rest.length ? resolve(this.cwd, rest.join(" ")) : undefined);
        this.copyText(path);
        this.transcript.note(`debug log saved to ${path} (path copied) · no messages or replies, but error lines in it can name your files and commands or quote a line of code: skim it before sending`, C.ok);
      } catch (e: any) {
        this.transcript.error(`could not export the debug log: ${e?.message ?? e}`);
      }
      return;
    }
    this.transcript.note(`debug log is ${debugLogOn() ? "on" : "off"} · /debug on, /debug off, /debug export [file]`);
  }

  /** What codemax and this machine are, for a debug report: versions and settings, never content. */
  private debugInfo(): Record<string, unknown> {
    const os = require("node:os") as typeof import("node:os");
    const agents = Object.fromEntries([...this.detect.entries()].map(([id, d]) => [id, d.installed ? d.version ?? "installed" : "not installed"]));
    const c = this.config;
    return {
      codemax: VERSION,
      os: `${process.platform} ${os.release()} ${process.arch}`,
      bun: process.versions.bun,
      terminal: process.env.TERM_PROGRAM ? `${process.env.TERM_PROGRAM} ${process.env.TERM_PROGRAM_VERSION ?? ""}`.trim() : process.env.TERM ?? "unknown",
      screen: `${this.renderer.width}x${this.renderer.height}`,
      agents,
      active: this.active ? `${this.active.agent} ${this.active.engine.info?.currentModel ?? ""}`.trim() : "none",
      settings: { order: c.order, theme: c.theme, colors: c.colors, questions: c.questions, narrate: c.narrate, autoSwitch: c.autoSwitch, sideAgent: c.sideAgent?.agent ?? null, awake: c.awake, checkpoints: c.checkpoints },
    };
  }

  /** NARRATE for agents that lack it (everyone but Claude Code), unless /config turned it off. */
  private narration(agent: AgentId): string | undefined {
    return agent !== "claude" && this.config.narrate !== false ? NARRATE : undefined;
  }

  private async cycleMode() {
    const a = this.active;
    if (!a?.engine.setMode) return this.setFlash("this agent has no permission modes");
    const ids = (a.engine.info?.modes ?? []).map((m) => m.id);
    // Claude Code's order first, then the agent's own modes (Antigravity's auto_edit, Codex's…).
    const order = [...MODE_CYCLE.filter((m) => ids.includes(m)), ...ids.filter((m) => !MODE_CYCLE.includes(m) && !NO_CYCLE.has(m))];
    if (order.length < 2) return this.setFlash(order.length ? "this agent has one permission mode here · /mode lists them" : "this agent has no permission modes");
    const from = a.mode ?? "";
    const next = order[(order.indexOf(from) + 1) % order.length]!;
    // Shown at once: the next Shift+Tab moves on from here, not from the mode the agent last confirmed.
    a.mode = next;
    this.renderFooter();
    try {
      await a.engine.setMode(next);
    } catch (e: any) {
      if (a.mode === next) a.mode = from;
      this.renderFooter();
      this.setFlash(`could not switch mode: ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }

  // ---------- engine lifecycle ----------

  private async launch(agent: AgentId, o: { fresh: boolean; from?: AgentId; reason?: string; model?: string }) {
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
    // Agent output never reaches the terminal raw (see safeText).
    active.unsubscribe = engine.onEvent((e) => this.onEngineEvent(active, safeDeep(e)));
    this.active = active;
    this.tasks.clear();
    this.showUpdateBadge(); // limits are per agent
    this.starting = true;
    this.setWorking(`${pick(G.spinner, 0)} Starting ${adapter.name}…`);
    try {
      const startedAt = Date.now();
      const info = await engine.start({ cwd: this.cwd, resume, questions: this.config.questions !== "off", instructions: this.narration(agent), costBaseline: resume ? this.costBaseline(agent, resume.id) : undefined });
      debugEvent("agent-start", { agent, ms: Date.now() - startedAt, resumed: !!resume && engine.session?.id === resume.id, resumeAsked: !!resume || undefined, handoffFrom: o.from, version: this.detect.get(agent)?.version ?? info.version, model: info.currentModel, models: info.models?.length, modes: info.modes?.map((m) => m.id), mode: info.currentMode, options: info.options?.map((x) => x.id) });
      active.mode = info.currentMode;
      if (engine.session) this.ledger.saveSession({ agent, id: engine.session.id, cwd: this.cwd, startedAt: engine.session.startedAt, lastUsedAt: Date.now() } as SessionRef);
      this.ledger.addEvent({ kind: o.from ? "switch" : "start", agent: o.from, to: agent, detail: o.reason });
      const resumed = !!resume && engine.session?.id === resume.id;
      active.replay = null;
      const version = this.detect.get(agent)?.version ?? info.version;
      const model = info.currentModel ? ` · ${displayModelName(info.currentModel, info.models)}` : "";
      this.transcript.divider(`${adapter.name}${version ? ` ${version}` : ""}${model} · ${resumed ? "resumed" : "new session"}`);
      if (NO_PERMISSION_PROMPTS.has(agent)) this.transcript.note(grokPermissionNote() ?? `${adapter.name} acts without asking permission`, C.warn);
      else if (EDITS_WITHOUT_ASKING.has(agent)) this.transcript.note(`${adapter.name} edits files without asking (it asks only before shell commands), so its edits come without a prompt or diff here · /undo or Esc Esc puts the files back`, C.warn);
      else {
        const loose = selfApprovingMode(info.currentMode, info.modes);
        if (loose) this.transcript.note(`${adapter.name} starts in ${loose.what} mode (its own settings): ${loose.effect}, so you won't see those prompts or their diffs. Shift+Tab or /mode to switch${loose.ask ? ` to "${loose.ask}"` : ""}.`, C.warn);
      }
      // The handoff order's model for this agent: on a handoff, and on a new session (a
      // resumed one keeps whatever model you chose there).
      const want = o.model ?? (resumed ? undefined : this.chainEntry(agent)?.model);
      if (want && engine.setModel && info.currentModel !== want) {
        try {
          await engine.setModel(want);
          this.transcript.note(`using ${displayModelName(want, info.models)} (handoff order)`);
        } catch (e: any) {
          this.transcript.note(`could not use ${displayModelName(want, info.models)} on ${adapter.name} (${String(e?.message ?? e).slice(0, 120)}); staying on ${displayModelName(info.currentModel, info.models)}`, C.warn);
        }
      }
      this.setWorking(null);
      this.renderFooter();
      this.setTitle();
      this.term.started(agent, adapter.name, engine.session?.id);
      // Only brief the agent when there is something to hand over: a brief with
      // nothing in it costs a turn (and quota) for no context.
      const hasHistory = this.ledger.turns().length > 0 || this.ledger.journal.steps().some((s) => s.kind === "user");
      if (hasHistory) {
        const input = { ledger: this.ledger, cwd: this.cwd, to: agent, from: o.from, reason: o.reason, config: this.config };
        // A resumed session already remembers its own work: tell it only what others did since.
        const catchup = resumed ? await buildCatchup(input) : null;
        const packet = resumed ? catchup : await buildBrief(input);
        if (this.closed || this.active !== active) {
          if (this.active !== active) return;
          this.starting = false;
          return;
        }
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
      // Ready: what you typed meanwhile goes now, in order.
      this.starting = false;
      await this.drainQueue(active);
    } catch (e: any) {
      this.starting = false;
      this.setWorking(null);
      debugEvent("agent-start-failed", { agent, version: this.detect.get(agent)?.version, ...errorFields(e) });
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

  private async runTurn(active: Active, text: string, o: { record?: boolean; rec?: TurnRecorder; journal?: boolean; images?: PromptImage[]; onReply?: (reply: string) => void } = {}): Promise<{ stop: StopReason; edited: boolean } | undefined> {
    if (this.closed) return;
    const block = this.transcript.agent();
    const rec = o.journal === false ? undefined : (o.rec ?? new TurnRecorder(this.ledger.journal, active.agent));
    active.turn = { block, tools: new Set(), startedAt: Date.now(), tokens: 0, chars: 0, verb: pick(VERBS), rec, stats: { lastAt: Date.now(), maxGapMs: 0, events: 0, textChunks: 0, thoughtChunks: 0, tools: {}, failedTools: 0, permissions: { asked: 0, allowed: 0, denied: 0 }, questions: 0, subagents: 0, inTokens: 0, outTokens: 0, costUsd: 0 } };
    debugEvent("turn-start", { agent: active.agent, side: this.side.has(active) || undefined, handoff: o.record === false || undefined, images: o.images?.length || undefined, promptChars: text.length });
    this.startSpinner(active);
    this.setTitle(`✳ ${active.name} working`);
    const main = !this.side.has(active);
    if (main) this.term.prompt(o.record === false ? "(handoff to " + active.name + ")" : text);
    let stop: StopReason;
    try {
      stop = await active.engine.prompt(text, o.images);
    } catch (e: any) {
      // The agent could not take the turn (not started, gone): never leave it looking busy.
      this.transcript.error(`${active.name}: ${String(e?.message ?? e).slice(0, 300)}`);
      stop = "error";
    }
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
    if (main) this.subagents.endAll();
    if (main && active === this.active) {
      const done = this.tasks.turnEnded();
      if (done && turn) turn.block.tasksDone(done);
    }
    if (main && turn) this.notePanel.setPaused(asksUser(turn.block.text()));
    if (turn && main) this.term.turnEnded({ reply: turn.block.text(), ms: Date.now() - turn.startedAt, error: stop === "error", longMs: this.config.bellAfterSeconds > 0 ? this.config.bellAfterSeconds * 1000 : Infinity });
    // Turns that did not end normally, with how long and how many tools (never what was said).
    if (turn) {
      const st = turn.stats;
      debugEvent("turn-end", {
        agent: active.agent,
        side: this.side.has(active) || undefined,
        model: turn.model ?? active.engine.info?.currentModel,
        stop,
        ms: Date.now() - turn.startedAt,
        firstReplyMs: st?.firstAt ? st.firstAt - turn.startedAt : undefined,
        longestSilenceMs: st?.maxGapMs,
        events: st?.events,
        textChunks: st?.textChunks,
        thoughtChunks: st?.thoughtChunks,
        tools: st?.tools,
        failedTools: st?.failedTools || undefined,
        permissions: st?.permissions.asked ? st.permissions : undefined,
        questions: st?.questions || undefined,
        subagents: st?.subagents || undefined,
        inTokens: st?.inTokens,
        outTokens: st?.outTokens,
        costUsd: st?.costUsd ? Math.round(st.costUsd * 10000) / 10000 : undefined,
        edited: turn.edited || undefined,
      });
    }
    if (turn) {
      const dur = fmtDuration(Date.now() - turn.startedAt);
      const who = `${active.name} · ${this.modelName(active, turn.model)}`;
      block.footer(stop === "cancelled" ? `Interrupted after ${dur} · ${who}` : `${pick(DONE_VERBS, turn.startedAt)} for ${dur} · done ${fmtTime(Date.now())} · ${who}`);
      const reply = block.text().trim();
      o.onReply?.(reply);
      const broken = agentSetupFailure(reply);
      if (isLimitNotice(reply)) turn.rec?.markLimit(reply);
      else if (broken) turn.rec?.markError(`${active.name} could not start its MCP server "${broken.mcpServer}"`);
      turn.rec?.end(stop);
      // The side agent reviews main-agent turns that did work (not /ask, not summaries).
      // A turn that only answers a forwarded note is not reviewed: note → turn → review → note
      // would loop on both plans. Its work is covered by the next review after a user turn.
      if (turn.rec && this.active === active && !this.side.has(active) && !isForwardedNote(text) && !broken && (turn.tools.size > 0 || reply.length > 0)) {
        const every = this.config.sideAgent?.every ?? 1;
        this.turnsSinceReview++;
        if (every > 0 && this.turnsSinceReview >= every) void this.review();
      }
      if (isLimitNotice(reply)) {
        // The agent ended the turn with only a limit notice: treat it as running out, and leave
        // the user's request unanswered in the ledger so the next agent is asked to finish it.
        this.onQuota({ agent: active.agent, exhausted: true, source: "probe", detail: reply.slice(0, 120), resetsAt: parseResetTime(reply), at: Date.now() });
      } else if (broken) {
        // The agent refuses every turn until its own MCP setup works: the request stays
        // unanswered for the next agent, and you get what to do about it.
        const fix = active.agent === "antigravity"
          ? `It is in Antigravity's own setup, not codemax's: \`agy mcp list\` and \`agy mcp disable ${broken.mcpServer}\` (or \`agy plugin list\` / \`disable\`), or open the Antigravity IDE if the server belongs to it, then /switch antigravity.`
          : `Fix or turn off that MCP server in ${active.name}'s own settings, then /switch ${active.agent}.`;
        this.transcript.note(`${active.name} won't work until its MCP server "${broken.mcpServer}" starts (${cleanError(broken.reason).slice(0, 160)}). ${fix}`, C.warn);
        this.broken.add(active.agent);
        if (this.active === active) this.offerHandoff(active.agent, `${active.name} cannot run: its MCP server "${broken.mcpServer}" fails`);
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
    return { stop, edited: !!turn?.edited };
  }

  private onEngineEvent(active: Active, e: EngineEvent) {
    this.safely(`${active.name} event`, () => {
      this.countEvent(active, e);
      this.handleEngineEvent(active, e);
    });
  }

  /** The turn's statistics for the debug log: when things arrived and what kind they were. */
  private countEvent(active: Active, e: EngineEvent) {
    const st = active.turn?.stats;
    if (!st) return;
    const now = Date.now();
    if (e.type === "text_delta" || e.type === "thought_delta" || e.type === "tool_call") st.firstAt ??= now;
    st.maxGapMs = Math.max(st.maxGapMs, now - st.lastAt);
    st.lastAt = now;
    st.events++;
    if (e.type === "text_delta") st.textChunks++;
    else if (e.type === "thought_delta") st.thoughtChunks++;
    else if (e.type === "tool_call") st.tools[e.kind ?? "other"] = (st.tools[e.kind ?? "other"] ?? 0) + 1;
    else if (e.type === "tool_update" && e.status === "failed") st.failedTools++;
    else if (e.type === "permission_request") st.permissions.asked++;
    else if (e.type === "question_request") st.questions++;
    else if (e.type === "subagent" && e.status === "running") st.subagents++;
    else if (e.type === "usage") {
      st.inTokens += (e.inputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheWriteTokens ?? 0);
      st.outTokens += e.outputTokens ?? 0;
      st.costUsd += e.costUsd ?? 0;
    }
  }

  private handleEngineEvent(active: Active, e: EngineEvent) {
    if (this.active !== active && !this.side.has(active) && e.type !== "permission_request" && e.type !== "question_request") return;
    const target = () => active.turn?.block ?? (active.replay ??= this.transcript.agent());
    switch (e.type) {
      case "text_delta":
        if (active.turn) {
          active.turn.chars += e.text.length;
          active.turn.step = undefined; // it is talking, not on a tool
        }
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
        // A live turn of the agent you talk to pins its plan above the prompt; replays keep it in the transcript.
        if (active === this.active && active.turn) this.tasks.set(e.entries);
        else target().plan(e.entries);
        break;
      case "tool_call":
        active.turn?.tools.add(e.title.split(/[\s(]/)[0] ?? e.title);
        if (active.turn && (/^(edit|delete|move|fileChange)$/.test(e.kind ?? "") || e.files?.length && e.kind !== "read" && e.kind !== "search")) active.turn.edited = true;
        active.turn?.rec?.tool(e.id, { title: e.title, kind: e.kind, status: e.status, input: e.input, output: e.output, files: e.files });
        target().tool(e.id, e.title, e.status, e.detail, e.kind);
        if (active.turn) active.turn.step = e.title;
        if (e.status === "completed" && this.active === active) this.term.toolDone(e.title);
        break;
      case "tool_update":
        active.turn?.rec?.tool(e.id, { title: e.title, status: e.status, input: e.input, output: e.output, files: e.files });
        if (e.status === "completed" && this.active === active) this.term.toolDone(e.title ?? "tool");
        target().toolUpdate(e.id, e.status, e.title, e.detail);
        if (active.turn && e.title && e.status !== "completed" && e.status !== "failed") active.turn.step = e.title;
        break;
      case "permission_request":
        // A debate only plans: whatever a debater asks to do is refused.
        if (this.debate?.actives.includes(active)) {
          const reject = e.request.options.find((o) => o.kind.startsWith("reject"))?.id ?? e.request.options.at(-1)!.id;
          active.engine.answerPermission(e.request.id, reject);
          this.transcript.note(`${active.name} asked to ${e.request.title.slice(0, 80)}: refused (a debate only plans)`, C.dim);
          break;
        }
        this.permissionQueue.push({ request: e.request, engine: active.engine });
        this.showNextPermission();
        break;
      case "subagent":
        if (this.active === active) {
          this.subagents.update(e);
          this.renderFooter();
        }
        break;
      case "question_request":
        if (this.debate?.actives.includes(active)) {
          active.engine.answerQuestion?.(e.request.id, { action: "decline" });
          break;
        }
        this.permissionQueue.push({ question: e.request, engine: active.engine });
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
        if (active.turn && e.model && !/default model$/.test(e.model)) active.turn.model = e.model;
        if (typeof e.contextUsed === "number" && typeof e.contextSize === "number" && e.contextSize > 0) {
          active.context = { used: e.contextUsed, size: e.contextSize };
          this.renderFooter();
        }
        for (const pl of e.planLimits ?? []) {
          const m = this.planLimits.get(active.agent) ?? new Map();
          m.set(pl.window, { usedPercent: pl.usedPercent, resetsAt: pl.resetsAt, status: pl.status, at: Date.now() });
          this.planLimits.set(active.agent, m);
          // A refused window is the plan running out: the handoff offer follows from onQuota.
          if (pl.status === "rejected" || pl.window === "five_hour") this.onQuota({ agent: active.agent, usedPercent: pl.usedPercent, exhausted: pl.status === "rejected", resetsAt: pl.resetsAt, source: "probe", at: Date.now() });
          // Claude Code warns once a window nears its end; so does codemax, once per level, in the transcript too.
          const level = pl.status === "rejected" ? "reached" : limitLevel(pl);
          const key = `${active.agent}:${pl.window}`;
          if (level && this.limitAnnounced.get(key) !== level && !this.side.has(active)) {
            this.limitAnnounced.set(key, level);
            this.transcript.note(`${active.name}: ${limitText(pl)}`, level === "reached" ? C.error : C.warn);
          } else if (!level) this.limitAnnounced.delete(key);
        }
        if (e.planLimits?.length && active === this.active) this.showUpdateBadge();
        if (typeof e.usedPercent === "number") this.onQuota({ agent: active.agent, usedPercent: e.usedPercent, exhausted: e.usedPercent >= 100, source: "probe", at: Date.now() });
        this.recordUsage(active.agent, active.engine, e);
        break;
      }
      case "session":
        if (this.side.has(active)) break; // /ask sessions are throwaway, not resumable
        this.ledger.saveSession({ agent: active.agent, id: e.ref.id, cwd: this.cwd, startedAt: e.ref.startedAt, lastUsedAt: Date.now() } as SessionRef);
        break;
      case "error":
        debugEvent("agent-error", { agent: active.agent, errorKind: e.kind, message: e.message, side: this.side.has(active) || undefined });
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
        if (e.level !== "info") debugEvent("agent-log", { agent: active.agent, level: e.level, message: e.message });
        if (e.level !== "info") this.transcript.note(`${active.name}: ${e.message}`, e.level === "error" ? C.error : C.dim);
        break;
      case "notice": {
        debugEvent("agent-notice", { agent: active.agent, level: e.level, title: e.title });
        // What the agent would show in its own UI ("Retrying Claude, attempt 2 of 10", "Model fallback").
        const text = e.detail ? `${e.title}: ${e.detail}` : e.title;
        // Agents repeat some (Codex sends its config warning per thread): once a minute is enough.
        const key = `${active.agent}:${text}`;
        if ((this.noticeSeen.get(key) ?? 0) > Date.now() - 60_000) break;
        this.noticeSeen.set(key, Date.now());
        this.transcript.note(`${active.name}: ${text}`, e.level === "error" ? C.error : e.level === "warn" ? C.warn : C.dim);
        if (e.level !== "info" && active === this.active) {
          this.promptNotice = { text: `${active.name}: ${e.title}`, level: e.level, until: Date.now() + NOTICE_MS };
          this.showUpdateBadge();
          setTimeout(() => this.showUpdateBadge(), NOTICE_MS + 50);
        }
        break;
      }
      default:
        break;
    }
  }

  private showNextPermission(): void {
    if (this.permission || !this.permissionQueue.length) return;
    const next = this.permissionQueue.shift()!;
    if ("question" in next) return this.showQuestion(next.question, next.engine);
    const { request, engine } = next;
    const name = this.active?.engine === engine ? this.active.name : "the agent";
    this.term.waiting("permission", request.title, request.kind, request.detail ? { detail: request.detail } : undefined);
    const shownAt = Date.now();
    this.permission = new PermissionDialog(this.renderer, request, name, (choice) => {
      this.permission?.destroy();
      this.permission = null;
      const opt = request.options.find((o) => o.id === choice.optionId);
      const fallbackReject = request.options.find((o) => o.kind.startsWith("reject"))?.id ?? request.options[0]!.id;
      engine.answerPermission(request.id, choice.optionId ?? fallbackReject);
      const allowed = !!opt && opt.kind.startsWith("allow");
      const st = this.active?.engine === engine ? this.active.turn?.stats : undefined;
      if (st) st.permissions[allowed ? "allowed" : "denied"]++;
      debugEvent("permission", { agent: this.active?.engine === engine ? this.active.agent : undefined, toolKind: request.kind, hasDiff: !!request.diff || undefined, options: request.options.map((o) => o.kind), answer: opt?.kind ?? "reject", waitedMs: Date.now() - shownAt });
      this.term.answered(allowed);
      if (!allowed) this.transcript.note(`declined: ${request.title.length > 70 ? request.title.slice(0, 67) + "…" : request.title}`, C.warn);
      if (choice.tellAgent) {
        this.input.placeholder = `Tell ${name} what to do differently…`;
        setTimeout(() => (this.input.placeholder = this.placeholderText), 15000);
      }
      this.input.focus();
      this.showNextPermission();
    });
    this.dialogHost.add(this.permission.box);
  }

  private showQuestion(q: QuestionRequest, engine: Engine): void {
    const name = this.active?.engine === engine ? this.active.name : "the agent";
    if (!engine.answerQuestion) return this.showNextPermission();
    this.term.waiting("question", q.fields[0]?.question || q.message, "question");
    // Unattended runs: a question nobody answers is skipped so the agent carries on.
    const timer = this.config.questions === "timeout"
      ? setTimeout(() => this.safely("question timeout", () => {
          if (this.permission !== dialog) return;
          this.transcript.note(`no answer for ${QUESTION_TIMEOUT_MS / 60000} minutes: skipped, ${name} carries on`, C.warn);
          dialog.handleKey({ name: "escape", sequence: "\x1b", ctrl: false, meta: false, shift: false } as any);
        }), QUESTION_TIMEOUT_MS)
      : null;
    const dialog = new QuestionDialog(this.renderer, q, name, (answer) => {
      if (timer) clearTimeout(timer);
      this.permission?.destroy();
      this.permission = null;
      engine.answerQuestion!(q.id, answer);
      this.term.answered(answer.action === "accept");
      if (answer.action === "accept") {
        for (const f of q.fields) {
          const v = answer.content[f.key];
          const other = f.otherKey ? answer.content[f.otherKey] : undefined;
          const label = (x: unknown) => f.options.find((o) => o.value === String(x))?.label ?? String(x);
          const shown = [...(Array.isArray(v) ? v.map(label) : v !== undefined ? [f.kind === "boolean" ? (v ? "Yes" : "No") : label(v)] : []), ...(other ? [`"${other}"`] : [])].join(", ");
          this.transcript.note(`${f.title ?? f.question}: ${shown || "(skipped)"}`, C.dim);
        }
      } else this.transcript.note(`skipped ${name}'s question`, C.warn);
      this.input.focus();
      this.showNextPermission();
    });
    this.permission = dialog;
    this.dialogHost.add(dialog.box);
  }

  private onQuota(q: QuotaStatus) {
    const prev = this.quota.get(q.agent);
    this.quota.set(q.agent, q);
    this.ledger.saveQuota(q);
    this.renderFooter();
    if (isExhausted(q) && !isExhausted(prev)) {
      this.ledger.addEvent({ kind: "quota", agent: q.agent, detail: q.detail });
      if (this.config.autoSwitch && !this.debate && (!this.active || this.active.agent === q.agent)) this.offerHandoff(q.agent, `${getAdapter(q.agent).name} is out of quota${q.resetsAt ? ` until ${fmtTime(q.resetsAt)}` : ""}`);
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
      agentTotalUsd: typeof e.agentTotalUsd === "number" ? e.agentTotalUsd : undefined,
      costCovered: e.costCovered || undefined,
    });
    this.ledger.addUsage(rec);
    this.sessionCost += recordCost(rec).usd;
    this.sessionTokens += rec.input + rec.output + rec.cacheRead + rec.cacheWrite;
    addSpend(this.today, rec);
    this.renderFooter();
    this.checkBudget(agent);
  }

  // ---------- side agent ----------

  private async disableSide() {
    await this.closeReviewer();
    this.saveSide({ ...(this.config.sideAgent ?? { forward: "ask" as const }), agent: null, model: undefined });
    this.transcript.note("side agent off", C.dim);
    this.renderFooter();
  }

  private saveSide(v: Config["sideAgent"]) {
    this.config.sideAgent = v;
    try {
      saveConfigKey("sideAgent", v);
    } catch {
      /* read-only home */
    }
  }

  private async enableSide(agent: AgentId, o: { forward: "ask" | "auto"; model?: string; pickModel: boolean; samePlan?: boolean }) {
    const prev = this.config.sideAgent;
    if (prev?.agent !== agent || (o.model && o.model !== prev.model)) await this.closeReviewer();
    // Keep the user's other side-agent settings (review cadence) when switching agent.
    this.saveSide({ ...prev, agent, forward: o.forward, model: o.model ?? (prev?.agent === agent ? prev.model : undefined), samePlan: o.samePlan ?? (prev?.agent === agent ? prev.samePlan : false) });
    const name = getAdapter(agent).name;
    if (agent === this.active?.agent) this.transcript.note(`${name} is also the main agent: both use one ${name} plan, so each review brings the main agent's limit closer. A different subscription (or a cheaper side-agent model, or fewer reviews, in /config) keeps it from running out sooner.`, C.warn);
    this.transcript.note(`side agent: ${name}${this.config.sideAgent.model ? ` (${displayModelName(this.config.sideAgent.model, this.reviewer?.engine.info?.models)})` : ""} reviews ${reviewCadence(this.config.sideAgent.every)} and speaks up only when something needs attention${o.forward === "auto" ? "; its notes go to the main agent automatically" : "; its notes appear above the prompt"}`, C.accent);
    this.renderFooter();
    if (!o.pickModel) return;
    // Start the reviewer now so its real model list can be offered.
    const r = await this.ensureReviewer();
    const models = r?.engine.info?.models ?? [];
    if (!r || models.length < 2) {
      if (r && models.length === 1) this.transcript.note(`${name} offers one model on your plan: ${models[0]!.name}`);
      return;
    }
    this.closePalette();
    this.paletteKind = "modes";
    this.palette = new Palette(this.renderer, {
      title: `Model for the side agent (${name}) · Esc keeps ${displayModelName(r.engine.info?.currentModel, r.engine.info?.models)}`,
      items: sortModels(models).map((m, i) => ({ label: `${m.name}${m.id === r.engine.info?.currentModel ? "  (current)" : ""}`, value: m.id, weight: 100 - i })),
      onPick: (it) => {
        this.closePalette();
        void this.setSideModel(it.value);
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  private async setSideModel(model: string) {
    const cfg = this.config.sideAgent;
    if (!cfg?.agent) return this.transcript.note("no side agent · turn one on in /config", C.warn);
    this.saveSide({ ...cfg, model });
    const r = this.reviewer;
    try {
      if (r?.engine.setModel) await r.engine.setModel(model);
      this.transcript.note(`side agent model: ${displayModelName(model, this.reviewer?.engine.info?.models)}`);
      if (cfg.agent === "cursor") this.transcript.note("Cursor saves this as its default model, so Cursor uses it outside codemax too", C.warn);
    } catch (e: any) {
      this.transcript.error(`could not set the side agent's model: ${e?.message ?? e}`);
    }
    this.renderFooter();
  }

  // ---------- settings (/config) ----------

  private settings(): { key: string; label: string; value: string; choices: { value: string; label?: string; description?: string }[]; apply: (v: string) => void | Promise<void> }[] {
    const c = this.config;
    const onOff = (b: boolean) => (b ? "on" : "off");
    const bool = (key: "autoSwitch" | "summarizeOnSwitch" | "checkpoints" | "priceUpdates") => (v: string) => {
      c[key] = v === "on";
      saveConfigKey(key, c[key]);
    };
    const side = c.sideAgent ?? { agent: null, forward: "ask" as const };
    const agents = listAdapters(c.order).filter((a) => this.detect.get(a.id)?.engine);
    const installed = listAdapters(c.order).filter((a) => this.detect.get(a.id)?.installed && this.detect.get(a.id)?.engine);
    return [
      {
        key: "agent",
        label: "Default agent",
        value: listAdapters(c.order).find((a) => a.id === c.order[0])?.name ?? c.order[0] ?? "claude",
        choices: installed.map((a) => ({ value: a.id, label: a.name, description: this.detect.get(a.id)?.version ? `v${this.detect.get(a.id)!.version}` : undefined })),
        apply: (v) => {
          c.order = [v as AgentId, ...c.order.filter((x) => x !== v)];
          saveConfigKey("order", c.order);
          // The handoff order starts with the default agent too.
          const ch = c.handoffChain;
          const at = ch?.findIndex((e) => e.agent === v) ?? -1;
          if (ch && at > 0) this.saveChain([ch[at]!, ...ch.filter((_, i) => i !== at)]);
        },
      },
      {
        key: "budget",
        label: "Daily budget",
        value: c.budgets?.all ? `$${c.budgets.all} a day` : "none",
        choices: [
          { value: "0", label: "none", description: "no limit on how much you use" },
          ...[5, 10, 20, 50, 100].map((n) => ({ value: String(n), label: `$${n} a day`, description: "all agents together · per-agent budgets: \"budgets\" in config.json" })),
        ],
        apply: (v) => {
          const b = { ...(c.budgets ?? {}) };
          if (Number(v) > 0) b.all = Number(v);
          else delete b.all;
          c.budgets = b;
          saveConfigKey("budgets", b);
        },
      },
      {
        key: "hotkeys",
        label: "Agent menu hotkey",
        value: c.hotkeys.join(" or "),
        choices: [
          { value: "ctrl+/,ctrl+^", label: "ctrl+/ or ctrl+^", description: "either one opens the agent menu" },
          { value: "ctrl+^", label: "ctrl+^", description: "for terminals that keep ctrl+/ for themselves (Warp)" },
          { value: "ctrl+]", label: "ctrl+]" },
        ],
        apply: (v) => {
          c.hotkeys = v.split(",");
          this.hotkeys = parseHotkeys(c.hotkeys);
          saveConfigKey("hotkeys", c.hotkeys);
        },
      },
      { key: "theme", label: "Theme", value: c.theme ?? "auto", choices: [{ value: "auto", description: "follow the terminal's background" }, { value: "dark" }, { value: "light" }], apply: (v) => this.setThemePref(v) },
      { key: "colors", label: "Colours", value: isColorTheme(c.colors) ? c.colors : "codemax", choices: COLOR_THEMES.map((t) => ({ value: t.id, description: `${t.name}: ${t.description}` })), apply: (v) => this.setThemePref(v) },
      { key: "awake", label: "Keep awake", value: c.awake ?? "off", choices: [{ value: "off", description: "sleep normally" }, { value: "on", description: "no sleep, screen saver or lock while codemax runs" }, { value: "lid", description: "also keep working with the lid closed" }], apply: (v) => this.setAwake(v) },
      { key: "side", label: "Side agent", value: side.agent ?? "off", choices: [{ value: "off" }, ...agents.map((a) => ({ value: a.id, label: a.name, description: a.id === this.active?.agent ? "same plan as the main agent: reviews count against its limit · pick its model next" : "its own subscription · pick its model next" }))], apply: (v) => (v === "off" ? this.disableSide() : this.enableSide(v as AgentId, { forward: side.forward, pickModel: true, samePlan: v === this.active?.agent })) },
      { key: "sideSamePlan", label: "Side agent on the main agent's plan", value: side.samePlan ? "allowed" : "never", choices: [{ value: "never", description: "reviews pause while the side agent's tool is also the main agent" }, { value: "allowed", description: "reviews count against the main agent's usage limit" }], apply: (v) => this.saveSide({ ...side, samePlan: v === "allowed" }) },
      { key: "sideModel", label: "Side agent model", value: side.agent ? (side.model ?? "default") : "(no side agent)", choices: side.agent ? [{ value: "pick", label: "Choose from its models", description: "starts the side agent to list them" }] : [], apply: async () => { if (side.agent) await this.enableSide(side.agent, { forward: side.forward, pickModel: true }); } },
      {
        key: "sideEvery",
        label: "Side agent reviews",
        value: reviewCadence(side.every),
        choices: [{ value: "1", label: "every turn" }, { value: "2", label: "every 2nd turn" }, { value: "3", label: "every 3rd turn" }, { value: "5", label: "every 5th turn" }],
        apply: (v) => this.saveSide({ ...side, every: Number(v) }),
      },
      { key: "sideForward", label: "Side agent notes", value: side.forward, choices: [{ value: "ask", description: "show them above the prompt: 1 expand · 2 discuss · 0 dismiss" }, { value: "auto", description: "send each note to the main agent" }], apply: (v) => this.saveSide({ ...side, forward: v === "auto" ? "auto" : "ask" }) },
      {
        key: "autoSwitch",
        label: "At a usage limit",
        value: !c.autoSwitch ? "do nothing" : c.autoHandoff ? "hand off automatically" : "offer a handoff",
        choices: [
          { value: "offer", label: "offer a handoff", description: "the next agent in your handoff order, one Enter away" },
          { value: "auto", label: "hand off automatically", description: "the next agent in your order takes over right away (unattended runs)" },
          { value: "off", label: "do nothing", description: "you switch yourself (/switch)" },
        ],
        apply: (v) => {
          c.autoSwitch = v !== "off";
          c.autoHandoff = v === "auto";
          saveConfigKey("autoSwitch", c.autoSwitch);
          saveConfigKey("autoHandoff", c.autoHandoff);
        },
      },
      {
        key: "chain",
        label: "Handoff order",
        value: c.handoffChain?.length ? c.handoffChain.map((e) => this.entryLabel(e)).join(" → ") : "installed agents, default models",
        choices: [{ value: "edit", label: "Edit the order", description: "which agent (and model) takes over when one hits its limit, first to last" }],
        apply: () => this.openChainEditor(),
      },
      { key: "summarizeOnSwitch", label: "Summary before switching", value: onOff(c.summarizeOnSwitch), choices: [{ value: "on", description: "only for history without a step journal" }, { value: "off" }], apply: bool("summarizeOnSwitch") },
      {
        key: "verify",
        label: "Checks after edits",
        value: c.verify?.[this.cwd] ?? "off",
        choices: [
          { value: "off", description: "or type /verify <command> for any other command" },
          ...[...new Set([...(c.verify?.[this.cwd] ? [c.verify[this.cwd]!] : []), ...verifyCandidates(this.cwd)])].map((cmd) => ({ value: cmd, description: "runs after each turn that changes files (this project)" })),
        ],
        apply: (v) => this.setVerify(v === "off" ? null : v),
      },
      { key: "verifyOnFail", label: "When checks fail", value: c.verifyOnFail === "fix" ? "send to the agent" : "show", choices: [{ value: "show", description: "show the failure; it goes with your next message" }, { value: "fix", label: "send to the agent", description: `the agent fixes it right away (at most ${VERIFY_FIX_CAP} times per task)` }], apply: (v) => { c.verifyOnFail = v === "fix" ? "fix" : "show"; saveConfigKey("verifyOnFail", c.verifyOnFail); } },
      {
        key: "debateRounds",
        label: "Debate rounds",
        value: roundsLabel(c.debateRounds ?? 1),
        choices: [
          ...[1, 2, 3, 5].map((n) => ({ value: String(n), label: roundsLabel(n), description: `${debateCost(2, n)} with two debaters` })),
          { value: "auto", label: roundsLabel("auto"), description: `the judge checks after each round and stops when one plan is clearly better (${UNTIL_SETTLED_MAX} rounds at most)` },
        ],
        apply: (v) => {
          c.debateRounds = v === "auto" ? "auto" : Number(v);
          saveConfigKey("debateRounds", c.debateRounds);
        },
      },
      { key: "checkpoints", label: "Snapshots for /undo", value: onOff(c.checkpoints), choices: [{ value: "on" }, { value: "off", description: "also turns off code diffs in handoffs" }], apply: bool("checkpoints") },
      {
        key: "bell",
        label: "Bell after long turns",
        value: c.bellAfterSeconds ? `${c.bellAfterSeconds}s` : "off",
        choices: [{ value: "0", label: "off" }, { value: "10", label: "10s" }, { value: "20", label: "20s" }, { value: "60", label: "60s" }],
        apply: (v) => {
          c.bellAfterSeconds = Number(v);
          saveConfigKey("bellAfterSeconds", c.bellAfterSeconds);
        },
      },
      { key: "questions", label: "Agent questions", value: c.questions ?? "ask", choices: [{ value: "ask", description: "show the agent's question and wait for your answer" }, { value: "timeout", label: "ask, skip after 5 min", description: "for unattended runs (keep awake): an unanswered question is skipped and the agent carries on" }, { value: "off", description: "agents never ask; they decide themselves (new sessions)" }], apply: (v) => { c.questions = v as Config["questions"]; saveConfigKey("questions", c.questions); } },
      { key: "terminalStatus", label: "Terminal tab status", value: c.terminalStatus === false ? "off" : "on", choices: [{ value: "on", description: "Warp shows the agent's badge and running / waiting / done; other terminals get OSC 7501 status" }, { value: "off" }], apply: (v) => { c.terminalStatus = v === "on"; saveConfigKey("terminalStatus", c.terminalStatus); } },
      { key: "notifications", label: "Desktop notifications", value: c.notifications === false ? "off" : "on", choices: [{ value: "on", description: "when an agent waits for you or a long turn ends, while you are in another window" }, { value: "off" }], apply: (v) => { c.notifications = v === "on"; saveConfigKey("notifications", c.notifications); } },
      { key: "narrate", label: "Agents say what they are doing", value: c.narrate === false ? "off" : "on", choices: [{ value: "on", description: "a short note asks Codex, OpenCode, Cursor, Grok and Antigravity to explain each step, as Claude Code does (new sessions)" }, { value: "off", description: "they work as they would on their own" }], apply: (v) => { c.narrate = v === "on"; saveConfigKey("narrate", c.narrate); } },
      { key: "tips", label: "Tips in the prompt", value: c.tips === false ? "off" : "on", choices: [{ value: "on", description: "a different feature (and when it helps) in the empty prompt after each message" }, { value: "off" }], apply: (v) => { c.tips = v === "on"; saveConfigKey("tips", c.tips); this.rotateTip(); } },
      { key: "debugLog", label: "Debug log", value: c.debugLog === false ? "off" : "on", choices: [{ value: "on", description: "records errors and odd behaviour, never your messages or replies; error lines can name files and commands · /debug export" }, { value: "off" }], apply: (v) => this.debugCommand(v) },
      { key: "updateCheck", label: "Check for codemax updates", value: c.updateCheck === false ? "off" : "on", choices: [{ value: "on", description: "asks npm at most every 12 hours" }, { value: "off" }], apply: (v) => { c.updateCheck = v === "on"; saveConfigKey("updateCheck", c.updateCheck); } },
      { key: "priceUpdates", label: "Weekly price list refresh", value: onOff(c.priceUpdates), choices: [{ value: "on" }, { value: "off", description: "stay fully offline" }], apply: bool("priceUpdates") },
    ];
  }

  /**
   * First-run setup (and /setup): every /config row in turn, each with why it matters. Rows
   * that only matter after an earlier answer (side-agent details, what to do when checks
   * fail) appear only then. The side agent's model is picked later in /config: listing its
   * models means starting it.
   */
  private runOnboarding(): Promise<void> {
    if (this.onboarding) return Promise.resolve();
    const why: Record<string, string> = {
      agent: "The agent codemax starts with. You can switch any time (Ctrl+^ or /switch), and the next one picks up where it left off.",
      chain: "Which agent takes over when one runs out, and on which model: e.g. Claude Code on Opus, then Cursor on Opus, then Antigravity on Gemini Flash. The first one is also where codemax starts.",
      autoSwitch: "When an agent hits its usage limit, the same task can continue in the next agent you pay for: offered (one Enter), automatic, or not at all.",
      budget: "A daily limit on the API-equivalent value of what you use (your subscription is never billed more). At the limit, codemax offers the next agent.",
      theme: "Colours for a dark or a light terminal. Auto reads your terminal's background.",
      colors: "The accent colour codemax draws with: its pink, Claude Code's own colours, blue, teal or plain greys. /theme <name> changes it later.",
      hotkeys: "The keys that open the agent menu from anywhere. Warp keeps ctrl+/ for itself, so pick ctrl+^ there.",
      questions: "Agents like Claude and Codex can stop to ask you something (\"which approach?\") instead of guessing.",
      checkpoints: "A snapshot of your files before each message, so /undo and Esc Esc (rewind) can put them back. It never touches your git branches or index.",
      verify: "Your own test or typecheck command, run after every turn that changes files, so a broken build shows up right away.",
      verifyOnFail: "What happens when those checks fail.",
      debateRounds: "/debate <goal> lets 2-3 agents (each on a model you pick) propose plans, argue them out and merge the best. More rounds argue longer and use more of each plan.",
      side: "A second agent that reads the main agent's work after a turn and points out problems in one short note.",
      sideSamePlan: "Whether reviews may run on the same plan as the main agent (they then count against its limit).",
      sideEvery: "How often the side agent reviews.",
      sideForward: "What happens to the side agent's notes.",
      bell: "A bell when a long turn finishes, so you can look away.",
      terminalStatus: "Show the agent and whether it is running, waiting or done in your terminal's tab (Warp shows the agent's badge).",
      notifications: "A desktop notification when an agent needs you while you are in another window.",
      narrate: "Claude Code tells you what it is about to do and what it found; other agents often just call tools. This asks them to do the same, in a few dozen tokens.",
      tips: "Show a different codemax feature in the empty prompt after each message you send (like /debate, rewind, dropping screenshots), with when it helps.",
      updateCheck: "Tell you when a new codemax is out; /update installs it.",
      priceUpdates: "Refresh the public price list weekly, used to show what your subscription usage would cost on the API.",
      summarizeOnSwitch: "Older histories (without codemax's step record) can be summarised before a switch. New work never needs it.",

      awake: "Last one: keep this machine always on while codemax runs, so long tasks and handoffs keep going when you step away (\"lid\": even with the lid closed). Turn it off any time with /awake off.",
    };
    const order = Object.keys(why);
    const steps = (): OnboardingStep[] => {
      const side = this.config.sideAgent;
      return this.settings()
        .filter((x) => why[x.key] && x.choices.length)
        .filter((x) => !["sideSamePlan", "sideEvery", "sideForward"].includes(x.key) || !!side?.agent)
        .filter((x) => x.key !== "sideSamePlan" || side?.agent === this.config.order[0])
        .filter((x) => x.key !== "verifyOnFail" || !!this.config.verify?.[this.cwd])
        .filter((x) => x.key !== "verify" || x.choices.length > 1)
        .filter((x) => x.key !== "agent" || x.choices.length > 1)
        .map((x) => ({ key: x.key, label: x.key === "awake" ? "Always on (keep this machine awake)" : x.label, why: why[x.key]!, value: x.value, choices: x.key === "chain" ? [...x.choices, { value: x.value, label: `keep: ${x.value}` }] : x.choices }))
        // In the order of `why`: what you need first, the fine print last.
        .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    };
    const apply = async (st: OnboardingStep, v: string) => {
      const row = this.settings().find((x) => x.key === st.key);
      if (!row) return;
      try {
        // The side agent's model is chosen later (/config); listing models starts the agent.
        if (st.key === "chain") {
          // The editor is its own picker: the setup card steps aside until it is done.
          this.onboardingAside = true;
          if (this.onboarding) this.onboarding.box.visible = false;
          try {
            await this.openChainEditor();
          } finally {
            this.onboardingAside = false;
            if (this.onboarding) this.onboarding.box.visible = true;
          }
        } else if (st.key === "side") v === "off" ? this.saveSide({ ...(this.config.sideAgent ?? { forward: "ask" }), agent: null }) : this.saveSide({ ...(this.config.sideAgent ?? { forward: "ask" }), agent: v as AgentId, samePlan: v === this.config.order[0] });
        else await row.apply(v);
      } catch (e: any) {
        this.transcript.error(`could not change ${st.label.toLowerCase()}: ${e?.message ?? e}`);
      }
      this.renderFooter();
    };
    return new Promise<void>((resolve) => {
      this.closePalette();
      const finish = (skipped: boolean, done = true) => {
          debugEvent("setup-finished", { skipped, done });
          this.onboarding?.destroy();
          this.onboarding = null;
          if (done) {
            saveConfigKey("onboarded", true);
            this.config.onboarded = true;
          }
          this.transcript.note(skipped ? "setup skipped: the rest keep their defaults · /setup or /config to change them" : `all set${this.config.sideAgent?.agent ? " · pick the side agent's model in /config" : ""} · /config changes any of it`, C.ok);
          this.input.focus();
          resolve();
      };
      this.endOnboarding = (skipped, done) => {
        this.endOnboarding = null;
        if (this.onboarding) finish(skipped, done);
      };
      this.onboarding = new Onboarding(this.renderer, { steps, apply, onDone: (skipped) => this.endOnboarding?.(skipped) });
      this.dialogHost.add(this.onboarding.box);
    });
  }

  /** Save the handoff order; its first agent is also the default agent. */
  private saveChain(chain: { agent: AgentId; model?: string; modelName?: string }[]) {
    this.config.handoffChain = chain;
    saveConfigKey("handoffChain", chain);
    const first = chain.map((e) => e.agent).filter((a, i, all) => all.indexOf(a) === i);
    this.config.order = [...first, ...this.config.order.filter((a) => !first.includes(a))];
    saveConfigKey("order", this.config.order);
  }

  /**
   * /config → Handoff order: build the list with arrows and Enter. Each entry is an agent and
   * the model to use there (from that agent's own list). Resolves when you are done (Esc).
   */
  private openChainEditor(): Promise<void> {
    return new Promise<void>((done) => {
      const list = () => [...(this.config.handoffChain?.length ? this.config.handoffChain : this.chain().filter((e) => this.detect.get(e.agent)?.installed && this.detect.get(e.agent)?.engine))];
      const show = () => {
        const chain = list();
        this.closePalette();
        this.paletteKind = "modes";
        const items: PaletteItem[] = [
          ...chain.map((e, i) => ({ label: `${i + 1}. ${this.entryLabel(e)}`, description: i === 0 ? "starts first" : "takes over at the limit of the one above", value: `e:${i}` })),
          { label: "+ Add an agent", description: "then pick its model", value: "add" },
          ...(this.config.handoffChain?.length ? [{ label: "Reset", description: "every installed agent, default models", value: "reset" }] : []),
        ].map((it, i) => ({ ...it, weight: 100 - i }));
        this.palette = new Palette(this.renderer, {
          title: "Handoff order · when one agent hits its limit, the next takes over · Enter to change · Esc done",
          items,
          maxRows: 10,
          onPick: (it) => {
            if (it.value === "add") return pickAgent();
            if (it.value === "reset") {
              this.config.handoffChain = [];
              saveConfigKey("handoffChain", []);
              return show();
            }
            entry(Number(it.value.slice(2)));
          },
          onClose: () => {
            this.closePalette();
            if (this.config.handoffChain?.length) this.transcript.note(`handoff order: ${this.config.handoffChain.map((e) => this.entryLabel(e)).join(" → ")}`);
            done();
          },
        }, this.paletteAnchor);
        this.renderer.root.add(this.palette.box);
      };
      const entry = (i: number) => {
        const chain = list();
        const e = chain[i];
        if (!e) return show();
        this.closePalette();
        this.paletteKind = "modes";
        const items: PaletteItem[] = [
          ...(i > 0 ? [{ label: "Move up", value: "up" }] : []),
          ...(i < chain.length - 1 ? [{ label: "Move down", value: "down" }] : []),
          { label: "Change model", description: `now ${e.model ? (e.modelName ?? displayModelName(e.model)) : "its default"}`, value: "model" },
          { label: "Remove", value: "remove" },
        ].map((it, k) => ({ ...it, weight: 100 - k }));
        this.palette = new Palette(this.renderer, {
          title: `${i + 1}. ${this.entryLabel(e)} · Esc back`,
          items,
          onPick: (it) => {
            const next = [...chain];
            if (it.value === "up" || it.value === "down") {
              const j = it.value === "up" ? i - 1 : i + 1;
              [next[i], next[j]] = [next[j]!, next[i]!];
              this.saveChain(next);
              return show();
            }
            if (it.value === "remove") {
              next.splice(i, 1);
              this.saveChain(next);
              return show();
            }
            void pickModel(e.agent, (m) => {
              next[i] = { agent: e.agent, ...m };
              this.saveChain(next);
              show();
            });
          },
          onClose: () => show(),
        }, this.paletteAnchor);
        this.renderer.root.add(this.palette.box);
      };
      const pickAgent = () => {
        this.closePalette();
        this.paletteKind = "modes";
        const agents = listAdapters(this.config.order).filter((a) => this.detect.get(a.id)?.installed && this.detect.get(a.id)?.engine);
        this.palette = new Palette(this.renderer, {
          title: "Add which agent? · Esc back",
          items: agents.map((a, i) => ({ label: a.name, description: list().some((e) => e.agent === a.id) ? "already in the order (another model is fine)" : "", value: a.id, weight: 100 - i })),
          onPick: (it) => void pickModel(it.value as AgentId, (m) => {
            this.saveChain([...list(), { agent: it.value as AgentId, ...m }]);
            show();
          }),
          onClose: () => show(),
        }, this.paletteAnchor);
        this.renderer.root.add(this.palette.box);
      };
      const pickModel = (agent: AgentId, use: (m: { model?: string; modelName?: string }) => void) => this.pickModelFor(agent, use);
      show();
    });
  }

  /** Pick a model from the agent's own list (it is started briefly when it is not the one running). */
  private async pickModelFor(agent: AgentId, use: (m: { model?: string; modelName?: string }) => void) {
    this.closePalette();
    const name = getAdapter(agent).name;
    let models = this.active?.agent === agent ? (this.active.engine.info?.models ?? []) : [];
    if (!models.length) {
      this.setFlash(`asking ${name} for its models…`);
      const engine = this.engineFactory(agent);
      this.tempEngines.add(engine);
      try {
        // An agent that never answers must not hold the editor: 30 s.
        const info = await Promise.race([engine.start({ cwd: this.cwd, questions: false }), Bun.sleep(30_000).then(() => Promise.reject(new Error("no answer in 30 s")))]);
        models = info.models ?? [];
      } catch (e: any) {
        this.transcript.note(`${name} could not list its models (${String(e?.message ?? e).slice(0, 120)}); it will use its default`, C.warn);
      } finally {
        this.tempEngines.delete(engine);
        await engine.close().catch(() => {});
      }
    }
    if (this.closed) return;
    if (models.length < 2) return use({});
    this.paletteKind = "modes";
    this.palette = new Palette(this.renderer, {
      title: `Model on ${name} · Esc for its default`,
      items: [{ label: "Its default model", value: "", weight: 1000 }, ...sortModels(models).map((m, i) => ({ label: m.name, value: m.id, weight: 100 - i }))],
      maxRows: 10,
      onPick: (it) => {
        this.closePalette();
        if (agent === "cursor" && it.value) this.transcript.note("Cursor saves the model it is switched to as its default, so Cursor uses it outside codemax too", C.dim);
        use(it.value ? { model: it.value, modelName: models.find((m) => m.id === it.value)?.name } : {});
      },
      onClose: () => {
        this.closePalette();
        use({});
      },
    }, this.paletteAnchor);
    this.paletteFiltered = true;
    this.renderer.root.add(this.palette.box);
  }

  /** /config: every setting with its value; pick one to change it. */
  private openConfig() {
    const all = this.settings();
    this.closePalette();
    this.paletteKind = "modes";
    this.palette = new Palette(this.renderer, {
      title: `Settings · Enter to change · saved to ${CONFIG_PATH.replace(homedir(), "~")}`,
      // Weights keep the settings in this order (the palette otherwise sorts by label).
      items: all.map((x, i) => ({ label: x.label, description: x.value, value: x.key, disabled: !x.choices.length, weight: 100 - i })),
      maxRows: 12,
      onPick: (it) => {
        const st = all.find((x) => x.key === it.value);
        if (st) this.openSetting(st);
      },
      onClose: () => this.closePalette(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }

  private openSetting(st: ReturnType<ChatApp["settings"]>[number]) {
    this.closePalette();
    this.paletteKind = "modes";
    this.palette = new Palette(this.renderer, {
      title: `${st.label} · now ${st.value} · Esc back to settings`,
      items: st.choices.map((ch, i) => ({ label: ch.label ?? ch.value, description: `${ch.description ?? ""}${(ch.label ?? ch.value) === st.value || ch.value === st.value ? "  (current)" : ""}`, value: ch.value, weight: 100 - i })),
      onPick: (it) => {
        this.closePalette();
        void (async () => {
          try {
            await st.apply(it.value);
            if (!["theme", "awake", "side", "sideModel", "chain"].includes(st.key)) this.transcript.note(`${st.label.toLowerCase()}: ${it.label}`);
          } catch (e: any) {
            this.transcript.error(`could not change ${st.label.toLowerCase()}: ${e?.message ?? e}`);
          }
          this.renderFooter();
          // Back to the list for the next change, unless a follow-up picker took over.
          if (!this.palette) this.openConfig();
        })();
      },
      onClose: () => this.openConfig(),
    }, this.paletteAnchor);
    this.renderer.root.add(this.palette.box);
  }


  /** The side agent's session, started on first use with the chosen model. */
  private async ensureReviewer() {
    const cfg = this.config.sideAgent;
    if (!cfg?.agent || this.closed) return null;
    if (this.reviewer?.agent === cfg.agent) return this.reviewer;
    await this.closeReviewer();
    if (this.checkBlockers(cfg.agent).length) return null;
    const engine = this.engineFactory(cfg.agent);
    const r = { agent: cfg.agent, name: getAdapter(cfg.agent).name, engine, busy: false, pending: false, since: this.lastReviewBaseline(), primed: false };
    this.reviewer = r;
    try {
      // The side agent never interrupts you with questions.
      await engine.start({ cwd: this.cwd, questions: false });
      if (cfg.model && engine.setModel && engine.info?.currentModel !== cfg.model) await engine.setModel(cfg.model).catch((e: any) => this.transcript.note(`side agent: could not use model ${cfg.model} (${e?.message ?? e}); using ${engine.info?.currentModel ?? "its default"}`, C.warn));
      return r;
    } catch (e: any) {
      if (this.reviewer === r) this.reviewer = null;
      this.transcript.note(`side agent ${r.name} could not start: ${e?.message ?? e}`, C.warn);
      return null;
    }
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
    // Reviews never spend the main agent's plan unless you chose that (/config). After a handoff
    // onto the side agent's own tool, they pause instead.
    if (cfg.agent === this.active?.agent && !cfg.samePlan) {
      if (!this.samePlanNoted) this.transcript.note(`side agent paused: ${getAdapter(cfg.agent).name} is now the main agent, so its reviews would use the same plan · pick another side agent, or allow sharing, in /config`, C.dim);
      this.samePlanNoted = true;
      this.turnsSinceReview = 0;
      return;
    }
    this.samePlanNoted = false;
    if (this.reviewer?.busy) {
      this.reviewer.pending = true;
      return;
    }
    const r = await this.ensureReviewer();
    if (!r) return;
    this.turnsSinceReview = 0;
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
        const off = engine.onEvent((raw) => {
          const e = safeDeep(raw);
          try {
          if (e.type === "text_delta") reply += e.text;
          else if (e.type === "permission_request") {
            // A reviewer never acts: refuse anything it asks to do.
            const no = e.request.options.find((o) => /reject|deny|decline/i.test(`${o.kind} ${o.id}`)) ?? e.request.options.at(-1);
            if (no) engine.answerPermission(e.request.id, no.id);
          } else if (e.type === "question_request") {
            // Nor does it interrupt you: its questions are skipped.
            engine.answerQuestion?.(e.request.id, { action: "decline" });
          } else if (e.type === "usage") this.recordUsage(r.agent, engine, e);
          else if (e.type === "error" && e.kind === "quota") limited = true;
          } catch {
            /* a bad event must never break the reviewer or the screen */
          }
        });
        await engine.prompt(prompt).catch(() => "error");
        off();
        if (this.closed) return;
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
    if (this.closed) return;
    this.notes.push({ ts: Date.now(), agent, name, text });
    this.ledger.addEvent({ kind: "note", agent, detail: `side agent note: ${text.slice(0, 2000)}` });
    const main = this.active?.name ?? "the main agent";
    const auto = this.config.sideAgent?.forward === "auto";
    const task = this.ledger.journal.task().request?.id ?? "none";
    const sent = this.autoForwards.get(task) ?? 0;
    const capped = auto && sent >= AUTO_FORWARD_CAP;
    if (auto && !capped) {
      // Only the current task's count matters.
      if (!this.autoForwards.has(task)) this.autoForwards.clear();
      this.autoForwards.set(task, sent + 1);
      this.transcript.noteCard(`⚑ Heads up from ${name} (side agent)`, text, `sent to ${main} automatically`);
      this.forwardNote(this.notes.length - 1);
      return;
    }
    if (capped) this.transcript.note(`auto-forward paused: ${AUTO_FORWARD_CAP} notes already sent for this task`, C.dim);
    this.notePanel.push({ name, text });
  }

  /**
   * The prompt holds only 0, 1 or 2 while a note shows: after a short pause that
   * digit acts on the note (and leaves the prompt). Typing on, before the pause
   * ends, keeps it a normal message, so "2 more tests please" never touches it.
   */
  private armNote(text: string) {
    if (this.noteArmTimer) clearTimeout(this.noteArmTimer);
    this.noteArmTimer = null;
    const k = text;
    // The permission dialog's digits work the same way: alone in the prompt, they answer.
    const dialog = this.permission;
    if (dialog instanceof PermissionDialog && /^[1-9]$/.test(k)) {
      this.noteArmTimer = setTimeout(() => this.safely("permission", () => {
        this.noteArmTimer = null;
        if (this.closed || this.permission !== dialog || this.input.plainText !== k) return;
        this.input.clear();
        dialog.handleKey({ name: k } as KeyEvent);
      }), NOTE_ARM_MS);
      return;
    }
    if (!this.notePanel.count || this.notePanel.isPaused || !/^[012]$/.test(k)) return;
    this.noteArmTimer = setTimeout(() => this.safely("note", () => {
      this.noteArmTimer = null;
      if (this.closed || this.input.plainText !== k || !this.notePanel.count) return;
      this.input.clear();
      this.noteKey(k as "0" | "1" | "2");
    }), NOTE_ARM_MS);
  }

  /** Act on the note shown above the prompt: 1 expand / collapse, 2 discuss, 0 dismiss. */
  private noteKey(k: "0" | "1" | "2") {
    const n = this.notePanel.current;
    if (!n) return;
    if (k === "1") return this.notePanel.toggle();
    this.notePanel.take();
    const { headline } = splitNote(n.text);
    if (k === "0") return this.transcript.note(`dismissed ${n.name}'s note: ${headline}`, C.dim);
    const i = this.notes.findIndex((x) => x.text === n.text);
    this.forwardNote(i >= 0 ? i : this.notes.length - 1);
  }

  private forwardNote(index = this.notes.length - 1) {
    if (this.closed) return;
    const n = this.notes[index];
    const a = this.active;
    if (!n) return this.transcript.note("no side-agent notes yet");
    if (!a) return this.transcript.note("no main agent to forward to", C.warn);
    const msg = forwardMessage(n.text, n.name);
    if (a.turn || this.switching || this.verifying) {
      this.enqueue(msg);
      return;
    }
    void this.send(a, msg);
  }

  /** The model's display name as the agent lists it ("Opus 5.5"), else a short id. */
  private modelName(a: Active, id?: string): string {
    const mid = id ?? a.engine.info?.currentModel;
    return mid ? displayModelName(mid, a.engine.info?.models) : "default model";
  }

  private scheduleUpdateCheck(ms: number) {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      if (this.closed || this.config.updateCheck === false) return;
      void this.updateChecker(VERSION, true)
        .then((v) => v && this.announceUpdate(v))
        .catch(() => {})
        .finally(() => !this.closed && this.scheduleUpdateCheck(ms * 2));
    }, ms);
    (this.updateTimer as any).unref?.();
  }

  private announceUpdate(version: string) {
    if (this.closed || this.updateAvailable === version) return;
    debugEvent("update-available", { current: VERSION, latest: version });
    this.updateAvailable = version;
    this.transcript.note(`codemax ${version} is available (you have ${VERSION}) · run /update to install it`, C.accent);
    this.showUpdateBadge();
    this.renderFooter();
  }

  /**
   * The prompt's top border, at the right, as Claude Code uses that spot: a plan-limit warning
   * first ("You've used 91% of your weekly limit · resets Fri 3:00 PM"), then a notice the
   * agent just raised (for a few seconds), then "↑ codemax 0.1.8 available · /update".
   */
  private showUpdateBadge() {
    this.safely("prompt title", () => {
      this.inputWrap.titleAlignment = "right";
      const limit = this.active ? limitWarning(this.planLimits.get(this.active.agent)) : null;
      const notice = this.promptNotice && this.promptNotice.until > Date.now() ? this.promptNotice : null;
      const text = limit?.text ?? notice?.text ?? (this.updateAvailable ? `↑ codemax ${this.updateAvailable} available · /update` : "");
      const width = Math.max(10, this.renderer.width - 8);
      this.inputWrap.title = text ? ` ${text.length > width ? text.slice(0, width - 1) + "…" : text} ` : "";
      this.inputWrap.titleColor = limit ? (limit.reached ? C.error : C.warn) : notice ? (notice.level === "error" ? C.error : C.warn) : C.dim;
    });
  }

  private noticeSeen = new Map<string, number>();
  /**
   * After /update: what changed since the version that ran it, in a small box above the prompt
   * for WHATS_NEW_MS, then gone. Never written to the transcript or the thread.
   */
  showWhatsNew(to: string, from?: string) {
    const notes = whatsNew(to, from);
    if (!notes.length) return;
    this.safely("what's new", () => {
      const box = new BoxRenderable(this.renderer, { id: "whats-new", width: "100%", flexShrink: 0, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: C.accent, paddingX: 1, title: ` What's new in codemax v${to} `, titleAlignment: "left" } as any);
      const lines = notes.flatMap((n, i) => [...(i > 0 || notes.length > 1 ? [`v${n.version}`] : []), ...n.lines.map((l) => `  • ${l}`)]);
      for (const [i, l] of lines.entries()) box.add(new TextRenderable(this.renderer, { id: `wn-${i}`, content: l, fg: l.startsWith("v") ? C.dim : C.text ?? C.dim, wrapMode: "none", truncate: true, width: "100%" } as any));
      this.chatRoot.insertBefore(box, this.inputWrap); // just above the prompt
      this.whatsNewBox = box;
      setTimeout(() => this.safely("what's new", () => {
        if (this.whatsNewBox !== box) return;
        box.destroyRecursively();
        this.whatsNewBox = null;
      }), WHATS_NEW_MS);
    });
  }

  private whatsNewBox: BoxRenderable | null = null;

  /** A notice an agent raised, shown on the prompt's border until `until`. */
  private promptNotice: { text: string; level: string; until: number } | null = null;
  /** Limit levels already announced in the transcript, per agent and window ("claude:seven_day" → "warning"). */
  private limitAnnounced = new Map<string, string>();

  /** /update: update the way codemax was installed, with its output on the real terminal. */
  private async runUpdate() {
    const plan = updatePlan();
    if (plan.manual) return this.transcript.note(plan.manual, C.warn);
    if (this.active?.turn) return this.transcript.note("an agent is working; /update when the turn ends", C.warn);
    debugEvent("update-run", { from: VERSION, with: plan.label });
    this.transcript.note(`updating with ${plan.label}…`);
    let ok = true;
    await this.withTerminal(async () => {
      process.stdout.write(`\ncodemax: updating with ${plan.label}\n\n`);
      for (const cmd of plan.cmd) {
        const p = Bun.spawn(platformArgv(cmd), { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...(plan.env ?? {}) } });
        if ((await p.exited) !== 0) {
          ok = false;
          break;
        }
      }
      process.stdout.write(ok ? "\ncodemax: done. Returning to codemax…\n" : "\ncodemax: the update failed (see above). Returning to codemax…\n");
      await Bun.sleep(1200);
    });
    if (ok) {
      const to = this.updateAvailable;
      this.updateAvailable = null;
      this.showUpdateBadge();
      this.transcript.note(`updated${to ? ` to ${to}` : ""} · restarting codemax…`, C.ok);
      // Quit cleanly (sessions saved, keep-awake released), then runChat starts the new version.
      this.restartAfterQuit = { agent: this.active?.agent, version: to };
      return void this.quit();
    } else this.transcript.error(`update failed · run it yourself: ${plan.cmd.map((c) => c.join(" ")).join(" && ")}`);
    this.renderFooter();
  }

  private startSpinner(active: Active) {
    this.stopSpinner();
    this.renderFooter(); // "esc to interrupt"
    this.spinnerTimer = setInterval(() => {
      const t = active.turn;
      if (!t) return this.stopSpinner();
      this.spinnerFrame++;
      const glyph = G.spinner[this.spinnerFrame % G.spinner.length];
      const secs = fmtDuration(Date.now() - t.startedAt);
      const approx = t.tokens || Math.round(t.chars / 4);
      const tok = approx ? ` · ↓ ${t.tokens ? "" : "~"}${approx} tokens` : "";
      if (this.permission) this.setWorking(this.permission instanceof QuestionDialog ? `${glyph} Waiting for your answer (${secs}) · esc to skip` : `${glyph} Waiting for your approval (${secs}) · esc to say no`);
      else {
        // Tips live in the empty prompt only, never on this line above it.
        // The step it is on, so a run of tool calls still says what is happening.
        const step = t.step ? ` · ${t.step.replace(/\s+/g, " ").slice(0, 60)}` : "";
        this.setWorking(`${glyph} ${t.verb}… (${secs}${tok}) · ${active.name} · ${this.modelName(active, t.model)}${step}`);
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
    if (!this.closed) setTimeout(() => this.renderFooter(), 0); // after the turn is cleared
  }

  private setWorking(text: string | null) {
    if (this.closed && text) return;
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
    this.safely("footer", () => this.drawFooter());
  }

  private drawFooter() {
    const a = this.active;
    const width = Math.max(20, this.renderer.width - 4);
    let color: string = C.dim;
    const mode = a ? modeLabel(a.name, a.mode) : null;
    if (mode) color = mode.color;
    const canCycle = !!a?.engine.setMode && (a.engine.info?.modes.length ?? 0) > 1;
    // Pieces in priority order; low-priority ones are dropped until the line fits.
    const left: { text: string; prio: number }[] = [];
    // Claude Code's hint line: the permission mode only when it is not the default, then what
    // the keys do right now (esc while working, ? when idle).
    const working = !!a?.turn || !!this.verifying || !!this.debate;
    const special = !!mode && a?.mode !== undefined && !/^(default|on-request)$/.test(a.mode);
    if (!a) left.push({ text: "no agent · /switch", prio: 0 });
    else if (special) left.push({ text: `${mode!.glyph} ${mode!.text}${canCycle ? " (shift+tab to cycle)" : ""}`, prio: 0 });
    if (this.flash) left.push({ text: this.flash, prio: 1 });
    else if (working) left.push({ text: "esc to interrupt", prio: 1 });
    if (!this.flash && this.queue.length) left.push({ text: `${this.queue.length} queued`, prio: 1 });
    if (!this.flash && !working && !this.queue.length && !this.shortcuts.visible) left.push({ text: "? for shortcuts", prio: 2 });
    const right: { text: string; prio: number }[] = [];
    if (this.updateAvailable) left.push({ text: `↑ ${this.updateAvailable} available · /update`, prio: 1 });
    if (this.config.sideAgent?.agent) left.push({ text: `◆ side ${this.config.sideAgent.agent}${this.config.sideAgent.model ? ` ${displayModelName(this.config.sideAgent.model, this.reviewer?.engine.info?.models)}` : ""}${this.reviewer?.busy ? " reviewing…" : ""}`, prio: 2 });
    // Narrow glyph: the footer is measured in characters, and an emoji takes two columns.
    if (this.awake.mode !== "off") left.push({ text: `● awake${this.awake.status.lid ? " · lid" : ""}`, prio: 1 });
    const effort = a ? this.effortOption(a)?.current : undefined;
    if (a) right.push({ text: `${a.name}${a.engine.info?.currentModel ? ` · ${displayModelName(a.engine.info.currentModel, a.engine.info.models)}` : ""}${effort ? ` ${effort}` : ""}`, prio: 2 });
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
    this.footerText.fg = this.flash || !special ? C.dim : color;
  }

  // ---------- detection / switching / quit ----------

  private async refreshDetect() {
    const t0 = Date.now();
    await Promise.all(
      listAdapters(this.config.order).map(async (a) => {
        const d = await a.detect();
        const f = engineFactories[a.id];
        const engine = d.installed && !!f && (await f.available().catch(() => false));
        this.detect.set(a.id, { installed: d.installed, version: d.version, engine, problem: d.problem });
      }),
    );
    // Which agents were found, their versions and why one is not usable (debug log).
    debugEvent("detect", { ms: Date.now() - t0, agents: Object.fromEntries([...this.detect.entries()].map(([id, d]) => [id, d.installed ? `${d.version ?? "?"}${d.engine ? "" : " (no engine)"}` : d.problem ? `missing: ${d.problem.slice(0, 80)}` : "missing"])) });
  }

  private async switchTo(agent: AgentId, fresh: boolean, o: { resumeTask?: boolean; model?: string } = {}) {
    debugEvent("switch", { from: this.active?.agent, to: agent, fresh: fresh || undefined, resumeTask: o.resumeTask || undefined, model: o.model });
    // Choosing an agent yourself means you fixed it (or want to try again).
    if (!o.resumeTask) this.broken.delete(agent);
    if (!hasEngine(agent)) return this.transcript.note(`${agent} has no protocol engine; run codemax --tui for it`, C.warn);
    // Every switch path (menu, /switch, routing, handoff offers) ends here, so an agent that is not really installed is refused here.
    const d = this.detect.get(agent);
    if (d && !d.installed) return this.transcript.note(d.problem ?? `${getAdapter(agent).name} is not installed`, C.warn);
    // An offer made for the agent you are leaving no longer applies.
    this.pendingOffer = null;
    this.switching = true;
    try {
      await this.switchToInner(agent, fresh, o);
    } finally {
      this.switching = false;
    }
  }

  private async switchToInner(agent: AgentId, fresh: boolean, o: { resumeTask?: boolean; model?: string }) {
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
    await this.launch(agent, { fresh, from, reason, model: o.model });
  }

  async quit() {
    if (this.closed) return;
    this.closed = true;
    debugEvent("quit", { uptimeMin: Math.round((Date.now() - this.bornAt) / 60000), agent: this.active?.agent, glitches: this.uiErrors || undefined });
    this.perf?.stop();
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    // Nothing codemax started keeps running: checks, ! commands, agents started to list models.
    this.verifying?.stop();
    this.shellRun?.stop();
    for (const e of this.tempEngines) void e.close().catch(() => {});
    if (this.noteArmTimer) clearTimeout(this.noteArmTimer);
    this.term.close();
    this.subagents.destroy();
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
    this.renderer.keyInput.off("paste", this.onPaste);
    this.resolveDone();
  }
}

/**
 * A permission mode in which the agent approves its own actions (Claude's auto,
 * acceptEdits, bypassPermissions; Antigravity's auto_edit, yolo; Codex's never),
 * with the mode that asks instead, when the agent lists one.
 */
export function selfApprovingMode(mode: string | undefined, modes: { id: string; name: string }[] = []): { what: string; effect: string; ask?: string } | null {
  if (!mode) return null;
  const edits = /^(acceptEdits|auto_edit)$/.test(mode);
  if (!edits && !/^(auto|bypassPermissions|yolo|never)$/.test(mode)) return null;
  const ask = modes.find((m) => m.id === "default" || m.id === "on-request");
  const name = modes.find((m) => m.id === mode)?.name ?? mode;
  return { what: `"${name}"`, effect: edits ? "it edits files without asking" : "it acts without asking", ask: ask?.id };
}

/**
 * Does the agent's reply end by asking you something ("Option 1 or 2?")? Then a lone
 * digit you type is an answer, not a note key.
 */
export function asksUser(reply: string): boolean {
  const tail = reply.trim().slice(-400);
  if (!tail) return false;
  const lastLine = tail.split("\n").filter((l) => l.trim()).pop() ?? "";
  return /\?\s*[)*_`"']*\s*$/.test(lastLine) || (/\?/.test(tail) && /^\s*(?:[-*]\s*)?\(?[0-9][.)]/m.test(tail));
}

/** Rows `text` takes when word-wrapped at `width` columns (as the prompt wraps it). */
export function wrappedLines(text: string, width: number): number {
  let rows = 0;
  for (const line of text.split("\n")) {
    let col = 0;
    rows++;
    for (const word of line.split(/(?<= )/)) {
      const w = Bun.stringWidth(word);
      if (col + Bun.stringWidth(word.trimEnd()) <= width) col += w;
      else if (w <= width) {
        rows++;
        col = w;
      } else {
        // A word longer than the line breaks by characters.
        const extra = col ? 1 : 0;
        rows += extra + Math.ceil(w / width) - 1;
        col = w % width || width;
      }
    }
  }
  return rows;
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export async function runChat(config: Config, ledger: Ledger, cwd: string, agent: AgentId, fresh: boolean, pick = false, explicit = false, pickThread = false, onboard = false) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: ["SIGTERM", "SIGHUP"], useMouse: true, targetFps: 60 });
  const pref = config.theme ?? "auto";
  applyTheme(pref === "auto" ? ((await renderer.waitForThemeMode(250).catch(() => null)) ?? "dark") : pref, isColorTheme(config.colors) ? config.colors : "codemax");
  const app = new ChatApp(renderer, config, ledger, cwd);
  process.once("exit", () => app.awake.releaseSync());
  stopChildrenOnExit();
  // Closing the terminal (SIGHUP) or a kill (SIGTERM): OpenTUI only takes the screen down,
  // and its handler keeps the process from exiting, so quit properly (agents closed,
  // sessions saved), then exit even if something hangs.
  for (const sig of ["SIGTERM", "SIGHUP"] as const)
    process.once(sig, () => {
      setTimeout(() => process.exit(0), 5000).unref?.();
      void app.quit().finally(() => setTimeout(() => process.exit(0), 50));
    });
  try {
    await app.start(agent, fresh, { pick, explicit, pickThread, onboard });
  } finally {
    renderer.destroy();
    try {
      await renderer.closed;
    } catch {
      /* output already gone */
    }
  }
  if (app.restartAfterQuit) {
    process.stdout.write("codemax: starting the new version…\n");
    await relaunch(app.restartAfterQuit.agent, app.restartAfterQuit.version, app.threadId, VERSION);
  }
  process.stdout.write(app.threadUsed ? `codemax: to continue this thread, run: codemax --resume ${app.threadId}\n` : "codemax: bye\n");
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

function reviewCadence(every: number | undefined): string {
  const n = every ?? 1;
  return n === 0 ? "never (reviews paused)" : n === 1 ? "every turn" : n === 2 ? "every 2nd turn" : n === 3 ? "every 3rd turn" : `every ${n}th turn`;
}

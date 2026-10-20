import type { AgentId } from "../adapters/types.ts";

/** One normalized stream that every protocol (ACP, Codex app-server, …) is mapped onto. */
export type EngineEvent =
  /** `messageId` changes between separate agent messages (e.g. before and after a tool call). */
  | { type: "text_delta"; text: string; messageId?: string }
  | { type: "thought_delta"; text: string; messageId?: string }
  /**
   * `detail` is a short display string. `input` (the tool's raw arguments), `output`
   * (its full text result) and `files` are carried uncut for the journal, which caps them.
   */
  | { type: "tool_call"; id: string; title: string; kind?: string; status: ToolStatus; detail?: string; input?: unknown; output?: string; files?: string[] }
  | { type: "tool_update"; id: string; status?: ToolStatus; title?: string; detail?: string; input?: unknown; output?: string; files?: string[] }
  | { type: "permission_request"; request: PermissionRequest }
  /** A subagent the main agent spawned (Task/Agent tool…): started, doing something, or finished. */
  | SubagentEvent
  /** The agent asks the user something (Claude's AskUserQuestion, MCP forms). Answer with `answerQuestion`. */
  | { type: "question_request"; request: QuestionRequest }
  | { type: "plan"; entries: { content: string; status: string; priority?: string }[] }
  | { type: "mode"; modeId: string }
  | { type: "commands"; commands: { name: string; description?: string }[] }
  | {
      type: "usage";
      /** Incremental token counts for the work just done (never cumulative). */
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      model?: string;
      /** Incremental cost the agent itself reported, in USD. */
      costUsd?: number;
      /** The agent's own running total for this session (Claude's `cost.amount`), kept so a restart never counts it again. */
      agentTotalUsd?: number;
      /** These tokens' cost is already in the agent's own figure: count them, never price them again. */
      costCovered?: boolean;
      /** Rate-limit window consumption, when the agent exposes it. */
      usedPercent?: number;
      /** Subscription plan limits the agent reported (Claude: 5-hour, weekly…), one entry per window. */
      planLimits?: PlanLimit[];
      /** Context window fill, when reported (tokens used / size). */
      contextUsed?: number;
      contextSize?: number;
    }
  | { type: "session"; ref: EngineSessionRef }
  | { type: "turn_end"; stopReason: StopReason }
  | { type: "error"; kind: ErrorKind; message: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  /** A warning the agent shows its own users (ACP `notice`, Codex `warning`…): "Retrying Claude, attempt 2 of 10", "Model fallback". */
  | { type: "notice"; level: "info" | "warn" | "error"; title: string; detail?: string };

export interface PlanLimit {
  /** e.g. "five_hour", "seven_day", "seven_day_opus". */
  window: string;
  usedPercent?: number;
  resetsAt?: number;
  /** "allowed" | "allowed_warning" | "rejected" (out of this window's quota). */
  status?: string;
}

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";
export type StopReason = "end_turn" | "max_tokens" | "cancelled" | "refusal" | "error" | "other";
export type ErrorKind = "quota" | "auth" | "protocol" | "crashed" | "other";

export interface PermissionOption {
  id: string;
  label: string;
  /** allow_once | allow_always | reject_once | reject_always */
  kind: string;
}

export interface PermissionRequest {
  id: string;
  toolCallId?: string;
  /** ACP tool kind when known: read | edit | delete | move | search | execute | think | fetch | other */
  kind?: string;
  title: string;
  detail?: string;
  /** The change an edit would make, as a unified-style diff (uncut; the dialog decides how much to show). */
  diff?: string;
  options: PermissionOption[];
}

export interface SubagentEvent {
  type: "subagent";
  /** Stable id (the launching tool call's id). */
  id: string;
  /** Agent type or name ("Explore", "general-purpose"). */
  name?: string;
  /** What it was asked to do (short description). */
  task?: string;
  /** Its latest step ("Grep(requireAuth)"). */
  activity?: string;
  status?: "running" | "done" | "failed";
}

export interface QuestionField {
  /** Property name in the agent's form; the answer is keyed by it. */
  key: string;
  /** Short label ("Database"), when the agent gives one. */
  title?: string;
  question: string;
  kind: "single" | "multi" | "text" | "number" | "boolean";
  options: { value: string; label: string; description?: string }[];
  /** Companion free-text field the agent accepts as "Other". */
  otherKey?: string;
  required?: boolean;
  integer?: boolean;
}

export interface QuestionRequest {
  id: string;
  message: string;
  fields: QuestionField[];
  toolCallId?: string;
}

/** accept = answered; decline = the user skipped (the agent carries on); cancel = abort the request. */
export type QuestionAnswer = { action: "accept"; content: Record<string, string | number | boolean | string[]> } | { action: "decline" } | { action: "cancel" };

export interface EngineSessionRef {
  agent: AgentId;
  /** Vendor session / thread id, used to resume. */
  id: string;
  cwd: string;
  startedAt: number;
  lastUsedAt: number;
}

export interface EngineMode {
  id: string;
  name: string;
  description?: string;
}

export interface EngineStartOptions {
  /** The agent's running cost total last recorded for the session being resumed: only what it adds after that is new. */
  costBaseline?: number;
  /** Let the agent ask the user questions (form elicitation). Off: the agent decides on its own. */
  questions?: boolean;
  cwd: string;
  /** Resume a previous session instead of starting a new one. */
  resume?: EngineSessionRef;
  /**
   * A few lines for the agent's instructions (how to keep the user informed). Sent where the
   * agent has a slot for them (ACP `systemPrompt` append, Codex `developerInstructions`);
   * otherwise once, ahead of the first message of a new session, never again.
   */
  instructions?: string;
}

export interface EngineInfo {
  agent: AgentId;
  name: string;
  version?: string;
  modes: EngineMode[];
  currentMode?: string;
  models?: { id: string; name: string }[];
  currentModel?: string;
  /** Subscription plan name when the agent reports one (e.g. "chatgpt pro"). */
  plan?: string;
  /** Other settings the agent exposes as selects, e.g. Grok's reasoning effort. */
  options?: EngineOption[];
}

export interface EngineOption {
  id: string;
  name: string;
  /** ACP category, e.g. "thought_level" for reasoning effort. */
  category?: string;
  current?: string;
  values: { value: string; name: string; description?: string }[];
}

/**
 * A running agent process spoken to over a protocol. One engine = one agent
 * session. Events arrive through `onEvent`; permission requests must be
 * answered with `answerPermission` or the agent stays blocked.
 */
export interface Engine {
  readonly agent: AgentId;
  readonly info: EngineInfo | null;
  readonly session: EngineSessionRef | null;
  onEvent(listener: (e: EngineEvent) => void): () => void;
  start(opts: EngineStartOptions): Promise<EngineInfo>;
  /** Send one user turn, with any images you attached. Resolves when the turn ends (turn_end has been emitted). */
  prompt(text: string, images?: PromptImage[]): Promise<StopReason>;
  answerPermission(requestId: string, optionId: string): void;
  /** Engines that can ask the user questions (`question_request`) answer them here. */
  answerQuestion?(requestId: string, answer: QuestionAnswer): void;
  cancel(): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  setModel?(modelId: string): Promise<void>;
  /** Change one of `info.options` (e.g. reasoning effort). */
  setOption?(optionId: string, value: string): Promise<void>;
  /**
   * Where the conversation stands now, for a later /rewind to come back to.
   * Only agents that can cut their own conversation at a message (Claude) have it;
   * null when this point cannot be returned to.
   */
  rewindPoint?(): RewindPoint | null;
  /** Continue in a copy of the conversation that ends at `point`: the later turns are gone from the agent's memory. */
  rewindConversation?(point: RewindPoint): Promise<void>;
  close(): Promise<void>;
}

/** An image file attached to a message (dropped into the prompt). */
export interface PromptImage {
  path: string;
  mimeType: string;
}

/** A place in an agent's conversation: after message `messageId`, or before anything (null). */
export interface RewindPoint {
  sessionId: string;
  messageId: string | null;
}

export interface EngineFactory {
  agent: AgentId;
  /** True when the binary (or adapter) this engine needs is available. */
  available(): Promise<boolean>;
  create(): Engine;
}

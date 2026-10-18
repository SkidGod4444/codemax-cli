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
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

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
  options: PermissionOption[];
}

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
  cwd: string;
  /** Resume a previous session instead of starting a new one. */
  resume?: EngineSessionRef;
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
  /** Send one user turn. Resolves when the turn ends (turn_end has been emitted). */
  prompt(text: string): Promise<StopReason>;
  answerPermission(requestId: string, optionId: string): void;
  cancel(): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  setModel?(modelId: string): Promise<void>;
  /** Change one of `info.options` (e.g. reasoning effort). */
  setOption?(optionId: string, value: string): Promise<void>;
  close(): Promise<void>;
}

export interface EngineFactory {
  agent: AgentId;
  /** True when the binary (or adapter) this engine needs is available. */
  available(): Promise<boolean>;
  create(): Engine;
}

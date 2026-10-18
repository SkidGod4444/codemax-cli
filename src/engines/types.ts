import type { AgentId } from "../adapters/types.ts";

/** One normalized stream that every protocol (ACP, Codex app-server, …) is mapped onto. */
export type EngineEvent =
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "tool_call"; id: string; title: string; kind?: string; status: ToolStatus; detail?: string }
  | { type: "tool_update"; id: string; status?: ToolStatus; title?: string; detail?: string }
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
      /** Context window fill, when reported (tokens used / size). */
      contextUsed?: number;
      contextSize?: number;
    }
  | { type: "session"; ref: EngineSessionRef }
  | { type: "turn_end"; stopReason: StopReason }
  | { type: "error"; kind: ErrorKind; message: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

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
  close(): Promise<void>;
}

export interface EngineFactory {
  agent: AgentId;
  /** True when the binary (or adapter) this engine needs is available. */
  available(): Promise<boolean>;
  create(): Engine;
}

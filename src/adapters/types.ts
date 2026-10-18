export type AgentId = "claude" | "codex" | "opencode" | "cursor" | "grok" | "antigravity" | "gemini" | "copilot" | "fake";

export interface SessionRef {
  agent: AgentId;
  /** Vendor session / thread id. */
  id: string;
  /** Absolute path of the vendor transcript, when known. */
  transcriptPath?: string;
  cwd: string;
  startedAt: number;
  lastUsedAt: number;
}

export interface Turn {
  ts: number;
  agent: AgentId;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  /** Tool names used in this assistant turn, deduped. */
  tools?: string[];
}

export interface QuotaStatus {
  agent: AgentId;
  /** 0..100 of the primary window consumed, when the vendor exposes it. */
  usedPercent?: number;
  resetsAt?: number;
  /** True when the vendor has told us we are out of quota. */
  exhausted: boolean;
  source: "probe" | "output" | "manual";
  detail?: string;
  at: number;
  /** Output-text detections are guesses: they expire instead of sticking. */
  expiresAt?: number;
}

export interface LaunchOptions {
  cwd: string;
  /** Resume this vendor session instead of starting a new one. */
  resume?: SessionRef;
  /** Initial prompt to seed the session with (the handoff brief). */
  prompt?: string;
  /** Pre-generated session id when the vendor lets us choose one. */
  sessionId?: string;
  extraArgs?: string[];
}

export interface LaunchSpec {
  cmd: string[];
  env?: Record<string, string>;
  /**
   * True when `prompt` was consumed by `cmd` (positional arg). False means
   * the orchestrator must type the prompt into the PTY once the TUI is ready.
   */
  promptConsumed: boolean;
}

export interface DetectResult {
  installed: boolean;
  path?: string;
  version?: string;
  /** Why a CLI found on PATH does not count as installed (it failed to run). */
  problem?: string;
}

export interface Adapter {
  id: AgentId;
  name: string;
  bin: string;
  detect(): Promise<DetectResult>;
  launch(opts: LaunchOptions): LaunchSpec;
  /** Choose a session id up front when the vendor supports it. */
  newSessionId?(): string;
  /** Find the vendor session created by a launch at `startedAt` in `cwd`. */
  locateSession(opts: { cwd: string; startedAt: number; sessionId?: string }): Promise<SessionRef | null>;
  /** Parse the vendor transcript into normalized turns. Null when unsupported. */
  readTranscript?(ref: SessionRef): Promise<Turn[]>;
  /** Proactive quota probe (vendor-specific files or APIs). */
  probeQuota?(ref: SessionRef | null): Promise<QuotaStatus | null>;
  /** Regexes matched against ANSI-stripped TUI output. */
  quotaPatterns: RegExp[];
  /**
   * Env vars that make the CLI bill a pay-per-token API key instead of the
   * user's subscription login. Always stripped at launch: codemax is
   * subscriptions-only.
   */
  apiKeyEnv: string[];
}

import { ClientSideConnection, ndJsonStream, type Client, type Stream } from "@agentclientprotocol/sdk";
import type { AgentId } from "../adapters/types.ts";
import type { Engine, EngineEvent, EngineInfo, EngineOption, EngineSessionRef, EngineStartOptions, PermissionRequest, PlanLimit, QuestionAnswer, StopReason } from "./types.ts";
import { elicitationResponse, parseElicitation } from "./elicitation.ts";
import { agentEnv } from "./env.ts";
import { IS_WINDOWS, platformArgv } from "../core/spawn.ts";
import { classifyError } from "./errors.ts";

export interface UsageSample {
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
}

export interface AcpEngineOptions {
  agent: AgentId;
  name: string;
  /** Command that starts the ACP agent over stdio. */
  cmd: string[];
  env?: Record<string, string>;
  /** Pre-built stream (tests inject an in-process agent). When set, `cmd` is not spawned. */
  stream?: Stream;
  /**
   * Run the agent behind plain pipes (`cat | agent | cat`, macOS/Linux). Bun gives a child
   * socket stdio; Antigravity's Python ACP server never answers on a socket.
   */
  plainPipes?: boolean;
  /**
   * Sign-in methods codemax may use when the agent says "Authentication required" (its
   * subscription login only, never an API-key method). A browser may open the first time.
   */
  signIn?: string[];
  /** False when the agent is known to auto-approve tools over ACP (surfaced to the user). */
  permissionPrompts?: boolean;
  /**
   * Agents that do not report usage over ACP (Claude Code, Grok) keep it in
   * session files. This reads what was appended since the last call.
   */
  usageTail?: (session: EngineSessionRef) => { read(): UsageSample[] };
}

/**
 * Generic Agent Client Protocol engine. Works for any agent that speaks ACP
 * over stdio: Claude Code (via the Zed adapter), OpenCode, Grok, Gemini CLI.
 */
export class AcpEngine implements Engine {
  readonly agent: AgentId;
  info: EngineInfo | null = null;
  session: EngineSessionRef | null = null;
  private listeners = new Set<(e: EngineEvent) => void>();
  private conn: ClientSideConnection | null = null;
  private proc: Bun.Subprocess | null = null;
  private pendingPermissions = new Map<string, (optionId: string | null) => void>();
  private pendingQuestions = new Map<string, (answer: QuestionAnswer) => void>();
  /** cancel() was called during the current turn. */
  private cancelled = false;
  private permSeq = 0;
  private turnActive = false;
  private tail: { read(): UsageSample[] } | null = null;
  private lastAgentCost = 0;
  /** Agents that expose model/mode as ACP config options (OpenCode) are switched through them. */
  private configIds: { model?: string; mode?: string } = {};
  /** Context fill from the latest usage_update this turn; a token fallback for agents with no usage. */
  private turnContext = 0;

  constructor(private opts: AcpEngineOptions) {
    this.agent = opts.agent;
  }

  onEvent(listener: (e: EngineEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(e: EngineEvent) {
    for (const l of this.listeners) l(e);
  }

  async start(o: EngineStartOptions): Promise<EngineInfo> {
    const stream = this.opts.stream ?? this.spawn(o.cwd);
    const client: Client = {
      requestPermission: (p) => this.onPermission(p),
      // Form questions only: codemax shows them in its own dialog. URL elicitations are not advertised.
      createElicitation: (p) => this.onElicitation(p) as any,
      sessionUpdate: ({ sessionId, update }) => {
        // Another session on this connection is a spawned agent (Cursor, Grok): its steps
        // are its activity, never part of the main transcript.
        if (sessionId && this.session && sessionId !== this.session.id) return this.onChildSession(sessionId, update as any);
        this.onUpdate(update as any);
      },
      // Cursor reports a finished Task subagent with its own notification.
      extNotification: async (method: string, params: any) => {
        if (method === "cursor/task" && params?.toolCallId) this.emit({ type: "subagent", id: params.toolCallId, name: params.subagentType, task: params.description, status: "done" });
      },
      readTextFile: async (p) => ({ content: await Bun.file(p.path).text() }),
      writeTextFile: async (p) => {
        await Bun.write(p.path, p.content);
        return {};
      },
    };
    this.conn = new ClientSideConnection(() => client, stream);
    const init = await this.conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, ...(o.questions === false ? {} : { elicitation: { form: {} } }) } });

    let sessionId: string;
    let modes: any;
    let models: any;
    let config: any;
    if (o.resume) {
      try {
        const r: any = await this.signedIn(init, () => this.conn!.loadSession({ sessionId: o.resume!.id, cwd: o.cwd, mcpServers: [] }));
        sessionId = o.resume.id;
        modes = r?.modes;
        models = r?.models;
        config = r?.configOptions;
      } catch (e: any) {
        this.emit({ type: "log", level: "warn", message: `resume failed (${e?.message ?? e}); starting a new session` });
        const s: any = await this.signedIn(init, () => this.conn!.newSession({ cwd: o.cwd, mcpServers: [] }));
        sessionId = s.sessionId;
        config = s.configOptions;
        modes = s.modes;
        models = s.models;
      }
    } else {
      const s: any = await this.signedIn(init, () => this.conn!.newSession({ cwd: o.cwd, mcpServers: [] }));
      sessionId = s.sessionId;
      modes = s.modes;
      models = s.models;
      config = s.configOptions;
    }
    // ACP config options (OpenCode): a "model" / "mode" select stands in for models/modes.
    const opt = (cat: string) => (Array.isArray(config) ? config.find((c: any) => c?.category === cat || c?.id === cat) : undefined);
    const modelOpt = opt("model"), modeOpt = opt("mode");
    if (modelOpt) this.configIds.model = modelOpt.id;
    if (modeOpt) this.configIds.mode = modeOpt.id;
    if (!models && modelOpt) {
      models = { currentModelId: modelOpt.currentValue, availableModels: (modelOpt.options ?? []).map((x: any) => ({ modelId: x.value, name: x.name ?? x.value })) };
    }
    if (!modes && modeOpt) {
      modes = { currentModeId: modeOpt.currentValue, availableModes: (modeOpt.options ?? []).map((x: any) => ({ id: x.value, name: x.name ?? x.value, description: x.description })) };
    }
    this.session = { agent: this.agent, id: sessionId, cwd: o.cwd, startedAt: Date.now(), lastUsedAt: Date.now() };
    this.tail = this.opts.usageTail?.(this.session) ?? null;
    if (o.resume && this.tail) this.tail.read(); // skip history already accounted for
    this.info = {
      agent: this.agent,
      name: (init as any).agentInfo?.title ?? this.opts.name,
      version: (init as any).agentInfo?.version,
      modes: (modes?.availableModes ?? []).map((m: any) => ({ id: m.id, name: m.name ?? m.id, description: m.description })),
      currentMode: modes?.currentModeId,
      models: (models?.availableModels ?? []).map((m: any) => ({ id: m.modelId ?? m.id, name: m.name ?? m.modelId ?? m.id })),
      currentModel: models?.currentModelId,
      options: extraOptions(config),
    };
    this.emit({ type: "session", ref: this.session });
    if (this.info.currentMode) this.emit({ type: "mode", modeId: this.info.currentMode });
    return this.info;
  }

  /** Run `fn`; if the agent wants a sign-in first, sign in with an allowed method and run it again. */
  private async signedIn<T>(init: any, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      // -32000 is ACP's "auth required"; some agents send it as an internal error with the reason in data.
      const needsAuth = e?.code === -32000 || /authenticat|auth required|sign.?in|log.?in/i.test(`${e?.message ?? ""} ${JSON.stringify(e?.data ?? "")}`);
      const method = (init?.authMethods ?? []).map((m: any) => m.id).find((id: string) => this.opts.signIn?.includes(id));
      if (!needsAuth || !this.conn) throw e;
      if (!method) {
        const offered = (init?.authMethods ?? []).map((m: any) => m.name ?? m.id).join(", ") || "none";
        throw new Error(`${this.opts.name} needs you to sign in, and offers no subscription sign-in codemax may use (offered: ${offered}). codemax never uses API keys.`);
      }
      this.emit({ type: "log", level: "warn", message: `signing in to ${this.opts.name} with your subscription (${method}); a browser window may open the first time` });
      await this.conn.authenticate({ methodId: method } as any);
      return fn();
    }
  }

  private spawn(cwd: string): Stream {
    const argv = this.opts.plainPipes && !IS_WINDOWS ? ["/bin/sh", "-c", 'cat | "$@" | cat', "sh", ...this.opts.cmd] : platformArgv(this.opts.cmd);
    const proc = Bun.spawn(argv, { cwd, env: agentEnv(this.opts.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    void (async () => {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        const s = new TextDecoder().decode(chunk).trim();
        if (s) this.emit({ type: "log", level: "info", message: s.slice(0, 500) }); // agent stderr: noise unless debugging
      }
    })();
    void proc.exited.then((code) => {
      if (this.conn) this.emit({ type: "error", kind: "crashed", message: `${this.opts.name} exited with code ${code}` });
    });
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        (proc.stdin as any).write(chunk);
        (proc.stdin as any).flush?.();
      },
    });
    return ndJsonStream(output, proc.stdout as ReadableStream<Uint8Array>);
  }

  private async onPermission(p: any) {
    const id = `perm-${++this.permSeq}`;
    const request: PermissionRequest = {
      id,
      toolCallId: p.toolCall?.toolCallId,
      kind: p.toolCall?.kind,
      title: p.toolCall?.title ?? p.toolCall?.toolCallId ?? "tool",
      detail: formatInput(p.toolCall?.rawInput),
      options: (p.options ?? []).map((o: any) => ({ id: o.optionId, label: o.name ?? o.optionId, kind: o.kind })),
    };
    const choice = await new Promise<string | null>((resolve) => {
      this.pendingPermissions.set(id, resolve);
      this.emit({ type: "permission_request", request });
    });
    this.pendingPermissions.delete(id);
    return choice ? { outcome: { outcome: "selected" as const, optionId: choice } } : { outcome: { outcome: "cancelled" as const } };
  }

  private onUpdate(u: any) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") this.emit({ type: "text_delta", text: u.content.text, messageId: u.messageId });
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") this.emit({ type: "thought_delta", text: u.content.text, messageId: u.messageId });
        break;
      case "tool_call":
        this.trackSubagent(u, true);
        this.emit({ type: "tool_call", id: u.toolCallId, title: u.title ?? u.toolCallId, kind: u.kind, status: mapStatus(u.status), detail: summarize(u), input: u.rawInput, files: paths(u), ...full(u) });
        break;
      case "tool_call_update":
        this.trackSubagent(u, false);
        this.emit({ type: "tool_update", id: u.toolCallId, status: u.status ? mapStatus(u.status) : undefined, title: u.title, detail: summarize(u), input: u.rawInput, files: paths(u), ...full(u) });
        break;
      case "plan":
        this.emit({ type: "plan", entries: (u.entries ?? []).map((e: any) => ({ content: e.content, status: e.status, priority: e.priority })) });
        break;
      case "current_mode_update":
        this.emit({ type: "mode", modeId: u.currentModeId });
        break;
      case "available_commands_update":
        this.emit({ type: "commands", commands: (u.availableCommands ?? []).map((c: any) => ({ name: c.name, description: c.description })) });
        break;
      case "usage_update": {
        // ACP: `used`/`size` describe context fill; `cost` is the session's running total.
        const total = typeof u.cost?.amount === "number" ? u.cost.amount : undefined;
        const delta = total !== undefined ? Math.max(0, total - this.lastAgentCost) : undefined;
        if (total !== undefined) this.lastAgentCost = total;
        // `used` is how full the context window is, not tokens spent: it feeds the context meter.
        // Token counts come from the prompt response (or session files) at turn end.
        if (typeof u.used === "number") this.turnContext = u.used;
        this.emit({ type: "usage", contextUsed: u.used, contextSize: u.size, costUsd: delta, model: this.currentModelName(), planLimits: planLimitsOf(u) });
        break;
      }
      default:
        break;
    }
  }

  async prompt(text: string): Promise<StopReason> {
    if (!this.conn || !this.session) throw new Error("engine not started");
    this.turnActive = true;
    this.cancelled = false;
    this.turnContext = 0;
    try {
      const res: any = await this.conn.prompt({ sessionId: this.session.id, prompt: [{ type: "text", text }] });
      this.session.lastUsedAt = Date.now();
      this.flushUsage();
      this.emitTurnUsage(res?.usage);
      // Some agents (Antigravity) end an interrupted turn with "end_turn": it was still cancelled.
      const reason = this.cancelled ? "cancelled" : mapStop(res.stopReason);
      this.emit({ type: "turn_end", stopReason: reason });
      return reason;
    } catch (e: any) {
      const message = e?.message ?? String(e);
      const data = JSON.stringify(e?.data ?? "");
      const kind = classifyError(`${message} ${data}`);
      this.emit({ type: "error", kind, message: `${message} ${data}`.trim() });
      this.emit({ type: "turn_end", stopReason: "error" });
      return "error";
    } finally {
      this.turnActive = false;
    }
  }

  answerPermission(requestId: string, optionId: string) {
    this.pendingPermissions.get(requestId)?.(optionId);
  }

  answerQuestion(requestId: string, answer: QuestionAnswer) {
    this.pendingQuestions.get(requestId)?.(answer);
  }

  /** Launch tool call id → whether it runs in the background (its "completed" only means launched). */
  private subagentLaunches = new Map<string, { background: boolean }>();

  /**
   * Subagents from tool calls. A launch is Claude's Agent/Task tool, OpenCode's task tool or
   * Cursor's "Task: …" (all carry subagent_type / description / prompt). Claude stamps each of
   * the subagent's own tool calls with `_meta.claudeCode.parentToolUseId`: that is its activity.
   */
  private trackSubagent(u: any, isNew: boolean) {
    const id = u.toolCallId;
    const meta = u._meta?.claudeCode ?? {};
    const parent = meta.parentToolUseId;
    if (parent && this.subagentLaunches.has(parent)) {
      if (isNew && u.title) this.emit({ type: "subagent", id: parent, activity: String(u.title) });
      return;
    }
    const launch = this.subagentLaunches.get(id);
    if (launch) {
      const st = u.status;
      if (st === "failed") this.emit({ type: "subagent", id, status: "failed" });
      else if (st === "completed" && !launch.background) this.emit({ type: "subagent", id, status: "done" });
      return;
    }
    if (!isNew) return;
    const input = u.rawInput ?? {};
    const tool = String(meta.toolName ?? input._toolName ?? "");
    const type = input.subagent_type ?? input.subagentType;
    const isLaunch = /^(agent|task)$/i.test(tool) || typeof type === "string" || /^Task: /.test(String(u.title ?? ""));
    if (!isLaunch || !(input.prompt || input.description || type)) return;
    this.subagentLaunches.set(id, { background: !!(input.run_in_background ?? input.background) });
    this.emit({ type: "subagent", id, name: typeof type === "string" && type ? type : input.name ?? "agent", task: input.description ?? String(u.title ?? "").replace(/^Task: /, ""), status: "running" });
  }

  /** A spawned agent's own session (agents that run subagents as sessions). */
  private onChildSession(sessionId: string, u: any) {
    if (u?.sessionUpdate === "tool_call" && u.title) this.emit({ type: "subagent", id: sessionId, activity: String(u.title) });
  }

  private async onElicitation(p: any) {
    if (p?.mode && p.mode !== "form") return { action: "decline" };
    const id = `ask-${++this.permSeq}`;
    const request = parseElicitation(id, p);
    if (!request.fields.length) return { action: "decline" };
    const answer = await new Promise<QuestionAnswer>((resolve) => {
      this.pendingQuestions.set(id, resolve);
      this.emit({ type: "question_request", request });
    });
    this.pendingQuestions.delete(id);
    return elicitationResponse(answer);
  }

  private currentModelName(): string {
    const id = this.info?.currentModel;
    return id ?? `${this.opts.name.toLowerCase()} default model`;
  }

  /**
   * Per-turn token counts from the ACP prompt response (OpenCode reports
   * inputTokens / outputTokens / thoughtTokens / cachedReadTokens). Agents
   * with session-file usage (Claude Code, Grok) are counted by the tail
   * instead; with neither, the context fill is the closest input figure.
   */
  private emitTurnUsage(u: any) {
    if (this.tail) return;
    const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
    if (u && typeof u === "object") {
      const cacheRead = n(u.cachedReadTokens ?? u.cacheReadTokens);
      const input = Math.max(0, n(u.inputTokens) - cacheRead);
      const output = n(u.outputTokens) + n(u.thoughtTokens ?? u.reasoningTokens);
      if (input + output + cacheRead > 0) {
        this.emit({ type: "usage", inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: n(u.cachedWriteTokens ?? u.cacheWriteTokens), model: this.currentModelName() });
        return;
      }
    }
    if (this.turnContext > 0) this.emit({ type: "usage", inputTokens: this.turnContext, model: this.currentModelName() });
  }

  /** Emit usage appended to the agent's session files since the last check. */
  flushUsage() {
    if (!this.tail) return;
    try {
      for (const s of this.tail.read()) this.emit({ type: "usage", inputTokens: s.input, outputTokens: s.output, cacheReadTokens: s.cacheRead, cacheWriteTokens: s.cacheWrite, model: s.model, costUsd: s.costUsd });
    } catch {
      /* file mid-write; next turn picks it up */
    }
  }

  async cancel() {
    if (!this.conn || !this.session || !this.turnActive) return;
    this.cancelled = true;
    for (const resolve of this.pendingPermissions.values()) resolve(null);
    for (const resolve of this.pendingQuestions.values()) resolve({ action: "cancel" });
    await this.conn.cancel({ sessionId: this.session.id }).catch(() => {});
  }

  async setModel(modelId: string) {
    if (!this.conn || !this.session) return;
    // The current protocol switches models through a config option (Grok, Cursor, OpenCode).
    // Agents that only list models (the Claude adapter) take the older session/set_model call,
    // which this SDK no longer wraps, so it is sent as a raw method.
    if (this.configIds.model) await this.conn.setSessionConfigOption({ sessionId: this.session.id, configId: this.configIds.model, value: modelId } as any);
    else await this.conn.extMethod("session/set_model", { sessionId: this.session.id, modelId });
    if (this.info) this.info.currentModel = modelId;
  }

  async setOption(optionId: string, value: string) {
    if (!this.conn || !this.session) return;
    await this.conn.setSessionConfigOption({ sessionId: this.session.id, configId: optionId, value } as any);
    const o = this.info?.options?.find((x) => x.id === optionId);
    if (o) o.current = value;
  }

  async setMode(modeId: string) {
    if (!this.conn || !this.session) return;
    if (this.configIds.mode) await this.conn.setSessionConfigOption({ sessionId: this.session.id, configId: this.configIds.mode, value: modeId } as any);
    else await this.conn.setSessionMode({ sessionId: this.session.id, modeId });
    if (this.info) this.info.currentMode = modeId;
    this.emit({ type: "mode", modeId });
  }

  async close() {
    this.flushUsage();
    const conn = this.conn;
    this.conn = null;
    for (const resolve of this.pendingPermissions.values()) resolve(null);
    for (const resolve of this.pendingQuestions.values()) resolve({ action: "cancel" });
    if (conn && this.session) await conn.closeSession?.({ sessionId: this.session.id }).catch(() => {});
    if (this.proc) {
      try {
        // End of input first: an agent behind plain pipes (and its `cat`s) exits on EOF.
        (this.proc.stdin as any)?.end?.();
      } catch {
        /* already closed */
      }
      try {
        this.proc.kill();
      } catch {
        /* already gone */
      }
      await Promise.race([this.proc.exited, Bun.sleep(1500)]);
      if (!this.proc.killed) this.proc.kill("SIGKILL");
    }
  }
}

/** Select-type config options other than model and mode (those have their own commands). */
function extraOptions(config: unknown): EngineOption[] {
  if (!Array.isArray(config)) return [];
  return config
    .filter((c: any) => c && c.type === "select" && c.category !== "model" && c.category !== "mode" && c.id !== "model" && c.id !== "mode" && Array.isArray(c.options))
    .map((c: any) => ({
      id: String(c.id),
      name: String(c.name ?? c.id),
      category: c.category,
      current: c.currentValue,
      values: c.options.map((o: any) => ({ value: String(o.value), name: String(o.name ?? o.value), description: o.description })),
    }));
}

/** Claude's plan limits ride on usage updates as `_meta["_claude/rateLimit"]` (SDKRateLimitInfo). */
function planLimitsOf(u: any): PlanLimit[] | undefined {
  const rl = u?._meta?.["_claude/rateLimit"];
  if (!rl || typeof rl !== "object") return undefined;
  const util = typeof rl.utilization === "number" ? (rl.utilization <= 1 ? rl.utilization * 100 : rl.utilization) : undefined;
  const reset = typeof rl.resetsAt === "number" ? (rl.resetsAt < 1e12 ? rl.resetsAt * 1000 : rl.resetsAt) : undefined;
  return [{ window: String(rl.rateLimitType ?? "plan"), usedPercent: util, resetsAt: reset, status: rl.status }];
}

function mapStatus(s: string | undefined): "pending" | "in_progress" | "completed" | "failed" {
  if (s === "in_progress" || s === "completed" || s === "failed") return s;
  return "pending";
}

function mapStop(s: string | undefined): StopReason {
  switch (s) {
    case "end_turn":
    case "max_tokens":
    case "cancelled":
    case "refusal":
      return s;
    default:
      return "other";
  }
}

function paths(u: any): string[] | undefined {
  const out = new Set<string>();
  for (const l of u.locations ?? []) if (l?.path) out.add(l.path);
  for (const c of u.content ?? []) if (c?.type === "diff" && c.path) out.add(c.path);
  return out.size ? [...out] : undefined;
}

/** The whole result of a tool call: text content, unified-style diffs, raw output. Uncut. */
function full(u: any): { output?: string } {
  const parts: string[] = [];
  for (const c of u.content ?? []) {
    if (c?.type === "content" && c.content?.type === "text") parts.push(c.content.text);
    else if (c?.type === "diff") parts.push(simpleDiff(c.path, c.oldText, c.newText));
  }
  if (!parts.length && u.rawOutput !== undefined) parts.push(typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput));
  return parts.length ? { output: parts.join("\n") } : {};
}

/** A minimal line diff for ACP diff content (old/new file text): changed region with context. */
export function simpleDiff(path: string, oldText: string | null | undefined, newText: string): string {
  const a = (oldText ?? "").split("\n");
  const b = (newText ?? "").split("\n");
  if (!oldText) return [`--- /dev/null`, `+++ ${path}`, ...b.map((l) => `+${l}`)].join("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1, eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  const ctx = 2, from = Math.max(0, s - ctx);
  const lines = [`--- ${path}`, `+++ ${path}`, `@@ line ${from + 1} @@`];
  for (let i = from; i < s; i++) lines.push(` ${a[i]}`);
  for (let i = s; i <= ea; i++) lines.push(`-${a[i]}`);
  for (let i = s; i <= eb; i++) lines.push(`+${b[i]}`);
  for (let i = ea + 1; i <= Math.min(a.length - 1, ea + ctx); i++) lines.push(` ${a[i]}`);
  return lines.join("\n");
}

function summarize(u: any): string | undefined {
  const parts: string[] = [];
  if (u.locations?.length) parts.push(u.locations.map((l: any) => l.path).join(", "));
  if (u.content?.length) {
    for (const c of u.content) {
      if (c.type === "content" && c.content?.type === "text") parts.push(c.content.text.slice(0, 400));
      else if (c.type === "diff") parts.push(`diff ${c.path}`);
      else if (c.type === "terminal") parts.push(`terminal ${c.terminalId}`);
    }
  }
  return parts.length ? parts.join("\n").slice(0, 1200) : undefined;
}

/** Human-readable view of a tool's raw input: `key: value` lines, long values clipped. */
function formatInput(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return String(raw).slice(0, 800);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 6)) {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    if (val === undefined) continue;
    lines.push(`${k}: ${val.length > 300 ? val.slice(0, 297) + "…" : val}`);
  }
  return lines.join("\n") || undefined;
}

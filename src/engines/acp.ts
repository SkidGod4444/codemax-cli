import { debugEvent, debugOnce } from "../core/debuglog.ts";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { insideDir, secretPlace } from "../core/paths.ts";
import { ClientSideConnection, ndJsonStream, RequestError, type Client, type Stream } from "@agentclientprotocol/sdk";
import type { AgentId } from "../adapters/types.ts";
import type { Engine, EngineEvent, EngineInfo, EngineOption, EngineSessionRef, EngineStartOptions, PermissionRequest, PlanLimit, PromptImage, QuestionAnswer, RewindPoint, StopReason } from "./types.ts";
import { elicitationResponse, parseElicitation } from "./elicitation.ts";
import { agentEnv } from "./env.ts";
import { GROUP_SPAWN, IS_WINDOWS, killTree, platformArgv, trackChild } from "../core/spawn.ts";
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
  /**
   * The agent forks a session at one of its messages (`session/fork` with the
   * `jetbrains.air.fork` point, the Claude adapter), so /rewind can cut the conversation too.
   */
  forkAtMessage?: boolean;
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
 * over stdio: Claude Code (via the Zed adapter), OpenCode, Grok, Cursor, Antigravity.
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
  /** Diffs a tool call carried before its permission request (Claude sends the tool call first). */
  private toolDiffs = new Map<string, string>();
  private cwd = "";
  private turnActive = false;
  private tail: { read(): UsageSample[] } | null = null;
  private lastAgentCost = 0;
  /** The agent reports its own cost (Claude, OpenCode): token records are then counted, not priced again. */
  private reportsCost = false;
  /** Agents that expose model/mode as ACP config options (OpenCode) are switched through them. */
  private configIds: { model?: string; mode?: string } = {};
  /** Context fill from the latest usage_update this turn; a token fallback for agents with no usage. */
  private turnContext = 0;
  /** /rewind can fork this agent's session at a message. */
  private canFork = false;
  /** The agent accepts images in a prompt. */
  private takesImages = false;
  /**
   * The latest agent message id in this session, and whether the last prompt produced one
   * and ended cleanly (a turn cut off mid-tool can end on a tool call with no result,
   * which is no place to resume a conversation from).
   */
  private lastMessageId: string | null = null;
  private idStale = false;
  /** A new session with nothing in it yet (rewinding to "before anything" is then a new session). */
  private fresh = false;

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
      // Form questions open codemax's dialog; a URL one (an MCP server's sign-in) opens the browser when you asked for it.
      createElicitation: (p) => this.onElicitation(p) as any,
      completeElicitation: async (p: any) => {
        const server = this.urlServers.get(String(p?.elicitationId)) ;
        this.urlServers.delete(String(p?.elicitationId));
        this.emit({ type: "url_done", id: String(p?.elicitationId), server, ok: true });
      },
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
      // Inside the project these work as the agent's own tools do; outside it you are asked first.
      readTextFile: async (p) => {
        await this.allowOutside("read", p.path);
        return { content: await Bun.file(p.path).text() };
      },
      writeTextFile: async (p) => {
        await this.allowOutside("write", p.path, p.content);
        await Bun.write(p.path, p.content);
        return {};
      },
    };
    this.conn = new ClientSideConnection(() => client, stream);
    this.instructions = o.instructions?.trim() || undefined;
    this.shared = o.mcpServers ?? [];
    this.mcpDisabled = new Set(o.mcpDisabled ?? []);
    const init = await this.conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, session: { notices: {} }, elicitation: { url: {}, ...(o.questions === false ? {} : { form: {} }) } } });

    let sessionId: string;
    let modes: any;
    let models: any;
    let config: any;
    if (o.resume) {
      try {
        const r: any = await this.signedIn(init, () => this.conn!.loadSession({ sessionId: o.resume!.id, cwd: o.cwd, mcpServers: this.mcpServers(init), ...this.systemPrompt(init) } as any));
        sessionId = o.resume.id;
        modes = r?.modes;
        models = r?.models;
        config = r?.configOptions;
      } catch (e: any) {
        this.emit({ type: "log", level: "warn", message: `resume failed (${e?.message ?? e}); starting a new session` });
        const s: any = await this.signedIn(init, () => this.conn!.newSession({ cwd: o.cwd, mcpServers: this.mcpServers(init), ...this.systemPrompt(init) } as any));
        sessionId = s.sessionId;
        config = s.configOptions;
        modes = s.modes;
        models = s.models;
      }
    } else {
      const s: any = await this.signedIn(init, () => this.conn!.newSession({ cwd: o.cwd, mcpServers: this.mcpServers(init), ...this.systemPrompt(init) } as any));
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
    this.cwd = o.cwd;
    this.canFork = !!this.opts.forkAtMessage && !!(init as any).agentCapabilities?.sessionCapabilities?.fork;
    {
      // What this agent says it supports (debug log): explains most "works for X, not Y" bugs.
      const caps: any = (init as any).agentCapabilities ?? {};
      debugEvent("acp-init", {
        agent: this.agent,
        protocol: (init as any).protocolVersion,
        agentInfo: [(init as any).agentInfo?.name, (init as any).agentInfo?.version].filter(Boolean).join(" ") || undefined,
        capabilities: Object.keys(caps).filter((k) => k !== "_meta"),
        session: Object.keys(caps.sessionCapabilities ?? {}),
        prompt: Object.keys(caps.promptCapabilities ?? {}).filter((k) => caps.promptCapabilities[k]),
        auth: ((init as any).authMethods ?? []).map((m: any) => m.id),
        resumed: !!o.resume && sessionId === o.resume.id,
        resumeAsked: !!o.resume || undefined,
        models: models?.availableModels?.length,
        modes: (modes?.availableModes ?? []).map((m: any) => m.id),
        configOptions: Array.isArray(config) ? config.map((c: any) => c?.id) : undefined,
      });
    }
    this.takesImages = !!(init as any).agentCapabilities?.promptCapabilities?.image;
    this.fresh = !o.resume || sessionId !== o.resume.id;
    this.session = { agent: this.agent, id: sessionId, cwd: o.cwd, startedAt: Date.now(), lastUsedAt: Date.now() };
    this.tail = this.opts.usageTail?.(this.session) ?? null;
    if (o.resume && this.tail) this.tail.read(); // skip history already accounted for
    if (o.resume && sessionId === o.resume.id) this.lastAgentCost = Math.max(0, o.costBaseline ?? 0);
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
    const proc = trackChild(Bun.spawn(argv, { ...GROUP_SPAWN, cwd, env: agentEnv(this.opts.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
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

  /**
   * The agent reads or writes a file through codemax (ACP fs). Inside the project this is
   * the agent's own business. Outside it, a write always needs your yes (with the change
   * shown), whatever the agent decided; a read needs it only where secrets live (secretPlace),
   * so unattended runs reading a sibling repo or a package's source don't stop.
   */
  private async allowOutside(kind: "read" | "write", path: string, content?: string) {
    if (insideDir(this.cwd, path)) return;
    const secret = secretPlace(path);
    if (kind === "read" && !secret) return;
    const id = `perm-${++this.permSeq}`;
    let old: string | null = null;
    if (kind === "write") old = await Bun.file(path).text().catch(() => null);
    const request: PermissionRequest = {
      id,
      kind: kind === "write" ? "edit" : "read",
      title: `${kind === "write" ? (old === null ? "Create" : "Edit") : "Read"} outside this project: ${path}`,
      detail: secret ? `This is ${secret}.` : undefined,
      diff: kind === "write" ? simpleDiff(path, old, content ?? "") : undefined,
      options: [
        { id: "allow", label: "Allow once", kind: "allow_once" },
        { id: "reject", label: "Deny", kind: "reject_once" },
      ],
    };
    const choice = await new Promise<string | null>((resolve) => {
      this.pendingPermissions.set(id, resolve);
      this.emit({ type: "permission_request", request });
    });
    this.pendingPermissions.delete(id);
    // A request error carries the reason to the agent (a plain Error arrives as "Internal error").
    if (choice !== "allow") throw RequestError.invalidRequest({ path }, `The user did not allow ${kind === "write" ? "writing" : "reading"} ${path}, which is outside the project.`);
  }

  private async onPermission(p: any) {
    const id = `perm-${++this.permSeq}`;
    const request: PermissionRequest = {
      id,
      toolCallId: p.toolCall?.toolCallId,
      kind: p.toolCall?.kind,
      title: p.toolCall?.title ?? p.toolCall?.toolCallId ?? "tool",
      detail: formatInput(p.toolCall?.rawInput),
      diff: contentDiff(p.toolCall?.content, this.cwd) ?? this.toolDiffs.get(p.toolCall?.toolCallId) ?? inputDiff(p.toolCall?.rawInput, this.cwd),
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
        this.noteMessageId(u.messageId);
        if (this.capture && u.content?.type === "text") this.capture.push(u.content.text);
        else if (u.content?.type === "text") this.emit({ type: "text_delta", text: u.content.text, messageId: u.messageId });
        break;
      case "agent_thought_chunk":
        this.noteMessageId(u.messageId);
        if (u.content?.type === "text") this.emit({ type: "thought_delta", text: u.content.text, messageId: u.messageId });
        break;
      case "tool_call": {
        this.rememberDiff(u);
        this.trackSubagent(u, true);
        // An agent's own todo tool (OpenCode's todowrite, Cursor's updateTodos, Grok's and
        // Antigravity's task lists) is its plan: shown as the task list, as the Claude adapter
        // already does for TodoWrite, never as a tool row.
        // Live, the first call often carries no list yet (Cursor's `{_toolName: "updateTodos"}`,
        // OpenCode's `todowrite` with `{}`); the update brings it. The row is skipped either way.
        const todo = todoPlan(u.rawInput, u.title);
        if (todo || isTodoTool(u.rawInput, u.title)) {
          this.planTools.add(u.toolCallId);
          debugEvent("todo-plan", { agent: this.agent, entries: todo?.length ?? 0 });
          if (todo) this.emit({ type: "plan", entries: todo });
          break;
        }
        this.emit({ type: "tool_call", id: u.toolCallId, title: u.title ?? u.toolCallId, kind: u.kind, status: mapStatus(u.status), detail: summarize(u), input: u.rawInput, files: paths(u), ...full(u) });
        break;
      }
      case "tool_call_update": {
        this.rememberDiff(u);
        this.trackSubagent(u, false);
        if (this.planTools.has(u.toolCallId)) {
          const todo = todoPlan(u.rawInput, u.title);
          if (todo) {
            debugEvent("todo-plan", { agent: this.agent, entries: todo.length, update: true });
            this.emit({ type: "plan", entries: todo });
          }
          break;
        }
        this.emit({ type: "tool_update", id: u.toolCallId, status: u.status ? mapStatus(u.status) : undefined, title: u.title, detail: summarize(u), input: u.rawInput, files: paths(u), ...full(u) });
        break;
      }
      case "plan":
        this.emit({ type: "plan", entries: (u.entries ?? []).map((e: any) => ({ content: e.content, status: e.status, priority: e.priority })) });
        break;
      case "current_mode_update":
        this.emit({ type: "mode", modeId: u.currentModeId });
        break;
      case "config_option_update": {
        // An agent whose modes and models are config options (Cursor, OpenCode) reports changes here.
        const opts: any[] = Array.isArray(u.configOptions) ? u.configOptions : u.configOption ? [u.configOption] : [];
        for (const c of opts) {
          if (!c?.id) continue;
          if (c.id === this.configIds.mode && typeof c.currentValue === "string") {
            if (this.info) this.info.currentMode = c.currentValue;
            this.emit({ type: "mode", modeId: c.currentValue });
          } else if (c.id === this.configIds.model && typeof c.currentValue === "string") {
            if (this.info) this.info.currentModel = c.currentValue;
          } else {
            const o = this.info?.options?.find((x) => x.id === c.id);
            if (o && typeof c.currentValue === "string") o.current = c.currentValue;
          }
        }
        debugEvent("acp-config-update", { agent: this.agent, ids: opts.map((c) => c?.id) });
        break;
      }
      case "available_commands_update":
        this.emit({ type: "commands", commands: (u.availableCommands ?? []).map((c: any) => ({ name: c.name, description: c.description })) });
        break;
      case "notice":
        // Warnings the agent would show its own users (retries, model fallback); advertised so
        // they arrive as notices instead of bold lines mixed into the reply.
        this.emit({ type: "notice", level: u.severity === "error" ? "error" : u.severity === "info" ? "info" : "warn", title: String(u.title ?? "notice"), detail: u.description ? String(u.description) : undefined });
        break;
      case "usage_update": {
        // ACP: `used`/`size` describe context fill; `cost` is the session's running total.
        const total = typeof u.cost?.amount === "number" ? u.cost.amount : undefined;
        // The total covers the whole session, earlier runs included: only what it added since the
        // last figure (or since the one recorded before a restart) is new. A lower total means
        // the agent started counting again.
        const delta = total !== undefined ? (total >= this.lastAgentCost ? total - this.lastAgentCost : total) : undefined;
        if (total !== undefined) {
          this.lastAgentCost = total;
          this.reportsCost = true;
        }
        // `used` is how full the context window is, not tokens spent: it feeds the context meter.
        // Token counts come from the prompt response (or session files) at turn end.
        if (typeof u.used === "number") this.turnContext = u.used;
        this.emit({ type: "usage", contextUsed: u.used, contextSize: u.size, costUsd: delta, agentTotalUsd: total, model: this.currentModelName(), planLimits: planLimitsOf(u) });
        break;
      }
      default:
        // Something this agent sends that codemax does not show (a new protocol feature?).
        debugOnce(`acp:${this.agent}:${u.sessionUpdate}`, "acp-unknown-update", { agent: this.agent, type: String(u.sessionUpdate) });
        break;
    }
  }

  private noteMessageId(id: unknown) {
    if (typeof id !== "string" || !id) return;
    this.lastMessageId = id;
    this.idStale = false;
  }

  /**
   * Images as ACP image content, when the agent takes images (promptCapabilities.image) and
   * the file is small enough to send (5 MB, what the models accept). Otherwise the message
   * already names the file, and the agent can open it itself.
   */
  private async imageBlocks(images: PromptImage[]): Promise<any[]> {
    if (!images.length || !this.takesImages) return [];
    const out: any[] = [];
    for (const im of images) {
      const f = Bun.file(im.path);
      if (!(await f.exists()) || f.size > 5 * 1024 * 1024) continue;
      out.push({ type: "image", mimeType: im.mimeType, data: Buffer.from(await f.arrayBuffer()).toString("base64"), uri: `file://${im.path}` });
    }
    return out;
  }

  rewindPoint(): RewindPoint | null {
    if (!this.canFork || !this.session || this.turnActive || this.idStale) return null;
    // Before anything was said, "back to here" is an empty conversation; a resumed one has no known start.
    if (!this.lastMessageId && !this.fresh) return null;
    return { sessionId: this.session.id, messageId: this.lastMessageId };
  }

  private instructions?: string;
  /** The agent takes client instructions on session requests (ACP `sessionCapabilities.systemPrompt`). */
  private systemPromptSlot = false;
  private initResult: any;

  private shared: import("../core/share.ts").SharedMcpServer[] = [];

  /**
   * The shared MCP servers in ACP's shape, for session requests. Stdio servers always (every ACP
   * agent takes them); http / sse only when the agent's mcpCapabilities say so.
   */
  private mcpDisabled = new Set<string>();
  /** Text of a reply being captured instead of shown (the adapter's own `/mcp` answers). */
  private capture: string[] | null = null;

  /** This agent reports MCP status and takes MCP actions through the Claude ACP adapter's `/mcp` prompt. */
  private get hasMcpCommand(): boolean {
    return this.agent === "claude";
  }

  /**
   * A prompt the agent answers itself, shown to nobody: the Claude adapter replies to `/mcp …`
   * with status Markdown without calling the model. The reply text comes back here.
   */
  private async hiddenPrompt(text: string, timeoutMs = 40_000): Promise<string> {
    if (!this.conn || !this.session) throw new Error("engine not started");
    if (this.turnActive) throw new Error("the agent is working");
    this.capture = [];
    this.turnActive = true;
    try {
      await Promise.race([
        this.conn.prompt({ sessionId: this.session.id, prompt: [{ type: "text", text }] }),
        Bun.sleep(timeoutMs).then(() => {
          throw new Error("no answer in time");
        }),
      ]);
      return this.capture.join("").trim();
    } finally {
      this.turnActive = false;
      this.capture = null;
    }
  }

  async mcpStatus() {
    if (!this.hasMcpCommand) return null;
    const { parseClaudeMcpMarkdown } = await import("../core/mcpstatus.ts");
    const text = await this.hiddenPrompt("/mcp", 15_000);
    const parsed = parseClaudeMcpMarkdown(text);
    if (!parsed) debugEvent("mcp-status-unparsed", { agent: this.agent, chars: text.length });
    return parsed;
  }

  async mcpAction(action: import("./types.ts").McpAction, name: string, config?: import("../core/share.ts").SharedMcpServer): Promise<string> {
    if (action === "authenticate") {
      // The adapter starts a sign-in (a URL elicitation) only for servers passed over ACP, at
      // session setup. So the server goes into the list (its own config, when it is the agent's
      // own), and the session is loaded again. Verified live: the authorize URL arrives.
      if (!this.shared.some((s) => s.name === name)) {
        if (!config) throw new Error(`codemax has no setup for ${name} to start its sign-in with`);
        this.shared = [...this.shared, config];
      }
      this.authWanted.add(name);
      this.mcpDisabled.delete(name);
      // An http/sse server only goes over to an agent that takes them (mcpCapabilities); otherwise nothing would happen.
      if (!this.mcpServers(this.initResult).some((s: any) => s.name === name)) throw new Error(`${this.opts.name} does not take this kind of MCP server over its protocol, so codemax cannot start its sign-in; sign in inside ${this.opts.name} itself once`);
      await this.reloadMcp(this.shared, [...this.mcpDisabled]);
      return `sign-in started for ${name}: finish it in your browser`;
    }
    if (!this.hasMcpCommand) throw new Error(`${this.opts.name} has no MCP commands over its protocol`);
    const verb = action;
    const text = await this.hiddenPrompt(`/mcp ${verb} ${name}`);
    return text.split(/\n\s*\n/)[0]!.replace(/\*\*/g, "").replace(/`/g, "").trim() || `${verb} sent`;
  }

  async reloadMcp(servers: import("../core/share.ts").SharedMcpServer[], disabled: string[]) {
    if (!this.conn || !this.session) throw new Error("engine not started");
    if (!(this.initResult as any)?.agentCapabilities?.loadSession) throw new Error(`${this.opts.name} cannot reload a session; /switch ${this.agent} restarts it`);
    this.shared = servers;
    this.mcpDisabled = new Set(disabled);
    const t0 = Date.now();
    await this.conn.loadSession({ sessionId: this.session.id, cwd: this.cwd, mcpServers: this.mcpServers(this.initResult), ...this.systemPrompt(this.initResult) } as any);
    debugEvent("mcp-reload", { agent: this.agent, servers: servers.length, disabled: disabled.length || undefined, ms: Date.now() - t0 });
  }

  private mcpServers(init: any): any[] {
    const caps = init?.agentCapabilities?.mcpCapabilities ?? {};
    const out: any[] = [];
    let dropped = 0;
    for (const s of this.shared) {
      if (this.mcpDisabled.has(s.name)) continue;
      const t = s.transport;
      if (t.type === "stdio") out.push({ name: s.name, command: t.command, args: t.args, env: Object.entries(t.env).map(([name, value]) => ({ name, value })) });
      else if (caps[t.type]) out.push({ type: t.type, name: s.name, url: t.url, headers: Object.entries(t.headers).map(([name, value]) => ({ name, value })) });
      else dropped++;
    }
    if (this.shared.length) debugEvent("shared-mcp-given", { agent: this.agent, servers: out.length, dropped: dropped || undefined, http: !!caps.http, sse: !!caps.sse });
    return out;
  }

  /** `systemPrompt` for a session request: only to an agent that advertises it (the spec requires that). */
  private systemPrompt(init: any): { systemPrompt?: unknown } {
    this.initResult = init;
    this.systemPromptSlot = !!init?.agentCapabilities?.sessionCapabilities?.systemPrompt;
    if (!this.instructions || !this.systemPromptSlot) return {};
    return { systemPrompt: { mode: "append", content: [{ type: "text", text: this.instructions }] } };
  }

  async rewindConversation(point: RewindPoint) {
    if (!this.conn || !this.session || !this.canFork) throw new Error(`${this.opts.name} cannot rewind its conversation`);
    if (point.sessionId !== this.session.id) throw new Error("that message is in an earlier session");
    const old = this.session.id;
    const { currentModel, currentMode } = this.info ?? {};
    const r: any = point.messageId
      ? await this.conn.unstable_forkSession({ sessionId: old, cwd: this.cwd, mcpServers: this.mcpServers(this.initResult), ...this.systemPrompt(this.initResult), _meta: { jetbrains: { air: { fork: { version: 1, messageId: point.messageId } } } } } as any)
      : await this.conn.newSession({ cwd: this.cwd, mcpServers: this.mcpServers(this.initResult), ...this.systemPrompt(this.initResult) } as any);
    this.session = { agent: this.agent, id: r.sessionId, cwd: this.cwd, startedAt: Date.now(), lastUsedAt: Date.now() };
    this.lastMessageId = point.messageId;
    this.idStale = false;
    this.fresh = !point.messageId;
    // The copy's usage was counted in the original session.
    this.lastAgentCost = 0;
    this.tail = this.opts.usageTail?.(this.session) ?? null;
    this.tail?.read();
    this.emit({ type: "session", ref: this.session });
    await this.conn.closeSession?.({ sessionId: old }).catch(() => {});
    // A fork keeps the transcript's model and mode; a new session starts on the defaults.
    const nowModel = r.models?.currentModelId;
    const nowMode = r.modes?.currentModeId;
    if (currentModel && nowModel && nowModel !== currentModel) await this.setModel(currentModel).catch(() => {});
    if (currentMode && nowMode && nowMode !== currentMode) await this.setMode(currentMode).catch(() => {});
  }

  async prompt(text: string, images: PromptImage[] = []): Promise<StopReason> {
    if (!this.conn || !this.session) throw new Error("engine not started");
    // An agent with no instruction slot gets them once, ahead of a new session's first message.
    if (this.fresh && this.instructions && !this.systemPromptSlot) text = `${this.instructions}\n\n${text}`;
    this.turnActive = true;
    this.idStale = true;
    this.fresh = false;
    this.cancelled = false;
    this.turnContext = 0;
    try {
      const res: any = await this.conn.prompt({ sessionId: this.session.id, prompt: [{ type: "text", text }, ...(await this.imageBlocks(images))] });
      this.session.lastUsedAt = Date.now();
      this.flushUsage();
      this.emitTurnUsage(res?.usage);
      // Some agents (Antigravity) end an interrupted turn with "end_turn": it was still cancelled.
      const reason = this.cancelled ? "cancelled" : mapStop(res.stopReason);
      if (reason !== "end_turn") this.idStale = true;
      this.emit({ type: "turn_end", stopReason: reason });
      return reason;
    } catch (e: any) {
      const message = e?.message ?? String(e);
      const data = JSON.stringify(e?.data ?? "");
      const kind = classifyError(`${message} ${data}`);
      this.emit({ type: "error", kind, message: `${message} ${data}`.trim() });
      this.idStale = true;
      this.emit({ type: "turn_end", stopReason: "error" });
      return "error";
    } finally {
      this.turnActive = false;
      // Subagents end with their turn (the panel marks them done): forget their launches.
      this.subagentLaunches.clear();
    }
  }

  answerPermission(requestId: string, optionId: string) {
    this.pendingPermissions.get(requestId)?.(optionId);
  }

  answerQuestion(requestId: string, answer: QuestionAnswer) {
    this.pendingQuestions.get(requestId)?.(answer);
  }

  /** Launch tool call id → whether it runs in the background (its "completed" only means launched). */
  private rememberDiff(u: any) {
    const d = contentDiff(u.content, this.cwd);
    if (!d || !u.toolCallId) return;
    this.toolDiffs.set(u.toolCallId, d);
    if (this.toolDiffs.size > 200) this.toolDiffs.delete(this.toolDiffs.keys().next().value!);
  }

  private subagentLaunches = new Map<string, { background: boolean; ids?: string[] }>();

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
      for (const sub of launch.ids ?? [id]) {
        if (st === "failed") this.emit({ type: "subagent", id: sub, status: "failed" });
        else if (st === "completed" && !launch.background) this.emit({ type: "subagent", id: sub, status: "done" });
      }
      return;
    }
    if (!isNew) return;
    const input = u.rawInput ?? {};
    const title = String(u.title ?? "");
    const tool = String(meta.toolName ?? input._toolName ?? "");
    // Antigravity: one invoke_subagent call starts each entry of `Subagents` ({ Role, Prompt, TypeName }).
    // The call completes as soon as they are started and they send nothing of their own, so they
    // count as running until the turn ends (the main agent waits for their replies within it).
    if (Array.isArray(input.Subagents) && /invoke_subagent/i.test(`${tool} ${title}`)) {
      const ids = input.Subagents.map((_: unknown, i: number) => `${id}:${i}`);
      this.subagentLaunches.set(id, { background: true, ids });
      input.Subagents.forEach((sub: any, i: number) => {
        const type = typeof sub?.TypeName === "string" && sub.TypeName !== "self" ? sub.TypeName : "subagent";
        const task = String(sub?.Role ?? sub?.Prompt ?? "").replace(/\s+/g, " ").trim();
        this.emit({ type: "subagent", id: ids[i]!, name: type, task: task || undefined, status: "running" });
      });
      return;
    }
    const type = input.subagent_type ?? input.subagentType;
    // Claude's Agent/Task, OpenCode's task, Cursor's "Task: …", Grok's spawn_subagent (its persona is the kind of agent).
    const isLaunch = /^(agent|task|spawn_subagent)$/i.test(tool) || typeof type === "string" || /^Task: /.test(title) || /spawn_subagent/i.test(title);
    if (!isLaunch || !(input.prompt || input.description || type)) return;
    this.subagentLaunches.set(id, { background: !!(input.run_in_background ?? input.background) });
    const name = typeof type === "string" && type ? type : typeof input.persona === "string" && input.persona ? input.persona : input.name ?? "agent";
    const task = input.description ?? (/spawn_subagent/i.test(title) ? undefined : title.replace(/^Task: /, "")) ?? String(input.prompt ?? "").split("\n")[0];
    this.emit({ type: "subagent", id, name, task, status: "running" });
  }

  /** A spawned agent's own session (agents that run subagents as sessions). */
  private onChildSession(sessionId: string, u: any) {
    if (u?.sessionUpdate === "tool_call" && u.title) this.emit({ type: "subagent", id: sessionId, activity: String(u.title) });
  }

  /** Tool calls that were the agent's todo list (shown as the plan), so their updates stay off the transcript. */
  private planTools = new Set<string>();
  /** Servers whose sign-in you asked for (/mcp → Authenticate): their URL is opened; others are only mentioned. */
  private authWanted = new Set<string>();
  private urlServers = new Map<string, string | undefined>();

  private async onElicitation(p: any) {
    if (p?.mode === "url" && typeof p.url === "string") {
      // The Claude adapter: "Authenticate with MCP server <name>", a URL, and a completion notice later.
      const server = String(p.message ?? "").match(/MCP server (.+?)\.?$/)?.[1];
      const auto = !!server && this.authWanted.has(server);
      const id = String(p.elicitationId ?? `url-${++this.permSeq}`);
      this.urlServers.set(id, server);
      debugEvent("url-elicitation", { agent: this.agent, server, auto });
      this.emit({ type: "open_url", id, url: p.url, message: p.message ? String(p.message) : undefined, server, auto });
      // Accepted when opened: the agent then waits for the sign-in to finish. Declined otherwise, so it does not wait on nothing.
      return { action: auto ? "accept" : "decline" };
    }
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
        this.emit({ type: "usage", inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: n(u.cachedWriteTokens ?? u.cacheWriteTokens), model: this.currentModelName(), costCovered: this.reportsCost || undefined });
        return;
      }
    }
    if (this.turnContext > 0) this.emit({ type: "usage", inputTokens: this.turnContext, model: this.currentModelName() });
  }

  /** Emit usage appended to the agent's session files since the last check. */
  flushUsage() {
    if (!this.tail) return;
    try {
      // When the agent also reports cost over ACP, that figure counts and the file's is not added again.
      for (const s of this.tail.read()) this.emit({ type: "usage", inputTokens: s.input, outputTokens: s.output, cacheReadTokens: s.cacheRead, cacheWriteTokens: s.cacheWrite, model: s.model, costUsd: this.reportsCost ? undefined : s.costUsd, costCovered: this.reportsCost || undefined });
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
    // The agent may take its time to close a session: half a second, then it is stopped anyway.
    if (conn && this.session) await Promise.race([conn.closeSession?.({ sessionId: this.session.id }).catch(() => {}), Bun.sleep(500)]);
    if (this.proc) {
      try {
        // End of input first: an agent behind plain pipes (and its `cat`s) exits on EOF.
        (this.proc.stdin as any)?.end?.();
      } catch {
        /* already closed */
      }
      // The whole group: the agent and whatever it started (shells, dev servers).
      killTree(this.proc);
      await Promise.race([this.proc.exited, Bun.sleep(1500)]);
      killTree(this.proc, "SIGKILL");
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
  // The empty "line" after a final newline is not a line.
  const lines_ = (t: string) => (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
  const a = lines_(oldText ?? "");
  const b = lines_(newText ?? "");
  if (!oldText) return [`--- /dev/null`, `+++ ${path}`, ...b.map((l) => `+${l}`)].join("\n");
  if (oldText === newText) return `--- ${path}\n+++ ${path}\n(no change: the file already has this content)`;
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

/** The diff entries of ACP tool-call content, as one unified-style diff; undefined when there are none. */
export function contentDiff(content: unknown, cwd = ""): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((c: any) => c?.type === "diff" && c.path).map((c: any) => simpleDiff(shownPath(c.path, cwd), c.oldText, c.newText ?? ""));
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * A diff rebuilt from an edit tool's raw input, for agents whose permission
 * request carries no diff: Claude-style Edit / MultiEdit / Write and
 * OpenCode-style edit / write (camelCase keys). Undefined for anything else.
 */
export function inputDiff(raw: any, cwd = ""): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const path: unknown = raw.file_path ?? raw.filePath ?? raw.path;
  if (typeof path !== "string" || !path) return undefined;
  const abs = isAbsolute(path) || !cwd ? path : join(cwd, path);
  const current = (() => {
    try {
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    } catch {
      return null;
    }
  })();
  const shown = shownPath(abs, cwd);
  const edits: { old: string; new: string }[] = Array.isArray(raw.edits)
    ? raw.edits.map((e: any) => ({ old: String(e.old_string ?? e.oldString ?? ""), new: String(e.new_string ?? e.newString ?? "") }))
    : typeof (raw.old_string ?? raw.oldString) === "string"
      ? [{ old: String(raw.old_string ?? raw.oldString), new: String(raw.new_string ?? raw.newString ?? "") }]
      : [];
  if (edits.length) {
    const out = [`--- ${shown}`, `+++ ${shown}`];
    for (const e of edits) {
      const at = current && e.old ? current.indexOf(e.old) : -1;
      out.push(at >= 0 ? `@@ line ${current!.slice(0, at).split("\n").length} @@` : "@@");
      if (e.old) out.push(...e.old.split("\n").map((l) => `-${l}`));
      if (e.new) out.push(...e.new.split("\n").map((l) => `+${l}`));
    }
    return out.join("\n");
  }
  const content = raw.content ?? raw.contents;
  if (typeof content === "string") return simpleDiff(shown, current, content);
  return undefined;
}

/** A path inside the project as a relative one, for diff headers. */
function shownPath(path: string, cwd: string): string {
  return cwd && isAbsolute(path) && path.startsWith(cwd + sep) ? relative(cwd, path) : path;
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

/**
 * A todo tool's input as plan entries, or null when the input is not a todo list. Accepts the
 * shapes seen live: OpenCode `todos: [{content, status, priority}]`, Cursor `todos:
 * [{id, content, status: "TODO_STATUS_IN_PROGRESS"}]`, and `tasks`/`items` with `title` or
 * `description` instead of `content`. Statuses come back as Claude Code's words.
 */
export function todoPlan(input: any, title?: string): { content: string; status: string; priority?: string }[] | null {
  // `todos` is always a todo list; `tasks` / `items` only on a tool named for it (an MCP tool
  // creating issues with `items: [{title, status}]` is a real tool call and keeps its row).
  const list = input?.todos ?? (isTodoTool(input, title) ? input?.tasks ?? input?.items : undefined);
  if (!Array.isArray(list) || !list.length || !list.every((t) => t && typeof t === "object" && (t.content || t.title || t.description || t.text) && typeof t.status === "string")) return null;
  return list.map((t: any) => {
    const raw = String(t.status).toLowerCase().replace(/^todo_status_/, "").replace(/-/g, "_");
    const status = /complete|done/.test(raw) ? "completed" : /progress|active|doing/.test(raw) ? "in_progress" : /cancel/.test(raw) ? "cancelled" : "pending";
    return { content: String(t.content ?? t.title ?? t.description ?? t.text), status, priority: typeof t.priority === "string" ? t.priority : undefined };
  });
}

/** A tool that is the agent's todo list, by name: Cursor's updateTodos, OpenCode's todowrite ("5 todos" titles), Claude's TodoWrite, task-list tools. */
export function isTodoTool(input: any, title?: string): boolean {
  const name = String(input?._toolName ?? input?.toolName ?? "");
  const t = String(title ?? "");
  return /^(update_?todos?|todo_?write|task_?list|update_?plan)$/i.test(name) || /^(todo_?write|update todos?\b|\d+ todos?$|task_?list)/i.test(t);
}

import { debugEvent, debugOnce } from "../core/debuglog.ts";
import type { AgentId } from "../adapters/types.ts";
import type { Engine, EngineEvent, EngineInfo, EngineOption, EngineSessionRef, EngineStartOptions, PermissionRequest, PromptImage, QuestionAnswer, QuestionRequest, RewindPoint, StopReason, ToolStatus } from "./types.ts";
import { elicitationResponse, parseElicitation } from "./elicitation.ts";
import { agentEnv } from "./env.ts";
import { GROUP_SPAWN, killTree, platformArgv, trackChild } from "../core/spawn.ts";
import { classifyError } from "./errors.ts";
import pkg from "../../package.json" with { type: "json" };

export interface CodexEngineOptions {
  /** Command for the app server. Default: codex app-server. */
  cmd?: string[];
  /** Tests inject a transport instead of spawning. */
  transport?: { send(line: string): void; onLine(cb: (line: string) => void): void; close(): Promise<void> };
}

/**
 * Codex engine over the native `codex app-server` JSON-RPC protocol (the one
 * Codex's own IDE extension uses). Works with ChatGPT-plan login. Approvals
 * arrive as server→client requests and are answered through
 * `answerPermission`.
 */
export class CodexEngine implements Engine {
  /** Models this account can use, from `model/list`. */
  private catalog: { id: string; name: string; efforts: string[]; defaultEffort?: string }[] = [];
  /** Reasoning effort chosen with /effort (sent with each turn); undefined = the model's default. */
  private effort: string | undefined;
  readonly agent: AgentId = "codex";
  info: EngineInfo | null = null;
  session: EngineSessionRef | null = null;
  private listeners = new Set<(e: EngineEvent) => void>();
  private proc: Bun.Subprocess | null = null;
  private transport: NonNullable<CodexEngineOptions["transport"]> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private pendingApprovals = new Map<string, { rpcId: number | string; method: string }>();
  private permSeq = 0;
  /** fileChange items by id: their approval request carries only the item id. */
  private fileChanges = new Map<string, any[]>();
  private turn: { resolve: (r: StopReason) => void; id?: string } | null = null;
  private threadId: string | null = null;
  /** Questions waiting for an answer: Codex's request_user_input, or an MCP server's form. */
  private pendingQuestions = new Map<string, { rpcId: number | string; kind: "input" | "mcp"; questions?: any[] }>();
  /**
   * Let Codex ask questions in its default mode: the `default_mode_request_user_input`
   * feature, which Codex marks under development. Only with /config → Agent questions on;
   * a Codex that rejects the setting gets a session without it.
   */
  private questions = false;
  /** The latest turn on this thread (a /rewind point), and whether the thread is still empty. */
  private lastTurnId: string | null = null;
  private fresh = false;
  /** A rewind is replacing the thread: its new thread's events are not a spawned agent's. */
  private replacing = false;
  private cwd = "";
  private model: string | undefined;
  /** Cumulative token totals per thread (the main one and each spawned agent's), to emit deltas. */
  private lastTotals = new Map<string, { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number }>();
  /** Threads (rewind forks) whose totals are not ours to diff against yet. */
  private newTotals = new Set<string>();

  constructor(private opts: CodexEngineOptions = {}) {}

  onEvent(listener: (e: EngineEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(e: EngineEvent) {
    for (const l of this.listeners) l(e);
  }

  async start(o: EngineStartOptions): Promise<EngineInfo> {
    this.cwd = o.cwd;
    this.transport = this.opts.transport ?? this.spawn(o.cwd);
    this.transport.onLine((line) => this.onLine(line));
    const t0 = Date.now();
    const init = await this.request("initialize", { clientInfo: { name: "codemax", version: pkg.version }, capabilities: {} });
    debugEvent("codex-init", { userAgent: String(init?.userAgent ?? "").split(" ")[0], ms: Date.now() - t0, resume: !!o.resume || undefined });
    this.notify("initialized", {});

    this.questions = o.questions !== false;
    this.instructions = o.instructions?.trim() || undefined;
    this.shared = o.mcpServers ?? [];
    this.mcpDisabled = new Set(o.mcpDisabled ?? []);
    let thread: any;
    if (o.resume) {
      try {
        thread = (await this.threadRequest("thread/resume", { threadId: o.resume.id, cwd: o.cwd, approvalPolicy: "on-request" })).thread;
      } catch (e: any) {
        this.emit({ type: "log", level: "warn", message: `resume failed (${e?.message ?? e}); starting a new thread` });
      }
    }
    this.fresh = !thread;
    if (!thread) thread = (await this.threadRequest("thread/start", { cwd: o.cwd, approvalPolicy: "on-request" })).thread;
    this.threadId = thread.id;
    this.lastTurnId = Array.isArray(thread.turns) && thread.turns.length ? (thread.turns.at(-1)?.id ?? null) : null;
    this.model = thread.model ?? undefined;
    this.session = { agent: "codex", id: thread.id, cwd: o.cwd, startedAt: Date.now(), lastUsedAt: Date.now() };
    const account: any = await this.request("account/read", {}).catch(() => null);
    // The models this account can use, straight from Codex: never a list of our own.
    // An older Codex without model/list must not hold up startup: give it a few seconds.
    this.catalog = await Promise.race([this.listModels(), Bun.sleep(4000).then(() => [])]).catch(() => []);
    this.info = {
      agent: "codex",
      name: "Codex",
      version: String(init?.userAgent ?? "").match(/\/(\d+\.\d+\.\d+)/)?.[1],
      modes: [
        { id: "on-request", name: "ask before risky actions" },
        { id: "never", name: "full auto (no approvals)" },
      ],
      currentMode: "on-request",
      models: this.catalog.length ? this.catalog.map((m) => ({ id: m.id, name: m.name })) : this.model ? [{ id: this.model, name: this.model }] : [],
      currentModel: this.model,
      options: this.effortOptions(),
      plan: account?.account?.planType ? `chatgpt ${account.account.planType}` : undefined,
    };
    this.emit({ type: "session", ref: this.session });
    return this.info;
  }

  private spawn(cwd: string) {
    const proc = trackChild(Bun.spawn(platformArgv(this.opts.cmd ?? ["codex", "app-server"]), { ...GROUP_SPAWN, cwd, env: agentEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
    this.proc = proc;
    void (async () => {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        const s = new TextDecoder().decode(chunk).trim();
        if (s && !/rmcp::transport|models_manager/.test(s)) this.emit({ type: "log", level: "info", message: s.slice(0, 500) });
      }
    })();
    void proc.exited.then((code) => {
      if (this.transport) this.emit({ type: "error", kind: "crashed", message: `codex app-server exited with code ${code}` });
      // Nothing will answer now: requests in flight fail instead of waiting forever.
      for (const p of this.pending.values()) p.reject(new Error(`codex app-server exited with code ${code}`));
      this.pending.clear();
      if (this.turn) this.finishTurn("error");
    });
    const sink: { cb: ((line: string) => void) | null } = { cb: null };
    void (async () => {
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += new TextDecoder().decode(chunk);
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) sink.cb?.(line);
        }
      }
    })();
    return {
      send: (line: string) => {
        (proc.stdin as any).write(line + "\n");
        (proc.stdin as any).flush?.();
      },
      onLine: (f: (line: string) => void) => void (sink.cb = f),
      close: async () => {
        // The whole group: Codex and the commands it started.
        killTree(proc);
        await Promise.race([proc.exited, Bun.sleep(1500)]);
        killTree(proc, "SIGKILL");
      },
    };
  }

  /** Thread settings codemax adds: the question feature when questions are on. */
  private instructions?: string;

  private shared: import("../core/share.ts").SharedMcpServer[] = [];
  private mcpDisabled = new Set<string>();

  /** mcpServerStatus/list, as /mcp shows it. */
  async mcpStatus() {
    const r = await Promise.race([this.request("mcpServerStatus/list", { threadId: this.threadId, detail: "toolsAndAuthOnly", limit: 200 }), Bun.sleep(20_000).then(() => null)]);
    if (!r) {
      debugEvent("mcp-status-timeout", { agent: "codex" });
      return null;
    }
    const out: import("../core/mcpstatus.ts").McpStatus[] = [];
    for (const s of r.data ?? []) {
      const rt = String(s.runtimeStatus ?? "").toLowerCase();
      const auth = String(s.authStatus ?? "");
      const status = auth === "notLoggedIn" ? "needs-auth" : /fail|error|cancel/.test(rt) ? "failed" : /start|pending|connecting/.test(rt) ? "pending" : "connected";
      out.push({ name: s.name, status, tools: s.tools && typeof s.tools === "object" ? Object.keys(s.tools).length : undefined, error: s.error ? String(s.error) : undefined, origin: s.pluginId ? "plugin" : undefined });
    }
    return out;
  }

  async mcpAction(action: import("./types.ts").McpAction, name: string): Promise<string> {
    if (action === "reconnect") {
      await Promise.race([this.request("config/mcpServer/reload", null), Bun.sleep(30_000).then(() => { throw new Error("no answer in time"); })]);
      return "Codex reloaded its MCP servers";
    }
    if (action === "authenticate") {
      const r = await Promise.race([this.request("mcpServer/oauth/login", { name, threadId: this.threadId }), Bun.sleep(30_000).then(() => { throw new Error("no answer in time"); })]);
      const url = typeof r?.authorizationUrl === "string" ? r.authorizationUrl : undefined;
      if (url) this.emit({ type: "open_url", id: `codex-oauth-${name}`, url, message: `Authenticate with MCP server ${name}`, server: name, auto: true });
      return url ? `sign-in started for ${name}: finish it in your browser` : `login started for ${name}`;
    }
    throw new Error(`Codex has no API to ${action} one of its own servers; edit ~/.codex/config.toml`);
  }

  /** The shared list changed: the same thread continues with the new overrides (thread/resume takes config). */
  async reloadMcp(servers: import("../core/share.ts").SharedMcpServer[], disabled: string[]) {
    if (!this.threadId) throw new Error("engine not started");
    this.shared = servers;
    this.mcpDisabled = new Set(disabled);
    const t0 = Date.now();
    await this.threadRequest("thread/resume", { threadId: this.threadId, cwd: this.cwd, approvalPolicy: this.info?.currentMode === "never" ? "never" : "on-request" });
    debugEvent("mcp-reload", { agent: "codex", servers: servers.length, disabled: disabled.length || undefined, ms: Date.now() - t0 });
  }

  /** Codex's thread config: the question feature, and the shared MCP servers as `mcp_servers.<name>.*` overrides (what `codex -c` takes). */
  private threadConfig(): { config?: Record<string, unknown> } {
    const config: Record<string, unknown> = this.questions ? { "features.default_mode_request_user_input": true, suppress_unstable_features_warning: true } : {};
    for (const s of this.shared) {
      const key = `mcp_servers.${s.name.replace(/[^A-Za-z0-9_-]+/g, "_")}`;
      const t = s.transport;
      if (this.mcpDisabled.has(s.name)) {
        config[`${key}.enabled`] = false; // turned off in /mcp for this session
        continue;
      }
      if (t.type === "stdio") {
        config[`${key}.command`] = t.command;
        config[`${key}.args`] = t.args;
        if (Object.keys(t.env).length) config[`${key}.env`] = t.env;
        if (t.cwd) config[`${key}.cwd`] = t.cwd;
      } else {
        config[`${key}.url`] = t.url;
        if (Object.keys(t.headers).length) config[`${key}.http_headers`] = t.headers;
      }
    }
    if (this.shared.length) debugEvent("shared-mcp-given", { agent: "codex", servers: this.shared.length });
    return Object.keys(config).length ? { config } : {};
  }

  /** codemax's few lines, as Codex's own developer instructions (added to its prompt, not replacing it). */
  private extra(): { developerInstructions?: string } {
    return this.instructions ? { developerInstructions: this.instructions } : {};
  }

  /** thread/start, /resume or /fork with codemax's settings; without the question feature if Codex rejects it. */
  private async threadRequest(method: string, params: Record<string, unknown>): Promise<any> {
    try {
      return await this.request(method, { ...params, ...this.extra(), ...this.threadConfig() });
    } catch (e: any) {
      if (!this.questions || !/feature|config|default_mode_request_user_input/i.test(`${e?.message ?? ""} ${JSON.stringify(e?.data ?? "")}`)) throw e;
      this.questions = false;
      this.emit({ type: "log", level: "warn", message: `Codex refused its question feature (${e?.message ?? e}); it will not ask questions in this session` });
      const cfg = { ...this.threadConfig().config };
      delete cfg["features.default_mode_request_user_input"];
      delete cfg.suppress_unstable_features_warning;
      return this.request(method, { ...params, ...this.extra(), ...(Object.keys(cfg).length ? { config: cfg } : {}) });
    }
  }

  private request(method: string, params: unknown): Promise<any> {
    if (!this.transport) return Promise.reject(new Error("Codex is not running"));
    if (this.proc && this.proc.exitCode !== null) return Promise.reject(new Error(`codex app-server exited with code ${this.proc.exitCode}`));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method, at: Date.now() } as any);
      this.transport!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(method: string, params: unknown) {
    this.transport!.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private onLine(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      // Failed and slow requests, by method (debug log; never their parameters).
      const pm = (p as any).method as string | undefined;
      const ms = Date.now() - ((p as any).at ?? Date.now());
      if (m.error) debugEvent("codex-rpc-error", { method: pm, code: m.error.code, message: String(m.error.message ?? "") });
      else if (ms > 5000 && pm !== "turn/start") debugEvent("codex-rpc-slow", { method: pm, ms });
      if (m.error) p.reject(Object.assign(new Error(m.error.message ?? JSON.stringify(m.error)), { data: m.error }));
      else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) return this.onServerRequest(m);
    if (m.method) this.onNotification(m.method, m.params ?? {});
  }

  private onServerRequest(m: any) {
    const method: string = m.method;
    if (method === "item/tool/requestUserInput") return this.onUserInput(m);
    if (method === "mcpServer/elicitation/request") return this.onMcpForm(m);
    if (/requestApproval|Approval/.test(method)) {
      const id = `perm-${++this.permSeq}`;
      this.pendingApprovals.set(id, { rpcId: m.id, method });
      const p = m.params ?? {};
      const what = method.includes("commandExecution") ? "Run command" : method.includes("fileChange") ? "Edit files" : method.replace(/^item\//, "").replace(/\/requestApproval$/, "");
      const changes: any[] | undefined = Array.isArray(p.changes) ? p.changes : p.changes && typeof p.changes === "object" ? Object.entries(p.changes).map(([path, c]: [string, any]) => ({ path, ...c })) : this.fileChanges.get(p.itemId);
      const diff = method.includes("fileChange") && changes?.length ? changes.map(changeDiff).join("\n") : undefined;
      const detail = p.command ? (Array.isArray(p.command) ? p.command.join(" ") : String(p.command)) : p.reason ?? (changes?.length ? changes.map((c) => c.path).filter(Boolean).join(", ") : undefined);
      const request: PermissionRequest = {
        id,
        toolCallId: p.itemId,
        kind: method.includes("commandExecution") ? "execute" : method.includes("fileChange") ? "edit" : "other",
        title: what,
        detail,
        diff,
        options: [
          { id: "accept", label: "Allow once", kind: "allow_once" },
          { id: "acceptForSession", label: "Allow for this session", kind: "allow_always" },
          { id: "decline", label: "Deny", kind: "reject_once" },
        ],
      };
      this.emit({ type: "permission_request", request });
      return;
    }
    // Unknown server request: decline politely so the agent does not hang.
    debugEvent("codex-unknown-request", { method });
    this.transport?.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `codemax does not handle ${method}` } }));
  }

  /** Codex's request_user_input: one dialog field per question (pick an option, or type with "Other"). */
  private onUserInput(m: any) {
    const p = m.params ?? {};
    const questions: any[] = Array.isArray(p.questions) ? p.questions : [];
    if (!this.questions || !questions.length) return this.respond(m.id, { answers: {} });
    const id = `ask-${++this.permSeq}`;
    this.pendingQuestions.set(id, { rpcId: m.id, kind: "input", questions });
    const request: QuestionRequest = {
      id,
      message: questions.length === 1 ? "" : "Codex has a few questions",
      toolCallId: p.itemId,
      fields: questions.map((q) => {
        const options = (Array.isArray(q.options) ? q.options : []).map((o: any) => ({ value: String(o.label), label: String(o.label), description: o.description || undefined }));
        return {
          key: String(q.id),
          title: q.header && q.header !== q.question ? String(q.header) : undefined,
          question: String(q.question ?? q.header ?? q.id),
          kind: options.length ? "single" : "text",
          options,
          otherKey: options.length && q.isOther ? `${q.id}__other` : undefined,
          required: false,
        } as QuestionRequest["fields"][number];
      }),
    };
    this.emit({ type: "question_request", request });
  }

  /** An MCP server's form (Codex relays it); URL forms are declined, as over ACP. */
  private onMcpForm(m: any) {
    const p = m.params ?? {};
    if (!this.questions || p.mode !== "form") return this.respond(m.id, { action: "decline" });
    const id = `ask-${++this.permSeq}`;
    const request = parseElicitation(id, p);
    if (!request.fields.length) return this.respond(m.id, { action: "decline" });
    this.pendingQuestions.set(id, { rpcId: m.id, kind: "mcp" });
    this.emit({ type: "question_request", request });
  }

  answerQuestion(requestId: string, answer: QuestionAnswer) {
    const q = this.pendingQuestions.get(requestId);
    if (!q) return;
    this.pendingQuestions.delete(requestId);
    if (q.kind === "mcp") return this.respond(q.rpcId, elicitationResponse(answer));
    // Skipped: no answers, and Codex carries on.
    const answers: Record<string, { answers: string[] }> = {};
    if (answer.action === "accept")
      for (const question of q.questions ?? []) {
        const other = answer.content[`${question.id}__other`];
        const v = typeof other === "string" && other.trim() ? other : answer.content[String(question.id)];
        const list = Array.isArray(v) ? v.map(String) : v === undefined || v === "" ? [] : [String(v)];
        if (list.length) answers[String(question.id)] = { answers: list };
      }
    this.respond(q.rpcId, { answers });
  }

  private respond(rpcId: number | string, result: unknown) {
    this.transport?.send(JSON.stringify({ jsonrpc: "2.0", id: rpcId, result }));
  }

  /**
   * Token usage of one thread. Totals are cumulative per thread; the delta is emitted. A spawned
   * agent's thread counts too: it runs on the same Codex plan, so /usage and budgets include it.
   * Codex's inputTokens include cached ones.
   */
  private usageFrom(p: any, thread: string) {
    const rl = p.rateLimits ?? p.tokenUsage?.rateLimits;
    const used = rl?.primary?.usedPercent ?? rl?.primary?.used_percent;
    const t = p.tokenUsage?.total;
    const main = thread === (this.threadId ?? "main");
    if (!t) {
      if (typeof used === "number" || rl) this.emit({ type: "usage", usedPercent: typeof used === "number" ? used : undefined, planLimits: codexWindows(rl) });
      return;
    }
    const zero = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };
    let last = this.lastTotals.get(thread) ?? zero;
    if (this.newTotals.delete(thread)) {
      const own = p.tokenUsage?.last ?? {};
      last = { inputTokens: (t.inputTokens ?? 0) - (own.inputTokens ?? 0), cachedInputTokens: (t.cachedInputTokens ?? 0) - (own.cachedInputTokens ?? 0), cacheWriteInputTokens: (t.cacheWriteInputTokens ?? 0) - (own.cacheWriteInputTokens ?? 0), outputTokens: (t.outputTokens ?? 0) - (own.outputTokens ?? 0) };
    }
    const d = {
      inputTokens: Math.max(0, (t.inputTokens ?? 0) - last.inputTokens),
      cachedInputTokens: Math.max(0, (t.cachedInputTokens ?? 0) - last.cachedInputTokens),
      cacheWriteInputTokens: Math.max(0, (t.cacheWriteInputTokens ?? 0) - last.cacheWriteInputTokens),
      outputTokens: Math.max(0, (t.outputTokens ?? 0) - last.outputTokens),
    };
    this.lastTotals.set(thread, { inputTokens: t.inputTokens ?? 0, cachedInputTokens: t.cachedInputTokens ?? 0, cacheWriteInputTokens: t.cacheWriteInputTokens ?? 0, outputTokens: t.outputTokens ?? 0 });
    if (!d.inputTokens && !d.outputTokens) return;
    this.emit({
      type: "usage",
      inputTokens: Math.max(0, d.inputTokens - d.cachedInputTokens),
      cacheReadTokens: d.cachedInputTokens,
      cacheWriteTokens: d.cacheWriteInputTokens,
      outputTokens: d.outputTokens,
      model: main ? this.model : (p.tokenUsage?.model ?? this.model),
      usedPercent: typeof used === "number" ? used : undefined,
      planLimits: main ? codexWindows(rl) : undefined,
      // Context fill is the main thread's; a helper's window says nothing about it.
      contextSize: main ? p.tokenUsage?.modelContextWindow : undefined,
    });
  }

  /** Notifications from a spawned agent's thread: start, latest step, usage, end. */
  private onChildThread(method: string, p: any, id: string) {
    if (method === "thread/tokenUsage/updated" || method === "turn/tokenUsage/updated") return this.usageFrom(p, id);
    if (method === "thread/started") {
      const t = p.thread ?? {};
      this.emit({ type: "subagent", id, name: t.agentRole ?? t.agentNickname, task: t.agentNickname && t.agentRole ? t.agentNickname : undefined, status: "running" });
    } else if (method === "item/started") {
      const it = p.item ?? {};
      const step = it.type === "commandExecution" ? `$ ${Array.isArray(it.command) ? it.command.join(" ") : it.command ?? ""}` : it.type === "fileChange" ? `edit ${(it.changes ?? []).map((c: any) => c.path).join(", ")}` : it.type === "mcpToolCall" ? `${it.server}/${it.tool}` : undefined;
      if (step) this.emit({ type: "subagent", id, activity: step });
    } else if (method === "turn/completed") {
      const status = p.turn?.status;
      this.emit({ type: "subagent", id, status: status === "failed" || p.turn?.error ? "failed" : "done" });
    }
  }

  private onNotification(method: string, p: any) {
    // A spawned agent runs on its own thread over this connection: its messages, tools and
    // turn end must never land in (or end) the main turn. They become subagent activity.
    const thread = p?.threadId ?? p?.turn?.threadId ?? (method === "thread/started" ? p?.thread?.id : undefined);
    // During a rewind no turn runs, so another thread's events are the new copy's, never a spawned agent's.
    if (this.replacing && thread && thread !== this.threadId) return;
    if (thread && this.threadId && thread !== this.threadId) return this.onChildThread(method, p, thread);
    switch (method) {
      case "account/rateLimits/updated": {
        // The 5-hour and weekly windows, as Claude's arrive: they feed /usage, quota and the limit warning.
        const planLimits = codexWindows(p.rateLimits);
        if (planLimits.length) this.emit({ type: "usage", planLimits });
        break;
      }
      case "warning":
      case "guardianWarning":
        this.emit({ type: "notice", level: "warn", title: String(p.message ?? "warning") });
        break;
      case "mcpServer/oauthLogin/completed":
        this.emit({ type: "url_done", id: `codex-oauth-${p.name}`, server: String(p.name ?? ""), ok: p.success !== false, error: p.error ? String(p.error) : undefined });
        break;
      case "mcpServer/startupStatus/updated": {
        // A server that failed to start (or needs a login) is worth a line; the others are noise.
        const st = String(p.status ?? "");
        debugEvent("codex-mcp-status", { name: String(p.name ?? ""), status: st, reason: p.failureReason ?? undefined });
        if (st === "failed") this.emit({ type: "notice", level: "warn", title: `MCP server ${p.name} failed to start${p.failureReason === "reauthenticationRequired" ? ": login needed (/mcp)" : p.error ? `: ${String(p.error).slice(0, 120)}` : ""}` });
        break;
      }
      case "configWarning":
      case "deprecationNotice":
        this.emit({ type: "notice", level: "warn", title: String(p.summary ?? method), detail: p.details ? String(p.details) : p.path ? String(p.path) : undefined });
        break;
      case "item/agentMessage/delta":
        this.emit({ type: "text_delta", text: p.delta ?? "" });
        break;
      case "item/reasoning/delta":
      case "item/reasoning/summaryDelta":
      case "item/reasoning/textDelta":
        this.emit({ type: "thought_delta", text: p.delta ?? "" });
        break;
      case "item/started":
      case "item/completed":
      case "item/updated": {
        const it = p.item ?? {};
        if (it.type === "agentMessage" || it.type === "userMessage" || it.type === "reasoning") break;
        if (it.type === "subAgentActivity") {
          if (it.agentThreadId) this.emit({ type: "subagent", id: it.agentThreadId, name: agentName(it.agentPath), status: it.kind === "completed" ? "done" : it.kind === "failed" ? "failed" : "running" });
          break;
        }
        if (it.type === "fileChange" && it.id) {
          if (method === "item/completed") this.fileChanges.delete(it.id);
          else if (Array.isArray(it.changes)) this.fileChanges.set(it.id, it.changes);
        }
        const status: ToolStatus = method === "item/started" ? "in_progress" : it.status === "failed" || it.status === "declined" ? "failed" : method === "item/completed" ? "completed" : "in_progress";
        const title = it.type === "commandExecution" ? `$ ${Array.isArray(it.command) ? it.command.join(" ") : it.command ?? ""}` : it.type === "fileChange" ? `edit ${(it.changes ?? []).map((c: any) => c.path).join(", ")}` : it.type === "mcpToolCall" ? `${it.server}/${it.tool}` : it.type ?? "tool";
        const detail = it.aggregatedOutput ? String(it.aggregatedOutput).slice(-800) : undefined;
        const files = it.type === "fileChange" ? (it.changes ?? []).map((c: any) => c.path).filter(Boolean) : undefined;
        const input = it.type === "commandExecution" ? { command: Array.isArray(it.command) ? it.command.join(" ") : it.command, cwd: it.cwd } : it.type === "mcpToolCall" ? it.arguments : undefined;
        const changeDiffs = it.type === "fileChange" ? (it.changes ?? []).map((c: any) => c.diff ?? c.unified_diff ?? "").filter(Boolean).join("\n") : "";
        const output = it.aggregatedOutput ? String(it.aggregatedOutput) : changeDiffs || undefined;
        if (method === "item/started") this.emit({ type: "tool_call", id: it.id, title, kind: it.type, status, detail, input, files });
        else this.emit({ type: "tool_update", id: it.id, status, title, detail, input, files, output });
        break;
      }
      case "item/commandExecution/outputDelta":
        this.emit({ type: "tool_update", id: p.itemId, detail: p.delta });
        break;
      case "turn/plan/updated":
      case "item/plan/updated":
        this.emit({ type: "plan", entries: (p.plan ?? p.entries ?? []).map((e: any) => ({ content: e.step ?? e.content, status: e.status })) });
        break;
      case "thread/tokenUsage/updated":
      case "turn/tokenUsage/updated":
        this.usageFrom(p, this.threadId ?? "main");
        break;
      case "turn/completed": {
        const status = p.turn?.status;
        const err = p.turn?.error;
        if (err) this.emit({ type: "error", kind: classify(JSON.stringify(err)), message: err.message ?? JSON.stringify(err) });
        const reason: StopReason = status === "completed" ? "end_turn" : status === "interrupted" || status === "cancelled" ? "cancelled" : err ? "error" : "other";
        this.finishTurn(reason);
        break;
      }
      case "turn/error":
      case "error": {
        const msg = p.error?.message ?? p.message ?? JSON.stringify(p);
        this.emit({ type: "error", kind: classify(msg), message: msg });
        break;
      }
      case "serverRequest/resolved": {
        for (const [id, a] of this.pendingApprovals) if (String(a.rpcId) === String(p.requestId)) this.pendingApprovals.delete(id);
        for (const [id, q] of this.pendingQuestions) if (String(q.rpcId) === String(p.requestId)) this.pendingQuestions.delete(id);
        break;
      }
      case "turn/started":
        if (p.turn?.id) this.lastTurnId = p.turn.id;
        break;
      default:
        debugOnce(`codex:${method}`, "codex-unknown-notification", { method });
        break;
    }
  }

  private finishTurn(reason: StopReason) {
    const t = this.turn;
    this.turn = null;
    if (this.session) this.session.lastUsedAt = Date.now();
    this.emit({ type: "turn_end", stopReason: reason });
    t?.resolve(reason);
  }

  async prompt(text: string, images: PromptImage[] = []): Promise<StopReason> {
    if (!this.transport || !this.threadId) throw new Error("engine not started");
    const done = new Promise<StopReason>((resolve) => (this.turn = { resolve }));
    try {
      const approvalPolicy = this.info?.currentMode === "never" ? "never" : "on-request";
      const res = await this.request("turn/start", { threadId: this.threadId, cwd: this.cwd, input: [{ type: "text", text }, ...images.map((im) => ({ type: "localImage", path: im.path }))], model: this.model, approvalPolicy, ...(this.effort ? { effort: this.effort } : {}) });
      if (this.turn) this.turn.id = res?.turn?.id;
      if (res?.turn?.id) this.lastTurnId = res.turn.id;
      this.fresh = false;
    } catch (e: any) {
      const msg = `${e?.message ?? e} ${JSON.stringify(e?.data ?? "")}`.trim();
      this.emit({ type: "error", kind: classify(msg), message: msg });
      this.finishTurn("error");
    }
    return done;
  }

  answerPermission(requestId: string, optionId: string) {
    const a = this.pendingApprovals.get(requestId);
    if (!a) return;
    this.pendingApprovals.delete(requestId);
    this.transport?.send(JSON.stringify({ jsonrpc: "2.0", id: a.rpcId, result: { decision: optionId } }));
  }

  /** Where this thread stands: after its latest turn (Codex forks a thread through a turn), or empty. */
  rewindPoint(): RewindPoint | null {
    if (!this.threadId || this.turn) return null;
    if (!this.lastTurnId && !this.fresh) return null;
    return { sessionId: this.threadId, messageId: this.lastTurnId };
  }

  /** Continue in a fork of the thread through the turn at `point`, or a new thread before the first turn. */
  async rewindConversation(point: RewindPoint) {
    if (!this.transport || !this.threadId) throw new Error("Codex is not running");
    if (point.sessionId !== this.threadId) throw new Error("that message is in an earlier thread");
    const old = this.threadId;
    const base = { cwd: this.cwd, approvalPolicy: this.info?.currentMode === "never" ? "never" : "on-request" };
    this.replacing = true;
    let thread: any;
    try {
      thread = point.messageId
        ? (await this.threadRequest("thread/fork", { threadId: old, lastTurnId: point.messageId, excludeTurns: true, ...base })).thread
        : (await this.threadRequest("thread/start", base)).thread;
    } finally {
      this.replacing = false;
    }
    if (!thread?.id) throw new Error("Codex returned no thread");
    // A fork's running totals start from some share of the original's: its first update counts
    // only its own usage (`last`), and later ones continue from the totals it reports.
    this.newTotals.add(thread.id);
    this.threadId = thread.id;
    this.lastTurnId = point.messageId;
    this.fresh = !point.messageId;
    this.session = { agent: "codex", id: thread.id, cwd: this.cwd, startedAt: Date.now(), lastUsedAt: Date.now() };
    this.emit({ type: "session", ref: this.session });
    await this.request("thread/unsubscribe", { threadId: old }).catch(() => {});
  }

  async cancel() {
    if (!this.transport || !this.threadId || !this.turn) return;
    for (const [id] of this.pendingApprovals) this.answerPermission(id, "cancel");
    for (const [id] of this.pendingQuestions) this.answerQuestion(id, { action: "cancel" });
    await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turn.id }).catch(() => {});
  }

  async setMode(modeId: string) {
    // Applied on the next turn via approvalPolicy; kept for parity with ACP modes.
    if (this.info) this.info.currentMode = modeId;
    this.emit({ type: "mode", modeId });
  }

  /** Codex takes the model per turn; it applies from the next prompt. */
  async setModel(modelId: string) {
    this.model = modelId;
    if (this.info) this.info.currentModel = modelId;
    // Reasoning efforts differ per model: keep the chosen one only if the new model has it.
    const efforts = this.catalog.find((m) => m.id === modelId)?.efforts ?? [];
    if (this.effort && !efforts.includes(this.effort)) this.effort = undefined;
    if (this.info) this.info.options = this.effortOptions();
  }

  async setOption(optionId: string, value: string) {
    if (optionId !== "effort") return;
    this.effort = value;
    if (this.info) this.info.options = this.effortOptions();
  }

  /** `model/list`, all pages, hidden models left out. */
  private async listModels(): Promise<{ id: string; name: string; efforts: string[]; defaultEffort?: string }[]> {
    const out: { id: string; name: string; efforts: string[]; defaultEffort?: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r: any = await this.request("model/list", cursor ? { cursor } : {});
      for (const m of r?.data ?? []) {
        if (m?.hidden) continue;
        const id = String(m.model ?? m.id ?? "");
        if (!id) continue;
        out.push({
          id,
          name: String(m.displayName ?? id),
          efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => String(e?.reasoningEffort ?? e)).filter(Boolean),
          defaultEffort: m.defaultReasoningEffort ? String(m.defaultReasoningEffort) : undefined,
        });
      }
      cursor = r?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** The current model's reasoning efforts, as Codex lists them. */
  private effortOptions(): EngineOption[] {
    const m = this.catalog.find((x) => x.id === this.model);
    if (!m?.efforts.length) return [];
    return [{ id: "effort", name: "Reasoning effort", category: "thought_level", current: this.effort ?? m.defaultEffort ?? "default", values: m.efforts.map((e) => ({ value: e, name: e })) }];
  }

  async close() {
    const t = this.transport;
    this.transport = null;
    for (const [id] of this.pendingApprovals) this.answerPermission(id, "cancel");
    for (const [id] of this.pendingQuestions) this.answerQuestion(id, { action: "cancel" });
    if (this.turn) this.finishTurn("cancelled");
    await t?.close();
  }
}

function classify(msg: string) {
  return classifyError(msg);
}

/** "/root/explorer" → "explorer". */
function agentName(path: unknown): string | undefined {
  return typeof path === "string" && path ? path.split("/").filter(Boolean).pop() : undefined;
}

/** One Codex file change as a unified-style diff. Codex sends a unified diff for updates and the file's text for adds. */
export function changeDiff(c: any): string {
  const path = String(c?.path ?? "file");
  const body = String(c?.diff ?? c?.unified_diff ?? c?.content ?? "");
  const kind = typeof c?.kind === "string" ? c.kind : c?.kind?.type;
  if (/^(---|\+\+\+|@@|diff --git)/m.test(body) && kind !== "add") return /^(---|diff --git)/.test(body) ? body : `--- ${path}\n+++ ${path}\n${body}`;
  if (kind === "delete") return [`--- ${path}`, `+++ /dev/null`, ...body.split("\n").filter((l, i, a) => l || i < a.length - 1).map((l) => `-${l}`)].join("\n");
  return [`--- /dev/null`, `+++ ${path}`, ...body.split("\n").filter((l, i, a) => l || i < a.length - 1).map((l) => `+${l}`)].join("\n");
}

/** Codex's rate-limit windows (primary is the 5-hour one, secondary the weekly) in codemax's PlanLimit form. */
export function codexWindows(rl: any): import("./types.ts").PlanLimit[] {
  if (!rl || typeof rl !== "object") return [];
  const out: import("./types.ts").PlanLimit[] = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const mins = Number(w.windowDurationMins ?? 0);
    const window = mins >= 7 * 24 * 60 - 60 ? "seven_day" : mins > 0 && mins <= 6 * 60 ? "five_hour" : mins ? `${Math.round(mins / 60)}h` : "plan";
    const resetsAt = typeof w.resetsAt === "number" ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : undefined;
    const reached = w.usedPercent >= 100 || (rl.rateLimitReachedType && w === rl.primary);
    out.push({ window, usedPercent: w.usedPercent, resetsAt, status: reached ? "rejected" : w.usedPercent >= 80 ? "allowed_warning" : "allowed" });
  }
  return out;
}

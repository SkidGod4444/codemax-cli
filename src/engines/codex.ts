import type { AgentId } from "../adapters/types.ts";
import type { Engine, EngineEvent, EngineInfo, EngineSessionRef, EngineStartOptions, PermissionRequest, StopReason, ToolStatus } from "./types.ts";
import { agentEnv } from "./env.ts";

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
  private turn: { resolve: (r: StopReason) => void; id?: string } | null = null;
  private threadId: string | null = null;
  private cwd = "";
  private model: string | undefined;
  private lastTotals = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };

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
    const init = await this.request("initialize", { clientInfo: { name: "codemax", version: "0.3.0" }, capabilities: {} });
    this.notify("initialized", {});

    let thread: any;
    if (o.resume) {
      try {
        thread = (await this.request("thread/resume", { threadId: o.resume.id, cwd: o.cwd, approvalPolicy: "on-request" })).thread;
      } catch (e: any) {
        this.emit({ type: "log", level: "warn", message: `resume failed (${e?.message ?? e}); starting a new thread` });
      }
    }
    if (!thread) thread = (await this.request("thread/start", { cwd: o.cwd, approvalPolicy: "on-request" })).thread;
    this.threadId = thread.id;
    this.model = thread.model ?? undefined;
    this.session = { agent: "codex", id: thread.id, cwd: o.cwd, startedAt: Date.now(), lastUsedAt: Date.now() };
    const account: any = await this.request("account/read", {}).catch(() => null);
    this.info = {
      agent: "codex",
      name: "Codex",
      version: String(init?.userAgent ?? "").match(/\/(\d+\.\d+\.\d+)/)?.[1],
      modes: [
        { id: "on-request", name: "ask before risky actions" },
        { id: "never", name: "full auto (no approvals)" },
      ],
      currentMode: "on-request",
      models: [...new Set([this.model, "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"].filter(Boolean))].map((id) => ({ id: id!, name: id! })),
      currentModel: this.model,
      plan: account?.account?.planType ? `chatgpt ${account.account.planType}` : undefined,
    };
    this.emit({ type: "session", ref: this.session });
    return this.info;
  }

  private spawn(cwd: string) {
    const proc = Bun.spawn(this.opts.cmd ?? ["codex", "app-server"], { cwd, env: agentEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    void (async () => {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        const s = new TextDecoder().decode(chunk).trim();
        if (s && !/rmcp::transport|models_manager/.test(s)) this.emit({ type: "log", level: "info", message: s.slice(0, 500) });
      }
    })();
    void proc.exited.then((code) => {
      if (this.transport) this.emit({ type: "error", kind: "crashed", message: `codex app-server exited with code ${code}` });
      if (this.turn) this.turn.resolve("error");
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
        try {
          proc.kill();
        } catch {
          /* gone */
        }
        await Promise.race([proc.exited, Bun.sleep(1500)]);
      },
    };
  }

  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
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
      if (m.error) p.reject(Object.assign(new Error(m.error.message ?? JSON.stringify(m.error)), { data: m.error }));
      else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) return this.onServerRequest(m);
    if (m.method) this.onNotification(m.method, m.params ?? {});
  }

  private onServerRequest(m: any) {
    const method: string = m.method;
    if (/requestApproval|Approval/.test(method)) {
      const id = `perm-${++this.permSeq}`;
      this.pendingApprovals.set(id, { rpcId: m.id, method });
      const p = m.params ?? {};
      const what = method.includes("commandExecution") ? "Run command" : method.includes("fileChange") ? "Edit files" : method.replace(/^item\//, "").replace(/\/requestApproval$/, "");
      const detail = p.command ? (Array.isArray(p.command) ? p.command.join(" ") : String(p.command)) : p.reason ?? (p.changes ? JSON.stringify(p.changes).slice(0, 1500) : undefined);
      const request: PermissionRequest = {
        id,
        toolCallId: p.itemId,
        kind: method.includes("commandExecution") ? "execute" : method.includes("fileChange") ? "edit" : "other",
        title: what,
        detail,
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
    this.transport!.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `codemax does not handle ${method}` } }));
  }

  private onNotification(method: string, p: any) {
    switch (method) {
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
        const status: ToolStatus = method === "item/started" ? "in_progress" : it.status === "failed" || it.status === "declined" ? "failed" : method === "item/completed" ? "completed" : "in_progress";
        const title = it.type === "commandExecution" ? `$ ${Array.isArray(it.command) ? it.command.join(" ") : it.command ?? ""}` : it.type === "fileChange" ? `edit ${(it.changes ?? []).map((c: any) => c.path).join(", ")}` : it.type === "mcpToolCall" ? `${it.server}/${it.tool}` : it.type ?? "tool";
        const detail = it.aggregatedOutput ? String(it.aggregatedOutput).slice(-800) : undefined;
        if (method === "item/started") this.emit({ type: "tool_call", id: it.id, title, kind: it.type, status, detail });
        else this.emit({ type: "tool_update", id: it.id, status, title, detail });
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
      case "turn/tokenUsage/updated": {
        const rl = p.rateLimits ?? p.tokenUsage?.rateLimits;
        const used = rl?.primary?.usedPercent ?? rl?.primary?.used_percent;
        const t = p.tokenUsage?.total;
        if (t) {
          // Totals are cumulative for the thread; emit the delta. Codex's inputTokens include cached ones.
          const d = {
            inputTokens: Math.max(0, (t.inputTokens ?? 0) - this.lastTotals.inputTokens),
            cachedInputTokens: Math.max(0, (t.cachedInputTokens ?? 0) - this.lastTotals.cachedInputTokens),
            cacheWriteInputTokens: Math.max(0, (t.cacheWriteInputTokens ?? 0) - this.lastTotals.cacheWriteInputTokens),
            outputTokens: Math.max(0, (t.outputTokens ?? 0) - this.lastTotals.outputTokens),
          };
          this.lastTotals = { inputTokens: t.inputTokens ?? 0, cachedInputTokens: t.cachedInputTokens ?? 0, cacheWriteInputTokens: t.cacheWriteInputTokens ?? 0, outputTokens: t.outputTokens ?? 0 };
          if (d.inputTokens || d.outputTokens) {
            this.emit({
              type: "usage",
              inputTokens: Math.max(0, d.inputTokens - d.cachedInputTokens),
              cacheReadTokens: d.cachedInputTokens,
              cacheWriteTokens: d.cacheWriteInputTokens,
              outputTokens: d.outputTokens,
              model: this.model,
              usedPercent: typeof used === "number" ? used : undefined,
              contextSize: p.tokenUsage?.modelContextWindow,
            });
          }
        } else if (typeof used === "number") this.emit({ type: "usage", usedPercent: used });
        break;
      }
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
        break;
      }
      default:
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

  async prompt(text: string): Promise<StopReason> {
    if (!this.transport || !this.threadId) throw new Error("engine not started");
    const done = new Promise<StopReason>((resolve) => (this.turn = { resolve }));
    try {
      const approvalPolicy = this.info?.currentMode === "never" ? "never" : "on-request";
      const res = await this.request("turn/start", { threadId: this.threadId, cwd: this.cwd, input: [{ type: "text", text }], model: this.model, approvalPolicy });
      if (this.turn) this.turn.id = res?.turn?.id;
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
    this.transport!.send(JSON.stringify({ jsonrpc: "2.0", id: a.rpcId, result: { decision: optionId } }));
  }

  async cancel() {
    if (!this.transport || !this.threadId || !this.turn) return;
    for (const [id] of this.pendingApprovals) this.answerPermission(id, "cancel");
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
  }

  async close() {
    const t = this.transport;
    this.transport = null;
    for (const [id] of this.pendingApprovals) this.answerPermission(id, "cancel");
    if (this.turn) this.finishTurn("cancelled");
    await t?.close();
  }
}

function classify(msg: string): "quota" | "auth" | "protocol" | "other" {
  if (/usage limit|quota|rate.?limit|too many requests|429/i.test(msg)) return "quota";
  if (/auth|login|unauthori|401/i.test(msg)) return "auth";
  return "other";
}

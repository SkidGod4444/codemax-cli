import type { AgentId } from "../adapters/types.ts";
import type { Engine, EngineEvent, EngineInfo, EngineOption, EngineSessionRef, EngineStartOptions, PermissionRequest, StopReason, ToolStatus } from "./types.ts";
import { agentEnv } from "./env.ts";
import { platformArgv } from "../core/spawn.ts";
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
  private cwd = "";
  private model: string | undefined;
  /** Cumulative token totals per thread (the main one and each spawned agent's), to emit deltas. */
  private lastTotals = new Map<string, { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number }>();

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
    const init = await this.request("initialize", { clientInfo: { name: "codemax", version: pkg.version }, capabilities: {} });
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
    const proc = Bun.spawn(platformArgv(this.opts.cmd ?? ["codex", "app-server"]), { cwd, env: agentEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
    this.transport!.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `codemax does not handle ${method}` } }));
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
      if (typeof used === "number") this.emit({ type: "usage", usedPercent: used });
      return;
    }
    const last = this.lastTotals.get(thread) ?? { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };
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
    if (thread && this.threadId && thread !== this.threadId) return this.onChildThread(method, p, thread);
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
      const res = await this.request("turn/start", { threadId: this.threadId, cwd: this.cwd, input: [{ type: "text", text }], model: this.model, approvalPolicy, ...(this.effort ? { effort: this.effort } : {}) });
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

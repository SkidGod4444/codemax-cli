import { ClientSideConnection, ndJsonStream, type Client, type Stream } from "@agentclientprotocol/sdk";
import type { AgentId } from "../adapters/types.ts";
import type { Engine, EngineEvent, EngineInfo, EngineSessionRef, EngineStartOptions, PermissionRequest, StopReason } from "./types.ts";
import { agentEnv } from "./env.ts";

export interface AcpEngineOptions {
  agent: AgentId;
  name: string;
  /** Command that starts the ACP agent over stdio. */
  cmd: string[];
  env?: Record<string, string>;
  /** Pre-built stream (tests inject an in-process agent). When set, `cmd` is not spawned. */
  stream?: Stream;
  /** False when the agent is known to auto-approve tools over ACP (surfaced to the user). */
  permissionPrompts?: boolean;
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
  private permSeq = 0;
  private turnActive = false;

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
      sessionUpdate: ({ update }) => this.onUpdate(update as any),
      readTextFile: async (p) => ({ content: await Bun.file(p.path).text() }),
      writeTextFile: async (p) => {
        await Bun.write(p.path, p.content);
        return {};
      },
    };
    this.conn = new ClientSideConnection(() => client, stream);
    const init = await this.conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });

    let sessionId: string;
    let modes: any;
    let models: any;
    if (o.resume) {
      try {
        const r: any = await this.conn.loadSession({ sessionId: o.resume.id, cwd: o.cwd, mcpServers: [] });
        sessionId = o.resume.id;
        modes = r?.modes;
        models = r?.models;
      } catch (e: any) {
        this.emit({ type: "log", level: "warn", message: `resume failed (${e?.message ?? e}); starting a new session` });
        const s: any = await this.conn.newSession({ cwd: o.cwd, mcpServers: [] });
        sessionId = s.sessionId;
        modes = s.modes;
        models = s.models;
      }
    } else {
      const s: any = await this.conn.newSession({ cwd: o.cwd, mcpServers: [] });
      sessionId = s.sessionId;
      modes = s.modes;
      models = s.models;
    }
    this.session = { agent: this.agent, id: sessionId, cwd: o.cwd, startedAt: Date.now(), lastUsedAt: Date.now() };
    this.info = {
      agent: this.agent,
      name: (init as any).agentInfo?.title ?? this.opts.name,
      version: (init as any).agentInfo?.version,
      modes: (modes?.availableModes ?? []).map((m: any) => ({ id: m.id, name: m.name ?? m.id, description: m.description })),
      currentMode: modes?.currentModeId,
      models: (models?.availableModels ?? []).map((m: any) => ({ id: m.modelId ?? m.id, name: m.name ?? m.modelId ?? m.id })),
      currentModel: models?.currentModelId,
    };
    this.emit({ type: "session", ref: this.session });
    if (this.info.currentMode) this.emit({ type: "mode", modeId: this.info.currentMode });
    return this.info;
  }

  private spawn(cwd: string): Stream {
    const proc = Bun.spawn(this.opts.cmd, { cwd, env: agentEnv(this.opts.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
      title: p.toolCall?.title ?? p.toolCall?.toolCallId ?? "tool",
      detail: p.toolCall?.rawInput ? JSON.stringify(p.toolCall.rawInput).slice(0, 2000) : undefined,
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
        if (u.content?.type === "text") this.emit({ type: "text_delta", text: u.content.text });
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") this.emit({ type: "thought_delta", text: u.content.text });
        break;
      case "tool_call":
        this.emit({ type: "tool_call", id: u.toolCallId, title: u.title ?? u.toolCallId, kind: u.kind, status: mapStatus(u.status), detail: summarize(u) });
        break;
      case "tool_call_update":
        this.emit({ type: "tool_update", id: u.toolCallId, status: u.status ? mapStatus(u.status) : undefined, title: u.title, detail: summarize(u) });
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
      case "usage_update":
        this.emit({ type: "usage", inputTokens: u.used ?? u.inputTokens, outputTokens: u.outputTokens });
        break;
      default:
        break;
    }
  }

  async prompt(text: string): Promise<StopReason> {
    if (!this.conn || !this.session) throw new Error("engine not started");
    this.turnActive = true;
    try {
      const res = await this.conn.prompt({ sessionId: this.session.id, prompt: [{ type: "text", text }] });
      this.session.lastUsedAt = Date.now();
      const reason = mapStop(res.stopReason);
      this.emit({ type: "turn_end", stopReason: reason });
      return reason;
    } catch (e: any) {
      const message = e?.message ?? String(e);
      const data = JSON.stringify(e?.data ?? "");
      const kind = /usage limit|quota|rate.?limit|429|insufficient/i.test(message + data) ? "quota" : /auth|login|unauthori|401/i.test(message + data) ? "auth" : "protocol";
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

  async cancel() {
    if (!this.conn || !this.session || !this.turnActive) return;
    for (const resolve of this.pendingPermissions.values()) resolve(null);
    await this.conn.cancel({ sessionId: this.session.id }).catch(() => {});
  }

  async setMode(modeId: string) {
    if (!this.conn || !this.session) return;
    await this.conn.setSessionMode({ sessionId: this.session.id, modeId });
    if (this.info) this.info.currentMode = modeId;
    this.emit({ type: "mode", modeId });
  }

  async close() {
    const conn = this.conn;
    this.conn = null;
    for (const resolve of this.pendingPermissions.values()) resolve(null);
    if (conn && this.session) await conn.closeSession?.({ sessionId: this.session.id }).catch(() => {});
    if (this.proc) {
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

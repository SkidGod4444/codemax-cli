import { test, expect } from "bun:test";
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";
import { AcpEngine } from "../src/engines/acp.ts";
import { CodexEngine } from "../src/engines/codex.ts";
import type { EngineEvent } from "../src/engines/types.ts";

/** Two ndjson streams wired back to back: what the agent writes, the client reads, and vice versa. */
function pipePair() {
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  return { clientStream: ndJsonStream(c2a.writable, a2c.readable), agentStream: ndJsonStream(a2c.writable, c2a.readable) };
}

test("ACP engine: text, tool call, permission round-trip, turn end", async () => {
  const { clientStream, agentStream } = pipePair();
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake Agent", version: "9.9" }, agentCapabilities: {}, authMethods: [] } as any; },
    async newSession() { return { sessionId: "sess-1", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] } } as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId }) {
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working… " } } as any });
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Write README.md", kind: "edit", status: "pending" } as any });
      const perm = await conn.requestPermission({ sessionId, toolCall: { toolCallId: "t1", title: "Write README.md" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } as any);
      const ok = (perm.outcome as any).optionId === "yes";
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: ok ? "completed" : "failed" } as any });
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ok ? "done" : "skipped" } } as any });
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }), agentStream);

  const engine = new AcpEngine({ agent: "fake", name: "Fake", cmd: [], stream: clientStream });
  const events: EngineEvent[] = [];
  engine.onEvent((e) => {
    events.push(e);
    if (e.type === "permission_request") {
      expect(e.request.title).toBe("Write README.md");
      expect(e.request.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
      engine.answerPermission(e.request.id, "yes");
    }
  });
  const info = await engine.start({ cwd: "/tmp" });
  expect(info.name).toBe("Fake Agent");
  expect(info.modes.map((m) => m.id)).toEqual(["default", "plan"]);
  expect(engine.session?.id).toBe("sess-1");

  const stop = await engine.prompt("hi");
  expect(stop).toBe("end_turn");
  const text = events.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("");
  expect(text).toBe("Working… done");
  expect(events.find((e) => e.type === "tool_call")).toMatchObject({ id: "t1", status: "pending", kind: "edit" });
  expect(events.find((e) => e.type === "tool_update")).toMatchObject({ id: "t1", status: "completed" });
  expect(events.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" });
});

test("Codex engine: app-server handshake, approval round-trip, turn end", async () => {
  // Fake app-server speaking the subset codemax uses.
  let toEngine: ((line: string) => void) | null = null;
  const sent: any[] = [];
  const reply = (obj: object) => toEngine?.(JSON.stringify(obj));
  const transport = {
    send(line: string) {
      const m = JSON.parse(line);
      sent.push(m);
      queueMicrotask(() => {
        if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { userAgent: "codemax/0.159.3 (test)" } });
        else if (m.method === "thread/start") reply({ jsonrpc: "2.0", id: m.id, result: { thread: { id: "thread-1", model: "gpt-6.1-sol" } } });
        else if (m.method === "model/list")
          reply({ jsonrpc: "2.0", id: m.id, result: { nextCursor: null, data: [
            { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "ultra" }] },
            { id: "internal", model: "internal-preview", displayName: "Internal", hidden: true, supportedReasoningEfforts: [] },
            { id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
          ] } });
        else if (m.method === "account/read") reply({ jsonrpc: "2.0", id: m.id, result: { account: { type: "chatgpt", planType: "pro" } } });
        else if (m.method === "turn/start") {
          reply({ jsonrpc: "2.0", id: m.id, result: { turn: { id: "turn-1" } } });
          reply({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "Editing. " } });
          reply({ jsonrpc: "2.0", method: "item/started", params: { item: { id: "i1", type: "fileChange", changes: [{ path: "README.md" }] } } });
          reply({ jsonrpc: "2.0", id: 77, method: "item/fileChange/requestApproval", params: { itemId: "i1", threadId: "thread-1", turnId: "turn-1" } });
        } else if (m.id === 77) {
          expect(m.result).toEqual({ decision: "accept" });
          reply({ jsonrpc: "2.0", method: "item/completed", params: { item: { id: "i1", type: "fileChange", status: "completed", changes: [{ path: "README.md" }] } } });
          reply({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "done" } });
          reply({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
        }
      });
    },
    onLine(cb: (line: string) => void) { toEngine = cb; },
    async close() {},
  };
  const engine = new CodexEngine({ transport });
  const events: EngineEvent[] = [];
  engine.onEvent((e) => {
    events.push(e);
    if (e.type === "permission_request") {
      expect(e.request.title).toBe("Edit files");
      engine.answerPermission(e.request.id, "accept");
    }
  });
  const info = await engine.start({ cwd: "/tmp" });
  expect(info.version).toBe("0.159.3");
  // the models are Codex's own list (hidden ones left out), not codemax's
  expect(info.models).toEqual([{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol" }, { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }]);
  expect(info.options?.[0]).toMatchObject({ id: "effort", current: "medium", values: [{ value: "low" }, { value: "medium" }, { value: "ultra" }] });
  expect(engine.session?.id).toBe("thread-1");
  expect(sent.some((m) => m.method === "initialized")).toBe(true);

  const stop = await engine.prompt("edit it");
  expect(stop).toBe("end_turn");
  expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("Editing. done");
  expect(events.find((e) => e.type === "tool_call")).toMatchObject({ id: "i1", title: "edit README.md", status: "in_progress" });
  expect(events.find((e) => e.type === "tool_update")).toMatchObject({ id: "i1", status: "completed" });
});

test("codex: a spawned agent's thread becomes subagent updates and can never end the main turn", async () => {
  let toEngine: ((line: string) => void) | undefined;
  const reply = (obj: object) => toEngine?.(JSON.stringify(obj));
  const n = (method: string, params: object) => reply({ jsonrpc: "2.0", method, params });
  const transport = {
    send(line: string) {
      const m = JSON.parse(line);
      queueMicrotask(() => {
        if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { userAgent: "codemax/0.160.0 (test)" } });
        else if (m.method === "thread/start") reply({ jsonrpc: "2.0", id: m.id, result: { thread: { id: "main", model: "gpt-6.1-sol" } } });
        else if (m.method === "model/list") reply({ jsonrpc: "2.0", id: m.id, result: { data: [], nextCursor: null } });
        else if (m.method === "account/read") reply({ jsonrpc: "2.0", id: m.id, result: { account: null } });
        else if (m.method === "turn/start") {
          reply({ jsonrpc: "2.0", id: m.id, result: { turn: { id: "t1" } } });
          n("item/started", { threadId: "main", item: { id: "s1", type: "subAgentActivity", agentThreadId: "child", agentPath: "/root/explorer", kind: "started" } });
          n("thread/started", { thread: { id: "child", agentNickname: "Ada", agentRole: "explorer" } });
          n("item/started", { threadId: "child", item: { id: "k1", type: "commandExecution", command: "rg auth" } });
          n("item/agentMessage/delta", { threadId: "child", delta: "child chatter" });
          // Each thread reports its own cumulative totals: both count, neither eats the other's.
          n("thread/tokenUsage/updated", { threadId: "main", tokenUsage: { total: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 }, modelContextWindow: 400000 } });
          n("thread/tokenUsage/updated", { threadId: "child", tokenUsage: { total: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 20 }, modelContextWindow: 400000 } });
          n("thread/tokenUsage/updated", { threadId: "child", tokenUsage: { total: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 30 } } });
          n("thread/tokenUsage/updated", { threadId: "main", tokenUsage: { total: { inputTokens: 1200, cachedInputTokens: 400, outputTokens: 60 } } });
          n("turn/completed", { threadId: "child", turn: { id: "ct", status: "completed" } });
          n("item/agentMessage/delta", { threadId: "main", delta: "main reply" });
          n("turn/completed", { threadId: "main", turn: { id: "t1", status: "completed" } });
        }
      });
    },
    onLine(cb: (line: string) => void) { toEngine = cb; },
    async close() {},
  };
  const { CodexEngine } = await import("../src/engines/codex.ts");
  const engine = new CodexEngine({ transport } as any);
  const events: any[] = [];
  engine.onEvent((e) => events.push(e));
  await engine.start({ cwd: "/tmp" });
  expect(await engine.prompt("explore")).toBe("end_turn");
  expect(events.filter((e) => e.type === "text_delta").map((e) => e.text).join("")).toBe("main reply");
  expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
  const usage = events.filter((e) => e.type === "usage").map((e) => [e.inputTokens, e.cacheReadTokens, e.outputTokens, e.contextSize]);
  expect(usage).toEqual([[600, 400, 50, 400000], [300, 0, 20, undefined], [100, 100, 10, undefined], [200, 0, 10, undefined]]);
  expect(events.filter((e) => e.type === "subagent")).toEqual([
    { type: "subagent", id: "child", name: "explorer", status: "running" },
    { type: "subagent", id: "child", name: "explorer", task: "Ada", status: "running" },
    { type: "subagent", id: "child", activity: "$ rg auth" },
    { type: "subagent", id: "child", status: "done" },
  ]);
});

test("ACP sign-in: an agent that needs auth is signed in with the subscription method only, then the session opens", async () => {
  const { clientStream, agentStream } = pipePair();
  const authed: string[] = [];
  new AgentSideConnection((): Agent => ({
    async initialize() {
      return { protocolVersion: 1, agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "1.4.1" }, agentCapabilities: {},
        authMethods: [{ id: "gemini-api-key", name: "Gemini API key" }, { id: "oauth-personal", name: "Log in with Google" }] } as any;
    },
    async authenticate(p: any) { authed.push(p.methodId); return {}; },
    async newSession() {
      if (!authed.length) { const e: any = new Error("Authentication required"); e.code = -32000; throw e; }
      return { sessionId: "s1" } as any;
    },
    async prompt() { return { stopReason: "end_turn" }; },
    async cancel() {},
  }), agentStream);
  const e = new AcpEngine({ agent: "antigravity", name: "Antigravity CLI", cmd: [], stream: clientStream, signIn: ["oauth-personal", "oauth-business"] });
  const logs: string[] = [];
  e.onEvent((x) => x.type === "log" && logs.push(x.message));
  const info = await e.start({ cwd: "/tmp" });
  expect(authed).toEqual(["oauth-personal"]); // never the API-key method
  expect(info.name).toBe("Google Antigravity");
  expect(logs.join("\n")).toContain("a browser window may open");

  // Without an allowed method the error stands: codemax never signs in with an API key.
  const p2 = pipePair();
  new AgentSideConnection((): Agent => ({
    async initialize() { return { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "gemini-api-key", name: "Gemini API key" }] } as any; },
    async authenticate() { throw new Error("should not be called"); },
    async newSession() { const err: any = new Error("Authentication required"); err.code = -32000; throw err; },
    async prompt() { return { stopReason: "end_turn" }; },
    async cancel() {},
  }), p2.agentStream);
  const e2 = new AcpEngine({ agent: "antigravity", name: "Antigravity CLI", cmd: [], stream: p2.clientStream, signIn: ["oauth-personal"] });
  await expect(e2.start({ cwd: "/tmp" })).rejects.toThrow(/needs you to sign in, and offers no subscription sign-in codemax may use \(offered: Gemini API key\)\. codemax never uses API keys\./);
});

test("Antigravity's ACP server: the registry's build for this machine, from dl.google.com only", async () => {
  const { antigravityInstallPlan, platformKey } = await import("../src/engines/antigravity.ts");
  expect(platformKey("darwin", "arm64")).toBe("darwin-aarch64");
  expect(platformKey("linux", "x64")).toBe("linux-x86_64");
  expect(platformKey("win32", "x64")).toBe("windows-x86_64");
  const entry = (archive: string) => ({ version: "1.4.1", distribution: { binary: { [platformKey()]: { archive, cmd: "./agy_acp_server.par" } } } });
  const fake = (body: object) => (async (_url: string, init?: any) =>
    init?.method === "HEAD" ? new Response(null, { headers: { "content-length": "112737434" } }) : Response.json(body)) as unknown as typeof fetch;
  const plan = await antigravityInstallPlan(fake(entry("https://dl.google.com/agy-extensions/releases/x.zip")));
  expect(plan).toEqual({ version: "1.4.1", url: "https://dl.google.com/agy-extensions/releases/x.zip", bytes: 112737434 });
  await expect(antigravityInstallPlan(fake(entry("https://evil.example.com/agy.zip")))).rejects.toThrow(/refusing to download .* evil\.example\.com/);
  await expect(antigravityInstallPlan(fake({ version: "1", distribution: { binary: {} } }))).rejects.toThrow(/no Antigravity ACP server for/);
});

test("ACP: a turn you interrupted is 'cancelled' even when the agent ends it with end_turn (Antigravity)", async () => {
  const { clientStream, agentStream } = pipePair();
  let stop!: () => void;
  new AgentSideConnection((): Agent => ({
    async initialize() { return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } as any; },
    async newSession() { return { sessionId: "s" } as any; },
    async authenticate() { return {}; },
    async prompt() { await new Promise<void>((r) => (stop = r)); return { stopReason: "end_turn" }; },
    async cancel() { stop(); },
  }), agentStream);
  const e = new AcpEngine({ agent: "antigravity", name: "Antigravity CLI", cmd: [], stream: clientStream });
  await e.start({ cwd: "/tmp" });
  const turn = e.prompt("count to 200");
  await Bun.sleep(20);
  await e.cancel();
  expect(await turn).toBe("cancelled");
  const next = e.prompt("again");
  await Bun.sleep(20);
  stop();
  expect(await next).toBe("end_turn"); // the next, uninterrupted turn is not marked
});

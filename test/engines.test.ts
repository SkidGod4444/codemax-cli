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

test("subagents: Antigravity's invoke_subagent (recorded from agy_acp_server 1.4.1) and Grok's spawn_subagent are listed", async () => {
  const { clientStream, agentStream } = pipePair();
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } as any; },
    async newSession() { return { sessionId: "s" } as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId }) {
      const up = (update: any) => conn.sessionUpdate({ sessionId, update });
      // Recorded shape: the launch, then "in progress" with empty input, then completed once started.
      await up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run invoke_subagent?", kind: "other", status: "pending", rawInput: { Subagents: [{ Model: "inherit", Prompt: "Reply with the single word PONG.", Role: "Ping Responder", TypeName: "self", Workspace: "inherit" }, { Prompt: "Read the tests", Role: "Test Reader", TypeName: "explorer" }] } });
      await up({ sessionUpdate: "tool_call_update", toolCallId: "t1", kind: "other", status: "in_progress", title: "Running invoke_subagent", rawInput: {} });
      await up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "Subagent invocation" });
      // Grok: its spawn_subagent tool (persona is the kind of agent).
      await up({ sessionUpdate: "tool_call", toolCallId: "g1", title: "spawn_subagent", kind: "other", status: "in_progress", rawInput: { persona: "reviewer", prompt: "Review the diff\nCarefully" } });
      await up({ sessionUpdate: "tool_call_update", toolCallId: "g1", status: "completed" });
      // A refused launch shows as failed.
      await up({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Run invoke_subagent?", kind: "other", status: "pending", rawInput: { Subagents: [{ Prompt: "x", Role: "Refused", TypeName: "self" }] } });
      await up({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed", rawOutput: "Rejected by user" });
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }), agentStream);
  const e = new AcpEngine({ agent: "antigravity", name: "Antigravity CLI", cmd: [], stream: clientStream });
  const subs: EngineEvent[] = [];
  e.onEvent((x) => x.type === "subagent" && subs.push(x));
  await e.start({ cwd: "/tmp" });
  await e.prompt("go");
  expect(subs).toEqual([
    { type: "subagent", id: "t1:0", name: "subagent", task: "Ping Responder", status: "running" },
    { type: "subagent", id: "t1:1", name: "explorer", task: "Test Reader", status: "running" },
    // Completing the launch call does not end them: they run until the turn ends.
    { type: "subagent", id: "g1", name: "reviewer", task: "Review the diff", status: "running" },
    { type: "subagent", id: "g1", status: "done" },
    { type: "subagent", id: "t2:0", name: "subagent", task: "Refused", status: "running" },
    { type: "subagent", id: "t2:0", status: "failed" },
  ]);
});

/** A scripted codex app-server: `on(method, msg, reply, notify)` answers each client message. */
function codexFake(on: (m: any, reply: (o: object) => void, n: (method: string, params: object) => void) => void) {
  let toEngine: ((line: string) => void) | undefined;
  const sent: any[] = [];
  const reply = (obj: object) => toEngine?.(JSON.stringify(obj));
  const n = (method: string, params: object) => reply({ jsonrpc: "2.0", method, params });
  const transport = {
    send(line: string) {
      const m = JSON.parse(line);
      sent.push(m);
      queueMicrotask(() => {
        if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { userAgent: "codemax/0.159.3 (test)" } });
        else if (m.method === "model/list") reply({ jsonrpc: "2.0", id: m.id, result: { data: [], nextCursor: null } });
        else if (m.method === "account/read") reply({ jsonrpc: "2.0", id: m.id, result: { account: null } });
        else on(m, reply, n);
      });
    },
    onLine(cb: (line: string) => void) { toEngine = cb; },
    async close() {},
  };
  return { transport, sent };
}

test("codex questions: request_user_input (recorded from codex 0.159.3) opens the dialog; the question feature follows /config", async () => {
  const { transport, sent } = codexFake((m, reply, n) => {
    if (m.method === "thread/start") reply({ jsonrpc: "2.0", id: m.id, result: { thread: { id: "th", model: "gpt-6.1-sol" } } });
    else if (m.method === "turn/start") {
      reply({ jsonrpc: "2.0", id: m.id, result: { turn: { id: "t1" } } });
      reply({ jsonrpc: "2.0", id: 5, method: "item/tool/requestUserInput", params: { threadId: "th", turnId: "t1", itemId: "call_1", isBlocking: false, autoResolutionMs: null, questions: [
        { id: "color", header: "Which color?", question: "Which color?", isOther: true, isSecret: false, options: [{ label: "Red", description: "Choose red." }, { label: "Blue", description: "Choose blue." }] },
        { id: "name", header: "Name", question: "What should it be called?", isOther: false, isSecret: false, options: null },
      ] } });
    } else if (m.id === 5) {
      n("item/agentMessage/delta", { threadId: "th", delta: JSON.stringify(m.result) });
      n("turn/completed", { threadId: "th", turn: { id: "t1", status: "completed" } });
    }
  });
  const e = new CodexEngine({ transport });
  let text = "";
  const asked: any[] = [];
  e.onEvent((x) => {
    if (x.type === "text_delta") text += x.text;
    if (x.type === "question_request") {
      asked.push(x.request);
      e.answerQuestion(x.request.id, { action: "accept", content: { color: "Red", color__other: "teal", name: "widget" } });
    }
  });
  await e.start({ cwd: "/tmp", questions: true });
  expect(sent.find((m) => m.method === "thread/start").params.config).toEqual({ "features.default_mode_request_user_input": true, suppress_unstable_features_warning: true });
  await e.prompt("ask me");
  expect(asked[0].fields).toEqual([
    { key: "color", title: undefined, question: "Which color?", kind: "single", options: [{ value: "Red", label: "Red", description: "Choose red." }, { value: "Blue", label: "Blue", description: "Choose blue." }], otherKey: "color__other", required: false },
    { key: "name", title: "Name", question: "What should it be called?", kind: "text", options: [], otherKey: undefined, required: false },
  ]);
  // "Other" text wins over the picked option.
  expect(JSON.parse(text)).toEqual({ answers: { color: { answers: ["teal"] }, name: { answers: ["widget"] } } });

  // Questions off: the feature is never turned on, and a question gets no dialog.
  const off = codexFake((m, reply) => m.method === "thread/start" && reply({ jsonrpc: "2.0", id: m.id, result: { thread: { id: "th" } } }));
  const e2 = new CodexEngine({ transport: off.transport });
  await e2.start({ cwd: "/tmp", questions: false });
  expect(off.sent.find((m) => m.method === "thread/start").params.config).toBeUndefined();

  // A Codex that rejects the feature still starts, without it.
  const old = codexFake((m, reply) => {
    if (m.method === "thread/start") reply(m.params.config ? { jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "unknown feature default_mode_request_user_input" } } : { jsonrpc: "2.0", id: m.id, result: { thread: { id: "th" } } });
  });
  const e3 = new CodexEngine({ transport: old.transport });
  await e3.start({ cwd: "/tmp", questions: true });
  expect(e3.session?.id).toBe("th");
  expect(old.sent.filter((m) => m.method === "thread/start").map((m) => !!m.params.config)).toEqual([true, false]);
});

test("codex rewind: forks the thread through the turn before the message, or starts a new one before the first", async () => {
  let turn = 0;
  const { transport, sent } = codexFake((m, reply, n) => {
    if (m.method === "thread/start") reply({ jsonrpc: "2.0", id: m.id, result: { thread: { id: `th${sent.filter((x) => x.method === "thread/start").length}` } } });
    else if (m.method === "thread/fork") {
      n("thread/started", { thread: { id: "fork1" } }); // the copy, not a spawned agent
      n("thread/tokenUsage/updated", { threadId: "fork1", tokenUsage: { total: { inputTokens: 600, cachedInputTokens: 0, outputTokens: 30 }, last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } } });
      reply({ jsonrpc: "2.0", id: m.id, result: { thread: { id: "fork1" } } });
    } else if (m.method === "thread/unsubscribe") reply({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.method === "turn/start") {
      const id = `t${++turn}`;
      reply({ jsonrpc: "2.0", id: m.id, result: { turn: { id } } });
      // A fork's totals include its share of the original's; only `last` is this update's own.
      if (m.params.threadId === "fork1") n("thread/tokenUsage/updated", { threadId: "fork1", tokenUsage: { total: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 40 }, last: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 10 } } });
      n("turn/completed", { threadId: m.params.threadId, turn: { id, status: "completed" } });
    }
  });
  const e = new CodexEngine({ transport });
  const events: any[] = [];
  e.onEvent((x) => events.push(x));
  await e.start({ cwd: "/tmp" });
  const before = e.rewindPoint();
  expect(before).toEqual({ sessionId: "th1", messageId: null });
  await e.prompt("one");
  const afterOne = e.rewindPoint();
  expect(afterOne).toEqual({ sessionId: "th1", messageId: "t1" });
  await e.prompt("two");
  await e.rewindConversation(afterOne!);
  expect(sent.find((m) => m.method === "thread/fork").params).toMatchObject({ threadId: "th1", lastTurnId: "t1", excludeTurns: true });
  expect(e.session?.id).toBe("fork1");
  expect(events.some((x) => x.type === "subagent")).toBe(false);
  expect(sent.find((m) => m.method === "thread/unsubscribe").params).toEqual({ threadId: "th1" });
  await e.prompt("three");
  expect(sent.filter((m) => m.method === "turn/start").at(-1).params.threadId).toBe("fork1");
  expect(events.filter((x) => x.type === "usage").map((x) => [x.inputTokens, x.outputTokens])).toEqual([[300, 10]]);
  // Before the first message: a new, empty thread.
  await e.rewindConversation({ sessionId: "fork1", messageId: null });
  expect(e.session?.id).toBe("th2");
  expect(e.rewindPoint()).toEqual({ sessionId: "th2", messageId: null });
});

test("codex: images dropped into the prompt go as localImage input", async () => {
  const { transport, sent } = codexFake((m, reply, n) => {
    if (m.method === "thread/start") reply({ jsonrpc: "2.0", id: m.id, result: { thread: { id: "th" } } });
    else if (m.method === "turn/start") {
      reply({ jsonrpc: "2.0", id: m.id, result: { turn: { id: "t1" } } });
      n("turn/completed", { threadId: "th", turn: { id: "t1", status: "completed" } });
    }
  });
  const e = new CodexEngine({ transport });
  await e.start({ cwd: "/tmp" });
  await e.prompt("what is in [Image #1]?", [{ path: "/tmp/shot.png", mimeType: "image/png" }]);
  expect(sent.find((m) => m.method === "turn/start").params.input).toEqual([{ type: "text", text: "what is in [Image #1]?" }, { type: "localImage", path: "/tmp/shot.png" }]);
});

test("edit diffs: Antigravity's client_edit_file (recorded from agy_acp_server 1.4.1); no trailing blank line; unchanged files say so", async () => {
  const { contentDiff, simpleDiff } = await import("../src/engines/acp.ts");
  // The permission request's content, as Antigravity sends it.
  const { resolve, join } = await import("node:path");
  const repo = resolve("/repo"); // C:\repo on Windows
  const content = [{ path: join(repo, "notes.txt"), oldText: "line one\noriginal\nline three\n", newText: "line one\nedited\nline three\n", _meta: { kind: "modify" }, type: "diff" }];
  expect(contentDiff(content, repo)).toBe("--- notes.txt\n+++ notes.txt\n@@ line 1 @@\n line one\n-original\n+edited\n line three");
  expect(simpleDiff("a.txt", "same\n", "same\n")).toContain("(no change");
  expect(simpleDiff("new.txt", null, "x\ny\n")).toBe("--- /dev/null\n+++ new.txt\n+x\n+y");
});

test("codex bug fixes: a crashed app-server fails pending requests instead of hanging; closing with an approval open is safe", async () => {
  let exit!: () => void;
  const exited = new Promise<number>((r) => (exit = () => r(1)));
  const { transport, sent } = codexFake((m, reply) => {
    if (m.method === "thread/start") reply({ jsonrpc: "2.0", id: m.id, result: { thread: { id: "th" } } });
    else if (m.method === "turn/start") {
      reply({ jsonrpc: "2.0", id: m.id, result: { turn: { id: "t1" } } });
      reply({ jsonrpc: "2.0", id: 9, method: "item/commandExecution/requestApproval", params: { itemId: "c1", command: "rm -rf build" } });
    }
  });
  const e = new CodexEngine({ transport });
  const asked: string[] = [];
  e.onEvent((x) => x.type === "permission_request" && asked.push(x.request.id));
  await e.start({ cwd: "/tmp" });
  void e.prompt("clean up");
  for (let i = 0; i < 50 && !asked.length; i++) await Bun.sleep(5);
  expect(asked.length).toBe(1);
  await expect(e.close()).resolves.toBeUndefined(); // used to throw: the approval was answered after the transport was gone
  void exited; void exit; void sent;
});

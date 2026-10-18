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

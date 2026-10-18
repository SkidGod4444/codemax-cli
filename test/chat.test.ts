import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";

process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-chat-home-"));
const { ChatApp } = await import("../src/chat/app.ts");
const { AcpEngine } = await import("../src/engines/acp.ts");
const { Ledger } = await import("../src/core/ledger.ts");
const { DEFAULT_CONFIG } = await import("../src/config.ts");

function fakeAgentStream(onPrompt: (text: string, conn: AgentSideConnection, sessionId: string) => Promise<void>) {
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake Agent", version: "1.0" }, agentCapabilities: {}, authMethods: [] } as any; },
    async newSession() { return { sessionId: "s-1", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } as any; },
    async loadSession() { return { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId, prompt }) {
      await onPrompt((prompt[0] as any).text, conn, sessionId);
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }), ndJsonStream(a2c.writable, c2a.readable));
  return ndJsonStream(c2a.writable, a2c.readable);
}

async function waitText(setup: Awaited<ReturnType<typeof createTestRenderer>>, pred: (f: string) => boolean, ms = 10000): Promise<string> {
  const t0 = Date.now();
  let frame = "";
  while (Date.now() - t0 < ms) {
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
    await Bun.sleep(40);
  }
  throw new Error(`timeout; last frame:\n${frame}`);
}

test("chat: send a message, see streamed reply, answer a permission prompt, reply recorded in ledger", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 });
  const repo = mkdtempSync(join(tmpdir(), "codemax-chat-repo-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  const ledger = new Ledger(repo);
  const app = new ChatApp(setup.renderer, { ...structuredClone(DEFAULT_CONFIG), order: ["claude"] }, ledger, repo);
  app.checkBlockers = () => [];
  app.engineFactory = () =>
    new AcpEngine({
      agent: "claude",
      name: "Claude Code",
      cmd: [],
      stream: fakeAgentStream(async (text, conn, sessionId) => {
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `You said: ${text}. ` } } as any });
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Write notes.md", kind: "edit", status: "pending" } as any });
        const perm = await conn.requestPermission({ sessionId, toolCall: { toolCallId: "t1", title: "Write notes.md", kind: "edit" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } as any);
        const ok = (perm.outcome as any).optionId === "ok";
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: ok ? "completed" : "failed" } as any });
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ok ? "Saved." : "Not saved." } } as any });
      }),
    });
  // Pre-detect is skipped: start() checks detection, so stub it to "installed with engine".
  (app as any).refreshDetect = async () => (app as any).detect.set("claude", { installed: true, version: "test", engine: true });
  const done = app.start("claude", true);
  try {
    await waitText(setup, (f) => f.includes("new session"));
    await setup.mockInput.typeText("hello there");
    setup.mockInput.pressEnter();
    let frame = await waitText(setup, (f) => f.includes("Do you want to proceed?"));
    expect(frame).toContain("wants to edit files"); // kind "edit" from the fake agent's tool_call
    expect(frame).toContain("1. Yes");
    expect(frame).toMatch(/No, and tell Claude Code what to do differently/);
    setup.mockInput.pressKey("y");
    frame = await waitText(setup, (f) => f.includes("Saved."));
    expect(frame).toContain("❯ hello there");
    expect(frame).toContain("⏺ You said: hello there.");
    expect(frame).toContain("⏺ Write notes.md");
    expect(frame).toMatch(/✻ \w+ for \d+s · done/);
    await waitText(setup, () => ledger.turns().length >= 2, 5000);
    const turns = ledger.turns();
    expect(turns[0]).toMatchObject({ role: "user", text: "hello there" });
    expect(turns[1]).toMatchObject({ role: "assistant", agent: "claude" });
    expect(turns[1]!.text).toContain("Saved.");
    expect(turns[1]!.tools).toEqual(["Write"]);

    await setup.mockInput.typeText("/quit");
    setup.mockInput.pressEnter();
    await done;
  } finally {
    setup.renderer.destroy();
  }
}, 30000);

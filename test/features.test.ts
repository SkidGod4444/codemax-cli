import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";

process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-features-home-"));
const { ChatApp } = await import("../src/chat/app.ts");
const { AcpEngine } = await import("../src/engines/acp.ts");
const { Ledger } = await import("../src/core/ledger.ts");
const { DEFAULT_CONFIG } = await import("../src/config.ts");

type Ctx = { conn: AgentSideConnection; sessionId: string; say: (t: string) => Promise<void>; cancelled: () => boolean };
type Handler = (text: string, ctx: Ctx) => Promise<void | Record<string, unknown>>;
/** Extra fields a fake agent returns from newSession (e.g. OpenCode's configOptions), and config-option calls it received. */
type FakeOpts = { session?: Record<string, unknown>; configCalls?: unknown[] };

function fakeStream(handler: Handler, fo: FakeOpts = {}) {
  let cancelled = false;
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  let n = 0;
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake", version: "1" }, agentCapabilities: { loadSession: true }, authMethods: [] } as any; },
    async newSession() { return { sessionId: `s-${++n}-${Math.random().toString(36).slice(2, 6)}`, ...(fo.session ?? {}) } as any; },
    async setSessionConfigOption(p: any) { fo.configCalls?.push(p); return {} as any; },
    async extMethod(method: string, params: any) { fo.configCalls?.push({ method, ...params }); return {}; },
    async loadSession(p: any) { fo.configCalls?.push({ method: "session/load", mcpServers: (p.mcpServers ?? []).map((x: any) => x.name) }); return {} as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId, prompt }) {
      const text = (prompt[0] as any).text as string;
      const say = (t: string) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } as any });
      cancelled = false;
      const extra = await handler(text, { conn, sessionId, say, cancelled: () => cancelled });
      return { stopReason: cancelled ? "cancelled" : "end_turn", ...(extra ?? {}) } as any;
    },
    async cancel() { cancelled = true; },
  }), ndJsonStream(a2c.writable, c2a.readable));
  return ndJsonStream(c2a.writable, a2c.readable);
}

async function harness(agents: Partial<Record<"claude" | "codex" | "opencode", Handler>>, cfg: any = {}, prep?: (repo: string, ledger: any) => void, fake: Partial<Record<string, FakeOpts>> = {}) {
  const setup = await createTestRenderer({ width: 110, height: 30 });
  const repo = mkdtempSync(join(tmpdir(), "codemax-feat-repo-"));
  Bun.spawnSync(["sh", "-c", "git init -q && echo original > README.md && git add -A && git -c user.email=a@b -c user.name=t commit -qm init"], { cwd: repo });
  const ledger = new Ledger(repo);
  prep?.(repo, ledger);
  const ids = Object.keys(agents) as ("claude" | "codex" | "opencode")[];
  const app = new ChatApp(setup.renderer, { ...structuredClone(DEFAULT_CONFIG), order: ids, summarizeOnSwitch: false, priceUpdates: false, narrate: false, ...cfg }, ledger, repo);
  const prompts: { agent: string; text: string }[] = [];
  const starts: { agent: string; resume?: string }[] = [];
  app.checkBlockers = () => [];
  app.engineFactory = (agent) => {
    const e = new AcpEngine({ agent, name: agent, cmd: [], stream: fakeStream(async (text, ctx) => { prompts.push({ agent, text }); return agents[agent as keyof typeof agents]!(text, ctx); }, fake[agent]) });
    const start = e.start.bind(e);
    e.start = async (o) => { starts.push({ agent, resume: o.resume?.id }); return start(o); };
    return e;
  };
  (app as any).refreshDetect = async () => { for (const id of ids) (app as any).detect.set(id, { installed: true, version: "t", engine: true }); };
  const frame = async (pred: (f: string) => boolean, ms = 8000) => {
    const t0 = Date.now(); let f = "";
    while (Date.now() - t0 < ms) { await setup.renderOnce(); f = setup.captureCharFrame(); if (pred(f)) return f; await Bun.sleep(30); }
    throw new Error(`timeout; last frame:\n${f}`);
  };
  const send = async (t: string) => { await setup.mockInput.typeText(t); setup.mockInput.pressEnter(); };
  const cleanup = async () => { await app.quit(); setup.renderer.destroy(); };
  return { setup, app, repo, ledger, prompts, starts, frame, send, cleanup };
}

const reply = (t: string): Handler => async (_text, { say }) => say(t);

test("1. auto-handoff on quota: Enter continues the unfinished request in the next agent", async () => {
  let claudeCalls = 0;
  const h = await harness({
    claude: async (_t, { say }) => { claudeCalls++; if (claudeCalls === 1) return say("First answer."); throw new Error("You've hit your usage limit · resets 6pm"); },
    codex: reply("Codex picked it up."),
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("first question");
    await h.frame((f) => f.includes("First answer."));
    await h.send("refactor the parser");
    const f = await h.frame((f) => f.includes("Continue in Codex"));
    expect(f).toContain("out of quota");
    expect(f).toContain("Stay on Claude Code");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Codex picked it up."));
    const brief = h.prompts.find((p) => p.agent === "codex")!.text;
    expect(brief).toContain("[codemax handoff]");
    expect(brief).toContain("ran out of quota mid-task");
    expect(brief).toContain("refactor the parser");
  } finally { await h.cleanup(); }
}, 30000);

test("2. daily budget: warns at 80%, offers a handoff at 100%, footer shows spend", async () => {
  let cost = 0;
  const h = await harness({
    claude: async (_t, { conn, sessionId, say }) => {
      cost += 0.9;
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: cost, currency: "USD" } } as any });
      await say("done");
    },
    codex: reply("codex here"),
  }, { budgets: { claude: 1 } });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("one");
    let f = await h.frame((f) => f.includes("80%+"));
    expect(f).toMatch(/\$0\.90\/\$1\.00 today/);
    await h.send("two");
    f = await h.frame((f) => f.includes("daily budget") && f.includes("Continue in Codex"));
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("codex here"));
    expect(h.prompts.find((p) => p.agent === "codex")!.text).toContain("hit its daily budget");
  } finally { await h.cleanup(); }
}, 30000);

test("3. checkpoints: /undo restores edited files and removes files the agent created", async () => {
  const h = await harness({
    claude: async (_t, { say }) => {
      writeFileSync(join(h.repo, "README.md"), "agent rewrote this\n");
      mkdirSync(join(h.repo, "src"), { recursive: true });
      writeFileSync(join(h.repo, "src", "new.ts"), "export {}\n");
      await say("Edited.");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    writeFileSync(join(h.repo, "notes.txt"), "user's uncommitted work\n"); // must survive
    await h.send("change things");
    await h.frame((f) => f.includes("Edited."));
    expect(readFileSync(join(h.repo, "README.md"), "utf8")).toBe("agent rewrote this\n");
    await h.send("/undo");
    await h.frame((f) => f.includes("reverted to the snapshot"));
    expect(readFileSync(join(h.repo, "README.md"), "utf8")).toBe("original\n");
    expect(existsSync(join(h.repo, "src", "new.ts"))).toBe(false);
    expect(existsSync(join(h.repo, "src"))).toBe(false);
    expect(readFileSync(join(h.repo, "notes.txt"), "utf8")).toBe("user's uncommitted work\n");
    // git state untouched: index clean of codemax, no stash
    expect(Bun.spawnSync(["git", "stash", "list"], { cwd: h.repo }).stdout.toString()).toBe("");
    // the agent is told on the next turn
    await h.send("ok");
    await h.frame(() => h.prompts.length >= 2);
    expect(h.prompts[1]!.text).toContain("reverted the file changes");
  } finally { await h.cleanup(); }
}, 30000);

test("4. @file: palette completes paths and the file's contents travel with the message", async () => {
  const h = await harness({ claude: reply("Read it.") }, {}, (repo) => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "parser.ts"), "export const parse = () => 42;\n");
    writeFileSync(join(repo, "src", "other.ts"), "x\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.setup.mockInput.typeText("explain @pars");
    let f = await h.frame((f) => f.includes("Attach a file") && f.includes("src/parser.ts"));
    expect(f).not.toContain("src/other.ts");
    h.setup.mockInput.pressTab();
    f = await h.frame((f) => f.includes("❯ explain @src/parser.ts") && !f.includes("Attach a file"));
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Read it."));
    const sent = h.prompts[0]!.text;
    expect(sent).toContain("explain @src/parser.ts");
    expect(sent).toContain("--- src/parser.ts ---");
    expect(sent).toContain("export const parse = () => 42;");
  } finally { await h.cleanup(); }
}, 30000);

test("5. /ask and routing rules: one-off answers from another agent, active agent unchanged", async () => {
  const h = await harness({ claude: reply("claude answer"), codex: reply("codex review done") }, { routes: [{ match: "^review", agent: "codex" }] });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("hello");
    await h.frame((f) => f.includes("claude answer"));
    await h.send("/ask codex what changed?");
    let f = await h.frame((f) => f.includes("codex review done") && f.includes("back to Claude Code"));
    expect(f).toContain("asked codex");
    await h.send("review the last commit");
    f = await h.frame((f) => f.includes("routed to codex by rule"));
    await h.frame(() => h.prompts.filter((p) => p.agent === "codex").length >= 2);
    const codexPrompts = h.prompts.filter((p) => p.agent === "codex");
    expect(codexPrompts[0]!.text).toContain("what changed?");
    expect(codexPrompts[1]!.text).toContain("review the last commit");
    await h.send("still claude?");
    await h.frame(() => h.prompts.filter((p) => p.agent === "claude").length === 2);
    f = await h.frame((f) => /Claude Code/.test(f.split("\n").at(-2) ?? f));
    expect(f).toMatch(/Claude Code/);
  } finally { await h.cleanup(); }
}, 30000);

test("6. startup picker: lists agents, most recent first, with their last message, and resumes the chosen one", async () => {
  const h = await harness({ claude: reply("resumed claude"), codex: reply("resumed codex") }, {}, (repo, ledger) => {
    const now = Date.now();
    ledger.saveSession({ agent: "claude", id: "claude-old", cwd: repo, startedAt: now - 7200_000, lastUsedAt: now - 3600_000 });
    ledger.saveSession({ agent: "codex", id: "codex-recent", cwd: repo, startedAt: now - 600_000, lastUsedAt: now - 300_000 });
    ledger.addTurns([
      { ts: now - 3600_000, agent: "claude", sessionId: "claude-old", role: "user", text: "add a parser" },
      { ts: now - 300_000, agent: "codex", sessionId: "codex-recent", role: "user", text: "fix the flaky test" },
    ]);
  });
  try {
    void h.app.start("claude", false, { pick: true });
    let f = await h.frame((f) => f.includes("Choose an agent to continue with"));
    expect(f).toContain('"fix the flaky test"');
    expect(f).toContain('"add a parser"');
    expect(f.indexOf("Codex  ")).toBeLessThan(f.indexOf("Claude Code  ")); // most recent first
    expect(f).toContain("New thread with Codex");
    h.setup.mockInput.pressArrow("down");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("resumed"));
    expect(h.starts[0]).toEqual({ agent: "claude", resume: "claude-old" });
  } finally { await h.cleanup(); }
}, 30000);

test("3b. checkpoints skip large untracked files, never delete them on /undo, and prune to the newest refs", async () => {
  const { createCheckpoint, restoreCheckpoint, listCheckpoints, pruneCheckpoints, MAX_UNTRACKED_BYTES } = await import("../src/core/checkpoint.ts");
  const repo = mkdtempSync(join(tmpdir(), "codemax-cp-"));
  Bun.spawnSync(["sh", "-c", "git init -q && echo a > a.txt && git add -A && git -c user.email=a@b -c user.name=t commit -qm init"], { cwd: repo });
  writeFileSync(join(repo, "weights.bin"), Buffer.alloc(MAX_UNTRACKED_BYTES + 1));
  const cp = (await createCheckpoint(repo, "t"))!;
  const files = Bun.spawnSync(["git", "ls-tree", "-r", "--name-only", cp.sha], { cwd: repo }).stdout.toString();
  expect(files).toContain("a.txt");
  expect(files).not.toContain("weights.bin");
  writeFileSync(join(repo, "a.txt"), "changed\n");
  await restoreCheckpoint(repo, cp.sha);
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a\n");
  expect(existsSync(join(repo, "weights.bin"))).toBe(true);
  for (let i = 0; i < 4; i++) await createCheckpoint(repo, `n${i}`);
  await pruneCheckpoints(repo, 2);
  expect((await listCheckpoints(repo, 100)).length).toBe(2);
}, 30000);

test("5b. /ask sessions are not offered for resume", async () => {
  const h = await harness({ claude: reply("c"), codex: reply("x") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("/ask codex hi");
    await h.frame((f) => f.includes("back to Claude Code"));
    expect(Object.keys(h.ledger.sessions())).toEqual(["claude"]);
  } finally { await h.cleanup(); }
}, 30000);

const upd = (ctx: Ctx, update: Record<string, unknown>) => ctx.conn.sessionUpdate({ sessionId: ctx.sessionId, update } as any);

test("7. switching before any conversation sends no handoff brief", async () => {
  const h = await harness({ claude: reply("hi"), codex: reply("codex ready") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await (h.app as any).switchTo("codex", true);
    await h.frame((f) => /Codex t · new session/.test(f));
    await Bun.sleep(200);
    expect(h.prompts.filter((p) => p.agent === "codex")).toHaveLength(0);
  } finally { await h.cleanup(); }
}, 30000);

test("8. separate agent messages become separate paragraphs, recorded with a blank line between", async () => {
  const h = await harness({
    claude: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Checking the theme." } });
      await upd(ctx, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Now fixing it." } });
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("go");
    const f = await h.frame((f) => f.includes("Now fixing it."));
    expect(f).not.toContain("theme.Now");
    await h.frame(() => h.ledger.turns().some((t: any) => t.role === "assistant"));
    expect(h.ledger.turns().find((t: any) => t.role === "assistant")!.text).toBe("Checking the theme.\n\nNow fixing it.");
  } finally { await h.cleanup(); }
}, 30000);

test("9. reasoning shows as a collapsed Thinking line and plans as a checklist", async () => {
  const h = await harness({
    claude: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "The user wants tests first." } });
      await upd(ctx, { sessionUpdate: "plan", entries: [{ content: "write tests", status: "completed", priority: "high" }, { content: "fix theme", status: "in_progress", priority: "high" }, { content: "ship", status: "pending", priority: "low" }] });
      await ctx.say("Done.");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("plan it");
    const f = await h.frame((f) => f.includes("Done."));
    expect(f).toContain("Thinking");
    expect(f).toContain("Thinking… The user wants tests first."); // a short preview: some agents narrate only here
    // The plan is pinned above the prompt (Claude Code's task list), not in the transcript.
    expect(f).toContain("3 tasks (1 done, 1 in progress, 1 open)");
    expect(f).toContain("✔ write tests");
    expect(f).toContain("◼ fix theme");
    expect(f).toContain("◻ ship");

  } finally { await h.cleanup(); }
}, 30000);

test("9b. a finished plan leaves one line in the chat when the pinned list clears", async () => {
  const h = await harness({
    claude: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "plan", entries: [{ content: "write tests", status: "completed", priority: "high" }, { content: "ship", status: "completed", priority: "low" }] });
      await ctx.say("All done.");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("do it");
    const f = await h.frame((f) => f.includes("2 tasks done: write tests, ship"));
    expect(f).not.toContain("2 tasks (2 done"); // the pinned list is gone
  } finally { await h.cleanup(); }
}, 30000);

test("10. OpenCode-style agents: model from config options, exact turn usage, context meter, model switch", async () => {
  const configCalls: unknown[] = [];
  const h = await harness({
    opencode: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "usage_update", used: 18000, size: 200000, cost: { amount: 0, currency: "USD" } });
      await ctx.say("PONG");
      return { usage: { inputTokens: 11142, outputTokens: 4, thoughtTokens: 12, cachedReadTokens: 6144, totalTokens: 17302 } };
    },
  }, {}, undefined, {
    opencode: {
      configCalls,
      session: { configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "opencode/big-pickle", options: [{ value: "opencode/big-pickle", name: "Big Pickle" }, { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" }] }] },
    },
  });
  try {
    void h.app.start("opencode", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("ping");
    const f = await h.frame((f) => f.includes("PONG") && f.includes("ctx 9%"));
    expect(f).toContain("Big Pickle");
    const usage = h.ledger.usage();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: "opencode/big-pickle", input: 11142 - 6144, output: 16, cacheRead: 6144 });
    const engine = (h.app as any).active.engine;
    expect(engine.info.models.map((m: any) => m.id)).toContain("anthropic/claude-sonnet-4-5");
    await engine.setModel("anthropic/claude-sonnet-4-5");
    expect(configCalls).toEqual([expect.objectContaining({ configId: "model", value: "anthropic/claude-sonnet-4-5" })]);
    expect(engine.info.currentModel).toBe("anthropic/claude-sonnet-4-5");
  } finally { await h.cleanup(); }
}, 30000);

test("11. a quota handoff with no unanswered request does not ask the next agent to finish one", async () => {
  const h = await harness({ claude: reply("hi"), codex: reply("codex here") }, {}, (_repo, ledger) => {
    ledger.addTurns([
      { ts: Date.now() - 2000, agent: "claude", sessionId: "x", role: "user", text: "rename the helper" },
      { ts: Date.now() - 1000, agent: "claude", sessionId: "x", role: "assistant", text: "Renamed." },
    ]);
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    (h.app as any).quota.set("claude", { agent: "claude", exhausted: true, source: "probe", at: Date.now() });
    await (h.app as any).switchTo("codex", false);
    await h.frame((f) => f.includes("codex here"));
    const brief = h.prompts.find((p) => p.agent === "codex")!.text;
    expect(brief).toContain("ran out of quota");
    expect(brief).not.toContain("finish the last user request");
  } finally { await h.cleanup(); }
}, 30000);

test("12. one-model agents say so, and /effort switches reasoning effort through config options", async () => {
  const configCalls: unknown[] = [];
  const h = await harness({ opencode: reply("ok") }, {}, undefined, {
    opencode: {
      configCalls,
      session: {
        models: { currentModelId: "grok-4.7", availableModels: [{ modelId: "grok-4.7", name: "Grok 4.7" }] },
        configOptions: [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: "grok-4.7", options: [{ value: "grok-4.7", name: "Grok 4.7" }] },
          { id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }, { value: "low", name: "Low" }] },
        ],
      },
    },
  });
  try {
    void h.app.start("opencode", true);
    await h.frame((f) => f.includes("new session"));
    expect(await h.frame((f) => f.includes("Grok 4.7 high"))).toBeTruthy();
    await h.send("/model");
    await h.frame((f) => f.includes("offers one model on your plan: Grok 4.7") && f.includes("/effort"));
    await h.send("/effort low");
    await h.frame((f) => f.includes("reasoning effort: low") && f.includes("Grok 4.7 low"));
    expect(configCalls).toEqual([expect.objectContaining({ configId: "reasoning_effort", value: "low" })]);
  } finally { await h.cleanup(); }
}, 30000);

test("13. agents that only list models (Claude adapter) switch through session/set_model", async () => {
  const calls: unknown[] = [];
  const h = await harness({ claude: reply("ok") }, {}, undefined, {
    claude: { configCalls: calls, session: { models: { currentModelId: "default", availableModels: [{ modelId: "default", name: "Default" }, { modelId: "opus", name: "Opus" }] } } },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("/model opus");
    await h.frame((f) => f.includes("model: Opus"));
    expect(calls).toEqual([expect.objectContaining({ method: "session/set_model", modelId: "opus" })]);
  } finally { await h.cleanup(); }
}, 30000);

test("14. Claude's session-limit error offers a handoff and the next agent gets the request", async () => {
  let n = 0;
  const h = await harness({
    claude: async (_t, { say }) => { if (++n === 1) return say("First."); throw new Error("You've hit your session limit · resets 3pm"); },
    codex: reply("Codex took over."),
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("one");
    await h.frame((f) => f.includes("First."));
    await h.send("add the login page");
    const f = await h.frame((f) => f.includes("Continue in Codex"));
    expect(f).toContain("out of quota until");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Codex took over."));
    const brief = h.prompts.find((p) => p.agent === "codex")!.text;
    expect(brief).toContain("finish the last user request");
    expect(brief).toContain("add the login page");
  } finally { await h.cleanup(); }
}, 30000);

test("15. a reply that is only a limit notice also offers the handoff, and is not saved as an answer", async () => {
  const h = await harness({ claude: reply("You've hit your session limit · resets 3pm"), codex: reply("ok") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("write the docs");
    await h.frame((f) => f.includes("Continue in Codex"));
    expect(h.ledger.turns().map((t: any) => t.role)).toEqual(["user"]);
  } finally { await h.cleanup(); }
}, 30000);

test("16. selecting text with the mouse copies it", async () => {
  const h = await harness({ claude: reply("COPY-THIS-LINE please") });
  const copied: string[] = [];
  (h.app as any).copyText = async (t: string) => { copied.push(t); return true; };
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("go");
    const f = await h.frame((f) => f.includes("COPY-THIS-LINE"));
    const row = f.split("\n").findIndex((l) => l.includes("COPY-THIS-LINE"));
    const col = f.split("\n")[row]!.indexOf("COPY-THIS-LINE");
    await h.setup.mockMouse.drag(col, row, col + 13, row);
    await h.frame((fr) => copied.length > 0 || fr.includes("copied"));
    expect(copied[0]).toContain("COPY-THIS-LINE");
    await h.frame((fr) => fr.includes("copied 14 chars"));
  } finally { await h.cleanup(); }
}, 30000);

test("17. a mid-turn limit hands over a resume packet: task, in-flight step with its input, plan, real diff", async () => {
  const h = await harness({
    claude: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "plan", entries: [{ content: "Add the validation helper", status: "completed", priority: "high" }, { content: "Run the auth tests", status: "in_progress", priority: "high" }, { content: "Wire it into the form", status: "pending", priority: "medium" }] });
      writeFileSync(join(h.repo, "auth.ts"), "export const validated = true\n");
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "e1", title: "Write auth.ts", kind: "edit", status: "completed", rawInput: { file_path: "auth.ts", content: "export const validated = true" }, locations: [{ path: "auth.ts" }] });
      await ctx.say("Helper added; running the tests now.");
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "b1", title: "Bash(bun test test/auth.test.ts)", kind: "execute", status: "in_progress", rawInput: { command: "bun test test/auth.test.ts" } });
      throw new Error("You've hit your session limit · resets 3pm");
    },
    codex: reply("Codex: checked the test run, continuing with the form."),
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("add login validation");
    await h.frame((f) => f.includes("Continue in Codex"));
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Codex: checked the test run"));
    const packet = h.prompts.find((p) => p.agent === "codex")!.text;
    if (process.env.SHOW_PACKET) console.log(packet);
    expect(packet).toContain("[codemax handoff]");
    expect(packet).toContain("> add login validation");
    expect(packet).toContain("ran out of its usage limit");
    expect(packet).toContain("In flight when it stopped: Bash(bun test test/auth.test.ts)");
    expect(packet).toContain('"command":"bun test test/auth.test.ts"');
    expect(packet).toContain("Run the auth tests  ← continue here");
    expect(packet).toContain("+export const validated = true");
    expect(packet).toContain('Its last words: "Helper added; running the tests now."');
    expect(packet).not.toContain("## Uncommitted changes");
    // the journal recorded the interrupted turn and how it ended
    const ends: any[] = h.ledger.journal.steps().filter((s: any) => s.kind === "end");
    expect(ends[0]).toMatchObject({ agent: "claude", outcome: "limit" });
    expect(ends[0].inFlight).toHaveLength(1);
  } finally { await h.cleanup(); }
}, 30000);

test("18. returning to an agent with its own session sends only what the others did, and /task shows both", async () => {
  const h = await harness({
    claude: async (text, ctx) => {
      if (text.startsWith("[codemax handoff]")) return ctx.say("Caught up.");
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "r1", title: "Read a.ts", kind: "read", status: "completed", rawInput: { path: "a.ts" } });
      await ctx.say("Read it.");
    },
    codex: async (text, ctx) => {
      if (text.startsWith("[codemax handoff]")) {
        // takes over and changes code in the handoff turn itself
        writeFileSync(join(h.repo, "c.ts"), "export const c = 3\n");
        await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "w0", title: "Write c.ts", kind: "edit", status: "completed", rawInput: { path: "c.ts" } });
        return ctx.say("On it.");
      }
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "w1", title: "Edit b.ts", kind: "edit", status: "completed", rawInput: { path: "b.ts" } });
      await ctx.say("Edited b.");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("look at a");
    await h.frame((f) => f.includes("Read it."));
    await (h.app as any).switchTo("codex", false);
    await h.frame((f) => f.includes("On it."));
    await h.send("now edit b");
    await h.frame((f) => f.includes("Edited b."));
    await (h.app as any).switchTo("claude", false);
    await h.frame((f) => f.includes("Caught up."));
    const back = h.prompts.filter((p) => p.agent === "claude").at(-1)!.text;
    expect(back).toContain("Welcome back");
    expect(back).toContain("Edit b.ts");
    expect(back).toContain("> now edit b");
    expect(back).not.toContain("Read a.ts");
    expect(back).toContain("Write c.ts");
    expect(back).toContain("+export const c = 3");
    await h.send("/task");
    const f = await h.frame((f) => f.includes("task: \"now edit b\""));
    expect(f).toContain("steps: codex 1");
  } finally { await h.cleanup(); }
}, 30000);

test("19. /ask gets the task as context only, never the takeover instructions, and stays out of the journal", async () => {
  const h = await harness({
    claude: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "plan", entries: [{ content: "step one", status: "in_progress", priority: "high" }] });
      await ctx.say("Working.");
    },
    codex: reply("Looks fine to me."),
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("build the thing");
    await h.frame((f) => f.includes("Working."));
    const before = h.ledger.journal.steps().length;
    await h.send("/ask codex is the plan sound?");
    await h.frame((f) => f.includes("Looks fine to me."));
    const side = h.prompts.find((p) => p.agent === "codex")!.text;
    expect(side).toContain("Context only");
    expect(side).toContain("is the plan sound?");
    expect(side).not.toContain("Continue now");
    expect(side).not.toContain("continue here");
    expect(h.ledger.journal.steps().length).toBe(before);
  } finally { await h.cleanup(); }
}, 30000);

test("20. /awake turns keep-awake on with a footer badge, saves it, and quitting releases it", async () => {
  const h = await harness({ claude: reply("ok") });
  const spawned: { cmd: string; killed: boolean }[] = [];
  const { Awake } = await import("../src/core/awake.ts");
  (h.app as any).awake = new Awake({
    platform: "linux", pid: process.pid, recordPath: join(mkdtempSync(join(tmpdir(), "aw-")), "r.json"),
    which: () => "/usr/bin/systemd-inhibit", run: async () => ({ code: 0, out: "", err: "" }),
    spawn: (cmd) => { const s = { cmd: cmd.join(" "), killed: false }; spawned.push(s); return { kill: () => void (s.killed = true) }; },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("/awake lid");
    const f = await h.frame((f) => f.includes("awake lid: this machine will not sleep") && f.includes("● awake · lid"));
    expect(f).toContain("not in a bag");
    expect(spawned[0]!.cmd).toContain("handle-lid-switch");
    await h.app.quit();
    expect(spawned[0]!.killed).toBe(true);
  } finally { await h.cleanup(); }
}, 30000);

test("21. side agent: reviews each working turn, notes wait above the prompt (1 expand · 2 discuss · 0 dismiss), its permission asks are refused", async () => {
  let reviews = 0;
  const permOutcomes: string[] = [];
  const h = await harness({
    claude: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: `t${Math.random()}`, title: "Bash(bun test)", kind: "execute", status: "completed", rawInput: { command: "bun test" } });
      await ctx.say("Tests pass; shipping it.");
    },
    codex: async (text, ctx) => {
      if (!text.includes("You are a side agent")) return ctx.say("?");
      reviews++;
      const r: any = await ctx.conn.requestPermission({ sessionId: ctx.sessionId, toolCall: { toolCallId: "p1", title: "Edit src/a.ts" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } as any);
      permOutcomes.push(r.outcome.optionId ?? r.outcome.outcome);
      if (reviews === 1) return ctx.say("Heads up · The tests only ran once, so a flaky pass would ship.\n\n**Thin evidence**\n- `bun test` ran a single time\n- **Consider running it twice before shipping.**");
      return ctx.say("NO_NOTE");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await (h.app as any).enableSide("codex", { forward: "ask", pickModel: false });
    await h.frame((f) => f.includes("side agent: Codex reviews every turn") && f.includes("appear above the"));
    await h.send("ship the release");
    let f = await h.frame((f) => f.includes("⚑ Heads up from Codex") && f.includes("1 expand · 2 discuss with Claude Code · 0 dismiss (type the number and pause)"));
    expect(f).toContain("The tests only ran once, so a flaky pass would ship.");
    expect(f).not.toContain("Thin evidence"); // collapsed until you press 1
    expect(permOutcomes).toEqual(["reject"]);
    // A message that starts with a digit is a message: the note is untouched.
    await h.setup.mockInput.typeText("2 more tests please");
    await Bun.sleep(900);
    f = await h.frame((f) => f.includes("❯ 2 more tests please"));
    expect(h.prompts.filter((p) => p.agent === "claude")).toHaveLength(1);
    expect((h.app as any).notePanel.count).toBe(1);
    for (let i = 0; i < "2 more tests please".length; i++) h.setup.mockInput.pressBackspace();
    await h.frame((f) => /❯ (Try "fix the failing test"|Tip: )/.test(f));
    // A lone digit, then a pause: it acts on the note and leaves the prompt.
    await h.setup.mockInput.typeText("1");
    f = await h.frame((f) => f.includes("Thin evidence") && f.includes("1 collapse") && /❯ (Try "fix the failing test"|Tip: )/.test(f));
    expect(f).toContain("Consider running it twice");
    expect(h.prompts.filter((p) => p.agent === "claude")).toHaveLength(1); // nothing was sent
    await h.setup.mockInput.typeText("2");
    await h.frame(() => h.prompts.filter((p) => p.agent === "claude").length === 2);
    const fwd = h.prompts.filter((p) => p.agent === "claude")[1]!.text;
    expect(fwd).toContain("A side agent (Codex) reviewing your work left this note");
    expect(fwd).toContain("Consider running it twice");
    // the main agent's reply to a forwarded note is not reviewed (no note → turn → review loop)
    await Bun.sleep(300);
    expect(reviews).toBe(1);
    // the next turn the user starts is reviewed again, and this time the side agent stays quiet
    await h.send("now tag the release");
    await h.frame(() => reviews === 2);
    await Bun.sleep(150);
    expect((h.app as any).notes).toHaveLength(1);
    expect((h.app as any).notePanel.count).toBe(0); // the discussed note left the panel
    // 0 dismisses a note without sending it
    (h.app as any).addNote("codex", "Codex", "Heads up · The changelog still says 0.1.3 for this release.\n\n**Stale changelog**\n- x");
    await h.frame((f) => f.includes("changelog still says 0.1.3"));
    await h.setup.mockInput.typeText("0");
    await h.frame((f) => f.includes("dismissed Codex's note: The changelog still says 0.1.3"));
    expect(h.prompts.filter((p) => p.agent === "claude")).toHaveLength(3);
    // reviewer turns stay out of the journal
    expect(h.ledger.journal.steps().some((s: any) => s.agent === "codex")).toBe(false);
  } finally { await h.cleanup(); }
}, 30000);

test("22. side agent in auto mode forwards its note to the main agent by itself", async () => {
  let reviewed = false;
  const h = await harness({
    claude: async (_t, ctx) => { await ctx.say("Changed the schema."); },
    codex: async (text, ctx) => {
      if (reviewed || !text.includes("You are a side agent")) return ctx.say("NO_NOTE");
      reviewed = true;
      return ctx.say("Heads up · The schema change has no migration.\n\n**Missing migration**\n- the column was renamed in place\n- **Consider adding a migration.**");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await (h.app as any).enableSide("codex", { forward: "auto", pickModel: false });
    await h.frame((f) => f.includes("side agent: Codex reviews every turn") && f.includes("◆ side codex"));
    await h.send("rename the column");
    await h.frame((f) => f.includes("sent to Claude"));
    await h.frame(() => h.prompts.filter((p) => p.agent === "claude").some((p) => p.text.includes("Missing migration")));
  } finally { await h.cleanup(); }
}, 30000);

test("23. the UI survives tiny and changing terminal sizes with long content, menus and note cards", async () => {
  const long = "x".repeat(300);
  const h = await harness({
    claude: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking ".repeat(60) } });
      await upd(ctx, { sessionUpdate: "plan", entries: [{ content: "a very long plan entry ".repeat(10), status: "in_progress", priority: "high" }] });
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "t1", title: `Bash(${"echo ".repeat(50)})`, kind: "execute", status: "completed", content: [{ type: "content", content: { type: "text", text: `${long}\n`.repeat(20) } }] });
      await ctx.say(`Done. ${long} and **bold** \`code\` text.`);
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    h.setup.resize(32, 18);
    await h.send(`please handle ${long}`);
    await h.frame((f) => f.includes("for ") || f.includes("Done"), 10000);
    (h.app as any).addNote("codex", "Codex", `Heads up · ${"careful ".repeat(30)}\n\n**Title**\n- ${long}\n- **Consider something.**`);
    for (const [w, ht] of [[24, 10], [140, 45], [40, 12], [80, 24]] as const) {
      h.setup.resize(w, ht);
      await h.setup.renderOnce();
    }
    h.setup.resize(30, 14);
    await h.setup.mockInput.typeText("/");
    await h.frame((f) => f.includes("/agents"));
    h.setup.mockInput.pressEscape();
    h.setup.mockInput.pressEscape();
    await h.send("/config");
    await h.frame((f) => f.includes("Settings") || f.includes("Theme"));
    h.setup.mockInput.pressEscape();
    h.setup.resize(110, 30);
    const f = await h.frame((f) => f.includes("Heads up from Codex"));
    expect(f).toContain("2 discuss with Claude Code");
    expect((h.app as any).uiErrors).toBe(0);
  } finally { await h.cleanup(); }
}, 30000);

test("24. /config changes settings and saves them, and turns on the side agent with a model from its own list", async () => {
  const calls: unknown[] = [];
  const h = await harness({ claude: reply("ok"), codex: reply("NO_NOTE") }, {}, undefined, {
    codex: { configCalls: calls, session: { models: { currentModelId: "gpt-5.6-terra", availableModels: [{ modelId: "gpt-5.6-terra", name: "Terra" }, { modelId: "gpt-5.6-mini", name: "Mini" }] } } },
  });
  const { CONFIG_PATH } = await import("../src/config.ts");
  const { readFileSync, writeFileSync } = await import("node:fs");
  writeFileSync(CONFIG_PATH, "{}\n");
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("/config");
    await h.frame((f) => f.includes("Theme") && f.includes("Keep awake") && f.includes("Side agent model"));
    await h.setup.mockInput.typeText("theme");
    await h.frame((f) => f.includes("Theme") && !f.includes("Keep awake"));
    h.setup.mockInput.pressEnter(); // Theme
    await h.frame((f) => f.includes("Theme · now"));
    await h.setup.mockInput.typeText("light");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("colours: codemax, light"));
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).theme).toBe("light");
    await h.setup.mockInput.typeText("side agent");
    await h.frame((f) => f.includes("Side agent") && !f.includes("Keep awake"));
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Side agent · now") && f.includes("its own subscription"));
    await h.setup.mockInput.typeText("codex");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Model for the side agent (Codex)"));
    await h.setup.mockInput.typeText("mini");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("side agent model: Mini") && f.includes("◆ side codex Mini"));
    expect(calls).toEqual([expect.objectContaining({ method: "session/set_model", modelId: "gpt-5.6-mini" })]);
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).sideAgent).toMatchObject({ agent: "codex", model: "gpt-5.6-mini" });
  } finally { await h.cleanup(); }
}, 30000);

test("25. side agent cadence: never on the main plan unless allowed, every 2nd turn reviews, paused reviews none", async () => {
  const reviewed: number[] = [];
  let turn = 0;
  const h = await harness({
    claude: async (text, ctx) => {
      if (text.includes("You are a side agent")) { reviewed.push(turn); return ctx.say("NO_NOTE"); }
      turn++;
      await ctx.say(`work ${turn}`);
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    // Not chosen explicitly: a side agent on the main agent's own plan stays paused.
    (h.app as any).config.sideAgent = { agent: "claude", forward: "ask", every: 1 };
    await h.send("task 0");
    await h.frame((fr) => fr.includes("work 1") && fr.includes("side agent paused: Claude Code is now the main agent"));
    await Bun.sleep(150);
    expect(reviewed).toEqual([]);
    turn = 0;
    (h.app as any).config.sideAgent = { agent: null, forward: "ask", every: 2 };
    await (h.app as any).enableSide("claude", { forward: "ask", pickModel: false, samePlan: true });
    const f = await h.frame((f) => f.includes("is also the main agent"));
    expect(f).toContain("reviews every 2nd turn");
    for (let i = 1; i <= 4; i++) {
      await h.send(`task ${i}`);
      await h.frame((fr) => fr.includes(`work ${i}`));
      await Bun.sleep(120);
    }
    await h.frame(() => reviewed.length === 2);
    expect(reviewed).toEqual([2, 4]);
    (h.app as any).config.sideAgent.every = 0;
    await h.send("task 5");
    await h.frame((fr) => fr.includes("work 5"));
    await Bun.sleep(200);
    expect(reviewed).toHaveLength(2);
    // The slash commands are gone: the side agent is set up in /config only.
    const names = (h.app as any).builtins().map((b: any) => b.name);
    for (const gone of ["/side", "/review", "/notes", "/forward"]) expect(names).not.toContain(gone);
  } finally { await h.cleanup(); }
}, 30000);

test("26. auto mode cannot loop: note replies are not reviewed, auto-forwards are capped, notes never become the task", async () => {
  let reviews = 0;
  const h = await harness({
    claude: async (text, ctx) => ctx.say(text.startsWith("A side agent (") ? "Agreed, adjusted." : "Built the parser."),
    codex: async (_t, ctx) => { reviews++; await ctx.say(`Heads up · Issue number ${reviews} deserves a look before shipping.\n\n**Issue ${reviews}**\n- something specific\n- **Consider checking it.**`); },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await (h.app as any).enableSide("codex", { forward: "auto", pickModel: false });
    await h.frame((f) => f.includes("◆ side codex"));
    await h.send("build the parser");
    await h.frame((f) => f.includes("Agreed, adjusted."));
    await Bun.sleep(400);
    expect(reviews).toBe(1); // the note reply did not trigger another review
    expect(h.prompts.filter((p) => p.agent === "claude")).toHaveLength(2);
    expect(h.ledger.journal.task().request?.text).toBe("build the parser");
    // two more notes in the same task: the second auto-forward of this task goes, the third waits
    (h.app as any).addNote("codex", "Codex", "Heads up · second note for this task, worth a look.\n\n**Two**\n- x\n- **Consider y.**");
    (h.app as any).addNote("codex", "Codex", "Heads up · third note for this task, worth a look.\n\n**Three**\n- x\n- **Consider y.**");
    await h.frame((f) => f.includes("auto-forward paused: 2 notes already sent for this task"));
  } finally { await h.cleanup(); }
}, 30000);

test("27. startup shows the wordmark and asks which agent to continue with; an update is announced with /update", async () => {
  const h = await harness({ claude: reply("hello from claude"), codex: reply("hello from codex") }, {}, (_repo, ledger) => {
    ledger.saveSession({ agent: "codex", id: "s-old", cwd: "/x", startedAt: Date.now() - 7200_000, lastUsedAt: Date.now() - 3600_000 });
    ledger.addTurns([{ ts: Date.now() - 3600_000, agent: "codex", sessionId: "s-old", role: "user", text: "fix the flaky test" }]);
  });
  (h.app as any).updateChecker = async () => "9.9.9";
  try {
    void h.app.start("claude", false, { pick: true });
    const f = await h.frame((f) => f.includes("Choose an agent to continue with"));
    expect(f).toContain("█████"); // the wordmark
    expect(f).toContain("Codex");
    expect(f).toContain('resume · 1h ago · "fix the flaky test"');
    expect(f).toContain("new session");
    expect(f).toContain("New thread with Codex");
    await h.frame((fr) => fr.includes("codemax 9.9.9 is available") && fr.includes("/update"));
    await h.setup.mockInput.typeText("claude");
    h.setup.mockInput.pressEnter();
    await h.frame((fr) => /Claude Code t · new session/.test(fr));
    await h.send("hi");
    await h.frame((fr) => fr.includes("hello from claude"));
    expect(h.starts.at(-1)!.agent).toBe("claude");
  } finally { await h.cleanup(); }
}, 30000);

test("28. /model lists the agent's own models by name, newest first, and scrolls to every one", async () => {
  const calls: unknown[] = [];
  const ids = ["default", "opus", "fable", "sonnet", "haiku", "claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"];
  const names = ["Default (recommended)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5", "Haiku 4.5", "Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6"];
  const h = await harness({ claude: reply("ok") }, {}, undefined, {
    claude: { configCalls: calls, session: { models: { currentModelId: "default", availableModels: ids.map((id, i) => ({ modelId: id, name: names[i] })) } } },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("/model");
    let f = await h.frame((f) => f.includes("Model for Claude Code") && f.includes("1/13"));
    // One column: names only, never the ids ("opus", "claude-sonnet-5") beside them.
    expect(f).not.toMatch(/claude-(opus|sonnet|haiku|fable)-|\b(opus|sonnet|haiku|fable)\b/);
    // newest first, Default pinned on top, equal versions in the agent's order
    const order = ["Default (recommended)", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "Fable 5.1", "Sonnet 5 ", "Opus 5 "];
    for (let i = 1; i < order.length; i++) expect(f.indexOf(order[i - 1]!)).toBeLessThan(f.indexOf(order[i]!));
    for (let i = 0; i < 9; i++) h.setup.mockInput.pressArrow("down");
    f = await h.frame((f) => f.includes("10/13") && f.includes("Opus 4.7"));
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("model: Opus 4.7"));
    expect(calls).toEqual([expect.objectContaining({ method: "session/set_model", modelId: "claude-opus-4-7" })]);
  } finally { await h.cleanup(); }
}, 30000);

test("29. queued messages stay pinned above the prompt until sent; the spinner and each turn show the responding model", async () => {
  let release!: () => void;
  let first = true;
  const h = await harness({
    claude: async (text, ctx) => {
      if (first) {
        first = false;
        await ctx.say("Working on it…");
        await new Promise<void>((r) => (release = r));
        return ctx.say(" done.");
      }
      await ctx.say(`Got: ${text}`);
    },
  }, {}, undefined, { claude: { session: { models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus 5.5" }, { modelId: "sonnet", name: "Sonnet 5.5" }] } } } });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("long task");
    await h.frame((f) => f.includes("Working on it…") && f.includes("Claude Code · Opus 5.5") && f.includes("esc to interrupt"));
    await h.send("second message");
    await h.send("third message");
    const f = await h.frame((f) => f.includes("❯ second message") && f.includes("❯ third message"));
    expect(f).toMatch(/❯ long task\s+· \d{1,2}:\d{2} (AM|PM)/); // sent messages carry a 12-hour time
    const lines = f.split("\n");
    const prompt = lines.findIndex((l) => l.includes('Try "fix the failing test"') || /^❯\s*$/.test(l.trim()));
    const q2 = lines.findIndex((l) => l.includes("❯ second message"));
    const q3 = lines.findIndex((l) => l.includes("❯ third message"));
    expect(q3).toBe(q2 + 1);
    expect(lines[q3 + 1]).toContain("↑ to edit or remove a queued message");
    expect(prompt - q3).toBeLessThanOrEqual(3); // directly above the input box (the hint and its top border in between)
    release();
    await h.frame((fr) => fr.includes("Got: second message") && fr.includes("Got: third message"));
    const after = await h.frame((fr) => !fr.split("\n").slice(-6).some((l) => l.includes("third message") && l.trim().startsWith("❯ third")) || true);
    expect(after).toContain("· Claude Code · Opus 5.5");
    expect((h.app as any).queue).toHaveLength(0);
    expect((h.app as any).queueBox.visible).toBe(false);
  } finally { await h.cleanup(); }
}, 30000);

test("30. an agent you name that is not available stops with a clear message instead of starting another", async () => {
  const h = await harness({ claude: reply("hi") });
  try {
    await expect(h.app.start("grok" as any, true, { explicit: true })).rejects.toThrow(/grok is (not installed|installed but has no protocol engine)\. Available: claude/);
    expect(h.starts).toHaveLength(0);
  } finally { await h.cleanup(); }
}, 30000);

test("31. Claude's plan limits show in /usage, a refused window offers the handoff, and its own /usage is /claude:usage", async () => {
  let n = 0;
  const h = await harness({
    claude: async (text, ctx) => {
      if (text.startsWith("/usage")) return ctx.say("Claude's own usage screen");
      n++;
      await upd(ctx, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "usage", description: "Plan usage" }, { name: "review", description: "Review" }] });
      await upd(ctx, { sessionUpdate: "usage_update", used: 1000, size: 200000, _meta: { "_claude/rateLimit": { status: n === 1 ? "allowed" : "rejected", rateLimitType: "five_hour", utilization: n === 1 ? 0.42 : 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } });
      await ctx.say(`turn ${n}`);
    },
    codex: reply("codex here"),
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("one");
    await h.frame((f) => f.includes("turn 1"));
    await h.send("/usage");
    await h.frame((f) => /Claude Code plan: 5-hour 42% · resets \w{3} \d+, \d{1,2}:\d{2} (AM|PM)/.test(f));
    await h.setup.mockInput.typeText("/claude:us");
    await h.frame((f) => f.includes("/claude:usage") && f.includes("Claude Code's own /usage"));
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Claude's own usage screen"));
    await h.send("two");
    await h.frame((f) => f.includes("out of quota until") && f.includes("Continue in Codex"));
  } finally { await h.cleanup(); }
}, 30000);

test("32. Warp sees the active agent's session, its permission wait and the end of the turn", async () => {
  const { TerminalStatus } = await import("../src/core/termstatus.ts");
  const sent: any[] = [];
  const h = await harness({
    claude: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.ts", kind: "read", status: "completed" });
      const r: any = await ctx.conn.requestPermission({ sessionId: ctx.sessionId, toolCall: { toolCallId: "p1", title: "Edit src/a.ts", kind: "edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } as any);
      await ctx.say(r.outcome.optionId === "allow" ? "Edited." : "Skipped.");
    },
  });
  h.app.term = new TerminalStatus(
    { status: (s) => void sent.push({ status: s.state }), notify: (m, t) => void sent.push(t === "warp://cli-agent" ? JSON.parse(m) : { plain: m }) },
    { cwd: "/w/proj", env: { WARP_CLI_AGENT_PROTOCOL_VERSION: "1", WARP_CLIENT_VERSION: "v0.2026.09.30.08.29.stable_01" }, enabled: () => true, notify: () => true },
  );
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("edit a.ts");
    await h.frame((f) => f.includes("Do you want to proceed?"));
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Edited."));
    await h.frame(() => sent.some((e) => e.event === "stop"));
    const events = sent.filter((e) => e.event).map((e) => e.event);
    expect(events).toEqual(["session_start", "prompt_submit", "tool_complete", "permission_request", "permission_replied", "stop"]);
    expect(sent.find((e) => e.event === "permission_request")).toMatchObject({ agent: "claude", summary: "Edit src/a.ts", project: "proj" });
    expect(sent.find((e) => e.event === "stop")).toMatchObject({ query: "edit a.ts", response: "Edited." });
    expect(sent.filter((e) => e.status).map((e) => e.status)).toEqual(["idle", "working", "blocked", "working", "done"]);
  } finally { await h.cleanup(); }
}, 30000);

test("33. an agent's questions open a dialog: digits pick, typing fills Other, Esc skips; the side agent never asks", async () => {
  const { askUserQuestionsToCreateRequest } = await import("@agentclientprotocol/claude-agent-acp/dist/elicitation.js");
  const qs: any[] = [
    { question: "Which database should we use?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "relational, the default" }, { label: "SQLite" }] },
    { question: "Which checks should run?", header: "Checks", multiSelect: true, options: [{ label: "Lint" }, { label: "Tests" }] },
  ];
  const answers: any[] = [];
  const h = await harness({
    claude: async (_t, ctx) => {
      const r: any = await (ctx.conn as any).createElicitation(askUserQuestionsToCreateRequest(qs, ctx.sessionId, "t1"));
      answers.push(r);
      await ctx.say(r.action === "accept" ? "Thanks, going with that." : "OK, I'll pick myself.");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("set up storage");
    let f = await h.frame((f) => f.includes("Claude Code has a question · 1 of 2"));
    expect(f).toContain("[Database] Which database should we use?");
    expect(f).toContain("relational, the default");
    await h.frame((f) => f.includes("Waiting for your answer"));
    // A letter does not pick an option: it starts the "something else" answer.
    await h.setup.mockInput.typeText("s");
    await h.frame((f) => f.includes("Type something else: s"));
    h.setup.mockInput.pressBackspace();
    await h.setup.mockInput.typeText("2");
    f = await h.frame((f) => f.includes("Claude Code has a question · 2 of 2"));
    expect(f).toContain("[ ] Lint");
    await h.setup.mockInput.typeText("1");
    await h.frame((f) => f.includes("[x] Lint"));
    await h.setup.mockInput.typeText("Redis");
    await h.frame((f) => f.includes("Add your own: Redis"));
    h.setup.mockInput.pressEnter();
    f = await h.frame((f) => f.includes("Thanks, going with that."));
    expect(answers[0]).toEqual({ action: "accept", content: { question_0: "SQLite", question_1: ["Lint"], question_1_custom: "Redis" } });
    expect(f).toContain("Database: SQLite");
    expect(f).toContain('Checks: Lint, "Redis"');
    // Esc skips: the agent is told and carries on.
    await h.send("again");
    await h.frame((f) => f.includes("Claude Code has a question · 1 of 2"));
    h.setup.mockInput.pressEscape();
    await h.frame((f) => f.includes("OK, I'll pick myself.") && f.includes("skipped Claude Code's question"));
    expect(answers[1]).toEqual({ action: "decline" });
  } finally { await h.cleanup(); }
}, 30000);

test("34. the prompt grows as you type past one line, keeps the start in view, and shrinks after sending", async () => {
  const h = await harness({ claude: reply("got it") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    const long = "alpha " + "word ".repeat(40) + "omega";
    await h.setup.mockInput.typeText(long);
    // Both ends of the text are on screen: the box grew instead of scrolling to an empty line.
    const f = await h.frame((f) => f.includes("❯ alpha word") && f.includes("omega"));
    const rows = f.split("\n");
    const top = rows.findIndex((r) => r.startsWith("❯ alpha word"));
    const end = rows.findIndex((r) => r.includes("omega"));
    expect(end - top).toBeGreaterThanOrEqual(1);
    expect(rows[end + 1]).toMatch(/^─+$/); // the box border sits right below the last line
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("got it") && /❯ (Try "fix the failing test"|Tip: )/.test(f));
    const after = (await h.frame((f) => f.includes("got it"))).split("\n");
    const p = after.findIndex((r) => /^❯ (Try "fix the failing test"|Tip: )/.test(r));
    expect(after[p + 1]).toMatch(/^─+$/); // back to one line
  } finally { await h.cleanup(); }
}, 30000);

test("35. typing after / narrows the command menu and highlights the best match", async () => {
  const h = await harness({ claude: reply("ok") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.setup.mockInput.typeText("/");
    await h.frame((f) => f.includes("/agents"));
    // Scroll first, then type: the highlight must jump back to the best match.
    h.setup.mockInput.pressArrow("down");
    h.setup.mockInput.pressArrow("down");
    await h.setup.mockInput.typeText("usa");
    let f = await h.frame((f) => /❯ \/usage\s/.test(f));
    expect(f).not.toContain("/agents");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Usage for this project"));
    // Letters in order find a command too.
    await h.setup.mockInput.typeText("/mdl");
    f = await h.frame((f) => /❯ \/model\s/.test(f));
    h.setup.mockInput.pressEscape();
  } finally { await h.cleanup(); }
}, 30000);

test("36. subagents the main agent spawns are listed under the prompt with their latest step, and leave when done", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = await harness({
    claude: async (_t, ctx) => {
      const launch = (id: string, type: string, description: string) =>
        upd(ctx, { sessionUpdate: "tool_call", toolCallId: id, title: description, kind: "think", status: "in_progress", rawInput: { subagent_type: type, description, prompt: "..." }, _meta: { claudeCode: { toolName: "Agent" } } });
      const child = (parent: string, id: string, title: string) =>
        upd(ctx, { sessionUpdate: "tool_call", toolCallId: id, title, kind: "search", status: "in_progress", _meta: { claudeCode: { parentToolUseId: parent, toolName: "Grep" } } });
      await launch("a1", "Explore", "find where auth is checked");
      await launch("a2", "general-purpose", "update the tests");
      await child("a1", "c1", "Grep(requireAuth)");
      await child("a2", "c2", "Edit(test/auth.test.ts)");
      await gate;
      await upd(ctx, { sessionUpdate: "tool_call_update", toolCallId: "a1", status: "completed" });
      await ctx.say("Both agents reported back.");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("audit auth");
    const f = await h.frame((f) => f.includes("⏺ 2 agents running") && f.includes("Grep(requireAuth)") && f.includes("Edit(test/auth.test.ts)"));
    expect(f).toMatch(/⎿ Explore · find where auth is checked · Grep\(requireAuth\) · \d+s/);
    expect(f).toMatch(/⎿ general-purpose · update the tests · Edit\(test\/auth\.test\.ts\)/);
    // The list sits in the footer area, right above the mode line.
    const rows = f.split("\n");
    expect(rows.findIndex((r) => r.includes("⏺ 2 agents running"))).toBeGreaterThan(rows.findIndex((r) => r.startsWith("❯ ")));
    release();
    // The turn ends: every agent is over, shown with ✓ for a moment, then the list goes.
    await h.frame((f) => f.includes("Both agents reported back.") && f.includes("✓ Explore"));
    await h.frame((f) => !f.includes("✓ Explore") && !f.includes("agents running"), 8000);
  } finally { await h.cleanup(); }
}, 30000);

test("37. queued messages can be edited, reordered back in place, removed, or left as they were", async () => {
  let release!: () => void;
  const h = await harness({
    claude: async (text, ctx) => {
      if (text === "long job") await new Promise<void>((r) => (release = r));
      await ctx.say(`did: ${text}`);
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("long job");
    await h.frame((f) => f.includes("esc to interrupt"));
    await h.send("first queued");
    await h.send("second queued");
    await h.send("third queued");
    let f = await h.frame((f) => f.includes("❯ third queued") && f.includes("↑ to edit or remove a queued message"));
    // ↑ pulls the last one back; ↑ again moves to the one before it.
    h.setup.mockInput.pressArrow("up");
    await h.frame((f) => f.includes("editing a queued message") && /^❯ third queued\s*$/m.test(f));
    h.setup.mockInput.pressArrow("up");
    f = await h.frame((f) => /^❯ second queued\s*$/m.test(f));
    expect((h.app as any).queue).toEqual(["first queued", "third queued"]);
    // Edit it: Enter puts it back where it was.
    await h.setup.mockInput.typeText(" (edited)");
    h.setup.mockInput.pressEnter();
    await h.frame(() => (h.app as any).queue.length === 3);
    expect((h.app as any).queue).toEqual(["first queued", "second queued (edited)", "third queued"]);
    // Remove one: pull it up, clear it, Enter.
    h.setup.mockInput.pressArrow("up");
    await h.frame((f) => /^❯ third queued\s*$/m.test(f));
    for (let i = 0; i < "third queued".length; i++) h.setup.mockInput.pressBackspace();
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("removed from the queue: third queued"));
    // Esc leaves one exactly as it was.
    h.setup.mockInput.pressArrow("up");
    await h.frame((f) => /^❯ second queued \(edited\)\s*$/m.test(f));
    await h.setup.mockInput.typeText(" oops");
    h.setup.mockInput.pressEscape();
    await h.frame(() => (h.app as any).queue.length === 2);
    expect((h.app as any).queue).toEqual(["first queued", "second queued (edited)"]);
    expect(h.prompts.map((p) => p.text)).toEqual(["long job"]); // nothing interrupted, nothing sent early
    release();
    await h.frame((f) => f.includes("did: second queued (edited)"));
    expect(h.prompts.map((p) => p.text)).toEqual(["long job", "first queued", "second queued (edited)"]);
  } finally { await h.cleanup(); }
}, 30000);

test("38. while the main agent's question is open, a lone digit is the answer, not a note key", async () => {
  const h = await harness({ claude: async (text, ctx) => ctx.say(text === "2" ? "Going with option 2." : "Should I use option 1 or 2?") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("plan the fix");
    await h.frame((f) => f.includes("option 1 or 2?"));
    (h.app as any).addNote("codex", "Codex", "Heads up · The fix skips the Windows path.\n\n**Windows**\n- x");
    await h.frame((f) => f.includes("asked you something, so 1 · 2 · 0 are your answer for now"));
    await h.setup.mockInput.typeText("2");
    await Bun.sleep(1200);
    await h.frame((f) => /^❯ 2\s*$/m.test(f)); // still in the prompt: not taken by the note
    expect((h.app as any).notePanel.count).toBe(1);
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Going with option 2."));
    expect(h.prompts.map((p) => p.text)).toEqual(["plan the fix", "2"]);
    // You replied: the note keys are back.
    await h.frame((f) => f.includes("2 discuss with Claude Code · 0 dismiss (type the number and pause)"));
  } finally { await h.cleanup(); }
}, 30000);

test("39. a message typed during /compact is queued and delivered when the summary ends, even if it fails", async () => {
  let release!: () => void;
  let fail = false;
  const h = await harness({
    claude: async (text, ctx) => {
      if (text.startsWith("[codemax] Write a compact project summary")) {
        await new Promise<void>((r) => (release = r));
        if (fail) throw new Error("summary blew up");
        return ctx.say("Goal: ship v0.1.5. Done: questions dialog, note panel. Next: release notes and tag.");
      }
      await ctx.say(`did: ${text}`);
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("/compact");
    await h.frame((f) => f.includes("asking Claude Code for a handoff summary"));
    await h.send("then run the tests");
    await h.frame((f) => f.includes("❯ then run the tests") && f.includes("↑ to edit"));
    release();
    await h.frame((f) => f.includes("summary saved") && f.includes("did: then run the tests"));
    expect((h.app as any).queue).toEqual([]);
    // A summary turn that throws still frees the agent and sends what was queued.
    fail = true;
    await h.send("/compact");
    await h.frame((f) => f.includes("asking Claude Code for a handoff summary") && !!release);
    await Bun.sleep(50);
    await h.send("and lint");
    await h.frame((f) => f.includes("❯ and lint"));
    release();
    await h.frame((f) => f.includes("did: and lint"));
  } finally { await h.cleanup(); }
}, 30000);

test("44. while an agent asks: the prompt still works, a digit answers only alone; Shift+Tab reaches auto; built-in commands run mid-turn", async () => {
  const configCalls: any[] = [];
  const outcomes: string[] = [];
  const modeOpt = { id: "mode", category: "mode", type: "select", currentValue: "default", options: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"].map((v) => ({ value: v, name: v })) };
  const h = await harness({
    claude: async (text, ctx) => {
      if (text !== "edit a.ts") return ctx.say(`got: ${text}`);
      const r: any = await ctx.conn.requestPermission({ sessionId: ctx.sessionId, toolCall: { toolCallId: "p1", title: "Edit src/a.ts", kind: "edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } as any);
      outcomes.push(r.outcome.optionId);
      await ctx.say("Edited.");
    },
  }, {}, undefined, { claude: { session: { configOptions: [modeOpt] }, configCalls } });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("edit a.ts");
    await h.frame((f) => f.includes("Do you want to proceed?"));
    // "2 more tests please" is a message, not option 2 ("don't ask again").
    await h.setup.mockInput.typeText("2 more tests please");
    await Bun.sleep(900);
    expect(outcomes).toEqual([]);
    let f = await h.frame((f) => f.includes("❯ 2 more tests please") && f.includes("Do you want to proceed?"));
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("2 more tests please") && f.includes("1 queued"));
    // A built-in command runs at once, dialog or not.
    await h.setup.mockInput.typeText("/status");
    await Bun.sleep(50);
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Do you want to proceed?") && /thread|session/i.test(f));
    expect((h.app as any).queue).toEqual(["2 more tests please"]);
    // Shift+Tab cycles default → accept edits → plan → auto → default, never to bypass.
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      h.setup.mockInput.pressTab({ shift: true });
      await Bun.sleep(30);
      seen.push((h.app as any).active.mode);
    }
    expect(seen).toEqual(["acceptEdits", "plan", "auto", "default"]);
    // A lone digit answers.
    await h.setup.mockInput.typeText("1");
    await Bun.sleep(30);
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Edited."));
    expect(outcomes).toEqual(["allow"]);
    f = await h.frame((f) => f.includes("got: 2 more tests please"));
  } finally { await h.cleanup(); }
}, 30000);

test("45. a run of reads and searches is one line, like Claude Code; the spinner names the step", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = await harness({
    claude: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "r1", title: "Read src/a.ts", kind: "read", status: "completed" });
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "r2", title: "Read src/b.ts", kind: "read", status: "completed" });
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "g1", title: "grep -n auth src/", kind: "execute", status: "completed" });
      // OpenCode names a command "bash" first, then gives the command.
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "b1", title: "bash", kind: "execute", status: "pending" });
      await upd(ctx, { sessionUpdate: "tool_call_update", toolCallId: "b1", title: "sed -n '1,40p' src/c.ts", status: "in_progress" });
      await gate;
      await upd(ctx, { sessionUpdate: "tool_call_update", toolCallId: "b1", status: "completed" });
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "w1", title: "bun test", kind: "execute", status: "completed" });
      await ctx.say("All good.");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("look around");
    let f = await h.frame((f) => f.includes("Reading 3 files, searching for 1 pattern…"));
    expect(f).toContain("sed -n '1,40p' src/c.ts"); // the latest step, under the line and on the spinner
    expect(f).not.toContain("Read src/a.ts");
    release();
    f = await h.frame((f) => f.includes("All good."));
    expect(f).toContain("Read 3 files, searched for 1 pattern (ctrl+o to expand)");
    expect(f).toContain("bun test"); // a command that may change things keeps its own row
    h.setup.mockInput.pressKey("o", { ctrl: true });
    f = await h.frame((f) => f.includes("Read src/a.ts") && f.includes("grep -n auth src/"));
  } finally { await h.cleanup(); }
}, 30000);

test("46. agents without Claude Code's narration rule get it once: an ACP system prompt where offered, else ahead of a new session's first message; never Claude", async () => {
  const { NARRATE } = await import("../src/chat/app.ts");
  const h = await harness({
    claude: async (text, ctx) => ctx.say(`claude got: ${text.slice(0, 20)}`),
    opencode: async (text, ctx) => ctx.say(text.startsWith(NARRATE) ? "narrated" : `plain: ${text}`),
  }, { narrate: true });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("hello");
    await h.frame((f) => f.includes("claude got: hello"));
    expect(h.prompts.filter((p) => p.agent === "claude").every((p) => !p.text.includes(NARRATE))).toBe(true);
    await (h.app as any).switchTo("opencode", true);
    await h.frame((f) => f.includes("narrated")); // the handoff, its first message
    await h.send("second");
    await h.frame((f) => f.includes("plain: second")); // only once
  } finally { await h.cleanup(); }
}, 30000);

test("47. colour themes: /theme claude switches to Claude Code's colours at once and saves; dark/light keep the theme; every theme is in /config", async () => {
  const theme = await import("../src/chat/theme.ts");
  const { CONFIG_PATH } = await import("../src/config.ts");
  theme.applyTheme("dark", "codemax");
  const h = await harness({ claude: async (_t, ctx) => ctx.say("ok") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("/theme claude");
    await h.frame((f) => f.includes("colours: Claude Code, dark"));
    expect(theme.C.accent).toBe("#d77757");
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).colors).toBe("claude");
    await h.send("/theme light");
    await h.frame((f) => f.includes("colours: Claude Code, light"));
    expect(theme.C.selBg).toBe("#5769f7"); // Claude Code's light selection blue
    expect(theme.C.error).toBe("#ab2b3f");
    const row = (h.app as any).settings().find((r: any) => r.key === "colors");
    expect(row.choices.map((c: any) => c.value)).toEqual(["codemax", "claude", "ocean", "teal", "mono"]);
    await h.send("/theme pink-ish");
    await h.frame((f) => f.includes("/theme codemax, claude, ocean, teal, mono"));
  } finally {
    theme.applyTheme("dark", "codemax");
    await h.cleanup();
  }
}, 30000);

test("48. plan-limit warnings and agent notices show as in Claude Code: on the prompt's top border, once in the transcript", async () => {
  const resets = Date.now() + 3 * 3600_000;
  const h = await harness({
    claude: async (text, ctx) => {
      if (text === "near") await upd(ctx, { sessionUpdate: "usage_update", used: 1000, size: 200000, _meta: { "_claude/rateLimit": { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.91, resetsAt: Math.floor(resets / 1000) } } });
      if (text === "notice") await upd(ctx, { sessionUpdate: "notice", severity: "warning", title: "Retrying Claude, attempt 2 of 10." });
      await ctx.say(`ok ${text}`);
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("near");
    let f = await h.frame((f) => f.includes("ok near") && /─ You've used 91% of your weekly limit · resets \d+:\d\d [AP]M ─/.test(f));
    expect(f.match(/You've used 91% of your weekly limit/g)!.length).toBe(2); // border + one transcript line
    await h.send("near");
    f = await h.frame((f) => f.match(/ok near/g)?.length === 2);
    expect(f.match(/You've used 91% of your weekly limit/g)!.length).toBe(2); // not announced again
    await h.send("notice");
    f = await h.frame((f) => f.includes("Claude Code: Retrying Claude, attempt 2 of 10."));
    expect(f).toContain("weekly limit"); // the limit keeps the border; the notice is in the transcript
  } finally { await h.cleanup(); }
}, 30000);

test("49. after /update, what changed since the old version shows above the prompt for 5 seconds, never in the chat", async () => {
  const { whatsNew } = await import("../src/core/whatsnew.ts");
  expect(whatsNew("0.1.13", "0.1.11").map((n) => n.version)).toEqual(["0.1.13", "0.1.12"]);
  expect(whatsNew("0.1.13").map((n) => n.version)).toEqual(["0.1.13"]); // an older codemax ran /update: no "from"
  expect(whatsNew("0.1.13", "0.1.13")).toEqual([]);
  const h = await harness({ claude: async (_t, ctx) => ctx.say("ok") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    (h.app as any).showWhatsNew("0.1.13", "0.1.12");
    const f = await h.frame((f) => f.includes("What's new in codemax v0.1.13") && f.includes("Colour themes"));
    await Bun.sleep(5200);
    expect(h.setup.captureCharFrame()).toContain("What's new in codemax"); // still there: the agent was ready before, so it waits for the next ready (or 15 s)
    (h.app as any).whatsNewArm?.(); // the agent is ready
    expect(f).not.toContain("33 bug fixes"); // only what came after the old version
    expect((h.app as any).transcript.box.getChildren().some((c: any) => JSON.stringify(c.content ?? "").includes("Colour themes"))).toBe(false);
    await Bun.sleep(5200);
    await h.frame((f) => !f.includes("What's new in codemax"));
  } finally { await h.cleanup(); }
}, 30000);

test("50. with the debug log on, errors and unknown agent messages are recorded, and nothing of the conversation is", async () => {
  const d = await import("../src/core/debuglog.ts");
  const { existsSync, rmSync } = await import("node:fs");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true); // on by default: cli.ts turns it on before the app starts
  const h = await harness({
    claude: async (text, ctx) => {
      await upd(ctx, { sessionUpdate: "session_info_update", title: "SECRET-PAYLOAD" }); // valid ACP, not shown by codemax
      await upd(ctx, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read secret-plan.md", kind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "TOOL-OUTPUT-XYZ" } }] });
      await ctx.say(`REPLY-ABC to ${text}`);
      throw new Error("adapter exploded");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("/debug on");
    await h.frame((f) => f.includes("debug log on"));
    await h.send("MY-PRIVATE-MESSAGE-123");
    await h.frame((f) => f.includes("adapter exploded"));
    await h.send("/debug export");
    await h.frame((f) => f.includes("debug log saved to"));
    const { readdirSync } = await import("node:fs");
    const { CODEMAX_HOME } = await import("../src/core/paths.ts");
    const dir = join(CODEMAX_HOME, "exports");
    const path = join(dir, readdirSync(dir).filter((n) => n.startsWith("codemax-debug-")).sort().at(-1)!);
    const text = readFileSync(path, "utf8");
    expect(text).toContain('"kind":"acp-unknown-update"');
    expect(text).toContain('"type":"session_info_update"');
    expect(text).toContain("adapter exploded");
    expect(text).toContain("codemax:");
    // The detail around it: the start, the turn's numbers, the command used, the agent's features.
    for (const kind of ["app-start", "acp-init", "agent-start", "turn-start", "turn-end", "command"]) expect(text).toContain(`"kind":"${kind}"`);
    const turnEnd = text.split("\n").filter((l) => l.includes('"kind":"turn-end"')).map((l) => JSON.parse(l)).at(-1);
    expect(turnEnd).toMatchObject({ agent: "claude", stop: "error", tools: { read: 1 } });
    expect(typeof turnEnd.ms).toBe("number");
    expect(text).toContain('"name":"/debug"');
    for (const secret of ["MY-PRIVATE-MESSAGE-123", "REPLY-ABC", "TOOL-OUTPUT-XYZ", "SECRET-PAYLOAD", "secret-plan.md"]) expect(text).not.toContain(secret);
    await h.send("/debug off");
    await h.frame((f) => f.includes("debug log off"));
  } finally {
    d.setDebugLog(false);
    await h.cleanup();
  }
}, 30000);

test("51. the debug log is on by default and says so once at start, with what it can contain", async () => {
  const d = await import("../src/core/debuglog.ts");
  const { CONFIG_PATH } = await import("../src/config.ts");
  d.setDebugLog(true); // what cli.ts does unless debugLog is false
  try {
    let h = await harness({ claude: async (_t, ctx) => ctx.say("ok") });
    try {
      void h.app.start("claude", true);
      const f = await h.frame((f) => f.includes("new session"));
      expect(f).toContain("debug log on");
      expect(f).toContain("/debug off");
    } finally { await h.cleanup(); }
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).debugNotified).toBe(true);
    // The next start reads config.json (the harness passes what loadConfig would).
    h = await harness({ claude: async (_t, ctx) => ctx.say("ok") }, { debugNotified: JSON.parse(readFileSync(CONFIG_PATH, "utf8")).debugNotified });
    try {
      void h.app.start("claude", true);
      expect(await h.frame((f) => f.includes("new session"))).not.toContain("debug log on"); // only once
    } finally { await h.cleanup(); }
  } finally {
    d.setDebugLog(false);
  }
}, 30000);

test("52. the debug log catches a lost key and a slow screen without recording what was typed", async () => {
  const d = await import("../src/core/debuglog.ts");
  const { existsSync, rmSync } = await import("node:fs");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  const h = await harness({ claude: async (_t, ctx) => ctx.say("ok") });
  const events = () => (existsSync(d.debugLogPath()) ? readFileSync(d.debugLogPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    const app: any = h.app;
    // Normal typing: every key lands, none is reported.
    await h.setup.mockInput.typeText("hello world");
    await h.frame((f) => f.includes("hello world"));
    for (let i = 0; i < 30; i++) await h.setup.renderOnce();
    expect(events().filter((e) => e.kind === "ui-key-missed")).toEqual([]);
    // A key the prompt never gets (as if dropped on the way): reported by its kind only.
    const real = app.input.handleKeyPress.bind(app.input);
    app.input.handleKeyPress = (key: any) => (key.sequence === "Q" ? false : real(key));
    await h.setup.mockInput.typeText("Q");
    await Bun.sleep(20);
    app.input.handleKeyPress = real;
    const missed = events().filter((e) => e.kind === "ui-key-missed");
    expect(missed.length).toBe(1);
    expect(missed[0]).toMatchObject({ keyKind: "letter", promptChars: 11 });
    // A key that waits long for the screen.
    const k = app.perf.keyIn({ sequence: "x", name: "x" });
    k.at -= 120;
    app.perf.keyLanded(k, true, 0, 1);
    await h.setup.mockInput.typeText("!");
    for (let i = 0; i < 5; i++) await h.setup.renderOnce();
    expect(events().some((e) => e.kind === "ui-slow-key-to-screen" && e.keyKind === "letter" && e.ms >= 120)).toBe(true);
    // Selecting text in the transcript: a fast selection is not reported, a slow one is.
    await h.send("say something");
    await h.frame((f) => f.includes("⏺ ok"));
    const rows = h.setup.captureCharFrame().split("\n");
    const row = rows.findIndex((l) => l.includes("⏺ ok"));
    await h.setup.mockMouse.drag(3, row, 6, row); // over the reply's text
    for (let i = 0; i < 5; i++) await h.setup.renderOnce();
    expect(events().filter((e) => e.kind === "ui-slow-selection")).toEqual([]);
    expect(app.perf.selectionMoves).toBeGreaterThan(0); // the drag was seen, move by move
    (app.perf as any).pendingSelection = performance.now() - 200;
    await h.setup.renderOnce();
    await h.setup.mockInput.typeText("z");
    for (let i = 0; i < 5; i++) await h.setup.renderOnce();
    expect(events().some((e) => e.kind === "ui-slow-selection" && e.ms >= 200)).toBe(true);
    const all = readFileSync(d.debugLogPath(), "utf8");
    for (const typed of ["hello", "world", "say something", '"Q"', '"x"', '"z"']) expect(all).not.toContain(typed);
  } finally {
    d.setDebugLog(false);
    await h.cleanup();
  }
}, 30000);

test("53. after /update with a slow-starting agent, the what's-new box stays until 5 s after the agent is ready", async () => {
  const h = await harness({ claude: async (_t, ctx) => ctx.say("ok") });
  const app: any = h.app;
  const make = app.engineFactory;
  app.engineFactory = (a: string) => {
    const e = make(a);
    const start = e.start.bind(e);
    e.start = async (o: any) => (await Bun.sleep(3000), start(o)); // an agent that takes 3 s, like Claude on a busy Mac
    return e;
  };
  process.env.CODEMAX_UPDATED_TO = "0.1.14";
  process.env.CODEMAX_UPDATED_FROM = "0.1.13";
  try {
    const t0 = Date.now();
    void app.start("claude", true);
    await h.frame((f) => f.includes("What's new in codemax"));
    await h.frame((f) => f.includes("new session"), 10000); // the agent is ready (~3 s)
    await Bun.sleep(Math.max(0, 5000 - (Date.now() - t0)));
    for (let i = 0; i < 3; i++) await h.setup.renderOnce();
    expect(h.setup.captureCharFrame()).toContain("What's new in codemax"); // 5 s after start, still shown
    await h.frame((f) => !f.includes("What's new in codemax"), 10000); // and gone 5 s after ready
    expect(Date.now() - t0).toBeGreaterThan(7500);
  } finally {
    delete process.env.CODEMAX_UPDATED_TO;
    delete process.env.CODEMAX_UPDATED_FROM;
    await h.cleanup();
  }
}, 30000);

test("54. the start card says hello (time of day, first name), one line of news and who makes codemax; notices sit under it", async () => {
  const { greeting } = await import("../src/chat/greeting.ts");
  expect(greeting(new Date("2026-10-20T08:00:00"), "Saidev")).toStartWith("☀ Good morning, Saidev · ");
  expect(greeting(new Date("2026-10-20T20:00:00"))).toStartWith("☾ Good evening · ");
  expect(greeting(new Date("2026-10-20T02:00:00"), "A")).toStartWith("☾ Up late, A · ");
  const h = await harness({ claude: async (_t, ctx) => ctx.say("ok") }, { awake: "off" });
  try {
    void h.app.start("claude", true);
    const f = await h.frame((f) => f.includes("new session"));
    expect(f).toContain("made by Saidev Dhal · saidev.codes");
    expect(f).toMatch(/[☀☾] (Good (morning|afternoon|evening)|Up late)/);
    expect(f).toMatch(/✦ new in v\d+\.\d+\.\d+: /);
    const card = f.slice(f.indexOf("╭"), f.indexOf("╰"));
    expect(card).not.toContain("debug log on"); // notices are below the card now
  } finally { await h.cleanup(); }
}, 30000);

test("55. queued messages all reach the agent in order, one at a time, even with a side-agent note arriving between them", async () => {
  const got: string[] = [];
  let inflight = 0, maxInflight = 0;
  const h = await harness({
    claude: async (text, ctx) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      got.push(text.startsWith("A side agent (") ? "note" : text);
      await Bun.sleep(300);
      await ctx.say(`answered`);
      inflight--;
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    const app: any = h.app;
    await h.send("m1");
    await Bun.sleep(50);
    for (const m of ["m2", "m3"]) await h.send(m);
    // The moment a queued message is being prepared (the agent looks idle), a note is forwarded.
    const t0 = Date.now();
    while (!app.sending && Date.now() - t0 < 3000) await Bun.sleep(1);
    app.addNote("codex", "Codex", "Heads up · Check the null case.\n\n**Null case**\n- **Consider a test.**");
    app.forwardNote();
    // And a message typed in the gap between two turns.
    while (!(app.draining && !app.active.turn) && Date.now() - t0 < 3000) await Bun.sleep(1);
    await h.send("m4");
    const t1 = Date.now();
    while (got.length < 5 && Date.now() - t1 < 8000) await Bun.sleep(50);
    await Bun.sleep(500);
    expect(maxInflight).toBe(1); // never two prompts at once
    expect(got.filter((g) => g !== "note")).toEqual(["m1", "m2", "m3", "m4"]);
    expect(got).toContain("note");
    expect(app.queue).toEqual([]);
  } finally { await h.cleanup(); }
}, 30000);

test("56. Ctrl+C twice quits at once: the screen goes first, slow agents get at most 1.2 s", async () => {
  const h = await harness({ claude: async (_t, ctx) => ctx.say("ok") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    const app: any = h.app;
    app.active.engine.close = () => Bun.sleep(3000); // an agent slow to close (Claude's session, Cursor…)
    const destroy = h.setup.renderer.destroy.bind(h.setup.renderer);
    let screenGoneAt = 0;
    h.setup.renderer.destroy = () => ((screenGoneAt ||= Date.now()), destroy());
    const t0 = Date.now();
    h.setup.mockInput.pressKey("c", { ctrl: true });
    h.setup.mockInput.pressKey("c", { ctrl: true });
    await app.done;
    expect(screenGoneAt - t0).toBeLessThan(200);
    expect(Date.now() - t0).toBeLessThan(1700);
  } finally {
    try { h.setup.renderer.destroy(); } catch { /* gone */ }
  }
}, 30000);

test("57. shortcuts and quitting are in the debug log: which key, what it did, never typed text", async () => {
  const d = await import("../src/core/debuglog.ts");
  const { existsSync, rmSync } = await import("node:fs");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  const h = await harness({ claude: async (_t, ctx) => ctx.say("ok") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    h.setup.mockInput.pressKey("o", { ctrl: true });
    h.setup.mockInput.pressTab({ shift: true });
    await h.setup.mockInput.typeText("?");
    await Bun.sleep(50);
    await h.setup.mockInput.typeText("secret words");
    h.setup.mockInput.pressKey("c", { ctrl: true }); // clears the prompt
    h.setup.mockInput.pressKey("c", { ctrl: true }); // "again to quit": quits
    await (h.app as any).done;
    const events = readFileSync(d.debugLogPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const keys = events.filter((e) => e.kind === "ui-hotkey" || e.kind === "hotkey").map((e) => e.key);
    expect(keys).toContain("ctrl+o");
    expect(keys).toContain("tab");
    expect(keys).toContain("?");
    expect(events.filter((e) => e.kind === "ctrl-c").map((e) => e.action)).toEqual(["clear-prompt", "quit"]);
    expect(events.some((e) => e.kind === "quit")).toBe(true);
    expect(events.some((e) => e.kind === "quit-closed")).toBe(true);
    expect(readFileSync(d.debugLogPath(), "utf8")).not.toContain("secret");
  } finally {
    d.setDebugLog(false);
    try { h.setup.renderer.destroy(); } catch { /* gone */ }
  }
}, 30000);

test("58. in the / palette, Tab writes the highlighted command into the prompt; no key typed around the palette is lost", async () => {
  const d = await import("../src/core/debuglog.ts");
  const { existsSync, rmSync } = await import("node:fs");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  const h = await harness({ claude: async (_t, ctx) => ctx.say("ok") });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    const app: any = h.app;
    const step = async (keys: string) => { await h.setup.mockInput.typeText(keys); await Bun.sleep(30); };
    await step("/");
    await h.frame((f) => f.includes("/config"));
    h.setup.mockInput.pressBackspace();
    await Bun.sleep(30);
    await step("/");
    await step("con");
    h.setup.mockInput.pressTab();
    await Bun.sleep(30);
    expect(app.input.plainText).toBe("/config ");
    expect(app.palette).toBeNull(); // completed: the menu closes, Enter runs it
    for (let i = 0; i < 8; i++) h.setup.mockInput.pressBackspace();
    await Bun.sleep(30);
    await step("/sta");
    h.setup.mockInput.pressTab();
    await Bun.sleep(30);
    expect(app.input.plainText).toBe("/status ");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => /thread|session/i.test(f) && !f.includes("/status "));
    const events = readFileSync(d.debugLogPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.filter((e) => e.kind === "ui-key-missed")).toEqual([]);
    expect(events.filter((e) => e.kind === "palette-tab").length).toBe(2);
  } finally {
    d.setDebugLog(false);
    await h.cleanup();
  }
}, 30000);

test("59. todos like Claude Code: the spinner names the task in progress; Ctrl+T folds the pinned list", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = await harness({
    claude: async (_t, ctx) => {
      await upd(ctx, { sessionUpdate: "plan", entries: [{ content: "Find the bug", status: "completed", priority: "high" }, { content: "Running the auth tests", status: "in_progress", priority: "high" }, { content: "Ship it", status: "pending", priority: "low" }] });
      await gate;
      await ctx.say("done");
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("go");
    let f = await h.frame((f) => /Running the auth tests… \(\d+s/.test(f));
    expect(f).toContain("3 tasks (1 done, 1 in progress, 1 open)");
    h.setup.mockInput.pressKey("t", { ctrl: true });
    f = await h.frame((f) => f.includes("· ctrl+t to show"));
    expect(f).not.toContain("◻ Ship it");
    h.setup.mockInput.pressKey("t", { ctrl: true });
    await h.frame((f) => f.includes("◻ Ship it"));
    release();
    await h.frame((f) => f.includes("done"));
  } finally { await h.cleanup(); }
}, 30000);

test("60. Ctrl+Enter sends now: interrupts the running turn and the message goes first; on an empty prompt the first queued one goes", async () => {
  const got: string[] = [];
  const h = await harness({
    claude: async (text, ctx) => {
      got.push(text);
      if (text === "slow") {
        for (let i = 0; i < 40 && !ctx.cancelled(); i++) await Bun.sleep(100);
        return ctx.say("slow done");
      }
      await Bun.sleep(150);
      await ctx.say(`answered ${text}`);
    },
  });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("slow");
    await Bun.sleep(50);
    await h.send("q1");
    await h.send("q2");
    await h.setup.mockInput.typeText("urgent");
    (h.setup.renderer as any).stdin.emit("data", Buffer.from("\x1b[13;5u")); // Ctrl+Enter as terminals send it
    await h.frame((f) => f.includes("answered urgent"));
    await h.frame((f) => f.includes("answered q2"), 10000);
    expect(got).toEqual(["slow", "urgent", "q1", "q2"]);
    // Empty prompt, messages queued, agent idle: Ctrl+Enter sends the first queued one.
    const app: any = h.app;
    app.queue.push("later1", "later2");
    app.renderQueue();
    (h.setup.renderer as any).stdin.emit("data", Buffer.from("\x1b[13;5u")); // Ctrl+Enter as terminals send it
    await h.frame((f) => f.includes("answered later2"), 10000);
    expect(got.slice(-2)).toEqual(["later1", "later2"]);
  } finally { await h.cleanup(); }
}, 30000);

test("61. at start, one line says what the other agents' setups gave every agent; the agent's own servers are not sent back to it", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "codemax-share-home-"));
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { gitk: { command: "npx", args: ["gitkraken-mcp"] } } }));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { freecad: { type: "stdio", command: "uvx", args: ["freecad-mcp"] } } }));
  mkdirSync(join(home, ".codex", "skills", "tdd"), { recursive: true });
  writeFileSync(join(home, ".codex", "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Red, green, refactor\n---\n");
  const prev = process.env.CODEMAX_SHARE_HOME;
  process.env.CODEMAX_SHARE_HOME = home;
  const sessions: any[] = [];
  const h = await harness({ claude: async (text, ctx) => ctx.say(`got: ${text.slice(0, 60)}`) }, {}, undefined, { claude: { session: {}, configCalls: sessions } });
  try {
    void h.app.start("claude", true);
    const f = await h.frame((f) => f.includes("new session"));
    expect(f).toContain("every agent gets the others' setup: 2 MCP servers (claude 1, cursor 1) and 1 skill");
    await h.send("hi");
    await h.frame((f) => f.includes("got: "));
    // Claude (no systemPrompt slot in the fake) gets Codex's skill in its first message, not its own freecad server.
    const first = h.prompts.find((p) => p.agent === "claude")!.text;
    expect(first).toContain("- tdd: Red, green, refactor → ");
    expect(first).toContain("hi");
  } finally {
    process.env.CODEMAX_SHARE_HOME = prev;
    await h.cleanup();
  }
}, 30000);

test("62. /mcp lists the agent's servers with their status and the shared ones; Enter picks an action; disabling a shared server reloads the session without it", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "codemax-mcp-home-"));
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { gitk: { command: "npx", args: ["gitkraken-mcp"] } } }));
  const prev = process.env.CODEMAX_SHARE_HOME;
  process.env.CODEMAX_SHARE_HOME = home;
  const calls: any[] = [];
  const h = await harness({
    claude: async (text, ctx) => {
      if (text === "/mcp") return ctx.say("**MCP servers:** 2 (1 connected, 1 failed)\n\n**Failed**\n- `freecad`: spawn uvx ENOENT; 0 tools\n\n**Connected**\n- `gitk`: 3 tools");
      if (text.startsWith("/mcp reconnect")) return ctx.say("Reconnected `freecad`.");
      await ctx.say(`got: ${text}`);
    },
  }, {}, undefined, { claude: { session: {}, configCalls: calls } });
  try {
    void h.app.start("claude", true);
    await h.frame((f) => f.includes("new session"));
    await h.send("/mcp");
    let f = await h.frame((f) => f.includes("MCP servers · Claude Code"));
    expect(f).toContain("freecad");
    expect(f).toContain("✘ failed: spawn uvx ENOENT");
    expect(f).toContain("✔ connected · 3 tools");
    expect(f).toContain("shared from cursor");
    expect(f).not.toContain("**MCP servers:**"); // the adapter's answer stays out of the chat
    // ↓ to gitk (failed rows sort first), Enter → actions.
    await h.setup.mockInput.pressArrow("down");
    await Bun.sleep(30);
    h.setup.mockInput.pressEnter();
    f = await h.frame((f) => f.includes("gitk · ✔ connected · 3 tools · shared from cursor"));
    expect(f).toContain("Disable");
    expect(f).toContain("Reconnect");
    await h.setup.mockInput.typeText("disable");
    await Bun.sleep(60);
    h.setup.mockInput.pressEnter();
    f = await h.frame((f) => f.includes("MCP · gitk is off for Claude Code this run"));
    expect(calls.some((c) => c.method === "session/load" && !c.mcpServers.includes("gitk"))).toBe(true); // reloaded without it
    f = await h.frame((f) => f.includes("MCP servers · Claude Code")); // the list is back
    expect(f).toMatch(/gitk\s+disabled/);
    h.setup.mockInput.pressEscape();
    await h.frame((f) => !f.includes("MCP servers · Claude Code"));
    // The direct form on the agent's own server goes through the adapter's /mcp reconnect.
    await h.send("/mcp reconnect freecad");
    await h.frame((f) => f.includes("MCP · Reconnected freecad."));
    expect(h.prompts.map((p) => p.text)).toContain("/mcp reconnect freecad");
    expect(h.setup.captureCharFrame()).not.toContain("Reconnected `freecad`");
  } finally {
    process.env.CODEMAX_SHARE_HOME = prev;
    await h.cleanup();
  }
}, 30000);

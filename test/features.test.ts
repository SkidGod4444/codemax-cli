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

type Ctx = { conn: AgentSideConnection; sessionId: string; say: (t: string) => Promise<void> };
type Handler = (text: string, ctx: Ctx) => Promise<void | Record<string, unknown>>;
/** Extra fields a fake agent returns from newSession (e.g. OpenCode's configOptions), and config-option calls it received. */
type FakeOpts = { session?: Record<string, unknown>; configCalls?: unknown[] };

function fakeStream(handler: Handler, fo: FakeOpts = {}) {
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  let n = 0;
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake", version: "1" }, agentCapabilities: { loadSession: true }, authMethods: [] } as any; },
    async newSession() { return { sessionId: `s-${++n}-${Math.random().toString(36).slice(2, 6)}`, ...(fo.session ?? {}) } as any; },
    async setSessionConfigOption(p: any) { fo.configCalls?.push(p); return {} as any; },
    async extMethod(method: string, params: any) { fo.configCalls?.push({ method, ...params }); return {}; },
    async loadSession() { return {} as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId, prompt }) {
      const text = (prompt[0] as any).text as string;
      const say = (t: string) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } as any });
      const extra = await handler(text, { conn, sessionId, say });
      return { stopReason: "end_turn", ...(extra ?? {}) } as any;
    },
    async cancel() {},
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
  const app = new ChatApp(setup.renderer, { ...structuredClone(DEFAULT_CONFIG), order: ids, summarizeOnSwitch: false, priceUpdates: false, ...cfg }, ledger, repo);
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

test("6. session picker: lists recent sessions with their last message and resumes the chosen one", async () => {
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
    let f = await h.frame((f) => f.includes("Resume a session"));
    expect(f).toContain('"fix the flaky test"');
    expect(f).toContain('"add a parser"');
    expect(f.indexOf("Resume Codex")).toBeLessThan(f.indexOf("Resume Claude Code")); // most recent first
    expect(f).toContain("New session with Claude Code");
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
    expect(f).toContain("The user wants tests first.");
    expect(f).toContain("☒ write tests");
    expect(f).toContain("◼ fix theme");
    expect(f).toContain("☐ ship");
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
    expect(f).toContain("big-pickle");
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
    expect(await h.frame((f) => f.includes("grok-4.7 high"))).toBeTruthy();
    await h.send("/model");
    await h.frame((f) => f.includes("offers one model on your plan: Grok 4.7") && f.includes("/effort"));
    await h.send("/effort low");
    await h.frame((f) => f.includes("reasoning effort: low") && f.includes("grok-4.7 low"));
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
    await h.frame((f) => f.includes("model: opus"));
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

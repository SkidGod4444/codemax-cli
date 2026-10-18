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
type Handler = (text: string, ctx: Ctx) => Promise<void>;

function fakeStream(handler: Handler) {
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  let n = 0;
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake", version: "1" }, agentCapabilities: { loadSession: true }, authMethods: [] } as any; },
    async newSession() { return { sessionId: `s-${++n}-${Math.random().toString(36).slice(2, 6)}` } as any; },
    async loadSession() { return {} as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId, prompt }) {
      const text = (prompt[0] as any).text as string;
      const say = (t: string) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } as any });
      await handler(text, { conn, sessionId, say });
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }), ndJsonStream(a2c.writable, c2a.readable));
  return ndJsonStream(c2a.writable, a2c.readable);
}

async function harness(agents: Partial<Record<"claude" | "codex" | "opencode", Handler>>, cfg: any = {}, prep?: (repo: string, ledger: any) => void) {
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
    const e = new AcpEngine({ agent, name: agent, cmd: [], stream: fakeStream(async (text, ctx) => { prompts.push({ agent, text }); await agents[agent as keyof typeof agents]!(text, ctx); }) });
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

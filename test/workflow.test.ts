import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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

type Ctx = { conn: AgentSideConnection; sessionId: string; say: (t: string) => Promise<void> };
type Handler = (text: string, ctx: Ctx) => Promise<void>;
/** A fake that forks like the Claude adapter: `session/fork` at `_meta.jetbrains.air.fork.messageId`. */
type ForkLog = { forks: { from: string; messageId?: string; to: string }[]; created: string[]; promptedIn: string[]; fail?: boolean };

function fakeStream(handler: Handler, fork?: ForkLog) {
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  let n = 0, msg = 0;
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake", version: "1" }, agentCapabilities: { loadSession: true, ...(fork ? { sessionCapabilities: { fork: {} } } : {}) }, authMethods: [] } as any; },
    async newSession() { const sessionId = `s-${++n}-${Math.random().toString(36).slice(2, 6)}`; fork?.created.push(sessionId); return { sessionId } as any; },
    async unstable_forkSession(p: any) { if (fork?.fail) throw new Error("fork unavailable"); const to = `f-${++n}`; fork?.forks.push({ from: p.sessionId, messageId: p._meta?.jetbrains?.air?.fork?.messageId, to }); return { sessionId: to } as any; },
    async loadSession() { return {} as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId, prompt }) {
      const text = (prompt[0] as any).text as string;
      fork?.promptedIn.push(sessionId);
      const messageId = `m-${++msg}`;
      const say = (t: string) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: t } } as any });
      await handler(text, { conn, sessionId, say });
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

async function harness(handler: Handler, o: { cfg?: any; repo?: string; height?: number; fork?: ForkLog; resume?: boolean } = {}) {
  const setup = await createTestRenderer({ width: 110, height: o.height ?? 30 });
  const repo = o.repo ?? newRepo();
  const ledger = new Ledger(repo);
  const app = new ChatApp(setup.renderer, { ...structuredClone(DEFAULT_CONFIG), order: ["claude"], summarizeOnSwitch: false, priceUpdates: false, ...(o.cfg ?? {}) }, ledger, repo);
  const prompts: string[] = [];
  app.checkBlockers = () => [];
  app.engineFactory = (agent) => new AcpEngine({ agent, name: agent, cmd: [], forkAtMessage: !!o.fork, stream: fakeStream(async (text, ctx) => { prompts.push(text); return handler(text, ctx); }, o.fork) });
  (app as any).refreshDetect = async () => void (app as any).detect.set("claude", { installed: true, version: "t", engine: true });
  const frame = async (pred: (f: string) => boolean, ms = 8000) => {
    const t0 = Date.now(); let f = "";
    while (Date.now() - t0 < ms) { await setup.renderOnce(); f = setup.captureCharFrame(); if (pred(f)) return f; await Bun.sleep(30); }
    throw new Error(`timeout; last frame:\n${f}`);
  };
  const send = async (t: string) => { await setup.mockInput.typeText(t); setup.mockInput.pressEnter(); };
  const cleanup = async () => { await app.quit(); setup.renderer.destroy(); };
  void app.start("claude", !o.resume);
  await frame((f) => f.includes(o.resume ? "resumed" : "new session"));
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
    expect(f).toContain("-original");
    expect(f).toContain("+changed");
    expect(f).not.toContain("old_string:"); // the diff replaces the raw input dump
    h.setup.mockInput.pressKey("1");
    await h.frame((f) => f.includes("ok"));
    await h.send("long");
    f = await h.frame((f) => f.includes("Do you want to proceed?"));
    expect(f).toContain("+line 0");
    expect(f).toContain("more lines · ctrl+o to see more");
    expect(f).not.toContain("+line 20");
    h.setup.mockInput.pressKey("o", { ctrl: true });
    f = await h.frame((f) => f.includes("+line 13") && f.includes("PgUp/PgDn"));
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
  const cmd = "test -f ok.txt || { echo CHECK-FAILED-MARK; exit 3; }";
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
  }, { repo, cfg: { verify: { [repo]: "echo NOPE-MARK; exit 1" }, verifyOnFail: "show" } });
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

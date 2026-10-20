import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixes from the security and leak audit: what agents may touch, what stays private,
// what is stopped, and what reaches the terminal.
process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-sec-home-"));
const { insideDir, privateHome, CODEMAX_HOME } = await import("../src/core/paths.ts");
const { mentionedFiles, attachFiles } = await import("../src/core/files.ts");
const { safeText, safeDeep } = await import("../src/core/terminal.ts");
const { displayCap } = await import("../src/chat/transcript.ts");
const { runVerify } = await import("../src/core/verify.ts");
const { antigravityInstallPlan, platformKey } = await import("../src/engines/antigravity.ts");
const unix = process.platform !== "win32";

test("inside the project: relative and absolute paths, new files, '..' and symlinks that lead out", () => {
  const root = mkdtempSync(join(tmpdir(), "codemax-sec-root-"));
  mkdirSync(join(root, "src"));
  expect(insideDir(root, "src/a.ts")).toBe(true);
  expect(insideDir(root, join(root, "new/dir/file.ts"))).toBe(true); // does not exist yet
  expect(insideDir(root, root)).toBe(true);
  expect(insideDir(root, "../outside.txt")).toBe(false);
  expect(insideDir(root, "/etc/passwd")).toBe(false);
  expect(insideDir(root, `${root}-sibling/x`)).toBe(false); // a prefix is not inside
  if (unix) {
    symlinkSync(tmpdir(), join(root, "escape"));
    expect(insideDir(root, "escape/x.txt")).toBe(false);
  }
});

test("@file attaches files from the project only", () => {
  const root = mkdtempSync(join(tmpdir(), "codemax-sec-at-"));
  writeFileSync(join(root, "ok.txt"), "fine");
  const outside = mkdtempSync(join(tmpdir(), "codemax-sec-secret-"));
  writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY");
  const rel = join("..", outside.split("/").pop()!, "id_rsa");
  expect(mentionedFiles(`look at @ok.txt and @${rel}`, root)).toEqual(["ok.txt"]);
  expect(attachFiles([rel], root)).not.toContain("PRIVATE KEY");
});

test.skipIf(!unix)("~/.codemax is made private, and new ledger files are yours only", async () => {
  chmodSync(CODEMAX_HOME, 0o755);
  privateHome();
  expect(statSync(CODEMAX_HOME).mode & 0o777).toBe(0o700);
  const { Ledger } = await import("../src/core/ledger.ts");
  const l = new Ledger("/p", mkdtempSync(join(tmpdir(), "codemax-sec-ledger-")));
  l.addTurns([{ ts: 1, agent: "claude", sessionId: "s", role: "user", text: "cat .env" }]);
  l.journal.append({ id: "1:user:1", ts: 1, agent: "claude", turn: "1", kind: "user", text: "cat .env" });
  expect(statSync(join(l.threadDir, "turns.jsonl")).mode & 0o777).toBe(0o600);
  expect(statSync(join(l.threadDir, "journal.jsonl")).mode & 0o777).toBe(0o600);
});

test("agent output reaches the screen without escape sequences: no clipboard writes, title changes or cursor moves", () => {
  const evil = "done\x1b]52;c;cm0gLXJmIH4=\x07 \x1b]0;pwned\x07\x1b[2J\x1b[31mred\x1b[0m\r\nnext\tcol\x00\x08";
  expect(safeText(evil)).toBe("done red\nnext\tcol");
  expect(safeText("plain text ✓ ünïcode")).toBe("plain text ✓ ünïcode");
  const e = safeDeep({ type: "tool_call", title: "\x1b]52;c;eA==\x07ls", input: { cmd: ["a\x1b[1mb"] }, n: 3 });
  expect(e).toEqual({ type: "tool_call", title: "ls", input: { cmd: ["ab"] }, n: 3 });
});

test("the transcript keeps the first and last 100 KB of a huge tool result", () => {
  const huge = "a".repeat(150_000) + "MIDDLE" + "z".repeat(150_000);
  const shown = displayCap(huge);
  expect(shown.length).toBeLessThan(201_000);
  expect(shown.startsWith("a".repeat(1000))).toBe(true);
  expect(shown.endsWith("z".repeat(1000))).toBe(true);
  expect(shown).toContain("characters not shown");
  expect(displayCap("small")).toBe("small");
});

test.skipIf(!unix)("stopping a command stops everything it started (its process group), and output is bounded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codemax-sec-tree-"));
  // A child that starts a grandchild and records its pid, then waits.
  const run = runVerify("sleep 60 & echo $! > grandchild.pid; wait", dir, 60_000, { ci: false });
  for (let i = 0; i < 50 && !existsSync(join(dir, "grandchild.pid")); i++) await Bun.sleep(20);
  const pid = Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
  run.stop();
  const r = await run.done;
  expect(r.stopped).toBe(true);
  await Bun.sleep(200);
  expect(() => process.kill(pid, 0)).toThrow(); // the grandchild is gone too
  // Endless output keeps only its end.
  const big = await runVerify("yes codemax | head -c 3000000", dir, 60_000, { ci: false }).done;
  expect(big.output.length).toBeLessThanOrEqual(200_000);
}, 20000);

test("Antigravity: a registry version that is not a plain version string is refused (it becomes a folder name)", async () => {
  const fake = (version: string) => (async (_url: string, init?: any) =>
    init?.method === "HEAD" ? new Response(null, { headers: { "content-length": "1" } }) : Response.json({ version, distribution: { binary: { [platformKey()]: { archive: "https://dl.google.com/agy/x.zip", cmd: "./agy" } } } })) as unknown as typeof fetch;
  await expect(antigravityInstallPlan(fake("1.4.1"))).resolves.toMatchObject({ version: "1.4.1" });
  await expect(antigravityInstallPlan(fake("../../../bin"))).rejects.toThrow(/refusing .* version name/);
  await expect(antigravityInstallPlan(fake("1.4/../../x"))).rejects.toThrow(/refusing/);
});

test("places that hold secrets are recognised (an agent reading one outside the project is asked about)", async () => {
  const { secretPlace } = await import("../src/core/paths.ts");
  // Native paths, so this holds on Windows too.
  const home = join(tmpdir(), "someone");
  const at = (...p: string[]) => join(home, ...p);
  expect(secretPlace(at(".ssh", "id_ed25519"), home)).toBe("SSH keys");
  expect(secretPlace(at(".aws", "credentials"), home)).toBe("AWS credentials");
  expect(secretPlace(at(".codex", "auth.json"), home)).toBe("Codex login");
  expect(secretPlace(at("Library", "Application Support", "Google", "Chrome", "Default", "Cookies"), home)).toBe("Chrome profiles");
  expect(secretPlace(join(tmpdir(), "srv", ".env.production"), home)).toBe("an environment file (.env)");
  expect(secretPlace(join(tmpdir(), "server.pem"), home)).toBe("a private key");
  // Ordinary reads outside the project go through.
  expect(secretPlace(at("code", "other-repo", "src", "index.ts"), home)).toBeNull();
  expect(secretPlace(join(tmpdir(), "lib", "node_modules", "typescript", "tsc.js"), home)).toBeNull();
  expect(secretPlace(at(".sshconfig-notes.md"), home)).toBeNull(); // a prefix is not the folder
});

test("drag and drop: what terminals paste for a dropped file is read as its path", async () => {
  const { splitDropped, droppedFiles, imageType } = await import("../src/chat/drop.ts");
  // Backslash escapes are macOS / Linux terminals' (on Windows a backslash is a path separator).
  if (unix) expect(splitDropped("/Users/me/My\\ Shot.png")).toEqual(["/Users/me/My Shot.png"]); // Terminal.app, iTerm2, Ghostty
  expect(splitDropped("'/Users/me/My Shot.png' '/tmp/b.pdf'")).toEqual(["/Users/me/My Shot.png", "/tmp/b.pdf"]); // VS Code, Warp
  expect(splitDropped('"/tmp/a b.jpg"')).toEqual(["/tmp/a b.jpg"]);
  // Windows Terminal quotes a dropped path; its backslashes are folders, not escapes.
  if (!unix) expect(splitDropped('"C:\\Users\\me\\My Shot.png" C:\\tmp\\b.txt')).toEqual(["C:\\Users\\me\\My Shot.png", "C:\\tmp\\b.txt"]);
  expect(splitDropped(unix ? "file:///Users/me/My%20Shot.png" : "file:///C:/Users/me/My%20Shot.png")).toEqual([unix ? "/Users/me/My Shot.png" : "C:/Users/me/My Shot.png"]);
  expect(splitDropped("/tmp/a.png\n/tmp/b.png")).toEqual(["/tmp/a.png", "/tmp/b.png"]);
  const exists = (p: string) => ["/tmp/a.png", "/tmp/b.png", "/Users/me/My Shot.png"].includes(p);
  if (unix) expect(droppedFiles("/Users/me/My\\ Shot.png ", exists)).toEqual(["/Users/me/My Shot.png"]);
  expect(droppedFiles(`"/Users/me/My Shot.png"`, exists)).toEqual(["/Users/me/My Shot.png"]);
  expect(droppedFiles("/tmp/a.png /tmp/b.png", exists)).toEqual(["/tmp/a.png", "/tmp/b.png"]);
  // Ordinary text, a missing file or a relative path stays a normal paste.
  expect(droppedFiles("look at /tmp/a.png please", exists)).toBeNull();
  expect(droppedFiles("/tmp/missing.png", exists)).toBeNull();
  expect(droppedFiles("src/a.ts", () => true)).toBeNull();
  expect(imageType("/x/Shot.PNG")).toBe("image/png");
  expect(imageType("/x/notes.pdf")).toBeUndefined();
});

test("bug fixes: /undo removes new files with non-ASCII names; snapshots in one millisecond stay apart", async () => {
  const { createCheckpoint, restoreCheckpoint, listCheckpoints } = await import("../src/core/checkpoint.ts");
  const repo = mkdtempSync(join(tmpdir(), "codemax-sec-utf-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "a\n");
  Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=t", "add", "-A"], { cwd: repo });
  Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  const one = await createCheckpoint(repo, "first");
  const two = await createCheckpoint(repo, "second"); // right after: possibly the same millisecond
  expect(two!.ts).toBeGreaterThan(one!.ts);
  expect((await listCheckpoints(repo)).length).toBe(2);
  writeFileSync(join(repo, "café.ts"), "x");
  writeFileSync(join(repo, "日本.md"), "y");
  const r = await restoreCheckpoint(repo, one!.sha);
  expect(r.removed.sort()).toEqual(["café.ts", "日本.md"].sort());
  expect(existsSync(join(repo, "café.ts"))).toBe(false);
});

test("bug fixes: every AI vendor's key is kept from agents, other variables are not touched", async () => {
  const { agentEnv } = await import("../src/engines/env.ts");
  const keep = { ...process.env };
  try {
    Object.assign(process.env, { OPENROUTER_API_KEY: "x", DEEPSEEK_API_KEY: "x", AZURE_OPENAI_API_KEY: "x", CODEX_API_KEY: "x", MISTRAL_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "x", STRIPE_API_KEY: "keep", MY_SETTING: "keep" });
    const env = agentEnv();
    for (const k of ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "AZURE_OPENAI_API_KEY", "CODEX_API_KEY", "MISTRAL_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) expect(env[k]).toBeUndefined();
    expect(env.STRIPE_API_KEY).toBe("keep");
    expect(env.MY_SETTING).toBe("keep");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  }
});

test("bug fixes: folders whose names differ only in punctuation keep separate histories; a torn journal line loses only itself", async () => {
  const { projectDir } = await import("../src/core/paths.ts");
  const base = mkdtempSync(join(tmpdir(), "codemax-sec-proj-"));
  const a = projectDir(join(base, "my-app")), b = projectDir(join(base, "my_app")), c = projectDir(join(base, "my.app"));
  expect(new Set([a, b, c]).size).toBe(3);
  expect(projectDir(join(base, "my_app"))).toBe(b); // stable
  const { Journal, TurnRecorder } = await import("../src/core/journal.ts");
  const dir = mkdtempSync(join(tmpdir(), "codemax-sec-journal-"));
  const j = new Journal(dir);
  j.append({ id: "1", ts: 1, agent: "claude", turn: "1", kind: "user", text: "first" });
  const { appendFileSync } = await import("node:fs");
  appendFileSync(join(dir, "journal.jsonl"), '{"id":"2","ts":2,"agent":"cla'); // a crash mid-write
  j.append({ id: "3", ts: 3, agent: "claude", turn: "3", kind: "user", text: "after the crash" });
  expect(j.steps().map((s: any) => s.text)).toEqual(["first", "after the crash"]);
  // A turn cut off by max_tokens is not finished.
  const rec = new TurnRecorder(j, "claude");
  rec.user("long task");
  rec.end("max_tokens");
  const end = j.steps().find((s: any) => s.kind === "end") as any;
  expect(end.outcome).toBe("error");
  expect(end.detail).toBe("stopped: max_tokens");
});

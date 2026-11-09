import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEMAX_HOME } from "../src/core/paths.ts";
import { which } from "../src/core/spawn.ts";
import { knownBinDirs, loginShellPath, mergePath } from "../src/core/syspath.ts";
import { CLAUDE_ADAPTER_PKG, claudeAdapter } from "../src/engines/index.ts";
import { antigravityServer, installAntigravityServer } from "../src/engines/antigravity.ts";
import { runSetup, setupEngine, setupState, startSetup } from "../src/engines/setup.ts";

// The Mac in the report: EditMax's codemax, and no Bun, no Node, no adapter on PATH.
const bare = { which: () => null, exists: () => false, execPath: "/Applications/EditMax.app/Contents/Resources/bin/codemax", compiled: true };

test("claude adapter: a compiled codemax on a Mac without Bun runs the adapter on its own Bun", () => {
  expect(claudeAdapter(bare)).toEqual({ cmd: [bare.execPath, "x", "--bun", CLAUDE_ADAPTER_PKG], env: { BUN_BE_BUN: "1" }, fetched: true });
  // Bun on PATH is still used first, and an adapter on PATH needs no fetching.
  expect(claudeAdapter({ ...bare, which: (b: string) => (b === "bunx" ? "/opt/homebrew/bin/bunx" : null) })).toEqual({ cmd: ["/opt/homebrew/bin/bunx", CLAUDE_ADAPTER_PKG], env: {}, fetched: true });
  expect(claudeAdapter({ ...bare, which: (b: string) => (b === "claude-agent-acp" ? "/x/claude-agent-acp" : null) })).toEqual({ cmd: ["/x/claude-agent-acp"], env: {}, fetched: false });
  // Not the compiled binary and no Bun anywhere: nothing to run it with.
  expect(claudeAdapter({ ...bare, compiled: false, execPath: "/usr/local/bin/node" })).toBeNull();
});

test("which: follows a PATH widened after start (Bun.which alone keeps the PATH the process started with)", () => {
  const d = mkdtempSync(join(tmpdir(), "codemax-which-"));
  writeFileSync(join(d, "zz-agent"), "#!/bin/sh\n");
  chmodSync(join(d, "zz-agent"), 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${d}:${old}`;
  try {
    expect(which("zz-agent")).toBe(join(d, "zz-agent"));
  } finally {
    process.env.PATH = old;
  }
  expect(which("zz-agent")).toBeNull();
});

test("system-wide PATH: the login shell's PATH first, then the app's, then the usual folders, each once", async () => {
  expect(mergePath(["/a", "/b"], "/b:/usr/bin", ["/a", "/c"])).toBe("/a:/b:/usr/bin:/c");
  const home = mkdtempSync(join(tmpdir(), "codemax-home-"));
  for (const d of [".local/bin", ".nvm/versions/node/v18.20.0/bin", ".nvm/versions/node/v22.3.0/bin"]) mkdirSync(join(home, d), { recursive: true });
  expect(knownBinDirs(home, (p) => p.startsWith(home) && existsSync(p))).toEqual([
    join(home, ".local/bin"),
    join(home, ".nvm/versions/node/v22.3.0/bin"),
    join(home, ".nvm/versions/node/v18.20.0/bin"),
  ]);
  // A shell whose rc files print things: only the marked PATH counts.
  const sh = join(home, "chatty-shell");
  writeFileSync(sh, '#!/bin/sh\necho "welcome back"\nPATH=/from/zshrc:/usr/bin\neval "$2"\necho bye\n');
  chmodSync(sh, 0o755);
  expect(await loginShellPath(sh)).toEqual(["/from/zshrc", "/usr/bin"]);
  // One that never answers is given up on.
  const stuck = join(home, "stuck-shell");
  writeFileSync(stuck, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(stuck, 0o755);
  const t0 = Date.now();
  expect(await loginShellPath(stuck, 300)).toEqual([]);
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("setup: an installed Antigravity without Google's server starts the download and says so", () => {
  const asked: string[] = [];
  expect(setupEngine("antigravity", false, (a) => (asked.push(a), { state: "installing" }))).toContain("installing Google's ACP server for Antigravity");
  expect(asked).toEqual(["antigravity"]);
  expect(setupEngine("antigravity", false, () => ({ state: "failed", error: "the ACP registry answered 503" }))).toContain("the ACP registry answered 503");
  const never: string[] = [];
  expect(setupEngine("antigravity", true, (a) => (never.push(a), { state: "installing" }))).toBeUndefined();
  expect(setupEngine("codex", false, (a) => (never.push(a), { state: "installing" }))).toBeUndefined();
  expect(never).toEqual([]);
});

test("setup: one installer at a time, a stale lock is ignored, and a failure waits 10 minutes", async () => {
  const dir = join(CODEMAX_HOME, "agents");
  mkdirSync(dir, { recursive: true });
  const spawned: string[][] = [];
  const spawn = (c: string[]) => void spawned.push(c);
  expect(startSetup("claude", spawn).state).toBe("installing");
  expect(spawned.map((c) => c.slice(-2))).toEqual([["install-engine", "claude"]]);
  expect(startSetup("claude", spawn).state).toBe("installing");   // just started: not a second one
  expect(spawned.length).toBe(1);

  const later = Date.now() + 60_000;   // past the start window: only the lock decides
  const lock = join(dir, "claude-install.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  expect(setupState("claude", later).state).toBe("installing");
  const logs: string[] = [];
  expect(await runSetup("claude", (m) => logs.push(m))).toBe(0);
  expect(logs).toEqual(["another codemax is installing the claude engine"]);
  writeFileSync(lock, JSON.stringify({ pid: 99_999_999 }));   // its installer was killed
  expect(setupState("claude", later).state).toBe("idle");

  const failed = join(dir, "antigravity-install.failed");
  writeFileSync(failed, JSON.stringify({ at: Date.now(), error: "the ACP registry answered 503" }));
  expect(startSetup("antigravity", spawn)).toEqual({ state: "failed", error: "the ACP registry answered 503" });
  writeFileSync(failed, JSON.stringify({ at: Date.now() - 11 * 60_000, error: "old" }));
  expect(startSetup("antigravity", spawn).state).toBe("installing");
  expect(spawned.map((c) => c.at(-1))).toEqual(["claude", "antigravity"]);
});

test("antigravity: the server is unpacked under a temporary name and renamed into place; a failed download leaves nothing", async () => {
  const src = mkdtempSync(join(tmpdir(), "codemax-agy-zip-"));
  writeFileSync(join(src, "agy_acp_server.par"), "#!/bin/sh\necho agy\n");
  const zip = join(src, "server.zip");
  expect(Bun.spawnSync(["zip", "-q", "-j", zip, join(src, "agy_acp_server.par")]).exitCode).toBe(0);
  const bytes = await Bun.file(zip).arrayBuffer();
  const ok = (async () => new Response(bytes)) as unknown as typeof fetch;
  const down = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
  const dir = join(CODEMAX_HOME, "agents", "antigravity-acp");

  await expect(installAntigravityServer({ version: "9.9.8", url: "https://dl.google.com/x.zip" }, () => {}, down)).rejects.toThrow("503");
  expect(existsSync(join(dir, "9.9.8"))).toBe(false);
  expect(readdirSync(dir).filter((n) => n.startsWith(".partial"))).toEqual([]);

  const spec = await installAntigravityServer({ version: "9.9.9", url: "https://dl.google.com/x.zip" }, () => {}, ok);
  expect(spec.cmd[0]).toBe(join(dir, "9.9.9", "agy_acp_server.par"));
  expect(antigravityServer()?.version).toBe("9.9.9");
  // What a killed download leaves is never taken for a server, even a newer-looking one.
  mkdirSync(join(dir, ".partial-9.9.10-1"));
  writeFileSync(join(dir, ".partial-9.9.10-1", "agy_acp_server.par"), "half");
  expect(antigravityServer()?.version).toBe("9.9.9");
});

test("serve: the agent list waits for the wider PATH and reports an engine being set up", async () => {
  process.env.CODEMAX_FAKE_AGENT = "1";
  const { Serve } = await import("../src/serve.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const out: any[] = [];
  let widened = false;
  const serve = new Serve({
    config: { ...structuredClone(DEFAULT_CONFIG), order: ["fake"] },
    available: async () => false,
    write: (l) => out.push(l),
    beforeDetect: async () => {
      await Bun.sleep(20);
      widened = true;
    },
    setup: (a, engine) => (widened && !engine ? `setting up ${a}` : undefined),
  });
  async function* input() {
    yield JSON.stringify({ id: 1, method: "agents" }) + "\n";
  }
  await serve.run(input());
  const fake = out.find((l) => l.id === 1)?.result?.find((a: any) => a.id === "fake");
  expect(fake).toMatchObject({ installed: false, version: "0.0.0", problem: "setting up fake" });
});

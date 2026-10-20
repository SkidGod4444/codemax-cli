import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-update-home-"));
const { checkForUpdate, installKind, isNewer, relaunchArgv, updatePlan, updateSource } = await import("../src/core/update.ts");

test("version comparison", () => {
  expect(isNewer("0.1.3", "0.1.2")).toBe(true);
  expect(isNewer("0.2.0", "0.1.9")).toBe(true);
  expect(isNewer("0.1.2", "0.1.2")).toBe(false);
  expect(isNewer("0.1.10", "0.1.9")).toBe(true);
  expect(isNewer("0.1.1", "0.1.2")).toBe(false);
});

test("install kind is read from where the code lives", () => {
  expect(installKind("/opt/homebrew/lib/node_modules/codemax-cli").kind).toBe("npm");
  expect(installKind("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\codemax-cli").kind).toBe("npm");
  const script = join(mkdtempSync(join(tmpdir(), "u-")), ".codemax", "cli");
  mkdirSync(join(script, ".git"), { recursive: true });
  expect(installKind(script).kind).toBe("script");
  const src = mkdtempSync(join(tmpdir(), "src-"));
  mkdirSync(join(src, ".git"));
  expect(installKind(src).kind).toBe("source");
  expect(installKind("/$bunfs/root").kind).toBe("binary");
});

test("each install updates its own way", () => {
  expect(updatePlan({ kind: "npm", root: "/x" }).cmd).toEqual([["npm", "install", "-g", "codemax-cli@latest"]]);
  expect(updatePlan({ kind: "script", root: "/h/.codemax/cli" }, "darwin")).toMatchObject({ cmd: [["bash", join("/h/.codemax/cli", "install.sh")]], env: { CODEMAX_DIR: "/h/.codemax/cli" } });
  expect(updatePlan({ kind: "script", root: "C:\\h\\.codemax\\cli" }, "win32").cmd[0]).toContain("-File");
  expect(updatePlan({ kind: "source", root: "/repo" }).cmd[0]).toEqual(["git", "-C", "/repo", "pull", "--ff-only"]);
  expect(updatePlan({ kind: "binary", root: "/$bunfs/root" }).manual).toContain("releases");
});

test("the update check asks the registry once, caches for 12 hours, and survives being offline", async () => {
  let calls = 0;
  const registry = (async () => {
    calls++;
    return new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 });
  }) as unknown as typeof fetch;
  expect(await checkForUpdate("0.1.3", { fetchImpl: registry, force: true, source: "npm" })).toBe("0.2.0");
  expect(await checkForUpdate("0.1.3", { fetchImpl: registry, source: "npm" })).toBe("0.2.0"); // cached
  expect(calls).toBe(1);
  expect(await checkForUpdate("0.2.0", { fetchImpl: registry, source: "npm" })).toBeNull(); // already current
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await checkForUpdate("0.1.3", { fetchImpl: offline, force: true, source: "npm" })).toBeNull();
});

test("installer, source and standalone installs check GitHub releases; npm installs check npm", async () => {
  expect(updateSource("npm")).toBe("npm");
  for (const k of ["script", "source", "binary"] as const) expect(updateSource(k)).toBe("github");
  const urls: string[] = [];
  const both = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(url.includes("github") ? { tag_name: "v0.3.0" } : { version: "0.1.1" }), { status: 200 });
  }) as unknown as typeof fetch;
  // a GitHub release npm has not caught up with: offered to installer users, not to npm users
  expect(await checkForUpdate("0.1.3", { fetchImpl: both, force: true, source: "github" })).toBe("0.3.0");
  expect(await checkForUpdate("0.1.3", { fetchImpl: both, force: true, source: "npm" })).toBeNull();
  expect(urls[0]).toContain("api.github.com/repos/SkidGod4444/codemax-cli/releases/latest");
});

test("model menus put the newest models first, Default/Auto pinned, ties in the agent's order", async () => {
  const { sortModels, modelVersion } = await import("../src/chat/models.ts");
  expect(modelVersion({ id: "claude-haiku-4-5-20251001", name: "claude-haiku-4-5-20251001" })).toBe(4.05);
  expect(modelVersion({ id: "x", name: "GPT-6.1-Sol" })).toBe(6.01);
  const out = sortModels([
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
    { id: "default[]", name: "Auto" },
    { id: "gpt-6-sol", name: "GPT-6-Sol" },
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
    { id: "composer-2.5", name: "composer-2.5" },
    { id: "mystery", name: "Mystery" },
  ]).map((m) => m.name);
  expect(out).toEqual(["Auto", "GPT-6.1-Sol", "GPT-6-Sol", "GPT-5.6-Luna", "composer-2.5", "Mystery"]);
});

test("times are always 12-hour, whatever the system locale", async () => {
  const { fmtTime12, fmtDateTime12 } = await import("../src/core/time.ts");
  expect(fmtTime12(new Date(2026, 9, 18, 19, 25).getTime())).toBe("7:25 PM");
  expect(fmtTime12(new Date(2026, 9, 18, 0, 5).getTime())).toBe("12:05 AM");
  expect(fmtDateTime12(new Date(2026, 9, 18, 19, 25).getTime())).toBe("Oct 18, 7:25 PM");
});

test("models are shown by their full display name everywhere, never the id", async () => {
  const { displayModelName } = await import("../src/chat/models.ts");
  const claude = [
    { id: "default", name: "Default (recommended)" },
    { id: "opus", name: "Opus 5.5" },
    { id: "sonnet", name: "Sonnet 5.5" },
    { id: "claude-sonnet-5", name: "Sonnet 5" },
  ];
  expect(displayModelName("opus", claude)).toBe("Opus 5.5");
  expect(displayModelName("default", claude)).toBe("Default");
  expect(displayModelName("claude-opus-5-5")).toBe("Opus 5.5"); // reported in usage, not in the list
  expect(displayModelName("claude-opus-5-5[context=300k,effort=medium]")).toBe("Opus 5.5"); // Cursor
  expect(displayModelName("claude-haiku-5-5-20260301")).toBe("Haiku 5.5");
  expect(displayModelName("anthropic/claude-sonnet-5")).toBe("Sonnet 5");
  expect(displayModelName("opus", [{ id: "x", name: "Opus 4.6" }, { id: "y", name: "Opus 5.5" }])).toBe("Opus 5.5"); // saved alias
  expect(displayModelName("gpt-6.1-codex", [{ id: "gpt-6.1-codex", name: "GPT-6.1-Codex" }])).toBe("GPT-6.1-Codex");
  expect(displayModelName("grok-4.7")).toBe("grok-4.7");
});

test("after /update codemax restarts with the same arguments, minus --fresh and a stale --agent", () => {
  const yes = () => true;
  expect(relaunchArgv(["bun", "/x/src/cli.ts", "--agent", "codex", "--fresh", "--theme", "dark"], "/b/bun", "/x/src/cli.ts", yes)).toEqual(["/b/bun", "/x/src/cli.ts", "--theme", "dark"]);
  expect(relaunchArgv(["bun", "/x/src/cli.ts", "-a", "claude"], "/b/bun", "/x/src/cli.ts", yes)).toEqual(["/b/bun", "/x/src/cli.ts"]);
  // The thread goes in the environment: `--resume` (with or without an id) is not repeated.
  expect(relaunchArgv(["bun", "/x/src/cli.ts", "--resume", "ab12cd34", "--tui"], "/b/bun", "/x/src/cli.ts", yes)).toEqual(["/b/bun", "/x/src/cli.ts", "--tui"]);
  expect(relaunchArgv(["bun", "/x/src/cli.ts", "--resume", "--theme", "dark"], "/b/bun", "/x/src/cli.ts", yes)).toEqual(["/b/bun", "/x/src/cli.ts", "--theme", "dark"]);
  // Bun or the script gone (replaced by the update): `codemax` from PATH.
  expect(relaunchArgv(["bun", "/x/src/cli.ts", "start"], "/gone/bun", "/x/src/cli.ts", (p) => p !== "/gone/bun", () => "/usr/local/bin/codemax")).toEqual(["/usr/local/bin/codemax", "start"]);
});

test("every released version tells users what changed: package.json's version has a what's-new entry", async () => {
  const pkg = await import("../package.json");
  const { WHATS_NEW } = await import("../src/core/whatsnew.ts");
  const lines = WHATS_NEW[pkg.version];
  expect(lines, `add WHATS_NEW["${pkg.version}"] in src/core/whatsnew.ts`).toBeDefined();
  expect(lines!.length).toBeGreaterThan(0);
  expect(lines!.length).toBeLessThanOrEqual(4);
  for (const l of lines!) expect(l.length).toBeLessThan(70);
});

test.skipIf(process.platform === "win32")("npm launcher: without a Bun 1.3+ on PATH, the bundled Bun becomes the global `bun` once, never replacing one", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, existsSync, readFileSync, lstatSync, readlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const T = mkdtempSync(join(tmpdir(), "codemax-launcher-"));
  const P = join(T, "lib", "node_modules", "codemax-cli");
  mkdirSync(join(P, "bin"), { recursive: true });
  mkdirSync(join(P, "src"));
  copyFileSync(join(import.meta.dir, "..", "bin", "codemax.cjs"), join(P, "bin", "codemax.cjs"));
  writeFileSync(join(P, "src", "cli.ts"), 'console.log("ran on", process.versions.bun);\n');
  // A stand-in for the @oven platform package: this Bun.
  const plat = `bun-${process.platform}-${process.arch === "arm64" ? "aarch64" : "x64"}`;
  const pkgDir = join(P, "node_modules", "@oven", plat);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: `@oven/${plat}`, version: Bun.version }));
  symlinkSync(process.execPath, join(pkgDir, "bin", "bun"));
  const home = join(T, "home");
  mkdirSync(home);
  const node = Bun.which("node");
  if (!node) return; // the launcher is a Node script
  const run = () => Bun.spawnSync([node, join(P, "bin", "codemax.cjs")], { env: { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" } });
  const first = run();
  expect(first.stdout.toString()).toContain(`ran on ${Bun.version}`);
  expect(first.stderr.toString()).toContain("~/.bun/bin/bun is now Bun");
  expect(lstatSync(join(home, ".bun", "bin", "bun")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(`export PATH="${join(home, ".bun", "bin")}:$PATH"`);
  const second = run();
  expect(second.stderr.toString()).not.toContain("is now Bun"); // once
  expect(existsSync(join(home, ".codemax", "global-bun.json"))).toBe(true);
  void readlinkSync;
});

test("restarting an npm install goes through its launcher (which picks the bundled Bun), not this process's Bun", async () => {
  const { relaunchArgv } = await import("../src/core/update.ts");
  const script = "/g/lib/node_modules/codemax-cli/src/cli.ts";
  const yes = () => true;
  expect(relaunchArgv(["bun", script, "--theme", "dark"], "/g/lib/node_modules/bun/bin/bun.exe", script, yes, (b) => (b === "node" ? "/usr/bin/node" : null))).toEqual(["/usr/bin/node", "/g/lib/node_modules/codemax-cli/bin/codemax.cjs", "--theme", "dark"]);
  // A source checkout or an installer install restarts with the same Bun, as before.
  expect(relaunchArgv(["bun", "/x/src/cli.ts"], "/b/bun", "/x/src/cli.ts", yes, () => "/usr/bin/node")).toEqual(["/b/bun", "/x/src/cli.ts"]);
});

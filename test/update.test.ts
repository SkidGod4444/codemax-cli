import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-update-home-"));
const { checkForUpdate, installKind, isNewer, updatePlan, updateSource } = await import("../src/core/update.ts");

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
  expect(updatePlan({ kind: "script", root: "/h/.codemax/cli" }, "darwin")).toMatchObject({ cmd: [["bash", "/h/.codemax/cli/install.sh"]], env: { CODEMAX_DIR: "/h/.codemax/cli" } });
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

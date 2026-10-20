import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectShared, sharedFor, skillsIndex, stripJsonc } from "../src/core/share.ts";

/** A home with every agent's setup, as found on the owner's Mac (values are fakes). */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "codemax-share-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "codemax-share-proj-"));
  const w = (p: string, t: string) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, t);
  };
  w(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { freecad: { type: "stdio", command: "uvx", args: ["freecad-mcp"], env: { FC_TOKEN: "claude-secret-1" } }, inspo: { type: "http", url: "https://inspo.example/mcp" } },
    projects: { [cwd]: { mcpServers: { exa: { type: "http", url: "https://exa.example/mcp", headers: { Authorization: "Bearer exa-secret" } } } } },
  }));
  w(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { projdb: { command: "node", args: ["db.js"] } } }));
  w(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { GitKraken: { command: "npx", args: ["-y", "gitkraken-mcp"], env: { GK_KEY: "cursor-secret" } }, "Better Auth": { url: "https://auth.example/mcp", headers: {} }, inspo: { url: "https://inspo-dup.example" } } }));
  w(join(home, ".codex", "config.toml"), `model = "gpt"\n\n[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp@latest"]\n\n[mcp_servers.playwright.tools.browser_close]\napproval_mode = "approve"\n\n[mcp_servers.figma]\nurl = "https://figma.example/mcp"\n\n[mcp_servers.off]\ncommand = "x"\nenabled = false\n`);
  w(join(home, ".config", "opencode", "opencode.jsonc"), `{\n  // comment with a url: https://x\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "ocdocs": { "type": "remote", "url": "https://docs.example/mcp" },\n    "oclocal": { "type": "local", "command": ["bun", "x", "my-mcp"], "environment": { "K": "v" } },\n  },\n}\n`);
  w(join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { gem: { command: "gem-mcp", args: [] } } }));
  // A Claude plugin with a skill and an MCP server.
  const plug = join(home, ".claude", "plugins", "cache", "official", "deploy", "1.0.0");
  w(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "deploy@official": [{ scope: "user", installPath: plug, version: "1.0.0" }] } }));
  w(join(plug, ".mcp.json"), JSON.stringify({ mcpServers: { deployer: { command: "${CLAUDE_PLUGIN_ROOT}/bin/deploy", args: [] } } }));
  w(join(plug, "skills", "ship", "SKILL.md"), "---\nname: ship\ndescription: Ship a release safely\n---\n# Ship\n");
  // Skills by owner.
  w(join(home, ".claude", "skills", "review", "SKILL.md"), '---\nname: review\ndescription: "Review a PR the house way"\n---\n');
  w(join(home, ".agents", "skills", "anatomy", "SKILL.md"), "---\nname: anatomy\ndescription: Isometric SVG figures\n---\n");
  w(join(home, ".codex", "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Red, green, refactor\n---\n");
  w(join(home, ".codex", "skills", "noname", "SKILL.md"), "no frontmatter here\n");
  return { home, cwd };
}

test("share: every agent's MCP servers and skills are collected once, deduped by name, with plugin paths resolved", () => {
  const { home, cwd } = fakeHome();
  const sh = collectShared(cwd, home);
  expect(sh.errors).toEqual([]);
  const names = sh.mcp.map((s) => `${s.source}:${s.name}`).sort();
  expect(names).toEqual(["claude:exa", "claude:freecad", "claude:inspo", "claude:projdb", "codex:figma", "codex:playwright", "cursor:Better Auth", "cursor:GitKraken", "gemini:gem", "opencode:occdocs".replace("occdocs", "ocdocs"), "opencode:oclocal", "plugin:deploy:deployer"].sort());
  expect(sh.mcp.find((s) => s.name === "inspo")!.source).toBe("claude"); // Cursor's duplicate dropped
  expect(sh.mcp.find((s) => s.name === "off")).toBeUndefined();
  expect(sh.mcp.find((s) => s.name === "oclocal")!.transport).toEqual({ type: "stdio", command: "bun", args: ["x", "my-mcp"], env: { K: "v" } });
  expect((sh.mcp.find((s) => s.name === "deployer")!.transport as any).command).toBe(`${join(home, ".claude", "plugins", "cache", "official", "deploy", "1.0.0")}/bin/deploy`); // the root substituted as text, as Claude does
  expect((sh.mcp.find((s) => s.name === "figma")!.transport as any).url).toBe("https://figma.example/mcp");
  expect(sh.skills.map((s) => `${s.source}:${s.name}`).sort()).toEqual(["agents:anatomy", "claude:review", "codex:noname", "codex:tdd", "plugin:ship"]);
  expect(sh.skills.find((s) => s.name === "review")!.description).toBe("Review a PR the house way");
});

test("share: each agent is given only what it does not load itself; the skills index names files, never contents", () => {
  const { home, cwd } = fakeHome();
  const sh = collectShared(cwd, home);
  const claude = sharedFor("claude", sh);
  expect(claude.mcp.map((s) => s.name).sort()).toEqual(["Better Auth", "GitKraken", "figma", "gem", "ocdocs", "oclocal", "playwright"]); // not its own, not its plugins'
  expect(claude.skills.map((s) => s.name).sort()).toEqual(["noname", "tdd"]); // Claude reads .claude, .agents and plugin skills itself
  const cursor = sharedFor("cursor", sh);
  expect(cursor.mcp.map((s) => s.name)).not.toContain("GitKraken");
  expect(cursor.mcp.map((s) => s.name)).toContain("freecad");
  expect(cursor.skills.length).toBe(5); // Cursor reads no skill folder: it gets the whole index
  const codex = sharedFor("codex", sh);
  expect(codex.mcp.map((s) => s.name)).not.toContain("playwright");
  expect(codex.skills.map((s) => s.name).sort()).toEqual(["review", "ship"]);
  const idx = skillsIndex(cursor.skills);
  expect(idx).toContain("- tdd: Red, green, refactor → ");
  expect(idx).toContain(join(home, ".codex", "skills", "tdd", "SKILL.md"));
  expect(idx).not.toContain("no frontmatter here");
});

test("share: secrets in env and headers reach the agents but never the debug log; unreadable configs are reported, not fatal", async () => {
  const d = await import("../src/core/debuglog.ts");
  if (existsSync(d.debugLogPath())) rmSync(d.debugLogPath());
  d.setDebugLog(true);
  try {
    const { home, cwd } = fakeHome();
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ not json");
    const sh = collectShared(cwd, home);
    expect((sh.mcp.find((s) => s.name === "freecad")!.transport as any).env.FC_TOKEN).toBe("claude-secret-1");
    expect(sh.errors.length).toBe(1);
    expect(sh.errors[0]!.file).toEndWith("mcp.json");
    const log = readFileSync(d.debugLogPath(), "utf8");
    expect(log).toContain('"kind":"shared-collected"');
    expect(log).toContain('"kind":"shared-config-error"');
    for (const secret of ["claude-secret-1", "exa-secret", "cursor-secret", "freecad", "https://"]) expect(log).not.toContain(secret);
  } finally {
    d.setDebugLog(false);
  }
});

test("stripJsonc leaves strings alone", () => {
  expect(JSON.parse(stripJsonc('{\n // c\n "u": "https://a/b", /* x */ "n": [1, 2,],\n}'))).toEqual({ u: "https://a/b", n: [1, 2] });
});

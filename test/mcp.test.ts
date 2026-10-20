import { test, expect } from "bun:test";
import { parseClaudeMcpMarkdown, describeStatus } from "../src/core/mcpstatus.ts";

test("the Claude adapter's /mcp Markdown is read back into statuses (groups, errors, tool counts, scopes, disabled, fences)", () => {
  const md = [
    "**MCP servers:** 6 (2 connected, 1 failed, 1 needs authentication, 1 connecting, 1 disabled)",
    "",
    "**Failed**",
    "- `freecad`: spawn uvx ENOENT. Is it installed?; 0 tools",
    "",
    "**Needs authentication**",
    "- `linear-server` (user)",
    "",
    "**Connecting**",
    "- `` a`b ``",
    "",
    "**Connected**",
    "- `inspo`: 12 tools",
    "- `linear-server` (project): 1 tool",
    "",
    "**Disabled:** `old-thing`, `another` (user)",
    "",
    "Run `/mcp reconnect <server>` to reconnect one server, or `/mcp reconnect` to reconnect every server that is not connected and not disabled.",
  ].join("\n");
  const out = parseClaudeMcpMarkdown(md)!;
  expect(out.map((s) => [s.name, s.status, s.tools, s.error, s.origin])).toEqual([
    ["freecad", "failed", 0, "spawn uvx ENOENT. Is it installed?", undefined],
    ["linear-server", "needs-auth", undefined, undefined, "user"],
    ["a`b", "pending", undefined, undefined, undefined],
    ["inspo", "connected", 12, undefined, undefined],
    ["linear-server", "connected", 1, undefined, "project"],
    ["old-thing", "disabled", undefined, undefined, undefined],
    ["another", "disabled", undefined, undefined, "user"],
  ]);
  expect(parseClaudeMcpMarkdown("No MCP servers are configured.")).toEqual([]);
  expect(parseClaudeMcpMarkdown("Here is what I found in the code…")).toBeNull();
  expect(describeStatus({ name: "x", status: "connected", tools: 1 })).toEqual({ text: "✔ connected · 1 tool", ok: true });
  expect(describeStatus({ name: "x", status: "failed", error: "boom" })).toEqual({ text: "✘ failed: boom", ok: false });
  expect(describeStatus({ name: "x", status: "needs-auth" }).text).toBe("⚠ needs authentication");
});

import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeTranscript } from "../src/transcripts/claude.ts";
import { parseCodexTranscript, codexQuotaFromRollout } from "../src/transcripts/codex.ts";
import { escapeCwd } from "../src/core/paths.ts";

const dir = mkdtempSync(join(tmpdir(), "codemax-fx-"));

test("claude transcript → turns (merges streamed assistant chunks, drops reminders)", () => {
  const p = join(dir, "c.jsonl");
  const lines = [
    { type: "queue-operation", operation: "enqueue" },
    { type: "user", timestamp: "2026-10-18T00:00:00Z", message: { role: "user", content: "<system-reminder>ignore</system-reminder>add a README" } },
    { type: "assistant", timestamp: "2026-10-18T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "On it." }, { type: "tool_use", name: "Write", input: {} }] } },
    { type: "user", timestamp: "2026-10-18T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    { type: "assistant", timestamp: "2026-10-18T00:00:03Z", message: { role: "assistant", content: [{ type: "text", text: "Done: README.md created." }] } },
    { type: "assistant", isSidechain: true, timestamp: "2026-10-18T00:00:04Z", message: { role: "assistant", content: [{ type: "text", text: "subagent noise" }] } },
  ];
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t = parseClaudeTranscript(p, "s1");
  expect(t.map((x) => x.role)).toEqual(["user", "assistant"]);
  expect(t[0]!.text).toBe("add a README");
  expect(t[1]!.text).toBe("On it.\nDone: README.md created.");
  expect(t[1]!.tools).toEqual(["Write"]);
});

test("codex rollout → turns + quota", () => {
  const p = join(dir, "r.jsonl");
  const lines = [
    { timestamp: "2026-10-18T00:00:00Z", type: "session_meta", payload: { id: "x", cwd: "/r" } },
    { timestamp: "2026-10-18T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] } },
    { timestamp: "2026-10-18T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] } },
    { timestamp: "2026-10-18T00:00:02Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
    { timestamp: "2026-10-18T00:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed." }] } },
    { timestamp: "2026-10-18T00:00:04Z", type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 42, resets_at: 1800000000 }, rate_limit_reached_type: null } } },
  ];
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t = parseCodexTranscript(p, "x");
  expect(t.map((x) => x.role)).toEqual(["user", "assistant"]);
  expect(t[0]!.text).toBe("fix the bug");
  expect(t[1]!.tools).toEqual(["shell"]);
  const q = codexQuotaFromRollout(p)!;
  expect(q.usedPercent).toBe(42);
  expect(q.exhausted).toBe(false);
});

test("claude project dir escaping", () => {
  expect(escapeCwd("/Users/me/Desktop/Codes/py_practice.v2")).toBe("-Users-me-Desktop-Codes-py-practice-v2");
});

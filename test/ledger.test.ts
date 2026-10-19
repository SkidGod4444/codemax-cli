import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger, BRIEF_MARKER } from "../src/core/ledger.ts";

test("growing assistant turn is stored once; briefs are not recorded", () => {
  const l = new Ledger("/tmp/some/project", mkdtempSync(join(tmpdir(), "codemax-ledger-")));
  const user = { ts: 1, agent: "claude" as const, sessionId: "s", role: "user" as const, text: "do it" };
  l.addTurns([user, { ts: 2, agent: "claude", sessionId: "s", role: "assistant", text: "work" }]);
  l.addTurns([user, { ts: 2, agent: "claude", sessionId: "s", role: "assistant", text: "working on it…", tools: ["Bash"] }]);
  l.addTurns([{ ts: 3, agent: "codex", sessionId: "c", role: "user", text: `${BRIEF_MARKER}\nlots of context` }]);
  const turns = l.turns();
  expect(turns).toHaveLength(2);
  expect(turns[1]!.text).toBe("working on it…");
  expect(turns[1]!.tools).toEqual(["Bash"]);
});

test("threads: a folder holds several conversations; old ledgers are copied into the first; usage stays project-wide", async () => {
  const { existsSync, writeFileSync, readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "codemax-threads-"));
  // A ledger from before threads: its files sit at the top level.
  writeFileSync(join(dir, "journal.jsonl"), JSON.stringify({ id: "1:user:1", ts: 1, agent: "claude", turn: "1", kind: "user", text: "old work" }) + "\n");
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ claude: { agent: "claude", id: "old-s", cwd: "/p", startedAt: 1, lastUsedAt: 1 } }));
  const first = new Ledger("/p", dir);
  expect(first.journal.steps().map((s: any) => s.text)).toEqual(["old work"]);
  expect(first.sessions().claude?.id).toBe("old-s");
  // Copied, not moved: an older codemax still finds them.
  expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
  expect(first.threadDir).toBe(join(dir, "threads", first.threadId));

  const second = new Ledger("/p", dir, "new");
  expect(second.threadId).not.toBe(first.threadId);
  expect(second.journal.steps()).toEqual([]);
  expect(second.sessions()).toEqual({});
  second.journal.append({ id: "2:user:1", ts: Date.now(), agent: "codex", turn: "2", kind: "user", text: "new task\nsecond line" });
  second.journal.append({ id: "2:text:1", ts: Date.now(), agent: "codex", turn: "2", kind: "text", text: "on it" });
  second.addUsage({ ts: 1, agent: "codex", inputTokens: 5, outputTokens: 1 } as any);

  // Newest first, titled by the first request, with the agent that last worked in it.
  const list = Ledger.threads(dir);
  expect(list.map((t) => t.id)).toEqual([second.threadId, first.threadId]);
  expect(list[0]).toMatchObject({ title: "new task second line", agent: "codex" });
  expect(list[1]).toMatchObject({ title: "old work", agent: "claude" });
  // No flag: the latest thread. A unique prefix finds one; an unknown id is an error.
  expect(new Ledger("/p", dir).threadId).toBe(second.threadId);
  expect(new Ledger("/p", dir, first.threadId.slice(0, 5)).threadId).toBe(first.threadId);
  expect(() => new Ledger("/p", dir, "zzzzzzzz")).toThrow(/no codemax thread "zzzzzzzz"/);
  // Usage belongs to the project: every thread (and the usage-only view) sees it.
  expect(first.usage()).toHaveLength(1);
  const usageOnly = new Ledger("/p", mkdtempSync(join(tmpdir(), "codemax-usage-")), false);
  expect(existsSync(join(usageOnly.dir, "threads"))).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, "threads", first.threadId, "thread.json"), "utf8")).migrated).toBe(true);
});

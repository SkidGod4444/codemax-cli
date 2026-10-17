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

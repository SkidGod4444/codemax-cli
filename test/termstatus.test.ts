import { test, expect } from "bun:test";
import { TerminalStatus, warpSupported, type TerminalSink } from "../src/core/termstatus.ts";

const WARP = { WARP_CLI_AGENT_PROTOCOL_VERSION: "1", WARP_CLIENT_VERSION: "v0.2026.09.30.08.29.stable_01" };

function rig(env: Record<string, string>, o: { enabled?: boolean; notify?: boolean } = {}) {
  const calls: { kind: "status" | "notify"; state?: string; title?: string; message?: string }[] = [];
  const sink: TerminalSink = {
    status: (s) => void calls.push({ kind: "status", state: s.state }),
    notify: (message, title) => void calls.push({ kind: "notify", title, message }),
  };
  const t = new TerminalStatus(sink, { cwd: "/work/app", env, enabled: () => o.enabled ?? true, notify: () => o.notify ?? true });
  const warp = () => calls.filter((c) => c.title === "warp://cli-agent").map((c) => JSON.parse(c.message!));
  return { t, calls, warp };
}

test("Warp support needs the protocol variable and a build that is not known to drop it", () => {
  expect(warpSupported(WARP)).toBe(true);
  expect(warpSupported({})).toBe(false);
  expect(warpSupported({ ...WARP, WARP_CLIENT_VERSION: "v0.2026.03.25.08.24.stable_05" })).toBe(false);
});

test("in Warp, a turn reports the active agent's session, prompt, tools, waits and stop", () => {
  const { t, warp, calls } = rig(WARP);
  t.started("claude", "Claude Code", "ses-1");
  t.prompt("fix the failing test");
  t.toolDone("Bash(bun test)");
  t.waiting("permission", "Edit src/a.ts", "edit", { detail: "x" });
  t.answered(true);
  t.turnEnded({ reply: "Fixed it.", ms: 60_000, longMs: 20_000 });
  const ev = warp();
  expect(ev.map((e) => e.event)).toEqual(["session_start", "prompt_submit", "tool_complete", "permission_request", "permission_replied", "stop"]);
  expect(ev[0]).toMatchObject({ v: 1, agent: "claude", session_id: "ses-1", cwd: "/work/app", project: "app" });
  expect(ev[1].query).toBe("fix the failing test");
  expect(ev[5]).toMatchObject({ query: "fix the failing test", response: "Fixed it." });
  // Warp raises its own notifications from these events: no second, plain one.
  expect(calls.filter((c) => c.title === "codemax")).toEqual([]);
  expect(calls.filter((c) => c.kind === "status").map((c) => c.state)).toEqual(["idle", "working", "blocked", "working", "done"]);
});

test("an agent Warp has no logo for gets status and plain notifications, not Warp events", () => {
  const { t, warp, calls } = rig(WARP);
  t.started("grok", "Grok CLI");
  t.waiting("permission", "Run rm -rf build");
  expect(warp()).toEqual([]);
  expect(calls.find((c) => c.title === "codemax")?.message).toBe("Grok CLI needs your approval: Run rm -rf build");
});

test("other terminals: notify only when you are not looking, and only for long turns", () => {
  const { t, calls } = rig({});
  t.started("codex", "Codex");
  t.focused = true;
  t.waiting("permission", "Run make");
  t.turnEnded({ reply: "done", ms: 60_000, longMs: 20_000 });
  expect(calls.filter((c) => c.kind === "notify")).toEqual([]);
  t.focused = false;
  t.turnEnded({ reply: "quick", ms: 2_000, longMs: 20_000 });
  t.turnEnded({ reply: "All   tests\npass.", ms: 60_000, longMs: 20_000 });
  expect(calls.filter((c) => c.kind === "notify").map((c) => c.message)).toEqual(["Codex finished: All tests pass."]);
});

test("turning the settings off sends nothing", () => {
  const { t, calls } = rig(WARP, { enabled: false, notify: false });
  t.started("claude", "Claude Code", "s");
  t.prompt("x");
  t.waiting("question", "Which database?");
  t.turnEnded({ reply: "y", ms: 99_000, longMs: 1 });
  expect(calls).toEqual([]);
});

test("a question always notifies when you are not looking, in Warp too; so does a reply that asks you something", () => {
  const { t, calls } = rig(WARP);
  t.started("cursor", "Cursor Agent", "ses-2");
  t.focused = false;
  t.waiting("question", "Which database should I use?", "question");
  t.waiting("permission", "Run bun test", "execute"); // Warp notifies for this one itself
  t.asked("Should I also update the migrations?");
  const own = calls.filter((c) => c.title === "codemax").map((c) => c.message);
  expect(own).toEqual(["Cursor Agent has a question: Which database should I use?", "Cursor Agent asks: Should I also update the migrations?"]);
  t.focused = true;
  t.asked("Anything else?");
  expect(calls.filter((c) => c.title === "codemax").length).toBe(2); // looking at it: no notification
});

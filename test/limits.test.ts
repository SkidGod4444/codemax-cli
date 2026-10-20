import { test, expect } from "bun:test";
import { classifyError, isLimitNotice, parseResetTime } from "../src/engines/errors.ts";

test("limit wording from every agent is classified as quota", () => {
  for (const msg of [
    "You've hit your session limit · resets 3pm (Asia/Kolkata)",
    "Claude AI usage limit reached|1792400000",
    "You've hit your usage limit. Upgrade to Pro",
    "You've reached your weekly limit",
    'API error (status 429 Too Many Requests): subscription:free-usage-exhausted',
    "Rate limited",
  ]) expect(classifyError(msg)).toBe("quota");
  expect(classifyError("Please run /login")).toBe("auth");
  expect(classifyError("tool failed: ENOENT")).toBe("protocol");
  // Ordinary errors are not a plan running out (they used to offer a handoff).
  for (const msg of ["insufficient permissions to write /etc/hosts", "context window limit reached; compacting", "status 429 from the GitHub API mock", "the author field is required"]) expect(classifyError(msg)).toBe("protocol");
});

test("a reply that is only a limit notice is recognised; ordinary replies are not", () => {
  expect(isLimitNotice("You've hit your session limit · resets 3pm")).toBe(true);
  expect(isLimitNotice("Claude AI usage limit reached|1792400000")).toBe(true);
  expect(isLimitNotice("I added a rate limiter; you've hit your session limit only in tests.")).toBe(false);
  expect(isLimitNotice("")).toBe(false);
});

test("reset times parse to the next occurrence", () => {
  const now = new Date(2026, 9, 19, 14, 0, 0);
  expect(new Date(parseResetTime("resets 3pm", now)!).getHours()).toBe(15);
  const tomorrow = new Date(parseResetTime("resets 9am", now)!);
  expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([20, 9]);
  expect(new Date(parseResetTime("resets at 18:30", now)!).getMinutes()).toBe(30);
  expect(parseResetTime("no time here", now)).toBeUndefined();
});

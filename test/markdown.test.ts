import { test, expect } from "bun:test";
import { styleMarkdown, styleToolOutput } from "../src/chat/markdown.ts";

const text = (st: any) => st.chunks.map((c: any) => c.text).join("");

test("markdown: strips markers but keeps content, colours diff lines in fences", () => {
  const st = styleMarkdown("# Title\nUse `bun test` and **always** *check*.\n- item\n```diff\n+added\n-removed\n```");
  const t = text(st);
  expect(t).toContain("Title");
  expect(t).not.toContain("# ");
  expect(t).toContain("bun test");
  expect(t).not.toContain("`");
  expect(t).toContain("always");
  expect(t).not.toContain("**");
  expect(t).toContain("• item");
  expect(t).toContain("── diff ──");
  const added = st.chunks.find((c: any) => c.text.includes("+added"));
  expect(added?.fg).toBeDefined();
});

test("tool output: diff lines get colour, other lines dim", () => {
  const st = styleToolOutput("@@ -1 +1 @@\n-hi\n+hello\ncontext");
  expect(text(st)).toBe("@@ -1 +1 @@\n-hi\n+hello\ncontext");
  expect(st.chunks.filter((c: any) => c.fg).length).toBeGreaterThanOrEqual(3);
});

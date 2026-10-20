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
  expect(t).toContain("- item"); // Claude Code's bullets
  expect(t).not.toContain("```");
  // A diff fence reads like any diff: summary, numbered lines, bands.
  expect(t).toContain("Added 1 line, removed 1 line");
  const added = st.chunks.find((c: any) => c.text.includes("added") && c.bg);
  expect(added?.bg).toBeDefined();
});

test("code blocks are highlighted like Claude Code's (Monokai on dark, GitHub on light): no rules, and only an unknown language is named", async () => {
  const { applyTheme } = await import("../src/chat/theme.ts");
  applyTheme("dark"); // another test file may have left the light theme on
  const st = styleMarkdown("```ts\nconst x = \"s\" // c\n```\n```weird\nraw\n```");
  const rgb = (c: any) => c.fg && [c.fg.r, c.fg.g, c.fg.b].map((v: number) => Math.round(v * 255)).join(",");
  const of = (piece: string) => rgb(st.chunks.find((c: any) => c.text.includes(piece)));
  expect(of("const")).toBe("102,217,239"); // storage #66d9ef
  expect(of('"s"')).toBe("230,219,116"); // string #e6db74
  expect(of("// c")).toBe("117,113,94"); // comment #75715e
  expect(text(st)).toBe("const x = \"s\" // c\nweird\nraw");
  expect(text(st)).not.toContain("──");
  applyTheme("light");
  const light = styleMarkdown("```ts\nconst x = 1\n```");
  expect(rgb(light.chunks.find((c: any) => c.text.includes("const")))).toBe("167,29,93"); // GitHub storage #a71d5d
  applyTheme("dark");
});

test("tool output: diffs read like Claude Code's (what happened, numbered lines, colour); other output stays dim", () => {
  const st = styleToolOutput("--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -11,3 +11,3 @@\n ctx\n-hi\n+hello\n@@ -40 +40 @@\n-old\n+new");
  expect(text(st)).toBe("Added 2 lines, removed 2 lines\n11   ctx\n12 - hi\n12 + hello\n...\n40 - old\n40 + new");
  expect(st.chunks.filter((c: any) => c.fg).length).toBeGreaterThanOrEqual(4);
  expect(text(styleToolOutput("--- /dev/null\n+++ new.ts\n+a\n+b"))).toBe("Added 2 lines\n1 + a\n2 + b");
  expect(text(styleToolOutput("ok\n2 passed"))).toBe("ok\n2 passed");
});

test("diffs mark the words that changed (Claude Code's word-level highlight), not when most of the line changed", async () => {
  const { diffRows } = await import("../src/chat/diffview.ts");
  const rows = diffRows("@@ -1 +1 @@\n-  if (expired(token)) return true\n+  if (expired(token)) return false");
  const del = rows.find((r) => r.kind === "del")!, add = rows.find((r) => r.kind === "add")!;
  expect(del.words!.map(([a, b]) => del.code!.slice(a, b))).toEqual(["true"]);
  expect(add.words!.map(([a, b]) => add.code!.slice(a, b))).toEqual(["false"]);
  // Symbols compare one character at a time, as in Claude Code: "<" → "<=" marks the "=".
  const op = diffRows("@@ -1 +1 @@\n-  if (exp < now) return true\n+  if (exp <= now) return true").find((r) => r.kind === "add")!;
  expect(op.words!.map(([a, b]) => op.code!.slice(a, b))).toEqual(["="]);
  const rewritten = diffRows("@@ -1 +1 @@\n-alpha beta gamma\n+totally different words");
  expect(rewritten.find((r) => r.kind === "add")!.words).toBeUndefined(); // over 40% changed: whole-line band only
});

test("bug fixes: asterisks in paths and code stay, '>=' is not a quote, rules, constructor fences, CRLF", async () => {
  const { applyTheme } = await import("../src/chat/theme.ts");
  applyTheme("dark");
  expect(text(styleMarkdown("edit src/*.ts and test/*.ts"))).toBe("edit src/*.ts and test/*.ts");
  expect(text(styleMarkdown("use **kwargs and *args here"))).toBe("use **kwargs and *args here");
  const it = styleMarkdown("this is *really* it");
  expect(text(it)).toBe("this is really it");
  expect(it.chunks.find((c: any) => c.text === "really")?.attributes).toBeTruthy();
  expect(text(styleMarkdown(">= 2.0 is required"))).toBe(">= 2.0 is required");
  expect(text(styleMarkdown("> quoted"))).toBe("▎ quoted");
  expect(text(styleMarkdown("* * *"))).toBe("---");
  expect(text(styleMarkdown("- - -"))).toBe("---");
  expect(() => styleMarkdown("```constructor\nx\n```")).not.toThrow();
  expect(() => styleMarkdown("```__proto__\nx\n```")).not.toThrow();
  expect(text(styleMarkdown("# T\r\nbody\r\n"))).not.toContain("\r");
});

test("bug fixes: git headers in diffs, binary files, '-- ' comments inside a hunk, model names, tips at small widths", async () => {
  const { diffRows } = await import("../src/chat/diffview.ts");
  const kinds = (t: string) => diffRows(t).map((r) => (r.kind === "summary" || r.kind === "note" ? `${r.kind}:${r.text}` : r.kind));
  expect(kinds("diff --git a/n.ts b/n.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b")).toEqual(["summary:Added 2 lines", "add", "add"]);
  expect(kinds("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ")).toEqual(["summary:Changed a binary file"]);
  expect(kinds("@@ -1,2 +1,2 @@\n--- old comment\n+++ new comment\n keep")).toEqual(["summary:Added 1 line, removed 1 line", "del", "add", "ctx"]);
  const { displayModelName } = await import("../src/chat/models.ts");
  expect(displayModelName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
  expect(displayModelName("claude-opus-4-6")).toBe("Opus 4.6");
  const { nextTip } = await import("../src/chat/tips.ts");
  expect(nextTip(0, { agents: 1, checks: false, hotkey: "ctrl+^" }, undefined, 5).text.length).toBeLessThanOrEqual(5);
  const { summarize } = await import("../src/chat/transcript.ts");
  expect(summarize("x".repeat(100_000)).length).toBeLessThan(400);
});

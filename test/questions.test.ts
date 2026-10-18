import { test, expect } from "bun:test";
// The Claude adapter's own code: how it builds AskUserQuestion forms and reads answers back.
import { askUserQuestionsToCreateRequest, applyAskElicitationResponse } from "@agentclientprotocol/claude-agent-acp/dist/elicitation.js";
import { elicitationResponse, parseElicitation } from "../src/engines/elicitation.ts";

const questions: any[] = [
  { question: "Which database should we use?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "relational, the default" }, { label: "SQLite", description: "one file" }] },
  { question: "Which checks should run?", header: "Checks", multiSelect: true, options: [{ label: "Lint" }, { label: "Tests" }] },
];

test("Claude's AskUserQuestion form becomes two questions, each with an Other box", () => {
  const req = parseElicitation("q1", askUserQuestionsToCreateRequest(questions, "s1", "t1"));
  expect(req.fields.map((f) => [f.key, f.kind, f.title, f.question, f.otherKey])).toEqual([
    ["question_0", "single", "Database", "Which database should we use?", "question_0_custom"],
    ["question_1", "multi", "Checks", "Which checks should run?", "question_1_custom"],
  ]);
  expect(req.fields[0]!.options).toEqual([{ value: "Postgres", label: "Postgres", description: "relational, the default" }, { value: "SQLite", label: "SQLite", description: "one file" }]);
});

test("answers round-trip into the shape Claude's AskUserQuestion tool reads", () => {
  const toolInput = { questions };
  const answered: any = applyAskElicitationResponse(elicitationResponse({ action: "accept", content: { question_0: "SQLite", question_0_custom: "keep it small", question_1: ["Lint"], question_1_custom: "Redis, not Memcached" } }) as any, toolInput, questions);
  expect(answered.updatedInput.answers).toEqual({ "Which database should we use?": "SQLite", "Which checks should run?": 'Lint, "Redis, not Memcached"' });
  expect(answered.updatedInput.annotations?.["Which database should we use?"]).toMatchObject({ notes: "keep it small" });
  // Skipping tells Claude you skipped; it does not abort the turn.
  expect(applyAskElicitationResponse(elicitationResponse({ action: "decline" }) as any, toolInput, questions)).toMatchObject({ action: "answered", updatedInput: { answers: {} } });
});

test("a single question takes its text from the message; any flat form is asked", () => {
  const one = parseElicitation("q2", askUserQuestionsToCreateRequest([questions[0]!], "s1", undefined));
  expect(one.fields).toHaveLength(1);
  expect(one.fields[0]!.question).toBe("Which database should we use?");
  const form = parseElicitation("q3", {
    message: "Configure the server",
    requestedSchema: { type: "object", required: ["port"], properties: { port: { type: "integer", title: "Port" }, verbose: { type: "boolean", title: "Verbose logs" }, region: { type: "string", enum: ["eu", "us"], enumNames: ["Europe", "US"] }, note: { type: "string", description: "Anything else?" } } },
  });
  expect(form.fields.map((f) => [f.key, f.kind, f.required ?? false])).toEqual([["port", "number", true], ["verbose", "boolean", false], ["region", "single", false], ["note", "text", false]]);
  expect(form.fields[2]!.options.map((o) => o.label)).toEqual(["Europe", "US"]);
});

test("the dialog: a number question takes digits as text; required fields are enforced", async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { QuestionDialog } = await import("../src/chat/question.ts");
  const { renderer } = await createTestRenderer({ width: 80, height: 20 });
  const req = parseElicitation("q", { message: "Port?", requestedSchema: { type: "object", required: ["port"], properties: { port: { type: "integer", title: "Port" } } } });
  let done: any = null;
  const d = new QuestionDialog(renderer, req, "OpenCode", (a) => (done = a));
  const key = (name: string, sequence = name) => d.handleKey({ name, sequence, ctrl: false, meta: false, shift: false } as any);
  key("return");
  expect(done).toBeNull(); // required: Enter on an empty answer is refused
  for (const c of "80a") key(c);
  key("return");
  expect(done).toBeNull(); // "80a" is not a whole number
  key("backspace");
  key("return");
  expect(done).toEqual({ action: "accept", content: { port: 80 } });
  d.destroy();
  renderer.destroy();
});

test("prompt line counting matches word wrap, newlines, long words and wide characters", async () => {
  const { wrappedLines } = await import("../src/chat/app.ts");
  expect(wrappedLines("", 10)).toBe(1);
  expect(wrappedLines("hello", 10)).toBe(1);
  expect(wrappedLines("hello world", 10)).toBe(2); // "hello " fits, "world" wraps
  expect(wrappedLines("one\ntwo\nthree", 10)).toBe(3);
  expect(wrappedLines("x".repeat(25), 10)).toBe(3); // a long word breaks by characters
  expect(wrappedLines("ab " + "x".repeat(25), 10)).toBe(4);
  expect(wrappedLines("日本語の文字", 10)).toBe(2); // 12 columns wide
});

test("an agent reply that asks you something is recognised (so a lone digit is your answer)", async () => {
  const { asksUser } = await import("../src/chat/app.ts");
  expect(asksUser("Done. Should I use option 1 or 2?")).toBe(true);
  expect(asksUser("Which approach?\n1. Rewrite the parser\n2. Patch the lexer")).toBe(true);
  expect(asksUser("Want me to push it? **")).toBe(true);
  expect(asksUser("Fixed the bug and the tests pass.")).toBe(false);
  expect(asksUser("Steps taken:\n1. read the file\n2. fixed it")).toBe(false);
  expect(asksUser("")).toBe(false);
});

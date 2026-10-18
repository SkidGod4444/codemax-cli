import { test, expect } from "bun:test";

test("the fake test agent registers even when the adapter registry was imported first", async () => {
  const { getAdapter, listAdapters } = await import("../src/adapters/index.ts");
  const before = process.env.CODEMAX_FAKE_AGENT;
  delete process.env.CODEMAX_FAKE_AGENT;
  expect(() => getAdapter("fake")).toThrow();
  process.env.CODEMAX_FAKE_AGENT = "1"; // set after import, as a later test file does
  try {
    expect(getAdapter("fake").id).toBe("fake");
    expect(listAdapters(["claude"]).map((a) => a.id)).toContain("fake");
  } finally {
    if (before === undefined) delete process.env.CODEMAX_FAKE_AGENT;
    else process.env.CODEMAX_FAKE_AGENT = before;
  }
});

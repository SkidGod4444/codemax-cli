import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCost, priceFor, fmtUsd } from "../src/core/pricing.ts";
import { renderUsageTable, totalsByAgent } from "../src/core/usage.ts";
import { ClaudeUsageTail } from "../src/transcripts/claude-usage.ts";
import { CodexEngine } from "../src/engines/codex.ts";
import type { EngineEvent } from "../src/engines/types.ts";

test("prices: model matching and API-equivalent cost", () => {
  expect(priceFor("claude-fable-5-1")?.key).toBe("claude-fable-5-1");
  expect(priceFor("gpt-5.6-terra")?.price.output).toBe(12);
  expect(priceFor("grok-4.7")?.price.input).toBe(2);
  expect(priceFor("opencode/big-pickle")?.price.input).toBe(0);
  expect(priceFor("mystery-model-9")).toBeNull();
  // 1M input + 1M output on Fable 5.1 = $60; cache read 1M = $0.25
  expect(estimateCost("claude-fable-5-1", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(60.25, 6);
  expect(fmtUsd(0.004)).toBe("$0.0040");
  expect(fmtUsd(1.5)).toBe("$1.50");
});

test("usage totals: agent-reported cost wins, unknown models flagged", () => {
  const t = totalsByAgent([
    { ts: 1, agent: "claude", sessionId: "a", model: "claude-opus-5-5", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    { ts: 2, agent: "opencode", sessionId: "b", model: "weird", input: 10, output: 10, cacheRead: 0, cacheWrite: 0, agentCostUsd: 0.5 },
    { ts: 3, agent: "grok", sessionId: "c", model: "unknown-thing", input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
  ]);
  const claude = t.find((x) => x.agent === "claude")!;
  expect(claude.costUsd).toBeCloseTo(4, 6);
  expect(t.find((x) => x.agent === "opencode")!.costUsd).toBe(0.5);
  expect(t.find((x) => x.agent === "grok")!.partial).toBe(true);
  const lines = renderUsageTable([], { title: "x" });
  expect(lines[1]).toContain("no usage");
});

test("Claude usage tail reads only newly appended assistant records", () => {
  const home = mkdtempSync(join(tmpdir(), "cm-usage-home-"));
  process.env.HOME = home; // paths.ts reads HOME at import time in other tests; construct the tail with explicit path instead
  const tail = new ClaudeUsageTail("/tmp/p", "sess");
  (tail as any).path = join(home, "t.jsonl");
  const rec = (i: number) => JSON.stringify({ type: "assistant", message: { model: "claude-fable-5-1", usage: { input_tokens: i, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } });
  writeFileSync((tail as any).path, rec(10) + "\n" + '{"type":"user","message":{"content":"x"}}' + "\n");
  expect(tail.read()).toEqual([{ model: "claude-fable-5-1", input: 10, output: 1, cacheRead: 2, cacheWrite: 3 }]);
  expect(tail.read()).toEqual([]);
  appendFileSync((tail as any).path, rec(20) + "\n");
  expect(tail.read().map((u) => u.input)).toEqual([20]);
});

test("Codex engine turns cumulative token totals into deltas with cached tokens split out", async () => {
  let toEngine: ((line: string) => void) | null = null;
  const reply = (o: object) => toEngine?.(JSON.stringify(o));
  const transport = {
    send(line: string) {
      const m = JSON.parse(line);
      queueMicrotask(() => {
        if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { userAgent: "codemax/0.159.3" } });
        else if (m.method === "thread/start") reply({ jsonrpc: "2.0", id: m.id, result: { thread: { id: "t1", model: "gpt-5.6-terra" } } });
        else if (m.method === "model/list") reply({ jsonrpc: "2.0", id: m.id, result: { data: [{ id: "gpt-5.6-terra", model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" }], nextCursor: null } });
        else if (m.method === "account/read") reply({ jsonrpc: "2.0", id: m.id, result: { account: { planType: "pro" } } });
        else if (m.method === "turn/start") {
          reply({ jsonrpc: "2.0", id: m.id, result: { turn: { id: "u1" } } });
          reply({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 0, outputTokens: 50 } } } });
          reply({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: 2500, cachedInputTokens: 2000, cacheWriteInputTokens: 0, outputTokens: 80 } } } });
          reply({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });
        }
      });
    },
    onLine(cb: (line: string) => void) { toEngine = cb; },
    async close() {},
  };
  const engine = new CodexEngine({ transport });
  const usage: EngineEvent[] = [];
  engine.onEvent((e) => e.type === "usage" && usage.push(e));
  const info = await engine.start({ cwd: "/tmp" });
  expect(info.currentModel).toBe("gpt-5.6-terra");
  expect(info.plan).toBe("chatgpt pro");
  await engine.prompt("hi");
  expect(usage).toHaveLength(2);
  expect(usage[0]).toMatchObject({ inputTokens: 400, cacheReadTokens: 600, outputTokens: 50, model: "gpt-5.6-terra" });
  expect(usage[1]).toMatchObject({ inputTokens: 100, cacheReadTokens: 1400, outputTokens: 30 });
});

test("live prices: OpenRouter ids normalize and win over built-ins; costs are frozen per record", async () => {
  const { parseOpenRouter, normalizeModelId } = await import("../src/core/prices-live.ts");
  const { priceRecord } = await import("../src/core/usage.ts");
  expect(normalizeModelId("anthropic/claude-opus-5.5:batch")).toBe("claude-opus-5-5");
  expect(normalizeModelId("x-ai/grok-4.7")).toBe("grok-4-7");
  expect(normalizeModelId("azure/us/gpt-5.6-terra")).toBe("gpt-5-6-terra");
  const parsed = parseOpenRouter({ data: [{ id: "openai/gpt-5.6-terra", pricing: { prompt: "0.000002", completion: "0.000012", input_cache_read: "0.0000002" } }, { id: "openai/gpt-5.6-terra:batch", pricing: { prompt: "0.000001", completion: "0.000006" } }] });
  expect(parsed["gpt-5-6-terra"]).toEqual({ input: 2, output: 12, cacheRead: 0.2, cacheWrite: undefined });
  const frozen = priceRecord({ ts: 1, agent: "codex", sessionId: "s", model: "gpt-5.6-terra", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  expect(frozen.costUsd).toBeCloseTo(2, 6);
  expect(frozen.priceSource).toMatch(/^(builtin|openrouter|litellm|user)/);
  const agentPriced = priceRecord({ ts: 1, agent: "grok", sessionId: "s", model: "grok-4.7", input: 5, output: 5, cacheRead: 0, cacheWrite: 0, agentCostUsd: 0.01 });
  expect(agentPriced).toMatchObject({ costUsd: 0.01, priceSource: "agent" });
  const unknown = priceRecord({ ts: 1, agent: "grok", sessionId: "s", model: "nope-9000", input: 5, output: 5, cacheRead: 0, cacheWrite: 0 });
  expect(unknown.priceSource).toBe("none");
});

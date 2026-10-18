import type { AgentId } from "../adapters/types.ts";
import { estimateCost, fmtTokens, fmtUsd, priceFor, priceProvenance } from "./pricing.ts";

/** One usage sample: a model call, a turn, or a delta reported by the agent. */
export interface UsageRecord {
  ts: number;
  agent: AgentId;
  sessionId: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cost the agent itself reported (OpenCode, Grok do). */
  agentCostUsd?: number;
  /** USD frozen at record time so later price changes do not rewrite history. */
  costUsd?: number;
  /** Where that figure came from: "agent", "user", "openrouter@2026-10-18", "builtin@…", or "none". */
  priceSource?: string;
}

/** Price a fresh record now and freeze the result on it. */
export function priceRecord(r: UsageRecord): UsageRecord {
  if (typeof r.agentCostUsd === "number") return { ...r, costUsd: r.agentCostUsd, priceSource: "agent" };
  const hit = priceFor(r.model);
  const est = estimateCost(r.model, r);
  if (hit && est !== null) {
    const prov = priceProvenance();
    return { ...r, costUsd: est, priceSource: hit.source === "user" ? "user" : hit.source === "builtin" ? `builtin@${prov.source === "builtin" ? prov.asOf : "2026-10-18"}` : `${hit.source}@${prov.asOf}` };
  }
  return { ...r, costUsd: undefined, priceSource: "none" };
}

export interface UsageTotals {
  agent: AgentId;
  models: Set<string>;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** API-equivalent USD: agent-reported where available, else estimated from list prices. */
  costUsd: number;
  /** True when some records had no price and were counted at $0. */
  partial: boolean;
}

export function recordCost(r: UsageRecord): { usd: number; known: boolean } {
  if (typeof r.agentCostUsd === "number") return { usd: r.agentCostUsd, known: true };
  if (typeof r.costUsd === "number") return { usd: r.costUsd, known: true };
  if (r.priceSource === "none") return { usd: 0, known: false };
  const est = estimateCost(r.model, r); // legacy records without a frozen cost
  return est === null ? { usd: 0, known: !(r.input || r.output || r.cacheRead || r.cacheWrite) } : { usd: est, known: true };
}

export function totalsByAgent(records: UsageRecord[]): UsageTotals[] {
  const map = new Map<AgentId, UsageTotals>();
  for (const r of records) {
    let t = map.get(r.agent);
    if (!t) {
      t = { agent: r.agent, models: new Set(), calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, partial: false };
      map.set(r.agent, t);
    }
    if (r.model) t.models.add(r.model);
    t.calls++;
    t.input += r.input;
    t.output += r.output;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += r.cacheWrite;
    const c = recordCost(r);
    t.costUsd += c.usd;
    if (!c.known) t.partial = true;
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export function sumCost(records: UsageRecord[]): number {
  return records.reduce((s, r) => s + recordCost(r).usd, 0);
}

/** Plain-text table for /usage and `codemax usage`. */
export function renderUsageTable(records: UsageRecord[], opts: { title: string; sessionId?: string }): string[] {
  const rows = totalsByAgent(records);
  const lines: string[] = [];
  lines.push(`${opts.title} · API-equivalent value at list prices (your subscriptions covered this)`);
  if (!rows.length) {
    lines.push("  no usage recorded yet");
    return lines;
  }
  const head = ["agent", "calls", "input", "output", "cache read", "cache write", "est. cost"];
  const data = rows.map((t) => [
    t.agent + (t.models.size ? ` (${[...t.models].map(shortModel).join(", ")})` : ""),
    String(t.calls),
    fmtTokens(t.input),
    fmtTokens(t.output),
    fmtTokens(t.cacheRead),
    fmtTokens(t.cacheWrite),
    fmtUsd(t.costUsd) + (t.partial ? "*" : ""),
  ]);
  const total = ["total", String(rows.reduce((s, t) => s + t.calls, 0)), fmtTokens(rows.reduce((s, t) => s + t.input, 0)), fmtTokens(rows.reduce((s, t) => s + t.output, 0)), fmtTokens(rows.reduce((s, t) => s + t.cacheRead, 0)), fmtTokens(rows.reduce((s, t) => s + t.cacheWrite, 0)), fmtUsd(rows.reduce((s, t) => s + t.costUsd, 0))];
  const all = [head, ...data, total];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => "  " + r.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  ");
  lines.push(fmt(head));
  for (const r of data) lines.push(fmt(r));
  lines.push(fmt(total));
  if (rows.some((t) => t.partial)) lines.push("  * includes calls on a model with no known price; set it in ~/.codemax/prices.json");
  const prov = priceProvenance();
  const agentPriced = records.filter((r) => typeof r.agentCostUsd === "number").length;
  lines.push(`  prices: ${prov.source} list as of ${prov.asOf}${agentPriced ? ` · ${agentPriced} calls priced by the agent itself` : ""} · each call keeps the rate it was recorded at`);
  return lines;
}

export function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/^(anthropic|openai|xai|google|opencode)\//, "");
}

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { CODEMAX_HOME } from "./paths.ts";
import { loadLivePrices, normalizeModelId, type LivePrices } from "./prices-live.ts";

/** USD per million tokens. cacheWrite defaults to 1.25 × input when omitted. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * List prices (USD per 1M tokens) as published on 2026-10-18. Matched by the
 * first entry whose key is a substring of the model id, so order matters
 * (more specific first). Override or extend in ~/.codemax/prices.json.
 */
export const DEFAULT_PRICES: [string, Price][] = [
  // Anthropic
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1.0 }],
  ["claude-mythos", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-4-6", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1 }],
  ["claude-haiku", { input: 1, output: 5, cacheRead: 0.1 }],
  ["fable", { input: 10, output: 50, cacheRead: 0.25 }],
  ["opus", { input: 4, output: 20, cacheRead: 0.2 }],
  ["sonnet", { input: 2, output: 10, cacheRead: 0.2 }],
  ["haiku", { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  // OpenAI
  ["gpt-6.1-sol", { input: 10, output: 50, cacheRead: 0.5 }],
  ["gpt-6-astra", { input: 10, output: 50, cacheRead: 1.0 }],
  ["gpt-5.6-sol", { input: 4, output: 20, cacheRead: 0.4 }],
  ["gpt-5.6-terra", { input: 2, output: 12, cacheRead: 0.2 }],
  ["gpt-5.6-luna", { input: 0.2, output: 1.2, cacheRead: 0.02 }],
  ["gpt-5.5-pro", { input: 30, output: 180 }],
  ["gpt-5.5", { input: 5, output: 30, cacheRead: 0.5 }],
  ["gpt-5.4-mini", { input: 0.75, output: 4.5, cacheRead: 0.075 }],
  ["gpt-5.4", { input: 2.5, output: 15, cacheRead: 0.25 }],
  ["gpt-5", { input: 2, output: 12, cacheRead: 0.2 }],
  // xAI
  ["grok-4.7", { input: 2, output: 6, cacheRead: 0.5 }],
  ["grok-4.6", { input: 2, output: 6, cacheRead: 0.5 }],
  ["grok-4.5", { input: 2, output: 6, cacheRead: 0.5 }],
  ["grok-4.20", { input: 1.25, output: 2.5, cacheRead: 0.2 }],
  ["grok-4.3", { input: 1.25, output: 2.5, cacheRead: 0.2 }],
  ["grok", { input: 2, output: 6, cacheRead: 0.5 }],
  // Google
  ["gemini-3", { input: 2, output: 12, cacheRead: 0.2 }],
  ["gemini-2.5-pro", { input: 1.25, output: 10, cacheRead: 0.31 }],
  ["gemini-2.5-flash", { input: 0.3, output: 2.5, cacheRead: 0.03 }],
  ["gemini", { input: 1.25, output: 10, cacheRead: 0.31 }],
  // OpenCode's bundled free models
  ["big-pickle", { input: 0, output: 0, cacheRead: 0 }],
  ["opencode/", { input: 0, output: 0, cacheRead: 0 }],
];

let cached: [string, Price][] | null = null;
let userCached: [string, Price][] | null = null;
let liveCached: LivePrices | null | undefined;

/** Forget cached tables (after `codemax prices update` or in tests). */
export function resetPriceCache() {
  cached = null;
  userCached = null;
  liveCached = undefined;
}

function userPrices(): [string, Price][] {
  if (userCached) return userCached;
  const user: [string, Price][] = [];
  const p = join(CODEMAX_HOME, "prices.json");
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, Price>;
      for (const [k, v] of Object.entries(j)) if (typeof v?.input === "number" && typeof v?.output === "number") user.push([k.toLowerCase(), v]);
    } catch {
      /* ignore malformed overrides */
    }
  }
  userCached = user;
  return user;
}

function live(): LivePrices | null {
  if (liveCached === undefined) liveCached = loadLivePrices();
  return liveCached;
}

/** Built-in table with the user's ~/.codemax/prices.json entries placed first (no live data). */
export function priceTable(): [string, Price][] {
  if (cached) return cached;
  cached = [...userPrices(), ...DEFAULT_PRICES];
  return cached;
}

export type PriceSource = "user" | "openrouter" | "litellm" | "builtin";

/**
 * Resolve a price: user overrides first, then the downloaded list (exact id,
 * then the longest id contained in the model name), then the built-in table.
 */
export function priceFor(model: string | undefined): { key: string; price: Price; source: PriceSource } | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [key, price] of userPrices()) if (m.includes(key)) return { key, price, source: "user" };
  const l = live();
  if (l) {
    const norm = normalizeModelId(m);
    if (l.prices[norm]) return { key: norm, price: l.prices[norm]!, source: l.source };
    let best: string | null = null;
    for (const k of Object.keys(l.prices)) if (k.length >= 6 && norm.includes(k) && (!best || k.length > best.length)) best = k;
    if (best) return { key: best, price: l.prices[best]!, source: l.source };
  }
  for (const [key, price] of DEFAULT_PRICES) if (m.includes(key)) return { key, price, source: "builtin" };
  return null;
}

/** Human description of where prices come from, for /usage and `codemax prices`. */
export function priceProvenance(): { source: PriceSource; asOf: string } {
  const l = live();
  if (l) return { source: l.source, asOf: new Date(l.fetchedAt).toISOString().slice(0, 10) };
  return { source: "builtin", asOf: "2026-10-18" };
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** API-equivalent USD for the given tokens, or null when the model is unknown. */
export function estimateCost(model: string | undefined, t: TokenCounts): number | null {
  const hit = priceFor(model);
  if (!hit) return null;
  const { price } = hit;
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const cacheWrite = price.cacheWrite ?? price.input * 1.25;
  return (t.input * price.input + t.output * price.output + t.cacheRead * cacheRead + t.cacheWrite * cacheWrite) / 1_000_000;
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

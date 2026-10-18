import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CODEMAX_HOME, ensureDir } from "./paths.ts";
import type { Price } from "./pricing.ts";

export interface LivePrices {
  fetchedAt: number;
  source: "openrouter" | "litellm";
  /** Keyed by normalized model id: lowercase, provider prefix and :suffix removed, dots as dashes. */
  prices: Record<string, Price>;
}

export const LIVE_PRICES_PATH = join(CODEMAX_HOME, "prices-live.json");
const OPENROUTER = "https://openrouter.ai/api/v1/models";
const LITELLM = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MAX_AGE_MS = 7 * 86_400_000;

/** "anthropic/claude-opus-5.5:batch" → "claude-opus-5-5"; "xai/grok-4.7" → "grok-4-7". */
export function normalizeModelId(id: string): string {
  let s = id.toLowerCase().trim();
  s = s.replace(/:(batch|free|extended|thinking|online)$/, "");
  s = s.replace(/^(global\.|us\.|eu\.|apac\.)/, "");
  s = s.replace(/^[a-z0-9_-]+[\/.](?=[a-z])/, ""); // provider prefix: "anthropic/", "anthropic.", "azure/us/" (loop below)
  while (/^(us|eu|global|apac)\//.test(s)) s = s.replace(/^[a-z]+\//, "");
  return s.replace(/\./g, "-");
}

const perM = (perToken: unknown): number | undefined => {
  const n = Number(perToken);
  return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
};

export function parseOpenRouter(json: any): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const m of json?.data ?? []) {
    const p = m.pricing ?? {};
    const input = perM(p.prompt);
    const output = perM(p.completion);
    if (input === undefined || output === undefined) continue;
    const key = normalizeModelId(String(m.id));
    if (out[key] && /:batch|:free/.test(String(m.id))) continue; // keep the standard variant
    out[key] = {
      input,
      output,
      cacheRead: p.input_cache_read ? perM(p.input_cache_read) : undefined,
      cacheWrite: p.input_cache_write ? perM(p.input_cache_write) : undefined,
    };
  }
  return out;
}

export function parseLiteLlm(json: any): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const [id, v] of Object.entries<any>(json ?? {})) {
    if (id === "sample_spec" || typeof v?.input_cost_per_token !== "number" || typeof v?.output_cost_per_token !== "number") continue;
    if (/^(azure|bedrock|vertex|databricks|perplexity|openrouter|fireworks|together)/.test(id)) continue; // partner-priced variants
    const key = normalizeModelId(id);
    if (out[key]) continue;
    out[key] = {
      input: perM(v.input_cost_per_token)!,
      output: perM(v.output_cost_per_token)!,
      cacheRead: typeof v.cache_read_input_token_cost === "number" ? perM(v.cache_read_input_token_cost) : undefined,
      cacheWrite: typeof v.cache_creation_input_token_cost === "number" ? perM(v.cache_creation_input_token_cost) : undefined,
    };
  }
  return out;
}

export function loadLivePrices(): LivePrices | null {
  if (!existsSync(LIVE_PRICES_PATH)) return null;
  try {
    const j = JSON.parse(readFileSync(LIVE_PRICES_PATH, "utf8"));
    return j && typeof j.fetchedAt === "number" && j.prices ? (j as LivePrices) : null;
  } catch {
    return null;
  }
}

export function livePricesStale(l: LivePrices | null, now = Date.now()): boolean {
  return !l || now - l.fetchedAt > MAX_AGE_MS;
}

/** Download the current list (OpenRouter, then LiteLLM) and cache it. Returns null when offline. */
export async function fetchLivePrices(timeoutMs = 8000): Promise<LivePrices | null> {
  const get = async (url: string) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "codemax-cli" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  };
  let result: LivePrices | null = null;
  try {
    const prices = parseOpenRouter(await get(OPENROUTER));
    if (Object.keys(prices).length > 50) result = { fetchedAt: Date.now(), source: "openrouter", prices };
  } catch {
    /* try the next source */
  }
  if (!result) {
    try {
      const prices = parseLiteLlm(await get(LITELLM));
      if (Object.keys(prices).length > 50) result = { fetchedAt: Date.now(), source: "litellm", prices };
    } catch {
      /* offline */
    }
  }
  if (result) {
    ensureDir(CODEMAX_HOME);
    writeFileSync(LIVE_PRICES_PATH, JSON.stringify(result));
  }
  return result;
}

/** Refresh in the background when the cache is older than a week. Never throws. */
export async function refreshLivePricesIfStale(): Promise<LivePrices | null> {
  const cur = loadLivePrices();
  if (!livePricesStale(cur)) return cur;
  return (await fetchLivePrices().catch(() => null)) ?? cur;
}

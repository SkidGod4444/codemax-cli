import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { AgentId } from "../adapters/types.ts";
import { CODEMAX_HOME } from "./paths.ts";
import { Ledger } from "./ledger.ts";
import { recordCost, type UsageRecord } from "./usage.ts";

export type BudgetKey = AgentId | "all";

export function startOfDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today's API-equivalent spend per agent, across every project codemax has seen. */
export function spendToday(now = Date.now()): Map<BudgetKey, number> {
  const since = startOfDay(now);
  const out = new Map<BudgetKey, number>();
  const root = join(CODEMAX_HOME, "projects");
  if (!existsSync(root)) return out;
  for (const d of readdirSync(root)) {
    for (const r of new Ledger("/", join(root, d), false).usage()) addSpend(out, r, since);
  }
  return out;
}

export function addSpend(map: Map<BudgetKey, number>, r: UsageRecord, since = startOfDay()) {
  if (r.ts < since) return;
  const usd = recordCost(r).usd;
  map.set(r.agent, (map.get(r.agent) ?? 0) + usd);
  map.set("all", (map.get("all") ?? 0) + usd);
}

export type BudgetLevel = "ok" | "warn" | "over";

export function budgetLevel(spent: number, limit: number | undefined): BudgetLevel {
  if (!limit || limit <= 0) return "ok";
  if (spent >= limit) return "over";
  if (spent >= limit * 0.8) return "warn";
  return "ok";
}

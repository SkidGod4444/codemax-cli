import type { Adapter, AgentId } from "./types.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { opencode, cursor, grok, gemini, copilot, fake } from "./simple.ts";

const all: Adapter[] = [claude, codex, opencode, cursor, grok, gemini, copilot];
if (process.env.CODEMAX_FAKE_AGENT) all.push(fake);

export const adapters: Record<string, Adapter> = Object.fromEntries(all.map((a) => [a.id, a]));

export function getAdapter(id: string): Adapter {
  const a = adapters[id];
  if (!a) throw new Error(`unknown agent "${id}". Known: ${Object.keys(adapters).join(", ")}`);
  return a;
}

export function listAdapters(order: AgentId[]): Adapter[] {
  const ranked = order.map((id) => adapters[id]).filter((a): a is Adapter => !!a);
  const rest = all.filter((a) => !ranked.includes(a));
  return [...ranked, ...rest];
}

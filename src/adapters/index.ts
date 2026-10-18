import type { Adapter, AgentId } from "./types.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { opencode, cursor, grok, gemini, copilot, fake } from "./simple.ts";

const real: Adapter[] = [claude, codex, opencode, cursor, grok, gemini, copilot];

/**
 * The adapters, read at call time: tests set CODEMAX_FAKE_AGENT after another
 * test file may already have imported this module (bun runs all files in one
 * process), so the fake agent must not be decided once at import.
 */
function all(): Adapter[] {
  return process.env.CODEMAX_FAKE_AGENT ? [...real, fake] : real;
}

export function getAdapter(id: string): Adapter {
  const a = all().find((x) => x.id === id);
  if (!a) throw new Error(`unknown agent "${id}". Known: ${all().map((x) => x.id).join(", ")}`);
  return a;
}

export function listAdapters(order: AgentId[]): Adapter[] {
  const list = all();
  const ranked = order.map((id) => list.find((a) => a.id === id)).filter((a): a is Adapter => !!a);
  return [...ranked, ...list.filter((a) => !ranked.includes(a))];
}

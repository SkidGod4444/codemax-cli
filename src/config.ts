import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CODEMAX_HOME, ensureDir } from "./core/paths.ts";
import type { AgentId } from "./adapters/types.ts";

export interface Config {
  /** Priority order used for "next agent" suggestions. */
  order: AgentId[];
  /** Hotkey byte that opens the codemax menu. Default 0x1f (Ctrl+_ / Ctrl+/). */
  hotkey: number;
  /** Offer a switch automatically when quota exhaustion is detected. */
  autoSwitch: boolean;
  /** Per-agent extra CLI args appended to every launch. */
  agentArgs: Partial<Record<AgentId, string[]>>;
  /** Max turns and chars included in a handoff brief. */
  brief: { turns: number; maxChars: number; turnChars: number };
}

export const DEFAULT_CONFIG: Config = {
  order: ["claude", "codex", "opencode", "cursor", "grok", "gemini", "copilot"],
  hotkey: 0x1f,
  autoSwitch: true,
  agentArgs: {},
  brief: { turns: 10, maxChars: 8000, turnChars: 1200 },
};

export const CONFIG_PATH = join(CODEMAX_HOME, "config.json");

export function loadConfig(): Config {
  ensureDir(CODEMAX_HOME);
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      brief: { ...DEFAULT_CONFIG.brief, ...(raw.brief ?? {}) },
      agentArgs: { ...(raw.agentArgs ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function hotkeyLabel(byte: number): string {
  if (byte === 0x1f) return "Ctrl+/ (Ctrl+_)";
  if (byte === 0x1e) return "Ctrl+^";
  if (byte >= 1 && byte <= 26) return `Ctrl+${String.fromCharCode(64 + byte)}`;
  return `0x${byte.toString(16)}`;
}

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CODEMAX_HOME, ensureDir } from "./core/paths.ts";
import type { AgentId } from "./adapters/types.ts";

export interface Config {
  /** Priority order used for "next agent" suggestions. */
  order: AgentId[];
  /**
   * Hotkeys that open the codemax menu, as "ctrl+<key>". Each is matched in
   * every encoding terminals use (raw byte, CSI u, modifyOtherKeys).
   * Default: ctrl+/ and ctrl+^. Run `codemax keys` to see what yours sends.
   */
  hotkeys: string[];
  /** Offer a switch automatically when quota exhaustion is detected. */
  autoSwitch: boolean;
  /** Per-agent extra CLI args appended to every launch. */
  agentArgs: Partial<Record<AgentId, string[]>>;
  /** Refresh the public price list weekly for /usage (set false to stay offline). */
  priceUpdates: boolean;
  /** Max turns and chars included in a handoff brief. */
  brief: { turns: number; maxChars: number; turnChars: number };
}

export const DEFAULT_CONFIG: Config = {
  order: ["claude", "codex", "opencode", "cursor", "grok", "gemini", "copilot"],
  hotkeys: ["ctrl+/", "ctrl+^"],
  autoSwitch: true,
  agentArgs: {},
  priceUpdates: true,
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
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config> & { hotkey?: number };
    // v0.1.0 stored a single byte; map it onto the new list.
    if (!raw.hotkeys && typeof raw.hotkey === "number") raw.hotkeys = [raw.hotkey === 0x1e ? "ctrl+^" : "ctrl+/"];
    delete raw.hotkey;
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

export function hotkeyLabel(hotkeys: string[]): string {
  return hotkeys.map((h) => h.replace(/^ctrl\+/i, "Ctrl+")).join(" or ");
}

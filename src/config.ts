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
  /** Ask the outgoing agent for a project summary before a switch (skipped when it is out of quota). */
  summarizeOnSwitch: boolean;
  /** Ring the terminal bell when a turn longer than this many seconds finishes (0 = never). */
  bellAfterSeconds: number;
  /** Daily API-equivalent USD limits per agent or "all"; at 80% codemax warns, at 100% it offers a handoff. */
  budgets: Partial<Record<AgentId | "all", number>>;
  /** Send a message to another agent when it matches: [{ "match": "^review", "agent": "codex" }]. */
  routes: { match: string; agent: AgentId }[];
  /** Snapshot the working tree before every turn so /undo can revert it. */
  checkpoints: boolean;
  /** Refresh the public price list weekly for /usage (set false to stay offline). */
  priceUpdates: boolean;
  /** Colour theme: "auto" follows the terminal's background, or force "dark" / "light". */
  theme: "auto" | "dark" | "light";
  /**
   * Handoff size. `resumeChars` bounds the resume packet (task, plan, steps, code diff);
   * the others bound the older turn-summary brief used when there is no step journal.
   */
  brief: { turns: number; maxChars: number; turnChars: number; resumeChars: number };
}

export const DEFAULT_CONFIG: Config = {
  order: ["claude", "codex", "opencode", "cursor", "grok", "gemini", "copilot"],
  hotkeys: ["ctrl+/", "ctrl+^"],
  autoSwitch: true,
  agentArgs: {},
  priceUpdates: true,
  budgets: {},
  routes: [],
  checkpoints: true,
  summarizeOnSwitch: true,
  bellAfterSeconds: 20,
  theme: "auto",
  brief: { turns: 10, maxChars: 8000, turnChars: 1200, resumeChars: 24000 },
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
      budgets: { ...(raw.budgets ?? {}) },
      routes: Array.isArray(raw.routes) ? raw.routes : [],
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** Write one setting back to config.json, leaving every other key as the user wrote it. */
export function saveConfigKey<K extends keyof Config>(key: K, value: Config[K]) {
  ensureDir(CODEMAX_HOME);
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return; // unreadable config: do not overwrite what the user wrote
  }
  raw[key] = value;
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
}

export function hotkeyLabel(hotkeys: string[]): string {
  return hotkeys.map((h) => h.replace(/^ctrl\+/i, "Ctrl+")).join(" or ");
}

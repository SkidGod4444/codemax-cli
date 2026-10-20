import { fmtTime12 } from "../core/time.ts";
/**
 * Glyphs and colours. The codemax brand theme: pink is the accent and nothing
 * else, plum is the one dark ink, and warnings, errors and success keep their
 * own hues so they never blur into the brand colour.
 *
 * Two palettes, picked at startup from the terminal's background (OSC 11, via
 * OpenTUI) or the `theme` config: "auto" | "dark" | "light". Every coloured
 * surface sets its own text colour too, so nothing relies on the terminal's
 * default foreground against a painted background.
 */
export const G = {
  prompt: "❯",
  bullet: "⏺",
  nest: "⎿",
  // Claude Code's frames, played forwards then back.
  spinner: ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"],
  done: "✻",
  thought: "∴",
  todo: "◻",
  doing: "◼",
  done_: "✔",
  modeOn: "⏵⏵",
  modeAsk: "⏵",
  modePause: "⏸",
  rule: "─",
} as const;

export type ThemeName = "dark" | "light";

export interface Palette {
  /** Brand pink: prompt glyph, borders, selected rows, links, inline code. */
  accent: string;
  /** Assistant `⏺` bullet. */
  assistant: string;
  /** Tool-call `⏺` bullet. */
  tool: string;
  ok: string;
  warn: string;
  error: string;
  /** Plan mode indicator. */
  plan: string;
  dim: string;
  /** Chrome: `⎿`, rules, disabled rows. */
  dimmer: string;
  /** Overlay (palette) background and its text. */
  panel: string;
  panelText: string;
  panelDim: string;
  /** Selected row inside an overlay. */
  selBg: string;
  selFg: string;
  /** Diff +/- signs and line text. */
  diffAdd: string;
  diffDel: string;
  /** Full-width background bands of added / removed lines, and of the words that changed in them. */
  diffAddBg: string;
  diffDelBg: string;
  diffAddWord: string;
  diffDelWord: string;
  /** Inline `code` and code without a known language (Claude Code's lavender). */
  code: string;
  /** Links. */
  link: string;
  /** The band behind your own messages. */
  userBg: string;
  /** The lines above and below the prompt (pink only in "!" shell mode). */
  promptBorder: string;
  /** Code highlighting, by highlight.js class (Monokai Extended dark, GitHub light, as Claude Code). */
  syntax: Record<string, string>;
  /** Reasoning text. */
  thought: string;
  /** Terminal default foreground. */
  text: string | undefined;
}

const DARK: Palette = {
  accent: "#ff5c8d",
  assistant: "#ffc3d6",
  tool: "#ff4f86",
  ok: "#4ade80",
  warn: "#fbbf24",
  error: "#f87171",
  plan: "#67e8f9",
  dim: "#9ca3af",
  dimmer: "#4b5563",
  panel: "#2a0a1b",
  panelText: "#ffe4ee",
  panelDim: "#b88a9f",
  selBg: "#ff5c8d",
  selFg: "#3a0d25",
  diffAdd: "#50c850",
  diffDel: "#dc5a5a",
  diffAddBg: "#225c2b",
  diffDelBg: "#7a2936",
  diffAddWord: "#38a660",
  diffDelWord: "#b3596b",
  code: "#b1b9f9",
  link: "#6cb6ff",
  userBg: "#373737",
  promptBorder: "#888888",
  syntax: {
    keyword: "#f92672", operator: "#f92672", storage: "#66d9ef", built_in: "#a6e22e", type: "#a6e22e", title: "#a6e22e",
    literal: "#be84ff", number: "#be84ff", symbol: "#be84ff", string: "#e6db74", regexp: "#e6db74", params: "#fd971f",
    comment: "#75715e", meta: "#75715e", variable: "#ffffff", property: "#ffffff", attr: "#a6e22e", punctuation: "#f8f8f2",
  },
  thought: "#b88a9f",
  text: undefined,
};

const LIGHT: Palette = {
  accent: "#e23571",
  assistant: "#3a0d25",
  tool: "#ec3570",
  ok: "#15803d",
  warn: "#b45309",
  error: "#c81e1e",
  plan: "#0e7490",
  dim: "#6b7280",
  dimmer: "#c9bcc3",
  panel: "#fff0f5",
  panelText: "#3a0d25",
  panelDim: "#8a6a7a",
  selBg: "#ffc3d6",
  selFg: "#3a0d25",
  diffAdd: "#248a3d",
  diffDel: "#cf222e",
  diffAddBg: "#69db7c",
  diffDelBg: "#ffa8b4",
  diffAddWord: "#2f9d44",
  diffDelWord: "#d1454b",
  code: "#5769f7",
  link: "#0b5cd5",
  userBg: "#f0f0f0",
  promptBorder: "#999999",
  syntax: {
    keyword: "#a71d5d", operator: "#a71d5d", storage: "#a71d5d", built_in: "#0086b3", type: "#0086b3", title: "#795da3",
    literal: "#0086b3", number: "#0086b3", symbol: "#0086b3", string: "#183691", regexp: "#183691", params: "#0086b3",
    comment: "#969896", meta: "#969896", variable: "#0086b3", property: "#0086b3", attr: "#795da3", punctuation: "#333333",
  },
  thought: "#8a6a7a",
  text: undefined,
};

/** The live palette. Read at render time; `applyTheme` swaps it in place. */
export const C: Palette = { ...DARK };
export let THEME: ThemeName = "dark";

export function applyTheme(mode: ThemeName) {
  Object.assign(C, mode === "light" ? LIGHT : DARK);
  THEME = mode;
}

export const VERBS = ["Thinking", "Pondering", "Brewing", "Weaving", "Crunching", "Sketching", "Tinkering", "Composing", "Mulling", "Noodling", "Percolating", "Assembling"];
export const DONE_VERBS = ["Worked", "Cooked", "Crunched", "Pondered", "Tinkered", "Composed"];
export function pick<T>(arr: readonly T[], seed = Date.now()): T {
  return arr[seed % arr.length]!;
}

/** Footer wording per permission mode, matching Claude Code's indicator style. */
export function modeLabel(agent: string, modeId: string | undefined): { glyph: string; text: string; color: string } {
  switch (modeId) {
    case "acceptEdits":
      return { glyph: G.modeOn, text: "accept edits on", color: C.accent };
    case "plan":
      return { glyph: G.modePause, text: "plan mode on", color: C.plan };
    case "bypassPermissions":
    case "never":
      return { glyph: G.modeOn, text: "bypass permissions on", color: C.error };
    case "dontAsk":
      return { glyph: G.modeOn, text: "don't ask on", color: C.error };
    case "auto":
      return { glyph: G.modeOn, text: "auto mode on", color: C.warn };
    case "ask":
      return { glyph: G.modePause, text: "ask mode · no edits", color: C.plan };
    case "on-request":
    case "default":
    default:
      return { glyph: G.modeAsk, text: "asks before acting", color: C.dim };
  }
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

/** 12-hour, always ("7:25 PM"). */
export function fmtTime(ts: number): string {
  return fmtTime12(ts);
}

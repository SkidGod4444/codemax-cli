/** Glyphs and colours. Mostly terminal defaults, dim chrome, one accent — the Claude Code feel. */
export const G = {
  prompt: "❯",
  bullet: "⏺",
  nest: "⎿",
  spinner: ["✻", "✶", "✳", "✢", "·", "✽"],
  done: "✻",
  modeOn: "⏵⏵",
  modeAsk: "⏵",
  modePause: "⏸",
  rule: "─",
} as const;

export const C = {
  dim: "#6b7280",
  dimmer: "#4b5563",
  accent: "#60a5fa",
  warn: "#fbbf24",
  error: "#f87171",
  ok: "#34d399",
  panel: "#0f172a",
  text: undefined as string | undefined, // terminal default foreground
} as const;

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
      return { glyph: G.modePause, text: "plan mode on", color: C.warn };
    case "bypassPermissions":
    case "never":
      return { glyph: G.modeOn, text: "bypass permissions on", color: C.error };
    case "dontAsk":
      return { glyph: G.modeOn, text: "don't ask on", color: C.error };
    case "auto":
      return { glyph: G.modeOn, text: "auto mode on", color: C.accent };
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

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

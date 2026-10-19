export const ESC = "\x1b";
export const CSI = `${ESC}[`;

/**
 * Put the host terminal back into a sane state after an agent TUI dies.
 * Agents killed mid-run do not restore anything, so undo every mode a modern
 * TUI may have switched on: alt screen, mouse, bracketed paste, focus events,
 * synchronized output, the kitty keyboard protocol and xterm modifyOtherKeys.
 */
export const RESET_SEQ = [
  `${CSI}?2004l`, // bracketed paste off
  `${CSI}?1000l${CSI}?1002l${CSI}?1003l${CSI}?1005l${CSI}?1006l${CSI}?1015l`, // mouse tracking off
  `${CSI}?1004l`, // focus events off
  `${CSI}?2026l`, // synchronized output off
  `${CSI}<u${CSI}<u${CSI}<u${CSI}<u`, // pop kitty keyboard flags (no-op where unsupported)
  `${CSI}=0;1u`, // kitty keyboard flags = 0
  `${CSI}>4;0m`, // xterm modifyOtherKeys off
  `${CSI}?1l`, // normal cursor keys
  `${ESC}>`, // numeric keypad
  `${CSI}?1049l`, // leave alt screen
  `${CSI}!p`, // DECSTR soft reset (scroll region, origin mode, SGR, cursor visible)
  `${CSI}r`, // scroll region = full screen
  `${CSI}?25h`, // show cursor
  `${CSI}?7h`, // autowrap on
  `${CSI}0m`, // reset attrs
].join("");

/** Clear the screen and home the cursor; used before a new agent draws. */
export const CLEAR_SEQ = `${CSI}2J${CSI}H`;

export const ALT_ON = `${CSI}?1049h${CSI}?25l${CSI}H${CSI}2J`;
export const ALT_OFF = `${CSI}?25h${CSI}?1049l`;

export const PASTE_START = `${CSI}200~`;
export const PASTE_END = `${CSI}201~`;

export function stripAnsi(s: string): string {
  // CSI, OSC, and single-char escapes.
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

export function termSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

export const out = (s: string) => {
  process.stdout.write(s);
};

/**
 * Text from an agent, made safe to put on screen: escape sequences (colours, but also OSC 52
 * clipboard writes, title changes, cursor moves) and other control characters are removed;
 * newlines and tabs stay. Applied to every string in an engine event before it is shown.
 */
export function safeText(s: string): string {
  if (!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s)) return s;
  return stripAnsi(s).replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Every string in a value, through safeText (objects and arrays are copied, not changed). */
export function safeDeep<T>(v: T, depth = 0): T {
  if (typeof v === "string") return safeText(v) as T;
  if (!v || typeof v !== "object" || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => safeDeep(x, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = safeDeep(x, depth + 1);
  return out as T;
}

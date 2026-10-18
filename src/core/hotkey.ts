/**
 * Hotkeys arrive in different encodings depending on the terminal and on
 * whether the agent TUI enabled an enhanced keyboard protocol:
 *   legacy        single control byte (Ctrl+/ → 0x1f)
 *   CSI u         ESC [ <codepoint> ; <mods> u   (kitty protocol; Warp, Ghostty, Kitty, WezTerm, iTerm2)
 *   modifyOtherKeys  ESC [ 27 ; <mods> ; <codepoint> ~   (xterm)
 * A hotkey name like "ctrl+/" expands to every encoding we know for it.
 */

const CTRL = 5; // modifier bitmask value for ctrl (1 + 4)
const CTRL_SHIFT = 6;

const LEGACY: Record<string, number> = {
  "/": 0x1f, _: 0x1f, "^": 0x1e, "]": 0x1d, "\\": 0x1c, "[": 0x1b, " ": 0x00, "@": 0x00,
};
/** Keys reached with shift on US layouts: the terminal may report the unshifted key + shift. */
const SHIFTED: Record<string, string> = { _: "-", "^": "6", "@": "2", "?": "/" };

export interface HotkeySpec {
  name: string;
  patterns: Uint8Array[];
}

export function parseHotkey(name: string): HotkeySpec {
  const n = name.trim().toLowerCase();
  const m = n.match(/^ctrl\+(.)$/);
  if (!m) throw new Error(`unsupported hotkey "${name}" (use ctrl+<key>, e.g. ctrl+/ or ctrl+^)`);
  const key = m[1]!;
  const enc = new TextEncoder();
  const pats: Uint8Array[] = [];
  const legacy = key in LEGACY ? LEGACY[key] : key >= "a" && key <= "z" ? key.charCodeAt(0) - 96 : undefined;
  if (legacy !== undefined) pats.push(new Uint8Array([legacy]));
  const cp = key.charCodeAt(0);
  pats.push(enc.encode(`\x1b[${cp};${CTRL}u`), enc.encode(`\x1b[27;${CTRL};${cp}~`));
  const base = SHIFTED[key];
  if (base) {
    const b = base.charCodeAt(0);
    pats.push(enc.encode(`\x1b[${b};${CTRL_SHIFT}u`), enc.encode(`\x1b[27;${CTRL_SHIFT};${b}~`), enc.encode(`\x1b[${cp};${CTRL_SHIFT}u`));
  }
  return { name: `ctrl+${key}`, patterns: pats };
}

export function parseHotkeys(names: string[]): HotkeySpec[] {
  return names.map(parseHotkey);
}

/** Find the first hotkey occurrence in an input chunk. */
export function findHotkey(bytes: Uint8Array, specs: HotkeySpec[]): { index: number; length: number; name: string } | null {
  let best: { index: number; length: number; name: string } | null = null;
  for (const s of specs) {
    for (const p of s.patterns) {
      const i = indexOfSeq(bytes, p);
      if (i >= 0 && (!best || i < best.index || (i === best.index && p.length > best.length))) best = { index: i, length: p.length, name: s.name };
    }
  }
  return best;
}

function indexOfSeq(hay: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 1) return hay.indexOf(needle[0]!);
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Human-readable dump of raw input bytes, for `codemax keys`. */
export function describeBytes(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const printable = [...bytes]
    .map((b) => (b === 0x1b ? "ESC" : b < 0x20 ? `^${String.fromCharCode(b + 64)}` : b === 0x7f ? "DEL" : String.fromCharCode(b)))
    .join(" ");
  return `${hex.padEnd(24)} ${printable}`;
}

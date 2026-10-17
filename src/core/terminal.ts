export const ESC = "\x1b";
export const CSI = `${ESC}[`;

/** Put the host terminal back into a sane state after an agent TUI dies. */
export const RESET_SEQ = [
  `${CSI}?2004l`, // bracketed paste off
  `${CSI}?1000l${CSI}?1002l${CSI}?1003l${CSI}?1006l`, // mouse tracking off
  `${CSI}?1004l`, // focus events off
  `${CSI}?2026l`, // synchronized output off
  `${CSI}?1049l`, // leave alt screen
  `${CSI}?25h`, // show cursor
  `${CSI}0m`, // reset attrs
  `${ESC}>`, // normal keypad
  `${CSI}?7h`, // autowrap on
].join("");

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

import type { AgentId, QuotaStatus } from "../adapters/types.ts";
import { stripAnsi } from "./terminal.ts";

export const GENERIC_QUOTA_PATTERNS = [
  /too many requests/i,
  /quota (has been )?exceeded/i,
  /insufficient[_ ]quota/i,
  /usage limit (reached|exceeded)/i,
  /\b429\b.*(rate|limit)/i,
];

/**
 * Scans the ANSI-stripped PTY output of one agent for quota exhaustion text.
 * Keeps a small rolling buffer so matches spanning chunks are still found.
 */
export class OutputScanner {
  private buf = "";
  private lastHit = 0;
  constructor(
    private agent: AgentId,
    private patterns: RegExp[],
    private onHit: (q: QuotaStatus) => void,
    private debounceMs = 60_000,
  ) {}

  feed(chunk: string) {
    this.buf = (this.buf + stripAnsi(chunk)).slice(-4096);
    if (Date.now() - this.lastHit < this.debounceMs) return;
    for (const re of [...this.patterns, ...GENERIC_QUOTA_PATTERNS]) {
      const m = this.buf.match(re);
      if (m) {
        this.lastHit = Date.now();
        this.onHit({ agent: this.agent, exhausted: true, source: "output", detail: m[0].slice(0, 120), at: Date.now() });
        this.buf = "";
        return;
      }
    }
  }
}

export function quotaLabel(q?: QuotaStatus): string {
  if (!q) return "";
  if (q.exhausted) {
    const reset = q.resetsAt ? ` until ${new Date(q.resetsAt).toLocaleTimeString()}` : "";
    return `EXHAUSTED${reset}`;
  }
  if (typeof q.usedPercent === "number") return `${Math.round(q.usedPercent)}% used`;
  return "";
}

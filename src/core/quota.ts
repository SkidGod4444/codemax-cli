import type { AgentId, QuotaStatus } from "../adapters/types.ts";
import { stripAnsi } from "./terminal.ts";
import { fmtTime12 } from "./time.ts";

/**
 * Vendor-neutral phrases. Deliberately narrow: "rate limit" or "429" alone
 * show up constantly in normal coding work and must not trip the detector.
 */
export const GENERIC_QUOTA_PATTERNS = [/usage limit (reached|exceeded)/i, /you['’]ve (hit|reached) your (usage |weekly |session |daily )?limit/i, /insufficient[_ ]quota/i];

/** How long an output-text detection counts before it is forgotten. */
export const OUTPUT_DETECTION_TTL_MS = 30 * 60_000;

export function isExhausted(q?: QuotaStatus, now = Date.now()): boolean {
  if (!q?.exhausted) return false;
  return !q.expiresAt || q.expiresAt > now;
}

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
        this.onHit({ agent: this.agent, exhausted: true, source: "output", detail: `text match: "${m[0].slice(0, 80)}"`, at: Date.now(), expiresAt: Date.now() + OUTPUT_DETECTION_TTL_MS });
        this.buf = "";
        return;
      }
    }
  }
}

export function quotaLabel(q?: QuotaStatus): string {
  if (!q) return "";
  if (isExhausted(q)) {
    const reset = q.resetsAt ? ` until ${fmtTime12(q.resetsAt)}` : "";
    return q.source === "output" ? `exhausted? (text match)${reset}` : `EXHAUSTED${reset}`;
  }
  if (typeof q.usedPercent === "number") return `${Math.round(q.usedPercent)}% used`;
  return "";
}

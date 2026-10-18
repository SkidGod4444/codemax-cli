import type { ErrorKind } from "./types.ts";

/**
 * Wording agents use when a subscription runs out. Claude Code says "You've hit
 * your session limit · resets 3pm" or "Claude AI usage limit reached"; Codex
 * "You've hit your usage limit"; Grok "free-usage-exhausted" / 429.
 */
const QUOTA = /usage limit|session limit|weekly limit|daily limit|monthly limit|hit your limit|limit reached|limit · resets|out of (credits|quota)|quota|rate.?limit|too many requests|\b429\b|insufficient|usage[-_ ]exhausted|credits? (exhausted|depleted)/i;
const AUTH = /\bauth|login|unauthori[sz]ed|\b401\b|not logged in/i;

/** The human part of an agent error: drops "Internal error" and unwraps {"details": "..."} / {"message": "..."}. */
export function cleanError(text: string): string {
  const m = text.match(/"(?:details|message)"\s*:\s*"((?:[^"\\]|\\.)+)"/);
  const inner = m ? m[1]!.replace(/\\"/g, '"') : text;
  return inner.replace(/^\s*(internal error|error)[:\s]*/i, "").trim() || text.trim();
}

export function classifyError(text: string): ErrorKind {
  if (QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  return "protocol";
}

/**
 * A whole reply that is only a limit notice (some agents end the turn normally
 * and put the notice in the message instead of raising an error).
 */
export function isLimitNotice(reply: string): boolean {
  const t = reply.trim();
  return t.length > 0 && t.length < 400 && /^(you've|you have) (hit|reached) your (session|usage|weekly|daily|monthly)? ?limit|^claude ai usage limit reached|^(session|usage|weekly) limit (reached|hit)/i.test(t);
}

/** "resets 3pm", "resets 6:30 pm", "resets at 15:00" → next such time, as epoch ms. */
export function parseResetTime(text: string, now = new Date()): number | undefined {
  const m = text.match(/resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

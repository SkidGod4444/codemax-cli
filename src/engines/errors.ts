import type { ErrorKind } from "./types.ts";

/**
 * Wording agents use when a subscription runs out. Claude Code says "You've hit
 * your session limit · resets 3pm" or "Claude AI usage limit reached"; Codex
 * "You've hit your usage limit"; Grok "free-usage-exhausted" / 429.
 */
// Specific wording only: "insufficient permissions", "context window limit reached" or a stray
// "429" in some tool's error are not a subscription running out.
// Also a plan that stopped paying for the work: Cursor's "Upgrade your plan to continue",
// OpenCode's "Model access is denied due to INVALID_PAYMENT_INSTRUMENT", credits gone.
const QUOTA = /usage limit|session limit|weekly limit|daily limit|monthly limit|hit your limit|limit · resets|out of (credits|quota|(fast |premium )?requests)|quota (exceeded|exhausted)|exceeded your (current )?quota|rate.?limit|too many requests|insufficient (credits|quota|balance|funds)|usage[-_ ]exhausted|credits? (exhausted|depleted)|credit balance is too low|upgrade (your plan|your subscription|to (pro|continue))|plan to continue|invalid_payment|payment (instrument|method) (is )?(required|invalid|declined)|valid payment instrument|subscription (has )?(expired|lapsed|inactive|required)/i;
const AUTH = /\/login\b|authenticat|\bauth(entication)? required|\blog ?in (required|again|to)|login required|unauthori[sz]ed|\b401\b|not logged in|sign in (required|again|to)/i;

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
const LIMIT_REPLY = /^(you've|you have) (hit|reached) your (session|usage|weekly|daily|monthly)? ?limit|^claude ai usage limit reached|^(session|usage|weekly) limit (reached|hit)|^upgrade your plan to continue|^you('ve| have) (run out of|used all your) (fast |premium )?requests/i;

/**
 * A reply that is the agent's plan running out: the whole reply, or its last short paragraph
 * (Cursor ends a turn with "Upgrade your plan to continue" after some work).
 */
export function isLimitNotice(reply: string): boolean {
  const t = reply.trim();
  if (!t) return false;
  if (t.length < 400 && LIMIT_REPLY.test(t)) return true;
  const last = t.split(/\n\s*\n/).at(-1)!.trim();
  return last.length < 200 && /^upgrade your plan to continue|^(you've|you have) (hit|reached) your .{0,20}limit/i.test(last);
}

/**
 * A reply that is only the agent saying it cannot work at all, such as Antigravity's
 * "The MCP server 'x' failed to initialize: … to continue." It refuses every turn
 * until its own setup is fixed, so it is no answer and the task should go elsewhere.
 */
export function agentSetupFailure(reply: string): { mcpServer: string; reason: string } | null {
  const m = reply.trim().match(/^The MCP server '([^']+)' failed to initialize:\s*([\s\S]{0,600}?)(?:\.?\s*Fix the MCP server|$)/);
  return m ? { mcpServer: m[1]!, reason: m[2]!.trim() } : null;
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

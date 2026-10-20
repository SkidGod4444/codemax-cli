import { isNewer } from "./update.ts";

/**
 * What each release added or removed, in a few words, shown for 5 seconds after `/update`
 * restarts codemax (never in the chat). Releasing adds an entry for the new version here:
 * at most 4 lines, each under 70 characters, user-facing (what you get, not how).
 */
export const WHATS_NEW: Record<string, string[]> = {
  "0.1.13": [
    "Colour themes: Claude Code, Ocean, Teal, Mono (/theme)",
    "Usage limit warnings on the prompt, agent warnings shown",
    "Usage from the agents' own figures (old logs cleared once)",
    "Full-screen /resume list; type while an agent asks permission",
  ],
  "0.1.12": [
    "Claude Code style prompt area and pinned task list",
    "Antigravity /model shows the models only its app can use",
    "33 bug fixes",
  ],
  "0.1.11": ["Transcript looks like Claude Code's", "Ctrl+G editor, /copy, /export"],
  "0.1.10": ["/debate: agents argue out a plan", "Feature tips in the prompt; keep-awake keeps the screen on"],
};

/** Lines for every release after `from` up to `to`, newest first; `from` unknown: just `to`'s. At most `max` lines. */
export function whatsNew(to: string, from?: string, max = 6): { version: string; lines: string[] }[] {
  const versions = Object.keys(WHATS_NEW)
    .filter((v) => !isNewer(v, to) && (from ? isNewer(v, from) : v === to))
    .sort((a, b) => (isNewer(a, b) ? -1 : 1));
  const out: { version: string; lines: string[] }[] = [];
  let left = max;
  for (const v of versions) {
    if (left <= 0) break;
    const lines = WHATS_NEW[v]!.slice(0, left);
    out.push({ version: v, lines });
    left -= lines.length;
  }
  return out;
}

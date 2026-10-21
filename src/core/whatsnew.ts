import { isNewer } from "./update.ts";

/**
 * What each release added or removed, in a few words, shown for 5 seconds after `/update`
 * restarts codemax (never in the chat). Releasing adds an entry for the new version here:
 * at most 4 lines, each under 70 characters, user-facing (what you get, not how).
 */
export const WHATS_NEW: Record<string, string[]> = {
  "0.1.18": [
    "MCP sign-in opens the browser (/mcp → Authenticate), Claude and Codex",
    "Tables drawn as boxes; code spans in your own messages",
    "Quieter start: the model on the session line, fewer notes",
    "OpenCode and Cursor todo lists land in the pinned task list",
  ],
  "0.1.17": [
    "/mcp: servers with status; ↑↓ + Enter to reconnect or disable",
    "Cursor's plan limit mid-task hands off; the work done is kept",
  ],
  "0.1.16": [
    "Every agent gets the others' MCP servers, skills and plugin skills",
    "Ctrl+Enter sends now; Ctrl+T folds the task list; /restart",
    "Questions notify you in any window; Cursor's plan limit hands off",
    "Tab completes / commands; Cursor's modes named right",
  ],
  "0.1.15": [
    "Queued messages never get lost; side-agent notes wait their turn",
    "Ctrl+C twice quits at once",
    "A friendlier start card, with news and a hello",
    "Always runs on a current Bun; the debug log catches lag and lost keys",
  ],
  "0.1.14": [
    "Smoother typing while agents stream long code replies",
    "Faster / and @file pickers, even in big projects",
    "Debug log (on by default, never your chat): /debug export",
  ],
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

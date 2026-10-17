import type { Config } from "../config.ts";
import type { AgentId, Turn } from "../adapters/types.ts";
import { diffStat, headLine, recentCommits } from "./git.ts";
import { BRIEF_MARKER, type Ledger } from "./ledger.ts";

export interface BriefInput {
  ledger: Ledger;
  cwd: string;
  to: AgentId;
  from?: AgentId;
  reason?: string;
  config: Config;
}

/** Build the handoff prompt the next agent starts with. Bounded by config.brief. */
export async function buildBrief(input: BriefInput): Promise<string> {
  const { ledger, cwd, to, from, reason, config } = input;
  const { turns: maxTurns, maxChars, turnChars } = config.brief;

  const all = ledger.turns();
  const recent = all.slice(-maxTurns);
  const agentsUsed = [...new Set(all.map((t) => t.agent))].filter((a) => a !== to);
  const lastUser = [...all].reverse().find((t) => t.role === "user");

  const lines: string[] = [];
  lines.push(BRIEF_MARKER);
  lines.push(
    `You are continuing an existing coding session in this repository${
      from ? ` that was being handled by ${from}` : ""
    }${reason ? ` (${reason})` : ""}. ` +
      "The user has not changed; only the agent has. Read the context below, then continue from where it left off. " +
      "Do not redo completed work. If the last task looks finished, briefly confirm and ask what is next.",
  );
  lines.push("");
  lines.push(`Repo: ${await headLine(cwd)}`);
  if (agentsUsed.length) lines.push(`Previous agents on this project: ${agentsUsed.join(", ")}`);

  const summary = ledger.summary();
  if (summary) {
    lines.push("", "## Project summary", summary);
  }

  if (recent.length) {
    lines.push("", `## Recent conversation (oldest first, last ${recent.length} turns)`);
    for (const t of recent) lines.push(formatTurn(t, turnChars));
  } else {
    lines.push("", "## Recent conversation", "(no prior turns recorded)");
  }

  const commits = await recentCommits(cwd, 5);
  if (commits) lines.push("", "## Recent commits", commits);

  lines.push("", "## Uncommitted changes", await diffStat(cwd));

  if (lastUser) {
    lines.push("", "## Last user request", quote(lastUser.text, turnChars));
  }

  return clamp(lines.join("\n"), maxChars);
}

function formatTurn(t: Turn, max: number): string {
  const who = t.role === "user" ? "USER" : `ASSISTANT (${t.agent})`;
  const tools = t.tools?.length ? ` [tools: ${t.tools.join(", ")}]` : "";
  return `${who}${tools}: ${truncate(t.text.replace(/\s+/g, " ").trim(), max)}`;
}

function quote(s: string, max: number): string {
  return truncate(s.trim(), max);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  // Keep head and tail; the tail holds diff + last request which matter most.
  const head = Math.floor(max * 0.55);
  const tail = max - head - 20;
  return s.slice(0, head) + "\n…[truncated]…\n" + s.slice(-tail);
}

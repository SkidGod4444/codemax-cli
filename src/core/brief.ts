import type { Config } from "../config.ts";
import type { AgentId, Turn } from "../adapters/types.ts";
import { diffStat, headLine, recentCommits } from "./git.ts";
import { checkpointDiff } from "./checkpoint.ts";
import { BRIEF_MARKER, type Ledger } from "./ledger.ts";
import type { Step, StepOf } from "./journal.ts";
import { fmtTime12 } from "./time.ts";

export interface BriefInput {
  ledger: Ledger;
  cwd: string;
  to: AgentId;
  from?: AgentId;
  reason?: string;
  config: Config;
  /** "takeover" (default): the agent continues the task. "context": a one-off question (/ask, routes) that must not take the task over. */
  purpose?: "takeover" | "context";
}

/**
 * The handoff prompt the next agent starts with. With a step journal this is a
 * resume packet: the task, where and why the last agent stopped (including the
 * step in flight), the plan, every step taken, and the real code diff since the
 * task began. Without one (an older ledger) it falls back to a turn summary.
 */
export async function buildBrief(input: BriefInput): Promise<string> {
  const steps = input.ledger.journal.steps();
  if (steps.some((s) => s.kind === "user")) return buildResumePacket(input, steps);
  return buildTurnBrief(input);
}

// ---------------------------------------------------------------- resume packet

export async function buildResumePacket(input: BriefInput, steps: Step[]): Promise<string> {
  const { ledger, cwd, to, from, reason, config } = input;
  const budget = config.brief.resumeChars;
  const task = ledger.journal.task(steps);
  const workSteps = task.steps.filter((s) => s.kind !== "user" || s !== task.request);
  const lastEnd = [...task.steps].reverse().find((s): s is StepOf<"end"> => s.kind === "end");
  const plan = [...task.steps].reverse().find((s): s is StepOf<"plan"> => s.kind === "plan");
  const unfinishedPlan = plan?.entries.some((e) => e.status !== "completed");
  const stoppedAgent = lastEnd?.agent ?? from;
  // A rewind after the last turn undid work: whatever that turn finished is not done any more.
  const rewound = task.steps.at(-1)?.kind === "rewind";
  const inProgress = !lastEnd || lastEnd.outcome !== "done" || !!unfinishedPlan || rewound;
  const context = input.purpose === "context";

  const head: string[] = [BRIEF_MARKER];
  if (context)
    head.push(
      "Context only: this is the current state of a coding task in this repository, recorded by codemax while other agents worked on it. " +
        "Do not take the task over, and do not change files unless the message at the end asks you to. Answer only that message.",
    );
  else head.push(
    `You are taking over a coding task in this repository${stoppedAgent ? ` from ${stoppedAgent}` : ""}${reason ? ` (${reason})` : ""}. ` +
      "Same user, same repo; only the agent changed. " +
      (inProgress
        ? "Resume exactly where it stopped: do not restart and do not redo finished steps. First check the step that was in flight (if any) actually happened, then continue the plan."
        : "The last task looks finished. Confirm that briefly and ask the user what is next; do not redo the work."),
  );
  head.push("", `Repo: ${await headLine(cwd)}`);

  head.push("", "## The task", quoteBlock(task.request?.text ?? "(no request recorded)"));
  for (const f of task.followUps) head.push("", "Follow-up from the user:", quoteBlock(f.text));

  if (lastEnd || stoppedAgent) head.push("", "## Where it stopped", ...whereItStopped(task.steps, lastEnd));

  if (plan) {
    head.push("", "## Plan (latest)");
    let marked = false;
    for (const e of plan.entries) {
      const box = e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]";
      const next = !context && !marked && e.status !== "completed" ? "  ← continue here" : "";
      if (next) marked = true;
      head.push(`${box} ${e.content}${next}`);
    }
  }

  const fixed = head.join("\n");
  let room = Math.max(2000, budget - fixed.length);

  // The real code change since the task began: what the next agent most needs to see.
  const diff = await taskDiff(cwd, task.request?.checkpoint);
  const diffBudget = Math.floor(room * 0.45);
  const diffPart = diff.text ? ["", `## Code changes since the task started${diff.vs ? ` (vs snapshot ${diff.vs.slice(0, 8)})` : ""}`, "```diff", cut(diff.text, diffBudget, "diff"), "```"] : ["", "## Code changes since the task started", "(none)"];
  room -= diffPart.join("\n").length;

  // Steps, newest kept first when space is short.
  const stepLines = workSteps.map((s) => formatStep(s)).filter((l): l is string => !!l);
  const stepBudget = Math.floor(room * 0.8);
  const kept: string[] = [];
  let used = 0;
  for (let i = stepLines.length - 1; i >= 0; i--) {
    const l = stepLines[i]!;
    if (used + l.length + 1 > stepBudget) {
      kept.unshift(`… ${i + 1} earlier step${i ? "s" : ""} on this task omitted for space`);
      break;
    }
    kept.unshift(l);
    used += l.length + 1;
  }
  room -= used;
  const stepsPart = kept.length ? ["", `## Steps taken on this task (oldest first)`, ...kept] : [];

  // Earlier conversation, condensed: previous requests and final answers.
  // Earlier tasks from the journal; the old turn list only for history recorded before it existed.
  const preJournal = steps[0] ? ledger.turns().filter((t) => t.ts < steps[0]!.ts) : [];
  const earlier = condensedHistory(task.earlier, preJournal, Math.max(0, Math.min(room, Math.floor(budget * 0.15))));
  const summary = ledger.summary();

  const tail: string[] = [];
  if (earlier) tail.push("", "## Earlier conversation (condensed)", earlier);
  if (summary) tail.push("", "## Project summary", cut(summary, 1500, "summary"));
  const commits = await recentCommits(cwd, 3);
  if (commits) tail.push("", "## Recent commits", commits);
  if (to && !context) tail.push("", `You are ${to}. Continue now.`);

  return [fixed, ...stepsPart, ...diffPart, ...tail].join("\n");
}

/**
 * For an agent whose own session resumes: only what happened while it was away.
 * Returns null when nobody else did anything since its last turn.
 */
export async function buildCatchup(input: BriefInput): Promise<string | null> {
  const { ledger, cwd, to, config } = input;
  const steps = ledger.journal.steps();
  const since = ledger.journal.lastSeen(to, steps);
  if (since === undefined) return null;
  const after = steps.filter((s) => s.ts > since && s.kind !== "handoff");
  // A rewind matters to every agent: one that resumes its own session still remembers the undone work.
  const others = after.filter((s) => (s.agent !== to && s.kind !== "user") || s.kind === "rewind");
  if (!others.length) return null;
  const users = after.filter((s): s is StepOf<"user"> => s.kind === "user");
  const plan = [...after].reverse().find((s): s is StepOf<"plan"> => s.kind === "plan");
  const lastEnd = [...after].reverse().find((s): s is StepOf<"end"> => s.kind === "end");
  const agents = [...new Set(others.map((s) => s.agent))].join(", ");

  const out: string[] = [BRIEF_MARKER];
  out.push(
    `Welcome back. Your own session history is intact. While you were away, ${agents} worked in this repo. ` +
      "Here is only what changed since your last turn. Continue from the current state; do not undo their work unless it is wrong.",
  );
  if (users.length) {
    out.push("", "## New requests from the user");
    for (const u of users) out.push(quoteBlock(u.text));
  }
  if (lastEnd) out.push("", "## Where it stopped", ...whereItStopped(after, lastEnd));
  if (plan) {
    out.push("", "## Plan (latest)");
    for (const e of plan.entries) out.push(`${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content}`);
  }
  const budget = Math.floor(config.brief.resumeChars * 0.6);
  const lines = after.filter((s) => s.agent !== to || s.kind === "user" || s.kind === "rewind").map((s) => formatStep(s)).filter((l): l is string => !!l);
  out.push("", "## What happened (oldest first)", ...lastLines(lines, Math.floor(budget * 0.5)));
  // Diff from the first snapshot taken after this agent stopped: before a user message or a
  // handoff turn (an agent that took over and edited files snapshots first).
  const firstSnapshot = steps.find((s) => s.ts > since && (s.kind === "user" || s.kind === "handoff") && s.checkpoint) as { checkpoint?: string } | undefined;
  const diff = firstSnapshot?.checkpoint ? await checkpointDiff(cwd, firstSnapshot.checkpoint).catch(() => "") : "";
  if (diff) out.push("", "## Code changes while you were away", "```diff", cut(diff, Math.floor(budget * 0.5), "diff"), "```");
  else out.push("", "## Uncommitted changes now", await diffStat(cwd));
  return out.join("\n");
}

function whereItStopped(steps: Step[], end: StepOf<"end"> | undefined): string[] {
  const out: string[] = [];
  if (!end) return ["The last agent had not finished its first turn."];
  const when = fmtTime12(end.ts);
  const why =
    end.outcome === "limit" ? `ran out of its usage limit${end.detail ? ` ("${oneLine(end.detail, 140)}")` : ""}`
    : end.outcome === "cancelled" ? "was interrupted by the user"
    : end.outcome === "error" ? `stopped on an error${end.detail ? `: ${oneLine(end.detail, 200)}` : ""}`
    : "finished its turn";
  out.push(`${end.agent} ${why} at ${when}.`);
  const turnSteps = steps.filter((s) => s.turn === end.turn);
  const tools = new Map(turnSteps.filter((s): s is StepOf<"tool"> => s.kind === "tool").map((t) => [t.id, t]));
  for (const id of end.inFlight ?? []) {
    const t = tools.get(id);
    if (!t) continue;
    out.push(`In flight when it stopped: ${t.title}${t.input ? ` with input ${oneLine(t.input, 400)}` : ""}. No result was recorded, so check whether it ran before continuing.`);
  }
  const lastText = [...turnSteps].reverse().find((s): s is StepOf<"text"> => s.kind === "text");
  if (lastText) out.push(`Its last words: "${oneLine(lastText.text, 500)}"`);
  const lastThought = [...turnSteps].reverse().find((s): s is StepOf<"thought"> => s.kind === "thought");
  if (lastThought && end.outcome !== "done") out.push(`What it was thinking: "${oneLine(lastThought.text, 500)}"`);
  return out;
}

export function formatStep(s: Step): string | null {
  switch (s.kind) {
    case "user":
      return `- USER: ${oneLine(s.text, 600)}`;
    case "text":
      return `- [${s.agent}] said: ${oneLine(s.text, 600)}`;
    case "tool": {
      const status = s.status === "completed" ? "" : ` (${s.status === "failed" ? "FAILED" : s.status === "in_progress" || s.status === "pending" ? "NOT FINISHED" : s.status})`;
      const lines = [`- [${s.agent}] ${s.title}${status}`];
      if (s.input) lines.push(`    input: ${oneLine(s.input, 300)}`);
      if (s.output) lines.push(`    result: ${resultSnippet(s.output)}`);
      return lines.join("\n");
    }
    case "plan":
      return `- [${s.agent}] updated the plan: ${s.entries.map((e) => `${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content}`).join("; ")}`;
    case "end":
      return s.outcome === "done" ? null : `- [${s.agent}] turn ended: ${s.outcome}${s.detail ? ` (${oneLine(s.detail, 160)})` : ""}`;
    case "handoff":
      return `- handed over to ${s.agent}${s.reason ? ` (${s.reason})` : ""}`;
    case "rewind":
      return `- USER rewound the files to before their message "${oneLine(s.text, 200)}": every change made after it is undone; treat that work as not done`;
    case "thought":
      return null;
  }
}

function condensedHistory(earlier: Step[], turns: Turn[], budget: number): string {
  if (budget < 200) return "";
  let lines: string[];
  if (earlier.some((s) => s.kind === "user")) {
    lines = [];
    for (const s of earlier) {
      if (s.kind === "user") lines.push(`USER: ${oneLine(s.text, 400)}`);
      else if (s.kind === "text") {
        // keep only each turn's final words
        const nextSameTurn = earlier.slice(earlier.indexOf(s) + 1).some((x) => x.turn === s.turn && x.kind === "text");
        if (!nextSameTurn) lines.push(`ASSISTANT (${s.agent}): ${oneLine(s.text, 400)}`);
      }
    }
  } else {
    lines = turns.slice(-8).map((t) => `${t.role === "user" ? "USER" : `ASSISTANT (${t.agent})`}: ${oneLine(t.text, 400)}`);
  }
  return lastLines(lines, budget).join("\n");
}

async function taskDiff(cwd: string, checkpoint?: string): Promise<{ text: string; vs?: string }> {
  if (checkpoint) {
    const text = await checkpointDiff(cwd, checkpoint).catch(() => "");
    return { text, vs: checkpoint };
  }
  const p = Bun.spawn(["git", "diff", "--no-color", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
  const text = (await new Response(p.stdout).text()).trimEnd();
  await p.exited;
  return { text };
}

function resultSnippet(output: string): string {
  const lines = output.trim().split("\n");
  if (lines.length <= 6) return lines.join("\n      ");
  return [...lines.slice(0, 3), `… ${lines.length - 6} lines …`, ...lines.slice(-3)].join("\n      ");
}

function lastLines(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i]!.length + 1 > budget) {
      out.unshift(`… ${i + 1} earlier line${i ? "s" : ""} omitted`);
      break;
    }
    out.unshift(lines[i]!);
    used += lines[i]!.length + 1;
  }
  return out;
}

function quoteBlock(s: string): string {
  return s.trim().split("\n").map((l) => `> ${l}`).join("\n");
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

function cut(s: string, max: number, what: string): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… ${what} cut: ${s.length - max} more characters (run git diff to see all)`;
}

// ---------------------------------------------------------------- legacy brief (no journal)

async function buildTurnBrief(input: BriefInput): Promise<string> {
  const { ledger, cwd, to, from, reason, config } = input;
  const { turns: maxTurns, maxChars, turnChars } = config.brief;
  const all = ledger.turns();
  const recent = all.slice(-maxTurns);
  const agentsUsed = [...new Set(all.map((t) => t.agent))].filter((a) => a !== to);
  const lastUser = [...all].reverse().find((t) => t.role === "user");

  const lines: string[] = [];
  lines.push(BRIEF_MARKER);
  lines.push(
    `You are continuing an existing coding session in this repository${from ? ` that was being handled by ${from}` : ""}${reason ? ` (${reason})` : ""}. ` +
      "The user has not changed; only the agent has. Read the context below, then continue from where it left off. " +
      "Do not redo completed work. If the last task looks finished, briefly confirm and ask what is next.",
  );
  lines.push("", `Repo: ${await headLine(cwd)}`);
  if (agentsUsed.length) lines.push(`Previous agents on this project: ${agentsUsed.join(", ")}`);
  const summary = ledger.summary();
  if (summary) lines.push("", "## Project summary", summary);
  if (recent.length) {
    lines.push("", `## Recent conversation (oldest first, last ${recent.length} turns)`);
    for (const t of recent) lines.push(`${t.role === "user" ? "USER" : `ASSISTANT (${t.agent})`}${t.tools?.length ? ` [tools: ${t.tools.join(", ")}]` : ""}: ${truncate(t.text.replace(/\s+/g, " ").trim(), turnChars)}`);
  } else lines.push("", "## Recent conversation", "(no prior turns recorded)");
  const commits = await recentCommits(cwd, 5);
  if (commits) lines.push("", "## Recent commits", commits);
  lines.push("", "## Uncommitted changes", await diffStat(cwd));
  if (lastUser) lines.push("", "## Last user request", truncate(lastUser.text.trim(), turnChars));
  return clamp(lines.join("\n"), maxChars);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.55);
  const tail = max - head - 20;
  return s.slice(0, head) + "\n…[truncated]…\n" + s.slice(-tail);
}

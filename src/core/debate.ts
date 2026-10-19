/**
 * /debate: two or three agents plan the same goal, then argue. Each proposes a plan on its
 * own, then (for each critique round) sees the others' latest plans, attacks their weak
 * points, defends its own where it is right, concedes where another is better, and revises.
 * A judge then merges the strongest parts into one plan and says how each disagreement was
 * settled. Nobody changes files: a debate only plans.
 */

export const DEBATE_MARKER = "[codemax debate]";

export interface Debater {
  name: string;
}

const RULES = "Read whatever code you need, but do not change any file or run anything that changes state: this is planning only (permission requests are refused).";

export function proposalPrompt(goal: string, me: Debater, others: Debater[]): string {
  return [
    `${DEBATE_MARKER} You are ${me.name}, one of ${others.length + 1} agents planning the same goal independently: ${[me, ...others].map((d) => d.name).join(", ")}. The others will challenge your plan, so make it one you can defend.`,
    RULES,
    "",
    "## Goal (from the user)",
    goal,
    "",
    "## Your answer",
    "Your plan as numbered steps, the key decisions and why you made them, the risks and how the plan handles them, and what you would check to know it worked. End with one line: SUMMARY: <the plan in one sentence>.",
  ].join("\n");
}

/** Argument rounds when the debate goes on until the judge is satisfied: never more than this. */
export const UNTIL_SETTLED_MAX = 6;

/** "auto": argue until the judge finds a clearly better plan (UNTIL_SETTLED_MAX rounds at most). */
export type DebateRounds = number | "auto";

export function critiquePrompt(goal: string, me: Debater, plans: { name: string; plan: string }[], round: number, rounds: DebateRounds, focus?: string): string {
  const theirs = plans.filter((p) => p.name !== me.name);
  return [
    `${DEBATE_MARKER} Round ${round + 1}${rounds === "auto" ? ` (the debate goes on until the judge finds the better plan, ${UNTIL_SETTLED_MAX + 1} rounds at most)` : ` of ${rounds + 1}`}. The goal again: ${goal}`,
    RULES,
    ...(focus ? ["", `The judge says these points are still open; argue them first: ${focus}`] : []),
    "",
    ...theirs.flatMap((p) => [`## ${p.name}'s plan`, p.plan, ""]),
    "## Your answer",
    "1. Critique: for each other plan, the concrete flaws, missing steps and risks, with reasons. Be specific and honest; do not be polite for its own sake.",
    "2. Defence: where they would criticise your plan, defend it if you are right, and say plainly where theirs is better.",
    "3. Your revised plan: numbered steps, taking anything better from the others.",
    "End with one line: SUMMARY: <your revised plan in one sentence>.",
  ].join("\n");
}

/**
 * After an argument round of an "until settled" debate: is one plan (or a merge everyone
 * would accept) now clearly better? The judge answers SETTLED, or CONTINUE with what is open.
 */
export function settledPrompt(goal: string, plans: { name: string; plan: string }[], round: number): string {
  return [
    `${DEBATE_MARKER} You will judge this debate. After round ${round + 1}, decide whether it is settled: one plan, or a merge the arguments support, is clearly the better way to reach the goal, and more arguing would not change it.`,
    RULES,
    "",
    "## Goal (from the user)",
    goal,
    "",
    ...plans.flatMap((p) => [`## ${p.name}'s plan now`, p.plan, ""]),
    "## Your answer",
    "The first line is either SETTLED or CONTINUE. After SETTLED, one sentence on why. After CONTINUE, the specific points still in dispute that the next round must settle, in one or two sentences. Nothing else.",
  ].join("\n");
}

/** The judge's call after a round: settled, or the points the next round must argue. */
export function parseSettled(reply: string): { settled: boolean; focus?: string } {
  const t = reply.trim();
  const first = t.split("\n")[0]!.replace(/[*_#`]/g, "").trim();
  if (/^SETTLED\b/i.test(first)) return { settled: true };
  const focus = t.replace(/^[*_#`\s]*CONTINUE[*_`:\s-]*/i, "").trim();
  // Anything but a clear CONTINUE ends the debate: it never loops on an unclear answer.
  return /^[*_#`\s]*CONTINUE\b/i.test(t) ? { settled: false, focus: focus || undefined } : { settled: true };
}

export function judgePrompt(goal: string, plans: { name: string; plan: string }[]): string {
  return [
    `${DEBATE_MARKER} You are now the judge. Be fair to every side, including your own.`,
    RULES,
    "",
    "## Goal (from the user)",
    goal,
    "",
    ...plans.flatMap((p) => [`## ${p.name}'s final plan`, p.plan, ""]),
    "## Your answer",
    "1. Where they agree.",
    "2. Each point of disagreement: the options, which one wins and why.",
    "3. THE PLAN: the final plan as a numbered checklist that an agent can carry out, taking the strongest parts of each.",
    "4. Risks still open, if any.",
  ].join("\n");
}

/** The final plan from the judge's answer (the part after "THE PLAN"), or the whole answer. */
export function finalPlan(verdict: string): string {
  const m = verdict.match(/THE PLAN[^\n]*\n([\s\S]*?)(?:\n#+\s*4\.|\n\*{0,2}4\.\s*Risks|$)/i);
  return (m?.[1] ?? verdict).trim();
}

/**
 * What a debate costs, said before it starts: every debater takes a turn per round (later
 * rounds carry everyone's plans, so they are long), and the judge one more.
 */
export function debateCost(debaters: number, rounds: DebateRounds): string {
  if (rounds === "auto") {
    const most = debaters * (UNTIL_SETTLED_MAX + 1) + UNTIL_SETTLED_MAX + 1;
    return `until the judge finds the better plan: ${debaters * 2 + 2} turns or more, up to ${most} (${UNTIL_SETTLED_MAX} argument rounds at most, each on the debaters' own plans' limits, plus the judge's checks)`;
  }
  const total = debaters * (rounds + 1) + 1;
  return `${total} turns in all: ${rounds + 1} per debater (on its own plan's limit) + 1 for the judge · ${rounds} argument round${rounds === 1 ? "" : "s"}`;
}

/** "2 rounds", "until settled". */
export function roundsLabel(r: DebateRounds): string {
  return r === "auto" ? "until the judge is satisfied" : `${r} argument round${r === 1 ? "" : "s"}`;
}

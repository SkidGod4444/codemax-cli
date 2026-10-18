import type { AgentId } from "../adapters/types.ts";
import type { Step, StepOf } from "./journal.ts";
import { formatStep } from "./brief.ts";

/**
 * The side agent: a second agent (any harness) that reviews the main agent's
 * work after each turn and speaks up only when something deserves the user's
 * attention: drift from the request or plan, claims without evidence, risky
 * assumptions, missing tests. Its notes can be forwarded to the main agent so
 * it stays aligned with the plan, whichever harness it runs on.
 */
export const NO_NOTE = "NO_NOTE";

export function reviewInstructions(mainAgent: string): string {
  return [
    `You are a side agent reviewing the work of another coding agent (${mainAgent}) for the user. You do not do the work yourself.`,
    "Do not use any tools and do not change any files. Read only what is below.",
    "Check the latest work against the user's request and the plan. Look for: drift from what the user asked; conclusions or claims the steps do not actually support; decisions resting on thin evidence (one run, one sample, a check that barely passed); risky assumptions; tests or edge cases that were skipped; work that will be wasted if an untested assumption is wrong.",
    `If nothing is worth interrupting the user for, reply with exactly ${NO_NOTE} and nothing else. Most turns deserve ${NO_NOTE}; do not nitpick style.`,
    "Otherwise reply with one note in exactly this shape, under 130 words, plain language, concrete facts from the work:",
    "",
    "Heads up · <one sentence: what could go wrong>",
    "",
    "**<short title>**",
    "- <fact from the work>",
    "- <why it matters for the user's goal>",
    "- **Consider <one concrete, cheap action>.**",
  ].join("\n");
}

/** What the reviewer sees: the request, the plan, and the main agent's steps since its last review. */
export function buildReviewPrompt(o: { steps: Step[]; since: number; mainAgent: string; reviewer: AgentId; context?: string }): string | null {
  // The reviewer's own turns are never journaled, so every step here is the main agent's,
  // even when both run on the same harness (Claude reviewing Claude).
  const recent = o.steps.filter((s) => s.ts > o.since && s.kind !== "handoff" && s.kind !== "thought");
  const work = recent.filter((s) => s.kind === "tool" || s.kind === "text" || s.kind === "plan");
  if (!work.length) return null;
  const users = o.steps.filter((s): s is StepOf<"user"> => s.kind === "user");
  const request = users.at(-1);
  const plan = [...o.steps].reverse().find((s): s is StepOf<"plan"> => s.kind === "plan");
  const out: string[] = [reviewInstructions(o.mainAgent), ""];
  if (o.context) out.push("## Context (the task so far, recorded by codemax)", o.context, "");
  if (request) out.push("## The user's latest request", request.text.trim().split("\n").map((l) => `> ${l}`).join("\n"), "");
  if (plan) out.push("## Plan", ...plan.entries.map((e) => `${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content}`), "");
  out.push("## Latest work to review (oldest first)", ...recent.map((s) => formatStep(s)).filter((l): l is string => !!l));
  return out.join("\n");
}

/** The note, or null when the reviewer had nothing to say. */
export function parseNote(reply: string): string | null {
  const t = reply.trim();
  if (!t || t.includes(NO_NOTE) || t.length < 40) return null;
  const at = t.indexOf("Heads up");
  return (at > 0 ? t.slice(at) : t).trim();
}

/** Forwarded notes start with this; they are follow-ups, never a new task, and never reviewed. */
export const NOTE_PREFIX = "A side agent (";

export function isForwardedNote(text: string): boolean {
  return text.startsWith(NOTE_PREFIX);
}

/** The message that hands a note to the main agent. */
export function forwardMessage(note: string, reviewerName: string): string {
  return `${NOTE_PREFIX}${reviewerName}) reviewing your work left this note. Weigh it against the user's request and plan: say in a sentence whether you agree, and adjust your work if it is right.\n\n${note}`;
}

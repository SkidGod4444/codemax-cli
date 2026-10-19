import type { Ledger } from "./ledger.ts";
import type { Step, StepOf } from "./journal.ts";
import { fmtDateTime12 } from "./time.ts";

/**
 * A conversation thread as Markdown (/export): each of your messages, what each agent said,
 * the steps it took (tool calls, plans, how its turns ended) and handoffs, oldest first.
 * Threads from before the step journal fall back to the recorded turns.
 */
export function threadMarkdown(ledger: Ledger, agents: { id: string; name: string }[]): string {
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const steps = ledger.journal.steps();
  const out: string[] = [`# codemax conversation ${ledger.threadId}`, "", `${ledger.cwd} · exported ${fmtDateTime12(Date.now())} · resume with \`codemax --resume ${ledger.threadId}\``, ""];
  if (!steps.length) {
    for (const t of ledger.turns()) out.push(t.role === "user" ? `## You · ${fmtDateTime12(t.ts)}` : `### ${name(t.agent)}`, "", t.text.trim(), "");
    return out.join("\n");
  }
  let lastAgent = "";
  for (const s of steps) {
    switch (s.kind) {
      case "user":
        out.push(`## You · ${fmtDateTime12(s.ts)}`, "", s.text.trim(), "");
        lastAgent = "";
        break;
      case "text":
        if (lastAgent !== s.agent) out.push(`### ${name(s.agent)}`, "");
        lastAgent = s.agent;
        out.push(s.text.trim(), "");
        break;
      case "tool":
        if (lastAgent !== s.agent) out.push(`### ${name(s.agent)}`, "");
        lastAgent = s.agent;
        out.push(`- \`${s.title.replace(/`/g, "'")}\`${s.status === "completed" ? "" : ` (${s.status})`}${s.files?.length ? ` · ${s.files.join(", ")}` : ""}`, "");
        break;
      case "plan":
        out.push("Plan:", ...(s as StepOf<"plan">).entries.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`), "");
        break;
      case "end":
        if (s.outcome !== "done") out.push(`_${name(s.agent)}'s turn ended: ${s.outcome}${s.detail ? ` (${s.detail})` : ""}_`, "");
        break;
      case "handoff":
        out.push(`_Handed over to ${name(s.agent)}${s.reason ? ` (${s.reason})` : ""}_`, "");
        lastAgent = "";
        break;
      case "rewind":
        out.push(`_You rewound to before "${s.text}"_`, "");
        break;
      case "thought":
        break;
      default:
        assertNever(s);
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function assertNever(_s: never): void {}

export type { Step };

import { join } from "node:path";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AgentId } from "../adapters/types.ts";

/**
 * The step journal: everything every agent did, as it happened, in
 * ~/.codemax/projects/<project>/journal.jsonl. This is what makes handoffs a
 * resume rather than a summary: the next agent sees the task, the plan, each
 * tool call with its input and result, the step that was in flight when the
 * last agent stopped, and why it stopped.
 *
 * Steps are appended as they happen (a turn cut off by a limit still leaves
 * its trail). A step that changes (a tool finishing) is appended again with
 * the same id; readers keep the last copy.
 */

export type Outcome = "done" | "cancelled" | "limit" | "error";

interface Base {
  id: string;
  ts: number;
  agent: AgentId;
  /** Groups the steps of one agent turn. */
  turn: string;
}

export type Step = Base &
  (
    | { kind: "user"; text: string; checkpoint?: string }
    | { kind: "text"; text: string }
    | { kind: "thought"; text: string }
    | { kind: "tool"; title: string; toolKind?: string; status: string; input?: string; output?: string; files?: string[] }
    | { kind: "plan"; entries: { content: string; status: string }[] }
    | { kind: "end"; outcome: Outcome; detail?: string; inFlight?: string[] }
    | { kind: "handoff"; from?: AgentId; reason?: string; mode: "packet" | "catchup"; chars: number; checkpoint?: string }
  );

export type StepOf<K extends Step["kind"]> = Extract<Step, { kind: K }>;

/** Caps applied when a step is written: enough to resume from, small enough to keep the file sane. */
export const CAP = { text: 6000, thought: 2000, input: 2000, output: 4000 } as const;

export function clip(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length <= max ? s : s.slice(0, Math.floor(max * 0.6)) + `\n…[${s.length - max} chars cut]…\n` + s.slice(-Math.floor(max * 0.4));
}

export class Journal {
  private path: string;

  constructor(dir: string) {
    this.path = join(dir, "journal.jsonl");
  }

  append(step: Step) {
    appendFileSync(this.path, JSON.stringify(step) + "\n");
  }

  /** All steps in order, each at its latest version. */
  steps(): Step[] {
    if (!existsSync(this.path)) return [];
    const byId = new Map<string, Step>();
    const order: string[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as Step;
        if (!byId.has(s.id)) order.push(s.id);
        byId.set(s.id, s);
      } catch {
        /* skip a torn line */
      }
    }
    return order.map((id) => byId.get(id)!);
  }

  /**
   * The current task: everything since the user's latest request, plus the
   * follow-ups. Earlier steps are history.
   */
  task(steps = this.steps()): { request?: StepOf<"user">; followUps: StepOf<"user">[]; steps: Step[]; earlier: Step[] } {
    // A forwarded side-agent note continues the current task; it never starts one.
    const users = steps.filter((s): s is StepOf<"user"> => s.kind === "user" && !s.text.startsWith("A side agent ("));
    if (!users.length) return { followUps: [], steps: [], earlier: steps };
    // A task begins at a user message that follows a turn which ended "done";
    // messages sent while the work was cut short continue the same task.
    let startIdx = steps.indexOf(users[users.length - 1]!);
    for (let i = users.length - 1; i > 0; i--) {
      const prevEnd = [...steps.slice(0, steps.indexOf(users[i]!))].reverse().find((s) => s.kind === "end") as StepOf<"end"> | undefined;
      if (prevEnd && prevEnd.outcome === "done") break;
      startIdx = steps.indexOf(users[i - 1]!);
    }
    const task = steps.slice(startIdx);
    const taskUsers = task.filter((s): s is StepOf<"user"> => s.kind === "user");
    const request = taskUsers.find((s) => !s.text.startsWith("A side agent ("));
    return { request, followUps: taskUsers.filter((s) => s !== request), steps: task, earlier: steps.slice(0, startIdx) };
  }

  /** When this agent last did any work (not counting being briefed). */
  lastSeen(agent: AgentId, steps = this.steps()): number | undefined {
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i]!;
      if (s.agent === agent && s.kind !== "handoff" && s.kind !== "user") return s.ts;
    }
    return undefined;
  }
}

/** Builds journal steps for one agent turn from the engine's event stream. */
export class TurnRecorder {
  readonly turn: string;
  private seq = 0;
  private text: { id: string; messageId?: string; text: string } | null = null;
  private thought: { id: string; text: string } | null = null;
  private tools = new Map<string, StepOf<"tool">>();
  private dirtyTools = new Set<string>();
  private limitHit = false;
  private lastError?: string;

  constructor(
    private journal: Journal,
    readonly agent: AgentId,
  ) {
    this.turn = `${agent}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  private nextId(kind: string) {
    return `${this.turn}:${kind}:${++this.seq}`;
  }

  private base() {
    return { ts: Date.now(), agent: this.agent, turn: this.turn };
  }

  user(text: string, checkpoint?: string) {
    this.journal.append({ ...this.base(), id: this.nextId("user"), kind: "user", text: clip(text, CAP.text)!, checkpoint });
  }

  handoff(o: { from?: AgentId; reason?: string; mode: "packet" | "catchup"; chars: number; checkpoint?: string }) {
    this.journal.append({ ...this.base(), id: this.nextId("handoff"), kind: "handoff", ...o });
  }

  textDelta(t: string, messageId?: string) {
    if (this.text && messageId && this.text.messageId && messageId !== this.text.messageId) this.flushText();
    this.flushThought();
    this.text ??= { id: this.nextId("text"), messageId, text: "" };
    this.text.text += t;
  }

  thoughtDelta(t: string) {
    this.thought ??= { id: this.nextId("thought"), text: "" };
    this.thought.text += t;
  }

  tool(callId: string, o: { title?: string; kind?: string; status?: string; input?: unknown; output?: string; files?: string[] }) {
    this.flushText();
    this.flushThought();
    let s = this.tools.get(callId);
    const first = !s;
    s ??= { ...this.base(), id: this.nextId("tool"), kind: "tool", title: o.title ?? callId, status: o.status ?? "pending" };
    if (o.title) s.title = o.title;
    if (o.kind) s.toolKind = o.kind;
    if (o.input !== undefined) s.input = clip(typeof o.input === "string" ? o.input : JSON.stringify(o.input), CAP.input);
    if (o.output !== undefined) s.output = clip(o.output, CAP.output);
    if (o.files?.length) s.files = [...new Set([...(s.files ?? []), ...o.files])];
    const statusChanged = !!o.status && o.status !== s.status;
    if (o.status) s.status = o.status;
    this.tools.set(callId, s);
    // Write at the start and at each status change; streamed output waits for the next one.
    if (first || statusChanged) this.writeTool(callId);
    else this.dirtyTools.add(callId);
  }

  plan(entries: { content: string; status: string }[]) {
    if (!entries.length) return;
    this.journal.append({ ...this.base(), id: `${this.turn}:plan`, kind: "plan", entries });
  }

  /** The agent reported running out (error or a limit-notice reply). */
  markLimit(detail?: string) {
    this.limitHit = true;
    if (detail) this.lastError = detail;
  }

  markError(detail: string) {
    this.lastError = detail;
  }

  /** Close the turn: flush buffered steps and record how it ended and what was still running. */
  end(stopReason: string, detail?: string) {
    this.flushText();
    this.flushThought();
    for (const id of this.dirtyTools) this.writeTool(id);
    this.dirtyTools.clear();
    const inFlight = [...this.tools.values()].filter((t) => t.status === "pending" || t.status === "in_progress").map((t) => t.id);
    const outcome: Outcome = this.limitHit ? "limit" : stopReason === "cancelled" ? "cancelled" : stopReason === "error" ? "error" : "done";
    this.journal.append({ ...this.base(), id: `${this.turn}:end`, kind: "end", outcome, detail: clip(detail ?? this.lastError, 400), inFlight: inFlight.length ? inFlight : undefined });
  }

  private writeTool(callId: string) {
    const s = this.tools.get(callId);
    if (s) this.journal.append({ ...s, ts: Date.now() });
    this.dirtyTools.delete(callId);
  }

  private flushText() {
    if (this.text?.text.trim()) this.journal.append({ ...this.base(), id: this.text.id, kind: "text", text: clip(this.text.text.trim(), CAP.text)! });
    this.text = null;
  }

  private flushThought() {
    if (this.thought?.text.trim()) this.journal.append({ ...this.base(), id: this.thought.id, kind: "thought", text: clip(this.thought.text.trim(), CAP.thought)! });
    this.thought = null;
  }
}

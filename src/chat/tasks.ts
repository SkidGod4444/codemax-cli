import { BoxRenderable, StyledText, TextRenderable, bold, dim, fg, strikethrough, stringToStyledText, type CliRenderer, type TextChunk } from "@opentui/core";
import type { PlanEntry } from "./transcript.ts";
import { C, G } from "./theme.ts";

/** Rows of the list shown at most; the rest are counted on one line (Claude Code shows 5). */
export const TASK_ROWS = 5;

/**
 * The agent's plan, pinned above the prompt the way Claude Code pins its task list, instead of
 * scrolling away in the transcript:
 *
 *   3 tasks (1 done, 1 in progress, 1 open)
 *   ✔ Find the failing assertion        (green tick, struck through, dim)
 *   ◼ Fix the token expiry check        (accent, bold)
 *   ◻ Run the auth tests
 *
 * It stays while anything is unfinished and clears when a turn ends with everything done.
 */
export class TaskPanel {
  readonly box: BoxRenderable;
  private text: TextRenderable;
  private entries: PlanEntry[] = [];
  /** Ctrl+T: only the summary line ("3 tasks (1 done, …) · ctrl+t to show"). */
  collapsed = false;

  constructor(renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, { id: "tasks", width: "100%", flexShrink: 0, flexDirection: "column", paddingX: 2, marginTop: 1 });
    this.text = new TextRenderable(renderer, { id: "tasks-text", content: "", width: "100%", wrapMode: "none", truncate: true });
    this.box.add(this.text);
    this.box.visible = false;
  }

  get current(): PlanEntry[] {
    return this.entries;
  }

  set(entries: PlanEntry[]) {
    this.entries = entries;
    this.render();
  }

  /** A turn ended: a finished list goes away (returned, so the chat can keep a line of it); an unfinished one stays. */
  turnEnded(): PlanEntry[] | null {
    if (!this.entries.length || !this.entries.every((e) => e.status === "completed")) return null;
    const done = this.entries;
    this.clear();
    return done;
  }

  clear() {
    this.entries = [];
    this.render();
  }

  /** Ctrl+T, as in Claude Code: fold the list to its summary line, or show it again. */
  toggle(): boolean {
    this.collapsed = !this.collapsed;
    this.render();
    return this.collapsed;
  }

  /** The task being worked on (Claude sends its "active form": "Running the auth tests"). */
  get inProgress(): string | undefined {
    return this.entries.find((e) => e.status === "in_progress")?.content;
  }

  private render() {
    this.box.visible = this.entries.length > 0;
    if (!this.entries.length) return;
    this.text.content = styleTasks(this.entries, this.collapsed ? 0 : TASK_ROWS);
  }
}

/** The list as styled text (also used by tests). */
export function styleTasks(entries: PlanEntry[], rows = TASK_ROWS): StyledText {
  const done = entries.filter((e) => e.status === "completed").length;
  const doing = entries.filter((e) => e.status === "in_progress").length;
  const open = entries.length - done - doing;
  const nl = () => stringToStyledText("\n").chunks;
  const chunks: TextChunk[] = [
    dim(bold(String(entries.length))), dim(` task${entries.length === 1 ? "" : "s"} (`),
    dim(bold(String(done))), dim(" done, "), dim(bold(String(doing))), dim(" in progress, "), dim(bold(String(open))), dim(" open)"),
  ];
  // Keep what matters in view: what is being done, then what is next, then what is finished.
  const order = [...entries.keys()].sort((a, b) => rank(entries[a]!) - rank(entries[b]!) || a - b);
  const shown = new Set(order.slice(0, rows));
  for (const [i, e] of entries.entries()) {
    if (!shown.has(i)) continue;
    chunks.push(...nl());
    if (e.status === "completed") chunks.push(fg(C.ok)(`${G.done_} `), fg(C.dim)(strikethrough(e.content)));
    else if (e.status === "in_progress") chunks.push(fg(C.accent)(bold(`${G.doing} ${e.content}`)));
    else chunks.push(fg(C.text ?? C.dim)(`${G.todo} ${e.content}`));
  }
  const hidden = entries.filter((_, i) => !shown.has(i));
  if (rows === 0) {
    chunks.push(dim(" · ctrl+t to show"));
    return new StyledText(chunks);
  }
  if (hidden.length) {
    const p = hidden.filter((e) => e.status !== "completed").length;
    const c = hidden.length - p;
    chunks.push(...nl(), dim(`  … +${[p ? `${p} pending` : "", c ? `${c} completed` : ""].filter(Boolean).join(", ")}`));
  }
  return new StyledText(chunks);
}

function rank(e: PlanEntry): number {
  return e.status === "in_progress" ? 0 : e.status === "completed" ? 2 : 1;
}

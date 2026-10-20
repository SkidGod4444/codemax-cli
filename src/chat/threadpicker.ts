import { BoxRenderable, StyledText, TextRenderable, bold, dim, fg, stringToStyledText, type CliRenderer, type KeyEvent, type TextChunk } from "@opentui/core";
import type { ThreadInfo } from "../core/ledger.ts";
import type { Turn } from "../adapters/types.ts";
import { C, G } from "./theme.ts";

export interface ThreadPickerOptions {
  threads: ThreadInfo[];
  /** "Claude Code" for "claude". */
  agentName: (id?: string) => string;
  /** The agent a new thread starts with. */
  newWith: string;
  preview: (id: string) => Turn[];
  /** A thread's id, or null for a new thread. */
  onPick: (id: string | null) => void;
}

/**
 * `codemax --resume`: the whole screen, like Claude Code's "Resume session" list.
 *
 *   Resume thread (1 of 12)
 *   ⌕ Search…
 *
 *   ❯ fix the failing auth test
 *     2h ago · Claude Code · 14 messages · 85940ffa
 *
 *     add dark mode
 *     3d ago · Codex · 2 messages · c4248639
 *
 * Two lines per thread, newest first. Typing searches titles, agents and ids; Space previews
 * the thread's last messages; Enter opens it; Esc starts a new thread.
 */
export class ThreadPicker {
  readonly box: BoxRenderable;
  private head: TextRenderable;
  private body: TextRenderable;
  private hint: TextRenderable;
  private query = "";
  private cursor = 0;
  private previewing: ThreadInfo | null = null;

  constructor(private renderer: CliRenderer, private o: ThreadPickerOptions) {
    this.box = new BoxRenderable(renderer, { id: "thread-picker", width: "100%", height: "100%", flexDirection: "column", border: true, borderStyle: "rounded", borderColor: C.accent, paddingX: 1 });
    this.head = new TextRenderable(renderer, { id: "tp-head", content: "", width: "100%", wrapMode: "none", truncate: true });
    this.body = new TextRenderable(renderer, { id: "tp-body", content: "", width: "100%", flexGrow: 1, wrapMode: "none", truncate: true } as any);
    this.hint = new TextRenderable(renderer, { id: "tp-hint", content: "", width: "100%", fg: C.dim, wrapMode: "none", truncate: true });
    this.box.add(this.head);
    this.box.add(this.body);
    this.box.add(this.hint);
    this.render();
  }

  /** The threads that match the search, then "New thread" (null). */
  private rows(): (ThreadInfo | null)[] {
    const q = this.query.toLowerCase().trim();
    const hits = q ? this.o.threads.filter((t) => `${t.title ?? ""} ${this.o.agentName(t.agent)} ${t.id}`.toLowerCase().includes(q)) : this.o.threads;
    return [...hits, null];
  }

  render() {
    if (this.previewing) return this.renderPreview(this.previewing);
    const rows = this.rows();
    this.cursor = Math.max(0, Math.min(this.cursor, rows.length - 1));
    const threads = rows.length - 1;
    const width = Math.max(10, this.renderer.width - 6);
    this.head.content = new StyledText([
      fg(C.accent)(bold("Resume thread")),
      dim(threads ? ` (${Math.min(this.cursor + 1, threads)} of ${threads})` : ""),
      ...stringToStyledText("\n").chunks,
      this.query ? fg(C.text ?? C.dim)(`⌕ ${this.query}`) : dim("⌕ Search…"),
      ...stringToStyledText("\n").chunks,
    ]);
    // Three rows per thread (title, details, a blank), as many as the screen holds, around the cursor.
    const room = Math.max(1, Math.floor((this.renderer.height - 7) / 3));
    const top = Math.max(0, Math.min(this.cursor - Math.floor(room / 2), rows.length - room));
    const chunks: TextChunk[] = [];
    const nl = () => chunks.push(...stringToStyledText("\n").chunks);
    rows.slice(top, top + room).forEach((t, k) => {
      const i = top + k;
      const sel = i === this.cursor;
      const mark = sel ? fg(C.accent)(`${G.prompt} `) : stringToStyledText("  ").chunks[0]!;
      if (k > 0) nl();
      if (!t) {
        chunks.push(mark, sel ? fg(C.accent)("New thread") : fg(C.text ?? C.dim)("New thread"));
        nl();
        chunks.push(dim(`  start fresh with ${this.o.newWith}`));
      } else {
        const title = clipTo(t.title ?? "(no messages)", width - 2);
        chunks.push(mark, sel ? fg(C.accent)(title) : fg(C.text ?? C.dim)(title));
        nl();
        const n = t.messages ?? 0;
        chunks.push(dim(clipTo(`  ${ago(t.updatedAt)}${t.agent ? ` · ${this.o.agentName(t.agent)}` : ""} · ${n} message${n === 1 ? "" : "s"} · ${t.id}`, width)));
      }
      nl();
    });
    if (threads === 0 && this.query) chunks.unshift(dim(`  no thread matches "${this.query}"`), ...stringToStyledText("\n\n").chunks);
    this.body.content = new StyledText(chunks);
    this.hint.content = this.query
      ? "type to search · ↑↓ select · Enter open · Esc clears the search"
      : "↑↓ select · Enter open · type to search · Space preview · Esc new thread";
  }

  private renderPreview(t: ThreadInfo) {
    const width = Math.max(10, this.renderer.width - 6);
    this.head.content = new StyledText([fg(C.accent)(bold(clipTo(t.title ?? "Thread", width))), ...stringToStyledText("\n").chunks, dim(`${ago(t.updatedAt)} · ${t.id}`), ...stringToStyledText("\n").chunks]);
    const turns = this.o.preview(t.id);
    const chunks: TextChunk[] = [];
    const room = Math.max(3, this.renderer.height - 7);
    const lines: TextChunk[][] = [];
    for (const m of turns) {
      const text = m.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (m.role === "user") lines.push([fg(C.dim)(`${G.prompt} `), fg(C.text ?? C.dim)(clipTo(text, width - 2))]);
      else lines.push([fg(C.assistant)(`${G.bullet} `), dim(clipTo(`${this.o.agentName(m.agent)}: ${text}`, width - 2))]);
      lines.push([]);
    }
    const shown = lines.slice(-room);
    if (!shown.length) shown.push([dim("nothing said in this thread yet")]);
    shown.forEach((l, i) => {
      if (i > 0) chunks.push(...stringToStyledText("\n").chunks);
      chunks.push(...l);
    });
    this.body.content = new StyledText(chunks);
    this.hint.content = "Enter open this thread · Space or Esc back to the list";
  }

  /** Every key goes here while the picker is open. */
  handleKey(key: KeyEvent) {
    const n = key.sequence === " " ? "space" : key.name;
    if (this.previewing) {
      if (n === "return") return this.o.onPick(this.previewing.id);
      if (n === "escape" || n === "space") this.previewing = null;
      return this.render();
    }
    const rows = this.rows();
    const cur = rows[this.cursor];
    if (n === "up") this.cursor = (this.cursor - 1 + rows.length) % rows.length;
    else if (n === "down" || n === "tab") this.cursor = (this.cursor + 1) % rows.length;
    else if (n === "pageup") this.cursor = Math.max(0, this.cursor - 5);
    else if (n === "pagedown") this.cursor = Math.min(rows.length - 1, this.cursor + 5);
    else if (n === "return") return this.o.onPick(cur ? cur.id : null);
    else if (n === "escape") {
      if (!this.query) return this.o.onPick(null);
      this.query = "";
      this.cursor = 0;
    } else if (n === "space" && !this.query) {
      if (cur) this.previewing = cur;
    }
    else if (n === "backspace") {
      this.query = this.query.slice(0, -1);
      this.cursor = 0;
    } else if (key.sequence && key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta) {
      this.query += key.sequence;
      this.cursor = 0;
    }
    this.render();
  }

  destroy() {
    this.box.destroyRecursively();
  }
}

function clipTo(s: string, w: number): string {
  return s.length > w ? s.slice(0, Math.max(1, w - 1)) + "…" : s;
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import type { QuestionAnswer, QuestionField, QuestionRequest } from "../engines/types.ts";
import { C, G } from "./theme.ts";

/**
 * An agent's question (Claude's AskUserQuestion, an MCP form), one field at a time:
 *
 *   Claude Code has a question · 1 of 2
 *   [Database] Which database should we use?
 *   ❯ 1. Postgres         relational, the default
 *     2. SQLite
 *     3. Type something else…
 *
 * Digits pick (or toggle, in a multi-select); typing goes into the
 * "something else" box, so a stray letter never picks an option. Esc skips
 * the question (the agent is told you skipped and carries on).
 */
export class QuestionDialog {
  readonly box: BoxRenderable;
  private header: TextRenderable;
  private prompt: TextRenderable;
  private list: BoxRenderable;
  private hint: TextRenderable;
  private index = 0;
  private cursor = 0;
  private picked = new Set<string>();
  private typed = "";
  private error = "";
  private content: Record<string, string | number | boolean | string[]> = {};

  constructor(
    private renderer: CliRenderer,
    readonly request: QuestionRequest,
    private agentName: string,
    private onDone: (a: QuestionAnswer) => void,
  ) {
    this.box = new BoxRenderable(renderer, { id: `ask-${request.id}`, width: "100%", flexShrink: 0, border: true, borderStyle: "rounded", borderColor: C.accent, paddingX: 1, flexDirection: "column" });
    this.header = new TextRenderable(renderer, { content: "", fg: C.accent });
    this.prompt = new TextRenderable(renderer, { content: "", wrapMode: "word", width: "100%" });
    this.list = new BoxRenderable(renderer, { width: "100%", flexDirection: "column", flexShrink: 0 });
    this.hint = new TextRenderable(renderer, { content: "", fg: C.dim, wrapMode: "word", width: "100%" });
    this.box.add(this.header);
    this.box.add(this.prompt);
    this.box.add(new TextRenderable(renderer, { content: "" }));
    this.box.add(this.list);
    this.box.add(this.hint);
    this.render();
  }

  private get field(): QuestionField {
    return this.request.fields[this.index]!;
  }

  /** Rows: the options, then a free-text row when the field takes text. */
  private get rows(): ({ kind: "option"; value: string; label: string; description?: string } | { kind: "text" })[] {
    const f = this.field;
    const text = f.kind === "text" || f.kind === "number" || !!f.otherKey;
    return [...f.options.map((o) => ({ kind: "option" as const, ...o })), ...(text ? [{ kind: "text" as const }] : [])];
  }

  private render() {
    const f = this.field;
    const n = this.request.fields.length;
    this.header.content = `${this.agentName} has a question${n > 1 ? ` · ${this.index + 1} of ${n}` : ""}`;
    this.prompt.content = `${f.title && f.title !== f.question ? `[${f.title}] ` : ""}${f.question || this.request.message}`;
    for (const c of [...this.list.getChildren()]) c.destroyRecursively();
    this.rows.forEach((r, i) => {
      const sel = i === this.cursor;
      const mark = sel ? G.prompt : " ";
      if (r.kind === "option") {
        const box = f.kind === "multi" ? (this.picked.has(r.value) ? "[x] " : "[ ] ") : "";
        this.list.add(new TextRenderable(this.renderer, { content: ` ${mark} ${i + 1}. ${box}${r.label}`, fg: sel ? C.accent : undefined, wrapMode: "word", width: "100%" }));
        if (r.description) this.list.add(new TextRenderable(this.renderer, { content: `       ${r.description}`, fg: C.dim, wrapMode: "word", width: "100%" }));
      } else {
        const label = f.kind === "text" || f.kind === "number" ? "" : f.kind === "multi" ? "Add your own: " : "Type something else: ";
        const caret = sel ? "▏" : "";
        const shown = this.typed ? this.typed + caret : caret || (f.kind === "text" || f.kind === "number" ? "(type your answer)" : "…");
        this.list.add(new TextRenderable(this.renderer, { content: ` ${mark} ${f.options.length ? `${i + 1}. ` : ""}${label}${shown}`, fg: sel ? C.accent : undefined, wrapMode: "word", width: "100%" }));
      }
    });
    const keys = f.kind === "multi" ? "1-9 or space to tick · Enter when done" : this.rows.length > 1 ? "1-9 or ↑/↓ then Enter" : "Enter to send";
    this.hint.content = `${this.error ? this.error + " · " : ""}${keys} · Esc to skip${n > 1 && this.index > 0 ? " · shift+tab back" : ""}`;
    this.hint.fg = this.error ? C.warn : C.dim;
  }

  /** Always consumes the key (the dialog owns the keyboard while open). */
  handleKey(key: KeyEvent): boolean {
    const rows = this.rows;
    const onText = rows[this.cursor]?.kind === "text";
    const n = key.name;
    this.error = "";
    if (n === "escape") return this.finish({ action: "decline" });
    if (n === "up") this.cursor = (this.cursor - 1 + rows.length) % rows.length;
    else if (n === "down" || (n === "tab" && !key.shift)) this.cursor = (this.cursor + 1) % rows.length;
    else if (n === "tab" && key.shift) this.back();
    else if (n === "return") return this.enter();
    else if (n === "backspace" && onText) this.typed = this.typed.slice(0, -1);
    else if (n === "space" && !onText && this.field.kind === "multi") this.toggle(this.cursor);
    // Digits pick unless you are typing an answer (an empty answer box still takes digits as picks).
    else if ((!onText || !this.typed) && /^[1-9]$/.test(n) && rows[Number(n) - 1]?.kind === "option") {
      const i = Number(n) - 1;
      this.cursor = i;
      if (rows[i]!.kind === "option") {
        if (this.field.kind === "multi") this.toggle(i);
        else return this.enter();
      }
    } else {
      const ch = key.sequence ?? "";
      // Typing never picks an option: it goes into the free-text row.
      if (ch.length >= 1 && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(ch)) {
        const t = rows.findIndex((r) => r.kind === "text");
        if (t >= 0) {
          this.cursor = t;
          this.typed += ch;
        }
      }
    }
    this.render();
    return false;
  }

  private toggle(i: number) {
    const r = this.rows[i];
    if (r?.kind !== "option") return;
    if (this.picked.has(r.value)) this.picked.delete(r.value);
    else this.picked.add(r.value);
  }

  private back() {
    if (this.index === 0) return;
    this.index--;
    // Going back re-asks the question, so its earlier answer is dropped.
    delete this.content[this.field.key];
    if (this.field.otherKey) delete this.content[this.field.otherKey];
    this.resetField();
  }

  private enter(): boolean {
    const f = this.field;
    const row = this.rows[this.cursor];
    const text = this.typed.trim();
    if (f.kind === "multi") {
      const picks = [...this.picked];
      if (picks.length) this.content[f.key] = picks;
      if (text && f.otherKey) this.content[f.otherKey] = text;
      if (!picks.length && !text && f.required) return this.complain("pick at least one");
    } else if (f.kind === "text" || f.kind === "number") {
      if (!text && f.required) return this.complain("type an answer");
      if (text && f.kind === "number") {
        const v = Number(text);
        if (!Number.isFinite(v) || (f.integer && !Number.isInteger(v))) return this.complain(f.integer ? "type a whole number" : "type a number");
        this.content[f.key] = v;
      } else if (text) this.content[f.key] = text;
    } else if (row?.kind === "option") {
      this.content[f.key] = f.kind === "boolean" ? row.value === "true" : row.value;
      // A note typed in "something else" travels with the pick (the agent reads it as a note).
      if (text && f.otherKey) this.content[f.otherKey] = text;
    } else {
      if (!text) return this.complain("type something, or pick an option");
      if (f.otherKey) this.content[f.otherKey] = text;
      else this.content[f.key] = text;
    }
    if (this.index + 1 < this.request.fields.length) {
      this.index++;
      this.resetField();
      return false;
    }
    return this.finish({ action: "accept", content: this.content });
  }

  private resetField() {
    this.cursor = 0;
    this.picked.clear();
    this.typed = "";
    this.render();
  }

  private complain(msg: string): boolean {
    this.error = msg;
    this.render();
    return false;
  }

  private finish(a: QuestionAnswer): boolean {
    this.onDone(a);
    return true;
  }

  destroy() {
    this.box.destroyRecursively();
  }
}

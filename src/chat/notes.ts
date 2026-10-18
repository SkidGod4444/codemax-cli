import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { styleMarkdown } from "./markdown.ts";
import { C } from "./theme.ts";

export interface PendingNote {
  name: string;
  text: string;
}

/**
 * Side-agent notes wait here, pinned above the prompt (with the queue), until
 * you act on one:
 *
 *   ╭──────────────────────────────────────────────────────────╮
 *   │ ⚑ Heads up from Codex · 1 of 2                           │
 *   │ The tests only ran once, so a flaky pass would ship.      │
 *   │ 1 expand · 2 discuss with Claude Code · 0 dismiss (type the number and pause) │
 *   ╰──────────────────────────────────────────────────────────╯
 *
 * A digit is always typed into the prompt first. Only when the prompt holds just
 * that digit and you pause does it act on the note, so "2 more tests please"
 * is a message, never a forwarded note.
 */
export class NotePanel {
  readonly box: BoxRenderable;
  private notes: PendingNote[] = [];
  private expanded = false;
  /** The main agent just asked you something: a lone digit is your answer, so the keys pause. */
  private paused = false;

  constructor(
    private renderer: CliRenderer,
    private mainName: () => string,
  ) {
    this.box = new BoxRenderable(renderer, { id: "notes", width: "100%", flexShrink: 0, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: C.warn, paddingX: 1 });
    this.box.visible = false;
  }

  get count() {
    return this.notes.length;
  }

  get current(): PendingNote | undefined {
    return this.notes[0];
  }

  push(n: PendingNote) {
    this.notes.push(n);
    this.render();
  }

  /** Remove the note on show (after it was sent or dismissed); the next one shows. */
  take(): PendingNote | undefined {
    const n = this.notes.shift();
    this.expanded = false;
    this.render();
    return n;
  }

  setPaused(p: boolean) {
    if (this.paused === p) return;
    this.paused = p;
    this.render();
  }

  get isPaused() {
    return this.paused;
  }

  toggle() {
    this.expanded = !this.expanded;
    this.render();
  }

  render() {
    for (const c of [...this.box.getChildren()]) c.destroyRecursively();
    const n = this.notes[0];
    this.box.visible = !!n;
    if (!n) return;
    const { headline, body } = splitNote(n.text);
    const more = this.notes.length > 1 ? ` · 1 of ${this.notes.length}` : "";
    this.box.borderColor = C.warn;
    this.box.add(new TextRenderable(this.renderer, { content: `⚑ Heads up from ${n.name}${more}`, fg: C.warn, attributes: 1, wrapMode: "none", truncate: true, width: "100%" } as any));
    this.box.add(new TextRenderable(this.renderer, { content: headline, wrapMode: "word", width: "100%" }));
    if (this.expanded && body) {
      // At most half the screen; the rest of a very long note is cut (it is in the ledger).
      const room = Math.max(3, Math.floor(this.renderer.height / 2) - 4);
      this.box.add(new TextRenderable(this.renderer, { content: styleMarkdown(body), wrapMode: "word", width: "100%", height: Math.min(room, body.split("\n").length + Math.ceil(body.length / Math.max(20, this.renderer.width - 6))), truncate: true } as any));
    }
    const expand = body ? (this.expanded ? "1 collapse" : "1 expand") : null;
    if (this.paused) this.box.add(new TextRenderable(this.renderer, { content: `${this.mainName()} asked you something, so 1 · 2 · 0 are your answer for now; the note keys come back after you reply`, fg: C.dim, wrapMode: "word", width: "100%" }));
    else this.box.add(new TextRenderable(this.renderer, { content: [expand, `2 discuss with ${this.mainName()}`, "0 dismiss"].filter(Boolean).join(" · ") + " (type the number and pause)", fg: C.dim, wrapMode: "word", width: "100%" }));
  }
}

/** "Heads up · <one line>" then a body: the line for the collapsed panel, the rest for expand. */
export function splitNote(text: string): { headline: string; body: string } {
  const lines = text.trim().split("\n");
  const first = (lines.shift() ?? "").replace(/^\s*(⚑\s*)?heads up\s*[·:-]\s*/i, "").trim();
  return { headline: first || "The side agent left a note", body: lines.join("\n").trim() };
}

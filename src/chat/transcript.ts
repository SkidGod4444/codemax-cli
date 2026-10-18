import { BoxRenderable, ScrollBoxRenderable, StyledText, TextRenderable, fg, italic, strikethrough, stringToStyledText, type CliRenderer, type TextChunk } from "@opentui/core";
import { C, G } from "./theme.ts";
import { styleMarkdown, styleToolOutput } from "./markdown.ts";

export interface PlanEntry {
  content: string;
  status: string;
}

export interface AgentBlock {
  /** Stream assistant text. A new `messageId` (or a tool row in between) starts a new `⏺` paragraph. */
  append(text: string, messageId?: string): void;
  /** Stream reasoning into a collapsed, dim "Thinking" block. */
  thought(text: string, messageId?: string): void;
  /** Show or update the agent's plan as a checklist. */
  plan(entries: PlanEntry[]): void;
  tool(id: string, title: string, status: string, detail?: string): void;
  toolUpdate(id: string, status?: string, title?: string, detail?: string): void;
  /** Closing dim line, e.g. "✻ Worked for 13s · done 7:25 PM". */
  footer(text: string): void;
  /** The reply as plain text: paragraphs joined by blank lines. */
  text(): string;
  toolCount(): number;
}

/** Something that can be shown cut down or in full (Ctrl+O toggles all of them). */
interface Collapsible {
  node: TextRenderable;
  full: string;
  render: (text: string, expanded: boolean) => string | StyledText;
}

/**
 * Conversation view in Claude Code's idiom: `❯ prompt`, `⏺ text`, `⏺ Tool(args)`
 * with `  ⎿  result` nested beneath, dim notes, and a divider on agent switches.
 * Every line is a row box: a fixed glyph column and a wrapping text column, so
 * wrapped continuation lines stay aligned under the text.
 */
export class Transcript {
  readonly box: ScrollBoxRenderable;
  private n = 0;
  private expanded = false;
  private collapsibles: Collapsible[] = [];

  constructor(private renderer: CliRenderer) {
    this.box = new ScrollBoxRenderable(renderer, {
      id: "transcript",
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      scrollY: true,
      scrollX: false,
      contentOptions: { flexDirection: "column", paddingX: 1 },
      verticalScrollbarOptions: { width: 0, showArrows: false },
    });
  }

  get isExpanded() {
    return this.expanded;
  }

  /** Ctrl+O: show every tool result and thinking block in full, or cut them back down. */
  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    for (const c of this.collapsibles) c.node.content = c.render(c.full, this.expanded);
    this.scrollToEnd();
    return this.expanded;
  }

  /** Startup card: brand mark, what codemax is, the project, and any notes. */
  header(lines: { title: string; subtitle: string; path: string; notes: string[] }) {
    if (this.gone) return;
    const card = new BoxRenderable(this.renderer, {
      id: `header-${++this.n}`,
      width: "100%",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: C.accent,
      paddingX: 1,
      marginTop: 1,
    });
    const title = new StyledText([fg(C.accent)("✻ "), fg(C.accent)(lines.title)]);
    card.add(new TextRenderable(this.renderer, { id: `h-t-${this.n}`, content: title, attributes: 1 } as any));
    card.add(new TextRenderable(this.renderer, { id: `h-s-${this.n}`, content: lines.subtitle, fg: C.dim }));
    card.add(new TextRenderable(this.renderer, { id: `h-gap-${this.n}`, content: "", height: 1 }));
    card.add(new TextRenderable(this.renderer, { id: `h-p-${this.n}`, content: `cwd: ${lines.path}`, fg: C.dim, wrapMode: "char" } as any));
    for (const [i, note] of lines.notes.entries()) card.add(new TextRenderable(this.renderer, { id: `h-n-${this.n}-${i}`, content: note, fg: C.dim, wrapMode: "word" } as any));
    this.box.add(card);
  }

  /** A side agent's note: a bordered card that stands apart from the conversation. */
  noteCard(title: string, body: string, hint: string) {
    if (this.gone) return;
    this.gap();
    const card = new BoxRenderable(this.renderer, { id: `note-${++this.n}`, width: "100%", flexDirection: "column", border: true, borderStyle: "rounded", borderColor: C.warn, paddingX: 1 });
    card.add(new TextRenderable(this.renderer, { id: `nt-${this.n}`, content: title, fg: C.warn, attributes: 1 } as any));
    card.add(new TextRenderable(this.renderer, { id: `nb-${this.n}`, content: styleMarkdown(body), wrapMode: "word", width: "100%" } as any));
    card.add(new TextRenderable(this.renderer, { id: `nh-${this.n}`, content: hint, fg: C.dim, wrapMode: "word" } as any));
    this.box.add(card);
    this.scrollToEnd();
  }

  user(text: string) {
    this.gap();
    this.line(`${G.prompt} `, text, { fg: undefined, glyphFg: C.accent });
  }

  note(text: string, fg_: string = C.dim) {
    this.nested(text, fg_);
  }

  error(text: string) {
    this.nested(text, C.error);
  }

  divider(text: string) {
    this.gap();
    const w = Math.max(20, this.renderer.width - 4);
    const label = ` ${text} `;
    const side = Math.max(3, Math.floor((w - label.length) / 2));
    const content = new StyledText([fg(C.dimmer)(G.rule.repeat(side)), fg(C.accent)(label), fg(C.dimmer)(G.rule.repeat(side))]);
    this.line("", "", {}).content = content;
    this.gap();
  }

  agent(): AgentBlock {
    const self = this;
    let para: { node: TextRenderable; text: string; id?: string } | null = null;
    let thinking: { node: TextRenderable; c: Collapsible; id?: string } | null = null;
    let planNode: TextRenderable | null = null;
    let styleTimer: ReturnType<typeof setTimeout> | null = null;
    const tools = new Map<string, { glyph: TextRenderable; title: TextRenderable; result?: Collapsible; name: string; status: string }>();
    const paragraphs: string[] = [];

    const settle = () => {
      if (para) {
        if (styleTimer) clearTimeout(styleTimer);
        styleTimer = null;
        para.node.content = styleMarkdown(para.text);
      }
    };
    const toolResult = (detail: string, failed: boolean): Collapsible => {
      const c: Collapsible = {
        node: null as unknown as TextRenderable,
        full: detail,
        render: (t, expanded) => styleToolOutput(expanded ? t.replace(/\s+$/, "") : summarize(t)),
      };
      c.node = self.nestedNode("", failed ? C.error : C.dim);
      c.node.content = c.render(detail, self.expanded);
      self.collapsibles.push(c);
      return c;
    };

    return {
      append(t, messageId) {
        if (para && messageId && para.id && messageId !== para.id) {
          settle();
          para = null;
        }
        thinking = null;
        if (!para) {
          const start = t.replace(/^\n+/, "");
          const node = self.line(`${G.bullet} `, start, { glyphFg: C.assistant });
          para = { node, text: start, id: messageId };
          paragraphs.push(start);
        } else {
          para.text += t;
          paragraphs[paragraphs.length - 1] = para.text;
        }
        const p = para;
        // Restyle at most every 80ms while streaming; the final append is always styled.
        if (!styleTimer) styleTimer = setTimeout(() => { styleTimer = null; p.node.content = styleMarkdown(p.text); }, 80);
        self.scrollToEnd();
      },
      thought(t, messageId) {
        if (thinking && messageId && thinking.id && messageId !== thinking.id) thinking = null;
        if (!thinking) {
          settle();
          para = null;
          const c: Collapsible = {
            node: null as unknown as TextRenderable,
            full: "",
            render: (text, expanded) => {
              const body = text.trim();
              const shown = expanded ? body : clip(body, 2, 160);
              return new StyledText([fg(C.thought)(italic(`Thinking${shown ? "… " : "…"}`)), fg(C.thought)(italic(shown))]);
            },
          };
          c.node = self.line(`${G.thought} `, "", { glyphFg: C.thought });
          self.collapsibles.push(c);
          thinking = { node: c.node, c, id: messageId };
        }
        thinking.c.full += t;
        thinking.node.content = thinking.c.render(thinking.c.full, self.expanded);
        self.scrollToEnd();
      },
      plan(entries) {
        if (!entries.length) return;
        settle();
        para = null;
        const chunks: TextChunk[] = [fg(C.assistant)("Plan")];
        for (const e of entries) {
          const done = e.status === "completed";
          const doing = e.status === "in_progress";
          const box = done ? G.done_ : doing ? G.doing : G.todo;
          // A line break inside a coloured chunk is not laid out; it must be its own plain chunk.
          chunks.push(...stringToStyledText("\n").chunks, fg(C.dimmer)(`${G.nest}  `));
          if (done) chunks.push(fg(C.dim)(`${box} `), fg(C.dim)(strikethrough(e.content)));
          else if (doing) chunks.push(fg(C.accent)(`${box} ${e.content}`));
          else chunks.push(fg(C.text ?? C.dim)(`${box} ${e.content}`));
        }
        const content = new StyledText(chunks);
        // One live checklist per turn: later updates redraw it in place.
        if (planNode) planNode.content = content;
        else {
          planNode = self.line(`${G.bullet} `, "", { glyphFg: C.tool });
          planNode.content = content;
        }
        self.scrollToEnd();
      },
      tool(id, title, status, detail) {
        settle();
        para = null;
        thinking = null;
        if (self.gone) return;
        const glyph = new TextRenderable(self.renderer, { id: `tg-${++self.n}`, content: `${G.bullet} `, width: 2, fg: toolColor(status), wrapMode: "none" });
        const title_ = self.lineWithGlyph(glyph, title);
        const entry = { glyph, title: title_, name: title, status, result: undefined as Collapsible | undefined };
        tools.set(id, entry);
        if (detail) entry.result = toolResult(detail, status === "failed");
        self.scrollToEnd();
      },
      toolUpdate(id, status, title, detail) {
        const e = tools.get(id);
        if (!e) return;
        if (title) {
          e.name = title;
          e.title.content = title;
        }
        if (status) {
          e.status = status;
          e.glyph.fg = toolColor(status);
        }
        if (status === "failed") e.title.fg = C.error;
        if (detail) {
          if (e.result) {
            e.result.full = detail;
            e.result.node.content = e.result.render(detail, self.expanded);
          } else e.result = toolResult(detail, status === "failed");
        }
      },
      footer(text) {
        settle();
        para = null;
        thinking = null;
        self.line(`${G.done} `, text, { fg: C.dim, glyphFg: C.dim });
        self.scrollToEnd();
      },
      text: () => paragraphs.map((p) => p.trim()).filter(Boolean).join("\n\n"),
      toolCount: () => tools.size,
    };
  }

  // ---------- primitives ----------

  /** After quit the native scene is gone; late async writes (a finishing handoff) are dropped. */
  private get gone() {
    return (this.renderer as { isDestroyed?: boolean }).isDestroyed === true;
  }

  private gap() {
    if (this.gone) return;
    this.box.add(new TextRenderable(this.renderer, { id: `gap-${++this.n}`, content: "", height: 1 }));
  }

  private line(glyph: string, text: string, o: { fg?: string; glyphFg?: string; bold?: boolean } = {}): TextRenderable {
    if (this.gone) return { content: "" } as unknown as TextRenderable;
    const g = glyph ? new TextRenderable(this.renderer, { id: `g-${++this.n}`, content: glyph, width: glyph.length, fg: o.glyphFg ?? o.fg, wrapMode: "none" }) : null;
    return this.lineWithGlyph(g, text, o);
  }

  private lineWithGlyph(glyph: TextRenderable | null, text: string, o: { fg?: string; bold?: boolean } = {}): TextRenderable {
    if (this.gone) return { content: "" } as unknown as TextRenderable;
    const row = new BoxRenderable(this.renderer, { id: `row-${++this.n}`, width: "100%", flexDirection: "row" });
    if (glyph) row.add(glyph);
    const body = new TextRenderable(this.renderer, { id: `t-${this.n}`, content: text, fg: o.fg, flexGrow: 1, flexShrink: 1, wrapMode: "word", attributes: o.bold ? 1 : undefined } as any);
    row.add(body);
    this.box.add(row);
    return body;
  }

  private nested(text: string, fg_: string) {
    this.nestedNode(text, fg_);
    this.scrollToEnd();
  }

  private nestedNode(text: string, fg_: string, toolOutput = false): TextRenderable {
    const node = this.line(`  ${G.nest}  `, text, { fg: fg_, glyphFg: C.dimmer });
    if (toolOutput) node.content = styleToolOutput(text);
    return node;
  }

  scrollToEnd() {
    queueMicrotask(() => {
      try {
        this.box.scrollTo({ x: 0, y: this.box.scrollHeight });
      } catch {
        /* not laid out yet */
      }
    });
  }
}

function toolColor(status: string): string {
  if (status === "completed") return C.ok;
  if (status === "failed") return C.error;
  return C.dim;
}

/** First `lines` lines of text, each clipped, with an ellipsis when anything was cut. */
function clip(text: string, lines: number, width: number): string {
  const all = text.split("\n").filter((l) => l.trim());
  const kept = all.slice(0, lines).map((l) => (l.length > width ? l.slice(0, width - 1) + "…" : l));
  const cut = all.length > lines || kept.some((l, i) => l !== all[i]);
  return kept.join(" ") + (cut ? " (ctrl+o)" : "");
}

/** Tool output: first lines, then "… +N lines" like Claude Code's collapsed results. */
export function summarize(detail: string, keep = 3): string {
  const lines = detail.replace(/\s+$/, "").split("\n");
  if (lines.length <= keep) return lines.join("\n");
  return lines.slice(0, keep).join("\n") + `\n… +${lines.length - keep} lines (ctrl+o to expand)`;
}

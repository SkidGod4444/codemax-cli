import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { C, G } from "./theme.ts";

export interface AgentBlock {
  /** Stream assistant text; starts a `⏺` paragraph, continues it until a tool row interrupts. */
  append(text: string): void;
  tool(id: string, title: string, status: string, detail?: string): void;
  toolUpdate(id: string, status?: string, title?: string, detail?: string): void;
  /** Closing dim line, e.g. "✻ Worked for 13s · done 7:25 PM". */
  footer(text: string): void;
  text(): string;
  toolCount(): number;
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

  /** Startup header: name, agent/model/plan, cwd, and any notes as nested dim lines. */
  header(lines: { title: string; subtitle: string; path: string; notes: string[] }) {
    this.gap();
    this.line("", lines.title, { bold: true });
    this.line("", lines.subtitle, { fg: C.dim });
    this.line("", lines.path, { fg: C.dim });
    for (const n of lines.notes) this.nested(n, C.dim);
    this.gap();
  }

  user(text: string) {
    this.gap();
    this.line(`${G.prompt} `, text, { fg: undefined, glyphFg: C.dim });
  }

  note(text: string, fg: string = C.dim) {
    this.nested(text, fg);
  }

  error(text: string) {
    this.nested(text, C.error);
  }

  divider(text: string) {
    this.gap();
    const w = Math.max(20, this.renderer.width - 4);
    const label = ` ${text} `;
    const side = Math.max(3, Math.floor((w - label.length) / 2));
    this.line("", G.rule.repeat(side) + label + G.rule.repeat(side), { fg: C.dimmer });
    this.gap();
  }

  agent(): AgentBlock {
    const self = this;
    let para: { node: TextRenderable; text: string } | null = null;
    const tools = new Map<string, { title: TextRenderable; result?: TextRenderable; name: string; status: string }>();
    let all = "";
    return {
      append(t) {
        all += t;
        if (!para) {
          const node = self.line(`${G.bullet} `, t.replace(/^\n+/, ""));
          para = { node, text: t.replace(/^\n+/, "") };
        } else {
          para.text += t;
          para.node.content = para.text;
        }
        self.scrollToEnd();
      },
      tool(id, title, status, detail) {
        para = null;
        const node = self.line(`${G.bullet} `, title, { fg: undefined });
        const entry = { title: node, name: title, status, result: undefined as TextRenderable | undefined };
        tools.set(id, entry);
        if (detail) entry.result = self.nestedNode(summarize(detail), C.dim);
        self.scrollToEnd();
      },
      toolUpdate(id, status, title, detail) {
        const e = tools.get(id);
        if (!e) return;
        if (title) {
          e.name = title;
          e.title.content = title;
        }
        if (status) e.status = status;
        if (status === "failed") e.title.fg = C.error;
        if (detail) {
          const s = summarize(detail);
          if (e.result) e.result.content = s;
          else e.result = self.nestedNode(s, status === "failed" ? C.error : C.dim);
        }
      },
      footer(text) {
        para = null;
        self.line(`${G.done} `, text, { fg: C.dim, glyphFg: C.dim });
        self.scrollToEnd();
      },
      text: () => all,
      toolCount: () => tools.size,
    };
  }

  // ---------- primitives ----------

  private gap() {
    this.box.add(new TextRenderable(this.renderer, { id: `gap-${++this.n}`, content: "", height: 1 }));
  }

  private line(glyph: string, text: string, o: { fg?: string; glyphFg?: string; bold?: boolean } = {}): TextRenderable {
    const row = new BoxRenderable(this.renderer, { id: `row-${++this.n}`, width: "100%", flexDirection: "row" });
    if (glyph) row.add(new TextRenderable(this.renderer, { id: `g-${this.n}`, content: glyph, width: glyph.length, fg: o.glyphFg ?? o.fg, wrapMode: "none" }));
    const body = new TextRenderable(this.renderer, { id: `t-${this.n}`, content: text, fg: o.fg, flexGrow: 1, flexShrink: 1, wrapMode: "word", attributes: o.bold ? 1 : undefined } as any);
    row.add(body);
    this.box.add(row);
    return body;
  }

  private nested(text: string, fg: string) {
    this.nestedNode(text, fg);
    this.scrollToEnd();
  }

  private nestedNode(text: string, fg: string): TextRenderable {
    return this.line(`  ${G.nest}  `, text, { fg, glyphFg: C.dimmer });
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

/** Tool output: first lines, then "… +N lines" like Claude Code's collapsed results. */
export function summarize(detail: string, keep = 3): string {
  const lines = detail.replace(/\s+$/, "").split("\n");
  if (lines.length <= keep) return lines.join("\n");
  return lines.slice(0, keep).join("\n") + `\n… +${lines.length - keep} lines`;
}

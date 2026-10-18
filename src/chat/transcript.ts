import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { AgentId } from "../adapters/types.ts";

const COLORS = { user: "#93c5fd", agent: "#86efac", tool: "#94a3b8", system: "#fbbf24", error: "#f87171", body: "#e5e7eb", dim: "#64748b" };

export interface MessageHandle {
  append(text: string): void;
  set(text: string): void;
  tool(id: string, title: string, status: string, detail?: string): void;
  toolUpdate(id: string, status?: string, title?: string, detail?: string): void;
  text(): string;
}

/** Scrolling conversation view: user turns, agent turns with tool rows, system notes. */
export class Transcript {
  readonly box: ScrollBoxRenderable;
  private n = 0;

  constructor(private renderer: CliRenderer) {
    this.box = new ScrollBoxRenderable(renderer, {
      id: "codemax-transcript",
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      scrollY: true,
      scrollX: false,
      contentOptions: { flexDirection: "column", paddingX: 1, gap: 1 },
    });
  }

  user(text: string) {
    this.message("you", COLORS.user, text);
  }

  system(text: string, color = COLORS.system) {
    this.message("codemax", color, text);
  }

  error(text: string) {
    this.message("error", COLORS.error, text);
  }

  agent(agent: AgentId, name: string): MessageHandle {
    return this.message(name.toLowerCase(), COLORS.agent, "");
  }

  private message(label: string, color: string, initial: string): MessageHandle {
    const id = `msg-${++this.n}`;
    const wrap = new BoxRenderable(this.renderer, { id, width: "100%", flexDirection: "column" });
    wrap.add(new TextRenderable(this.renderer, { id: `${id}-h`, content: label, fg: color }));
    const body = new TextRenderable(this.renderer, { id: `${id}-b`, content: initial, fg: COLORS.body, width: "100%" });
    wrap.add(body);
    this.box.add(wrap);
    this.scrollToEnd();
    const tools = new Map<string, TextRenderable>();
    const titles = new Map<string, string>();
    // Keep plain strings per segment: TextRenderable.content may hold styled text, not a string.
    const segments: { node: TextRenderable; text: string }[] = [{ node: body, text: initial }];
    let toolsAfterText = false;
    const self = this;
    return {
      append(t) {
        if (toolsAfterText) {
          // Text after a tool row starts a new paragraph so ordering stays visible.
          const node = new TextRenderable(self.renderer, { id: `${id}-b${segments.length}`, content: t, fg: COLORS.body, width: "100%" });
          wrap.add(node);
          segments.push({ node, text: t });
          toolsAfterText = false;
        } else {
          const seg = segments[segments.length - 1]!;
          seg.text += t;
          seg.node.content = seg.text;
        }
        self.scrollToEnd();
      },
      set(t) {
        segments.splice(1).forEach((s) => s.node.destroy());
        segments[0]!.text = t;
        body.content = t;
        self.scrollToEnd();
      },
      tool(tid, title, status, detail) {
        const row = new TextRenderable(self.renderer, { id: `${id}-t-${tools.size}`, content: toolLine(title, status, detail), fg: COLORS.tool, width: "100%" });
        tools.set(tid, row);
        titles.set(tid, title);
        wrap.add(row);
        toolsAfterText = true;
        self.scrollToEnd();
      },
      toolUpdate(tid, status, title, detail) {
        const row = tools.get(tid);
        if (!row) return;
        if (title) titles.set(tid, title);
        row.content = toolLine(titles.get(tid) ?? tid, status ?? "in_progress", detail);
        if (status === "failed") row.fg = COLORS.error;
      },
      text: () => segments.map((s) => s.text).join(""),
    };
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

function toolLine(title: string, status: string, detail?: string): string {
  const mark = status === "completed" ? "✓" : status === "failed" ? "✗" : status === "in_progress" ? "…" : "⚙";
  const d = detail ? `  ·  ${detail.split("\n").slice(-1)[0]?.slice(0, 120)}` : "";
  return `${mark} ${title}${d}`;
}

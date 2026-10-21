import { debugEvent } from "../core/debuglog.ts";
import { BoxRenderable, ScrollBoxRenderable, StyledText, TextRenderable, bold, dim, fg, italic, strikethrough, stringToStyledText, type CliRenderer, type TextChunk } from "@opentui/core";
import { C, G } from "./theme.ts";
import { styleInline, styleMarkdown, styleToolOutput } from "./markdown.ts";
import { collapsedDiff, diffRows, isDiff, styleDiffRows } from "./diffview.ts";
import { fmtTime12 } from "../core/time.ts";

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
  tool(id: string, title: string, status: string, detail?: string, kind?: string): void;
  toolUpdate(id: string, status?: string, title?: string, detail?: string): void;
  /** A plan finished: one dim line keeps it in the chat after the pinned list clears. */
  tasksDone(entries: PlanEntry[]): void;
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
  /** A file read: collapsed it says how many lines were read, not what they say. */
  read?: boolean;
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
  /**
   * Startup card: brand mark, what codemax is, the project, a greeting, one line of news and
   * who makes it (a link). Notices (keep-awake, updated, debug log…) go under the card, dim,
   * so the card stays a hello.
   */
  header(lines: { title: string; subtitle: string; path: string; notes: string[]; logo?: string[]; greeting?: string; news?: string; maker?: { name: string; url: string; label: string } }) {
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
    if (lines.logo?.length) {
      // The wordmark: one line per two rows of the website's halftone grid, never wrapped.
      for (const [i, l] of lines.logo.entries()) card.add(new TextRenderable(this.renderer, { id: `h-l-${this.n}-${i}`, content: l, fg: C.accent, wrapMode: "none" } as any));
      card.add(new TextRenderable(this.renderer, { id: `h-s-${this.n}`, content: `${lines.title} · ${lines.subtitle}`, fg: C.dim }));
    } else {
      const title = new StyledText([fg(C.accent)("✻ "), fg(C.accent)(lines.title)]);
      card.add(new TextRenderable(this.renderer, { id: `h-t-${this.n}`, content: title, attributes: 1 } as any));
      card.add(new TextRenderable(this.renderer, { id: `h-s-${this.n}`, content: lines.subtitle, fg: C.dim }));
    }
    card.add(new TextRenderable(this.renderer, { id: `h-gap-${this.n}`, content: "", height: 1 }));
    card.add(new TextRenderable(this.renderer, { id: `h-p-${this.n}`, content: `cwd: ${lines.path}`, fg: C.dim, wrapMode: "char" } as any));
    if (lines.greeting || lines.news || lines.maker) card.add(new TextRenderable(this.renderer, { id: `h-gap2-${this.n}`, content: "", height: 1 }));
    if (lines.greeting) card.add(new TextRenderable(this.renderer, { id: `h-g-${this.n}`, content: lines.greeting, fg: C.text ?? C.dim, wrapMode: "word" } as any));
    if (lines.news) card.add(new TextRenderable(this.renderer, { id: `h-nw-${this.n}`, content: new StyledText([fg(C.accent)("✦ "), fg(C.dim)(lines.news)]), wrapMode: "word" } as any));
    if (lines.maker) {
      const m = lines.maker;
      card.add(new TextRenderable(this.renderer, { id: `h-m-${this.n}`, content: new StyledText([fg(C.dim)(`made by ${m.name} · `), { ...fg(C.link)(m.label), link: { url: m.url } }]), wrapMode: "word" } as any));
    }
    this.box.add(card);
    // Notices under the card: still there to read, no longer crowding the hello.
    for (const note of lines.notes) this.line(`  ${G.nest}  `, note, { fg: C.dim, glyphFg: C.dimmer });
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

  /** Your message, with the time it was sent ("· 7:25 PM", 12-hour). */
  user(text: string, ts = Date.now()) {
    // Claude Code's look: a grey "❯" and your words, normal weight, on a grey band.
    const node = this.line(`${G.prompt} `, text, { fg: undefined, glyphFg: C.dim, gap: true, bg: C.userBg });
    // `code` in your message is coloured as Claude Code colours it; the rest stays as typed.
    node.content = new StyledText([...styleInline(text), fg(C.dimmer)(`  · ${fmtTime12(ts)}`)]);
  }

  note(text: string, fg_: string = C.dim) {
    this.nested(text, fg_);
  }

  error(text: string) {
    // The error line you saw, scrubbed (debug log only when it is on).
    debugEvent("shown-error", { text });
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
    const tools = new Map<string, { glyph: TextRenderable; title: TextRenderable; result?: Collapsible; name: string; status: string; kind?: string; lastN?: number }>();
    // A run of reads, searches and listings shares one line, as in Claude Code: "Read 3 files, searched for 2 patterns".
    type Group = { glyph: TextRenderable; c: Collapsible; items: Map<string, { title: string; status: string; cls: ToolClass }> };
    let group = null as Group | null;
    const grouped = new Map<string, Group>();
    const drawGroup = (g: Group) => {
      const all = [...g.items.values()];
      g.glyph.fg = all.some((i) => i.status === "failed") ? C.error : all.every((i) => i.status === "completed") ? C.ok : C.dim;
      g.c.node.content = g.c.render("", self.expanded);
    };
    const addToGroup = (id: string, title: string, status: string, cls: ToolClass) => {
      if (!group) {
        // No bullet: a dim line under the text column, as Claude Code shows "Read 3 files".
        const glyph = new TextRenderable(self.renderer, { id: `tg-${++self.n}`, content: "  ", width: 2, fg: C.dim, wrapMode: "none" });
        const node = self.lineWithGlyph(glyph, "", { gap: true, fg: C.dim });
        const items = new Map<string, { title: string; status: string; cls: ToolClass }>();
        const c: Collapsible = { node, full: "", render: (_t, expanded) => groupText([...items.values()], expanded) };
        self.collapsibles.push(c);
        group = { glyph, c, items };
      }
      const g: Group = group;
      g.items.set(id, { title, status, cls });
      grouped.set(id, g);
      drawGroup(g);
      self.scrollToEnd();
    };
    const paragraphs: string[] = [];

    const settle = () => {
      if (para) {
        if (styleTimer) clearTimeout(styleTimer);
        styleTimer = null;
        try {
          para.node.content = styleMarkdown(para.text, self.textWidth());
        } catch {
          para.node.content = para.text;
        }
      }
    };
    const toolResult = (detail: string, failed: boolean, kind?: string): Collapsible => {
      detail = displayCap(detail);
      const c: Collapsible = {
        node: null as unknown as TextRenderable,
        full: detail,
        ...(kind === "read" && !failed ? { read: true } : {}),
        // A diff collapses to its summary and first changed lines, not its first raw lines.
        // The band of a changed line spans the transcript, less the "  ⎿  " indent and padding.
        render: (t, expanded) => (c.read && !expanded ? readSummary(t) : isDiff(t) ? styleDiffRows(expanded ? diffRows(t) : collapsedDiff(diffRows(t)), Math.max(20, self.renderer.width - 8)) : styleToolOutput(expanded ? t.replace(/\s+$/, "") : summarize(t))),
      };
      c.node = self.nestedNode("", failed ? C.error : C.dim);
      c.node.content = c.render(detail, self.expanded);
      self.collapsibles.push(c);
      return c;
    };

    return {
      append(t, messageId) {
        if (t.trim() || para) group = null;
        if (para && messageId && para.id && messageId !== para.id) {
          settle();
          para = null;
        }
        thinking = null;
        if (!para) {
          const start = t.replace(/^\n+/, "");
          const node = self.line(`${G.bullet} `, start, { glyphFg: C.assistant, gap: true });
          para = { node, text: start, id: messageId };
          paragraphs.push(start);
        } else {
          para.text += t;
          paragraphs[paragraphs.length - 1] = para.text;
        }
        const p = para;
        // Restyle at most every 80ms while streaming; the final append is always styled.
        if (!styleTimer)
          styleTimer = setTimeout(() => {
            styleTimer = null;
            // Styling runs on a timer, outside every handler: a failure keeps the plain text.
            try {
              p.node.content = styleMarkdown(p.text, self.textWidth());
            } catch {
              p.node.content = p.text;
            }
          }, 80);
        self.scrollToEnd();
      },
      thought(t, messageId) {
        group = null;
        if (thinking && messageId && thinking.id && messageId !== thinking.id) thinking = null;
        if (!thinking) {
          settle();
          para = null;
          const c: Collapsible = {
            node: null as unknown as TextRenderable,
            full: "",
            render: (text, expanded) => {
              // Claude Code keeps reasoning out of the normal view; ctrl+o shows it.
              const body = text.trim();
              // A short preview: some agents (OpenCode, Cursor) say what they are doing only here.
              if (!expanded) return new StyledText([fg(C.thought)(italic(body ? "Thinking… " : "Thinking…")), fg(C.thought)(italic(clip(body, 2, 160)))]);
              return new StyledText([fg(C.thought)(italic("Thinking… ")), fg(C.thought)(italic(body))]);
            },
          };
          c.node = self.line(`${G.thought} `, "", { glyphFg: C.thought, gap: true });
          self.collapsibles.push(c);
          thinking = { node: c.node, c, id: messageId };
        }
        thinking.c.full += t;
        thinking.node.content = thinking.c.render(thinking.c.full, self.expanded);
        self.scrollToEnd();
      },
      plan(entries) {
        if (!entries.length) return;
        group = null;
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
          planNode = self.line(`${G.bullet} `, "", { glyphFg: C.tool, gap: true });
          planNode.content = content;
        }
        self.scrollToEnd();
      },
      tool(id, title, status, detail, kind) {
        settle();
        para = null;
        thinking = null;
        if (self.gone) return;
        const cls = toolClass(title, kind);
        if (cls) return addToGroup(id, title, status, cls);
        // A tool announced by its bare name ("bash", then its command) may still join the run.
        if (!/^\s*[A-Za-z_-]+\s*$/.test(title)) group = null;
        const glyph = new TextRenderable(self.renderer, { id: `tg-${++self.n}`, content: `${G.bullet} `, width: 2, fg: toolColor(status), wrapMode: "none" });
        const title_ = self.lineWithGlyph(glyph, title, { gap: true });
        title_.content = toolTitle(title);
        const entry = { glyph, title: title_, name: title, status, kind, result: undefined as Collapsible | undefined, lastN: undefined as number | undefined };
        tools.set(id, entry);
        if (detail) entry.result = toolResult(detail, status === "failed", kind);
        entry.lastN = self.n;
        self.scrollToEnd();
      },
      toolUpdate(id, status, title, detail) {
        const g = grouped.get(id);
        if (g) {
          const it = g.items.get(id)!;
          if (title) it.title = title;
          if (status) it.status = status;
          drawGroup(g);
          return;
        }
        const e = tools.get(id);
        if (!e) return;
        // "bash" became a read-only command and nothing came after it: it joins the run of reads.
        const cls = title ? toolClass(title, e.kind) : null;
        if (cls && e.lastN === self.n && !e.result) {
          (e.title as any).parent?.destroyRecursively?.();
          tools.delete(id);
          return addToGroup(id, title!, status ?? e.status, cls);
        }
        if (title) {
          e.name = title;
          e.title.content = toolTitle(title);
        }
        if (status) {
          e.status = status;
          e.glyph.fg = toolColor(status);
        }
        if (status === "failed") e.title.fg = C.error;
        if (detail) {
          if (e.result) {
            detail = displayCap(detail);
            e.result.full = detail;
            e.result.node.content = e.result.render(detail, self.expanded);
          } else e.result = toolResult(detail, status === "failed", e.kind);
        }
      },
      tasksDone(entries) {
        group = null;
        settle();
        para = null;
        thinking = null;
        const n = entries.length;
        self.line(`${G.done_} `, `${n} task${n === 1 ? "" : "s"} done: ${entries.map((e) => e.content).join(", ")}`, { fg: C.dim, glyphFg: C.ok, gap: true });
        self.scrollToEnd();
      },
      footer(text) {
        group = null;
        settle();
        para = null;
        thinking = null;
        self.line(`${G.done} `, text, { fg: C.dim, glyphFg: C.dim, gap: true });
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

  /** `gap`: one blank line before it (Claude Code puts one before every block, none before results). `bg`: a band behind the whole row. */
  private line(glyph: string, text: string, o: { fg?: string; glyphFg?: string; bold?: boolean; gap?: boolean; bg?: string } = {}): TextRenderable {
    if (this.gone) return { content: "" } as unknown as TextRenderable;
    const g = glyph ? new TextRenderable(this.renderer, { id: `g-${++this.n}`, content: glyph, width: glyph.length, fg: o.glyphFg ?? o.fg, wrapMode: "none" }) : null;
    return this.lineWithGlyph(g, text, o);
  }

  private lineWithGlyph(glyph: TextRenderable | null, text: string, o: { fg?: string; bold?: boolean; gap?: boolean; bg?: string } = {}): TextRenderable {
    if (this.gone) return { content: "" } as unknown as TextRenderable;
    const row = new BoxRenderable(this.renderer, { id: `row-${++this.n}`, width: "100%", flexDirection: "row", ...(o.gap ? { marginTop: 1 } : {}), ...(o.bg ? { backgroundColor: o.bg } : {}) });
    if (glyph) row.add(glyph);
    const body = new TextRenderable(this.renderer, { id: `t-${this.n}`, content: text, fg: o.fg, flexGrow: 1, flexShrink: 1, wrapMode: "word", attributes: o.bold ? 1 : undefined } as any);
    row.add(body);
    this.box.add(row);
    return body;
  }

  /** Columns a paragraph's text has: the transcript's padding and the bullet column taken off. */
  private textWidth(): number {
    return Math.max(20, this.renderer.width - 4);
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
export function summarize(detail: string, keep = 5): string {
  // Each kept line at most 300 characters: one minified line must not fill the screen.
  const lines = detail.replace(/\s+$/, "").split("\n").map((l) => (l.length > 300 ? `${l.slice(0, 299)}…` : l));
  if (lines.length <= keep) return lines.join("\n");
  return lines.slice(0, keep).join("\n") + `\n… +${lines.length - keep} lines (ctrl+o to expand)`;
}

/**
 * What the transcript keeps of one tool result: its first and last 100 KB. A long session
 * of `cat` and test runs would otherwise hold every byte on screen (the journal keeps its own copy).
 */
const DISPLAY_KEEP = 100_000;
export function displayCap(s: string): string {
  return s.length <= 2 * DISPLAY_KEEP ? s : `${s.slice(0, DISPLAY_KEEP)}\n… ${s.length - 2 * DISPLAY_KEEP} characters not shown …\n${s.slice(-DISPLAY_KEEP)}`;
}

/** "Read src/auth.ts" → **Read** src/auth.ts: the tool's name bold, its arguments normal (Claude Code's header). */
type ToolClass = "read" | "search" | "list";

/** Reads, searches and listings (the agent's own tools or read-only shell commands) are grouped; anything that may change something is not. */
export function toolClass(title: string, kind?: string): ToolClass | null {
  let t = title.trim().replace(/^`+|`+$/g, "").replace(/^(Bash|Shell|Terminal|Run)\((.*)\)$/s, "$2").replace(/^\$\s*/, "").trim();
  // Codex and others wrap commands in a login shell: /bin/zsh -lc 'grep …'.
  const wrapped = t.match(/^(?:\/\S+\/)?(?:ba|z|)sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  if (wrapped) t = wrapped[2]!;
  // The agent's own read and search tools.
  if (kind === "read" || /^(Read|View|ReadFile|view_file|read_file)\b/.test(t)) return "read";
  if (kind === "search" || /^(Grep|Glob|Search|Find|grep_search|find_by_name|codebase_search)\b/.test(t)) return "search";
  if (/^(LS|List|list_dir|list_directory)\b/.test(t)) return "list";
  // A shell command: every part of a chain or pipe must be read-only (a `cd` first is fine).
  const clean = t.replace(/\s\d?>\s*\/dev\/null|\s2>&1/g, " ");
  if (/[<>`]|\$\(/.test(clean)) return null; // redirections and substitutions may write or run anything
  const parts = clean.split(/&&|\|\||;|\|/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  let cls: ToolClass | null = null;
  const rank = { list: 0, read: 1, search: 2 } as const;
  for (const part of parts) {
    const c = shellClass(part);
    if (c === undefined) return null;
    if (c && (!cls || rank[c] > rank[cls])) cls = c;
  }
  return cls;
}

/** One command of a chain: its class, null for harmless helpers (cd, sort, head after a pipe…), undefined when it may change something. */
function shellClass(cmd: string): ToolClass | null | undefined {
  const [name, ...rest] = cmd.split(/\s+/);
  const args = rest.join(" ");
  switch (name) {
    case "grep": case "rg": case "ag": case "ack": case "egrep": case "fgrep":
      return "search";
    case "find": case "fd":
      return /-(exec|delete|ok)\b/.test(args) ? undefined : "search";
    case "cat": case "bat": case "nl": case "less": case "head": case "tail": case "wc": case "file": case "stat": case "jq":
      return "read";
    case "sed":
      return /(^|\s)-[a-zA-Z]*i/.test(args) ? undefined : "read";
    case "awk":
      return /system\(|>\s*"/.test(args) ? undefined : "read";
    case "ls": case "tree": case "eza": case "exa": case "du": case "df": case "pwd": case "which": case "type":
      return "list";
    case "git":
      return /^(status|log|diff|show|grep|branch|blame|ls-files|rev-parse|remote -v)\b/.test(args) ? (/^grep\b/.test(args) ? "search" : "read") : undefined;
    case "cd": case "sort": case "uniq": case "cut": case "tr": case "echo": case "printf": case "true": case "column":
      return null;
    default:
      return undefined;
  }
}

/** "Read 3 files, searched for 2 patterns" (present tense while any is still running), each one listed when expanded. */
function groupText(items: { title: string; status: string; cls: ToolClass }[], expanded: boolean): StyledText {
  const running = items.some((i) => i.status !== "completed" && i.status !== "failed");
  const n = (c: ToolClass) => items.filter((i) => i.cls === c).length;
  const order = [...new Set(items.map((i) => i.cls))];
  const words: Record<ToolClass, [string, string, string, string]> = {
    read: ["read", "reading", "file", "files"],
    search: ["searched for", "searching for", "pattern", "patterns"],
    list: ["listed", "listing", "directory", "directories"],
  };
  const parts = order.map((c) => {
    const [done, now, one, many] = words[c];
    return `${running ? now : done} ${n(c)} ${n(c) === 1 ? one : many}`;
  });
  let text = parts.join(", ");
  text = text.charAt(0).toUpperCase() + text.slice(1) + (running ? "…" : "");
  const failed = items.filter((i) => i.status === "failed").length;
  // The counts in bold, as Claude Code shows "Read **3** files".
  const chunks: TextChunk[] = [];
  for (const piece of text.split(/(\d+)/)) {
    if (/^\d+$/.test(piece)) chunks.push(bold(piece));
    else if (piece) chunks.push(...stringToStyledText(piece).chunks);
  }
  if (failed) chunks.push(fg(C.error)(` · ${failed} failed`));
  if (!expanded) {
    // The latest step, so a long run of reads still shows what it is doing (ctrl+o lists them all).
    const last = items.at(-1)!;
    if (running) chunks.push(...stringToStyledText("\n").chunks, fg(C.dimmer)(`  ${G.nest}  `), dim(last.title.replace(/\s+/g, " ").slice(0, 120)));
    return new StyledText(chunks);
  }
  for (const i of items) chunks.push(...stringToStyledText("\n").chunks, fg(C.dimmer)(`  ${G.nest}  `), i.status === "failed" ? fg(C.error)(i.title) : dim(i.title.replace(/\s+/g, " ")));
  return new StyledText(chunks);
}

function toolTitle(title: string): StyledText {
  const m = title.match(/^([A-Za-z][\w.-]*)(\(.*\)|\s.*)?$/s);
  if (!m) return new StyledText(stringToStyledText(title).chunks);
  return new StyledText([bold(m[1]!), ...(m[2] ? stringToStyledText(m[2]).chunks : [])]);
}

/** A file read, collapsed: "Read 42 lines" (ctrl+o shows the content), as Claude Code shows reads. */
function readSummary(content: string): StyledText {
  const body = content.replace(/\n+$/, "");
  const n = body ? body.split("\n").length : 0;
  return new StyledText([...stringToStyledText("Read ").chunks, bold(String(n)), ...stringToStyledText(` line${n === 1 ? "" : "s"}`).chunks, dim(" (ctrl+o to expand)")]);
}

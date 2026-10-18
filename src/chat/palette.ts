import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { C, G } from "./theme.ts";

export interface PaletteItem {
  /** What is matched against the filter and shown first (e.g. "/switch" or "claude"). */
  label: string;
  description?: string;
  /** Optional right-aligned hint (session age, quota, version). */
  hint?: string;
  value: string;
  disabled?: boolean;
  /** Tie-breaker among equal matches; higher sorts first (built-ins over agent commands). */
  weight?: number;
}

export interface PaletteOptions {
  items: PaletteItem[];
  /** Initial filter text (e.g. "sw" when the user already typed "/sw"). */
  filter?: string;
  /** Header line shown above the rows (e.g. "Switch agent"). */
  title?: string;
  onPick: (item: PaletteItem) => void;
  onClose: () => void;
  /** Rows to show at most. */
  maxRows?: number;
}

/**
 * The one list UI codemax uses everywhere: slash commands, /switch, /mode.
 * Anchored above the input like Claude Code's command menu: `❯ /name   description`.
 * Filtering is prefix-or-word based so typos never auto-run anything.
 */
export class Palette {
  readonly box: BoxRenderable;
  private rows: TextRenderable[] = [];
  private titleRow: TextRenderable;
  private cursor = 0;
  private filter: string;
  private matches: PaletteItem[] = [];
  private maxRows: number;

  constructor(
    private renderer: CliRenderer,
    private opts: PaletteOptions,
    private anchor: () => { top: number; width: number },
  ) {
    this.filter = opts.filter ?? "";
    this.maxRows = opts.maxRows ?? 8;
    this.box = new BoxRenderable(renderer, { id: `palette-${Date.now()}`, position: "absolute", left: 0, top: 0, width: "100%", zIndex: 800, flexDirection: "column", paddingX: 1, backgroundColor: C.panel });
    this.titleRow = new TextRenderable(renderer, { content: "", fg: C.dim, bg: C.panel, wrapMode: "none", truncate: true, width: "100%" });
    this.box.add(this.titleRow);
    for (let i = 0; i < this.maxRows; i++) {
      const t = new TextRenderable(renderer, { content: "", bg: C.panel, wrapMode: "none", truncate: true, width: "100%" });
      this.rows.push(t);
      this.box.add(t);
    }
    this.setFilter(this.filter);
  }

  setFilter(text: string) {
    this.filter = text;
    const q = text.trim().toLowerCase();
    const scored = this.opts.items
      .map((it) => ({ it, s: score(it, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (b.it.weight ?? 0) - (a.it.weight ?? 0) || a.it.label.localeCompare(b.it.label));
    this.matches = scored.map((x) => x.it);
    this.cursor = Math.min(this.cursor, Math.max(0, this.matches.length - 1));

    this.render();
  }

  /** Replace items without losing the highlighted row (matched by value). */
  setItems(items: PaletteItem[]) {
    const keep = this.current?.value;
    this.opts.items = items;
    this.setFilter(this.filter);
    const i = this.matches.findIndex((m) => m.value === keep);
    if (i >= 0) {
      this.cursor = i;
      this.render();
    }
  }

  get current(): PaletteItem | undefined {
    return this.matches[this.cursor];
  }

  render() {
    const { top, width } = this.anchor();
    const visible = this.matches.slice(0, this.maxRows);
    const shown = visible.length;
    const titleLines = this.opts.title ? 1 : 0;
    this.titleRow.visible = !!this.opts.title;
    this.titleRow.content = this.opts.title ?? "";
    this.box.height = shown + titleLines + (shown === 0 ? 1 : 0);
    this.box.top = Math.max(0, top - this.box.height);
    const labelW = Math.min(28, Math.max(10, ...visible.map((v) => v.label.length + 2)));
    this.rows.forEach((row, i) => {
      const it = visible[i];
      if (!it) {
        if (i === 0 && shown === 0) {
          row.visible = true;
          row.content = this.filter ? `  no matches for "${this.filter}"` : "  nothing here";
          row.fg = C.dim;
          return;
        }
        row.visible = false;
        return;
      }
      row.visible = true;
      const sel = i === this.cursor;
      const label = pad(it.label, labelW);
      const desc = it.description ?? "";
      const hint = it.hint ? `  ${it.hint}` : "";
      const bodyW = Math.max(10, width - 2 - 2 - labelW - hint.length);
      row.content = `${sel ? G.prompt : " "} ${label}${desc.slice(0, bodyW).padEnd(bodyW)}${hint}`;
      row.fg = it.disabled ? C.dimmer : sel ? C.accent : undefined;
    });
  }

  /** Returns true when the key was consumed. */
  handleKey(key: KeyEvent): boolean {
    const n = key.name;
    if (n === "up" || (n === "p" && key.ctrl)) return this.move(-1);
    if (n === "down" || (n === "n" && key.ctrl)) return this.move(1);
    if (n === "tab" && !key.shift) return this.move(1);
    if (n === "escape") {
      this.opts.onClose();
      return true;
    }
    if (n === "return") {
      const cur = this.current;
      if (cur && !cur.disabled) this.opts.onPick(cur);
      else if (!cur) this.opts.onClose();
      return true;
    }
    return false;
  }

  private move(d: number): boolean {
    const n = Math.min(this.matches.length, this.maxRows);
    if (!n) return true;
    this.cursor = (this.cursor + d + n) % n;
    this.render();
    return true;
  }

  destroy() {
    this.box.destroyRecursively();
  }
}

/** 3 = prefix match, 2 = word-start match (after : _ - /), 1 = substring in description; 0 = no match. */
function score(it: PaletteItem, q: string): number {
  if (!q) return 1;
  const label = it.label.toLowerCase().replace(/^\//, "");
  const needle = q.replace(/^\//, "");
  if (label.startsWith(needle)) return 3;
  if (label.split(/[:_\-/ ]/).some((w) => w.startsWith(needle))) return 2;
  if ((it.description ?? "").toLowerCase().includes(needle)) return 1;
  return 0;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length);
}

import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import type { MenuAction, MenuRow, MenuState } from "../core/menu.ts";
import { isExhausted, quotaLabel } from "../core/quota.ts";
import { hotkeyLabel } from "../config.ts";

const ROWS_MAX = 12;

/** The codemax agent menu, drawn as an overlay box above the agent pane. */
export class MenuOverlay {
  readonly box: BoxRenderable;
  private lines: TextRenderable[] = [];
  private cursor = 0;
  private fresh = false;
  private state: MenuState;

  constructor(
    private renderer: CliRenderer,
    state: MenuState,
  ) {
    this.state = state;
    const i = state.rows.findIndex((r) => r.adapter.id !== state.current && r.installed && !isExhausted(r.quota));
    this.cursor = i >= 0 ? i : 0;
    this.box = new BoxRenderable(renderer, {
      id: "codemax-menu",
      position: "absolute",
      top: 1,
      left: 2,
      zIndex: 1000,
      border: true,
      borderStyle: "rounded",
      borderColor: "#22d3ee",
      backgroundColor: "#0b1020",
      title: " codemax ",
      titleColor: "#22d3ee",
      paddingX: 1,
      flexDirection: "column",
    });
    for (let k = 0; k < ROWS_MAX + 5; k++) {
      const t = new TextRenderable(renderer, { id: `codemax-menu-line-${k}`, content: "", fg: "#e5e7eb" });
      this.lines.push(t);
      this.box.add(t);
    }
    this.render();
  }

  update(patch: Partial<MenuState>) {
    Object.assign(this.state, patch);
    this.render();
  }

  render() {
    const width = Math.min(Math.max(40, this.renderer.width - 6), 104);
    this.box.width = width;
    const out: { text: string; fg?: string }[] = [];
    out.push({ text: this.state.title, fg: "#94a3b8" });
    if (this.state.notice) out.push({ text: `! ${this.state.notice}`, fg: "#fbbf24" });
    out.push({ text: "" });
    this.state.rows.slice(0, ROWS_MAX).forEach((r, i) => {
      const sel = i === this.cursor;
      const name = r.adapter.name + (r.adapter.id === this.state.current ? " (current)" : "");
      const inst = r.installed ? `installed${r.version ? " " + r.version : ""}` : "not found";
      const sess = r.session ? `session ${r.session.id.slice(0, 8)}… ${ago(r.session.lastUsedAt)}` : "no session";
      const q = quotaLabel(r.quota);
      const line = `${sel ? "›" : " "} ${i + 1}. ${pad(name, 24)} ${pad(inst, 24)} ${pad(sess, 30)} ${q}`;
      out.push({ text: line.slice(0, width - 4), fg: sel ? "#22d3ee" : !r.installed ? "#64748b" : isExhausted(r.quota) ? "#f87171" : "#e5e7eb" });
    });
    out.push({ text: "" });
    out.push({ text: `↑/↓ or 1-9 pick · Enter switch · f: ${this.fresh ? "fresh session" : "resume if a session exists"}`, fg: "#94a3b8" });
    out.push({ text: `${this.state.canClose ? "Esc/q back to agent · " : ""}x quit codemax · hotkey ${hotkeyLabel(this.state.hotkeys)}`, fg: "#94a3b8" });
    this.lines.forEach((l, i) => {
      const row = out[i];
      l.content = row?.text ?? "";
      l.fg = row?.fg ?? "#e5e7eb";
      l.visible = i < out.length;
    });
    this.box.height = out.length + 2;
  }

  handleKey(key: KeyEvent): MenuAction | null {
    const n = key.name;
    if (n === "up" || n === "k") this.move(-1);
    else if (n === "down" || n === "j") this.move(1);
    else if (n === "f") {
      this.fresh = !this.fresh;
      this.render();
    } else if (n === "return" || n === "linefeed") return this.pick(this.cursor);
    else if (/^[1-9]$/.test(n)) return this.pick(Number(n) - 1);
    else if (n === "x" || (n === "c" && key.ctrl)) return { kind: "quit" };
    else if ((n === "escape" || n === "q") && this.state.canClose) return { kind: "close" };
    return null;
  }

  private move(d: number) {
    const n = Math.min(this.state.rows.length, ROWS_MAX);
    this.cursor = (this.cursor + d + n) % n;
    this.render();
  }

  private pick(i: number): MenuAction | null {
    const r = this.state.rows[i];
    if (!r) return null;
    if (!r.installed) {
      this.update({ notice: `${r.adapter.name} is not installed (looked for "${r.adapter.bin}" on PATH).` });
      return null;
    }
    return { kind: "switch", agent: r.adapter.id, fresh: this.fresh };
  }

  destroy() {
    this.box.destroyRecursively();
  }
}

export type { MenuRow };

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + "…" : s + " ".repeat(n - s.length);
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

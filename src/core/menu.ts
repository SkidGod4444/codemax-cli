import type { Adapter, AgentId, QuotaStatus, SessionRef } from "../adapters/types.ts";
import { ALT_OFF, ALT_ON, CSI, out, termSize } from "./terminal.ts";
import { quotaLabel } from "./quota.ts";
import { hotkeyLabel } from "../config.ts";

export interface MenuRow {
  adapter: Adapter;
  installed: boolean;
  version?: string;
  session?: SessionRef;
  quota?: QuotaStatus;
}

export type MenuAction =
  | { kind: "switch"; agent: AgentId; fresh: boolean }
  | { kind: "close" }
  | { kind: "quit" };

export interface MenuState {
  title: string;
  rows: MenuRow[];
  current?: AgentId;
  notice?: string;
  /** When the current agent has exited, "close" is not offered. */
  canClose: boolean;
  hotkey: number;
}

const dim = (s: string) => `${CSI}2m${s}${CSI}22m`;
const bold = (s: string) => `${CSI}1m${s}${CSI}22m`;
const red = (s: string) => `${CSI}31m${s}${CSI}39m`;
const green = (s: string) => `${CSI}32m${s}${CSI}39m`;
const yellow = (s: string) => `${CSI}33m${s}${CSI}39m`;
const cyan = (s: string) => `${CSI}36m${s}${CSI}39m`;

/** Full-screen codemax menu drawn on the alternate screen. */
export class Menu {
  private fresh = false;
  private cursor = 0;
  constructor(private state: MenuState) {
    const i = state.rows.findIndex((r) => r.adapter.id !== state.current && r.installed && !r.quota?.exhausted);
    this.cursor = i >= 0 ? i : 0;
  }

  open() {
    out(ALT_ON);
    this.render();
  }

  close() {
    out(ALT_OFF);
  }

  update(patch: Partial<MenuState>) {
    Object.assign(this.state, patch);
    this.render();
  }

  render() {
    const { cols } = termSize();
    const w = Math.min(cols - 2, 96);
    const L: string[] = [];
    L.push(bold(cyan(" codemax ")) + dim(`— ${this.state.title}`));
    L.push(dim("─".repeat(w)));
    if (this.state.notice) L.push(yellow(" ! " + this.state.notice), "");
    this.state.rows.forEach((r, i) => {
      const sel = i === this.cursor ? cyan("›") : " ";
      const num = dim(`${i + 1}.`);
      const name = r.adapter.id === this.state.current ? bold(r.adapter.name) + dim(" (current)") : r.adapter.name;
      const inst = r.installed ? green("installed") + (r.version ? dim(` ${r.version}`) : "") : red("not found");
      const sess = r.session ? dim(`session ${r.session.id.slice(0, 8)}… ${ago(r.session.lastUsedAt)}`) : dim("no session");
      const q = r.quota ? (r.quota.exhausted ? red(quotaLabel(r.quota)) : yellow(quotaLabel(r.quota))) : "";
      L.push(` ${sel} ${num} ${pad(name, 22)} ${pad(inst, 28)} ${pad(sess, 34)} ${q}`);
    });
    L.push("");
    const mode = this.fresh ? yellow("fresh session") : green("resume if a session exists");
    L.push(dim(" ↑/↓ or 1-9 pick · Enter switch · f toggle: ") + mode);
    L.push(dim(` ${this.state.canClose ? "Esc/q back to agent · " : ""}x quit codemax · hotkey ${hotkeyLabel(this.state.hotkey)}`));
    out(`${CSI}H${CSI}2J` + L.map((l) => l + `${CSI}K`).join("\r\n"));
  }

  /** Returns an action when the key completes one; null otherwise. */
  handleKey(bytes: Uint8Array): MenuAction | null {
    const s = Buffer.from(bytes).toString("utf8");
    // A chunk may hold several keys typed quickly; escape sequences stay whole.
    if (s.length > 1 && !s.startsWith("\x1b")) {
      for (const ch of s) {
        const a = this.handleKey(Buffer.from(ch));
        if (a) return a;
      }
      return null;
    }
    if (s === "\x1b[A" || s === "k") this.move(-1);
    else if (s === "\x1b[B" || s === "j") this.move(1);
    else if (s === "f") {
      this.fresh = !this.fresh;
      this.render();
    } else if (s === "\r" || s === "\n") return this.pick(this.cursor);
    else if (/^[1-9]$/.test(s)) return this.pick(Number(s) - 1);
    else if (s === "x" || s === "\x03") return { kind: "quit" };
    else if ((s === "\x1b" || s === "q") && this.state.canClose) return { kind: "close" };
    return null;
  }

  private move(d: number) {
    const n = this.state.rows.length;
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
}

function pad(s: string, n: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return visible >= n ? s : s + " ".repeat(n - visible);
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { SubagentEvent } from "../engines/types.ts";
import { C, G } from "./theme.ts";

interface Row {
  id: string;
  name: string;
  task?: string;
  activity?: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  endedAt?: number;
}

/** Finished agents stay visible this long, then leave the list. */
const LINGER_MS = 4000;
const MAX_ROWS = 4;

/**
 * The agents the main agent spawned (Claude's Task/Agent tool, OpenCode's
 * task tool…), listed under the prompt the way Claude Code lists them:
 *
 *   ⏺ 2 agents running
 *     ⎿ Explore · find where auth is checked · Grep(requireAuth) · 12s
 *     ⎿ general-purpose · update the tests · Edit(test/auth.test.ts) · 4s
 *
 * Each row shows the agent's type, its task and its latest step. A finished
 * agent shows ✓ (or ✗) for a few seconds and then leaves the list.
 */
export class SubagentPanel {
  readonly box: BoxRenderable;
  private rows = new Map<string, Row>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, { id: "subagents", width: "100%", flexShrink: 0, flexDirection: "column", paddingX: 1 });
    this.box.visible = false;
  }

  get running(): number {
    return [...this.rows.values()].filter((r) => r.status === "running").length;
  }

  update(e: SubagentEvent) {
    const prev = this.rows.get(e.id);
    const row: Row = prev ?? { id: e.id, name: e.name || "agent", status: "running", startedAt: Date.now() };
    if (e.name) row.name = e.name;
    if (e.task) row.task = e.task;
    if (e.activity) row.activity = e.activity;
    if (e.status) {
      if (e.status !== "running" && row.status === "running") row.endedAt = Date.now();
      row.status = e.status;
    }
    this.rows.set(e.id, row);
    this.render();
  }

  /** The turn ended: anything still marked running is over too. */
  endAll() {
    for (const r of this.rows.values()) if (r.status === "running") {
      r.status = "done";
      r.endedAt = Date.now();
    }
    this.render();
  }

  clear() {
    this.rows.clear();
    this.render();
  }

  render() {
    const now = Date.now();
    for (const [id, r] of this.rows) if (r.endedAt && now - r.endedAt > LINGER_MS) this.rows.delete(id);
    for (const c of [...this.box.getChildren()]) c.destroyRecursively();
    const list = [...this.rows.values()];
    this.box.visible = list.length > 0;
    if (!list.length) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    // Tick once a second for the elapsed times and to let finished rows leave.
    this.timer ??= setInterval(() => {
      try {
        this.render();
      } catch {
        /* never break the screen */
      }
    }, 1000);
    const running = this.running;
    this.box.add(new TextRenderable(this.renderer, { content: `${G.bullet} ${running ? `${running} agent${running === 1 ? "" : "s"} running` : `${list.length} agent${list.length === 1 ? "" : "s"} finished`}`, fg: running ? C.accent : C.dim, wrapMode: "none", truncate: true, width: "100%" } as any));
    const shown = [...list.filter((r) => r.status === "running"), ...list.filter((r) => r.status !== "running")].slice(0, MAX_ROWS);
    for (const r of shown) {
      const mark = r.status === "done" ? "✓ " : r.status === "failed" ? "✗ " : "";
      const secs = Math.round(((r.endedAt ?? now) - r.startedAt) / 1000);
      const parts = [r.name, r.task, r.status === "running" ? r.activity : undefined, `${secs}s`].filter(Boolean).map((p) => String(p).replace(/\s+/g, " ").trim());
      this.box.add(new TextRenderable(this.renderer, { content: `  ${G.nest} ${mark}${parts.join(" · ")}`, fg: r.status === "failed" ? C.error : r.status === "done" ? C.dim : undefined, wrapMode: "none", truncate: true, width: "100%" } as any));
    }
    if (list.length > shown.length) this.box.add(new TextRenderable(this.renderer, { content: `    + ${list.length - shown.length} more`, fg: C.dimmer, wrapMode: "none" } as any));
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

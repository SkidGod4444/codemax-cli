import { basename } from "node:path";
import type { AgentId } from "../adapters/types.ts";

/**
 * What the terminal around codemax shows about it: the tab's agent badge and
 * running / waiting / done status, and a notification when you are needed.
 *
 * - Warp: its "cli-agent" channel (OSC 777 with the title `warp://cli-agent`
 *   and a JSON body). Warp only has built-in logos, so the tab shows the agent
 *   codemax is driving (Claude Code, Codex, Gemini, OpenCode, Cursor, Copilot);
 *   other agents get status without a badge. Warp raises its own notifications
 *   from these events, so codemax sends none of its own there.
 * - Other terminals: OSC 7501 program status (working / blocked / done), which
 *   terminals that lack it ignore, and a desktop notification when an agent
 *   waits for you or a long turn ends while the terminal is not focused.
 *
 * Every write goes through the renderer (`TerminalSink`), never straight to
 * stdout, so it can never land inside a frame.
 */
export interface TerminalSink {
  status(s: { state: "idle" | "working" | "blocked" | "done" | "error" | "clear" }): void;
  notify(message: string, title?: string): void;
}

/** Agent names Warp has a logo for (checked against Warp 2026.09). */
export const WARP_AGENTS: Partial<Record<AgentId, string>> = { claude: "claude", codex: "codex", gemini: "gemini", opencode: "opencode", cursor: "cursor", copilot: "copilot" };

// Warp builds that advertise the protocol but drop it (from Warp's own adapters).
const WARP_BROKEN: Record<string, string> = { stable: "v0.2026.03.25.08.24.stable_05", preview: "v0.2026.03.25.08.24.preview_05" };

export function warpSupported(env: Record<string, string | undefined> = process.env): boolean {
  if (!env.WARP_CLI_AGENT_PROTOCOL_VERSION || !env.WARP_CLIENT_VERSION) return false;
  const channel = Object.keys(WARP_BROKEN).find((c) => env.WARP_CLIENT_VERSION!.includes(c));
  return !channel || env.WARP_CLIENT_VERSION > WARP_BROKEN[channel]!;
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + "..." : s);

export class TerminalStatus {
  private agent: { id: AgentId; name: string; session: string } | null = null;
  private lastQuery = "";
  private readonly warp: boolean;
  /** True/false once the terminal reports focus; null when it never has. */
  focused: boolean | null = null;

  constructor(
    private sink: TerminalSink,
    private o: { cwd: string; env?: Record<string, string | undefined>; enabled: () => boolean; notify: () => boolean },
  ) {
    this.warp = warpSupported(o.env ?? process.env);
  }

  /** An agent's session is ready (start, switch, handoff). */
  started(id: AgentId, name: string, session = "") {
    this.agent = { id, name, session };
    this.warpEvent("session_start");
    this.status("idle");
  }

  prompt(text: string) {
    this.lastQuery = text;
    this.warpEvent("prompt_submit", { query: cut(text, 200) });
    this.status("working");
  }

  toolDone(tool: string) {
    this.warpEvent("tool_complete", { tool_name: tool });
  }

  /** The agent waits for you: a permission prompt or a question. */
  waiting(kind: "permission" | "question", summary: string, tool?: string, input?: unknown) {
    if (kind === "question") this.warpEvent("question_asked", { tool_name: tool ?? "question", summary: cut(summary, 200) });
    else this.warpEvent("permission_request", { summary: cut(summary, 200), tool_name: tool ?? "tool", tool_input: input ?? {} });
    this.status("blocked");
    this.desktop(`${this.agent?.name ?? "The agent"} ${kind === "question" ? "has a question" : "needs your approval"}: ${cut(summary, 120)}`);
  }

  answered(allowed: boolean) {
    if (allowed) this.warpEvent("permission_replied");
    this.status("working");
  }

  turnEnded(o: { reply: string; ms: number; error?: boolean; longMs: number }) {
    this.warpEvent("stop", { query: cut(this.lastQuery, 200), response: cut(o.reply, 200), transcript_path: "" });
    this.status(o.error ? "error" : "done");
    if (o.ms >= o.longMs) this.desktop(`${this.agent?.name ?? "The agent"} finished: ${cut(o.reply.replace(/\s+/g, " ").trim() || "done", 120)}`);
  }

  close() {
    this.status("clear");
  }

  private status(state: Parameters<TerminalSink["status"]>[0]["state"]) {
    if (!this.o.enabled()) return;
    try {
      this.sink.status({ state });
    } catch {
      /* a terminal that refuses it must never break codemax */
    }
  }

  private warpEvent(event: string, extra: Record<string, unknown> = {}) {
    const slug = this.agent && WARP_AGENTS[this.agent.id];
    if (!this.warp || !slug || !this.o.enabled()) return;
    const body = { v: 1, agent: slug, event, session_id: this.agent!.session, cwd: this.o.cwd, project: basename(this.o.cwd), ...extra };
    try {
      this.sink.notify(JSON.stringify(body), "warp://cli-agent");
    } catch {
      /* ignore */
    }
  }

  /** A plain desktop notification, only when you are not looking (Warp sends its own). */
  private desktop(message: string) {
    if (this.focused === true || !this.o.notify()) return;
    if (this.warp && this.agent && WARP_AGENTS[this.agent.id] && this.o.enabled()) return;
    try {
      this.sink.notify(message, "codemax");
    } catch {
      /* ignore */
    }
  }
}

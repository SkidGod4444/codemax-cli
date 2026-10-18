import { join } from "node:path";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureDir, projectDir } from "./paths.ts";
import type { AgentId, QuotaStatus, SessionRef, Turn } from "../adapters/types.ts";

export interface LedgerEvent {
  ts: number;
  kind: "start" | "switch" | "exit" | "quota" | "note";
  agent?: AgentId;
  to?: AgentId;
  detail?: string;
  diffStat?: string;
}

/**
 * Project ledger in ~/.codemax/projects/<escaped-cwd>/.
 *  - turns.jsonl     normalized conversation turns from every agent
 *  - sessions.json   latest vendor session per agent (for native resume)
 *  - events.jsonl    switches, quota detections, notes
 *  - summary.md      optional hand- or agent-written compacted summary
 */
export class Ledger {
  readonly dir: string;
  private seen = new Set<string>();

  constructor(readonly cwd: string, dir?: string) {
    this.dir = ensureDir(dir ?? projectDir(cwd));
    for (const t of this.turns()) this.seen.add(turnKey(t));
  }

  private file(name: string) {
    return join(this.dir, name);
  }

  /**
   * Recorded turns. A streaming assistant turn is appended again each time it
   * grows (its key includes the text length), so collapse by identity keeping
   * the last, longest copy.
   */
  turns(): Turn[] {
    const byId = new Map<string, Turn>();
    for (const t of readJsonl<Turn>(this.file("turns.jsonl"))) byId.set(turnId(t), t);
    return [...byId.values()].sort((a, b) => a.ts - b.ts);
  }

  /** Append turns not already recorded. Returns how many were new. */
  addTurns(turns: Turn[]): number {
    let n = 0;
    for (const t of turns) {
      // The handoff brief shows up as a user message in the next agent's
      // transcript; recording it would nest briefs inside later briefs.
      if (t.role === "user" && t.text.startsWith(BRIEF_MARKER)) continue;
      const k = turnKey(t);
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      appendFileSync(this.file("turns.jsonl"), JSON.stringify(t) + "\n");
      n++;
    }
    return n;
  }

  events(): LedgerEvent[] {
    return readJsonl<LedgerEvent>(this.file("events.jsonl"));
  }

  addEvent(e: Omit<LedgerEvent, "ts"> & { ts?: number }) {
    appendFileSync(this.file("events.jsonl"), JSON.stringify({ ts: Date.now(), ...e }) + "\n");
  }

  sessions(): Partial<Record<AgentId, SessionRef>> {
    const p = this.file("sessions.json");
    if (!existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return {};
    }
  }

  saveSession(ref: SessionRef) {
    const all = this.sessions();
    all[ref.agent] = ref;
    writeFileSync(this.file("sessions.json"), JSON.stringify(all, null, 2) + "\n");
  }

  summary(): string {
    const p = this.file("summary.md");
    return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
  }

  writeSummary(text: string) {
    writeFileSync(this.file("summary.md"), text.trimEnd() + "\n");
  }

  quota(): Partial<Record<AgentId, QuotaStatus>> {
    const p = this.file("quota.json");
    if (!existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return {};
    }
  }

  saveQuota(q: QuotaStatus) {
    const all = this.quota();
    all[q.agent] = q;
    writeFileSync(this.file("quota.json"), JSON.stringify(all, null, 2) + "\n");
  }

  clearQuota(agent?: AgentId) {
    const all = agent ? this.quota() : {};
    if (agent) delete all[agent];
    writeFileSync(this.file("quota.json"), JSON.stringify(all, null, 2) + "\n");
  }
}

export const BRIEF_MARKER = "[codemax handoff]";

function turnId(t: Turn): string {
  return `${t.agent}:${t.sessionId}:${t.role}:${t.ts}`;
}

function turnKey(t: Turn): string {
  return `${turnId(t)}:${t.text.length}:${t.tools?.length ?? 0}`;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

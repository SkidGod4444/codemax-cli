import { join } from "node:path";
import { appendFileSync, closeSync, copyFileSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ensureDir, projectDir } from "./paths.ts";
import type { AgentId, QuotaStatus, SessionRef, Turn } from "../adapters/types.ts";
import type { UsageRecord } from "./usage.ts";
import { Journal } from "./journal.ts";

export interface LedgerEvent {
  ts: number;
  kind: "start" | "switch" | "exit" | "quota" | "note";
  agent?: AgentId;
  to?: AgentId;
  detail?: string;
  diffStat?: string;
}

/** Files that belong to one conversation thread; everything else is project-wide. */
const THREAD_FILES = ["turns.jsonl", "sessions.json", "summary.md", "journal.jsonl"];

export interface ThreadInfo {
  id: string;
  createdAt: number;
  /** Last activity (newest change to its files). */
  updatedAt: number;
  /** The first thing you asked, as its title. */
  title?: string;
  /** The agent that last worked in it. */
  agent?: AgentId;
}

/**
 * Project ledger in ~/.codemax/projects/<escaped-cwd>/, holding one or more
 * conversation threads (`codemax --resume <id>`):
 *  - threads/<id>/   one conversation every agent shares
 *      turns.jsonl     normalized conversation turns from every agent
 *      sessions.json   each agent's own session in this thread (for native resume)
 *      summary.md      optional hand- or agent-written compacted summary
 *      journal.jsonl   every step every agent took (see journal.ts); handoffs resume from it
 *  - events.jsonl    switches, quota detections, notes
 *  - usage.jsonl, quota.json   usage and plan limits, for the whole project
 * Ledgers from before threads (those files at the top level) are copied into the first thread.
 */
export class Ledger {
  /** The project directory. */
  readonly dir: string;
  /** This thread's id and directory. */
  readonly threadId: string;
  readonly threadDir: string;
  readonly journal: Journal;
  private seen = new Set<string>();

  /**
   * `thread`: an id (or its start), "new", or omitted for the latest thread. `false` opens
   * only the project-wide files (usage totals), without touching threads.
   */
  constructor(readonly cwd: string, dir?: string, thread?: string | false) {
    this.dir = ensureDir(dir ?? projectDir(cwd));
    if (thread === false) {
      this.threadId = "";
      this.threadDir = this.dir;
    } else {
      this.migrate();
      const id = thread === "new" ? undefined : thread ? Ledger.findThread(this.dir, thread) : Ledger.threads(this.dir)[0]?.id;
      if (thread && thread !== "new" && !id) throw new Error(`no codemax thread "${thread}" in ${cwd}. codemax --resume lists them.`);
      this.threadId = id ?? newThreadId(this.dir);
      this.threadDir = ensureDir(join(this.dir, "threads", this.threadId));
      const meta = join(this.threadDir, "thread.json");
      if (!existsSync(meta)) writeFileSync(meta, JSON.stringify({ id: this.threadId, createdAt: Date.now() }) + "\n", { mode: 0o600 });
    }
    this.journal = new Journal(this.threadDir);
    for (const t of this.turns()) this.seen.add(turnKey(t));
  }

  /** The project's threads, most recently active first. */
  static threads(projectDirPath: string): ThreadInfo[] {
    const root = join(projectDirPath, "threads");
    if (!existsSync(root)) return [];
    const out: ThreadInfo[] = [];
    for (const id of readdirSync(root)) {
      const d = join(root, id);
      let createdAt = 0;
      try {
        createdAt = Number(JSON.parse(readFileSync(join(d, "thread.json"), "utf8")).createdAt) || 0;
      } catch {
        try {
          createdAt = statSync(d).mtimeMs;
        } catch {
          continue;
        }
      }
      let updatedAt = createdAt;
      for (const f of THREAD_FILES) {
        try {
          updatedAt = Math.max(updatedAt, statSync(join(d, f)).mtimeMs);
        } catch {
          /* not written yet */
        }
      }
      // Only the journal's first and last 64 KB: listing stays fast however long a thread grows.
      const head = jsonLines(readEnds(join(d, "journal.jsonl"), "head"));
      const tail = jsonLines(readEnds(join(d, "journal.jsonl"), "tail"));
      const firstUser = head.find((x) => x?.kind === "user") as { text?: string } | undefined;
      const lastWork = [...tail].reverse().find((x) => x?.kind && x.kind !== "user" && x.kind !== "handoff" && x.kind !== "rewind");
      const steps = tail;
      const turns = firstUser ? [] : readJsonl<Turn>(join(d, "turns.jsonl"));
      const title = (firstUser?.text ?? turns.find((t) => t.role === "user")?.text)?.replace(/\s+/g, " ").trim().slice(0, 80);
      let sessions: Partial<Record<AgentId, SessionRef>> = {};
      try {
        sessions = JSON.parse(readFileSync(join(d, "sessions.json"), "utf8"));
      } catch {
        /* none yet */
      }
      const latestSession = Object.values(sessions).sort((a, b) => (b?.lastUsedAt ?? 0) - (a?.lastUsedAt ?? 0))[0]?.agent;
      out.push({ id, createdAt, updatedAt, title: title || undefined, agent: lastWork?.agent ?? latestSession ?? steps.at(-1)?.agent ?? turns.at(-1)?.agent });
    }
    // Same instant (two threads touched within a millisecond): the newer thread first.
    return out.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  /** The thread whose id is `id` or starts with it (when only one does). */
  static findThread(projectDirPath: string, id: string): string | undefined {
    const all = Ledger.threads(projectDirPath).map((t) => t.id);
    if (all.includes(id)) return id;
    const hits = all.filter((t) => t.startsWith(id));
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** Copy a pre-threads ledger's conversation files into its first thread (once: `threads/` then exists). */
  private migrate() {
    const legacy = THREAD_FILES.filter((f) => existsSync(join(this.dir, f)));
    if (!legacy.length || existsSync(join(this.dir, "threads"))) return;
    const id = newThreadId(this.dir);
    const d = ensureDir(join(this.dir, "threads", id));
    let createdAt = Date.now();
    for (const f of legacy) {
      try {
        createdAt = Math.min(createdAt, statSync(join(this.dir, f)).birthtimeMs || statSync(join(this.dir, f)).mtimeMs);
      } catch {
        /* keep now */
      }
      // Copied, not moved: an older codemax still reads them where they were.
      copyFileSync(join(this.dir, f), join(d, f));
    }
    writeFileSync(join(d, "thread.json"), JSON.stringify({ id, createdAt, migrated: true }) + "\n", { mode: 0o600 });
  }

  private file(name: string) {
    return join(THREAD_FILES.includes(name) ? this.threadDir : this.dir, name);
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
      appendFileSync(this.file("turns.jsonl"), JSON.stringify(t) + "\n", { mode: 0o600 });
      n++;
    }
    return n;
  }

  events(): LedgerEvent[] {
    return readJsonl<LedgerEvent>(this.file("events.jsonl"));
  }

  addEvent(e: Omit<LedgerEvent, "ts"> & { ts?: number }) {
    appendFileSync(this.file("events.jsonl"), JSON.stringify({ ts: Date.now(), ...e }) + "\n", { mode: 0o600 });
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
    writeFileSync(this.file("sessions.json"), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  }

  summary(): string {
    const p = this.file("summary.md");
    return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
  }

  writeSummary(text: string) {
    writeFileSync(this.file("summary.md"), text.trimEnd() + "\n", { mode: 0o600 });
  }

  usage(): UsageRecord[] {
    return readJsonl<UsageRecord>(this.file("usage.jsonl"));
  }

  addUsage(r: UsageRecord) {
    appendFileSync(this.file("usage.jsonl"), JSON.stringify(r) + "\n", { mode: 0o600 });
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
    writeFileSync(this.file("quota.json"), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  }

  clearQuota(agent?: AgentId) {
    const all = agent ? this.quota() : {};
    if (agent) delete all[agent];
    writeFileSync(this.file("quota.json"), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  }
}

export const BRIEF_MARKER = "[codemax handoff]";

/** The first or last 64 KB of a file ("" when missing). */
function readEnds(path: string, end: "head" | "tail", bytes = 64 * 1024): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    try {
      const n = Math.min(size, bytes);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, end === "head" ? 0 : size - n);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Whole JSON lines of a chunk (a line cut at either edge is skipped). */
function jsonLines(chunk: string): any[] {
  const out: any[] = [];
  for (const line of chunk.split("\n")) {
    try {
      if (line.trim()) out.push(JSON.parse(line));
    } catch {
      /* cut at the edge */
    }
  }
  return out;
}

/** A short thread id (8 hex characters), unused in this project. */
function newThreadId(projectDirPath: string): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!existsSync(join(projectDirPath, "threads", id))) return id;
  }
}

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

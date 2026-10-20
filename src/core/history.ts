import { join } from "node:path";
import { appendFileSync, chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { CODEMAX_HOME, ensureDir, writeAtomic } from "./paths.ts";

/**
 * Prompt history that survives restarts: every message you send, one JSON line
 * per entry in ~/.codemax/history.jsonl ({ ts, cwd, text }), readable only by
 * you. ↑ walks this project's entries; Ctrl+R searches them.
 */
export const HISTORY_FILE = () => join(CODEMAX_HOME, "history.jsonl");
/** Above this size the file is rewritten with its newest KEEP_ENTRIES lines. */
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_ENTRIES = 3000;
/** Longer messages (pasted logs) are not worth keeping. */
const MAX_TEXT = 20_000;

export interface HistoryEntry {
  ts: number;
  cwd: string;
  text: string;
}

function readAll(): HistoryEntry[] {
  const file = HISTORY_FILE();
  if (!existsSync(file)) return [];
  const out: HistoryEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.text === "string" && typeof e?.cwd === "string") out.push({ ts: Number(e.ts) || 0, cwd: e.cwd, text: e.text });
    } catch {
      /* a torn line from a crash: skip it */
    }
  }
  return out;
}

/** This project's messages, oldest first, without repeats (a repeat counts at its latest use). */
export function loadHistory(cwd: string, limit = 500): string[] {
  try {
    const seen = new Set<string>();
    const out: string[] = [];
    const all = readAll();
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const e = all[i]!;
      if (e.cwd !== cwd || seen.has(e.text)) continue;
      seen.add(e.text);
      out.push(e.text);
    }
    return out.reverse();
  } catch {
    return [];
  }
}

export function appendHistory(cwd: string, text: string) {
  if (!text.trim() || text.length > MAX_TEXT) return;
  try {
    ensureDir(CODEMAX_HOME);
    const file = HISTORY_FILE();
    const fresh = !existsSync(file);
    appendFileSync(file, JSON.stringify({ ts: Date.now(), cwd, text }) + "\n", { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
    if (statSync(file).size > MAX_BYTES) {
      const keep = readAll().slice(-KEEP_ENTRIES);
      writeAtomic(file, keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
  } catch {
    /* history is a convenience: never fail a send over it */
  }
}

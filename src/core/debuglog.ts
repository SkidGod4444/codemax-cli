import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEMAX_HOME, ensureDir } from "./paths.ts";

/**
 * The debug log (/config → Debug log, `/debug`): what codemax did not expect, so a user can
 * send it (`/debug export`) and the bug can be found without them describing it. It records
 * errors, display glitches, crashes, agent errors and warnings, protocol messages codemax does
 * not understand, odd turn endings and UI stalls. It never records the conversation: no
 * messages, replies, reasoning, tool input or output, file contents or diffs. Error text is
 * clipped and scrubbed of secrets, e-mail addresses and the home directory. Plain files under
 * ~/.codemax, the same on every OS.
 */

const MAX_BYTES = 5 * 1024 * 1024;
let enabled = false;
const seenOnce = new Set<string>();

export function debugLogPath(): string {
  return join(CODEMAX_HOME, "debug.log");
}

export function setDebugLog(on: boolean) {
  enabled = on;
}

export function debugLogOn(): boolean {
  return enabled;
}

/**
 * One event. `fields` must hold facts about codemax, never conversation content: names,
 * counts, lengths, kinds, ids and error messages (scrubbed here). Nothing when the log is off.
 */
export function debugEvent(kind: string, fields: Record<string, unknown> = {}) {
  if (!enabled) return;
  try {
    const file = debugLogPath();
    ensureDir(CODEMAX_HOME);
    // Bounded: past 5 MB the log becomes debug.log.1 (one older file kept).
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) clean[k] = typeof v === "string" ? scrub(v) : v;
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), kind, ...clean }) + "\n", { mode: 0o600 });
  } catch {
    /* the log must never get in the way */
  }
}

/** The same event only once per run (e.g. an unknown update type an agent sends on every turn). */
export function debugOnce(key: string, kind: string, fields: Record<string, unknown> = {}) {
  if (!enabled || seenOnce.has(key)) return;
  seenOnce.add(key);
  debugEvent(kind, fields);
}

/** A thrown value as a short message and the codemax frames of its stack (file:line, no source). */
export function errorFields(e: unknown): { error: string; at?: string } {
  const err = e as { message?: unknown; stack?: unknown };
  const message = String(err?.message ?? e);
  const frames = typeof err?.stack === "string"
    ? err.stack
        .split("\n")
        .map((l) => l.match(/(src[\\/][^\s):]+:\d+)/)?.[1])
        .filter(Boolean)
        .slice(0, 4)
        .join(" < ")
    : "";
  return { error: message, ...(frames ? { at: frames.replace(/\\/g, "/") } : {}) };
}

/** Text safe to keep: clipped, with secrets, e-mail addresses and the home directory removed. */
export function scrub(s: string, max = 300): string {
  let t = s.replace(/\s+/g, " ").trim();
  const home = homedir();
  if (home) t = t.split(home).join("~");
  t = t
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk_(live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g, "<secret>")
    .replace(/\b(bearer|token|api[_-]?key|password|secret)(\s*[:=]\s*|\s+)("?)[^\s"']{6,}\3/gi, "$1$2<secret>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, "<long-token>");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * The file to send: what codemax and this machine are, then the log (newest last). Written to
 * ~/.codemax/exports unless `target` is given. Returns its path.
 */
export function exportDebugLog(info: Record<string, unknown>, target?: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const path = target ?? join(ensureDir(join(CODEMAX_HOME, "exports")), `codemax-debug-${stamp}.txt`);
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  const log = (read(`${debugLogPath()}.1`) + read(debugLogPath())).trim().split("\n").filter(Boolean).slice(-5000);
  const head = Object.entries(info).map(([k, v]) => `${k}: ${typeof v === "string" ? scrub(v, 500) : JSON.stringify(v)}`);
  const body = [
    "codemax debug log",
    "No messages, replies or tool output are in this file: only what codemax did not expect.",
    "Error lines below can name your files, folders and commands, or quote a line of code that failed. Skim it before sending.",
    "",
    ...head,
    "",
    `--- ${log.length} events (oldest first) ---`,
    ...log,
    "",
  ].join("\n");
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

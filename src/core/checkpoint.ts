import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, rmdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Working-tree checkpoints that never touch the user's index, branches or
 * stash: a private index file snapshots everything git would add (`.gitignore`
 * respected) into a commit stored under refs/codemax/checkpoints/.
 */

/**
 * Snapshots are byte-exact: no line-ending conversion when a file goes in or comes back out.
 * Otherwise `core.autocrlf` (on by default with Git for Windows) or a `.gitattributes`
 * `text` rule would turn a restored LF file into CRLF. Attributes are read from the empty
 * tree (`--attr-source`, git 2.40+); an older git gets autocrlf off only.
 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
let exactFlags: Promise<string[]> | null = null;
function rawGit(): Promise<string[]> {
  exactFlags ??= (async () => {
    const base = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
    const p = Bun.spawn(["git", `--attr-source=${EMPTY_TREE}`, "version"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0 ? [`--attr-source=${EMPTY_TREE}`, ...base] : base;
  })();
  return exactFlags;
}

async function run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["git", ...(await rawGit()), ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out.trimEnd(), err: err.trimEnd() };
}

async function gitDir(cwd: string): Promise<string | null> {
  const r = await run(cwd, ["rev-parse", "--absolute-git-dir"]);
  return r.code === 0 ? r.out : null;
}

/** Untracked files above this size are left out of snapshots (and so never deleted by /undo). */
export const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
/** Checkpoint refs kept per repo; older ones are deleted so git can collect their objects. */
export const KEEP_CHECKPOINTS = 50;

async function largeUntracked(cwd: string): Promise<string[]> {
  const r = await run(cwd, ["ls-files", "-o", "--exclude-standard", "-z"]);
  if (r.code !== 0) return [];
  const { statSync } = await import("node:fs");
  return r.out.split("\0").filter((f) => {
    if (!f) return false;
    try {
      return statSync(join(cwd, f)).size > MAX_UNTRACKED_BYTES;
    } catch {
      return false;
    }
  });
}

async function treeOfWorkingDir(cwd: string, index: string): Promise<string | null> {
  const env = { GIT_INDEX_FILE: index };
  await run(cwd, ["read-tree", "--empty"], env);
  const skip = (await largeUntracked(cwd)).map((f) => `:(exclude,literal)${f}`);
  if ((await run(cwd, ["add", "-A", "--", ".", ...skip], env)).code !== 0) return null;
  const t = await run(cwd, ["write-tree"], env);
  return t.code === 0 ? t.out : null;
}

export interface Checkpoint {
  sha: string;
  label: string;
  ts: number;
  /** Where the agent's conversation stood (for /rewind after a restart), kept in the snapshot's message. */
  fork?: { agent?: string; sessionId: string; messageId: string | null };
  /** The codemax thread it was taken in (/rewind lists only the current thread's). */
  thread?: string;
}

const FORK_TRAILER = "Codemax-Rewind-Point: ";
const THREAD_TRAILER = "Codemax-Thread: ";

/** Snapshot the working tree. Returns null outside a git repo. */
export async function createCheckpoint(cwd: string, label: string, fork?: Checkpoint["fork"], thread?: string): Promise<Checkpoint | null> {
  const dir = await gitDir(cwd);
  if (!dir) return null;
  const index = join(dir, "codemax-checkpoint-index");
  const tree = await treeOfWorkingDir(cwd, index);
  if (!tree) return null;
  const head = await run(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  const ident = { GIT_AUTHOR_NAME: "codemax", GIT_AUTHOR_EMAIL: "codemax@localhost", GIT_COMMITTER_NAME: "codemax", GIT_COMMITTER_EMAIL: "codemax@localhost" };
  const c = await run(cwd, ["commit-tree", tree, ...(head.code === 0 ? ["-p", head.out] : []), "-m", label, ...(fork || thread ? ["-m", [fork && FORK_TRAILER + JSON.stringify(fork), thread && THREAD_TRAILER + thread].filter(Boolean).join("\n")] : [])], ident);
  if (c.code !== 0) return null;
  const ts = Date.now();
  await run(cwd, ["update-ref", `refs/codemax/checkpoints/${ts}`, c.out]);
  await pruneCheckpoints(cwd);
  return { sha: c.out, label, ts, ...(fork ? { fork } : {}), ...(thread ? { thread } : {}) };
}

/** Keep the newest KEEP_CHECKPOINTS refs; delete the rest. */
export async function pruneCheckpoints(cwd: string, keep = KEEP_CHECKPOINTS) {
  const r = await run(cwd, ["for-each-ref", "--sort=-refname", "--format=%(refname)", "refs/codemax/checkpoints"]);
  const old = r.out.split("\n").filter(Boolean).slice(keep);
  for (const ref of old) await run(cwd, ["update-ref", "-d", ref]);
}

/** Make the working tree match a checkpoint: restore its files, delete files created since. */
export async function restoreCheckpoint(cwd: string, sha: string): Promise<{ restored: number; removed: string[] }> {
  const dir = await gitDir(cwd);
  if (!dir) throw new Error("not a git repository");
  const index = join(dir, "codemax-restore-index");
  const now = await treeOfWorkingDir(cwd, index);
  const list = async (tree: string) => (await run(cwd, ["ls-tree", "-r", "--name-only", tree])).out.split("\n").filter(Boolean);
  const target = new Set(await list(sha));
  const current = now ? await list(now) : [];
  const removed = current.filter((f) => !target.has(f));
  for (const f of removed) {
    const abs = join(cwd, f);
    rmSync(abs, { force: true });
    // tidy now-empty directories the agent created
    let d = dirname(abs);
    while (d.startsWith(cwd) && d !== cwd && existsSync(d) && readdirSync(d).length === 0) {
      rmdirSync(d);
      d = dirname(d);
    }
  }
  const env = { GIT_INDEX_FILE: index };
  await run(cwd, ["read-tree", sha], env);
  const co = await run(cwd, ["checkout-index", "-a", "-f"], env);
  if (co.code !== 0) throw new Error(co.err || "checkout-index failed");
  return { restored: target.size, removed };
}

export async function listCheckpoints(cwd: string, limit = 20): Promise<Checkpoint[]> {
  // Fields split by \x1f, records by \x1e: the body (rewind point) may span lines.
  const r = await run(cwd, ["for-each-ref", "--sort=-refname", `--count=${limit}`, "--format=%(objectname)%1f%(refname:lstrip=3)%1f%(contents:subject)%1f%(contents:body)%1e", "refs/codemax/checkpoints"]);
  if (r.code !== 0 || !r.out) return [];
  return r.out.split("\x1e").map((rec) => rec.replace(/^\n/, "")).filter(Boolean).map((rec) => {
    const [sha, ts, label, body] = rec.split("\x1f");
    const lines = (body ?? "").split("\n");
    const line = lines.find((l) => l.startsWith(FORK_TRAILER));
    const thread = lines.find((l) => l.startsWith(THREAD_TRAILER))?.slice(THREAD_TRAILER.length).trim();
    let fork: Checkpoint["fork"];
    try {
      const f = line ? JSON.parse(line.slice(FORK_TRAILER.length)) : undefined;
      if (f && typeof f.sessionId === "string") fork = { agent: typeof f.agent === "string" ? f.agent : undefined, sessionId: f.sessionId, messageId: typeof f.messageId === "string" ? f.messageId : null };
    } catch {
      /* not ours */
    }
    return { sha: sha!, ts: Number(ts), label: label ?? "", ...(fork ? { fork } : {}), ...(thread ? { thread } : {}) };
  });
}

/** Files that differ between a checkpoint and the working tree now. */
export async function checkpointDiffStat(cwd: string, sha: string): Promise<string> {
  const dir = await gitDir(cwd);
  if (!dir) return "";
  const now = await treeOfWorkingDir(cwd, join(dir, "codemax-restore-index"));
  if (!now) return "";
  return (await run(cwd, ["diff", "--stat", sha, now])).out;
}

/** How many files differ between each checkpoint and the working tree now (one snapshot of the tree for all). */
export async function checkpointChangeCounts(cwd: string, shas: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const dir = await gitDir(cwd);
  if (!dir || !shas.length) return out;
  const now = await treeOfWorkingDir(cwd, join(dir, "codemax-restore-index"));
  if (!now) return out;
  for (const sha of shas) {
    const r = await run(cwd, ["diff", "--name-only", "--no-renames", sha, now]);
    if (r.code === 0) out.set(sha, r.out ? r.out.split("\n").length : 0);
  }
  return out;
}

/**
 * The full code change between a checkpoint and the working tree now, new files
 * included (the snapshot uses a private index, so the user's staging is untouched).
 */
export async function checkpointDiff(cwd: string, sha: string): Promise<string> {
  const dir = await gitDir(cwd);
  if (!dir) return "";
  const now = await treeOfWorkingDir(cwd, join(dir, "codemax-restore-index"));
  if (!now) return "";
  return (await run(cwd, ["diff", "--no-color", "--no-ext-diff", "-M", sha, now])).out;
}

export function ensureDirFor(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

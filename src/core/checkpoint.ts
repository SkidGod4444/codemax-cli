import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, rmdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Working-tree checkpoints that never touch the user's index, branches or
 * stash: a private index file snapshots everything git would add (`.gitignore`
 * respected) into a commit stored under refs/codemax/checkpoints/.
 */

async function run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
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
}

/** Snapshot the working tree. Returns null outside a git repo. */
export async function createCheckpoint(cwd: string, label: string): Promise<Checkpoint | null> {
  const dir = await gitDir(cwd);
  if (!dir) return null;
  const index = join(dir, "codemax-checkpoint-index");
  const tree = await treeOfWorkingDir(cwd, index);
  if (!tree) return null;
  const head = await run(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  const ident = { GIT_AUTHOR_NAME: "codemax", GIT_AUTHOR_EMAIL: "codemax@localhost", GIT_COMMITTER_NAME: "codemax", GIT_COMMITTER_EMAIL: "codemax@localhost" };
  const c = await run(cwd, ["commit-tree", tree, ...(head.code === 0 ? ["-p", head.out] : []), "-m", label], ident);
  if (c.code !== 0) return null;
  const ts = Date.now();
  await run(cwd, ["update-ref", `refs/codemax/checkpoints/${ts}`, c.out]);
  await pruneCheckpoints(cwd);
  return { sha: c.out, label, ts };
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
  const r = await run(cwd, ["for-each-ref", "--sort=-refname", `--count=${limit}`, "--format=%(objectname) %(refname:lstrip=3) %(contents:subject)", "refs/codemax/checkpoints"]);
  if (r.code !== 0 || !r.out) return [];
  return r.out.split("\n").map((l) => {
    const [sha, ts, ...rest] = l.split(" ");
    return { sha: sha!, ts: Number(ts), label: rest.join(" ") };
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

export function ensureDirFor(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

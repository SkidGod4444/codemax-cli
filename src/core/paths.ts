import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync, mkdirSync, existsSync } from "node:fs";

export const HOME = homedir();
export const CODEMAX_HOME = process.env.CODEMAX_HOME ?? join(HOME, ".codemax");

/** Claude Code's project-dir rule: every non-alphanumeric char becomes '-'. */
export function escapeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function canonicalCwd(cwd: string = process.cwd()): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

export function projectDir(cwd: string): string {
  const dir = join(CODEMAX_HOME, "projects", escapeCwd(cwd));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

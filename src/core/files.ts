import { join, relative } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { insideDir } from "./paths.ts";

const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "target", ".venv", "__pycache__"]);

/** Repo files for @-mentions: git's view when available (ignores respected), else a bounded walk. */
export async function listProjectFiles(cwd: string, max = 20000): Promise<string[]> {
  try {
    const p = Bun.spawn(["git", "ls-files", "-co", "--exclude-standard"], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) === 0 && out.trim()) return out.split("\n").filter(Boolean).slice(0, max);
  } catch {
    /* fall through */
  }
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || files.length >= max) return;
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, depth + 1);
      else files.push(relative(cwd, abs));
      if (files.length >= max) return;
    }
  };
  walk(cwd, 0);
  return files;
}

export const MENTION_RE = /(^|\s)@([^\s@]*)$/;

/** Paths mentioned as @path in a message that exist in the project. */
export function mentionedFiles(text: string, cwd: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const p = m[1]!.replace(/[),.;:]+$/, "");
    // Only files in the project: "@../../.ssh/id_rsa" is not attached.
    if (!out.includes(p) && insideDir(cwd, p) && existsSync(join(cwd, p)) && statSync(join(cwd, p)).isFile()) out.push(p);
  }
  return out;
}

/** Contents block appended to a prompt for the mentioned files (bounded). */
export function attachFiles(paths: string[], cwd: string, perFile = 30_000, total = 100_000): string {
  let used = 0;
  const parts: string[] = [];
  for (const p of paths) {
    if (!insideDir(cwd, p)) continue;
    let body = readFileSync(join(cwd, p), "utf8");
    if (body.includes("\u0000")) {
      parts.push(`--- ${p} (binary, not attached) ---`);
      continue;
    }
    if (body.length > perFile) body = body.slice(0, perFile) + `\n… [truncated, ${body.length - perFile} more chars]`;
    if (used + body.length > total) {
      parts.push(`--- ${p} (skipped, attachment limit reached) ---`);
      continue;
    }
    used += body.length;
    parts.push(`--- ${p} ---\n${body}`);
  }
  return parts.length ? `\n\n[files the user attached with @]\n${parts.join("\n\n")}` : "";
}

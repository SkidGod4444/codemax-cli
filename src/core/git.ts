export async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(p.stdout).text();
    const code = await p.exited;
    return code === 0 ? text.trimEnd() : null;
  } catch {
    return null;
  }
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

export async function diffStat(cwd: string): Promise<string> {
  if (!(await isRepo(cwd))) return "(not a git repo)";
  const staged = await git(cwd, ["diff", "--cached", "--stat"]);
  const unstaged = await git(cwd, ["diff", "--stat"]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const parts: string[] = [];
  if (staged) parts.push("staged:\n" + staged);
  if (unstaged) parts.push("unstaged:\n" + unstaged);
  if (untracked) parts.push("untracked:\n" + untracked.split("\n").slice(0, 30).join("\n"));
  return parts.length ? parts.join("\n") : "(working tree clean)";
}

export async function headLine(cwd: string): Promise<string> {
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const log = await git(cwd, ["log", "-1", "--format=%h %s"]);
  return `${branch ?? "?"} @ ${log ?? "(no commits)"}`;
}

export async function recentCommits(cwd: string, n = 5): Promise<string> {
  return (await git(cwd, ["log", `-${n}`, "--format=%h %s"])) ?? "";
}

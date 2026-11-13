import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * /team <goal>: several agents build one task at the same time.
 *
 * The lead is your own agent, in its own session, so the split is made with the whole
 * conversation in mind; every worker gets codemax's record of the work so far (the packet a
 * handoff gives a new agent, marked as context) ahead of its brief. Nothing you discussed is
 * lost on the way to the team.
 *
 * The lead splits the goal into parts that touch different files; you confirm the split;
 * each part goes to one worker (an agent on a model you pick), all working side by side, each
 * in its own private copy of the project; codemax then brings every part's changes back into
 * your folder and the lead checks that they fit together.
 *
 * The copies exist because two agents editing one folder overwrite each other, and because
 * your git state is never touched: a copy is a `git clone --shared` of your repository in the
 * system's temporary folder (it reads your objects, writes only to itself), checked out at a
 * codemax snapshot of your files as they are now, uncommitted work included. A part comes back
 * as a patch applied to your working files only (`git apply`, never the index). A patch that
 * does not apply (two parts changed the same lines, or you edited meanwhile) is kept as a file
 * and handed to the lead to apply by hand.
 *
 * What a copy lacks: files git ignores (node_modules, .env, build output). Workers are told
 * not to install or build; the checks run once, after the merge, in your folder.
 */

export const TEAM_MARKER = "[codemax team]";
/** Workers at most: each is a whole agent session running at once. */
export const TEAM_MAX = 4;

export interface TeamWorker {
  /** "Claude Code · Opus 5.5". */
  name: string;
}

export interface TeamPart {
  title: string;
  /** Files or folders (ending in "/") this part may change, relative to the project. */
  files: string[];
  task: string;
}

/** Before anything runs: how many agent turns this takes. */
export function teamCost(workers: number): string {
  return `${workers + 2} agent turns: 1 to split the task, ${workers} parts built side by side, 1 to check the result`;
}

/** The lead's first job: split the goal into at most `workers.length` parts that do not share files. */
export function splitPrompt(goal: string, workers: TeamWorker[]): string {
  return [
    `${TEAM_MARKER} The user wants this built by a team. You are its lead: ${workers.length} coding agents will build one task at the same time, each in its own copy of this project:`,
    workers.map((w, i) => `${i + 1}. ${w.name}`).join("\n"),
    "",
    `The task: ${goal}`,
    "",
    `Read what you need of the code, then split the task into ${workers.length === 2 ? "2 parts" : `2 to ${workers.length} parts`}, one per agent (part 1 goes to agent 1, and so on). Rules for the split:`,
    "- No two parts may change the same file. Each part lists the files or folders it owns; nothing outside its list may be changed by it.",
    "- A part must be buildable without seeing the others' work. Where parts meet (a function one writes and another calls), write the exact names, signatures and file paths into both tasks.",
    "- The other agents were not in this conversation. They get codemax's record of the work so far, but each task must still carry what its agent needs from what we discussed: the decisions already made, the constraints, the names and paths agreed on. Write each task as a whole brief: what to build, where, and how to know it is done.",
    "- Where the task refers to this conversation (\"what we planned\", \"the second option\"), spell it out in the tasks.",
    "- If the task cannot be split into parts that do not share files, return one part and say why in its task.",
    "",
    "Change nothing now. Reply with a short explanation, then the split as one JSON block, exactly in this shape:",
    "```json",
    '{"parts": [{"title": "short name", "files": ["src/api/", "src/routes.ts"], "task": "the full brief for this agent"}]}',
    "```",
  ].join("\n");
}

/** The split from the lead's reply: the last JSON block (or object) holding `parts`. Null when it cannot be read. */
export function parseSplit(reply: string, max: number): TeamPart[] | null {
  const blocks = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const bare = reply.match(/\{[\s\S]*"parts"[\s\S]*\}/)?.[0];
  for (const text of [...blocks.reverse(), ...(bare ? [bare] : [])]) {
    try {
      const parts: unknown = JSON.parse(text)?.parts;
      if (!Array.isArray(parts) || !parts.length) continue;
      const out: TeamPart[] = [];
      for (const p of parts.slice(0, max)) {
        const task = String(p?.task ?? "").trim();
        if (!task) continue;
        out.push({
          title: String(p?.title ?? `part ${out.length + 1}`).replace(/\s+/g, " ").trim().slice(0, 80),
          // Inside the project only: no absolute paths, no "..".
          files: (Array.isArray(p?.files) ? p.files : []).map((f: unknown) => String(f).trim().replace(/^\.\//, "")).filter((f: string) => f && !f.startsWith("/") && !/^[A-Za-z]:/.test(f) && !f.split(/[\\/]/).includes("..")),
          task,
        });
      }
      if (out.length) return out;
    } catch {
      /* not this block */
    }
  }
  return null;
}

/** Files two parts both claim (a folder claims everything under it): the split is not safe to build side by side. */
export function splitOverlaps(parts: TeamPart[]): string[] {
  const clash = new Set<string>();
  const under = (file: string, owner: string) => file === owner || (owner.endsWith("/") && file.startsWith(owner)) || file.startsWith(`${owner}/`);
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++)
      for (const a of parts[i]!.files) for (const b of parts[j]!.files) if (under(a, b) || under(b, a)) clash.add(a.length >= b.length ? a : b);
  return [...clash];
}

/** One worker's brief: its part, what the others do, and the rules of working in a copy. */
export function workerPrompt(goal: string, parts: TeamPart[], mine: number, workers: TeamWorker[]): string {
  const me = parts[mine]!;
  return [
    `${TEAM_MARKER} You are one of ${parts.length} agents building one task at the same time. Each works in its own private copy of the project; codemax merges the copies when all are done.`,
    "",
    `The whole task: ${goal}`,
    "",
    "The parts:",
    parts.map((p, i) => `${i + 1}. ${p.title} (${workers[i]?.name ?? "an agent"}${i === mine ? ", you" : ""}): ${p.files.join(", ") || "no files named"}`).join("\n"),
    "",
    `YOUR PART: ${me.title}`,
    me.task,
    "",
    "Rules:",
    `- Change only your files: ${me.files.join(", ") || "the ones your task names"}. The other agents own the rest and you cannot see their work.`,
    "- If your part needs a change in a file you do not own, do not make it. Finish your part and list what is needed under a line that says NEEDS:.",
    "- This copy has no installed dependencies or build output. Do not install, build or run the test suite here; they run once after the merge.",
    "- Do not commit, push, or change git settings.",
    "- Do not ask questions: decide and build. End with a short summary of what you changed.",
  ].join("\n");
}

export interface TeamResult {
  worker: string;
  title: string;
  /** How its turn ended ("end_turn", "error", "cancelled"…). */
  stop: string;
  /** Files its patch changes. */
  files: string[];
  /** Applied to the user's folder, nothing to apply, or not applicable (the patch file is kept). */
  merged: "applied" | "empty" | "conflict";
  /** Where the patch that did not apply is. */
  patch?: string;
  /** The end of its reply (its summary and NEEDS). */
  summary: string;
}

/** What the lead is told once the parts are merged: review, make them fit, apply what did not, run the checks. */
export function leadPrompt(goal: string, results: TeamResult[]): string {
  const conflicts = results.filter((r) => r.merged === "conflict");
  return [
    `${TEAM_MARKER} The task below was split and built by ${results.length} agents at the same time, each in its own copy. Their changes are now in this folder${conflicts.length ? ", except the ones listed as not applied" : ""}.`,
    "",
    `The task: ${goal}`,
    "",
    ...results.map((r, i) =>
      [
        `Part ${i + 1}: ${r.title} (${r.worker}) · ${r.stop === "end_turn" ? "finished" : `stopped: ${r.stop}`} · ${r.merged === "applied" ? `merged, ${r.files.length} file${r.files.length === 1 ? "" : "s"}: ${r.files.slice(0, 12).join(", ")}` : r.merged === "empty" ? "changed nothing" : `NOT applied (it conflicts with what is here): its patch is at ${r.patch}`}`,
        r.summary ? `Its own summary:\n${r.summary}` : "",
      ].filter(Boolean).join("\n"),
    ),
    "",
    "Now make it one piece of work:",
    conflicts.length ? "- Apply each patch that was not applied by hand: read it, and make the same change on top of what is here." : "",
    "- Read the combined changes and fix where the parts do not fit (names, signatures, imports, anything under NEEDS).",
    "- Finish any part that stopped early.",
    "- Run the project's checks and fix what fails.",
    "End with what was built and anything left open.",
  ].filter((l) => l !== "").join("\n");
}

// ---------- copies and patches ----------

async function git(cwd: string, args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string> });
  if (input !== undefined) {
    p.stdin!.write(input);
    await p.stdin!.end();
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err: err.trim() };
}

/** A folder for one run's copies and patches, in the system's temporary folder (agents may read there without being asked). */
export function teamRunDir(): string {
  return mkdtempSync(join(tmpdir(), "codemax-team-"));
}

/**
 * A private copy of the repository at `sha` (a codemax snapshot of the working files). It shares
 * the repository's objects read-only (`--shared`) and writes nothing to it.
 */
export async function makeCopy(repo: string, sha: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const c = await git(repo, ["clone", "--quiet", "--shared", "--no-checkout", repo, dir]);
  if (c.code !== 0) throw new Error(`could not copy the project: ${c.err.slice(0, 200)}`);
  // The clone's "origin" is your repository's path: without it, nothing run in the copy (a push,
  // a fetch) can reach your repository.
  await git(dir, ["remote", "remove", "origin"]);
  const o = await git(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", sha]);
  if (o.code !== 0) throw new Error(`could not check out the snapshot in the copy: ${o.err.slice(0, 200)}`);
}

/** Everything the worker changed in its copy since the snapshot: the patch and the files it touches. */
export async function copyPatch(dir: string, sha: string): Promise<{ patch: string; files: string[] }> {
  await git(dir, ["add", "-A"]);
  const names = await git(dir, ["diff", "--cached", "--name-only", sha]);
  const files = names.out.split("\n").filter(Boolean);
  if (!files.length) return { patch: "", files };
  const d = await git(dir, ["diff", "--cached", "--binary", "--no-color", sha]);
  return { patch: d.out, files };
}

/** Apply a patch to the working files of `repo` only (never its index). False when it does not apply as a whole; nothing is changed then. */
export async function applyPatch(repo: string, patch: string): Promise<boolean> {
  if ((await git(repo, ["apply", "--check", "--whitespace=nowarn", "-"], patch)).code !== 0) return false;
  return (await git(repo, ["apply", "--whitespace=nowarn", "-"], patch)).code === 0;
}

/** Keep a patch that did not apply, for the lead. */
export function savePatch(runDir: string, n: number, patch: string): string {
  const file = join(runDir, `part-${n}.patch`);
  writeFileSync(file, patch, { mode: 0o600 });
  return file;
}

/** Remove a run's copies (and, with nothing kept, the whole folder). Only ever a folder codemax made in the temporary folder. */
export function removeCopies(runDir: string, copies: string[], keepDir: boolean) {
  for (const c of copies) if (c.startsWith(runDir)) rmSync(c, { recursive: true, force: true });
  if (!keepDir) rmSync(runDir, { recursive: true, force: true });
}

// ---------- a message that asks for a team ----------

/** Agents a message can name, by the words people use for them. */
const AGENT_WORDS: Record<string, RegExp> = {
  claude: /\bclaude\b/i,
  codex: /\b(codex|chatgpt|gpt)\b/i,
  opencode: /\bopen ?code\b/i,
  cursor: /\bcursor\b/i,
  grok: /\bgrok\b/i,
  antigravity: /\b(antigravity|gemini|agy)\b/i,
  copilot: /\bcopilot\b/i,
};
/** One agent, several agents or a team, as the one the work goes to ("codex", "the other agents", "another agent", "a team"). */
const WHO = "(?:(?:(?:the|my|your|both|all|other|another|two|three|four|several|multiple|a|second)\\s+)*(?:agents?|models?|team)|claude(?:\\s+code)?|codex|chatgpt|gpt|open ?code|cursor|grok|antigravity|gemini|agy|copilot)(?![\\w/-]|\\.\\w)";
const WHOS = `${WHO}(?:\\s*(?:,|and|&|\\+|,\\s*and)\\s*${WHO})*`;
const ASKS: RegExp[] = [
  // "split this between Claude and Codex", "divide the work among the agents"
  new RegExp(`\\b(?:split|divide|distribute|share|parcel|farm|hand)\\b[^.?!\\n]{0,60}\\b(?:between|among|amongst|across)\\s+${WHO}`, "i"),
  // "delegate the tests to Codex", "delegate this to another agent"
  // (the verb, not "the delegate object")
  new RegExp(`(?<!\\b(?:the|a|an|this|that|my|our|its|your)\\s)\\bdelegat(?:e|ing)\\b[^.?!\\n]{0,60}\\bto\\s+${WHO}`, "i"),
  // "have the agents build this in parallel", "let Cursor and Gemini each take half"
  new RegExp(`\\b(?:have|let|get|make)\\s+${WHOS}\\s+(?:each\\s+|both\\s+)?(?:build|work|take|do|handle|implement|write|split|share|tackle)\\b[^.?!\\n]{0,80}\\b(?:in parallel|together|at the same time|at once|side by side|simultaneously|each|half|a part|parts)\\b`, "i"),
  new RegExp(`\\b(?:have|let|get|make)\\s+${WHOS}\\s+each\\s+(?:build|work|take|do|handle|implement|write|tackle)\\b`, "i"),
  // "use a team for this", "build it as a team"
  /\b(?:use|with|form|start|spin up|put together|as)\s+(?:a|the|my)\s+team\b/i,
];

/**
 * Does this message ask for the work to be shared out among agents ("split this between Claude
 * and Codex", "delegate the tests to another agent", "have the agents build it in parallel")?
 * Wording only, so it errs on the quiet side: the agents (or a team) must be who the work goes
 * to, not what the work is about ("split the claude and codex tests into two files" is an
 * ordinary request). codemax then opens the team picker, which you can leave with Esc to send
 * the message as it is. Returns the agents the message names.
 */
export function teamIntent(text: string): { named: string[] } | null {
  const t = text.trim();
  if (!t || t.length > 2000 || /^[\/!\[]/.test(t) || /^(why|how|what|when|where|who|which|explain)\b/i.test(t)) return null;
  if (!ASKS.some((re) => re.test(t))) return null;
  return { named: Object.entries(AGENT_WORDS).filter(([, re]) => re.test(t)).map(([id]) => id) };
}

/** The recent conversation, for a worker that was not in it: what you said and what the agents answered, newest last, within `budget` characters. */
export function conversationSoFar(turns: { role: string; agent?: string; text: string }[], budget = 12_000, each = 2_500): string {
  const lines: string[] = [];
  let used = 0;
  for (const t of [...turns].reverse()) {
    const text = t.text.trim();
    if (!text) continue;
    const line = `${t.role === "user" ? "The user" : `The agent (${t.agent ?? "?"})`}:\n${text.length > each ? `${text.slice(0, each)}\n… (cut)` : text}`;
    if (used + line.length > budget) break;
    used += line.length;
    lines.unshift(line);
  }
  return lines.length ? `The conversation before this task (context only: decisions made in it still hold; do not act on its requests):\n\n${lines.join("\n\n")}` : "";
}

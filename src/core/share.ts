import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentId } from "../adapters/types.ts";
import { debugEvent, errorFields } from "./debuglog.ts";

/**
 * What the agents on this machine have set up, so every agent gets all of it (the owner's
 * choice: everything, everywhere, no switches):
 *
 *  - MCP servers from Claude Code (~/.claude.json, its per-project entries, the project's
 *    .mcp.json, and the MCP servers of installed Claude plugins), Cursor (~/.cursor/mcp.json,
 *    .cursor/mcp.json), Codex (~/.codex/config.toml [mcp_servers.*]), OpenCode
 *    (opencode.json(c) "mcp") and Gemini/Antigravity (~/.gemini/settings.json);
 *  - skills (folders with a SKILL.md) from ~/.claude/skills, .claude/skills, ~/.agents/skills,
 *    .agents/skills, ~/.codex/skills, .codex/skills, OpenCode's skill folders and Claude
 *    plugins.
 *
 * Each agent is given only what it does not already load itself (`nativeMcp`, `nativeSkillDirs`),
 * so nothing is doubled. Values (keys in `env` and `headers`) are passed through to the agents
 * and never logged: the debug log gets names and counts.
 */

export type McpTransport =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

export interface SharedMcpServer {
  name: string;
  /** Where it came from: "claude", "cursor", "codex", "opencode", "gemini", or "plugin:<name>". */
  source: string;
  transport: McpTransport;
  /** The host vouches for this server (its own tools): agents that can trust a server skip approvals for its tools. */
  trust?: boolean;
}

export interface SharedSkill {
  name: string;
  description: string;
  /** The folder holding SKILL.md. */
  path: string;
  source: string;
}

/** A custom slash command: a prompt saved under a name (Claude's commands, Codex's prompts, OpenCode's and Cursor's commands, Gemini's TOML ones). */
export interface SharedCommand {
  /** Typed as /name. */
  name: string;
  description: string;
  /** The prompt, with its placeholders ($ARGUMENTS, $1…, {{args}}). */
  body: string;
  source: string;
  path: string;
}

/** One of the project's rules files (CLAUDE.md, AGENTS.md, GEMINI.md…): what an agent is told about this project. */
export interface SharedRule {
  /** As named in the project ("CLAUDE.md", ".github/copilot-instructions.md"). */
  file: string;
  path: string;
  text: string;
}

export interface Shared {
  mcp: SharedMcpServer[];
  skills: SharedSkill[];
  /** The project's rules files, for the agents that do not read them themselves. */
  rules: SharedRule[];
  /** Custom slash commands of any agent: codemax expands them itself, so they run in every agent. */
  commands: SharedCommand[];
  /** Config files that could not be read, by path (shown once, logged). */
  errors: { file: string; error: string }[];
}

/** JSONC → JSON: comments and trailing commas removed, strings left alone. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readJson(file: string, errors: Shared["errors"]): any {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(stripJsonc(readFileSync(file, "utf8")));
  } catch (e) {
    errors.push({ file, error: String((e as Error)?.message ?? e) });
    return undefined;
  }
}

const strMap = (o: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
};
const strList = (o: unknown): string[] => (Array.isArray(o) ? o.map(String) : []);

/** A server entry in the JSON shape Claude, Cursor and Gemini share ({command,args,env} or {url,headers}). */
function fromJsonEntry(name: string, e: any, source: string): SharedMcpServer | null {
  if (!e || typeof e !== "object" || e.disabled === true || e.enabled === false) return null;
  const type = String(e.type ?? "").toLowerCase();
  if (typeof e.url === "string" && e.url) {
    const t: "http" | "sse" = type === "sse" ? "sse" : "http";
    return { name, source, transport: { type: t, url: e.url, headers: strMap(e.headers) } };
  }
  if (typeof e.command === "string" && e.command) return { name, source, transport: { type: "stdio", command: e.command, args: strList(e.args), env: strMap(e.env), cwd: typeof e.cwd === "string" ? e.cwd : undefined } };
  return null;
}

function claudeServers(home: string, cwd: string, errors: Shared["errors"]): SharedMcpServer[] {
  const out: SharedMcpServer[] = [];
  const cfg = readJson(join(home, ".claude.json"), errors);
  for (const [n, e] of Object.entries(cfg?.mcpServers ?? {})) {
    const s = fromJsonEntry(n, e, "claude");
    if (s) out.push(s);
  }
  for (const [n, e] of Object.entries(cfg?.projects?.[cwd]?.mcpServers ?? {})) {
    const s = fromJsonEntry(n, e, "claude");
    if (s) out.push(s);
  }
  const proj = readJson(join(cwd, ".mcp.json"), errors);
  for (const [n, e] of Object.entries(proj?.mcpServers ?? {})) {
    const s = fromJsonEntry(n, e, "claude");
    if (s) out.push(s);
  }
  return out;
}

function cursorServers(home: string, cwd: string, errors: Shared["errors"]): SharedMcpServer[] {
  const out: SharedMcpServer[] = [];
  for (const f of [join(home, ".cursor", "mcp.json"), join(cwd, ".cursor", "mcp.json")]) {
    const cfg = readJson(f, errors);
    for (const [n, e] of Object.entries(cfg?.mcpServers ?? {})) {
      const s = fromJsonEntry(n, e, "cursor");
      if (s) out.push(s);
    }
  }
  return out;
}

function geminiServers(home: string, errors: Shared["errors"]): SharedMcpServer[] {
  const out: SharedMcpServer[] = [];
  const cfg = readJson(join(home, ".gemini", "settings.json"), errors);
  for (const [n, e] of Object.entries(cfg?.mcpServers ?? {})) {
    const s = fromJsonEntry(n, e as any, "gemini");
    if (s) out.push(s);
  }
  return out;
}

function codexServers(home: string, errors: Shared["errors"]): SharedMcpServer[] {
  const file = join(home, ".codex", "config.toml");
  if (!existsSync(file)) return [];
  let cfg: any;
  try {
    cfg = (Bun as any).TOML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    errors.push({ file, error: String((e as Error)?.message ?? e) });
    return [];
  }
  const out: SharedMcpServer[] = [];
  for (const [n, e] of Object.entries((cfg?.mcp_servers ?? {}) as Record<string, any>)) {
    if (!e || typeof e !== "object" || e.enabled === false) continue;
    if (typeof e.url === "string" && e.url) {
      // Codex names the variable holding the token; the token itself is read here, so the other
      // agents get a working header.
      const headers = strMap(e.http_headers);
      const tokenVar = typeof e.bearer_token_env_var === "string" ? e.bearer_token_env_var : undefined;
      if (tokenVar && process.env[tokenVar]) headers.Authorization = `Bearer ${process.env[tokenVar]}`;
      out.push({ name: n, source: "codex", transport: { type: "http", url: e.url, headers } });
    } else if (typeof e.command === "string" && e.command) {
      out.push({ name: n, source: "codex", transport: { type: "stdio", command: e.command, args: strList(e.args), env: strMap(e.env), cwd: typeof e.cwd === "string" ? e.cwd : undefined } });
    }
  }
  return out;
}

function opencodeServers(home: string, cwd: string, errors: Shared["errors"]): SharedMcpServer[] {
  const out: SharedMcpServer[] = [];
  const files = [join(home, ".config", "opencode", "opencode.json"), join(home, ".config", "opencode", "opencode.jsonc"), join(cwd, "opencode.json"), join(cwd, "opencode.jsonc")];
  for (const f of files) {
    const cfg = readJson(f, errors);
    for (const [n, e] of Object.entries((cfg?.mcp ?? {}) as Record<string, any>)) {
      if (!e || typeof e !== "object" || e.enabled === false) continue;
      if (e.type === "remote" && typeof e.url === "string") out.push({ name: n, source: "opencode", transport: { type: "http", url: e.url, headers: strMap(e.headers) } });
      else if (e.type === "local" && Array.isArray(e.command) && e.command.length) out.push({ name: n, source: "opencode", transport: { type: "stdio", command: String(e.command[0]), args: e.command.slice(1).map(String), env: strMap(e.environment) } });
    }
  }
  return out;
}

/** Installed Claude plugins: their folders (newest version per plugin). */
function claudePluginDirs(home: string, errors: Shared["errors"]): { name: string; dir: string }[] {
  const reg = readJson(join(home, ".claude", "plugins", "installed_plugins.json"), errors);
  const out: { name: string; dir: string }[] = [];
  for (const [key, installs] of Object.entries((reg?.plugins ?? {}) as Record<string, any[]>)) {
    const dir = Array.isArray(installs) ? installs.find((i) => typeof i?.installPath === "string" && existsSync(i.installPath))?.installPath : undefined;
    if (dir) out.push({ name: key.split("@")[0]!, dir });
  }
  return out;
}

function pluginServers(plugins: { name: string; dir: string }[], errors: Shared["errors"]): SharedMcpServer[] {
  const out: SharedMcpServer[] = [];
  for (const p of plugins) {
    const cfg = readJson(join(p.dir, ".mcp.json"), errors);
    for (const [n, e] of Object.entries(cfg?.mcpServers ?? {})) {
      const s = fromJsonEntry(n, e, `plugin:${p.name}`);
      if (s) out.push({ ...s, transport: resolvePluginRoot(s.transport, p.dir) });
    }
  }
  return out;
}

/** Plugin configs refer to their own folder as ${CLAUDE_PLUGIN_ROOT}. */
function resolvePluginRoot(t: McpTransport, dir: string): McpTransport {
  const fix = (s: string) => s.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, dir);
  if (t.type === "stdio") return { ...t, command: fix(t.command), args: t.args.map(fix), env: Object.fromEntries(Object.entries(t.env).map(([k, v]) => [k, fix(v)])) };
  return { ...t, url: fix(t.url) };
}

/** The skills in a folder: each subfolder with a SKILL.md, named by its frontmatter (else the folder). */
export function skillsIn(dir: string, source: string): SharedSkill[] {
  const out: SharedSkill[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const path = join(dir, n);
    const file = join(path, "SKILL.md");
    try {
      if (!statSync(path).isDirectory() || !existsSync(file)) continue;
      const head = readFileSync(file, "utf8").slice(0, 4000);
      const fm = head.match(/^---\s*\n([\s\S]*?)\n---/);
      const field = (k: string) => fm?.[1]?.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
      out.push({ name: field("name") || n, description: (field("description") || "").replace(/\s+/g, " ").slice(0, 160), path, source });
    } catch {
      /* unreadable: skipped */
    }
  }
  return out;
}

/** Skill folders by owner, home-level and project-level. */
export function skillDirs(home: string, cwd: string): { dir: string; source: string }[] {
  return [
    { dir: join(home, ".claude", "skills"), source: "claude" },
    { dir: join(cwd, ".claude", "skills"), source: "claude" },
    { dir: join(home, ".agents", "skills"), source: "agents" },
    { dir: join(cwd, ".agents", "skills"), source: "agents" },
    { dir: join(home, ".codex", "skills"), source: "codex" },
    { dir: join(cwd, ".codex", "skills"), source: "codex" },
    { dir: join(home, ".config", "opencode", "skill"), source: "opencode" },
    { dir: join(home, ".config", "opencode", "skills"), source: "opencode" },
    { dir: join(cwd, ".opencode", "skill"), source: "opencode" },
    { dir: join(cwd, ".opencode", "skills"), source: "opencode" },
  ];
}

/**
 * Which skill folders each agent reads on its own (from the binaries: Claude Code 2.1 reads
 * .claude/skills and .agents/skills; OpenCode 1.19 reads ~/.agents/skills, ~/.claude/skills and
 * its own; Codex 0.159 reads ~/.codex/skills and .agents/skills; Cursor, Grok and Antigravity
 * none that were found).
 */
export function nativeSkillSources(agent: AgentId | string): Set<string> {
  switch (agent) {
    case "claude":
      return new Set(["claude", "agents", "plugin"]);
    case "opencode":
      return new Set(["opencode", "agents", "claude"]);
    case "codex":
      return new Set(["codex", "agents"]);
    default:
      return new Set();
  }
}

/** The MCP source each agent already loads itself. */
export function nativeMcpSource(agent: AgentId | string): string | undefined {
  return ({ claude: "claude", cursor: "cursor", codex: "codex", opencode: "opencode", antigravity: "gemini" } as Record<string, string>)[agent];
}

/** The home whose agent setups are read: the user's, or CODEMAX_SHARE_HOME (tests point it at an empty folder). */
export function shareHome(): string {
  return process.env.CODEMAX_SHARE_HOME || homedir();
}

export function collectShared(cwd: string, home = shareHome()): Shared {
  const errors: Shared["errors"] = [];
  const plugins = claudePluginDirs(home, errors);
  const all = [...claudeServers(home, cwd, errors), ...cursorServers(home, cwd, errors), ...codexServers(home, errors), ...opencodeServers(home, cwd, errors), ...geminiServers(home, errors), ...pluginServers(plugins, errors)];
  // One server per name: the first seen wins (Claude's, then Cursor's…), later duplicates dropped.
  const mcp: SharedMcpServer[] = [];
  const seen = new Set<string>();
  for (const s of all) {
    const key = s.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mcp.push(s);
  }
  const skills: SharedSkill[] = [];
  const seenSkills = new Set<string>();
  const addSkills = (list: SharedSkill[]) => {
    for (const s of list) {
      const key = s.name.toLowerCase();
      if (seenSkills.has(key)) continue;
      seenSkills.add(key);
      skills.push(s);
    }
  };
  for (const d of skillDirs(home, cwd)) addSkills(skillsIn(d.dir, d.source));
  for (const p of plugins) addSkills(skillsIn(join(p.dir, "skills"), `plugin:${p.name}`).map((s) => ({ ...s, source: "plugin" })));
  const rules = projectRules(cwd);
  const commands: SharedCommand[] = [];
  const seenCommands = new Set<string>();
  for (const c of [...commandDirs(home, cwd).flatMap((d) => commandsIn(d.dir, d.source)), ...plugins.flatMap((p) => commandsIn(join(p.dir, "commands"), "plugin"))]) {
    if (seenCommands.has(c.name)) continue;   // one per name: the project's before the user's, Claude's before the others'
    seenCommands.add(c.name);
    commands.push(c);
  }
  debugEvent("shared-collected", { mcp: mcp.length, skills: skills.length, rules: rules.length || undefined, commands: commands.length || undefined, plugins: plugins.length, bySource: countBy(mcp.map((s) => s.source.split(":")[0]!)), errors: errors.length || undefined });
  for (const e of errors) debugEvent("shared-config-error", { file: basename(e.file), ...errorFields(new Error(e.error)) });
  return { mcp, skills, rules, commands, errors };
}

// ---------- custom slash commands ----------
//
// A custom command is a prompt in a file. Each agent runs only its own folder's, so a command
// written for Claude Code did nothing in Codex. codemax reads them all and, when the agent at
// work does not offer a command of that name itself, sends the command's prompt with the
// arguments filled in. Lines that only Claude Code acts on (!`shell`, @file) go as text.

/** Command folders by owner, the project's before the user's. */
export function commandDirs(home: string, cwd: string): { dir: string; source: string }[] {
  return [
    { dir: join(cwd, ".claude", "commands"), source: "claude" },
    { dir: join(home, ".claude", "commands"), source: "claude" },
    { dir: join(cwd, ".cursor", "commands"), source: "cursor" },
    { dir: join(home, ".cursor", "commands"), source: "cursor" },
    { dir: join(home, ".codex", "prompts"), source: "codex" },
    { dir: join(cwd, ".opencode", "command"), source: "opencode" },
    { dir: join(cwd, ".opencode", "commands"), source: "opencode" },
    { dir: join(home, ".config", "opencode", "command"), source: "opencode" },
    { dir: join(home, ".config", "opencode", "commands"), source: "opencode" },
    { dir: join(cwd, ".gemini", "commands"), source: "gemini" },
    { dir: join(home, ".gemini", "commands"), source: "gemini" },
  ];
}

/** The commands in a folder (and one level of subfolders): `name.md` with optional frontmatter, or Gemini's `name.toml`. */
export function commandsIn(dir: string, source: string, depth = 0): SharedCommand[] {
  const out: SharedCommand[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    const path = join(dir, n);
    try {
      const st = statSync(path);
      if (st.isDirectory()) {
        if (depth < 1) out.push(...commandsIn(path, source, depth + 1));
        continue;
      }
      const m = n.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)\.(md|toml)$/);
      if (!m || st.size > 200_000) continue;
      const raw = readFileSync(path, "utf8");
      let body: string;
      let description = "";
      if (m[2] === "toml") {
        const t: any = Bun.TOML.parse(raw);
        body = String(t.prompt ?? "");
        description = String(t.description ?? "");
      } else {
        const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
        body = fm ? raw.slice(fm[0].length) : raw;
        description = fm?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
      }
      body = body.trim();
      if (!body) continue;
      out.push({ name: m[1]!.toLowerCase(), description: (description || body.split("\n")[0]!).replace(/\s+/g, " ").slice(0, 120), body, source, path });
    } catch {
      /* unreadable: skipped */
    }
  }
  return out;
}

/** The command's prompt with the arguments in place: $ARGUMENTS / {{args}} whole, $1…$9 by word; added at the end when the prompt has no placeholder. */
export function expandCommand(c: SharedCommand, args: string): string {
  const all = args.trim();
  const words = all.split(/\s+/).filter(Boolean);
  const placed = /\$ARGUMENTS|\$[1-9]|\{\{args\}\}/.test(c.body);
  const body = c.body.replace(/\$ARGUMENTS|\{\{args\}\}/g, () => all).replace(/\$([1-9])/g, (_m, n) => words[Number(n) - 1] ?? "");
  return placed || !all ? body : `${body}\n\n${all}`;
}

// ---------- project rules ----------
//
// Each agent reads its own rules file and no other: a project written for Claude Code has only
// CLAUDE.md, so Codex or Antigravity taking over the task knew none of the project's rules.

/** The rules files a project can have, in the order they are given. */
const RULES_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", ".github/copilot-instructions.md"];
/** A rules file larger than this is not read (it is no rules file). */
const RULES_MAX_BYTES = 400_000;

/**
 * What each agent reads from the project by itself (their docs, and the file names in their
 * programs: claude 2.1.323, codex 0.159.3, opencode 1.19.3, grok 1.0.62, agy 1.4.2).
 * `firstOnly`: it takes the first of its files that exists and skips the rest (OpenCode reads
 * CLAUDE.md only when there is no AGENTS.md). An agent not listed reads none.
 */
const RULES_READ: Record<string, { files: string[]; firstOnly?: boolean }> = {
  claude: { files: ["CLAUDE.md", ".claude/CLAUDE.md"] },
  codex: { files: ["AGENTS.md"] },
  opencode: { files: ["AGENTS.md", "CLAUDE.md"], firstOnly: true },
  cursor: { files: ["AGENTS.md", "CLAUDE.md", ".cursorrules"] },
  grok: { files: ["AGENTS.md", "CLAUDE.md"] },
  antigravity: { files: ["AGENTS.md", "GEMINI.md"] },
  // From GitHub's docs only (its program could not be searched): it reads the other agents' files too.
  copilot: { files: ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"] },
};

/** The project's rules files that have something in them. */
export function projectRules(cwd: string): SharedRule[] {
  const out: SharedRule[] = [];
  for (const file of RULES_FILES) {
    const path = join(cwd, file);
    try {
      if (!statSync(path).isFile() || statSync(path).size > RULES_MAX_BYTES) continue;
      const text = readFileSync(path, "utf8").trim();
      if (text) out.push({ file, path, text });
    } catch {
      /* not there */
    }
  }
  return out;
}

/**
 * The rules files `agent` should be given: the ones it does not read itself, unless one only
 * repeats or points to a file it does read (a CLAUDE.md that says "@AGENTS.md", a link).
 */
export function rulesFor(agent: AgentId | string, rules: SharedRule[]): SharedRule[] {
  const reads = RULES_READ[agent] ?? { files: [] };
  const present = reads.files.filter((f) => rules.some((r) => r.file === f));
  const own = rules.filter((r) => (reads.firstOnly ? r.file === present[0] : present.includes(r.file)));
  const given: SharedRule[] = [];
  for (const r of rules) {
    if (own.includes(r)) continue;
    const known = [...own, ...given];
    if (known.some((o) => o.text === r.text)) continue;
    if (r.text.length < 400 && known.some((o) => r.text.includes(basename(o.file)))) continue;
    given.push(r);
  }
  return given;
}

/** Rules this long or shorter go into the instructions whole; a longer file is named, to be read first. */
export const RULES_INLINE_CHARS = 6000;

/** The agent's instructions for the project's rules it does not read itself. */
export function rulesNote(rules: SharedRule[]): string {
  if (!rules.length) return "";
  const parts = rules.map((r) =>
    r.text.length <= RULES_INLINE_CHARS
      ? `From ${r.file}:\n${r.text}`
      : `${r.file} (${r.text.split("\n").length} lines) is at ${r.path}: read it before your first step.`,
  );
  return `This project's rules (codemax passes them on: they were written for another agent, and they bind you the same). Follow them:\n\n${parts.join("\n\n")}`;
}

/** What `agent` should be given: the servers and skills it does not load itself. */
export function sharedFor(agent: AgentId | string, shared: Shared): { mcp: SharedMcpServer[]; skills: SharedSkill[]; rules: SharedRule[] } {
  const ownMcp = nativeMcpSource(agent);
  const ownSkills = nativeSkillSources(agent);
  return {
    mcp: shared.mcp.filter((s) => s.source !== ownMcp && !(agent === "claude" && s.source.startsWith("plugin:"))),
    skills: shared.skills.filter((s) => !ownSkills.has(s.source)),
    rules: rulesFor(agent, shared.rules ?? []),
  };
}

/** The skills index for an agent's instructions: name, what for, and where its SKILL.md is. */
export function skillsIndex(skills: SharedSkill[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description || "(no description)"} → ${join(s.path, "SKILL.md")}`);
  return `Skills available to you (shared by codemax from the other agents on this machine). When a task matches one, read its SKILL.md first and follow it:\n${lines.join("\n")}`;
}

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

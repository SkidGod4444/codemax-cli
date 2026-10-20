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
}

export interface SharedSkill {
  name: string;
  description: string;
  /** The folder holding SKILL.md. */
  path: string;
  source: string;
}

export interface Shared {
  mcp: SharedMcpServer[];
  skills: SharedSkill[];
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
  debugEvent("shared-collected", { mcp: mcp.length, skills: skills.length, plugins: plugins.length, bySource: countBy(mcp.map((s) => s.source.split(":")[0]!)), errors: errors.length || undefined });
  for (const e of errors) debugEvent("shared-config-error", { file: basename(e.file), ...errorFields(new Error(e.error)) });
  return { mcp, skills, errors };
}

/** What `agent` should be given: the servers and skills it does not load itself. */
export function sharedFor(agent: AgentId | string, shared: Shared): { mcp: SharedMcpServer[]; skills: SharedSkill[] } {
  const ownMcp = nativeMcpSource(agent);
  const ownSkills = nativeSkillSources(agent);
  return {
    mcp: shared.mcp.filter((s) => s.source !== ownMcp && !(agent === "claude" && s.source.startsWith("plugin:"))),
    skills: shared.skills.filter((s) => !ownSkills.has(s.source)),
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

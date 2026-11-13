import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { debugEvent, errorFields } from "../core/debuglog.ts";
import { CODEMAX_HOME } from "../core/paths.ts";
import { IS_WINDOWS, platformCmd, which } from "../core/spawn.ts";

/**
 * Antigravity CLI (`agy`, Google's successor to Gemini CLI) has no ACP mode of
 * its own. Google publishes a separate ACP server for it in the ACP agent
 * registry (the one Zed installs): `agy_acp_server`. codemax drives that, over
 * plain pipes, signed in with the user's Google account (`oauth-personal`).
 *
 * The server is not bundled (it is proprietary and ~110 MB): it is downloaded from
 * the registry's own link, only from dl.google.com, into
 * ~/.codemax/agents/antigravity-acp/<version>/. The terminal app asks first; an app
 * driving codemax (`serve`) gets it without asking, once agy is installed (setup.ts).
 */
export const REGISTRY_URL = "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";
const DIR = () => join(CODEMAX_HOME, "agents", "antigravity-acp");
const BIN = IS_WINDOWS ? "agy_acp_server.exe" : "agy_acp_server.par";

export interface ServerSpec {
  cmd: string[];
  version: string;
}

/** The installed ACP server (newest version first), or one on PATH; null when none. */
export function antigravityServer(): ServerSpec | null {
  const onPath = which("agy_acp_server") ?? which("agy-acp-server");
  if (onPath) return { cmd: [onPath, ...linuxArgs()], version: "PATH" };
  const dir = DIR();
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .filter((v) => !v.startsWith(".") && existsSync(join(dir, v, BIN)))   // ".partial-…": a download under way
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return versions[0] ? { cmd: [join(dir, versions[0], BIN), ...linuxArgs()], version: versions[0] } : null;
}

/** The registry asks Linux builds to run with `--uid=`. */
function linuxArgs(): string[] {
  return process.platform === "linux" ? ["--uid="] : [];
}

/** The registry key for this machine ("darwin-aarch64", "windows-x86_64"…). */
export function platformKey(platform = process.platform, arch = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  return `${os}-${arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch}`;
}

export interface InstallPlan {
  version: string;
  url: string;
  bytes?: number;
}

/** What would be downloaded: the registry's latest version for this machine, and its size. */
export async function antigravityInstallPlan(fetchImpl: typeof fetch = fetch): Promise<InstallPlan> {
  const res = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the ACP registry answered ${res.status}`);
  const entry: any = await res.json();
  const bin = entry?.distribution?.binary?.[platformKey()];
  if (!bin?.archive) throw new Error(`Google publishes no Antigravity ACP server for ${platformKey()}`);
  const url = String(bin.archive);
  // Only Google's own download host: a changed registry entry can't point codemax elsewhere.
  if (!/^https:\/\/dl\.google\.com\//.test(url)) throw new Error(`refusing to download the ACP server from ${new URL(url).host} (expected dl.google.com)`);
  let bytes: number | undefined;
  try {
    const head = await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
    bytes = Number(head.headers.get("content-length")) || undefined;
  } catch {
    /* size unknown */
  }
  // The version becomes a folder name under ~/.codemax/agents: plain version strings only.
  const version = String(entry.version ?? "latest");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version) || version.includes("..")) throw new Error(`refusing an Antigravity ACP server with the version name "${version.slice(0, 40)}"`);
  return { version, url, bytes };
}

/**
 * Download and unpack the server. Returns its command. It is downloaded and unpacked under a temporary name and renamed
 * into place at the end, so a process stopped half-way never leaves a version folder with a cut-off server in it.
 */
export async function installAntigravityServer(plan: InstallPlan, onProgress: (msg: string) => void = () => {}, fetchImpl: typeof fetch = fetch): Promise<ServerSpec> {
  const dest = join(DIR(), plan.version);
  if (existsSync(join(dest, BIN))) return { cmd: [join(dest, BIN), ...linuxArgs()], version: plan.version };
  const tmp = join(DIR(), `.partial-${plan.version}-${process.pid}`);
  const zip = `${tmp}.zip`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    onProgress(`downloading ${plan.url}${plan.bytes ? ` (${Math.round(plan.bytes / 1e6)} MB)` : ""}`);
    const res = await fetchImpl(plan.url);
    // (`res.body` is not looked at: on Bun 1.3 touching it makes Bun.write(file, response) wait forever.)
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    await Bun.write(zip, res);
    onProgress("unpacking");
    const unzip = IS_WINDOWS
      ? ["powershell", "-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`]
      : ["unzip", "-q", "-o", zip, "-d", tmp];
    const p = Bun.spawn(unzip, { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) throw new Error(`could not unpack the archive: ${(await new Response(p.stderr).text()).trim().slice(0, 200)}`);
    if (!existsSync(join(tmp, BIN))) throw new Error(`the archive has no ${BIN}`);
    if (!IS_WINDOWS) chmodSync(join(tmp, BIN), 0o755);
    rmSync(dest, { recursive: true, force: true });   // a folder an older codemax left without a whole server
    renameSync(tmp, dest);
  } finally {
    rmSync(zip, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
  return { cmd: [join(dest, BIN), ...linuxArgs()], version: plan.version };
}

/** Removes what downloads that were stopped half-way left behind. Only while no download runs (setup.ts holds its lock). */
export function clearPartialDownloads() {
  const dir = DIR();
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) if (n.startsWith(".partial-")) rmSync(join(dir, n), { recursive: true, force: true });
}

/**
 * Models Antigravity's own CLI offers that its ACP server does not (checked with agy 1.4.2 and
 * agy_acp_server 1.4.1: the server's Google sign-in gets the Gemini models only, and refuses
 * Claude and GPT-OSS with "not available for the current authentication method"). Read from
 * `agy models` (a listing, no prompt), so /model can say where those models are. Cached.
 */
let agyModels: Promise<{ id: string; name: string }[]> | null = null;
export function agyOnlyModels(acp: { id: string }[], run: () => Promise<string> = defaultAgyModels): Promise<{ id: string; name: string }[]> {
  agyModels ??= run()
    .then((out) => out.split("\n").map((l) => l.split("\t")).filter((p) => p.length >= 2 && p[0]!.trim() && !/^Fetching/.test(p[0]!)).map(([id, name]) => ({ id: id!.trim(), name: name!.trim() })))
    .catch(() => []);
  return agyModels.then((all) => all.filter((m) => !acp.some((a) => a.id === m.id || a.id.startsWith(m.id) || m.id.startsWith(a.id))));
}

async function defaultAgyModels(): Promise<string> {
  if (!which("agy")) return "";
  const p = Bun.spawn({ ...platformCmd(["agy", "models"]), env: process.env as Record<string, string>, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), 8000);
  const out = await new Response(p.stdout).text();
  clearTimeout(timer);
  return out;
}

// ---------- MCP servers of Antigravity's own that cannot start ----------
//
// agy_acp_server (1.4.1) loads every server in <gemini home>/config/mcp_config.json and, when one
// fails to start, refuses every turn ("The MCP server 'x' failed to initialize: … to continue").
// It ignores `"disabled": true` (what `agy mcp disable` writes), so the only way to leave a server
// out is a config without it. The usual case: the Antigravity IDE's Data Agent Kit extension
// registers "data-agent-kit" there, a proxy to a socket that exists only while the IDE is open.
//
// codemax never edits that file. The server takes its home from $GEMINI_HOME, so when a server
// has to be left out it runs in a home of codemax's (~/.codemax/agents/antigravity-home) where
// everything is a link to the real one, except config/mcp_config.json: a copy without the
// servers left out. Login, conversations, plugins, skills and rules stay the user's own files.
// Checked live: same login (no new sign-in), a refused session works again once loaded there.

/** Antigravity's home: $GEMINI_HOME, else ~/.gemini (the server's own rule). */
export function geminiHome(): string {
  return process.env.GEMINI_HOME || join(homedir(), ".gemini");
}

const OVERLAY = () => join(CODEMAX_HOME, "agents", "antigravity-home");
const SKIP_FILE = () => join(CODEMAX_HOME, "antigravity-mcp-skip.json");

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Antigravity's own servers, by name, as its config has them. */
function ownServers(base: string): Record<string, any> {
  const all = readJson(join(base, "config", "mcp_config.json"))?.mcpServers;
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}

/** A server's setup as one string: a skip holds only while the setup is the one that failed. */
const fingerprint = (entry: unknown) => Bun.hash(JSON.stringify(entry ?? null)).toString(36);

/** Servers codemax leaves out because they did not start: name → the setup that failed. */
function skips(): Record<string, string> {
  const s = readJson(SKIP_FILE());
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}

function saveSkips(s: Record<string, string>) {
  mkdirSync(CODEMAX_HOME, { recursive: true });
  writeFileSync(SKIP_FILE(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

export interface LeftOut {
  name: string;
  /** "failed": it did not start under codemax; "disabled": turned off with `agy mcp disable`. */
  why: "failed" | "disabled";
  /** A proxy to the Antigravity IDE: it can only start while the IDE is open. */
  needsIde: boolean;
}

/** The servers of Antigravity's own that codemax starts it without. */
export function antigravityLeftOut(base = geminiHome()): LeftOut[] {
  const skip = skips();
  const out: LeftOut[] = [];
  for (const [name, entry] of Object.entries(ownServers(base))) {
    const why = entry?.disabled === true ? "disabled" : skip[name] === fingerprint(entry) ? "failed" : null;
    if (why) out.push({ name, why, needsIde: /antigravityide/i.test(JSON.stringify(entry?.args ?? "")) });
  }
  return out;
}

/** Leave one of Antigravity's own servers out from now on (it did not start). False when its config has no such server. */
export function skipAntigravityMcp(name: string, base = geminiHome()): boolean {
  const own = ownServers(base);
  const key = Object.keys(own).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return false;
  saveSkips({ ...skips(), [key]: fingerprint(own[key]) });
  return true;
}

/** Try a left-out server again at the next start. False when it was not left out by codemax. */
export function unskipAntigravityMcp(name: string): boolean {
  const s = skips();
  const key = Object.keys(s).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return false;
  delete s[key];
  saveSkips(s);
  return true;
}

/**
 * The home to start the ACP server in: null (its own) when no server has to be left out, else
 * codemax's linked home with the filtered MCP config. Built again at every start, so a changed
 * config or a new file in the real home is picked up.
 */
export function antigravityHome(base = geminiHome(), link: Linker = symlinkSync): { home: string; left: LeftOut[] } | null {
  const left = antigravityLeftOut(base);
  const home = OVERLAY();
  // Only for a server that did not start. One merely turned off with `agy mcp disable` is left
  // out too once the linked home is in use, but does not bring it on by itself.
  if (!left.some((l) => l.why === "failed") || base === home) return null;
  try {
    const t0 = Date.now();
    // The login and conversations live here; were it missing, the server would create it inside
    // codemax's home and a later start in the real one would ask to sign in again.
    mkdirSync(join(base, "antigravity-acp"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
    const links = mirror(base, home, new Set(["config"]), link) + mirror(join(base, "config"), join(home, "config"), new Set(["mcp_config.json"]), link);
    const config = readJson(join(base, "config", "mcp_config.json"));
    const out = new Set(left.map((l) => l.name));
    config.mcpServers = Object.fromEntries(Object.entries(config.mcpServers).filter(([name]) => !out.has(name)));
    const file = join(home, "config", "mcp_config.json");
    writeFileSync(`${file}.new`, JSON.stringify(config, null, 2), { mode: 0o600 });   // it can hold tokens
    renameSync(`${file}.new`, file);
    // Counts only: server names and setups are the user's.
    debugEvent("antigravity-home", { ms: Date.now() - t0, links, kept: Object.keys(config.mcpServers).length, failed: left.filter((l) => l.why === "failed").length || undefined, disabled: left.filter((l) => l.why === "disabled").length || undefined });
    return { home, left };
  } catch (e) {
    // Without the linked home the agent starts as before (and may refuse its turns again).
    debugEvent("antigravity-home-failed", errorFields(e));
    return null;
  }
}

/** `symlinkSync`, or a stand-in: Windows without Developer Mode refuses links to files (tests). */
type Linker = (target: string, path: string, type: "dir" | "file" | "junction") => void;

/**
 * Make `to` show everything in `from` except `own` (which the caller writes itself): folders as
 * links (junctions on Windows, which need no privilege), files as links, or where Windows
 * refuses those a hard link, or a copy. Nothing is ever removed recursively: only a link, a
 * file, or an empty folder, so the real home cannot be reached through a link and deleted.
 */
function mirror(from: string, to: string, own: Set<string>, link: Linker): number {
  const want = new Map<string, boolean>();   // name → is a folder
  for (const d of readdirSync(from, { withFileTypes: true })) {
    if (own.has(d.name) || /\.(tmp|lock|new)$/.test(d.name)) continue;
    let dir: boolean;
    try {
      dir = statSync(join(from, d.name)).isDirectory();   // follows a link in the real home
    } catch {
      continue;   // a dangling link
    }
    want.set(d.name, dir);
  }
  for (const d of readdirSync(to, { withFileTypes: true })) {
    if (own.has(d.name) || d.name.endsWith(".new")) continue;
    const at = join(to, d.name);
    const target = join(from, d.name);
    if (d.isSymbolicLink()) {
      let same = false;
      try {
        same = want.has(d.name) && readlinkSync(at).replace(/[\\/]+$/, "") === target;
      } catch { /* unreadable: replaced below */ }
      if (same) want.delete(d.name);
      else unlinkOne(at);
    } else if (d.isFile()) {
      unlinkOne(at);   // a hard link or copy: made again, so it is never stale
    }
    // A real folder here was made by the server itself: left alone.
    else want.delete(d.name);
  }
  let made = 0;
  for (const [name, dir] of want) {
    const target = join(from, name);
    const at = join(to, name);
    try {
      link(target, at, dir ? (IS_WINDOWS ? "junction" : "dir") : "file");
    } catch {
      if (dir) continue;
      try {
        linkSync(target, at);
      } catch {
        try {
          copyFileSync(target, at);
        } catch {
          continue;
        }
      }
    }
    made++;
  }
  return made;
}

/** Remove one link or file. A junction is removed as the empty folder Windows sees it as. */
function unlinkOne(at: string) {
  try {
    unlinkSync(at);
  } catch {
    try {
      rmdirSync(at);
    } catch { /* stays; linking over it fails and is skipped */ }
  }
}

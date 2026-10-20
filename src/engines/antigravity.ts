import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CODEMAX_HOME } from "../core/paths.ts";
import { IS_WINDOWS, platformArgv } from "../core/spawn.ts";

/**
 * Antigravity CLI (`agy`, Google's successor to Gemini CLI) has no ACP mode of
 * its own. Google publishes a separate ACP server for it in the ACP agent
 * registry (the one Zed installs): `agy_acp_server`. codemax drives that, over
 * plain pipes, signed in with the user's Google account (`oauth-personal`).
 *
 * The server is not bundled (it is proprietary and ~110 MB): codemax offers to
 * download it from the registry's own link, only from dl.google.com, into
 * ~/.codemax/agents/antigravity-acp/<version>/.
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
  const onPath = Bun.which("agy_acp_server") ?? Bun.which("agy-acp-server");
  if (onPath) return { cmd: [onPath, ...linuxArgs()], version: "PATH" };
  const dir = DIR();
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .filter((v) => existsSync(join(dir, v, BIN)))
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

/** Download and unpack the server. Returns its command. */
export async function installAntigravityServer(plan: InstallPlan, onProgress: (msg: string) => void = () => {}): Promise<ServerSpec> {
  const dest = join(DIR(), plan.version);
  const zip = join(DIR(), `agy-acp-${plan.version}.zip`);
  mkdirSync(dest, { recursive: true });
  onProgress(`downloading ${plan.url}${plan.bytes ? ` (${Math.round(plan.bytes / 1e6)} MB)` : ""}`);
  const res = await fetch(plan.url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await Bun.write(zip, res);
  onProgress("unpacking");
  const unzip = IS_WINDOWS
    ? ["powershell", "-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]
    : ["unzip", "-q", "-o", zip, "-d", dest];
  const p = Bun.spawn(unzip, { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  rmSync(zip, { force: true });
  if (code !== 0) throw new Error(`could not unpack the archive: ${(await new Response(p.stderr).text()).trim().slice(0, 200)}`);
  const bin = join(dest, BIN);
  if (!existsSync(bin)) throw new Error(`the archive has no ${BIN}`);
  if (!IS_WINDOWS) chmodSync(bin, 0o755);
  return { cmd: [bin, ...linuxArgs()], version: plan.version };
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
  if (!Bun.which("agy")) return "";
  const p = Bun.spawn(platformArgv(["agy", "models"]), { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), 8000);
  const out = await new Response(p.stdout).text();
  clearTimeout(timer);
  return out;
}

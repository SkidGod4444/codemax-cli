import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CODEMAX_HOME, ensureDir } from "./paths.ts";

/**
 * Update checks and self-update. At most every 12 hours (3 s timeout, never
 * blocking startup) codemax asks for the newest version from the place its own
 * update comes from: npm for npm installs, GitHub releases for the installer,
 * source checkouts and standalone builds. So a release is only offered where
 * `/update` can actually fetch it. `/update` / `codemax update` then updates
 * the way codemax was installed.
 */
const REGISTRY = "https://registry.npmjs.org/codemax-cli/latest";
const RELEASES = "https://api.github.com/repos/SkidGod4444/codemax-cli/releases/latest";
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const CACHE = () => join(CODEMAX_HOME, "update-check.json");

export type InstallKind = "npm" | "script" | "source" | "binary";

/** How this codemax was installed, judged from where its code lives. */
export function installKind(root = resolve(import.meta.dir, "..", "..")): { kind: InstallKind; root: string } {
  if (root.includes("$bunfs") || root.startsWith("/$bunfs") || root.startsWith("B:\\~BUN")) return { kind: "binary", root };
  if (root.includes(`${sep}node_modules${sep}codemax-cli`) || root.includes("/node_modules/codemax-cli")) return { kind: "npm", root };
  if (existsSync(join(root, ".git")) && /[\\/]\.codemax[\\/]cli$/.test(root)) return { kind: "script", root };
  if (existsSync(join(root, ".git"))) return { kind: "source", root };
  return { kind: "npm", root };
}

/** a > b for x.y.z versions (pre-release suffixes ignored). */
export function isNewer(a: string, b: string): boolean {
  const p = (v: string) => v.replace(/^v/, "").split("-")[0]!.split(".").map((n) => Number(n) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export async function latestVersion(source: "npm" | "github" = "npm", fetchImpl: typeof fetch = fetch, timeoutMs = 3000): Promise<string | null> {
  try {
    const res = await fetchImpl(source === "npm" ? REGISTRY : RELEASES, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: source === "npm" ? "application/json" : "application/vnd.github+json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown; tag_name?: unknown };
    const v = String((source === "npm" ? body.version : body.tag_name) ?? "").replace(/^v/, "");
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Where this install's updates come from. */
export function updateSource(kind: InstallKind = installKind().kind): "npm" | "github" {
  return kind === "npm" ? "npm" : "github";
}

/** The latest version when it is newer than `current`; null otherwise. Cached for 12 hours. */
export async function checkForUpdate(current: string, o: { force?: boolean; fetchImpl?: typeof fetch; source?: "npm" | "github" } = {}): Promise<string | null> {
  const source = o.source ?? updateSource();
  let cached: { at: number; latest: string | null; source?: string } | null = null;
  try {
    cached = existsSync(CACHE()) ? JSON.parse(readFileSync(CACHE(), "utf8")) : null;
  } catch {
    cached = null;
  }
  let latest = cached?.latest ?? null;
  if (o.force || !cached || cached.source !== source || Date.now() - cached.at > CHECK_EVERY_MS) {
    latest = await latestVersion(source, o.fetchImpl);
    try {
      ensureDir(CODEMAX_HOME);
      writeFileSync(CACHE(), JSON.stringify({ at: Date.now(), latest, source }) + "\n");
    } catch {
      /* read-only home: check again next time */
    }
  }
  return latest && isNewer(latest, current) ? latest : null;
}

/** The command that updates this install, or null with an explanation when it cannot update itself. */
export function updatePlan(install = installKind(), platform = process.platform): { cmd: string[][]; env?: Record<string, string>; manual?: string; label: string } {
  switch (install.kind) {
    case "npm":
      return { cmd: [["npm", "install", "-g", "codemax-cli@latest"]], label: "npm install -g codemax-cli@latest" };
    case "script":
      return platform === "win32"
        ? { cmd: [["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(install.root, "install.ps1")]], env: { CODEMAX_DIR: install.root }, label: "the codemax installer (newest release)" }
        : { cmd: [["bash", join(install.root, "install.sh")]], env: { CODEMAX_DIR: install.root }, label: "the codemax installer (newest release)" };
    case "source":
      return { cmd: [["git", "-C", install.root, "pull", "--ff-only"], ["bun", "install", "--cwd", install.root]], label: `git pull in ${install.root}` };
    case "binary":
      return { cmd: [], manual: "This is a standalone build; download the new release from https://github.com/SkidGod4444/codemax-cli/releases or switch to `npm install -g codemax-cli`.", label: "manual download" };
  }
}

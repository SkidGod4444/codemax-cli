import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { chmodSync, realpathSync, mkdirSync, existsSync, statSync } from "node:fs";

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

/** Folders codemax creates are yours only (transcripts and tool output can hold secrets). */
export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * ~/.codemax readable by you only, also when an older codemax created it 0755: everything in
 * it (ledgers, journals, sessions, history) is then out of other local users' reach.
 */
export function privateHome() {
  ensureDir(CODEMAX_HOME);
  if (process.platform === "win32") return;
  try {
    if ((statSync(CODEMAX_HOME).mode & 0o077) !== 0) chmodSync(CODEMAX_HOME, 0o700);
  } catch {
    /* not ours to change */
  }
}

/** `path` (or, for a new file, its nearest existing folder) resolves inside `dir`, symlinks followed. */
export function insideDir(dir: string, path: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      const parent = dirname(p);
      return parent === p ? p : join(real(parent), basename(p));
    }
  };
  const root = real(resolve(dir));
  const target = real(resolve(dir, path));
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}


/**
 * Places that hold secrets (keys, logins, tokens, browser data). An agent reading one of
 * these outside the project always needs your yes, in every mode; other reads go through.
 * Returns what the place is, or null.
 */
export function secretPlace(path: string, home = HOME): string | null {
  let p = resolve(path);
  try {
    p = realpathSync(p);
  } catch {
    /* not there yet */
  }
  const under = (rel: string) => {
    const base = join(home, rel);
    return p === base || p.startsWith(base + sep);
  };
  const dirs: [string, string][] = [
    [".ssh", "SSH keys"], [".gnupg", "GPG keys"], [".aws", "AWS credentials"], [".azure", "Azure credentials"],
    [".config/gcloud", "Google Cloud credentials"], [".kube", "Kubernetes credentials"], [".docker", "Docker credentials"],
    [".config/gh", "GitHub CLI login"], [".codemax", "codemax's own records"], [".password-store", "passwords"],
    ["Library/Keychains", "the keychain"], ["Library/Cookies", "cookies"], ["Library/Safari", "Safari data"],
    ["Library/Application Support/Google/Chrome", "Chrome profiles"], ["Library/Application Support/Firefox", "Firefox profiles"],
    ["Library/Application Support/BraveSoftware", "Brave profiles"], ["Library/Application Support/Microsoft Edge", "Edge profiles"],
    [".config/google-chrome", "Chrome profiles"], [".config/chromium", "Chromium profiles"], [".mozilla", "Firefox profiles"],
    [".local/share/keyrings", "the keyring"],
  ];
  for (const [rel, what] of dirs) if (under(rel)) return what;
  const files: [string, string][] = [
    [".netrc", "saved logins"], [".npmrc", "npm token"], [".pypirc", "PyPI token"], [".git-credentials", "git credentials"],
    [".claude.json", "Claude login"], [".claude/.credentials.json", "Claude login"], [".codex/auth.json", "Codex login"],
    [".gemini/oauth_creds.json", "Google login"], [".gemini/antigravity-acp/settings.json", "Antigravity login"],
    [".config/hub", "GitHub token"], [".cargo/credentials.toml", "Cargo token"], [".cargo/credentials", "Cargo token"],
  ];
  for (const [rel, what] of files) if (p === join(home, rel)) return what;
  const name = basename(p);
  if (/^\.env(\..+)?$/.test(name)) return "an environment file (.env)";
  if (/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(name) || /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name)) return "a private key";
  if (p === "/etc/shadow" || p === "/etc/sudoers" || p.startsWith("/etc/sudoers.d/")) return "system passwords";
  return null;
}

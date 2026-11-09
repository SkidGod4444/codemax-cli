import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { IS_WINDOWS } from "./spawn.ts";

/**
 * An app starts codemax with the app's own PATH (on macOS launchd gives apps /usr/bin:/bin:/usr/sbin:/sbin), which
 * misses the folders agent CLIs are installed in. `serve` therefore searches system wide: the PATH of the person's
 * login shell (what their terminal finds) first, then what it was started with, then the usual install folders
 * (Claude's and others' ~/.local/bin, Homebrew, npm's, Bun's, Volta's, pnpm's, nvm's Node versions).
 */
export function knownBinDirs(home = homedir(), exists: (p: string) => boolean = existsSync): string[] {
  if (IS_WINDOWS) return [];
  const dirs = [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, "Library", "pnpm"),
    join(home, ".yarn", "bin"),
    join(home, ".cargo", "bin"),
  ];
  // nvm: every installed Node, newest first (globally installed CLIs live with the Node that installed them).
  const nvm = join(home, ".nvm", "versions", "node");
  try {
    const versions = readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) dirs.push(join(nvm, v, "bin"));
  } catch {
    /* no nvm */
  }
  return dirs.filter((d) => exists(d));
}

const MARK = "__CODEMAX_PATH__";

/**
 * The PATH an interactive login shell of the person's ends up with (`-i` too: nvm and many installers add to PATH in
 * .zshrc, which a login shell alone does not read). Empty when the shell fails or takes longer than `timeoutMs`;
 * whatever the rc files print is ignored, only the text between the markers counts.
 */
export async function loginShellPath(shell = process.env.SHELL || "/bin/zsh", timeoutMs = 4000): Promise<string[]> {
  if (IS_WINDOWS) return [];
  let p: ReturnType<typeof Bun.spawn> | undefined;
  try {
    p = Bun.spawn({
      cmd: [shell, "-ilc", `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`],
      env: { ...(process.env as Record<string, string>), CODEMAX_SHELL_PROBE: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    // Raced, not just killed on time: something an rc file starts in the background can keep stdout open.
    const out = await Promise.race([new Response(p.stdout as ReadableStream).text(), Bun.sleep(timeoutMs).then(() => "")]);
    const m = out.match(new RegExp(`${MARK}([\\s\\S]*?)${MARK}`));
    return m ? m[1]!.split(delimiter).filter((d) => d.startsWith("/")) : [];
  } catch {
    return [];
  } finally {
    try {
      p?.kill();
    } catch {
      /* already gone */
    }
  }
}

/** `first` folders, then `current`'s, then `extra`, each once, in that order. */
export function mergePath(first: string[], current: string, extra: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...first, ...current.split(delimiter), ...extra]) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(delimiter);
}

let widened: Promise<void> | null = null;

/**
 * Widens this process's PATH as described above, once; later calls wait for the first. Agents inherit it.
 * CODEMAX_SYSTEM_PATH=0 keeps the PATH codemax was started with (a shell whose rc files misbehave; tests).
 */
export function widenPath(): Promise<void> {
  widened ??= (async () => {
    if (process.env.CODEMAX_SYSTEM_PATH === "0") return;
    const shell = await loginShellPath();
    process.env.PATH = mergePath(shell, process.env.PATH ?? "", knownBinDirs());
  })();
  return widened;
}

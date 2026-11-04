/*
 * Cross-platform process arguments. On macOS and Linux these return argv
 * unchanged. On Windows, CLIs installed through npm are `.cmd` shims that
 * cannot be started directly, so they are resolved through PATH/PATHEXT and
 * run via cmd.exe; shell commands go to cmd.exe instead of sh.
 */
export const IS_WINDOWS = process.platform === "win32";

/** Bun.spawn's `cmd` for argv on this platform, and how to pass it. Spread it into Bun.spawn's options. */
export interface PlatformCmd {
  cmd: string[];
  windowsVerbatimArguments?: boolean;
}

export function platformCmd(argv: string[]): PlatformCmd {
  if (!IS_WINDOWS || argv.length === 0) return { cmd: argv };
  const [bin, ...rest] = argv as [string, ...string[]];
  const path = Bun.which(bin) ?? bin;
  if (!/\.(cmd|bat)$/i.test(path)) return { cmd: [path, ...rest] };
  // The line goes to cmd.exe as written: Bun's own quoting puts quotes around a path with a
  // space (C:\Users\neeraj kumar\…\codex.cmd), and `/s` then strips the first and last quote
  // of the line, which split the path at the space ("'C:\Users\neeraj' is not recognized").
  return { cmd: ["cmd.exe", "/d", "/s", "/c", `"${cmdLine(path, rest)}"`], windowsVerbatimArguments: true };
}

// cmd.exe metacharacters, escaped with ^ (as cross-spawn does, https://qntm.org/cmd).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * The command line that runs a batch file (an npm or pnpm `.cmd` shim) with these arguments under
 * `cmd.exe /d /s /c "<line>"`. The path is quoted (cmd.exe takes a quoted command name with spaces
 * or parentheses); each argument is quoted for the program's own parser and its cmd.exe
 * metacharacters escaped with ^, twice for a node_modules\.bin shim, whose %* cmd.exe reads again.
 */
export function cmdLine(path: string, args: string[]): string {
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(path);
  const arg = (a: string) => {
    let s = `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1");
    if (twice) s = s.replace(CMD_META, "^$1");
    return s;
  };
  return [`"${path}"`, ...args.map(arg)].join(" ");
}

/**
 * argv that runs one shell command line (`!cmd` in the chat, checks after edits). Spawn it
 * with SHELL_SPAWN: on Windows the line must reach cmd.exe untouched. Bun's default quoting
 * escapes `"` as `\"`, which cmd.exe does not understand, so `/s /c "<line>"` is passed
 * verbatim and cmd.exe strips only the outer quotes.
 */
export function shellArgv(cmd: string): string[] {
  return IS_WINDOWS ? ["cmd.exe", "/d", "/s", "/c", `"${cmd}"`] : ["sh", "-c", cmd];
}

export const SHELL_SPAWN: { windowsVerbatimArguments?: boolean } = IS_WINDOWS ? { windowsVerbatimArguments: true } : {};

/**
 * Child processes codemax started (agents, checks, `!` commands). Each runs in its own
 * process group (`detached`), so stopping it also stops what it started: an agent's shell,
 * a dev server, `npm` → `node`. They are all stopped when codemax exits, however it exits.
 */
const children = new Set<Bun.Subprocess>();

export const GROUP_SPAWN: { detached?: boolean } = IS_WINDOWS ? {} : { detached: true };

/** Remember a child started with GROUP_SPAWN, until it exits. */
export function trackChild<T extends Bun.Subprocess>(p: T): T {
  children.add(p);
  void p.exited.then(() => children.delete(p));
  return p;
}

/** Stop a child and everything it started. */
export function killTree(p: Bun.Subprocess, signal: NodeJS.Signals = "SIGTERM") {
  if (p.exitCode !== null || p.signalCode !== null) return;
  try {
    if (IS_WINDOWS) Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(p.pid)], { stdout: "ignore", stderr: "ignore" });
    else process.kill(-p.pid, signal);
  } catch {
    try {
      p.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

let exitHooked = false;
/** On exit (normal, crash or signal), stop every child still running. */
export function stopChildrenOnExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => {
    for (const p of children) killTree(p, "SIGKILL");
  });
}

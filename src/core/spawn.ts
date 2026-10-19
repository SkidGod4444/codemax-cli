/*
 * Cross-platform process arguments. On macOS and Linux these return argv
 * unchanged. On Windows, CLIs installed through npm are `.cmd` shims that
 * cannot be started directly, so they are resolved through PATH/PATHEXT and
 * run via cmd.exe; shell commands go to cmd.exe instead of sh.
 */
export const IS_WINDOWS = process.platform === "win32";

/** argv ready for Bun.spawn on this platform. */
export function platformArgv(argv: string[]): string[] {
  if (!IS_WINDOWS || argv.length === 0) return argv;
  const [bin, ...rest] = argv as [string, ...string[]];
  const path = Bun.which(bin) ?? bin;
  return /\.(cmd|bat)$/i.test(path) ? ["cmd.exe", "/d", "/s", "/c", path, ...rest] : [path, ...rest];
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

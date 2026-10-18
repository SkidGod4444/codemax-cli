import type { DetectResult } from "./types.ts";
import { platformArgv } from "../core/spawn.ts";

export interface DetectDeps {
  which: (bin: string) => string | null;
  run: (argv: string[], timeoutMs: number) => Promise<{ code: number | null; out: string; timedOut?: boolean }>;
}

const defaultDeps: DetectDeps = {
  which: (b) => Bun.which(b),
  run: async (argv, timeoutMs) => {
    const p = Bun.spawn(platformArgv(argv), { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out: `${out}\n${err}`.trim(), timedOut };
  },
};

/**
 * An agent counts as installed only when its CLI actually runs: `<bin> --version`
 * must exit 0. A file on PATH alone is not enough; on Windows an uninstalled npm
 * CLI can leave shims behind that no longer start, and those must not be offered.
 */
export async function detectBin(bin: string, versionArgs: string[] = ["--version"], deps: DetectDeps = defaultDeps, timeoutMs = 15000): Promise<DetectResult> {
  const path = deps.which(bin);
  if (!path) return { installed: false };
  try {
    const r = await deps.run([path, ...versionArgs], timeoutMs);
    const lines = r.out.split("\n").map((l) => l.trim()).filter(Boolean);
    // Node prints a stack location first; the line naming the error is the useful one.
    const first = lines.find((l) => /error|not found|cannot|denied/i.test(l)) ?? lines[0] ?? "";
    if (r.timedOut) return { installed: false, path, problem: `${bin} was found at ${path} but did not answer ${versionArgs.join(" ")} within ${Math.round(timeoutMs / 1000)}s` };
    if (r.code !== 0) return { installed: false, path, problem: `${bin} was found at ${path} but does not run${first ? `: ${first.slice(0, 160)}` : ` (exit ${r.code})`}` };
    const m = r.out.match(/\d+\.\d+(\.\d+)?/);
    return { installed: true, path, version: m?.[0] ?? first };
  } catch (e: any) {
    return { installed: false, path, problem: `${bin} was found at ${path} but could not be started: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

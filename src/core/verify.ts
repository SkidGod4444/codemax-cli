import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SHELL_SPAWN, shellArgv } from "./spawn.ts";

/**
 * Checks after edits: the project's own test / typecheck command, run by
 * codemax after every main-agent turn that changed files. The command is the
 * user's choice (picked from what the project defines, or typed with
 * /verify <command>), saved per project in config.json.
 */

/** Wall-clock limit for one run of the checks. */
export const VERIFY_TIMEOUT_MS = 10 * 60_000;
/** Times per task a failure is sent back to the agent automatically ("fix" mode). */
export const VERIFY_FIX_CAP = 2;
/** Output kept from one run (the end, where failures are summarised). */
const KEEP_OUTPUT = 200_000;

/** Commands this project defines, most useful first. */
export function verifyCandidates(cwd: string): string[] {
  const out: string[] = [];
  const has = (f: string) => existsSync(join(cwd, f));
  try {
    if (has("package.json")) {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {};
      const pm = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
      // `bun test` is Bun's own runner, not the script: scripts always go through `run`.
      const run = (name: string) => (pm === "npm" && name === "test" ? "npm test" : `${pm} run ${name}`);
      const real = (name: string) => typeof scripts[name] === "string" && !/no test specified/.test(scripts[name]!);
      const checks = ["typecheck", "lint", "test"].filter(real);
      if (checks.length > 1) out.push(checks.map(run).join(" && "));
      for (const c of [...checks].reverse()) out.push(run(c));
      if (!real("test") && pm === "bun" && /bun test/.test(JSON.stringify(scripts))) out.push("bun test");
    }
  } catch {
    /* unreadable package.json */
  }
  if (has("Cargo.toml")) out.push("cargo test", "cargo check");
  if (has("go.mod")) out.push("go test ./...", "go vet ./...");
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg") || has("tox.ini")) out.push("pytest");
  try {
    if (has("Makefile") && /^test:/m.test(readFileSync(join(cwd, "Makefile"), "utf8"))) out.push("make test");
  } catch {
    /* ignore */
  }
  return [...new Set(out)];
}

export interface VerifyResult {
  code: number;
  output: string;
  ms: number;
  timedOut: boolean;
  stopped: boolean;
}

/** Run the checks in the project; `stop()` ends them early. */
export function runVerify(cmd: string, cwd: string, timeoutMs = VERIFY_TIMEOUT_MS): { done: Promise<VerifyResult>; stop: () => void } {
  const t0 = Date.now();
  const p = Bun.spawn(shellArgv(cmd), { ...SHELL_SPAWN, cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0", NO_COLOR: "1" } });
  let stopped = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, timeoutMs);
  const done = (async () => {
    let output = "";
    const read = async (s: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const chunk of s) {
        output += dec.decode(chunk, { stream: true });
        if (output.length > KEEP_OUTPUT * 2) output = output.slice(-KEEP_OUTPUT);
      }
    };
    await Promise.all([read(p.stdout as ReadableStream<Uint8Array>), read(p.stderr as ReadableStream<Uint8Array>)]);
    const code = await p.exited;
    clearTimeout(timer);
    return { code, output: output.slice(-KEEP_OUTPUT).trimEnd(), ms: Date.now() - t0, timedOut, stopped };
  })();
  return {
    done,
    stop: () => {
      stopped = true;
      p.kill();
    },
  };
}

/** The last `lines` lines of the output (where test runners print their summary). */
export function tail(output: string, lines: number): string {
  const all = output.split("\n");
  return all.length <= lines ? output : `… ${all.length - lines} lines above\n${all.slice(-lines).join("\n")}`;
}

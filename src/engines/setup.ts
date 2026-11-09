import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODEMAX_HOME } from "../core/paths.ts";
import { IS_COMPILED } from "../core/update.ts";
import { agentEnv } from "./env.ts";
import { antigravityInstallPlan, antigravityServer, clearPartialDownloads, installAntigravityServer } from "./antigravity.ts";
import { CLAUDE_ADAPTER_PKG, claudeAdapter } from "./index.ts";

/**
 * Protocol engines codemax sets up by itself when an app drives it (`serve`). The person installed the agent; the
 * bridge codemax needs to talk to it is fetched without asking, so the agent simply shows up as ready:
 *
 * - antigravity: Google's ACP server (~110 MB, dl.google.com only). Antigravity cannot be used before it is there.
 * - claude: bunx's cache is filled with the Claude ACP adapter, so the first message does not wait ~10 s for it.
 *
 * Each runs as a detached `codemax install-engine <agent>`: an app may stop the serve that started it at any time
 * (EditMax stops a window's serve 4 s after the window closes, and its updater's health check after one request),
 * and the download still finishes. A lock file keeps the serves of several windows from downloading it twice; a
 * failure is remembered for 10 minutes, so a broken download is not restarted on every request.
 */
export type SetupAgent = "antigravity" | "claude";
export const SETUP_AGENTS: readonly SetupAgent[] = ["antigravity", "claude"];

const DIR = () => join(CODEMAX_HOME, "agents");
const lockFile = (a: SetupAgent) => join(DIR(), `${a}-install.lock`);
const failFile = (a: SetupAgent) => join(DIR(), `${a}-install.failed`);
const warmFile = () => join(DIR(), `${CLAUDE_ADAPTER_PKG.replace(/^@[^/]+\//, "").replace(/[^\w.@-]/g, "_")}.ready`);
const RETRY_MS = 10 * 60_000;
/** A lock this young whose contents cannot be read yet is being written, not left over. */
const FRESH_LOCK_MS = 10_000;
/** Between starting the installer and its lock appearing, this process still counts it as installing. */
const STARTING_MS = 15_000;

export interface SetupState {
  state: "idle" | "installing" | "failed";
  error?: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

function lockHeld(a: SetupAgent): boolean {
  const f = lockFile(a);
  if (!existsSync(f)) return false;
  try {
    const { pid } = JSON.parse(readFileSync(f, "utf8"));
    return typeof pid === "number" && alive(pid);
  } catch {
    try {
      return Date.now() - statSync(f).mtimeMs < FRESH_LOCK_MS;
    } catch {
      return false;
    }
  }
}

const started = new Map<SetupAgent, number>();

export function setupState(a: SetupAgent, now = Date.now()): SetupState {
  if (lockHeld(a) || now - (started.get(a) ?? 0) < STARTING_MS) return { state: "installing" };
  try {
    const f = JSON.parse(readFileSync(failFile(a), "utf8"));
    if (now - Number(f.at) < RETRY_MS) return { state: "failed", error: String(f.error ?? "unknown error") };
  } catch {
    /* no recent failure */
  }
  return { state: "idle" };
}

/** Whether bunx already has the Claude ACP adapter this codemax runs. */
export function claudeAdapterWarm(): boolean {
  return existsSync(warmFile());
}

/** The command that runs this codemax again: the compiled binary itself, or Bun with src/cli.ts. */
export function selfCommand(): string[] {
  return IS_COMPILED ? [process.execPath] : [process.execPath, resolve(import.meta.dir, "..", "cli.ts")];
}

function spawnDetached(cmd: string[]) {
  const p = Bun.spawn({ cmd, env: process.env as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  p.unref();
}

/** Starts `codemax install-engine <a>` in the background, unless one runs or one failed in the last 10 minutes. */
export function startSetup(a: SetupAgent, spawn: (cmd: string[]) => void = spawnDetached): SetupState {
  const s = setupState(a);
  if (s.state !== "idle") return s;
  started.set(a, Date.now());
  try {
    spawn([...selfCommand(), "install-engine", a]);
  } catch (e: any) {
    started.delete(a);
    return { state: "failed", error: `could not start the installer: ${e?.message ?? e}` };
  }
  return { state: "installing" };
}

/**
 * What `serve` reports for an installed agent while its engine is being set up (undefined: nothing to say), and the
 * setup it starts. `engine`: whether the agent can be driven right now.
 */
export function setupEngine(agent: string, engine: boolean, start: (a: SetupAgent) => SetupState = (a) => startSetup(a)): string | undefined {
  if (agent === "antigravity" && !engine) {
    const s = start("antigravity");
    if (s.state === "installing") return "installing Google's ACP server for Antigravity (about 110 MB, once): ready in a minute or two";
    if (s.state === "failed") return `could not download Google's ACP server for Antigravity (${s.error}); trying again in 10 minutes`;
    return undefined;
  }
  if (agent === "claude" && engine && claudeAdapter()?.fetched && !claudeAdapterWarm()) start("claude");
  return undefined;
}

function takeLock(a: SetupAgent): boolean {
  mkdirSync(DIR(), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(lockFile(a), "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      if (lockHeld(a)) return false;
      rmSync(lockFile(a), { force: true });   // left by an installer that was killed
    }
  }
  return false;
}

/** `codemax install-engine <agent>`: sets the engine up now. Exit code 0 when it is ready (or another codemax is on it). */
export async function runSetup(a: SetupAgent, log: (msg: string) => void = (m) => console.log(m)): Promise<number> {
  if (!takeLock(a)) {
    log(`another codemax is installing the ${a} engine`);
    return 0;
  }
  try {
    if (a === "antigravity") {
      clearPartialDownloads();
      const have = antigravityServer();
      if (have) log(`Google's ACP server for Antigravity ${have.version} is already installed`);
      else {
        const plan = await antigravityInstallPlan();
        await installAntigravityServer(plan, log);
        log(`Google's ACP server for Antigravity ${plan.version} is installed`);
      }
    } else {
      const adapter = claudeAdapter();
      if (!adapter) throw new Error("no Bun here to run the Claude ACP adapter with");
      const p = Bun.spawn({ cmd: [...adapter.cmd, "--version"], env: agentEnv(adapter.env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => p.kill(), 5 * 60_000);
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      clearTimeout(timer);
      if (code !== 0) throw new Error(`the Claude ACP adapter did not start (exit ${code}): ${(err || out).trim().split("\n").pop()?.slice(0, 200)}`);
      writeFileSync(warmFile(), `${new Date().toISOString()} ${out.trim()}\n`);
      log(`Claude ACP adapter ${out.trim()} is ready`);
    }
    rmSync(failFile(a), { force: true });
    return 0;
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 300);
    writeFileSync(failFile(a), JSON.stringify({ at: Date.now(), error }));
    log(`could not install the ${a} engine: ${error}`);
    return 1;
  } finally {
    rmSync(lockFile(a), { force: true });
  }
}

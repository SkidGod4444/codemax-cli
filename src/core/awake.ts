import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CODEMAX_HOME, ensureDir } from "./paths.ts";

/**
 * Keep the machine awake while codemax runs, so agents keep working.
 *
 *   on   no idle/system sleep (and on Linux, no shutdown) while codemax runs
 *   lid  the same, and keep working with the laptop lid closed
 *
 * How, per platform:
 *   macOS    `caffeinate -dims -w <pid>` (the display too: no screen saver or
 *            lock while agents work); lid: `pmset -a disablesleep 1` (admin
 *            password once). A root watchdog started with the same password sets
 *            it and puts it back within seconds of codemax exiting for any reason
 *            (quit, crash, kill -9, closed terminal). macOS cannot block shutdown.
 *   Linux    `systemd-inhibit --mode=block` on idle, sleep and shutdown, plus
 *            handle-lid-switch for lid mode. No admin needed on a desktop session.
 *   Windows  SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED) from a
 *            PowerShell helper; lid: lid action set to "do nothing" on the current
 *            power plan, restored afterwards. Windows cannot block shutdown.
 *
 * Safety: every holder process watches codemax's pid and exits with it, so a
 * crash never leaves the machine unable to sleep. Settings that outlive a
 * process (pmset, powercfg) are written to a restore record first and put back
 * on release, on exit, or at the next start if codemax died.
 */
export type AwakeMode = "off" | "on" | "lid";

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export interface AwakeDeps {
  platform: NodeJS.Platform;
  pid: number;
  /** Run a command to completion. `interactive` lets it use the terminal (a sudo prompt). */
  run: (cmd: string[], o?: { interactive?: boolean }) => Promise<RunResult>;
  /** Start a long-running holder process. */
  spawn: (cmd: string[]) => { kill(): void };
  which: (bin: string) => string | null;
  recordPath: string;
  /** Wraps an interactive command (the chat pauses its screen around it). */
  interactive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

interface RestoreRecord {
  platform: NodeJS.Platform;
  pid: number;
  at: number;
  mac?: { disablesleep: number };
  win?: { ac: number; dc: number };
}

export interface AwakeStatus {
  mode: AwakeMode;
  /** True when lid-close is actually covered right now. */
  lid: boolean;
  notes: string[];
}

export function defaultAwakeDeps(): AwakeDeps {
  return {
    platform: process.platform,
    pid: process.pid,
    which: (b) => Bun.which(b),
    recordPath: join(CODEMAX_HOME, "awake-restore.json"),
    run: async (cmd, o) => {
      const p = Bun.spawn(cmd, { stdin: o?.interactive ? "inherit" : "ignore", stdout: o?.interactive ? "inherit" : "pipe", stderr: o?.interactive ? "inherit" : "pipe" });
      const [out, err] = o?.interactive ? ["", ""] : await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text()]);
      return { code: await p.exited, out: out.trim(), err: err.trim() };
    },
    spawn: (cmd) => {
      const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return { kill: () => p.kill() };
    },
  };
}

const WHY = "A coding agent is working (codemax /awake)";
// ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED (0x80000003): the screen stays on
// too. Written so PowerShell keeps it unsigned: a bare 0x80000003 is read as a negative
// Int32 and the call fails.
const ES_CONTINUOUS_SYSTEM_REQUIRED = "[uint32]2147483651";

export class Awake {
  mode: AwakeMode = "off";
  private holder: { kill(): void } | null = null;
  private lidActive = false;
  /** macOS lid mode: the root watchdog and the flag file that keeps it holding. */
  private macWatch: { kill(): void } | null = null;
  private macFlag: string | null = null;

  constructor(private d: AwakeDeps = defaultAwakeDeps()) {}

  get status(): AwakeStatus {
    return { mode: this.mode, lid: this.lidActive, notes: [] };
  }

  /** Switch modes. Returns what is in effect and anything the user should know. */
  async set(mode: AwakeMode): Promise<AwakeStatus> {
    const notes: string[] = [];
    if (mode === this.mode) return { mode, lid: this.lidActive, notes };
    await this.release(notes);
    if (mode === "off") return { mode: "off", lid: false, notes };

    // 1. The sleep hold, tied to codemax's lifetime.
    let hold = this.holdCommand(mode === "lid");
    if (hold && this.d.platform === "linux") hold = await this.linuxHold(mode === "lid", notes);
    if (hold) this.holder = this.d.spawn(hold);
    else notes.push(this.d.platform === "linux" ? "systemd-inhibit was not found, so codemax cannot keep this machine awake. Install systemd or use your desktop's 'caffeine' setting." : `keeping awake is not supported on ${this.d.platform}`);

    // 2. Lid-close, where it needs a setting changed.
    if (mode === "lid") {
      if (this.d.platform === "darwin") this.lidActive = await this.macLidOn(notes);
      else if (this.d.platform === "win32") this.lidActive = await this.winLidOn(notes);
      else this.lidActive = !!hold && hold.some((a) => a.includes("handle-lid-switch")); // Linux: lid-switch inhibitor
    }
    if (this.d.platform === "linux" && hold && !hold.some((a) => a.includes("shutdown"))) notes.push("This session is not allowed to block shutdown; only sleep is prevented.");
    if (this.d.platform !== "linux") notes.push(`${this.d.platform === "darwin" ? "macOS" : "Windows"} does not let apps block a shutdown; only sleep is prevented.`);
    if (this.lidActive) notes.push("With the lid closed, keep the laptop somewhere it can breathe: not in a bag.");
    this.mode = hold || this.lidActive ? mode : "off";
    return { mode: this.mode, lid: this.lidActive, notes };
  }

  /** Undo everything: stop the holder and put changed settings back. */
  async release(notes: string[] = []): Promise<string[]> {
    this.holder?.kill();
    this.holder = null;
    if (this.macFlag) {
      // The watchdog sees the flag gone and turns sleep back on as root.
      rmSync(this.macFlag, { force: true });
      this.macFlag = null;
      const back = await this.waitSleepDisabled(false, 8000);
      this.macWatch = null;
      if (back) rmSync(this.d.recordPath, { force: true });
    }
    if (this.lidActive) await restoreFromRecord(this.d, notes, { interactive: true });
    this.lidActive = false;
    this.mode = "off";
    return notes;
  }

  /** Best effort, synchronous: for process exit, where nothing can be awaited. */
  releaseSync() {
    this.holder?.kill();
    // macOS: removing the flag is enough; the root watchdog restores sleep on its own.
    if (this.macFlag) {
      rmSync(this.macFlag, { force: true });
      return;
    }
    if (!this.lidActive) return;
    const rec = readRecord(this.d.recordPath);
    if (!rec) return;
    const cmds = restoreCommands(rec, { nonInteractive: true });
    let ok = true;
    for (const c of cmds) ok = Bun.spawnSync(c, { stdout: "ignore", stderr: "ignore" }).exitCode === 0 && ok;
    if (ok) rmSync(this.d.recordPath, { force: true });
  }

  /**
   * Linux: the system's policy decides which locks a session may take (a remote or
   * headless session often may not block shutdown or the lid switch). Probe with an
   * instant command, keep the widest set that is allowed, and say what was refused.
   */
  private async linuxHold(lid: boolean, notes: string[]): Promise<string[] | null> {
    const sets = lid ? [["idle", "sleep", "shutdown", "handle-lid-switch"], ["idle", "sleep", "handle-lid-switch"], ["idle", "sleep"]] : [["idle", "sleep", "shutdown"], ["idle", "sleep"]];
    let lastErr = "";
    for (const set of sets) {
      const r = await this.d.run(["systemd-inhibit", `--what=${set.join(":")}`, "--who=codemax", `--why=${WHY}`, "--mode=block", "true"]);
      if (r.code === 0) {
        if (lid && !set.includes("handle-lid-switch")) notes.push("This session is not allowed to hold the lid switch, so closing the lid may still suspend.");
        return this.linuxCommand(set);
      }
      lastErr = r.err || r.out;
    }
    notes.push(`The system refused to let codemax keep it awake${lastErr ? ` (${lastErr.split("\n")[0]!.slice(0, 160)})` : ""}. This usually means a remote or non-desktop session.`);
    return null;
  }

  private linuxCommand(what: string[]): string[] {
    return ["systemd-inhibit", `--what=${what.join(":")}`, "--who=codemax", `--why=${WHY}`, "--mode=block", "sh", "-c", `while kill -0 ${this.d.pid} 2>/dev/null; do sleep 5; done`];
  }

  holdCommand(lid: boolean): string[] | null {
    const pid = String(this.d.pid);
    switch (this.d.platform) {
      case "darwin":
        // -d display sleep (so no screen saver or lock: it looked asleep without it), -i idle
        // sleep, -m disk sleep, -s system sleep (on AC).
        return this.d.which("caffeinate") ? ["caffeinate", "-dims", "-w", pid] : null;
      case "linux": {
        if (!this.d.which("systemd-inhibit")) return null;
        return this.linuxCommand(["idle", "sleep", "shutdown", ...(lid ? ["handle-lid-switch"] : [])]);
      }
      case "win32":
        return [
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$k = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name K -Namespace CodemaxAwake -PassThru; ` +
            `[void]$k::SetThreadExecutionState(${ES_CONTINUOUS_SYSTEM_REQUIRED}); ` +
            `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }`,
        ];
      default:
        return null;
    }
  }

  private async macLidOn(notes: string[]): Promise<boolean> {
    const cur = await this.d.run(["pmset", "-g"]);
    const disabled = /SleepDisabled\s+1/.test(cur.out);
    if (disabled && !readRecord(this.d.recordPath)) {
      notes.push("Sleep is already disabled on this Mac (pmset disablesleep 1), so the lid can close; codemax will leave that setting as it found it.");
      return true;
    }
    writeRecord(this.d.recordPath, { platform: "darwin", pid: this.d.pid, at: Date.now(), mac: { disablesleep: 0 } });
    let auth = await this.d.run(["sudo", "-n", "-v"]);
    if (auth.code !== 0 && this.d.interactive) {
      notes.push("macOS needs your admin password to keep running with the lid closed.");
      auth = await this.d.interactive(() => this.d.run(["sudo", "-v"], { interactive: true }));
    }
    if (auth.code !== 0) {
      rmSync(this.d.recordPath, { force: true });
      notes.push("Lid-close needs admin rights on macOS and was not enabled; the Mac still will not idle-sleep. Run `codemax awake lid` in a terminal to enter your password.");
      return false;
    }
    // A root watchdog sets disablesleep and restores it the moment codemax is gone (or the flag
    // is removed). It ignores INT/HUP/TERM so closing the terminal cannot kill it before it restores.
    const flag = join(dirname(this.d.recordPath), `awake-${this.d.pid}.flag`);
    writeFileSync(flag, "");
    this.macFlag = flag;
    this.macWatch = this.d.spawn(["sudo", "-n", "sh", "-c", macWatchdog(this.d.pid, flag, 0)]);
    if (await this.waitSleepDisabled(true, 5000)) return true;
    rmSync(flag, { force: true });
    this.macFlag = null;
    this.macWatch.kill();
    this.macWatch = null;
    await restoreFromRecord(this.d, notes, {});
    notes.push("Could not switch off sleep (pmset), so lid-close was not enabled.");
    return false;
  }

  /** Poll `pmset -g` until SleepDisabled matches. */
  private async waitSleepDisabled(want: boolean, ms: number): Promise<boolean> {
    for (let t = 0; t <= ms; t += 250) {
      const cur = await this.d.run(["pmset", "-g"]);
      if (/SleepDisabled\s+1/.test(cur.out) === want) return true;
      await Bun.sleep(250);
    }
    return false;
  }

  private async winLidOn(notes: string[]): Promise<boolean> {
    const q = await this.d.run(["powercfg", "/q", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION"]);
    const ac = parsePowercfg(q.out, "AC"), dc = parsePowercfg(q.out, "DC");
    if (ac === undefined || dc === undefined) {
      notes.push("This PC reports no lid setting (a desktop or server has none), so only sleep is prevented.");
      return false;
    }
    writeRecord(this.d.recordPath, { platform: "win32", pid: this.d.pid, at: Date.now(), win: { ac, dc } });
    const cmds = [
      ["powercfg", "/setacvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", "0"],
      ["powercfg", "/setdcvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", "0"],
      ["powercfg", "/setactive", "SCHEME_CURRENT"],
    ];
    for (const c of cmds) {
      if ((await this.d.run(c)).code !== 0) {
        await restoreFromRecord(this.d, notes, {});
        notes.push("Could not change the lid setting (powercfg), so lid-close was not enabled.");
        return false;
      }
    }
    return true;
  }
}

/** The root watchdog script: hold disablesleep while codemax lives and the flag exists, then restore. */
export function macWatchdog(pid: number, flag: string, restoreTo: number): string {
  const f = flag.replace(/'/g, `'\\''`);
  return `trap '' INT HUP TERM; pmset -a disablesleep 1; while kill -0 ${pid} 2>/dev/null && [ -e '${f}' ]; do sleep 2; done; pmset -a disablesleep ${restoreTo}`;
}

/** At startup: if a previous codemax died with a lid setting changed, put it back. */
export async function recoverAwake(d: AwakeDeps = defaultAwakeDeps()): Promise<string[]> {
  const rec = readRecord(d.recordPath);
  if (!rec || rec.platform !== d.platform) return [];
  if (rec.pid !== d.pid && pidAlive(rec.pid)) return []; // another codemax still holds it
  const notes: string[] = [];
  await restoreFromRecord(d, notes, { interactive: !!d.interactive });
  if (!readRecord(d.recordPath)) notes.unshift("Restored the lid/sleep setting a previous codemax session changed.");
  return notes;
}

async function restoreFromRecord(d: AwakeDeps, notes: string[], o: { interactive?: boolean }) {
  const rec = readRecord(d.recordPath);
  if (!rec) return;
  let ok = true;
  for (const c of restoreCommands(rec, { nonInteractive: true })) ok = (await d.run(c)).code === 0 && ok;
  if (!ok && rec.mac && o.interactive && d.interactive) {
    const r = await d.interactive(() => d.run(["sudo", "pmset", "-a", "disablesleep", String(rec.mac!.disablesleep)], { interactive: true }));
    ok = r.code === 0;
  }
  if (ok) rmSync(d.recordPath, { force: true });
  else notes.push(rec.mac ? "Could not turn sleep back on. Run: sudo pmset -a disablesleep 0" : "Could not restore the lid setting. Run `codemax awake off` to retry.");
}

function restoreCommands(rec: RestoreRecord, o: { nonInteractive: boolean }): string[][] {
  if (rec.mac) return [["sudo", ...(o.nonInteractive ? ["-n"] : []), "pmset", "-a", "disablesleep", String(rec.mac.disablesleep)]];
  if (rec.win)
    return [
      ["powercfg", "/setacvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", String(rec.win.ac)],
      ["powercfg", "/setdcvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", String(rec.win.dc)],
      ["powercfg", "/setactive", "SCHEME_CURRENT"],
    ];
  return [];
}

/** "Current AC Power Setting Index: 0x00000001" → 1 */
export function parsePowercfg(out: string, which: "AC" | "DC"): number | undefined {
  const m = out.match(new RegExp(`Current ${which} Power Setting Index:\\s*0x([0-9a-f]+)`, "i"));
  return m ? parseInt(m[1]!, 16) : undefined;
}

function readRecord(path: string): RestoreRecord | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RestoreRecord) : null;
  } catch {
    return null;
  }
}

function writeRecord(path: string, rec: RestoreRecord) {
  ensureDir(join(path, ".."));
  writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

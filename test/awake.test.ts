import { test, expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Awake, macWatchdog, parsePowercfg, recoverAwake, type AwakeDeps } from "../src/core/awake.ts";

/** A fake system: records every command; answers from a script. Nothing real runs. */
function fakeSystem(platform: NodeJS.Platform, answer: (cmd: string) => { code?: number; out?: string } = () => ({})) {
  const ran: string[] = [];
  const spawned: { cmd: string; killed: boolean }[] = [];
  const interactive: string[] = [];
  const deps: AwakeDeps = {
    platform,
    pid: 4242,
    recordPath: join(mkdtempSync(join(tmpdir(), "codemax-awake-")), "awake-restore.json"),
    which: (b) => (b === "systemd-inhibit" && platform !== "linux" ? null : `/usr/bin/${b}`),
    run: async (cmd, o) => {
      const line = cmd.join(" ");
      ran.push(line);
      if (o?.interactive) interactive.push(line);
      const a = answer(line);
      return { code: a.code ?? 0, out: a.out ?? "", err: "" };
    },
    spawn: (cmd) => {
      const s = { cmd: cmd.join(" "), killed: false };
      spawned.push(s);
      return { kill: () => void (s.killed = true) };
    },
    interactive: (fn) => fn(),
  };
  return { deps, ran, spawned, interactive };
}

test("macOS: on holds caffeinate tied to codemax's pid; off stops it", async () => {
  const sys = fakeSystem("darwin");
  const a = new Awake(sys.deps);
  const st = await a.set("on");
  expect(st.mode).toBe("on");
  expect(sys.spawned[0]!.cmd).toBe("caffeinate -ims -w 4242");
  expect(sys.ran).toEqual([]); // no setting touched
  expect(st.notes.join(" ")).toContain("block a shutdown");
  await a.set("off");
  expect(sys.spawned[0]!.killed).toBe(true);
});

/** macOS fake: pmset reports sleep disabled while a watchdog is alive and its flag file exists. */
function macSystem(o: { userDisabled?: boolean; sudo?: "cached" | "prompt" | "refused" } = {}) {
  const sys = fakeSystem("darwin");
  const watches: { cmd: string; killed: boolean; flag: string }[] = [];
  const holding = () => o.userDisabled || watches.some((w) => !w.killed && existsSync(w.flag));
  sys.deps.run = async (cmd, opts) => {
    const line = cmd.join(" ");
    sys.ran.push(line);
    if (opts?.interactive) sys.interactive.push(line);
    if (line === "pmset -g") return { code: 0, out: `SleepDisabled\t\t${holding() ? 1 : 0}`, err: "" };
    if (line === "sudo -n -v") return { code: o.sudo === "prompt" || o.sudo === "refused" ? 1 : 0, out: "", err: "" };
    if (line === "sudo -v") return { code: o.sudo === "refused" ? 1 : 0, out: "", err: "" };
    return { code: 0, out: "", err: "" };
  };
  const baseSpawn = sys.deps.spawn;
  sys.deps.spawn = (cmd) => {
    const h = baseSpawn(cmd);
    const flag = cmd.join(" ").match(/-e '([^']+)'/)?.[1];
    if (flag) {
      const w = { cmd: cmd.join(" "), killed: false, flag };
      watches.push(w);
      return { kill: () => { w.killed = true; h.kill(); } };
    }
    return h;
  };
  return { ...sys, watches, holding };
}

test("macOS: lid starts a root watchdog that disables sleep, and turning it off restores sleep", async () => {
  const sys = macSystem();
  const a = new Awake(sys.deps);
  const st = await a.set("lid");
  expect(st).toMatchObject({ mode: "lid", lid: true });
  expect(sys.ran).toContain("sudo -n -v");
  const w = sys.watches[0]!;
  expect(w.cmd).toStartWith("sudo -n sh -c trap '' INT HUP TERM; pmset -a disablesleep 1; while kill -0 4242");
  expect(w.cmd).toEndWith("pmset -a disablesleep 0");
  expect(sys.holding()).toBe(true);
  expect(existsSync(sys.deps.recordPath)).toBe(true);
  await a.release();
  expect(sys.holding()).toBe(false); // the flag is gone, so the watchdog restores sleep
  expect(existsSync(sys.deps.recordPath)).toBe(false);
});

test("macOS: if codemax dies, removing the flag on exit is all it takes; no sudo needed at exit", async () => {
  const sys = macSystem();
  const a = new Awake(sys.deps);
  await a.set("lid");
  const before = sys.ran.length;
  a.releaseSync();
  expect(sys.holding()).toBe(false);
  expect(sys.ran.length).toBe(before); // nothing run: the root watchdog restores on its own
});

test("macOS: without cached sudo it asks for the password; refusing leaves nothing changed", async () => {
  const granted = macSystem({ sudo: "prompt" });
  expect((await new Awake(granted.deps).set("lid")).lid).toBe(true);
  expect(granted.interactive).toEqual(["sudo -v"]);

  const refused = macSystem({ sudo: "refused" });
  const st = await new Awake(refused.deps).set("lid");
  expect(st.lid).toBe(false);
  expect(st.mode).toBe("lid"); // still keeps idle sleep away through caffeinate
  expect(st.notes.join(" ")).toContain("was not enabled");
  expect(refused.watches).toHaveLength(0);
  expect(existsSync(refused.deps.recordPath)).toBe(false);
});

test("macOS: a sleep setting the user already disabled is left exactly as found", async () => {
  const sys = macSystem({ userDisabled: true });
  const a = new Awake(sys.deps);
  expect((await a.set("lid")).lid).toBe(true);
  await a.release();
  expect(sys.watches).toHaveLength(0);
  expect(sys.ran.filter((c) => c.includes("sudo"))).toEqual([]);
});

test("the watchdog script ignores terminal signals and quotes its flag path", () => {
  const sh = macWatchdog(7, "/tmp/it's here/a.flag", 0);
  expect(sh).toStartWith("trap '' INT HUP TERM;");
  expect(sh).toContain(`[ -e '/tmp/it'\\''s here/a.flag' ]`);
});

test("Linux: one systemd-inhibit blocks idle, sleep and shutdown, plus the lid switch in lid mode", async () => {
  const sys = fakeSystem("linux");
  const a = new Awake(sys.deps);
  await a.set("on");
  expect(sys.spawned[0]!.cmd).toContain("--what=idle:sleep:shutdown --who=codemax");
  expect(sys.spawned[0]!.cmd).toContain("while kill -0 4242");
  const st = await a.set("lid");
  expect(sys.spawned[0]!.killed).toBe(true);
  expect(sys.spawned[1]!.cmd).toContain("--what=idle:sleep:shutdown:handle-lid-switch");
  expect(st.lid).toBe(true);
  expect(st.notes.join(" ")).not.toContain("shutdown");
});

test("Linux: when the session may not block shutdown or the lid, codemax takes what is allowed and says what was refused", async () => {
  const sys = fakeSystem("linux", (c) => (c.endsWith(" true") && (c.includes("shutdown") || c.includes("handle-lid-switch")) ? { code: 1, out: "Access denied" } : {}));
  const st = await new Awake(sys.deps).set("lid");
  expect(sys.spawned[0]!.cmd).toContain("--what=idle:sleep --who=codemax");
  expect(st).toMatchObject({ mode: "lid", lid: false });
  expect(st.notes.join(" ")).toContain("not allowed to hold the lid switch");
  expect(st.notes.join(" ")).toContain("not allowed to block shutdown");
});

test("Linux: when the system refuses every lock, codemax does not claim to keep it awake", async () => {
  const sys = fakeSystem("linux", (c) => (c.endsWith(" true") ? { code: 1, out: "Access denied" } : {}));
  const st = await new Awake(sys.deps).set("on");
  expect(st.mode).toBe("off");
  expect(sys.spawned).toHaveLength(0);
  expect(st.notes[0]).toContain("refused to let codemax keep it awake (Access denied)");
});

test("Linux without systemd-inhibit says so and stays off", async () => {
  const sys = fakeSystem("linux");
  sys.deps.which = () => null;
  const st = await new Awake(sys.deps).set("on");
  expect(st.mode).toBe("off");
  expect(st.notes[0]).toContain("systemd-inhibit was not found");
});

test("Windows: SetThreadExecutionState helper; lid action set to do-nothing and restored to the original values", async () => {
  const q = "Current AC Power Setting Index: 0x00000001\r\nCurrent DC Power Setting Index: 0x00000002";
  const sys = fakeSystem("win32", (c) => (c.startsWith("powercfg /q") ? { out: q } : {}));
  const a = new Awake(sys.deps);
  const st = await a.set("lid");
  expect(sys.spawned[0]!.cmd).toContain("SetThreadExecutionState(0x80000001)");
  expect(sys.spawned[0]!.cmd).toContain("Get-Process -Id 4242");
  expect(sys.ran).toContain("powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0");
  expect(sys.ran).toContain("powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0");
  expect(st.lid).toBe(true);
  await a.release();
  expect(sys.ran).toContain("powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1");
  expect(sys.ran).toContain("powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 2");
  expect(existsSync(sys.deps.recordPath)).toBe(false);
});

test("after a crash, the next start restores a changed setting; a live session's setting is left alone", async () => {
  const q = "Current AC Power Setting Index: 0x00000001\nCurrent DC Power Setting Index: 0x00000001";
  const first = fakeSystem("win32", (c) => (c.startsWith("powercfg /q") ? { out: q } : {}));
  first.deps.pid = 999_999; // a pid that is not running: the previous session "crashed"
  await new Awake(first.deps).set("lid");
  expect(existsSync(first.deps.recordPath)).toBe(true);

  const next = fakeSystem("win32");
  next.deps.recordPath = first.deps.recordPath;
  const notes = await recoverAwake(next.deps);
  expect(next.ran).toContain("powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1");
  expect(notes[0]).toContain("Restored");
  expect(existsSync(first.deps.recordPath)).toBe(false);

  const live = fakeSystem("win32", (c) => (c.startsWith("powercfg /q") ? { out: q } : {}));
  live.deps.pid = process.pid; // this process is alive: its record must not be touched by another start
  await new Awake(live.deps).set("lid");
  const other = fakeSystem("win32");
  other.deps.recordPath = live.deps.recordPath;
  other.deps.pid = 1;
  expect(await recoverAwake(other.deps)).toEqual([]);
  expect(existsSync(live.deps.recordPath)).toBe(true);
});

test("powercfg output parsing", () => {
  expect(parsePowercfg("Current AC Power Setting Index: 0x00000003", "AC")).toBe(3);
  expect(parsePowercfg("nothing", "DC")).toBeUndefined();
});

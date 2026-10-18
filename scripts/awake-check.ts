/**
 * Real-machine check for keep-awake (CI only: it changes power settings).
 * Uses a stand-in process as "codemax", turns lid mode on, verifies the system
 * really changed, kills the stand-in with SIGKILL, and verifies everything was
 * put back without codemax's help.
 *
 *   bun scripts/awake-check.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Awake, defaultAwakeDeps, recoverAwake } from "../src/core/awake.ts";

const sh = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return (r.stdout.toString() + r.stderr.toString()).trim();
};
const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  if (process.platform === "win32") {
    // Diagnose: run the same helper briefly with its output visible, and list power requests.
    const hold = new Awake({ ...deps, pid: process.pid }).holdCommand(false)!;
    const probe = Bun.spawnSync([...hold.slice(0, -1), hold.at(-1)!.replace(/while \(Get-Process[^}]+\}/, "Start-Sleep -Seconds 4; 'helper ran'")], { stdout: "pipe", stderr: "pipe" });
    console.error("helper exit", probe.exitCode, "out:", probe.stdout.toString().trim(), "err:", probe.stderr.toString().trim().slice(0, 800));
    console.error("powercfg /requests:\n" + sh(["powercfg", "/requests"]));
  }
  process.exit(1);
};
const until = async (what: string, pred: () => boolean, ms = 12000) => {
  for (let t = 0; t < ms; t += 500) {
    if (pred()) return console.log(`ok: ${what}`);
    await Bun.sleep(500);
  }
  fail(what);
};

// The stand-in for codemax: everything codemax starts watches this pid.
const standIn = Bun.spawn(process.platform === "win32" ? ["powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 600"] : ["sleep", "600"]);
const deps = { ...defaultAwakeDeps(), pid: standIn.pid, recordPath: join(mkdtempSync(join(tmpdir(), "awake-check-")), "awake-restore.json") };
const awake = new Awake(deps);
console.log(`platform ${process.platform}, stand-in pid ${standIn.pid}`);

const lidValues = () => {
  const out = sh(["powercfg", "/q", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION"]);
  return [out.match(/Current AC Power Setting Index:\s*0x([0-9a-f]+)/i)?.[1], out.match(/Current DC Power Setting Index:\s*0x([0-9a-f]+)/i)?.[1]].map((v) => (v ? parseInt(v, 16) : -1));
};
const before = process.platform === "win32" ? lidValues() : [];
if (process.platform === "win32") {
  // Make the "before" value distinguishable from the "lid" value (0).
  sh(["powercfg", "/setacvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", "1"]);
  sh(["powercfg", "/setdcvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", "1"]);
  sh(["powercfg", "/setactive", "SCHEME_CURRENT"]);
}

const st = await awake.set("lid");
console.log("set lid ->", JSON.stringify(st));
// A Windows server/desktop has no lid setting: then only the no-sleep hold can be checked.
const noLid = process.platform === "win32" && st.notes.some((n) => n.includes("no lid setting"));
if (st.mode !== "lid" || (!st.lid && !noLid)) fail("lid mode did not turn on");

if (process.platform === "darwin") {
  await until("pmset reports sleep disabled", () => /SleepDisabled\s+1/.test(sh(["pmset", "-g"])));
  await until("caffeinate holds an assertion", () => /caffeinate/.test(sh(["pmset", "-g", "assertions"])));
  standIn.kill("SIGKILL");
  await until("sleep re-enabled after codemax was killed", () => /SleepDisabled\s+0/.test(sh(["pmset", "-g"])));
  await until("caffeinate assertion released", () => !/caffeinate/.test(sh(["pmset", "-g", "assertions"])));
} else if (process.platform === "linux") {
  await until("systemd-inhibit holds idle/sleep/shutdown/lid", () => /codemax[\s\S]*handle-lid-switch/.test(sh(["systemd-inhibit", "--list"])));
  standIn.kill("SIGKILL");
  await until("inhibitor released after codemax was killed", () => !/codemax/.test(sh(["systemd-inhibit", "--list"])));
} else if (process.platform === "win32" && noLid) {
  await until("a system-required power request is held", () => /SYSTEM:[\s\S]*powershell/i.test(sh(["powercfg", "/requests"])));
  standIn.kill("SIGKILL");
  await until("power request released after codemax was killed", () => !/SYSTEM:[\s\S]*powershell/i.test(sh(["powercfg", "/requests"])), 15000);
  console.log("note: this machine has no lid, so the lid action could not be checked here");
} else if (process.platform === "win32") {
  await until("lid action set to do nothing (AC and DC)", () => lidValues().every((v) => v === 0));
  await until("a system-required power request is held", () => /SYSTEM:[\s\S]*powershell/i.test(sh(["powercfg", "/requests"])));
  standIn.kill("SIGKILL");
  await until("power request released after codemax was killed", () => !/SYSTEM:[\s\S]*powershell/i.test(sh(["powercfg", "/requests"])), 15000);
  // The lid setting outlives the process; the next codemax start restores it.
  const notes = await recoverAwake({ ...defaultAwakeDeps(), recordPath: deps.recordPath });
  console.log("recover:", notes.join(" | "));
  await until("lid action restored to its original value", () => lidValues().every((v) => v === 1));
  sh(["powercfg", "/setacvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", String(before[0])]);
  sh(["powercfg", "/setdcvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", String(before[1])]);
  sh(["powercfg", "/setactive", "SCHEME_CURRENT"]);
}
console.log("PASS");
process.exit(0);

import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdLine, platformCmd } from "../src/core/spawn.ts";
import { defaultDeps, detectBin } from "../src/adapters/detect.ts";

const win = process.platform === "win32";

// Issue #2: on Windows a user folder with a space (C:\Users\neeraj kumar) broke every npm/pnpm
// `.cmd` shim: "'C:\Users\neeraj' is not recognized as an internal or external command".
test("a .cmd shim's command line keeps a path with spaces whole and escapes the arguments", () => {
  const codex = "C:\\Users\\neeraj kumar\\AppData\\Roaming\\npm\\codex.cmd";
  expect(cmdLine(codex, ["app-server"])).toBe(`"${codex}" ^"app-server^"`);
  expect(cmdLine(codex, ["--version"])).toBe(`"${codex}" ^"--version^"`);
  expect(cmdLine(codex, ["a b", "x&y", 'say "hi"', "dir\\"])).toBe(`"${codex}" ^"a^ b^" ^"x^&y^" ^"say^ \\^"hi\\^"^" ^"dir\\\\^"`);
  const bin = "C:\\Program Files (x86)\\app\\node_modules\\.bin\\tool.cmd";
  expect(cmdLine(bin, ["x&y"])).toBe(`"${bin}" ^^^"x^^^&y^^^"`);
});

test.skipIf(win)("outside Windows argv is passed unchanged", () => {
  expect(platformCmd(["codex", "app-server"])).toEqual({ cmd: ["codex", "app-server"] });
});

/** A folder like the reporter's: a space (and parentheses) in the path, with an npm-style shim in it. */
function shimDir() {
  const dir = join(mkdtempSync(join(tmpdir(), "codemax-spawn-")), "neeraj kumar (home)", "npm");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "args.js"), "console.log(JSON.stringify(process.argv.slice(2)))\n");
  writeFileSync(join(dir, "fake.cmd"), `@ECHO off\r\n"${process.execPath}" "%~dp0\\args.js" %*\r\n`);
  writeFileSync(join(dir, "codex.cmd"), `@ECHO off\r\necho codex-cli 9.9.9\r\n`);
  return dir;
}

test.skipIf(!win)("Windows: a .cmd shim in a folder with a space runs and gets its arguments", async () => {
  const dir = shimDir();
  const args = ["app-server", "a b", "x&y", "C:\\Users\\neeraj kumar\\file.txt"];
  const p = Bun.spawn({ ...platformCmd([join(dir, "fake.cmd"), ...args]), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(err).not.toContain("is not recognized");
  expect(await p.exited).toBe(0);
  expect(JSON.parse(out.trim())).toEqual(args);
});

test.skipIf(!win)("Windows: detection finds a CLI whose shim sits in a folder with a space", async () => {
  const dir = shimDir();
  const r = await detectBin("codex", ["--version"], { ...defaultDeps, which: () => join(dir, "codex.cmd") }, 10000);
  expect(r.problem).toBeUndefined();
  expect(r).toMatchObject({ installed: true, version: "9.9.9" });
});

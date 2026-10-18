import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBin, type DetectDeps } from "../src/adapters/detect.ts";

const deps = (r: Awaited<ReturnType<DetectDeps["run"]>> | Error, found = "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"): DetectDeps => ({
  which: () => found,
  run: async () => {
    if (r instanceof Error) throw r;
    return r;
  },
});

test("an agent counts as installed only when its --version runs", async () => {
  expect(await detectBin("codex", ["--version"], deps({ code: 0, out: "codex-cli 0.163.0" }))).toMatchObject({ installed: true, version: "0.163.0" });
  expect(await detectBin("codex", ["--version"], { which: () => null, run: async () => ({ code: 0, out: "" }) })).toEqual({ installed: false });
});

test("a leftover Windows shim that no longer runs is not installed, and says why", async () => {
  const gone = await detectBin("codex", ["--version"], deps({ code: 1, out: "Error: Cannot find module 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'" }));
  expect(gone.installed).toBe(false);
  expect(gone.problem).toContain("does not run: Error: Cannot find module");
  expect((await detectBin("codex", ["--version"], deps(new Error("ENOENT")))).installed).toBe(false);
  const hung = await detectBin("codex", ["--version"], deps({ code: null, out: "", timedOut: true }));
  expect(hung).toMatchObject({ installed: false });
  expect(hung.problem).toContain("did not answer --version");
});

test.skipIf(process.platform === "win32")("real processes: a broken CLI on PATH is detected as broken", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codemax-detect-"));
  const bin = join(dir, "codex");
  writeFileSync(bin, "#!/bin/sh\necho 'node: cannot find module' >&2\nexit 1\n");
  chmodSync(bin, 0o755);
  const which = (b: string) => Bun.which(b, { PATH: dir });
  const run: DetectDeps["run"] = async (argv) => {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    return { code: await p.exited, out };
  };
  const r = await detectBin("codex", ["--version"], { which, run }, 5000);
  expect(r.installed).toBe(false);
  expect(r.problem).toContain("cannot find module");
  writeFileSync(bin, "#!/bin/sh\necho 'codex-cli 9.9.9'\n");
  const ok = await detectBin("codex", ["--version"], { which, run });
  expect(ok).toMatchObject({ installed: true, version: "9.9.9" });
});

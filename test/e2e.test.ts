import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../src/core/terminal.ts";

/** Drive codemax's legacy --raw passthrough inside a PTY with the fake (sh) agent. */
// --raw runs the agent in a PTY, which is Unix-only.
test.skipIf(process.platform === "win32")("passthrough → hotkey menu → close → switch (brief typed) → quit", async () => {
  const home = mkdtempSync(join(tmpdir(), "codemax-home-"));
  const repo = mkdtempSync(join(tmpdir(), "codemax-repo-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });

  let out = "";
  const term = new Bun.Terminal({ cols: 100, rows: 30, data: (_t, c) => (out += new TextDecoder().decode(c)) });
  // This Bun, not whatever `bun` is first on PATH (an older one there has no Bun.Terminal).
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "start", "--raw", "--agent", "fake"], {
    cwd: repo,
    terminal: term,
    env: { ...process.env, CODEMAX_FAKE_AGENT: "1", CODEMAX_HOME: home, PS1: "FAKE$ ", ENV: "/dev/null", TERM: "xterm" },
  });

  const waitFor = async (re: RegExp, ms = 8000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (re.test(stripAnsi(out))) return;
      await Bun.sleep(50);
    }
    throw new Error(`timeout waiting for ${re}\n--- output ---\n${stripAnsi(out).slice(-1500)}`);
  };

  await waitFor(/FAKE\$/);
  term.write("echo pass-through-works\r");
  await waitFor(/pass-through-works\s*[\r\n]/);

  // hotkey opens the menu
  out = "";
  term.write("\x1b[47;5u"); // CSI-u encoding of Ctrl+/
  await waitFor(/codemax.*switch agent/s);
  expect(stripAnsi(out)).toMatch(/Fake \(sh\)/);

  // Esc returns to the shell, which still works
  out = "";
  term.write("\x1b");
  await Bun.sleep(200);
  term.write("echo still-alive\r");
  await waitFor(/still-alive\s*[\r\n]/);

  // switch to the fake agent again as a fresh session: brief gets typed into the new shell
  out = "";
  term.write("\x1b[47;5u"); // CSI-u encoding of Ctrl+/
  await waitFor(/codemax/);
  term.write("f"); // fresh
  await Bun.sleep(150);
  const idx = (stripAnsi(out).match(/(\d)\. Fake/) ?? [])[1] ?? "1";
  term.write(idx);
  await waitFor(/handing off to Fake/);
  await waitFor(/\[codemax handoff\]/, 20000);

  // quit from the menu
  out = "";
  term.write("\x1b[47;5u"); // CSI-u encoding of Ctrl+/
  await waitFor(/codemax/);
  term.write("x");
  await waitFor(/codemax: to continue this thread, run: codemax --resume [0-9a-f]{8}/);
  const code = await proc.exited;
  term.close();
  expect(code).toBe(0);

  const projects = join(home, "projects");
  expect(existsSync(projects)).toBe(true);
  const dir = join(projects, Bun.spawnSync(["ls", projects]).stdout.toString().trim());
  const events = readFileSync(join(dir, "events.jsonl"), "utf8");
  expect(events).toMatch(/"kind":"start"/);
  expect(events).toMatch(/"kind":"switch"/);
  expect(events).toMatch(/"kind":"exit"/);
}, 60000);

import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";

process.env.CODEMAX_FAKE_AGENT = "1";
process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-tui-home-"));
const { AgentPane } = await import("../src/tui/pane.ts");
const { App } = await import("../src/tui/app.ts");
const { Ledger } = await import("../src/core/ledger.ts");
const { DEFAULT_CONFIG } = await import("../src/config.ts");

/** Wall-clock wait: the app does async work (spawns, detection) that schedules no frames while pending. */
async function waitText(setup: Awaited<ReturnType<typeof createTestRenderer>>, pred: (f: string) => boolean, ms = 10000): Promise<string> {
  const t0 = Date.now();
  let frame = "";
  while (Date.now() - t0 < ms) {
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
    await Bun.sleep(50);
  }
  throw new Error(`timeout; last frame:\n${frame}`);
}

// The embedded-terminal fallback (--tui, --raw) is Unix-only.
const onWindows = process.platform === "win32";

test.skipIf(onWindows)("agent pane paints child output, including alt-screen apps", async () => {
  const setup = await createTestRenderer({ width: 60, height: 10 });
  try {
    const pane = new AgentPane(setup.renderer, {
      id: "p", cmd: ["sh", "-c", "printf '\\033[?1049h\\033[Hhello-from-child'; sleep 5"], cwd: tmpdir(), cols: 60, rows: 9,
      onOutput: () => {}, onExit: () => {},
    });
    setup.renderer.root.add(pane.terminal);
    const frame = await waitText(setup, (f) => f.includes("hello-from-child"));
    expect(frame).toContain("hello-from-child");
    await pane.destroy();
  } finally {
    setup.renderer.destroy();
  }
}, 20000);

test.skipIf(onWindows)("app: status bar, hotkey opens menu, Esc closes, x quits", async () => {
  const setup = await createTestRenderer({ width: 100, height: 20 });
  const repo = mkdtempSync(join(tmpdir(), "codemax-tui-repo-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  const config = { ...structuredClone(DEFAULT_CONFIG), order: ["fake" as const] };
  const app = new App(setup.renderer, config, new Ledger(repo), repo);
  const done = app.start("fake", true);
  try {
    let frame = await waitText(setup, (f) => /codemax.*Fake \(sh\)/.test(f));
    expect(frame).toMatch(/Ctrl\+\/ or Ctrl\+\^ menu/);

    setup.mockInput.pressKey("\x1e"); // Ctrl+^
    frame = await waitText(setup, (f) => f.includes("switch agent"));
    expect(frame).toMatch(/Fake \(sh\) \(current\)/);

    setup.mockInput.pressEscape();
    await waitText(setup, (f) => !f.includes("switch agent"));

    setup.mockInput.pressKey("\x1e");
    await waitText(setup, (f) => f.includes("switch agent"));
    setup.mockInput.pressKey("x");
    await done;
  } finally {
    setup.renderer.destroy();
  }
}, 30000);

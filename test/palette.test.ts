import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { Palette } from "../src/chat/palette.ts";

process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-palette-home-"));
const { ChatApp } = await import("../src/chat/app.ts");
const { Ledger } = await import("../src/core/ledger.ts");
const { DEFAULT_CONFIG } = await import("../src/config.ts");

async function waitText(setup: Awaited<ReturnType<typeof createTestRenderer>>, pred: (f: string) => boolean, ms = 5000): Promise<string> {
  const t0 = Date.now();
  let frame = "";
  while (Date.now() - t0 < ms) {
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
    await Bun.sleep(30);
  }
  throw new Error(`timeout; last frame:\n${frame}`);
}

test("palette filters by prefix and word start, never matches typos, Enter picks, Esc closes", async () => {
  const setup = await createTestRenderer({ width: 80, height: 16 });
  try {
    const picked: string[] = [];
    let closed = 0;
    const p = new Palette(setup.renderer, {
      items: [
        { label: "/switch", description: "Switch agent", value: "switch" },
        { label: "/status", description: "Details", value: "status" },
        { label: "/mode", description: "Permission mode", value: "mode" },
        { label: "/firecrawl-deep-research", description: "Research", value: "fdr" },
      ],
      onPick: (it) => picked.push(it.value),
      onClose: () => closed++,
    }, () => ({ top: 14, width: 80 }));
    setup.renderer.root.add(p.box);
    let frame = await waitText(setup, (f) => f.includes("/switch") && f.includes("/mode"));
    expect(frame).toMatch(/❯ \/firecrawl-deep-research|❯ \/mode|❯ \/status|❯ \/switch/);
    p.setFilter("st");
    frame = await waitText(setup, (f) => !f.includes("/mode"));
    expect(frame).toContain("/status");
    expect(frame).not.toContain("/switch");
    p.setFilter("deep");
    frame = await waitText(setup, (f) => f.includes("/firecrawl-deep-research") && !f.includes("/status"));
    p.setFilter("zzz");
    frame = await waitText(setup, (f) => f.includes("no matches"));
    expect(p.current).toBeUndefined();
    p.setFilter("sw");
    await waitText(setup, (f) => f.includes("❯ /switch"));
    expect(p.handleKey({ name: "return" } as any)).toBe(true);
    expect(picked).toEqual(["switch"]);
    // a background refresh must not move the highlight
    p.setFilter("");
    p.handleKey({ name: "down" } as any);
    const before = p.current?.value;
    p.setItems([{ label: "/switch", value: "switch" }, { label: "/status", value: "status" }, { label: "/mode", value: "mode" }, { label: "/firecrawl-deep-research", value: "fdr" }, { label: "/new", value: "new" }]);
    expect(p.current?.value).toBe(before);
    expect(p.handleKey({ name: "escape" } as any)).toBe(true);
    expect(closed).toBe(1);
    p.destroy();
  } finally {
    setup.renderer.destroy();
  }
});

test("typing / in the chat opens the palette; Esc keeps the typed text", async () => {
  const setup = await createTestRenderer({ width: 90, height: 20 });
  const repo = mkdtempSync(join(tmpdir(), "codemax-palette-repo-"));
  const app = new ChatApp(setup.renderer, structuredClone(DEFAULT_CONFIG), new Ledger(repo), repo);
  try {
    await setup.mockInput.typeText("/sw");
    let frame = await waitText(setup, (f) => f.includes("Switch to another agent"));
    expect(frame).toContain("❯ /switch");
    expect(frame).not.toContain("/quit"); // filtered out
    setup.mockInput.pressEscape();
    frame = await waitText(setup, (f) => !f.includes("Switch to another agent"));
    expect(frame).toContain("❯ /sw"); // text stays in the prompt
    await app.quit();
  } finally {
    setup.renderer.destroy();
  }
});

test("palette filtering narrows as you type and gives exactly what a fresh search gives", async () => {
  const { Palette } = await import("../src/chat/palette.ts");
  const { createTestRenderer } = await import("@opentui/core/testing");
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const items = Array.from({ length: 3000 }, (_, i) => ({ label: `src/mod${i % 40}/comp_${i}.tsx`, value: String(i), description: i % 7 ? undefined : "model helper" }));
  const live = new Palette(setup.renderer, { title: "t", items, onPick: () => {}, onClose: () => {} } as any, () => ({ top: 10, width: 80 }));
  for (const q of ["m", "mo", "mod", "mod1", "mod12", "mdl", "comp_1"]) {
    live.setFilter(q);
    const fresh = new Palette(setup.renderer, { title: "t", items, onPick: () => {}, onClose: () => {} } as any, () => ({ top: 10, width: 80 }));
    fresh.setFilter(q);
    expect((live as any).matches.map((m: any) => m.value)).toEqual((fresh as any).matches.map((m: any) => m.value));
    fresh.destroy();
  }
  live.destroy();
  setup.renderer.destroy();
});

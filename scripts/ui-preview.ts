/**
 * UI preview: plays a scripted session through the real chat UI with a fake
 * ACP agent, then writes colour snapshots as HTML (dark and light terminal).
 *
 *   bun scripts/ui-preview.ts [outDir]
 *
 * Nothing is spawned and no agent is contacted.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";
import type { CapturedFrame } from "@opentui/core";

process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-preview-home-"));
const { ChatApp } = await import("../src/chat/app.ts");
const { AcpEngine } = await import("../src/engines/acp.ts");
const { Ledger } = await import("../src/core/ledger.ts");
const { DEFAULT_CONFIG } = await import("../src/config.ts");
const { applyTheme } = await import("../src/chat/theme.ts");

const out = resolve(process.argv[2] ?? "ui-preview");
// Optional colour theme (codemax, claude, ocean, teal, mono): files are then named <theme>-<mode>-….
const colors = (process.argv[3] ?? "codemax") as "codemax";
const prefix = process.argv[3] ? `${colors}-` : "";
mkdirSync(out, { recursive: true });

function fakeAgent() {
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentInfo: { name: "claude", title: "Claude Code", version: "2.1" }, agentCapabilities: {}, authMethods: [] } as any; },
    async newSession() {
      return {
        sessionId: "preview",
        models: { currentModelId: "claude-sonnet-5-5", availableModels: [{ modelId: "claude-sonnet-5-5", name: "Sonnet 5.5" }] },
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "acceptEdits", name: "Accept edits" }, { id: "plan", name: "Plan" }] },
      } as any;
    },
    async loadSession() { return {} as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId }) {
      const u = (update: any) => conn.sessionUpdate({ sessionId, update });
      const pause = () => Bun.sleep(15);
      await u({ sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "The failing test is in auth; the expiry comparison is probably off by one. Read the check, then fix and rerun." } });
      await u({ sessionUpdate: "plan", entries: [{ content: "Find the failing assertion", status: "completed", priority: "high" }, { content: "Fix the token expiry check", status: "in_progress", priority: "high" }, { content: "Run the auth tests", status: "pending", priority: "medium" }] });
      await u({ sessionUpdate: "tool_call", toolCallId: "r1", title: "Read src/auth.ts", kind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "export function isExpired(exp: number, now = Date.now()) {\n  if (exp < now) return true\n  return false\n}" } }] });
      await pause();
      await u({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "The check treats a token that expires **this exact millisecond** as valid." } });
      await u({ sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit src/auth.ts", kind: "edit", status: "completed", content: [{ type: "content", content: { type: "text", text: "@@ -1,4 +1,4 @@\n-  if (exp < now) return true\n+  if (exp <= now) return true" } }] });
      await u({ sessionUpdate: "tool_call", toolCallId: "b1", title: "Bash(bun test test/auth.test.ts)", kind: "execute", status: "failed", content: [{ type: "content", content: { type: "text", text: "error: snapshot mismatch in refresh.test.ts" } }] });
      await u({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Fixed the off-by-one in `isExpired`. The auth tests pass; one unrelated snapshot in `refresh.test.ts` still fails." } });
      await u({ sessionUpdate: "usage_update", used: 41200, size: 200000, cost: { amount: 0.12, currency: "USD" } });
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }), ndJsonStream(a2c.writable, c2a.readable));
  return ndJsonStream(c2a.writable, a2c.readable);
}

async function shoot(mode: "dark" | "light") {
  applyTheme(mode, colors);
  const setup = await createTestRenderer({ width: 100, height: 38 });
  const repo = mkdtempSync(join(tmpdir(), "codemax-preview-repo-"));
  Bun.spawnSync(["sh", "-c", "git init -q && echo x > a && git add -A && git -c user.email=a@b -c user.name=t commit -qm init"], { cwd: repo });
  const app = new ChatApp(setup.renderer, { ...structuredClone(DEFAULT_CONFIG), order: ["claude"], summarizeOnSwitch: false, priceUpdates: false, checkpoints: false }, new Ledger(repo), repo);
  app.checkBlockers = () => [];
  app.engineFactory = (agent) => new AcpEngine({ agent, name: "Claude Code", cmd: [], stream: fakeAgent() });
  (app as any).refreshDetect = async () => void (app as any).detect.set("claude", { installed: true, version: "2.1", engine: true });
  void app.start("claude", true);
  const until = async (pred: (f: string) => boolean) => {
    for (let i = 0; i < 300; i++) {
      await setup.renderOnce();
      if (pred(setup.captureCharFrame())) return;
      await Bun.sleep(20);
    }
    throw new Error("preview timed out:\n" + setup.captureCharFrame());
  };
  await until((f) => f.includes("new session"));
  await setup.mockInput.typeText("fix the failing auth test");
  setup.mockInput.pressEnter();
  await until((f) => f.includes("still fails") && f.includes("for "));
  await Bun.sleep(120);
  await setup.renderOnce();
  write(`${prefix}${mode}-session`, setup.captureSpans(), mode);
  await setup.mockInput.typeText("/");
  await until((f) => f.includes("/agents"));
  await setup.renderOnce();
  write(`${prefix}${mode}-palette`, setup.captureSpans(), mode);
  setup.mockInput.pressEscape();
  setup.mockInput.pressEscape();
  (app as any).addNote("codex", "Codex", "Heads up · The tests ran once, so a flaky pass would ship.\n\n**Thin evidence**\n- `bun test test/auth.test.ts` ran a single time\n- one unrelated snapshot still fails\n- **Consider running the suite twice before shipping.**");
  await setup.mockInput.typeText("/config");
  setup.mockInput.pressEnter();
  await until((f) => f.includes("Keep awake"));
  await setup.renderOnce();
  write(`${prefix}${mode}-config`, setup.captureSpans(), mode);
  await app.quit();
  setup.renderer.destroy();
}

function hex(c: { r: number; g: number; b: number }) {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function write(name: string, frame: CapturedFrame, mode: "dark" | "light") {
  const bg = mode === "dark" ? "#16161a" : "#ffffff";
  const defaultFg = mode === "dark" ? "#e8e3e6" : "#1f1a1d";
  const rows = frame.lines.map((line) =>
    line.spans
      .map((s) => {
        const fgc = hex(s.fg);
        // The test renderer reports the terminal's default colours as white-on-black.
        const color = fgc === "#ffffff" ? defaultFg : fgc;
        const back = s.bg.a > 0 && hex(s.bg) !== "#000000" ? `background:${hex(s.bg)};` : "";
        const weight = s.attributes & 1 ? "font-weight:700;" : "";
        const style = s.attributes & 4 ? "font-style:italic;" : "";
        const strike = s.attributes & 128 ? "text-decoration:line-through;" : "";
        const text = s.text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        return `<span style="color:${color};${back}${weight}${style}${strike}">${text}</span>`;
      })
      .join(""),
  );
  const html = `<!doctype html><meta charset="utf-8"><title>${name}</title><body style="margin:0;background:${bg}"><pre style="margin:0;padding:16px;font:14px/1.35 'JetBrains Mono',Menlo,monospace;background:${bg}">${rows.join("\n")}</pre></body>`;
  writeFileSync(join(out, `${name}.html`), html);
  console.log(join(out, `${name}.html`));
}

await shoot("dark");
await shoot("light");
process.exit(0);

/**
 * Typing latency benchmark: the real chat UI with a fake agent. Fills the transcript, then
 * types while idle and while the agent streams, and reports the time per key (handling plus
 * one render) and how long the event loop was blocked (what makes typing feel laggy).
 *
 *   bun scripts/type-bench.ts [toolRows]
 *
 * Nothing is spawned and no agent is contacted.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";

process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-bench-home-"));
const { ChatApp } = await import("../src/chat/app.ts");
const { AcpEngine } = await import("../src/engines/acp.ts");
const { Ledger } = await import("../src/core/ledger.ts");
const { DEFAULT_CONFIG } = await import("../src/config.ts");
const { applyTheme } = await import("../src/chat/theme.ts");

const ROWS = Number(process.argv[2] ?? 600);
const PARA = "Here is what I found in `src/auth.ts`: the **expiry check** compares with `<` instead of `<=`, so a token that expires this exact millisecond is treated as valid. ";

function fakeAgent() {
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  new AgentSideConnection((conn): Agent => ({
    async initialize() { return { protocolVersion: 1, agentInfo: { name: "claude", version: "2.1" }, agentCapabilities: {}, authMethods: [] } as any; },
    async newSession() { return { sessionId: "bench" } as any; },
    async loadSession() { return {} as any; },
    async authenticate() { return {}; },
    async prompt({ sessionId, prompt }) {
      const u = (update: any) => conn.sessionUpdate({ sessionId, update });
      const text = (prompt[0] as any).text as string;
      if (text === "fill") {
        for (let i = 0; i < ROWS; i++) {
          await u({ sessionUpdate: "tool_call", toolCallId: `e${i}`, title: `Edit src/file${i}.ts`, kind: "edit", status: "completed", content: [{ type: "content", content: { type: "text", text: "line one\nline two\nline three" } }] });
          if (i % 5 === 0) await u({ sessionUpdate: "agent_message_chunk", messageId: `m${i}`, content: { type: "text", text: PARA.repeat(3) } });
        }
      } else {
        // Stream a long reply in small chunks, like a real agent: prose, then a big code block
        // arriving line by line (CODE=1), as when an agent shows a whole file.
        const big = process.env.CODE === "1";
        if (big) await u({ sessionUpdate: "agent_message_chunk", messageId: "s1", content: { type: "text", text: "Here is the new file:\n\n```ts\n" } });
        for (let i = 0; i < (big ? Number(process.env.LINES ?? 400) : 300); i++) {
          const chunk = big ? `export function handler${i}(req: Request, res: Response): Promise<void> { return res.json({ ok: ${i} > 3, items: [1, 2, 3].map((n) => n * ${i}) }); }\n` : i % 20 === 19 ? "\n\n```ts\nconst x = 1;\n```\n\n" : PARA.slice(0, 40);
          await u({ sessionUpdate: "agent_message_chunk", messageId: "s1", content: { type: "text", text: chunk } });
          if (!big && i % 50 === 0) await u({ sessionUpdate: "tool_call", toolCallId: `r${i}`, title: `Read src/x${i}.ts`, kind: "read", status: "completed" });
          await Bun.sleep(big ? 4 : 15);
        }
        if (big) await u({ sessionUpdate: "agent_message_chunk", messageId: "s1", content: { type: "text", text: "```\n" } });
      }
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }), ndJsonStream(a2c.writable, c2a.readable));
  return ndJsonStream(c2a.writable, a2c.readable);
}

applyTheme("dark");
const setup = await createTestRenderer({ width: 120, height: 40 });
const repo = mkdtempSync(join(tmpdir(), "codemax-bench-repo-"));
Bun.spawnSync(["sh", "-c", "git init -q && echo x > a && git add -A && git -c user.email=a@b -c user.name=t commit -qm init"], { cwd: repo });
const app: any = new ChatApp(setup.renderer, { ...structuredClone(DEFAULT_CONFIG), order: ["claude"], summarizeOnSwitch: false, priceUpdates: false, checkpoints: false, updateCheck: false, onboarded: true } as any, new Ledger(repo), repo);
app.checkBlockers = () => [];
app.engineFactory = (agent: string) => new AcpEngine({ agent, name: "Claude Code", cmd: [], stream: fakeAgent() } as any);
app.refreshDetect = async () => void app.detect.set("claude", { installed: true, version: "2.1", engine: true });
void app.start("claude", true);
const until = async (pred: () => boolean) => {
  for (let i = 0; i < 3000 && !pred(); i++) {
    await setup.renderOnce();
    await Bun.sleep(5);
  }
};
await until(() => setup.captureCharFrame().includes("new session"));
const send = async (t: string) => {
  await setup.mockInput.typeText(t);
  setup.mockInput.pressEnter();
};
await send("fill");
await until(() => !app.active?.turn && app.transcript.box.getChildren().length > ROWS);
await setup.renderOnce();

// Event-loop lag: how late a 4 ms timer fires (a key arriving then waits that long).
function lagMeter() {
  const lags: number[] = [];
  let last = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    lags.push(now - last - 4);
    last = now;
  }, 4);
  return { stop: () => (clearInterval(t), lags) };
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return `p50 ${q(0.5).toFixed(1)}ms  p95 ${q(0.95).toFixed(1)}ms  max ${s.at(-1)!.toFixed(1)}ms`;
};
const handle: number[] = [], render: number[] = [];
async function typeKeys(n: number) {
  const per: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await setup.mockInput.typeText(i % 30 === 29 ? " " : "a");
    const t1 = performance.now();
    await setup.renderOnce();
    const t2 = performance.now();
    handle.push(t1 - t0);
    render.push(t2 - t1);
    per.push(t2 - t0);
    await Bun.sleep(25); // a fast typist
  }
  return per;
}

console.log(`transcript: ${app.transcript.box.getChildren().length} rows`);
let lag = lagMeter();
let per = await typeKeys(120);
console.log(`idle      per key: ${stats(per)} | loop lag: ${stats(lag.stop())}`);
console.log(`          handling: ${stats(handle)} | render: ${stats(render)}`);
handle.length = 0; render.length = 0;
{ const t0 = performance.now(); for (let i = 0; i < 20; i++) await setup.renderOnce(); console.log(`          render with nothing changed: ${((performance.now() - t0) / 20).toFixed(1)}ms`); }
{ const t0 = performance.now(); for (let i = 0; i < 20; i++) { app.footerText.content = "footer " + i; await setup.renderOnce(); } console.log(`          render after a footer text change: ${((performance.now() - t0) / 20).toFixed(1)}ms`); }
{ const t0 = performance.now(); for (let i = 0; i < 20; i++) { app.working.content = "spin " + i; await setup.renderOnce(); } console.log(`          render after a spinner text change: ${((performance.now() - t0) / 20).toFixed(1)}ms`); }
{ const keep = app.input.onContentChange; app.input.onContentChange = () => {}; const t0 = performance.now(); for (let i = 0; i < 20; i++) { app.input.insertText("b"); await setup.renderOnce(); } console.log(`          render after textarea insert, codemax's handler off: ${((performance.now() - t0) / 20).toFixed(1)}ms`); app.input.onContentChange = keep; }
{ const t0 = performance.now(); for (let i = 0; i < 20; i++) { app.input.insertText("c"); await setup.renderOnce(); } console.log(`          render after textarea insert, handler on: ${((performance.now() - t0) / 20).toFixed(1)}ms`); }
{ let sum = 0; for (let i = 0; i < 20; i++) { await Bun.sleep(25); const t0 = performance.now(); await setup.renderOnce(); sum += performance.now() - t0; } console.log(`          render after 25ms idle (timers only): ${(sum / 20).toFixed(1)}ms`); }
{ let sum = 0; for (let i = 0; i < 20; i++) { await Bun.sleep(25); Bun.gc(true); const t0 = performance.now(); await setup.renderOnce(); sum += performance.now() - t0; } console.log(`          render after 25ms idle + forced GC first: ${(sum / 20).toFixed(1)}ms`); }
{ let sum = 0; for (let i = 0; i < 20; i++) { await Bun.sleep(1); const t0 = performance.now(); await setup.renderOnce(); sum += performance.now() - t0; } console.log(`          render after 1ms idle: ${(sum / 20).toFixed(1)}ms`); }
{ let sum = 0; for (let i = 0; i < 20; i++) { await setup.mockInput.typeText("z"); await Bun.sleep(25); const t0 = performance.now(); await setup.renderOnce(); sum += performance.now() - t0; } console.log(`          render 25ms after a key (its timers ran): ${(sum / 20).toFixed(1)}ms`); }
{ const t0 = performance.now(); for (let i = 0; i < 20; i++) { setup.mockInput.pressKey("f5"); await setup.renderOnce(); } console.log(`          render after an F5 key (nothing handles it): ${((performance.now() - t0) / 20).toFixed(1)}ms`); }
{ const t0 = performance.now(); for (let i = 0; i < 20; i++) { app.input.cursorOffset = i % 2; await setup.renderOnce(); } console.log(`          render after moving the cursor: ${((performance.now() - t0) / 20).toFixed(1)}ms`); }
{ const t0 = performance.now(); for (let i = 0; i < 20; i++) { app.inputWrap.borderColor = i % 2 ? "#888888" : "#999999"; await setup.renderOnce(); } console.log(`          render after a prompt border colour change: ${((performance.now() - t0) / 20).toFixed(1)}ms`); }
for (let i = 0; i < 120; i++) setup.mockInput.pressBackspace();
await setup.renderOnce();
// A long message already in the prompt (a pasted log), then typing at its end.
app.input.insertText("error: something failed at step ".repeat(250));
await setup.renderOnce();
handle.length = 0; render.length = 0;
per = await typeKeys(60);
console.log(`long prompt (8k chars) per key: ${stats(per)} | handling ${stats(handle)}`);
app.input.clear();
await setup.renderOnce();
// The slash command palette: type "/" then a command name, letter by letter, and back.
// A real Claude Code reports its skills and plugin commands too (hundreds on some machines).
app.input.clear();
await setup.renderOnce();
if (process.env.CMDS) app.active.commands = Array.from({ length: Number(process.env.CMDS) }, (_, i) => ({ name: `plugin-${i % 30}:skill-${i}`, description: "Use this skill whenever the user wants to do something with a thing, including reading, writing and checking it. ".repeat(3) }));
{
  const keys = "/config".split("");
  const per2: number[] = [];
  for (let r = 0; r < 8; r++) {
    for (const k of keys) {
      const t0 = performance.now();
      await setup.mockInput.typeText(k);
      await setup.renderOnce();
      per2.push(performance.now() - t0);
      await Bun.sleep(25);
    }
    for (let i = 0; i < keys.length; i++) {
      const t0 = performance.now();
      setup.mockInput.pressBackspace();
      await setup.renderOnce();
      per2.push(performance.now() - t0);
      await Bun.sleep(25);
    }
  }
  console.log(`/ palette per key: ${stats(per2)}`);
}
// The @file picker over a big project.
const files = Array.from({ length: 20000 }, (_, i) => `src/module${i % 300}/component${i}.tsx`);
app.fileList = files; app.projectFiles = files; app.filesCache = files;
handle.length = 0; render.length = 0;
await setup.mockInput.typeText("look at @");
await setup.renderOnce();
per = await typeKeys(30);
console.log(`@file picker (20k files) per key: ${stats(per)} | handling ${stats(handle)}`);
app.input.clear();
await setup.renderOnce();
void send("stream");
await Bun.sleep(100);
lag = lagMeter();
per = await typeKeys(120);
console.log(`streaming per key: ${stats(per)} | loop lag: ${stats(lag.stop())}`);
console.log(`          handling: ${stats(handle)} | render: ${stats(render)}`);
await until(() => !app.active?.turn);
await app.quit().catch(() => {});
process.exit(0);

/** The real chat UI on a real terminal renderer with a scripted agent (for scripts/pty-bench.ts). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";
process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-pty-home-"));
const { ChatApp } = await import("../src/chat/app.ts");
const { AcpEngine } = await import("../src/engines/acp.ts");
const { Ledger } = await import("../src/core/ledger.ts");
const { DEFAULT_CONFIG } = await import("../src/config.ts");
const { applyTheme } = await import("../src/chat/theme.ts");
const ROWS = Number(process.env.ROWS ?? 600);
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
        for (let i = 0; i < 600; i++) {
          await u({ sessionUpdate: "agent_message_chunk", messageId: "s1", content: { type: "text", text: i % 20 === 19 ? "\n\n```ts\nconst x = 1;\n```\n\n" : PARA.slice(0, 40) } });
          await Bun.sleep(15);
        }
      }
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }), ndJsonStream(a2c.writable, c2a.readable));
  return ndJsonStream(c2a.writable, a2c.readable);
}
const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, targetFps: Number(process.env.FPS ?? 60) });
applyTheme("dark");
const repo = mkdtempSync(join(tmpdir(), "codemax-pty-repo-"));
Bun.spawnSync(["sh", "-c", "git init -q && echo x > a && git add -A && git -c user.email=a@b -c user.name=t commit -qm init"], { cwd: repo });
const app: any = new ChatApp(renderer, { ...structuredClone(DEFAULT_CONFIG), order: ["claude"], summarizeOnSwitch: false, priceUpdates: false, checkpoints: false, updateCheck: false, onboarded: true, tips: false } as any, new Ledger(repo), repo);
app.checkBlockers = () => [];
app.engineFactory = (agent: string) => new AcpEngine({ agent, name: "Claude Code", cmd: [], stream: fakeAgent() } as any);
app.refreshDetect = async () => void app.detect.set("claude", { installed: true, version: "2.1", engine: true });
setTimeout(() => {
  if (process.env.CMDS && app.active) app.active.commands = Array.from({ length: Number(process.env.CMDS) }, (_, i) => ({ name: `plugin-${i % 30}:skill-${i}`, description: "Use this skill whenever the user wants to do something with a thing, including reading, writing and checking it. ".repeat(3) }));
}, 1500);
await app.start("claude", true);
process.exit(0);

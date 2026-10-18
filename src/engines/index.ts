import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentId } from "../adapters/types.ts";
import type { Engine, EngineFactory } from "./types.ts";
import { AcpEngine } from "./acp.ts";
import { CodexEngine } from "./codex.ts";

/** The Claude ACP adapter installed with codemax; it runs the user's own `claude`. */
function claudeAdapterBin(): string | null {
  const candidates = [
    join(import.meta.dir, "..", "..", "node_modules", ".bin", "claude-code-acp"),
    join(process.cwd(), "node_modules", ".bin", "claude-code-acp"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return Bun.which("claude-code-acp");
}

const factories: EngineFactory[] = [
  {
    agent: "claude",
    available: async () => !!Bun.which("claude") && !!claudeAdapterBin(),
    create: () =>
      new AcpEngine({
        agent: "claude",
        name: "Claude Code",
        cmd: [claudeAdapterBin()!],
        env: { CLAUDE_CODE_EXECUTABLE: Bun.which("claude")! },
      }),
  },
  {
    agent: "codex",
    available: async () => !!Bun.which("codex"),
    create: () => new CodexEngine(),
  },
  {
    agent: "opencode",
    available: async () => !!Bun.which("opencode"),
    // OpenCode's defaults allow edits and shell without asking. Over ACP it honours an inline
    // config, so codemax makes it ask for anything that changes state; reads stay silent.
    create: () =>
      new AcpEngine({
        agent: "opencode",
        name: "OpenCode",
        cmd: ["opencode", "acp"],
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "ask", read: "allow", glob: "allow", grep: "allow", list: "allow", todowrite: "allow", todoread: "allow", webfetch: "ask" } }) },
      }),
  },
  {
    agent: "grok",
    available: async () => !!Bun.which("grok"),
    // Grok takes its permission mode from the user's Claude Code settings; see grokPermissionNote().
    create: () => new AcpEngine({ agent: "grok", name: "Grok", cmd: ["grok", "agent", "stdio"], permissionPrompts: !grokPermissionNote() }),
  },
  {
    agent: "gemini",
    available: async () => !!Bun.which("gemini"),
    create: () => new AcpEngine({ agent: "gemini", name: "Gemini CLI", cmd: ["gemini", "--experimental-acp"] }),
  },
];

/**
 * Grok applies Claude Code's settings files as its permission source (seen in
 * `grok inspect`). With `permissions.defaultMode: "auto"` there it rarely asks.
 * Returns a note for the user when that is the case, else null.
 */
export function grokPermissionNote(): string | null {
  for (const f of [join(homedir(), ".claude", "settings.local.json"), join(homedir(), ".claude", "settings.json")]) {
    try {
      const mode = JSON.parse(readFileSync(f, "utf8"))?.permissions?.defaultMode;
      if (mode && mode !== "default") return `Grok follows your Claude Code settings (${f}): defaultMode is "${mode}", so it will act without asking. Set it to "default" there to get prompts.`;
    } catch {
      /* missing or unreadable */
    }
  }
  return null;
}

/** Agents whose protocol never asks before acting on this machine; shown as a warning in the menu. */
export const NO_PERMISSION_PROMPTS: ReadonlySet<AgentId> = new Set(grokPermissionNote() ? ["grok"] : []);

export const engineFactories: Partial<Record<AgentId, EngineFactory>> = Object.fromEntries(factories.map((f) => [f.agent, f]));

export function hasEngine(agent: AgentId): boolean {
  return !!engineFactories[agent];
}

export function createEngine(agent: AgentId): Engine {
  const f = engineFactories[agent];
  if (!f) throw new Error(`no protocol engine for ${agent}`);
  return f.create();
}

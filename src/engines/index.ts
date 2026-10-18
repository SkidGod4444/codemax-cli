import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentId } from "../adapters/types.ts";
import type { Engine, EngineFactory } from "./types.ts";
import { AcpEngine, type UsageSample } from "./acp.ts";
import { CodexEngine } from "./codex.ts";
import { ClaudeUsageTail } from "../transcripts/claude-usage.ts";

/** Grok writes ~/.grok/sessions/<encoded cwd>/<session>/usage.json with per-turn totals. */
function grokUsageTail(cwd: string, sessionId: string): { read(): UsageSample[] } {
  const path = join(homedir(), ".grok", "sessions", encodeURIComponent(cwd), sessionId, "usage.json");
  let seen = 0;
  return {
    read() {
      if (!existsSync(path)) return [];
      let j: any;
      try {
        j = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return [];
      }
      const turns: any[] = j.turns ?? [];
      const fresh = turns.slice(seen);
      seen = turns.length;
      return fresh.map((t) => ({
        model: t.primaryModelId ?? j.session?.primaryModelId,
        input: Math.max(0, (t.inputTokens ?? 0) - (t.cachedReadTokens ?? 0)),
        cacheRead: t.cachedReadTokens ?? 0,
        cacheWrite: t.cacheCreationTokens ?? 0,
        output: t.outputTokens ?? 0,
        costUsd: typeof t.costUsdTicks === "number" ? t.costUsdTicks / 1e10 : undefined,
      }));
    },
  };
}

const CLAUDE_ADAPTER_PKG = "@zed-industries/claude-code-acp@0.16.2";

/**
 * Command for the Claude ACP adapter (it runs the user's own `claude`).
 * From a source checkout it is in node_modules; from the compiled binary it is
 * fetched once by bunx and cached.
 */
function claudeAdapterCmd(): string[] | null {
  const candidates = [
    join(import.meta.dir, "..", "..", "node_modules", ".bin", "claude-code-acp"),
    join(process.cwd(), "node_modules", ".bin", "claude-code-acp"),
  ];
  for (const c of candidates) if (existsSync(c)) return [c];
  const onPath = Bun.which("claude-code-acp");
  if (onPath) return [onPath];
  const bunx = Bun.which("bunx") ?? (Bun.which("bun") ? [Bun.which("bun")!, "x"] : null);
  if (!bunx) return null;
  return Array.isArray(bunx) ? [...bunx, CLAUDE_ADAPTER_PKG] : [bunx, CLAUDE_ADAPTER_PKG];
}

const factories: EngineFactory[] = [
  {
    agent: "claude",
    available: async () => !!Bun.which("claude") && !!claudeAdapterCmd(),
    create: () =>
      new AcpEngine({
        agent: "claude",
        name: "Claude Code",
        cmd: claudeAdapterCmd()!,
        env: { CLAUDE_CODE_EXECUTABLE: Bun.which("claude")! },
        usageTail: (s) => new ClaudeUsageTail(s.cwd, s.id),
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
    create: () => new AcpEngine({ agent: "grok", name: "Grok", cmd: ["grok", "agent", "stdio"], permissionPrompts: !grokPermissionNote(), usageTail: (s) => grokUsageTail(s.cwd, s.id) }),
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

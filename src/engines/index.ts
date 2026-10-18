import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentId } from "../adapters/types.ts";
import type { Engine, EngineFactory } from "./types.ts";
import { AcpEngine, type UsageSample } from "./acp.ts";
import { CodexEngine } from "./codex.ts";
import { ClaudeUsageTail } from "../transcripts/claude-usage.ts";
import { antigravityServer } from "./antigravity.ts";

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

const CLAUDE_ADAPTER_PKG = "@agentclientprotocol/claude-agent-acp@0.93.0";

/**
 * Command for the Claude ACP adapter (it runs the user's own `claude`).
 * From a source checkout it is in node_modules; from the compiled binary it is
 * fetched once by bunx and cached.
 */
function claudeAdapterCmd(): string[] | null {
  const runningOnBun = basename(process.execPath).toLowerCase().startsWith("bun");
  if (process.platform !== "win32") {
    const candidates = [
      join(import.meta.dir, "..", "..", "node_modules", ".bin", "claude-agent-acp"),
      join(process.cwd(), "node_modules", ".bin", "claude-agent-acp"),
    ];
    for (const c of candidates) if (existsSync(c)) return [c];
  }
  // The installed package's own entry, run with this Bun: works where .bin shims
  // do not (Windows) and when no `bun` is on PATH (installed through npm).
  if (runningOnBun) {
    try {
      const pkgJson = Bun.resolveSync("@agentclientprotocol/claude-agent-acp/package.json", import.meta.dir);
      const bin = JSON.parse(readFileSync(pkgJson, "utf8")).bin;
      const entry = typeof bin === "string" ? bin : bin?.["claude-agent-acp"];
      if (entry && existsSync(join(dirname(pkgJson), entry))) return [process.execPath, join(dirname(pkgJson), entry)];
    } catch {
      /* not installed next to codemax */
    }
  }
  const onPath = Bun.which("claude-agent-acp");
  if (onPath) return [onPath];
  const bun = Bun.which("bun") ?? (runningOnBun ? process.execPath : null);
  const bunx = Bun.which("bunx") ? [Bun.which("bunx")!] : bun ? [bun, "x"] : null;
  return bunx ? [...bunx, CLAUDE_ADAPTER_PKG] : null;
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
    agent: "cursor",
    available: async () => !!Bun.which("cursor-agent"),
    // `cursor-agent acp` (Cursor Agent 2026.10+) asks before shell commands and edits, and
    // exposes its modes (agent / plan / ask) and models as ACP config options.
    create: () => new AcpEngine({ agent: "cursor", name: "Cursor Agent", cmd: ["cursor-agent", "acp"] }),
  },
  {
    agent: "antigravity",
    // Google's ACP server for Antigravity (installed on request, see antigravity.ts), driven over
    // plain pipes and signed in with the user's Google account only, never an API key.
    available: async () => !!Bun.which("agy") && !!antigravityServer(),
    create: () => new AcpEngine({ agent: "antigravity", name: "Antigravity CLI", cmd: antigravityServer()!.cmd, plainPipes: true, signIn: ["oauth-personal", "oauth-business"] }),
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

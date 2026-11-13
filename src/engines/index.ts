import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentId } from "../adapters/types.ts";
import type { Engine, EngineFactory } from "./types.ts";
import { AcpEngine, type UsageSample } from "./acp.ts";
import { CodexEngine } from "./codex.ts";
import { ClaudeUsageTail } from "../transcripts/claude-usage.ts";
import { antigravityHome, antigravityServer } from "./antigravity.ts";
import { platformCmd, which } from "../core/spawn.ts";
import { debugEvent } from "../core/debuglog.ts";
import { IS_COMPILED } from "../core/update.ts";

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

export const CLAUDE_ADAPTER_PKG = "@agentclientprotocol/claude-agent-acp@0.93.0";

/** How to start the Claude ACP adapter, what it needs in its environment, and whether bunx fetches it (first run: ~10 s). */
export interface ClaudeAdapter {
  cmd: string[];
  env: Record<string, string>;
  fetched: boolean;
}

export interface AdapterDeps {
  which: (bin: string) => string | null;
  exists: (path: string) => boolean;
  execPath: string;
  /** This is the compiled codemax: Bun is built in. */
  compiled: boolean;
}

const adapterDeps = (): AdapterDeps => ({ which, exists: existsSync, execPath: process.execPath, compiled: IS_COMPILED });

/**
 * The Claude ACP adapter (it runs the user's own `claude`). From a source checkout it is in node_modules; otherwise bunx
 * fetches it once and caches it. With no Bun on the machine, the compiled codemax does that itself: it is Bun, and
 * BUN_BE_BUN=1 makes it act as the `bun` CLI. Apps ship that binary to Macs with neither Bun nor Node, where this
 * returned nothing before 0.1.24 and Claude Code showed as "no protocol engine on this machine".
 */
export function claudeAdapter(d: AdapterDeps = adapterDeps()): ClaudeAdapter | null {
  const runningOnBun = basename(d.execPath).toLowerCase().startsWith("bun");
  if (process.platform !== "win32") {
    const candidates = [
      join(import.meta.dir, "..", "..", "node_modules", ".bin", "claude-agent-acp"),
      join(process.cwd(), "node_modules", ".bin", "claude-agent-acp"),
    ];
    for (const c of candidates) if (d.exists(c)) return { cmd: [c], env: {}, fetched: false };
  }
  // The installed package's own entry, run with this Bun: works where .bin shims
  // do not (Windows) and when no `bun` is on PATH (installed through npm).
  if (runningOnBun) {
    try {
      const pkgJson = Bun.resolveSync("@agentclientprotocol/claude-agent-acp/package.json", import.meta.dir);
      const bin = JSON.parse(readFileSync(pkgJson, "utf8")).bin;
      const entry = typeof bin === "string" ? bin : bin?.["claude-agent-acp"];
      if (entry && d.exists(join(dirname(pkgJson), entry))) return { cmd: [d.execPath, join(dirname(pkgJson), entry)], env: {}, fetched: false };
    } catch {
      /* not installed next to codemax */
    }
  }
  const onPath = d.which("claude-agent-acp");
  if (onPath) return { cmd: [onPath], env: {}, fetched: false };
  const bun = d.which("bun") ?? (runningOnBun ? d.execPath : null);
  const bunx = d.which("bunx") ? [d.which("bunx")!] : bun ? [bun, "x"] : null;
  if (bunx) return { cmd: [...bunx, CLAUDE_ADAPTER_PKG], env: {}, fetched: true };
  // `--bun`: run the adapter (a `#!/usr/bin/env node` script) on this Bun, so Node is not needed either. The variable
  // reaches the adapter's own children too; `claude` ignores it (checked with 2.1.319).
  if (d.compiled) return { cmd: [d.execPath, "x", "--bun", CLAUDE_ADAPTER_PKG], env: { BUN_BE_BUN: "1" }, fetched: true };
  return null;
}

/** The oldest Copilot CLI whose ACP mode was seen asking before edits and commands. */
export const COPILOT_MIN = [1, 0, 111];

/** Is this `copilot --version` text GitHub's Copilot CLI, COPILOT_MIN or newer? */
export function copilotVersionOk(text: string): boolean {
  const m = text.match(/GitHub Copilot CLI (\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const v = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== COPILOT_MIN[i]) return v[i]! > COPILOT_MIN[i]!;
  return true;
}

let copilotVersionText: Promise<string> | null = null;
function copilotVersion(): Promise<string> {
  copilotVersionText ??= (async () => {
    try {
      const p = Bun.spawn({ ...platformCmd(["copilot", "--version"]), stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const timer = setTimeout(() => p.kill(), 15_000);
      const out = await new Response(p.stdout).text();
      clearTimeout(timer);
      const ok = copilotVersionOk(out);
      debugEvent("copilot-version", { ok, version: out.match(/\d+\.\d+\.\d+/)?.[0] });
      return out;
    } catch {
      return "";
    }
  })();
  return copilotVersionText;
}

const factories: EngineFactory[] = [
  {
    agent: "claude",
    available: async () => !!which("claude") && !!claudeAdapter(),
    create: () => {
      const adapter = claudeAdapter()!;
      return new AcpEngine({
        agent: "claude",
        name: "Claude Code",
        cmd: adapter.cmd,
        env: { ...adapter.env, CLAUDE_CODE_EXECUTABLE: which("claude")! },
        forkAtMessage: true,
        usageTail: (s) => new ClaudeUsageTail(s.cwd, s.id),
      });
    },
  },
  {
    agent: "codex",
    available: async () => !!which("codex"),
    create: () => new CodexEngine(),
  },
  {
    agent: "opencode",
    available: async () => !!which("opencode"),
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
    available: async () => !!which("grok"),
    // Grok takes its permission mode from the user's Claude Code settings; see grokPermissionNote().
    create: () => new AcpEngine({ agent: "grok", name: "Grok", cmd: ["grok", "agent", "stdio"], permissionPrompts: !grokPermissionNote(), usageTail: (s) => grokUsageTail(s.cwd, s.id) }),
  },
  {
    agent: "cursor",
    available: async () => !!which("cursor-agent"),
    // `cursor-agent acp` (Cursor Agent 2026.10+) asks before shell commands and edits, and
    // exposes its modes (agent / plan / ask) and models as ACP config options.
    create: () => new AcpEngine({ agent: "cursor", name: "Cursor Agent", cmd: ["cursor-agent", "acp"] }),
  },
  {
    agent: "copilot",
    // GitHub Copilot CLI's own ACP mode (`copilot --acp`, checked live with 1.0.111): it asks
    // before file edits (with the diff) and before shell commands that change something, and
    // honours a reject; read-only commands (echo, ls) run unasked. Modes agent / plan / autopilot
    // and an "allow all" switch come as config options; codemax never turns those on. It signs
    // in with `copilot login` (the GitHub account's Copilot plan); env.ts removes its
    // own-provider and auto-approval variables. It reports tokens per turn and no model list.
    // Only GitHub's CLI, 1.0.111 or newer: earlier builds were reported to approve tools themselves
    // in ACP mode (github/copilot-cli#845), and AWS ships an unrelated `copilot`.
    available: async () => !!which("copilot") && copilotVersionOk(await copilotVersion()),
    create: () => new AcpEngine({ agent: "copilot", name: "Copilot CLI", cmd: ["copilot", "--acp"] }),
  },
  {
    agent: "antigravity",
    // Google's ACP server for Antigravity (downloaded once, see antigravity.ts), driven over
    // plain pipes and signed in with the user's Google account only, never an API key.
    available: async () => !!which("agy") && !!antigravityServer(),
    // A server of its own that cannot start makes it refuse every turn: it then runs in codemax's
    // linked home, whose MCP config leaves that server out (antigravityHome).
    create: () => {
      const home = antigravityHome();
      return new AcpEngine({ agent: "antigravity", name: "Antigravity CLI", cmd: antigravityServer()!.cmd, env: home ? { GEMINI_HOME: home.home } : undefined, plainPipes: true, signIn: ["oauth-personal", "oauth-business"] });
    },
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

/**
 * Agents that write file edits straight to disk without a permission request (they ask only
 * before shell commands), checked live: Cursor Agent sends the diff only after the edit.
 */
export const EDITS_WITHOUT_ASKING: ReadonlySet<AgentId> = new Set<AgentId>(["cursor"]);

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

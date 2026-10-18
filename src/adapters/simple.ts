import type { Adapter, AgentId, LaunchOptions, LaunchSpec } from "./types.ts";
import { detectBin } from "./detect.ts";

/**
 * Adapters for agents whose transcripts we do not parse yet (v0.2 work).
 * They launch, pass through, and get the handoff brief typed into the TUI.
 */
function simple(opts: {
  id: AgentId;
  name: string;
  bin: string;
  versionArgs?: string[];
  resumeArgs?: (id: string) => string[];
  promptPositional?: boolean;
  patterns?: RegExp[];
  apiKeyEnv?: string[];
}): Adapter {
  return {
    id: opts.id,
    name: opts.name,
    bin: opts.bin,
    detect: () => detectBin(opts.bin, opts.versionArgs),
    launch(o: LaunchOptions): LaunchSpec {
      const cmd = [opts.bin];
      if (o.resume && opts.resumeArgs) cmd.push(...opts.resumeArgs(o.resume.id));
      if (o.extraArgs) cmd.push(...o.extraArgs);
      const consumed = !!o.prompt && !!opts.promptPositional;
      if (consumed) cmd.push(o.prompt!);
      return { cmd, promptConsumed: consumed };
    },
    async locateSession() {
      return null;
    },
    quotaPatterns: opts.patterns ?? [],
    apiKeyEnv: opts.apiKeyEnv ?? [],
  };
}

export const opencode = simple({
  id: "opencode",
  name: "OpenCode",
  bin: "opencode",
  // TUI positional is a project path, not a prompt → brief is typed in.
  patterns: [/usage limit reached/i],
});

export const cursor = simple({
  id: "cursor",
  name: "Cursor Agent",
  bin: "cursor-agent",
  resumeArgs: (id) => ["--resume", id],
  promptPositional: true,
  patterns: [/usage limit reached/i, /out of (fast )?requests/i],
  apiKeyEnv: ["CURSOR_API_KEY"],
});

export const grok = simple({
  id: "grok",
  name: "Grok CLI",
  bin: "grok",
  resumeArgs: (id) => ["--resume", id],
  patterns: [/usage limit reached/i],
  apiKeyEnv: ["XAI_API_KEY", "GROK_API_KEY"],
});

export const gemini = simple({
  id: "gemini",
  name: "Gemini CLI",
  bin: "gemini",
  promptPositional: false,
  patterns: [/quota exceeded/i, /RESOURCE_EXHAUSTED/],
  apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
});

export const copilot = simple({
  id: "copilot",
  name: "Copilot CLI",
  bin: "copilot",
  patterns: [/premium requests? (limit|exhausted|used up)/i],
});

/** Test-only agent: a plain shell, enabled with CODEMAX_FAKE_AGENT=1. */
export const fake = simple({
  id: "fake",
  name: "Fake (sh)",
  bin: "sh",
  versionArgs: ["-c", "echo 0.0.0"],
  patterns: [/FAKE_QUOTA_HIT/],
});

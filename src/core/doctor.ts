import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import type { AgentId } from "../adapters/types.ts";

export interface Finding {
  agent: AgentId | "all";
  severity: "block" | "warn";
  message: string;
  /** What `codemax doctor --fix` would do, when a safe fix exists. */
  fix?: { description: string; apply: () => string };
}

const KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/**
 * Checks that would make an agent bill an API key instead of a subscription,
 * or act without asking. codemax is subscriptions-only, so "block" findings
 * stop that agent from launching until fixed.
 */
export function diagnose(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Finding[] {
  const out: Finding[] = [];
  const CLAUDE_SETTINGS = join(home, ".claude", "settings.json");
  const CLAUDE_LOCAL = join(home, ".claude", "settings.local.json");
  for (const file of [CLAUDE_SETTINGS, CLAUDE_LOCAL]) {
    if (!existsSync(file)) continue;
    let json: any;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      out.push({ agent: "claude", severity: "warn", message: `${file} is not valid JSON; Claude Code may ignore it` });
      continue;
    }
    const injected = KEY_VARS.filter((k) => typeof json?.env?.[k] === "string" && json.env[k].length > 0);
    if (injected.length) {
      out.push({
        agent: "claude",
        severity: "block",
        message: `${file} sets ${injected.join(", ")} in its "env" block. Claude Code applies that at startup, so every session (codemax or not) bills the API key instead of your claude.ai plan.`,
        fix: {
          description: `remove ${injected.join(", ")} from the "env" block of ${file} (a backup is written next to it)`,
          apply: () => {
            copyFileSync(file, `${file}.codemax-backup`);
            for (const k of injected) delete json.env[k];
            if (json.env && Object.keys(json.env).length === 0) delete json.env;
            writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
            return `removed ${injected.join(", ")} from ${file}; backup at ${file}.codemax-backup`;
          },
        },
      });
    }
    if (typeof json?.apiKeyHelper === "string" && json.apiKeyHelper) {
      out.push({ agent: "claude", severity: "block", message: `${file} sets "apiKeyHelper"; Claude Code will fetch an API key from it and bill that key.` });
    }
    const mode = json?.permissions?.defaultMode;
    if (file === CLAUDE_SETTINGS && mode && mode !== "default") {
      out.push({ agent: "grok", severity: "warn", message: `Grok reads ${file}: permissions.defaultMode is "${mode}", so Grok acts without asking. Set it to "default" there to get prompts (this also changes Claude Code's own default).` });
    }
  }
  const envKeys = KEY_VARS.concat(["OPENAI_API_KEY", "CURSOR_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]).filter((k) => env[k]);
  if (envKeys.length) out.push({ agent: "all", severity: "warn", message: `${envKeys.join(", ")} set in this shell; codemax strips them for agents, but your plain CLI sessions will bill them.` });
  return out;
}

export function blockers(agent: AgentId): Finding[] {
  return diagnose().filter((f) => f.severity === "block" && (f.agent === agent || f.agent === "all"));
}

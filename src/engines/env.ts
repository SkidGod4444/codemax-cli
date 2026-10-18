/**
 * Environment for agent subprocesses. Subscriptions only: vendor API keys are
 * removed so each agent uses its login. Nested-session markers from a parent
 * Claude Code / Codex session are removed too. CLAUDE_CODE_EXECUTABLE is kept
 * on purpose: the Claude ACP adapter uses it to run the user's own `claude`.
 */
const STRIP = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CURSOR_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CODEX_SANDBOX|CODEX_THREAD_ID)$|^CLAUDE_CODE_(?!EXECUTABLE$)/;

export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) env[k] = v;
  return { ...env, ...extra };
}

export function strippedKeys(): string[] {
  return Object.keys(process.env).filter((k) => /API_KEY|AUTH_TOKEN/.test(k) && STRIP.test(k));
}

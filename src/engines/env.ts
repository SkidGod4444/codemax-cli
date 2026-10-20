/**
 * Environment for agent subprocesses. Subscriptions only: vendor API keys are
 * removed so each agent uses its login. Nested-session markers from a parent
 * Claude Code / Codex session are removed too. CLAUDE_CODE_EXECUTABLE is kept
 * on purpose: the Claude ACP adapter uses it to run the user's own `claude`.
 */
// AI vendors' keys (any of their *_API_KEY / *_AUTH_TOKEN / *_ACCESS_TOKEN names, so a key for a
// provider an agent can bill, like OpenRouter for OpenCode, never reaches it), plus the markers.
const VENDORS = "ANTHROPIC|OPENAI|AZURE_OPENAI|CODEX|CURSOR|XAI|GROK|GEMINI|GOOGLE|GOOGLE_GENAI|VERTEX|OPENROUTER|MISTRAL|DEEPSEEK|GROQ|TOGETHER|FIREWORKS|PERPLEXITY|COHERE|HUGGINGFACE|HF|REPLICATE|CEREBRAS|OPENCODE|MOONSHOT|KIMI|ZAI|ZHIPU|DASHSCOPE|QWEN|NVIDIA|SAMBANOVA|AI21|VOYAGE|AMP|COPILOT";
const STRIP = new RegExp(`^(${VENDORS})_(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|KEY)$|^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CODEX_SANDBOX|CODEX_THREAD_ID|AWS_BEARER_TOKEN_BEDROCK)$|^CLAUDE_CODE_(?!EXECUTABLE$)`);

export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) env[k] = v;
  return { ...env, ...extra };
}

export function strippedKeys(): string[] {
  return Object.keys(process.env).filter((k) => /API_KEY|AUTH_TOKEN/.test(k) && STRIP.test(k));
}

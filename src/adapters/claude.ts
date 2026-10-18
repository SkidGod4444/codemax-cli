import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Adapter, LaunchOptions, LaunchSpec, SessionRef } from "./types.ts";
import { HOME, escapeCwd } from "../core/paths.ts";
import { detectBin } from "./detect.ts";
import { parseClaudeTranscript } from "../transcripts/claude.ts";

function transcriptPath(cwd: string, id: string) {
  return join(HOME, ".claude", "projects", escapeCwd(cwd), `${id}.jsonl`);
}

export const claude: Adapter = {
  id: "claude",
  name: "Claude Code",
  bin: "claude",
  detect: () => detectBin("claude", ["--version"]),
  newSessionId: () => crypto.randomUUID(),
  launch(o: LaunchOptions): LaunchSpec {
    // Settings files can inject ANTHROPIC_API_KEY via their "env" block; blank it so the
    // claude.ai login is billed. (The ACP engine path cannot pass this and is gated by doctor.)
    const cmd = ["claude", "--settings", JSON.stringify({ env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } })];
    if (o.resume) cmd.push("--resume", o.resume.id);
    else if (o.sessionId) cmd.push("--session-id", o.sessionId);
    if (o.extraArgs) cmd.push(...o.extraArgs);
    // Interactive claude accepts an initial prompt as the positional argument.
    if (o.prompt) cmd.push(o.prompt);
    return { cmd, promptConsumed: !!o.prompt };
  },
  async locateSession({ cwd, startedAt, sessionId }) {
    if (!sessionId) return null;
    // The transcript appears after the first message; until then the session
    // does not exist on Claude's side and could not be resumed.
    const p = transcriptPath(cwd, sessionId);
    if (!existsSync(p)) return null;
    return { agent: "claude", id: sessionId, transcriptPath: p, cwd, startedAt, lastUsedAt: Date.now() };
  },
  async readTranscript(ref: SessionRef) {
    const p = ref.transcriptPath ?? transcriptPath(ref.cwd, ref.id);
    return parseClaudeTranscript(p, ref.id);
  },
  quotaPatterns: [/claude (ai )?usage limit reached/i, /out of extra usage/i, /limit will reset at/i],
  apiKeyEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
};

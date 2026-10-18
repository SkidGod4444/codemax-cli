import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME, escapeCwd } from "../core/paths.ts";

export interface UsageDelta {
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Claude Code writes per-message `usage` into its session transcript. The ACP
 * adapter does not relay it, so codemax tails the file: every call returns the
 * assistant records appended since the previous call for this session.
 */
export class ClaudeUsageTail {
  private offset = 0;
  private partial = "";
  readonly path: string;

  constructor(cwd: string, sessionId: string) {
    this.path = join(HOME, ".claude", "projects", escapeCwd(cwd), `${sessionId}.jsonl`);
  }

  read(): UsageDelta[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size <= this.offset) return [];
    const fd = openSync(this.path, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      text = this.partial + buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    const out: UsageDelta[] = [];
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.type !== "assistant" || !rec.message?.usage) continue;
        const u = rec.message.usage;
        out.push({
          model: rec.message.model,
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        });
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

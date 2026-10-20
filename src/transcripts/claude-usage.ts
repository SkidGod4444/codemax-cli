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
  /** Claude Code writes one line per content block (thinking, text, tool use), each with the whole message's usage: count each message once. */
  private seen = new Map<string, number>();
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
        const id = rec.message.id ?? rec.requestId;
        if (id) {
          // A later line of the same message can carry more output (it was still streaming): add only that.
          const prev = this.seen.get(id);
          const outNow = u.output_tokens ?? 0;
          if (prev !== undefined) {
            if (outNow > prev) {
              this.seen.set(id, outNow);
              out.push({ model: rec.message.model, input: 0, output: outNow - prev, cacheRead: 0, cacheWrite: 0 });
            }
            continue;
          }
          this.seen.set(id, outNow);
          if (this.seen.size > 5000) this.seen = new Map([...this.seen].slice(-2500));
        }
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

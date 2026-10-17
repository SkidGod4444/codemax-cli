import { existsSync, readFileSync } from "node:fs";
import type { Turn } from "../adapters/types.ts";

type Block = { type: string; text?: string; name?: string; content?: unknown };

/** Parse a Claude Code ~/.claude/projects/<p>/<session>.jsonl into turns. */
export function parseClaudeTranscript(path: string, sessionId: string): Turn[] {
  if (!existsSync(path)) return [];
  const turns: Turn[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    if (rec.isSidechain || rec.isMeta) continue;
    const msg = rec.message;
    if (!msg) continue;
    const ts = Date.parse(rec.timestamp ?? "") || Date.now();
    const content: string | Block[] = msg.content;

    if (rec.type === "user") {
      const text = userText(content);
      if (!text) continue; // tool_result-only or system-reminder-only lines
      turns.push({ ts, agent: "claude", sessionId, role: "user", text });
    } else {
      const { text, tools } = assistantText(content);
      if (!text && !tools.length) continue;
      // Merge consecutive assistant chunks (streaming writes several records per turn).
      const prev = turns[turns.length - 1];
      if (prev && prev.role === "assistant" && ts - prev.ts < 120_000) {
        if (text) prev.text = (prev.text ? prev.text + "\n" : "") + text;
        if (tools.length) prev.tools = [...new Set([...(prev.tools ?? []), ...tools])];
        continue;
      }
      turns.push({ ts, agent: "claude", sessionId, role: "assistant", text, tools: tools.length ? tools : undefined });
    }
  }
  return turns;
}

function userText(content: string | Block[]): string {
  const raw = typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  return cleanUser(raw);
}

export function cleanUser(s: string): string {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<command-name>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .trim();
}

function assistantText(content: string | Block[]): { text: string; tools: string[] } {
  if (typeof content === "string") return { text: content.trim(), tools: [] };
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => (b.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
  const tools = content.filter((b) => b.type === "tool_use" && b.name).map((b) => b.name as string);
  return { text, tools: [...new Set(tools)] };
}

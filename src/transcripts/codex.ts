import { existsSync, readFileSync } from "node:fs";
import type { QuotaStatus, Turn } from "../adapters/types.ts";

/** Parse a Codex ~/.codex/sessions/.../rollout-*.jsonl into turns. */
export function parseCodexTranscript(path: string, sessionId: string): Turn[] {
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
    if (rec.type !== "response_item") continue;
    const p = rec.payload ?? {};
    const ts = Date.parse(rec.timestamp ?? "") || Date.now();
    if (p.type === "message") {
      const text = (p.content ?? [])
        .map((c: any) => c.text ?? "")
        .join("\n")
        .trim();
      if (!text) continue;
      if (p.role === "user") {
        if (/^<(environment_context|user_instructions|permissions|turn_aborted|app_context)/.test(text)) continue;
        turns.push({ ts, agent: "codex", sessionId, role: "user", text });
      } else if (p.role === "assistant") {
        const prev = turns[turns.length - 1];
        if (prev && prev.role === "assistant" && ts - prev.ts < 120_000) {
          prev.text = (prev.text ? prev.text + "\n" : "") + text;
        } else turns.push({ ts, agent: "codex", sessionId, role: "assistant", text });
      }
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const name: string = p.name ?? p.type;
      const prev = turns[turns.length - 1];
      if (prev && prev.role === "assistant") prev.tools = [...new Set([...(prev.tools ?? []), name])];
      else turns.push({ ts, agent: "codex", sessionId, role: "assistant", text: "", tools: [name] });
    }
  }
  return turns.filter((t) => t.text || t.tools?.length);
}

/** Read the most recent rate_limits block Codex wrote into the rollout. */
export function codexQuotaFromRollout(path: string): QuotaStatus | null {
  if (!existsSync(path)) return null;
  let last: any = null;
  let lastTs = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const rec = JSON.parse(line);
      const rl = rec.payload?.rate_limits;
      if (rl) {
        last = rl;
        lastTs = Date.parse(rec.timestamp ?? "") || Date.now();
      }
    } catch {
      /* ignore */
    }
  }
  if (!last) return null;
  const used = last.primary?.used_percent ?? last.secondary?.used_percent;
  const reached = !!last.rate_limit_reached_type;
  return {
    agent: "codex",
    usedPercent: typeof used === "number" ? used : undefined,
    resetsAt: last.primary?.resets_at ? last.primary.resets_at * 1000 : undefined,
    exhausted: reached || (typeof used === "number" && used >= 100),
    source: "probe",
    detail: last.plan_type ? `plan ${last.plan_type}` : undefined,
    at: lastTs,
  };
}

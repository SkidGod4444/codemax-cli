/**
 * MCP server status as codemax shows it in /mcp, whatever agent reported it.
 * `status` follows Claude Code's words: connected, failed, needs-auth, pending, disabled.
 */
export interface McpStatus {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | string;
  tools?: number;
  error?: string;
  /** Where the agent says it came from (a scope or file), when it tells two same-named servers apart. */
  origin?: string;
}

const TITLE_STATUS: Record<string, McpStatus["status"]> = { failed: "failed", "needs authentication": "needs-auth", connecting: "pending", connected: "connected", disabled: "disabled" };

/**
 * The Claude ACP adapter answers a `/mcp` prompt with Markdown (its mcp-command.js): a summary
 * line, then one block per status ("**Connected**" and "- `name`: error; 12 tools" items, a
 * same-named server with its scope in brackets), and "**Disabled:** `a`, `b`". Names are code
 * spans whose fence may be longer than one backtick, padded with a space when needed.
 * Returns null for text that is not that list.
 */
export function parseClaudeMcpMarkdown(md: string): McpStatus[] | null {
  const text = md.trim();
  if (/^No MCP servers are configured\.?$/i.test(text)) return [];
  if (!/\*\*MCP servers:\*\*/.test(text)) return null;
  const out: McpStatus[] = [];
  let status: McpStatus["status"] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const disabledLine = line.match(/^\*\*Disabled:\*\*\s*(.*)$/);
    if (disabledLine) {
      for (const m of disabledLine[1]!.matchAll(/(`+)( ?)(.+?)\2\1(?:\s+\(([^)]+)\))?/g)) out.push({ name: m[3]!, status: "disabled", origin: m[4] });
      status = null;
      continue;
    }
    const title = line.match(/^\*\*([^*]+)\*\*$/);
    if (title) {
      const t = title[1]!.trim().toLowerCase();
      status = TITLE_STATUS[t] ?? t;
      continue;
    }
    const item = status && line.match(/^-\s+(`+)( ?)(.+?)\2\1(?:\s+\(([^)]+)\))?(?::\s*(.*))?$/);
    if (!item || !status) continue;
    const entry: McpStatus = { name: item[3]!, status, origin: item[4] };
    const details = (item[5] ?? "").split(/;\s*/).map((d) => d.trim()).filter(Boolean);
    for (const d of details) {
      const tools = d.match(/^(\d+) tools?$/);
      if (tools) entry.tools = Number(tools[1]);
      else entry.error = entry.error ? `${entry.error}; ${d}` : d;
    }
    out.push(entry);
  }
  return out;
}

/** One line for a status, the way /mcp shows it. */
export function describeStatus(s: McpStatus): { text: string; ok: boolean | null } {
  const tools = s.tools !== undefined ? ` · ${s.tools} tool${s.tools === 1 ? "" : "s"}` : "";
  switch (s.status) {
    case "connected":
      return { text: `✔ connected${tools}`, ok: true };
    case "failed":
      return { text: `✘ failed${s.error ? `: ${s.error}` : ""}`, ok: false };
    case "needs-auth":
      return { text: "⚠ needs authentication", ok: false };
    case "pending":
      return { text: "… connecting", ok: null };
    case "disabled":
      return { text: "disabled", ok: null };
    default:
      return { text: `${s.status}${s.error ? `: ${s.error}` : ""}${tools}`, ok: null };
  }
}

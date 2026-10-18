import { join } from "node:path";
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { Adapter, LaunchOptions, LaunchSpec, SessionRef } from "./types.ts";
import { HOME } from "../core/paths.ts";
import { detectBin } from "./detect.ts";
import { parseCodexTranscript, codexQuotaFromRollout } from "../transcripts/codex.ts";

const SESSIONS = join(HOME, ".codex", "sessions");

/** First line of a file. session_meta lines run to tens of KB, so read in chunks until a newline. */
function firstLine(path: string, max = 4 * 1024 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < max) {
      const buf = Buffer.alloc(65536);
      const n = readSync(fd, buf, 0, buf.length, total);
      if (n <= 0) break;
      chunks.push(buf.subarray(0, n));
      total += n;
      if (buf.subarray(0, n).includes(0x0a)) break;
    }
    return Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? "";
  } finally {
    closeSync(fd);
  }
}

/** Rollout files written on/after `since`, newest first. Scans today and yesterday. */
function recentRollouts(since: number): string[] {
  const out: string[] = [];
  for (const dayOffset of [0, 1]) {
    const d = new Date(since - dayOffset * 86_400_000);
    const dir = join(SESSIONS, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      if (statSync(p).mtimeMs >= since - 2000) out.push(p);
    }
  }
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function findRolloutById(id: string): string | undefined {
  // Walk year/month/day dirs, newest first.
  if (!existsSync(SESSIONS)) return undefined;
  const years = readdirSync(SESSIONS).sort().reverse();
  for (const y of years) {
    const yd = join(SESSIONS, y);
    for (const m of readdirSync(yd).sort().reverse()) {
      const md = join(yd, m);
      for (const d of readdirSync(md).sort().reverse()) {
        const dd = join(md, d);
        const hit = readdirSync(dd).find((f) => f.includes(id));
        if (hit) return join(dd, hit);
      }
    }
  }
  return undefined;
}

export const codex: Adapter = {
  id: "codex",
  name: "Codex",
  bin: "codex",
  detect: () => detectBin("codex", ["--version"]),
  launch(o: LaunchOptions): LaunchSpec {
    // Global flags go before the subcommand so `resume` accepts them too.
    const cmd = ["codex", "-C", o.cwd];
    if (o.resume) cmd.push("resume", o.resume.id);
    if (o.extraArgs) cmd.push(...o.extraArgs);
    if (o.prompt) cmd.push(o.prompt);
    return { cmd, promptConsumed: !!o.prompt };
  },
  async locateSession({ cwd, startedAt }) {
    for (const p of recentRollouts(startedAt)) {
      try {
        const meta = JSON.parse(firstLine(p));
        if (meta.type === "session_meta" && meta.payload?.cwd === cwd) {
          return { agent: "codex", id: meta.payload.id ?? meta.payload.session_id, transcriptPath: p, cwd, startedAt, lastUsedAt: Date.now() };
        }
      } catch {
        /* partial write, try next */
      }
    }
    return null;
  },
  async readTranscript(ref: SessionRef) {
    const p = ref.transcriptPath ?? findRolloutById(ref.id);
    return p ? parseCodexTranscript(p, ref.id) : [];
  },
  async probeQuota(ref) {
    const p = ref?.transcriptPath ?? (ref ? findRolloutById(ref.id) : undefined);
    if (!p) return null;
    return codexQuotaFromRollout(p);
  },
  quotaPatterns: [/you['’]ve hit your usage limit/i, /usage limit reached/i],
  apiKeyEnv: ["OPENAI_API_KEY"],
};

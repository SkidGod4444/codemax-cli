import { StyledText, bg, bold, dim, fg, stringToStyledText, type TextChunk } from "@opentui/core";
import { C } from "./theme.ts";
import { highlightCode, languageOf } from "./highlight.ts";

/**
 * Diffs the way Claude Code draws them: a summary ("Added 2 lines, removed 1 line"), then
 * each line with its number in a gutter. Added and removed lines sit on full-width green and
 * red bands, the words that changed in them on a brighter band (when under 40% of the line
 * changed), added and context lines are syntax-coloured by the file's type, the context
 * gutter is dim, and `...` separates hunks. No `---` / `+++` / `@@` syntax on screen.
 */

export interface DiffRow {
  kind: "summary" | "add" | "del" | "ctx" | "gap" | "note";
  /** Summary, gap and note text. */
  text: string;
  /** Line number (gutter) and code, for add / del / ctx. */
  num?: string;
  code?: string;
  /** Character ranges of the words that changed (add / del). */
  words?: [number, number][];
  /** The file's language, for syntax colours. */
  lang?: string;
}

/** Text that is a unified-style diff (as engines and the permission prompt carry it). */
export function isDiff(text: string): boolean {
  return (/^@@/m.test(text) && /^[-+]/m.test(text)) || (/^--- /m.test(text) && /^\+\+\+ /m.test(text));
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "src/app.tsx" → "typescript", when the extension names a language codemax can colour. */
function langOfPath(path: string): string | undefined {
  const ext = path.match(/\.([A-Za-z0-9+]+)$/)?.[1];
  return ext ? languageOf(ext) : undefined;
}

export function diffRows(text: string): DiffRow[] {
  const lines = text.replace(/\n+$/, "").split("\n");
  type File = { name: string; created: boolean; deleted: boolean; lines: string[] };
  const files: File[] = [];
  let cur: File | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const from = l.slice(4).trim().replace(/^a\//, "");
      const to = lines[i + 1]!.slice(4).trim().replace(/^b\//, "");
      cur = { name: to === "/dev/null" ? from : to, created: from === "/dev/null", deleted: to === "/dev/null", lines: [] };
      files.push(cur);
      i++;
      continue;
    }
    if (/^diff --git /.test(l) || /^index [0-9a-f]+\.\.[0-9a-f]+/.test(l)) continue;
    if (!cur) {
      cur = { name: "", created: false, deleted: false, lines: [] };
      files.push(cur);
    }
    cur.lines.push(l);
  }
  let width = 1;
  for (const f of files) for (const l of f.lines) {
    const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/) ?? l.match(/^@@ line (\d+) @@/);
    if (m) width = Math.max(width, String(Number(m[3] ?? m[1]) + Number(m[4] ?? m[2] ?? 0) + f.lines.length).length);
  }
  const out: DiffRow[] = [];
  for (const f of files) {
    const adds = f.lines.filter((l) => l.startsWith("+")).length;
    const dels = f.lines.filter((l) => l.startsWith("-")).length;
    // Claude Code's wording; with several files, each names its file.
    const what = !adds && !dels ? "No changes" : adds ? `Added ${plural(adds, "line")}${dels ? `, removed ${plural(dels, "line")}` : ""}` : `Removed ${plural(dels, "line")}`;
    if (f.name && files.length > 1) out.push({ kind: "summary", text: `${f.name} · ${what}` });
    else out.push({ kind: "summary", text: what });
    const lang = langOfPath(f.name);
    let oldN = 1, newN = 1, hunks = 0;
    const body: DiffRow[] = [];
    for (const l of f.lines) {
      const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      const h2 = l.match(/^@@ line (\d+) @@/);
      if (h || h2) {
        oldN = Number(h ? h[1] : h2![1]);
        newN = Number(h ? h[2] : h2![1]);
        if (hunks++ > 0) body.push({ kind: "gap", text: "..." });
        continue;
      }
      if (l.startsWith("\\")) continue; // "\ No newline at end of file"
      const pad = (n: number) => String(n).padStart(width);
      if (l.startsWith("+")) body.push({ kind: "add", text: "", num: pad(newN++), code: l.slice(1), lang });
      else if (l.startsWith("-")) body.push({ kind: "del", text: "", num: pad(oldN++), code: l.slice(1), lang });
      else if (l.startsWith(" ") || l === "") {
        body.push({ kind: "ctx", text: "", num: pad(newN), code: l.slice(1), lang });
        oldN++;
        newN++;
      } else body.push({ kind: "note", text: l });
    }
    markWords(body);
    out.push(...body);
  }
  return out;
}

/** Words, runs of spaces, or single characters: what a word-level change is made of. */
const tokens = (s: string) => s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];

/**
 * Mark the words that changed in each removed line and the added line paired with it (a run
 * of `-` lines followed by a run of `+` lines pairs up in order), as Claude Code does. Lines
 * that changed by more than 40% are left whole.
 */
function markWords(rows: DiffRow[]) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind !== "del") continue;
    let d = i;
    while (d < rows.length && rows[d]!.kind === "del") d++;
    let a = d;
    while (a < rows.length && rows[a]!.kind === "add") a++;
    const dels = rows.slice(i, d), adds = rows.slice(d, a);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const [x, y] = [dels[k]!, adds[k]!];
      const tx = tokens(x.code ?? ""), ty = tokens(y.code ?? "");
      if (tx.length * ty.length > 40_000) continue;
      // Longest common subsequence of tokens.
      const L: number[][] = Array.from({ length: tx.length + 1 }, () => new Array(ty.length + 1).fill(0));
      for (let p = tx.length - 1; p >= 0; p--) for (let q = ty.length - 1; q >= 0; q--) L[p]![q] = tx[p] === ty[q] ? L[p + 1]![q + 1]! + 1 : Math.max(L[p + 1]![q]!, L[p]![q + 1]!);
      const keepX = new Set<number>(), keepY = new Set<number>();
      for (let p = 0, q = 0; p < tx.length && q < ty.length; ) {
        if (tx[p] === ty[q]) {
          keepX.add(p++);
          keepY.add(q++);
        } else if (L[p + 1]![q]! >= L[p]![q + 1]!) p++;
        else q++;
      }
      const ranges = (t: string[], keep: Set<number>) => {
        const r: [number, number][] = [];
        let pos = 0;
        t.forEach((tok, idx) => {
          if (!keep.has(idx) && tok.trim()) {
            const last = r[r.length - 1];
            if (last && last[1] === pos) last[1] = pos + tok.length;
            else r.push([pos, pos + tok.length]);
          }
          pos += tok.length;
        });
        return r;
      };
      const changed = (t: string[], keep: Set<number>) => t.filter((tok, idx) => !keep.has(idx) && tok.trim()).join("").length;
      const total = Math.max((x.code ?? "").replace(/\s/g, "").length, (y.code ?? "").replace(/\s/g, "").length, 1);
      if (Math.max(changed(tx, keepX), changed(ty, keepY)) / total > 0.4) continue;
      x.words = ranges(tx, keepX);
      y.words = ranges(ty, keepY);
    }
    i = a - 1;
  }
}

/**
 * Coloured rows. With `width`, added and removed lines are padded so their band spans the
 * line (in a box that wide); without it the band covers the text only.
 */
export function styleDiffRows(rows: DiffRow[], width?: number): StyledText {
  const chunks: TextChunk[] = [];
  const nl = () => chunks.push(...stringToStyledText("\n").chunks);
  rows.forEach((r, i) => {
    if (r.kind === "summary") chunks.push(...summaryChunks(r.text));
    else if (r.kind === "gap" || r.kind === "note") chunks.push(dim(r.text));
    else if (r.kind === "ctx") {
      chunks.push(dim(`${r.num}   `), ...codeChunks(r.code ?? "", r.lang));
    } else {
      const add = r.kind === "add";
      const band = add ? C.diffAddBg : C.diffDelBg;
      const word = add ? C.diffAddWord : C.diffDelWord;
      const code = r.code ?? "";
      const lead = `${r.num} `;
      const sign = add ? "+" : "-";
      const line: TextChunk[] = [bg(band)(lead), bg(band)(fg(add ? C.diffAdd : C.diffDel)(`${sign} `))];
      // Removed lines are not syntax-coloured (Claude Code's rule); added lines are.
      const colored = add ? codeChunks(code, r.lang) : stringToStyledText(code).chunks;
      line.push(...applyBands(colored, band, word, r.words ?? []));
      const used = lead.length + 2 + code.length;
      if (width && used < width) line.push(bg(band)(" ".repeat(width - used)));
      chunks.push(...line);
    }
    if (i < rows.length - 1) nl();
  });
  return new StyledText(chunks);
}

/** "Added 2 lines, removed 1 line" with the counts in bold. */
function summaryChunks(text: string): TextChunk[] {
  const out: TextChunk[] = [];
  let last = 0;
  for (const m of text.matchAll(/\d+/g)) {
    if (m.index! > last) out.push(...stringToStyledText(text.slice(last, m.index)).chunks);
    out.push(bold(m[0]));
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(...stringToStyledText(text.slice(last)).chunks);
  return out;
}

function codeChunks(code: string, lang?: string): TextChunk[] {
  return lang ? highlightCode(code, lang).filter((c) => c.text !== "\n") : stringToStyledText(code).chunks;
}

/** Put the line's band behind every chunk, and the brighter word band behind the changed ranges. */
function applyBands(chunks: TextChunk[], band: string, word: string, ranges: [number, number][]): TextChunk[] {
  const out: TextChunk[] = [];
  let pos = 0;
  for (const c of chunks) {
    let start = 0;
    const text = c.text;
    const cuts = new Set<number>([0, text.length]);
    for (const [a, b] of ranges) {
      if (a > pos && a < pos + text.length) cuts.add(a - pos);
      if (b > pos && b < pos + text.length) cuts.add(b - pos);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k < points.length - 1; k++) {
      start = points[k]!;
      const end = points[k + 1]!;
      const abs = pos + start;
      const inWord = ranges.some(([a, b]) => abs >= a && abs < b);
      out.push(bg(inWord ? word : band)({ ...c, text: text.slice(start, end) } as TextChunk));
    }
    pos += text.length;
  }
  return out;
}

/** A diff as shown collapsed: its summary lines and the first changed lines. */
export function collapsedDiff(rows: DiffRow[], keep = 6): DiffRow[] {
  const changes = rows.filter((r) => r.kind !== "summary");
  if (changes.length <= keep) return rows;
  const shown: DiffRow[] = [];
  let n = 0;
  for (const r of rows) {
    if (r.kind === "summary") shown.push(r);
    else if (n++ < keep) shown.push(r);
  }
  shown.push({ kind: "note", text: `… +${changes.length - keep} lines (ctrl+o to expand)` });
  return shown;
}

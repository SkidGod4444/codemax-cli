import { StyledText, bold, dim, fg, italic, stringToStyledText, underline, type TextChunk } from "@opentui/core";
import { C } from "./theme.ts";
import { diffRows, isDiff, styleDiffRows } from "./diffview.ts";
import { highlightCode, languageOf } from "./highlight.ts";

const plain = (s: string): TextChunk[] => (s ? stringToStyledText(s).chunks : []);

/**
 * Markdown for streamed agent text, the way Claude Code shows it, done without a parser so it
 * is cheap to re-run on every append: h1 bold, italic and underlined, other headings bold,
 * `code` in lavender, **bold**, *italic*, links, "-" bullets, numbered lists, quotes, and
 * fenced code highlighted by language (no rules, no background; a language highlight.js
 * does not know is named once, dimmed, and shown in one colour). Diffs in a fence read as diffs.
 * Tables (a header row, a `|---|` row, then rows) are drawn with box lines the way Claude Code
 * draws them; `width` (the columns available) wraps cells so the box never breaks.
 */
export function styleMarkdown(text: string, width?: number): StyledText {
  text = text.replace(/\r\n?/g, "\n");
  const chunks: TextChunk[] = [];
  const lines = text.split("\n");
  let fence: { lang: string; lines: string[] } | null = null;
  let table: string[] | null = null;
  const flushTable = () => {
    if (!table) return;
    chunks.push(...styleTable(table, width));
    table = null;
  };
  const nl = () => chunks.push(...plain("\n"));
  const flushFence = () => {
    if (!fence) return;
    const code = fence.lines.join("\n");
    if (fence.lang && !languageOf(fence.lang) && !/^(diff|patch)$/i.test(fence.lang)) {
      chunks.push(dim(fence.lang));
      nl();
    }
    if (isDiff(code) || /^(diff|patch)$/i.test(fence.lang)) chunks.push(...styleDiffRows(diffRows(code)).chunks);
    else chunks.push(...highlightCode(code, fence.lang));
    fence = null;
  };
  lines.forEach((line, i) => {
    if (!fence && table) {
      // A table runs until a line that is not a row (a partial last row, still streaming, belongs to it).
      if (/^\s*\|/.test(line) || / \| /.test(line)) {
        table.push(line);
        if (i === lines.length - 1) flushTable();
        return;
      }
      flushTable();
      nl();
    }
    if (/^\s*```/.test(line)) {
      if (fence) {
        flushFence();
      } else {
        fence = { lang: line.replace(/^\s*```/, "").trim(), lines: [] };
        return;
      }
    } else if (fence) {
      fence.lines.push(line);
      return;
    } else if (!table && /\|/.test(line) && isSeparatorRow(lines[i + 1] ?? "")) {
      // A header row with its `|---|` line under it: a table begins (before the separator arrives it is text).
      table = [line];
      return;
    } else if (/^#\s/.test(line)) {
      chunks.push(bold(italic(underline(line.replace(/^#\s+/, "")))));
    } else if (/^#{2,6}\s/.test(line)) {
      chunks.push(bold(line.replace(/^#{2,6}\s+/, "")));
    } else if (/^\s*(-{3,}|\*{3,}|_{3,}|(\*\s*){3,}|(-\s*){3,})\s*$/.test(line)) {
      // A rule before a bullet: "* * *" and "- - -" are rules.
      chunks.push(dim("---"));
    } else if (/^\s*[-*•+]\s+/.test(line)) {
      const m = line.match(/^(\s*)[-*•+]\s+(.*)$/)!;
      chunks.push(...plain(`${m[1]}- `), ...inline(m[2]!));
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      const m = line.match(/^(\s*\d+[.)]\s+)(.*)$/)!;
      chunks.push(...plain(m[1]!), ...inline(m[2]!));
    } else if (/^\s*>(\s|$)/.test(line)) {
      chunks.push(dim("▎ "), ...inline(line.replace(/^\s*>\s?/, "")).map((c) => ({ ...c, attributes: (c.attributes ?? 0) | 2 })));
    } else {
      chunks.push(...inline(line));
    }
    if (i < lines.length - 1) nl();
  });
  // A block still streaming in: colour what has arrived.
  flushFence();
  flushTable();
  return new StyledText(chunks.length ? chunks : plain(""));
}

const isSeparatorRow = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && /-/.test(line);

/** The cells of a table row: split on unescaped pipes, the outer pipes dropped. */
function cells(row: string): string[] {
  const out = row.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/);
  return out.map((c) => c.trim().replace(/\\\|/g, "|"));
}

const widthOf = (chunks: TextChunk[]) => chunks.reduce((n, c) => n + Bun.stringWidth(c.text), 0);

/** Word-wrap styled text to `w` columns, each word keeping its style (long words are cut). */
function wrapChunks(chunks: TextChunk[], w: number): TextChunk[][] {
  const lines: TextChunk[][] = [];
  let line: TextChunk[] = [];
  let col = 0;
  const push = (c: TextChunk) => {
    line.push(c);
    col += Bun.stringWidth(c.text);
  };
  const flush = () => {
    while (line.length && /^\s+$/.test(line.at(-1)!.text)) line.pop();
    lines.push(line);
    line = [];
    col = 0;
  };
  for (const c of chunks) {
    for (const tok of c.text.split(/(\s+)/).filter(Boolean)) {
      const piece = { ...c, text: tok };
      if (/^\s+$/.test(tok)) {
        if (col) push(piece);
        continue;
      }
      let tw = Bun.stringWidth(tok);
      if (col && col + tw > w) flush();
      // A word wider than the column is cut.
      while (tw > w) {
        let cut = tok.length;
        while (cut > 1 && Bun.stringWidth(piece.text.slice(0, cut)) > w) cut--;
        push({ ...c, text: piece.text.slice(0, cut) });
        piece.text = piece.text.slice(cut);
        tw = Bun.stringWidth(piece.text);
        flush();
      }
      if (piece.text) push(piece);
    }
  }
  flush();
  return lines.length ? lines : [[]];
}

/**
 * A Markdown table as Claude Code draws it: box lines in the text colour, the header bold and
 * centred, cells padded by one space, inline Markdown inside the cells. Columns wider than the
 * room (`width`) wrap their cells, widest first, so the box always fits.
 */
function styleTable(rows: string[], width?: number): TextChunk[] {
  const header = cells(rows[0]!);
  const aligns = cells(rows[1] ?? "").map((c) => (/^:-+:$/.test(c) ? "center" : /^-+:$/.test(c) ? "right" : "left"));
  const body = rows.slice(2).map(cells);
  const cols = Math.max(header.length, ...body.map((r) => r.length));
  const styled = (r: string[], c: number, head: boolean) => {
    const text = (r[c] ?? "").replace(/<br\s*\/?>/gi, " ");
    return head ? [bold(text)] : inline(text);
  };
  const all = [[header, true] as const, ...body.map((r) => [r, false] as const)];
  const widths = Array.from({ length: cols }, (_, c) => Math.max(1, ...all.map(([r, head]) => Math.max(0, ...wrapChunks(styled(r, c, head), 10_000).map(widthOf)))));
  // Room for the cells: the box takes one border per column plus one, and two spaces of padding per cell.
  const room = width ? width - (cols + 1) - cols * 2 : Infinity;
  while (widths.reduce((a, b) => a + b, 0) > room) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i]! <= 3) break;
    widths[i]!--;
  }
  const out: TextChunk[] = [];
  const rule = (l: string, m: string, r: string) => out.push(...plain(`${l}${widths.map((w) => "─".repeat(w + 2)).join(m)}${r}`));
  const drawRow = (r: string[], head: boolean) => {
    const lines = widths.map((w, c) => wrapChunks(styled(r, c, head), w));
    const h = Math.max(...lines.map((l) => l.length));
    for (let k = 0; k < h; k++) {
      out.push(...plain("│"));
      widths.forEach((w, c) => {
        const chunks = lines[c]![k] ?? [];
        const pad = Math.max(0, w - widthOf(chunks));
        const align = head ? "center" : aligns[c] ?? "left";
        const left = align === "center" ? Math.floor(pad / 2) : align === "right" ? pad : 0;
        out.push(...plain(` ${" ".repeat(left)}`), ...chunks, ...plain(`${" ".repeat(pad - left)} │`));
      });
      out.push(...plain("\n"));
    }
  };
  rule("┌", "┬", "┐");
  out.push(...plain("\n"));
  drawRow(header, true);
  body.forEach((r) => {
    rule("├", "┼", "┤");
    out.push(...plain("\n"));
    drawRow(r, false);
  });
  rule("└", "┴", "┘");
  return out;
}

/** Inline Markdown only (code spans, bold, italic, links): for one line, such as your own message. */
export function styleInline(s: string): TextChunk[] {
  return inline(s);
}

/** Inline: `code`, **bold**, *italic*, [links](url). */
function inline(s: string): TextChunk[] {
  const out: TextChunk[] = [];
  // *italic* only when the asterisks are not inside a word or a path: "src/*.ts" and "*args" stay as typed.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|((?<![\w*/])\*(?![\s*])[^*\n]+?(?<![\s*/])\*(?![\w*]))|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(...plain(s.slice(last, m.index)));
    if (m[1]) out.push(fg(C.code)(m[1].slice(1, -1)));
    else if (m[2]) out.push(bold(m[2].slice(2, -2)));
    else if (m[3]) out.push(italic(m[3].slice(1, -1)));
    else if (m[4]) {
      // A real link (OSC 8): clickable in terminals that support it, like Claude Code's.
      const [, label, url] = m[4].match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push({ ...fg(C.link)(label!), link: { url: url! } });
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(...plain(s.slice(last)));
  return out;
}

/** Tool output: colour diff lines, dim the rest. */
export function styleToolOutput(text: string): StyledText {
  text = text.replace(/\r\n?/g, "\n");
  if (isDiff(text)) return styleDiffRows(diffRows(text));
  const chunks: TextChunk[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/^\+(?!\+\+)/.test(line)) chunks.push(fg(C.diffAdd)(line));
    else if (/^-(?!--)/.test(line)) chunks.push(fg(C.diffDel)(line));
    else if (/^@@/.test(line)) chunks.push(fg(C.accent)(line));
    else chunks.push(dim(line));
    if (i < lines.length - 1) chunks.push(...plain("\n"));
  });
  return new StyledText(chunks.length ? chunks : plain(""));
}

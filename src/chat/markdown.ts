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
 */
export function styleMarkdown(text: string): StyledText {
  text = text.replace(/\r\n?/g, "\n");
  const chunks: TextChunk[] = [];
  const lines = text.split("\n");
  let fence: { lang: string; lines: string[] } | null = null;
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
  return new StyledText(chunks.length ? chunks : plain(""));
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

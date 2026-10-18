import { StyledText, bold, dim, fg, italic, stringToStyledText, type TextChunk } from "@opentui/core";
import { C } from "./theme.ts";

const plain = (s: string): TextChunk[] => (s ? stringToStyledText(s).chunks : []);

/**
 * Minimal markdown styling for streamed agent text, done without a parser so it
 * is cheap to re-run on every append: headings bold, `code` dimmed with an
 * accent, **bold**, *italic*, bullets normalised, fenced code blocks indented
 * and dimmed, and unified-diff lines coloured.
 */
export function styleMarkdown(text: string): StyledText {
  const chunks: TextChunk[] = [];
  const lines = text.split("\n");
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      const lang = line.replace(/^\s*```/, "").trim();
      chunks.push(dim(lang ? `── ${lang} ──` : "──"));
    } else if (inFence) {
      chunks.push(...diffOrCode(line));
    } else if (/^#{1,6}\s/.test(line)) {
      chunks.push(bold(line.replace(/^#{1,6}\s+/, "")));
    } else if (/^\s*[-*•]\s+/.test(line)) {
      const m = line.match(/^(\s*)[-*•]\s+(.*)$/)!;
      chunks.push(plain(`${m[1]}• `)[0]!, ...inline(m[2]!));
    } else if (/^\s*\d+\.\s+/.test(line)) {
      const m = line.match(/^(\s*\d+\.\s+)(.*)$/)!;
      chunks.push(dim(m[1]!), ...inline(m[2]!));
    } else if (/^\s*>\s?/.test(line)) {
      chunks.push(dim("│ "), ...inline(line.replace(/^\s*>\s?/, "")).map((c) => c));
    } else {
      chunks.push(...inline(line));
    }
    if (i < lines.length - 1) chunks.push(...plain("\n"));
  });
  return new StyledText(chunks.length ? chunks : plain(""));
}

function diffOrCode(line: string): TextChunk[] {
  if (/^\+(?!\+\+)/.test(line)) return [fg(C.diffAdd)(`  ${line}`)];
  if (/^-(?!--)/.test(line)) return [fg(C.diffDel)(`  ${line}`)];
  if (/^@@/.test(line)) return [fg(C.accent)(`  ${line}`)];
  return [dim(`  ${line}`)];
}

/** Inline: `code`, **bold**, *italic*. */
function inline(s: string): TextChunk[] {
  const out: TextChunk[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(...plain(s.slice(last, m.index)));
    if (m[1]) out.push(fg(C.accent)(m[1].slice(1, -1)));
    else if (m[2]) out.push(bold(m[2].slice(2, -2)));
    else if (m[3]) out.push(italic(m[3].slice(1, -1)));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(...plain(s.slice(last)));
  return out;
}

/** Tool output: colour diff lines, dim the rest. */
export function styleToolOutput(text: string): StyledText {
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

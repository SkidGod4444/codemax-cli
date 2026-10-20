import hljs from "highlight.js/lib/common";
import { fg, stringToStyledText, type TextChunk } from "@opentui/core";
import { C } from "./theme.ts";

/**
 * Code blocks coloured the way Claude Code colours them: highlight.js tokens with the
 * Monokai Extended (dark) or GitHub (light) palette from the theme (`C.syntax`). Code in a
 * language highlight.js does not know is shown in one colour (`C.code`).
 */

const ALIASES: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", rb: "ruby", yml: "yaml", md: "markdown", rs: "rust", golang: "go", kt: "kotlin", "c++": "cpp", "c#": "csharp", cs: "csharp", ps1: "powershell" };

/** Words Monokai paints as storage (declarations), not as plain keywords. */
const STORAGE = new Set(["const", "let", "var", "function", "fn", "def", "class", "interface", "type", "struct", "enum", "impl", "trait", "func", "async", "static", "public", "private", "protected", "export", "import", "from", "package", "module"]);

export function languageOf(lang: string): string | undefined {
  const l = lang.trim().toLowerCase().split(/[\s{]/)[0] ?? "";
  // Own keys only: a fence labelled "constructor" or "__proto__" must not reach Object's.
  const name = Object.hasOwn(ALIASES, l) ? ALIASES[l]! : l;
  if (!name || !/^[a-z0-9+#._-]+$/.test(name)) return undefined;
  try {
    return hljs.getLanguage(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m);

/** The colour for a highlight.js class list ("hljs-title function_" → title). */
function colourFor(classes: string[], text: string): string | undefined {
  for (const cls of [...classes].reverse()) {
    const name = cls.replace(/^hljs-/, "").split(/[\s.]/)[0]!.replace(/_$/, "");
    if (name === "keyword" && STORAGE.has(text.trim())) return C.syntax.storage;
    const c = Object.hasOwn(C.syntax, name) ? C.syntax[name] : undefined;
    if (c) return c;
  }
  return undefined;
}

/**
 * Code is highlighted in pieces of PIECE_LINES lines, each cached by its text: while a reply
 * streams, its code is styled again every 80 ms, and highlighting a long block whole each time
 * (about 60 µs a line) blocked typing for tens of milliseconds. Now only the last, still
 * growing piece is new work. A construct spanning a piece boundary (a long block comment) may
 * be coloured as code after it; that is the price of smooth typing.
 */
const PIECE_LINES = 40;
const CACHE_MAX = 3000;
const cache = new Map<string, TextChunk[]>();

/** Highlighted chunks for a block of code; line breaks are plain chunks (coloured ones are not laid out). */
export function highlightCode(code: string, lang: string): TextChunk[] {
  const lines = code.split("\n");
  if (lines.length <= PIECE_LINES) return cached(code, lang);
  const out: TextChunk[] = [];
  for (let i = 0; i < lines.length; i += PIECE_LINES) {
    if (i > 0) out.push(...stringToStyledText("\n").chunks);
    out.push(...cached(lines.slice(i, i + PIECE_LINES).join("\n"), lang));
  }
  return out;
}

function cached(code: string, lang: string): TextChunk[] {
  // The palette is part of the key: a theme switch must not reuse old colours.
  const key = `${lang}\u0000${C.syntax.keyword}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
    return hit;
  }
  const chunks = highlightPiece(code, lang);
  cache.set(key, chunks);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return chunks;
}

function highlightPiece(code: string, lang: string): TextChunk[] {
  const language = languageOf(lang);
  const out: TextChunk[] = [];
  const push = (text: string, colour: string | undefined) => {
    text.split("\n").forEach((part, i) => {
      if (i > 0) out.push(...stringToStyledText("\n").chunks);
      if (part) out.push(colour ? fg(colour)(part) : fg(C.syntax.punctuation ?? C.code)(part));
    });
  };
  if (!language) {
    push(code, C.code);
    return out;
  }
  let html: string;
  try {
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    push(code, C.code);
    return out;
  }
  const stack: string[] = [];
  for (const m of html.matchAll(/<span class="([^"]+)">|<\/span>|[^<]+/g)) {
    if (m[1]) stack.push(m[1]);
    else if (m[0] === "</span>") stack.pop();
    else {
      const text = decode(m[0]);
      push(text, colourFor(stack, text));
    }
  }
  return out;
}

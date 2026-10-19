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
  const name = ALIASES[l] ?? l;
  return name && hljs.getLanguage(name) ? name : undefined;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m);

/** The colour for a highlight.js class list ("hljs-title function_" → title). */
function colourFor(classes: string[], text: string): string | undefined {
  for (const cls of [...classes].reverse()) {
    const name = cls.replace(/^hljs-/, "").split(/[\s.]/)[0]!.replace(/_$/, "");
    if (name === "keyword" && STORAGE.has(text.trim())) return C.syntax.storage;
    const c = C.syntax[name];
    if (c) return c;
  }
  return undefined;
}

/** Highlighted chunks for a block of code; line breaks are plain chunks (coloured ones are not laid out). */
export function highlightCode(code: string, lang: string): TextChunk[] {
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

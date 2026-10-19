import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute } from "node:path";

/**
 * Drag and drop into the prompt. Terminals paste a dropped file as its path: escaped
 * (`/Users/me/My\ Shot.png`, Terminal.app, iTerm2, Ghostty), quoted (`'/Users/me/My Shot.png'`,
 * VS Code, Warp) or as a file:// URL, several files separated by spaces. When everything
 * pasted is such a path to an existing file, it is an attachment, not text.
 */

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** The image type for a path codemax can send to an agent, or undefined. */
export function imageType(path: string): string | undefined {
  return IMAGE_TYPES[extname(path).toLowerCase()];
}

/** Split pasted text the way a shell would: quotes, backslash escapes, file:// URLs. */
export function splitDropped(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let any = false;
  const t = text.trim();
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < t.length) cur += t[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      any = true;
    } else if (c === "\\" && i + 1 < t.length && process.platform !== "win32") {
      cur += t[++i];
      any = true;
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (cur || any) out.push(cur);
  return out.map((p) => {
    if (/^file:\/\//i.test(p)) {
      try {
        return decodeURIComponent(new URL(p).pathname).replace(/^\/([A-Za-z]:)/, "$1");
      } catch {
        return p;
      }
    }
    return p.startsWith("~/") ? homedir() + p.slice(1) : p;
  });
}

/**
 * The files a paste is made of, when it is only paths to existing files (a drop); null for
 * ordinary text (a path inside a sentence stays text).
 */
export function droppedFiles(text: string, isFile: (p: string) => boolean = defaultIsFile): string[] | null {
  // A drop is short: a few paths, one per space or line.
  if (!text.trim() || text.length > 8000) return null;
  const paths = splitDropped(text);
  if (!paths.length || paths.some((p) => !isAbsolute(p) || !isFile(p))) return null;
  return paths;
}

function defaultIsFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A dropped file's text for the message (30 KB at most); binary files are named, not attached. */
export function droppedContents(path: string, max = 30_000): string {
  try {
    const buf = readFileSync(path);
    if (buf.subarray(0, 8000).includes(0)) return " (binary file, not attached; it is on disk if the agent can open it)";
    const text = buf.toString("utf8");
    return `\n--- ${path} ---\n${text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters not attached` : text}\n--- end ---`;
  } catch (e: any) {
    return ` (could not read it: ${e?.message ?? e})`;
  }
}

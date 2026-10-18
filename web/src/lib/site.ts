/** One place for the facts every page, crawler and share card needs. */
/** Production address; NEXT_PUBLIC_SITE_URL overrides it (for previews or a new domain). */
const DEFAULT_URL = "https://codemax.saidev.codes";

export const SITE = {
  url: (process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_URL).replace(/\/$/, ""),
  name: "codemax",
  title: "codemax — every AI coding plan you pay for, one terminal",
  shortTitle: "Every AI coding plan you pay for. One terminal.",
  description:
    "Use Claude Code, Codex, OpenCode, Grok and Cursor from one terminal. When one hits its usage limit, the next finishes your task with the same context. Uses only the subscriptions you already pay for. Free and open source.",
  repo: "https://github.com/SkidGod4444/codemax-cli",
  /** Short link for every "GitHub" button on the site; redirects to `repo`. */
  github: "https://ref.saidev.codes/codemax",
  author: { name: "Saidev Dhal", url: "https://saidev.codes" },
  keywords: [
    "codemax",
    "AI coding agent",
    "coding agent CLI",
    "Claude Code",
    "Codex CLI",
    "OpenCode",
    "Grok CLI",
    "Antigravity CLI",
    "Gemini CLI",
    "usage limit",
    "AI subscription",
    "multi-agent terminal",
    "agent harness",
    "open source developer tool",
  ],
  pink: "#ff5c8d",
  /** The installer script in the repo; the site's /install redirects here. */
  installScript: "https://raw.githubusercontent.com/SkidGod4444/codemax-cli/main/install.sh",
  installScriptWindows: "https://raw.githubusercontent.com/SkidGod4444/codemax-cli/main/install.ps1",
} as const;

/**
 * What users paste into their terminal: the npm package works the same on macOS,
 * Linux and Windows and brings its own Bun. (The script installers stay available
 * at /install and /install.ps1.)
 */
const NPM_INSTALL = "npm install -g codemax-cli";
export const INSTALL_COMMANDS = { unix: NPM_INSTALL, windows: NPM_INSTALL } as const;

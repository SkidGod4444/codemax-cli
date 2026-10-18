# codemax-cli

One terminal for every coding agent the user pays for. codemax drives Claude Code, Codex, OpenCode, Grok and Gemini CLI from one chat UI, keeps one conversation and project history across them, and hands the task to the next agent when one runs out of quota.

## Commands

```sh
bun install
bun run dev            # run the CLI from source (same as `codemax` after `bun link`)
bun test               # all tests; no logins, no network, no quota
bun test test/x.test.ts
bun run typecheck
bun run build          # dist/codemax, re-signed on macOS

cd web && bun run dev  # landing page on http://localhost:3000
cd web && bun run lint && bunx tsc --noEmit && bun run build
```

## Layout

- `src/cli.ts` entry and subcommands. `src/config.ts` reads `~/.codemax/config.json`.
- `src/engines/` one engine per agent protocol, all emitting one normalized event stream (`types.ts`). `acp.ts` is the generic ACP client (Claude via `@zed-industries/claude-code-acp`, OpenCode, Grok, Gemini). `codex.ts` speaks native `codex app-server` JSON-RPC. `env.ts` builds every agent's environment.
- `src/chat/` the OpenTUI chat UI: transcript, slash palette, permission dialog, markdown and diff styling, theme.
- `src/core/` ledger, handoff brief, usage and pricing, budgets, checkpoints, `@file`, doctor, quota.
- `src/tui/`, `src/adapters/`, `src/transcripts/` the embedded-terminal fallback (`codemax --tui`, `--raw`) and transcript tailing for agents without a protocol.
- `test/` runs the real `ChatApp` in OpenTUI's test renderer against scripted fake ACP agents. `test/setup.ts` (bunfig preload) gives each file its own `CODEMAX_HOME`.
- `install.sh` the one-line installer (`curl … | bash`): clones the newest release tag into `~/.codemax/cli`, installs Bun if asked, links `codemax` into `~/.bun/bin`. The site's `/install` redirects to it. Test it with a temp `HOME` and `CODEMAX_REPO=$PWD`.
- `web/` the Next.js landing page. Read `web/AGENTS.md` first: this Next.js version differs from older ones, and its docs are in `web/node_modules/next/dist/docs/`.

## Rules that never bend

These come straight from the project owner. Do not offer options that weaken them.

- **No one-shot headless modes.** Never drive agents with `claude -p`, `codex exec`, `opencode run` and similar. They auto-approve and drop permission prompts. Agents run only over interactive protocols (ACP, Codex app-server) where permission requests reach the user.
- **Subscriptions only.** `src/engines/env.ts` always strips vendor API-key variables. There is no opt-out. `codemax doctor --fix` removes keys from `~/.claude/settings.json`.
- **No auto-approval.** Every new engine maps the agent's approval requests to `permission_request` events.
- **Never touch the user's git state.** Checkpoints use a private index and `refs/codemax/checkpoints`.
- Commit or push only when the user says "push".
- **License is AGPL-3.0-only** plus a section 7 permission in `NOTICE` for the non-free agent SDKs and CLIs codemax drives (for example `@anthropic-ai/claude-agent-sdk`). The name and logo are governed by `TRADEMARKS.md`. Check a new dependency's license before adding it. Outside contributions need a signed `CLA.md` (checked by `.github/workflows/cla.yml`); never merge an outside pull request while that check is red.
- **Users install release tags, not `main`.** `install.sh` picks the newest `vX.Y.Z` tag (falls back to `main` only before the first release). Pushing to `main` ships nothing; releasing does. To release, when the user asks: bump `version` in `package.json`, commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.

## Design decisions

| Decision | Why |
|---|---|
| codemax owns the UI; agents are engines (since v0.3) | One consistent chat, native ledger of every turn, handoffs without terminal-state bugs. `PLAN.md`'s opening "wrap the real TUIs" section is history; that path survives only as `--tui` and `--raw`. |
| OpenTUI for the terminal UI | Bun-native, embedded terminal (Ghostty VT) for the fallback pane; Ink has none. |
| Codex via its own app-server, not the ACP adapter | The community adapter rejects ChatGPT-plan models. |
| Claude via the Zed ACP adapter with `CLAUDE_CODE_EXECUTABLE` | Runs the user's own installed `claude` and login. |
| OpenCode gets an inline "ask" permission config | Otherwise it acts without asking. |
| Grok inherits Claude Code's permission mode | Its own behavior; codemax warns when that mode is `auto`. |
| Handoff = brief from the ledger (summary, recent turns, commits, diff stat, unfinished request) | Context survives switching agents without vendor cooperation. |
| Usage priced at public API rates, frozen per record | Shows the value a flat subscription covered; later price changes never rewrite history. Prices from OpenRouter, LiteLLM fallback, weekly. |
| UI follows Claude Code's idiom (`❯`, `⏺`, `⎿`, its permission wording) | Familiar to the main audience. Rules in `docs/claude-code-ui-rules.md`. Letters never pick a permission option. |

## Landing page (`web/`)

- Next.js 16 (Turbopack, cache components), Tailwind 4, coss ui components from the `@coss` shadcn registry, Base UI.
- Brand: pink `#ff5c8d` and white bands, plum `#3a0d25` ink on white. Fonts: Instrument Serif (headlines), Inter Tight (body), JetBrains Mono (labels).
- Each `Band` takes `tone="pink" | "white"`. The `.tone-*` classes in `globals.css` set CSS variables (`--ink`, `--line`, `--label`…), so components use `var(--…)` and work on either tone. Do not hard-code white or plum inside bands.
- Everything sits on one 4-column grid (25 / 50 / 75 %), so vertical lines run straight down the page. Two-column sections split 50/50. Keep new sections on this grid.
- Quilted look: `.quilt` on a grid gives each child cell pillow shading and an inset stitch line; `.tuft` buttons mark where seams cross (`Cross`, `Marks`). Children with `aria-hidden` or `data-overlay` are skipped.
- Art is original: `src/lib/ascii/render3d.ts` ray-marches signed-distance scenes, and `src/components/AsciiArt.tsx` draws them as a halftone glyph ramp with a reveal, pointer orbit and cursor lens. Reduced motion gets a still frame. Logo = the halftone wordmark (`src/lib/wordmark.ts`, `Logo.tsx`).
- The "why" terminal (`TerminalDemo.tsx`) is a simulation that runs entirely in the browser. It must stay labeled as simulated.
- Copy explains what users get and why, never how it works inside.
- No visible scrollbars, pointer cursor on everything clickable, no horizontal overflow from 320 px up. The phone nav uses `MobileMenu.tsx`.
- SEO: metadata in `layout.tsx` from `src/lib/site.ts`, plus `robots.ts`, `sitemap.ts`, `manifest.ts`, `opengraph-image.tsx`, `apple-icon.tsx` and JSON-LD in `page.tsx`. The site address is https://codemax.saidev.codes (`src/lib/site.ts`); `NEXT_PUBLIC_SITE_URL` overrides it. Vercel Analytics is mounted in the layout.

## Gotchas

- The `web` dev server often keeps serving the old stylesheet after `globals.css` changes. Restart it with `.next` removed: `pkill -f "next dev"; rm -rf web/.next; cd web && bun run dev`.
- On this Mac, `bun build --compile` output must be re-signed or macOS kills it with exit 137. The build script does it.
- The user's terminal (Warp) swallows Ctrl+/; the working switcher hotkey is Ctrl+^.
- The Open Graph image loads fonts from Google Fonts at render time and falls back to Geist offline, so it renders on demand, not at build.

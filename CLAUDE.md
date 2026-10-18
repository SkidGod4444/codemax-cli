# codemax-cli

One terminal for every coding agent the user pays for. codemax drives Claude Code, Codex, OpenCode, Grok, Cursor and Antigravity CLI (Google's successor to Gemini CLI) from one chat UI, keeps one conversation and project history across them, and hands the task to the next agent when one runs out of quota.

## Commands

```sh
bun install
bun run dev            # run the CLI from source (same as `codemax` after `bun link`)
bun test               # all tests; no logins, no network, no quota
bun test test/x.test.ts
bun run typecheck
bun run build          # dist/codemax, re-signed on macOS
bun scripts/ui-preview.ts <dir>   # colour snapshots (dark + light HTML) of a scripted session

cd web && bun run dev  # landing page on http://localhost:3000
cd web && bun run lint && bunx tsc --noEmit && bun run build
```

## Layout

- `src/cli.ts` entry and subcommands. `src/config.ts` reads `~/.codemax/config.json`.
- `src/engines/` one engine per agent protocol, all emitting one normalized event stream (`types.ts`). `acp.ts` is the generic ACP client (Claude via `@agentclientprotocol/claude-agent-acp` (formerly `@zed-industries/claude-code-acp`), OpenCode, Grok, Gemini). `codex.ts` speaks native `codex app-server` JSON-RPC. `env.ts` builds every agent's environment.
- `src/chat/` the OpenTUI chat UI: transcript, slash palette, permission dialog, markdown and diff styling, theme.
- `src/core/` ledger, handoff brief, usage and pricing, budgets, checkpoints, `@file`, doctor, quota.
- `src/tui/`, `src/adapters/`, `src/transcripts/` the embedded-terminal fallback (`codemax --tui`, `--raw`) and transcript tailing for agents without a protocol.
- `test/` runs the real `ChatApp` in OpenTUI's test renderer against scripted fake ACP agents. `test/setup.ts` (bunfig preload) gives each file its own `CODEMAX_HOME`.
- `install.sh` (macOS/Linux, adds Bun's bin to the shell profile) and `install.ps1` (Windows PowerShell, adds it to the user PATH) are the one-line installers. `install.sh`: clones the newest release tag into `~/.codemax/cli`, installs Bun if asked, links `codemax` into `~/.bun/bin`. The site's `/install` and `/install.ps1` redirect to them. On Windows, agents are launched through `src/core/spawn.ts` (`.cmd` shims via cmd.exe); `--tui`/`--raw` are Unix-only. Install on Windows is CI-tested (`.github/workflows/install.yml`); full agent sessions on Windows are not. Test it with a temp `HOME` and `CODEMAX_REPO=$PWD`.
- `bin/codemax.cjs` is the npm entry (`npm i -g codemax-cli`): a Node launcher that runs `src/cli.ts` with Bun from the matching `@oven/bun-<platform>` optional dependency (npm installs only the one for the machine, with no install script), or a `bun` on PATH. `bin/codemax` (Bun shebang) is what the install scripts link. Published on npm as `codemax-cli` (the site's install box shows `npm install -g codemax-cli`). Publishing needs the owner's `npm publish` with browser 2FA approval; `.github/workflows/npm.yml` tests the package (or, via workflow_dispatch with source=registry, the published one) on macOS, Linux and Windows.
- `web/` the Next.js landing page. Read `web/AGENTS.md` first: this Next.js version differs from older ones, and its docs are in `web/node_modules/next/dist/docs/`.

## Rules that never bend

These come straight from the project owner. Do not offer options that weaken them.

- **No one-shot headless modes.** Never drive agents with `claude -p`, `codex exec`, `opencode run` and similar. They auto-approve and drop permission prompts. Agents run only over interactive protocols (ACP, Codex app-server) where permission requests reach the user.
- **Subscriptions only.** `src/engines/env.ts` always strips vendor API-key variables. There is no opt-out. `codemax doctor --fix` removes keys from `~/.claude/settings.json`.
- **No auto-approval.** Every new engine maps the agent's approval requests to `permission_request` events.
- **Never touch the user's git state.** Checkpoints use a private index and `refs/codemax/checkpoints`.
- Commit or push only when the user says "push".
- **Engines pass tool input, output, diffs and files uncut** (`tool_call` / `tool_update` fields); only the journal caps them. Do not truncate in an engine.
- **License is AGPL-3.0-only** plus a section 7 permission in `NOTICE` for the non-free agent SDKs and CLIs codemax drives (for example `@anthropic-ai/claude-agent-sdk`). The name and logo are governed by `TRADEMARKS.md`. Check a new dependency's license before adding it. Outside contributions need a signed `CLA.md` (checked by `.github/workflows/cla.yml`); never merge an outside pull request while that check is red.
- **Users install release tags, not `main`.** `install.sh` picks the newest `vX.Y.Z` tag (falls back to `main` only before the first release). Pushing to `main` ships nothing; releasing does. To release, when the user asks: bump `version` in `package.json`, commit, push, wait for the npm / Install / Keep awake workflows to pass, then `git tag vX.Y.Z && git push origin vX.Y.Z`, `gh release create`, and `npm publish` (the owner approves in the browser within a few minutes; run it under `script` so npm waits). A release is done only when `npm view codemax-cli version` shows it: npm installs are only offered updates that reached npm, installer installs are offered GitHub releases (`src/core/update.ts`).

## Design decisions

| Decision | Why |
|---|---|
| codemax owns the UI; agents are engines (since v0.3) | One consistent chat, native ledger of every turn, handoffs without terminal-state bugs. `PLAN.md`'s opening "wrap the real TUIs" section is history; that path survives only as `--tui` and `--raw`. |
| OpenTUI for the terminal UI | Bun-native, embedded terminal (Ghostty VT) for the fallback pane; Ink has none. |
| Codex via its own app-server, not the ACP adapter | The community adapter rejects ChatGPT-plan models. |
| Claude via the Zed ACP adapter with `CLAUDE_CODE_EXECUTABLE` | Runs the user's own installed `claude` and login. |
| OpenCode gets an inline "ask" permission config | Otherwise it acts without asking. |
| Cursor via `cursor-agent acp` (hidden command, Cursor Agent 2026.10+) | Verified: it asks before shell commands (allow once / always / reject) and honours a reject. Models and modes (agent / plan / ask) come as config options. It reports no token usage. Changing its model persists in Cursor's own settings. |
| Model menus show only what the agent reports, never a list of ours | ACP agents report models in the session (or config options); Codex through `model/list` (hidden models skipped, 4 s timeout, falls back to the current model). Menus show display names, newest first by the version in the name, Default/Auto pinned (`src/chat/models.ts`), and scroll so every entry is reachable. Codex's `/effort` levels come from the current model's `supportedReasoningEfforts`. |
| Model switching prefers the ACP `model` config option; else raw `session/set_model` | SDK 1.9 dropped `unstable_setSessionModel`; the Claude adapter still answers `session/set_model`. Agents with one model (Grok on most plans) say so; `/effort` sets a `thought_level` option. |
| Antigravity via Google's own ACP server (`src/engines/antigravity.ts`) | `agy` (1.4) has no ACP mode; Google publishes `agy_acp_server` in the ACP registry (what Zed installs). codemax offers it from the switcher (size shown, dl.google.com only, into `~/.codemax/agents/antigravity-acp/<version>/`) and never bundles it (proprietary). It must run behind plain pipes (`plainPipes`: Bun's socket stdio gets no answer), signs in with `oauth-personal` only (`signIn`; never the API-key methods; a browser may open once; login lives in `~/.gemini/antigravity-acp/`). Verified live: permission prompts (reject honoured), models (Gemini 3.8 Flash High/Medium/Low), thinking level, modes default/auto_edit/yolo, resume, cancel. It reports only context fill, so usage is input-only, and it ends an interrupted turn with end_turn (the engine reports cancelled). Gemini CLI stays for existing installs, last in the order. |
| Grok inherits Claude Code's permission mode | Its own behavior; codemax warns when that mode is `auto`. |
| Handoffs resume from a step journal (`src/core/journal.ts`), not a summary | Every step (user request + snapshot, agent messages, reasoning, each tool call with input and result, plans, how each turn ended and what was in flight, handoffs) is appended as it happens, so a turn cut off by a limit leaves its trail. A fresh agent gets a resume packet (`buildResumePacket`): the task, where and why it stopped with the in-flight step, the plan with "continue here", the steps, and the real diff since the task's snapshot, within `brief.resumeChars`. An agent whose own session resumes gets only a catch-up of what others did since its last step (`buildCatchup`; last-seen comes from the journal, never `sessions.json`). The old turn brief remains for journal-less ledgers. The pre-switch summary turn is skipped when a journal exists. |
| Usage priced at public API rates, frozen per record | Shows the value a flat subscription covered; later price changes never rewrite history. Prices from OpenRouter, LiteLLM fallback, weekly. |
| Brand theme in `src/chat/theme.ts`, dark and light palettes, `theme: auto` reads the terminal background | Pink is only the accent; warn/error/ok/plan keep distinct hues; overlays set their own text colour so light terminals stay readable. `/theme` saves the choice. |
| Thinking, plans and separate messages are first-class | Agents stream reasoning (`thought_delta`), plans and `messageId`s; the transcript shows a collapsed Thinking line, a live checklist, one paragraph per message; Ctrl+O expands everything cut short. |
| Per-turn usage from the ACP prompt response | OpenCode reports exact tokens there; `usage_update.used` is context fill (footer `ctx N%`), never added as tokens. Models/modes may arrive as ACP `configOptions` and are switched with `setSessionConfigOption`. |
| Limit detection is shared (`src/engines/errors.ts`) | Agents word it differently ("session limit · resets 3pm", "usage limit reached", 429 "free-usage-exhausted"). Errors and replies that are only a limit notice both trigger the handoff offer; such replies are not saved as answers, so the next agent gets the unanswered request. |
| Side agent (`/config` only, `src/core/review.ts`, `src/chat/notes.ts`) | No slash commands: `/config` sets the agent, its model (picked from the agent's own list), how often it reviews (`sideAgent.every`, 0 = paused) and whether notes are forwarded automatically. Any harness can review the main agent's work after a working turn and reply NO_NOTE or one "Heads up" note. A note waits in a panel above the prompt (above the queue): 1 expands it, 2 sends it to the main agent to discuss (`forwardMessage`), 0 dismisses. A digit is always typed as text; only when the prompt holds just that digit for `NOTE_ARM_MS` (800 ms) does it act on the note and leave the prompt, so "2 more tests please" is a message. While the main agent's last reply asks you something (`asksUser`: ends in "?" or a "?" with a numbered list), the keys pause and a lone digit is your answer; they return after you reply. It never reviews on the main agent's own plan unless the user picked that agent explicitly (`sideAgent.samePlan`, also a `/config` row); after a handoff onto its tool, reviews pause with one note. Loop guard: a turn that only answers a forwarded note is never reviewed, auto mode sends at most 2 notes per task (`AUTO_FORWARD_CAP`), forwarded notes are follow-ups in the journal. It runs in its own persistent session with questions off, its permission requests are refused, it stays out of the journal, and it turns itself off at its usage limit. |
| Keep awake (`/awake on|lid`, `src/core/awake.ts`) | macOS caffeinate (+ `pmset disablesleep` via a root watchdog for lid mode), Linux systemd-inhibit (sleep, shutdown, lid switch), Windows SetThreadExecutionState (+ lid action set to do nothing). Every holder watches codemax's pid; changed settings are restored on quit, on crash (watchdog / restore record) and at next start. macOS and Windows cannot block shutdown. Real-machine check: `.github/workflows/awake.yml` (never run `scripts/awake-check.ts` on a user's machine). |
| Settings live in one place (`/config`) | Every user-facing option is a row in `ChatApp.settings()` with its choices and an `apply` that takes effect at once and saves with `saveConfigKey`. Add new options there, not as one-off commands only. |
| Queued messages and the responding model are always visible | Messages typed while an agent works go through `enqueue()` and sit in a panel pinned above the prompt (`queueBox`) until sent. ↑ on an empty prompt pulls the last queued message back for editing (↑ again moves to the one before): Enter puts it back in its place, clearing it and pressing Enter removes it, Esc restores it unchanged (`queueEdit`). The spinner and every turn's closing line name the agent and model, using the model the agent reported for that turn when it does (`turn.model`), shown by its listed display name. |
| Times are always 12-hour (`src/core/time.ts`) | `fmtTime12` / `fmtDateTime12` force en-US 12-hour ("7:25 PM", "Oct 18, 7:25 PM") whatever the locale; every message you send and every turn's closing line carry one. Never use `toLocaleTimeString()` directly. |
| Plan limits come from the agent, not a command | Claude Code's own `/usage` is terminal-only and the adapter never offers it, but the same data arrives on usage updates as `_meta["_claude/rateLimit"]`; codemax shows it in `/usage`, feeds quota from it, and a "rejected" window triggers the handoff offer. Agent commands that clash with a built-in stay reachable as `/<agent>:<name>`. |
| A named agent is never swapped | `--agent X` (chat or `--tui`) stops with "X is not installed. Available: …" instead of starting another agent; without `--agent` the first installed one is used and named. Under `bun test` a fallback to a real agent throws, so tests can never spend quota. The adapter registry reads `CODEMAX_FAKE_AGENT` at call time. |
| Subagents are shown, never mixed in (`src/chat/subagents.ts`) | Engines emit `subagent` events (start, latest step, end). Claude: the Agent/Task tool call (`_meta.claudeCode.toolName`, `rawInput.subagent_type`) and child calls stamped `parentToolUseId`; OpenCode: its task tool (start/end only); Cursor: "Task: …" plus `cursor/task`; Codex: `subAgentActivity` items and the child's own thread. A Codex child thread's events never reach the main turn (its `turn/completed` used to end the main turn early), but its token usage is counted per thread, so /usage and budgets include helpers. ACP updates for another session id become subagent activity. The list sits under the prompt; finished agents show ✓ for 4 s. Background subagents (Claude `run_in_background`) end with the turn. Gemini and Grok are not mapped yet (Grok needs a logged trace). |
| Agent questions (`src/chat/question.ts`, `src/engines/elicitation.ts`) | ACP form elicitation is advertised, so Claude's AskUserQuestion (otherwise disabled by the adapter) and MCP forms open a dialog in codemax's slot with permission prompts: digits pick, typing fills "Other", Esc skips (the agent carries on). `questions` in `/config`: ask, skip after 5 min (unattended runs), or off (not advertised; new sessions). Codex has no equivalent yet. |
| The prompt grows with its text | Up to 10 lines or a third of the screen, counted by `wrappedLines` (the textarea's own `virtualLineCount` lags). A fixed one-line box made a full line look like a new empty prompt. |
| Terminal tab status (`src/core/termstatus.ts`) | Warp has built-in logos only (no custom icon API, warpdotdev/warp#13519), so codemax speaks Warp's `warp://cli-agent` channel (OSC 777 + JSON, gated on `WARP_CLI_AGENT_PROTOCOL_VERSION`) as the agent it drives: the tab shows Claude Code / Codex / Gemini / OpenCode / Cursor / Copilot with running / waiting / done, and Warp raises its own notifications. Other terminals get OSC 7501 status and a desktop notification (OpenTUI `triggerNotification`) when an agent waits or a turn over `bellAfterSeconds` ends while unfocused. Everything goes through the renderer, never raw stdout. `/config`: Terminal tab status, Desktop notifications. |
| Models are shown by display name only (`displayModelName`) | "Opus 5.5", never "opus" or "claude-opus-5-5", in menus (one column, no id), footer, turn lines, /status, /usage and side-agent labels. Ids the list lacks are spelled out for Claude families. |
| An agent is installed only if its CLI runs (`src/adapters/detect.ts`) | A file on PATH is not enough: `<bin> --version` must exit 0 within 15 s. Stale npm shims on Windows were offered as switch targets. `engine` in the chat's detection implies installed, and `switchTo` refuses an agent that is not. |
| The UI never breaks | Engine events, keys, the footer and resize run through `ChatApp.safely()`: a failure prints one "display glitch" line and codemax keeps going. Every picker filters as you type and clears its filter text on close. Test 23 renders long content, menus and note cards from 24×10 to 140×45 and requires zero glitches. |
| Copy on select | Mouse selection copies via the OS clipboard tool (pbcopy, wl-copy/xclip/xsel, clip) plus OSC 52; `ChatApp.copyText` is swapped in tests. |
| A switch with no conversation sends no brief | Briefing an agent with nothing to hand over burns a turn and quota. |
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

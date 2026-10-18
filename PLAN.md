# codemax-cli — plan

One terminal harness that runs several coding-agent CLIs (Claude Code, Codex, OpenCode, Cursor Agent, Grok, Gemini CLI, Copilot CLI) and lets you move between them without losing project context or history. People with several subscriptions can spend all of them from one place.

## Core decision: wrap the real TUIs, never headless mode

**v0.2 update (2026-10-18):** passing the agent's bytes straight to the host terminal broke on every switch once Claude Code moved to the alternate screen with mouse tracking: a killed agent leaves the host in whatever modes it enabled, and codemax's own menu toggled the alternate screen underneath it. codemax now owns the screen with [OpenTUI](https://opentui.com) (Bun-native, by the OpenCode team, powers OpenCode in production). Each agent runs inside an `EmbeddedTerminalRenderable` (Ghostty VT parser); codemax paints that pane plus a status bar and menu overlay. A fresh renderable per launch means no vendor terminal state survives a switch. Ink has no equivalent, which decided the framework choice. The old passthrough stays as `codemax --raw`.

codemax does **not** drive agents through `-p` / `exec` / `run --format json`. Headless modes lose the vendor UX (permission prompts, plan mode, slash commands, skills, hooks, MCP auth flows) and force auto-approve. Instead:

- codemax spawns the agent's own interactive TUI inside a pseudo-terminal (`Bun.Terminal`) and passes keystrokes and screen bytes through untouched. You are using the real `claude`, `codex`, etc.
- A hotkey (default `Ctrl+_`, which most terminals send for `Ctrl+/`; configurable) opens the codemax menu: switch agent, see quota, quit.
- Context survives a switch because codemax keeps its own **project ledger**, fed from the transcript files the agents already write to disk, plus git.

## v0.3 direction (2026-10-18): codemax's own UI, agents as engines

The user chose a single codemax chat UI that drives the agents underneath instead of showing each vendor's TUI. That needs a programmatic channel, and the distinction matters: one-shot headless modes (`-p`, `exec`) stay ruled out because they auto-approve and have no permission prompts. The channel is the interactive kind: the Agent Client Protocol (ACP) or the vendor's equivalent JSON-RPC session, where the agent sends permission requests, tool-call and plan updates back to the UI and the UI answers. Zed and JetBrains drive agents this way.

Spike (same day, API keys stripped from the environment, all on subscription logins):

| Agent | Channel | Auth seen | Permission prompt | Status |
|---|---|---|---|---|
| Claude Code | ACP via `@zed-industries/claude-code-acp` (Claude Agent SDK) | `claude-login` | yes (allow always / once / reject) | works; verify it runs the user's `claude`, else fall back to `claude --input-format stream-json` |
| Codex | native `codex app-server` JSON-RPC over stdio | ChatGPT plan | yes (`item/*/requestApproval`) | works. The community ACP adapter does not: its bundled core rejects ChatGPT-plan models |
| OpenCode | native `opencode acp` | `opencode-login` | not asked (ran on its default) | works; confirm it picks a subscription model, not the free one |
| Grok | native `grok agent stdio` (ACP) | `cached_token` | not asked | works |
| Gemini CLI | native ACP per registry | — | — | not installed here |
| Cursor Agent | none (stream-json only) | — | — | falls back to the embedded terminal pane |

Lost: vendor slash commands, skills, hooks and plan-mode screens, and MCP sign-in flows the vendor TUIs render. ACP exposes modes and an available-commands list, so some comes back.
Gained: the ledger sees every message natively; handoff is codemax's own conversation; quota comes from structured errors; the terminal-fidelity problem disappears.
Carries over: OpenTUI renderer, status bar, menu overlay, tests, ledger, brief builder. The embedded pane becomes `codemax --tui` and the fallback for engine-less agents; `--raw` stays.

Layout: `src/engines/` (normalized event stream; `acp.ts` generic client; `codex.ts` app-server client), `src/chat/` (OpenTUI chat UI: turn list, tool rows, permission overlay, input).

**Status (2026-10-18, later):** default flipped. Verified end to end through a headless terminal: Claude wrote a file after a permission prompt answered in codemax, the menu switched to Codex with an 821-char brief, Codex confirmed the file and answered a follow-up, all four turns landed in the ledger natively. Permission caveats found and handled: OpenCode needs an inline "ask" config (codemax sets it); Grok inherits the permission mode from the user's Claude Code settings (`defaultMode: "auto"` here), which codemax surfaces as a warning. The Claude adapter runs the user's own `claude` through `CLAUDE_CODE_EXECUTABLE`.

**UI pass (v0.3.1):** chat restyled to Claude Code's idiom from live captures and a cheap-model rules extraction (`docs/claude-code-ui-rules.md`, `docs/ui-review.md`): `❯` prompts, `⏺` blocks with `⎿` nested results, spinner line with verbs/timer/approx tokens, one slash palette for `/`, `/switch`, `/mode` (prefix/word matching, typos never run), Claude's permission wording with "tell the agent what to do differently", Shift+Tab mode cycling, history, queueing while busy, footer with mode indicator.

**Usage (v0.3.2):** `/usage`, footer cost and `codemax usage` sum tokens per agent/model and price them at public API list rates (API-equivalent value; subscriptions bill flat). Sources: Codex `thread/tokenUsage/updated` deltas; OpenCode ACP `usage_update` (own cost, context size); Claude transcript `usage` fields tailed per session; Grok `~/.grok/sessions/<cwd>/<id>/usage.json` (its own cost ticks, which matched the list-price estimate exactly). Prices in `src/core/pricing.ts`, user overrides in `~/.codemax/prices.json`.

**v0.4 (2026-10-18):** markdown and diff styling in the transcript (headings, inline code, bold/italic, bullets, fenced blocks, +/- lines coloured, throttled restyle while streaming); `/model` (ACP `session/set_model`, Codex per-turn model); `/compact` and summarize-on-switch writing `summary.md` for every handoff (skipped at 85%+ quota, 30s cap, Esc skips); `!cmd` shell mode attached to the next prompt; `/diff`, `/new`; terminal title and bell on long turns; queued `/` and `!` entries dispatched like typed ones; permission dialog no longer reacts to letters (typing at the wrong moment picked "allow for session"); switch palette keeps its highlight across the background refresh; compiled binary fetches the Claude adapter through bunx when it is not on disk.

**v0.5 (2026-10-18):** auto-handoff offer on quota exhaustion (deferred to turn end, Enter continues the unfinished request); daily API-equivalent budgets per agent and overall with 80% warning and 100% handoff; working-tree checkpoints under refs/codemax/checkpoints with a private index, /undo and /checkpoints (5 MB untracked cap, newest 50 kept); @file completion with contents attached; /ask and regex routing rules to a throwaway session on another agent; startup session picker. Tests now run with an isolated CODEMAX_HOME (bunfig preload); before that, full-suite runs wrote ledger folders into the real ~/.codemax.

Open: Gemini CLI untested (not installed).

## How context survives

| Mechanism | Scope | Source |
|---|---|---|
| Native resume (`claude --resume <id>`, `codex resume <id>`) | Same agent, later | Vendor session store |
| Handoff brief injected into the next agent | Across agents | codemax ledger + `git diff --stat` |
| Ledger (`~/.codemax/projects/<escaped-cwd>/`) | Whole project | Tailed vendor transcripts |

Transcript sources per agent (verified where marked):

- Claude Code: `~/.claude/projects/<cwd with non-alnum → '-'>/<session-id>.jsonl`. We pass `--session-id <uuid>` so the path is known up front. ✅ verified
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread-id>.jsonl`; found after launch by `session_meta.cwd` + mtime. Also contains `token_count.rate_limits.primary.used_percent` → proactive quota signal. ✅ verified
- OpenCode: sqlite at `~/.local/share/opencode/opencode.db`, or `opencode export <sessionID>`. ⏳ v2
- Cursor Agent: `~/.cursor/chats/<hash>/<id>/store.db`. ⏳ v2
- Grok: `~/.grok/sessions`. ⏳ v2 (local binary is outdated, HTTP 426)
- Gemini CLI, Copilot CLI: not installed here. Detect-only stubs.

Git is the ground truth for *what changed*. The ledger records `git diff --stat` at every switch; we never reconstruct edits from tool-call events.

## Handoff brief

Injected as the first prompt of the next agent (positional prompt arg for `claude` and `codex`; typed into the PTY with bracketed paste for agents that take no prompt arg, and for resumed sessions).

Bounded: compacted summary (`summary.md`, optional) + last 10 turns (each ≤1200 chars) + diff stat, total ≤8000 chars.

## Quota detection

Pluggable per adapter, with a manual switch always available:

1. Proactive probes: Codex `rate_limits` in rollout; Claude usage via OAuth usage endpoint (v2).
2. Output scan: ANSI-stripped rolling buffer of the PTY output matched against per-agent regexes ("usage limit reached", "hit your usage limit", 429, …).
3. On detection codemax raises a notice in the menu and (if `autoSwitch` is on) offers the next agent in priority order. It never kills an agent mid-turn on its own.

## Subscriptions, not API keys

The point of codemax is to spend subscription quota. A vendor API key in the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, …) makes most of these CLIs bill the key instead of the login. codemax always strips each agent's key variables from the child environment and prints a one-line notice. There is no opt-out: codemax is subscriptions-only by design.

## Runtime and layout

- Bun ≥1.3 only (needs `Bun.Terminal`). Ships as `bun build --compile` binary and as an npm package that requires Bun.
- TypeScript, single package.

```
src/
  cli.ts                entry + commands: (default) start, agents, status, history
  config.ts             ~/.codemax/config.json (agent order, hotkey, per-agent extra args)
  core/pty.ts           spawn agent in Bun.Terminal, passthrough, resize, kill
  core/terminal.ts      reset sequences, alt-screen, key codes
  core/menu.ts          codemax overlay menu (alt screen, redraw child on exit)
  core/orchestrator.ts  session loop: run agent → hotkey/exit → switch → inject brief
  core/ledger.ts        project ledger (turns, sessions, events)
  core/brief.ts         handoff brief builder
  core/git.ts           diff stat / status
  core/quota.ts         output scanner + probe aggregation
  adapters/*.ts         one per agent: detect, launch args, locate session, read transcript, quota
  transcripts/*.ts      vendor transcript parsers → normalized turns
```

## Milestones

1. **v0.1 (this pass):** PTY passthrough, hotkey menu, Claude ⇄ Codex switch with brief, ledger from both transcripts, Codex proactive quota, output-scan quota for both, native resume when switching back.
2. **v0.2:** OpenCode, Cursor, Grok adapters + transcript readers; status bar line; `codemax history`.
3. **v0.3:** LLM compaction of the ledger (ask the outgoing agent to summarize while it still has quota), Claude usage probe, Gemini/Copilot once installed.

## Open items to verify by hand

- Hotkey `Ctrl+_` is unbound inside Claude Code, Codex, and OpenCode TUIs.
- Claude path escaping for cwd containing `.` or `_` (rule assumed: every non-alphanumeric char → `-`).
- Terminal state after the first switch (alt screen / mouse / bracketed paste reset).

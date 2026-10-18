# codemax-cli — plan

One terminal harness that runs several coding-agent CLIs (Claude Code, Codex, OpenCode, Cursor Agent, Grok, Gemini CLI, Copilot CLI) and lets you move between them without losing project context or history. People with several subscriptions can spend all of them from one place.

## Core decision: wrap the real TUIs, never headless mode

**v0.2 update (2026-10-18):** passing the agent's bytes straight to the host terminal broke on every switch once Claude Code moved to the alternate screen with mouse tracking: a killed agent leaves the host in whatever modes it enabled, and codemax's own menu toggled the alternate screen underneath it. codemax now owns the screen with [OpenTUI](https://opentui.com) (Bun-native, by the OpenCode team, powers OpenCode in production). Each agent runs inside an `EmbeddedTerminalRenderable` (Ghostty VT parser); codemax paints that pane plus a status bar and menu overlay. A fresh renderable per launch means no vendor terminal state survives a switch. Ink has no equivalent, which decided the framework choice. The old passthrough stays as `codemax --raw`.

codemax does **not** drive agents through `-p` / `exec` / `run --format json`. Headless modes lose the vendor UX (permission prompts, plan mode, slash commands, skills, hooks, MCP auth flows) and force auto-approve. Instead:

- codemax spawns the agent's own interactive TUI inside a pseudo-terminal (`Bun.Terminal`) and passes keystrokes and screen bytes through untouched. You are using the real `claude`, `codex`, etc.
- A hotkey (default `Ctrl+_`, which most terminals send for `Ctrl+/`; configurable) opens the codemax menu: switch agent, see quota, quit.
- Context survives a switch because codemax keeps its own **project ledger**, fed from the transcript files the agents already write to disk, plus git.

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

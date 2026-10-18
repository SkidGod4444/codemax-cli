# codemax

One terminal for all your coding agents. Run Claude Code, Codex, OpenCode, Cursor Agent, Grok and others from a single harness, switch between them with a hotkey, and keep project context and history across the switch.

Built for people with more than one subscription: when one agent runs out of quota, hand the same task to the next one without re-explaining the project.

## How it works

- codemax runs the agent's **real interactive TUI** in a pseudo-terminal. No headless modes, no auto-approve: you get the vendor UX, permissions, plan mode, slash commands, skills and MCP exactly as shipped.
- The agent draws into an **embedded virtual terminal** ([OpenTUI](https://opentui.com)'s `EmbeddedTerminalRenderable`, backed by Ghostty's VT parser), and codemax paints that plus its own one-line status bar and menu. The host terminal never sees the agent's escape sequences, so alternate screen, mouse and keyboard modes cannot leak from one agent to the next.
- It keeps a **project ledger** in `~/.codemax/projects/<project>/`, fed from the transcript files the agents already write to disk (Claude Code and Codex today) plus `git diff --stat`.
- On a switch it builds a bounded **handoff brief** (summary, recent turns, recent commits, uncommitted changes, last request) and gives it to the next agent as its first prompt. Switching back to an agent you used before resumes its native session.
- Codex reports quota usage proactively in its own session file; every agent's output is also scanned for "usage limit" style messages. When one fires, codemax offers the next agent. You can always switch manually.
- **Subscriptions only.** Vendor API-key env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`, …) are always removed from the agent's environment, so your plan is billed and never a pay-per-token key. There is no setting to turn this off.

## Install

Requires [Bun](https://bun.sh) ≥ 1.3 (tested on 1.3.5; `@opentui/core` declares 1.3.14, so `bun upgrade` is the first thing to try if the native renderer misbehaves).

```sh
git clone <this repo> && cd codemax-cli
bun install
bun link            # puts `codemax` on PATH
```

## Use

```sh
cd your-project
codemax                      # starts the first installed agent in config order (Claude Code by default)
codemax --agent codex        # start with a specific agent
codemax agents               # what is installed, saved sessions, quota
codemax history -n 20        # recorded turns for this project
codemax brief --to codex     # preview the handoff brief
codemax config               # ~/.codemax/config.json
```

Inside an agent press **Ctrl+^** (Ctrl+Shift+6) or **Ctrl+/** to open the codemax menu: pick another agent with the number keys or arrows, `f` toggles fresh vs. resume, `Esc` goes back, `x` quits. Some terminals swallow Ctrl+/ (Warp does); run `codemax keys` to see what yours sends, and set `"hotkeys": ["ctrl+<key>"]` in the config to change it.

`codemax --raw` runs the older passthrough mode without the codemax screen, for comparison or if the embedded terminal misbehaves in your terminal.

When an agent exits on its own (for example you typed `/exit`), the menu opens so you can continue in another one.

## Status

v0.1. Claude Code and Codex have full support (transcript ledger, native resume, quota). OpenCode, Cursor Agent and Grok launch and receive the brief, but their transcripts are not read yet, so turns spent in them are not in the ledger. Gemini CLI and Copilot CLI are detect-only. See `PLAN.md`.

## Develop

```sh
bun test            # unit tests + an end-to-end PTY test with a fake shell agent
bun run typecheck
bun run build       # single binary at dist/codemax
```

On macOS the build script re-signs the binary (`codesign --force --sign - dist/codemax`). Without that step Bun 1.3.5 output is killed on launch with exit 137 ("invalid signature") on recent macOS.

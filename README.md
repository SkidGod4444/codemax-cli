# codemax

One terminal for all your coding agents. Run Claude Code, Codex, OpenCode, Cursor Agent, Grok and others from a single harness, switch between them with a hotkey, and keep project context and history across the switch.

Built for people with more than one subscription: when one agent runs out of quota, hand the same task to the next one without re-explaining the project.

## How it works

- codemax has **its own chat UI** (built on [OpenTUI](https://opentui.com)) and drives each agent underneath over an interactive protocol: the [Agent Client Protocol](https://agentclientprotocol.com) for Claude Code (via the Zed adapter, running your installed `claude`), OpenCode, Grok and Gemini CLI, and Codex's native `app-server` JSON-RPC for Codex. These are two-way sessions: the agent sends permission requests, tool calls and plan updates, and you answer them in codemax. One-shot headless modes (`-p`, `exec`) are never used, and nothing is auto-approved.
- `codemax --tui` instead shows the agent's **own TUI** inside the codemax screen (an embedded virtual terminal backed by Ghostty's VT parser). It is the fallback for agents without a protocol, such as Cursor Agent. `codemax --raw` is the older bare passthrough.
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

In the chat:

- Type and press Enter. Shift+Enter inserts a newline. Typing while the agent works queues the message.
- `/` opens the command palette, filtered as you type: `/switch`, `/mode`, `/status`, `/clear`, `/help`, `/quit`, plus the agent's own commands. Enter runs the highlighted one; a typo never runs anything.
- `/switch` (or **Ctrl+^** / **Ctrl+/**) lists agents with version, session age and quota. Enter hands the conversation over with a brief.
- `Shift+Tab` cycles permission modes (ask → accept edits → plan); the footer shows the current one. `/mode` lists them.
- Permission prompts: `1` Yes · `2` Yes for this session · `3` No, and tell the agent what to do differently (focuses the prompt). `Esc` is No.
- `Esc` interrupts a running turn. `Ctrl+C` clears the prompt, twice quits. `↑` recalls history. `?` on an empty prompt shows shortcuts.
- `/usage` (or `codemax usage`, `--all` for every project) shows tokens per agent and model and the **API-equivalent cost** at public list prices. Your subscriptions bill a flat fee, so this is the value of what they covered, not a charge: use it to compare agents and spot heavy sessions. The footer shows the running figure for this session. Sources: Codex streams token totals over its protocol, OpenCode reports its own cost, Claude Code and Grok write per-call usage to their session files, which codemax tails. Prices come from OpenRouter's public model list (LiteLLM's as fallback), downloaded on first run and refreshed weekly into `~/.codemax/prices-live.json`; the built-in table is the offline fallback. `codemax prices` shows the source and date, `codemax prices update` refreshes now, `codemax prices <model>` looks one up. Override any model in `~/.codemax/prices.json` as `{"model-substring": {"input": 2, "output": 12, "cacheRead": 0.2}}` per million tokens. Every usage record keeps the rate it was priced at, so a later price change applies only going forward. Set `"priceUpdates": false` in the config to stay offline. Some terminals swallow Ctrl+/ (Warp does); run `codemax keys` to see what yours sends, and set `"hotkeys": ["ctrl+<key>"]` in the config to change it.

`codemax --raw` runs the older passthrough mode without the codemax screen, for comparison or if the embedded terminal misbehaves in your terminal.

When an agent exits on its own (for example you typed `/exit`), the menu opens so you can continue in another one.

## Permissions per agent

- **Claude Code**: asks (allow once / always / reject) through the adapter; modes `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` via `/mode`.
- **Codex**: asks before edits and commands (`on-request` approval policy).
- **OpenCode**: its defaults allow edits and shell silently, so codemax starts it with an inline config that asks for anything state-changing and allows reads.
- **Grok**: takes its permission mode from your Claude Code settings. If `~/.claude/settings.json` has `permissions.defaultMode: "auto"` it will act without asking; codemax warns when that is the case.

## Status

v0.3. Chat UI drives Claude Code, Codex, OpenCode and Grok over their protocols with the ledger fed natively; switching hands a brief to the next agent and resumes native sessions when switching back. Gemini CLI is wired but untested here (not installed). Cursor Agent and Copilot fall back to `--tui`. See `PLAN.md`.

## Develop

```sh
bun test            # unit tests + an end-to-end PTY test with a fake shell agent
bun run typecheck
bun run build       # single binary at dist/codemax
```

On macOS the build script re-signs the binary (`codesign --force --sign - dist/codemax`). Without that step Bun 1.3.5 output is killed on launch with exit 137 ("invalid signature") on recent macOS.

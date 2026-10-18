<p align="center">
  <img src="assets/logo.svg" width="360" alt="codemax" />
</p>

# codemax

**One terminal for every coding agent you pay for.** codemax drives Claude Code, Codex, OpenCode, Grok and Gemini CLI from a single chat, keeps one conversation and project history across all of them, and hands the task to the next agent when one runs out of quota.

```
 ❯ Change README.md to say hello world, then commit it.
 ⏺ Edit README.md
   ⎿  -hi
      +hello world
 ⏺ Committed as 95e18e1 "say hello world". Working tree is clean.
 ✻ Worked for 9s · done 8:14 PM
   ⎿  Claude Code reached its $5.00 daily budget · Enter to continue in Codex
 ───────────────────── Codex 0.159.3 · gpt-5.6-terra · new session ─────────────────────
   ⎿  handing over 6 earlier turns and the repo state
 ❯ What did the previous agent commit?
 ⏺ README.md, changing hi to hello world, in commit 95e18e1.
────────────────────────────────────────────────────────────────────────────────────────
❯ Try "fix the failing test" · / for commands
────────────────────────────────────────────────────────────────────────────────────────
  ⏵ asks before acting · shift+tab to cycle · ? for shortcuts      Codex · gpt-5.6-terra
```

- **Your subscriptions, not API keys.** Each agent runs through its own CLI and your own login. codemax strips vendor API-key variables from every agent it launches, and `codemax doctor` finds settings files that would bill a key anyway.
- **Real agents, real permission prompts.** codemax talks to each agent over its interactive protocol, so edits and commands still ask first. It never uses one-shot headless modes and never auto-approves.
- **Context survives a switch.** A project ledger records every turn. Switching agents hands over a brief of the conversation, recent commits, uncommitted changes and an agent-written summary. Switching back resumes that agent's own session.

> Status: early (v0.5). Works day to day with Claude Code, Codex, OpenCode and Grok on macOS. Gemini CLI is wired but untested. Not affiliated with Anthropic, OpenAI, xAI, Google or the OpenCode team.

## Quick start

Requires [Bun](https://bun.sh) 1.3 or newer and at least one supported agent CLI, installed and logged in.

```sh
git clone https://github.com/SkidGod4444/codemax-cli.git
cd codemax-cli
bun install
bun link                 # puts `codemax` on your PATH
codemax doctor           # checks nothing will bill an API key
cd ~/your-project && codemax
```

If `codemax` is not found after `bun link`, add `~/.bun/bin` to your `PATH`.

## Supported agents

| Agent | How codemax drives it | Permission prompts | Resume | Usage and cost |
|---|---|---|---|---|
| Claude Code | [ACP](https://agentclientprotocol.com) via the Zed adapter, running your installed `claude` | yes | yes | from its session files |
| Codex | native `codex app-server` JSON-RPC | yes | yes | streamed by Codex |
| OpenCode | native `opencode acp` | yes (codemax turns on "ask") | yes | reported by OpenCode |
| Grok CLI | native `grok agent stdio` (ACP) | follows your Claude Code settings | yes | from its session files |
| Gemini CLI | native ACP | untested | untested | not yet |
| Cursor Agent, Copilot CLI | no protocol yet: shown in their own TUI with `codemax --tui` | their own | their own | no |

## Using it

Type and press Enter. Shift+Enter adds a newline. Messages typed while the agent works are queued.

| Keys and commands | What they do |
|---|---|
| `/` | Command palette, filtered as you type. A typo never runs anything. |
| `/switch` or **Ctrl+^** | Pick another agent. Enter hands over the conversation. |
| `/ask codex <msg>` | One message to another agent; you stay where you are. |
| `@path` | Fuzzy-complete a file; its contents go with the message. |
| `!cmd` | Run a shell command; its output goes with your next message. |
| `/undo`, `/checkpoints` | Revert the files the last turn changed; list snapshots. |
| `/model`, `/mode`, **Shift+Tab** | Pick the model; set or cycle permission mode. |
| `/compact` | Ask the agent for a summary used in every later handoff. |
| `/usage`, `/budget` | Tokens and API-equivalent cost per agent; today's spend. |
| `/diff`, `/status`, `/new`, `/clear`, `/quit` | Uncommitted changes, session details, fresh session, clear screen, quit. |
| **Esc** | Interrupt the running turn. |
| **Ctrl+C** | Clear the prompt; twice quits. |
| **↑** | Previous messages. |
| `?` | Shortcuts. |

**Permission prompts** read like Claude Code's: `1` Yes, `2` Yes for this session, `3` No and tell the agent what to do instead, which puts the cursor in the prompt. Esc means No. Letters never pick an option, so typing at the wrong moment is safe.

**Starting** with plain `codemax` lists your recent sessions in the project with their last message. Enter resumes one. `codemax --agent codex` or `--fresh` skips the list.

## Features in more detail

### Handoffs when quota or budget runs out

When an agent reports it is out of quota, or passes your daily budget, codemax waits for the turn to end and offers `Continue in <next agent>`. Enter hands over the conversation, the repo state and the unfinished request. The next agent is the first in your `order` that is installed, not out of quota and not over budget.

Before a normal switch codemax can ask the outgoing agent for a short project summary (`summarizeOnSwitch`, on by default). That costs one prompt on that agent. It is skipped when the agent reports 85% or more of its quota used, gives up after 30 seconds, and Esc skips it.

### Usage and cost

`/usage`, the footer and `codemax usage [--all]` show tokens per agent and model, priced at each vendor's **public API rates**. Your subscriptions bill a flat fee, so this is the API-equivalent value of what they covered, not money spent. Use it to compare agents and spot heavy sessions.

Prices come from [OpenRouter's public model list](https://openrouter.ai/api/v1/models), with [LiteLLM's](https://github.com/BerriAI/litellm) as fallback. They are refreshed weekly into `~/.codemax/prices-live.json`, with a built-in table for offline use. Each usage record keeps the rate it was priced at, so a price change only affects later turns. When an agent reports its own cost (OpenCode, Grok), that figure wins.

```sh
codemax prices                  # source and date of the price list
codemax prices update           # refresh now
codemax prices gpt-5.6-terra    # look up one model
```

### Checkpoints and `/undo`

Before each turn codemax snapshots your working tree into `refs/codemax/checkpoints/`. It uses a private index, so your staging area, branches and stash are never touched. `/undo` restores the files the last turn changed and removes files it created, then tells the agent on your next message.

Untracked files over 5 MB are left out of snapshots and never deleted by `/undo`. Only the newest 50 snapshots are kept. Requires a git repo.

### Routing

`"routes": [{"match": "^review", "agent": "codex"}]` sends any message matching the pattern to that agent as a one-off, like `/ask`, while you stay on the current one.

## Configuration

`~/.codemax/config.json` is created on first run. `codemax config` prints it.

| Key | Default | Meaning |
|---|---|---|
| `order` | `["claude", "codex", "opencode", "cursor", "grok", "gemini", "copilot"]` | Preference order for the default agent and handoffs |
| `hotkeys` | `["ctrl+/", "ctrl+^"]` | Keys that open the agent switcher. Warp swallows Ctrl+/; `codemax keys` shows what your terminal sends |
| `budgets` | `{}` | Daily API-equivalent USD per agent or `"all"`, e.g. `{"claude": 20, "all": 50}`. Warns at 80%, offers a handoff at 100% |
| `routes` | `[]` | `[{ "match": "<regex>", "agent": "<id>" }]` one-off routing |
| `checkpoints` | `true` | Snapshot before each turn for `/undo` |
| `summarizeOnSwitch` | `true` | Ask the outgoing agent for a summary before a switch |
| `autoSwitch` | `true` | Offer a handoff when an agent runs out of quota |
| `priceUpdates` | `true` | Weekly price list download; `false` stays offline |
| `bellAfterSeconds` | `20` | Ring the terminal bell when a longer turn finishes; `0` disables it |
| `brief` | `{ turns: 10, maxChars: 8000, turnChars: 1200 }` | Size of the handoff brief |
| `agentArgs` | `{}` | Extra CLI args per agent (for `--tui` and `--raw` modes) |

`~/.codemax/prices.json` overrides prices per model substring, in USD per million tokens:

```json
{ "gpt-5.6-terra": { "input": 2, "output": 12, "cacheRead": 0.2 } }
```

## Commands

```
codemax [--agent <id>] [--fresh]   chat (default); --tui shows the agent's own TUI, --raw bare passthrough
codemax doctor [--fix]             find settings that would bill an API key or make an agent act without asking
codemax agents                     installed agents, saved sessions, quota
codemax usage [--all]              tokens and API-equivalent cost for this project or all projects
codemax prices [update] [<model>]  price list source and age, refresh, look up one model
codemax history [-n <count>]       recorded turns for this project
codemax brief [--to <id>]          preview the handoff brief
codemax status | config | keys | quota [clear [<id>]]
```

## Privacy and billing

- Everything stays on your machine. codemax keeps its ledger, usage and config in `~/.codemax/` and talks only to the agent CLIs you have installed. The one network call of its own is the weekly price-list download, which `priceUpdates: false` turns off.
- Agents run under your existing logins. codemax always removes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `CURSOR_API_KEY` and similar variables from their environment.
- Claude Code can still read an API key from the `env` block of `~/.claude/settings.json`. `codemax doctor` reports that, codemax refuses to start Claude while it is there, and `codemax doctor --fix` removes it, keeping a backup.
- **Grok** takes its permission mode from your Claude Code settings. With `permissions.defaultMode: "auto"` it acts without asking, and codemax warns you when it starts.

## How it works

```
                 ┌──────────────── codemax (Bun + OpenTUI) ────────────────┐
  you  ⇄  chat UI ─ palette ─ permission dialog ─ /usage ─ checkpoints     │
                 │        │                                                │
                 │   engine (one per agent session)                        │
                 │   ├─ ACP client ──────► claude-code-acp ► claude        │
                 │   │                 ├─► opencode acp                    │
                 │   │                 └─► grok agent stdio                │
                 │   └─ app-server ──────► codex app-server                │
                 │                                                         │
                 └── ledger ~/.codemax/projects/<project>/ ────────────────┘
                     turns · sessions · usage · summary · events
```

- **Engines** turn each protocol into one event stream: text, tool calls, permission requests, plan and mode updates, usage, turn end. See `src/engines/`.
- **The chat UI** is built on [OpenTUI](https://opentui.com) and follows Claude Code's conventions: `❯`, `⏺` and `⎿`, a slash palette, its permission wording, Shift+Tab modes. See `src/chat/`.
- **Handoff brief:** a bounded prompt built from the ledger: summary, recent turns, recent commits, `git diff --stat` and the last request. See `src/core/brief.ts`.
- **`codemax --tui`** runs an agent's own TUI inside an embedded virtual terminal (Ghostty's VT parser), for agents with no protocol.

Design notes and history are in [`PLAN.md`](PLAN.md). The UI conventions are in [`docs/claude-code-ui-rules.md`](docs/claude-code-ui-rules.md).

## Development

```sh
bun install
bun test             # 31 tests: engines, chat UI, palettes, features (fake ACP agents), checkpoints, pricing
bun run typecheck
bun run build        # single binary at dist/codemax (fetches the Claude adapter with bunx when needed)
```

Tests run the real chat app in OpenTUI's in-memory renderer against scripted ACP agents, so they need no logins and spend no quota. A preload (`test/setup.ts`) gives every test file its own temporary `CODEMAX_HOME`.

On macOS the build script re-signs the binary (`codesign --force --sign -`). Without it, recent macOS kills Bun 1.3 binaries at launch with exit 137.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Most useful right now:

- an engine for Cursor Agent or Copilot CLI once they expose a protocol, and testing the Gemini CLI engine;
- Linux and Windows testing;
- usage data for agents that do not report it yet.

## License

[Apache 2.0](LICENSE)

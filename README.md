<p align="center">
  <img src="assets/logo.svg" width="360" alt="codemax" />
</p>

<p align="center"><b>Every AI coding plan you pay for. One terminal.</b></p>

<p align="center">
  Claude Code · Codex · OpenCode · Grok · Gemini CLI
</p>

---

## What you get

- **Never stop at a usage limit.** When one agent runs out, press Enter and the next one finishes the same task.
- **One conversation across every agent.** Your history, project context and changes follow you when you switch.
- **Only the subscriptions you already pay for.** No API keys, no per-token bills, no new account.
- **Every agent asks before acting.** Edits and commands wait for your approval, just like in each agent's own app.
- **Undo any turn.** Roll back the files a reply changed with `/undo`.
- **See what you're getting.** `/usage` shows tokens and their API-equivalent value per agent, with daily budgets if you want them.
- **Free and open source.** Everything stays on your machine.

```
 ❯ fix the failing auth test
 ⏺ Fixed the off-by-one in token expiry. 14 tests pass.
   ⎿  Claude Code reached its daily limit · Enter to continue in Codex
 ───────────────────── Codex · gpt-5.6-terra · new session ─────────────────────
 ❯ now add a test for the refresh path
 ⏺ Added refresh-expiry coverage. 15 tests pass.
```

## Get started

Paste this in your terminal (macOS, Linux or WSL):

```sh
curl -fsSL https://codemax.saidev.codes/install | bash
```

It installs codemax (and [Bun](https://bun.sh) if you don't have it), then lists the agent CLIs it found. You need at least one agent you're logged in to. Then:

```sh
codemax doctor        # confirms nothing will bill an API key
cd ~/your-project && codemax
```

It installs the latest release. Run the same command again to update. To uninstall: `rm -rf ~/.codemax/cli ~/.bun/bin/codemax`.

<details>
<summary>Install from a clone instead</summary>

```sh
git clone https://github.com/SkidGod4444/codemax-cli.git
cd codemax-cli && bun install && bun link
```

</details>

## Supported agents

| Agent | Plan it uses | Status |
|---|---|---|
| Claude Code | Claude Pro / Max | Supported |
| Codex | ChatGPT Plus / Pro | Supported |
| OpenCode | Your OpenCode login | Supported |
| Grok | SuperGrok | Supported |
| Gemini CLI | Google AI plans | Early, untested |
| Cursor, Copilot | Your plan | In their own UI via `codemax --tui` |

## Everyday keys

| | |
|---|---|
| `/switch` or **Ctrl+^** | Move to another agent, conversation included |
| `/ask codex <msg>` | One question to another agent |
| `@file` | Attach a file to your message |
| `/undo` | Revert the last turn's changes |
| `/usage`, `/budget` | Usage and spend per agent |
| `/model`, **Shift+Tab** | Pick the model, cycle permission mode |
| **Esc** | Stop the current turn |
| `/` | All commands |

<details>
<summary><b>Configuration</b></summary>

`~/.codemax/config.json` is created on first run. `codemax config` prints it.

| Key | Default | What it does |
|---|---|---|
| `order` | `["claude", "codex", "opencode", "cursor", "grok", "gemini", "copilot"]` | Which agent comes next on a handoff |
| `budgets` | `{}` | Daily limit per agent, e.g. `{"claude": 20, "all": 50}` |
| `routes` | `[]` | Send matching messages to a specific agent |
| `checkpoints` | `true` | Snapshots for `/undo` |
| `autoSwitch` | `true` | Offer a handoff when an agent runs out |
| `summarizeOnSwitch` | `true` | Brief the next agent with a summary |
| `priceUpdates` | `true` | Weekly price list refresh |
| `hotkeys` | `["ctrl+/", "ctrl+^"]` | Keys that open the agent switcher |

</details>

<details>
<summary><b>CLI commands</b></summary>

```
codemax [--agent <id>] [--fresh]   start chatting
codemax doctor [--fix]             check nothing bills an API key
codemax agents                     installed agents and their quota
codemax usage [--all]              usage for this project or all projects
codemax prices [update]            price list used for usage values
codemax history | brief | status | config | keys
```

</details>

<details>
<summary><b>Privacy and billing</b></summary>

- Your code goes only to the agents you already use, under your own logins.
- codemax always removes vendor API keys from the agents it starts, and `codemax doctor --fix` removes any left in Claude Code's settings.
- Grok follows your Claude Code permission setting. If that is `auto`, Grok acts without asking, and codemax warns you.
- Its only network call is a weekly price-list download, which `priceUpdates: false` turns off.
- Usage values are what your plans covered at public API rates, not money you spent.

</details>

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [PLAN.md](PLAN.md) for design notes.

```sh
bun test && bun run typecheck
```

Not affiliated with Anthropic, OpenAI, xAI, Google or the OpenCode team.

## License

Copyright © 2026 [Saidev Dhal](https://saidev.codes). Free and open source under the [GNU AGPL-3.0](LICENSE), with an [added permission](NOTICE) for the agent tools codemax drives.

You can use, change and share codemax. If you distribute a modified version, or run one as a service, you must publish your changes under the same license. The codemax name and logo are not covered by the license: forks need their own name. See [TRADEMARKS.md](TRADEMARKS.md).

# Contributing to codemax

Thanks for helping. A few things keep the project easy to work on.

## Setup

```sh
bun install
bun test
bun run typecheck
```

Run `bun link` to use your checkout as `codemax`. It runs from source, so changes apply on the next launch.

## Ground rules

- **Never use an agent's one-shot headless mode.** Use `claude -p`, `codex exec` and similar only in throwaway scripts, never in codemax. codemax drives agents only through interactive protocols where permission requests reach the user.
- **Subscriptions only.** Do not add an option that passes vendor API keys to agents. `src/engines/env.ts` strips them, and that stays unconditional.
- **No auto-approval.** Permission requests must reach the user. A new engine must map the agent's approval requests to `permission_request` events.
- **Never touch the user's git state.** Checkpoints use a private index and `refs/codemax/`. Anything new must leave the index, branches and stash alone.

## Adding an agent

1. Add an adapter in `src/adapters/` for detection and the `--tui` fallback.
2. If the agent speaks ACP, register it in `src/engines/index.ts` with an `AcpEngine` and its command. Otherwise write an engine that implements `Engine` from `src/engines/types.ts` (see `codex.ts`).
3. If the agent does not report usage over its protocol, add a `usageTail` that reads its session files.
4. Add a test with a scripted fake agent (see `test/engines.test.ts` and `test/features.test.ts`), and check permission prompts against the real agent before opening the PR.

## Tests

- Tests must not need logins or network access, and must not spend quota. Use the fake ACP agent helpers.
- UI tests run the real `ChatApp` in OpenTUI's test renderer and assert on captured frames.
- `test/setup.ts` isolates `CODEMAX_HOME`; do not write to the real `~/.codemax`.

## Pull requests

Keep them focused and describe what you verified by hand against real agents. Update `README.md` when user-facing behavior changes.

## License

codemax is licensed under the [GNU AGPL-3.0](LICENSE) with an additional permission described in [NOTICE](NOTICE). By opening a pull request you agree that your contribution is licensed under the same terms. The codemax name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md), not by the license.

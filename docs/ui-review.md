## Matches
- R1: header, then a rule-bounded prompt box above the footer (lines 30-32 of capture 1).
- R2: grey placeholder `Try "fix the failing test"` sits inside the prompt box (line 31).
- R10: `/` opens a menu that narrows live; `/mo` leaves /mode, /model, /morning (captures 2-3).
- R11: after `/mo`, `/mode` is the highlighted top row, matching typed letters (capture 3, line 86).
- R20: assistant text and tool lines start with `⏺ ` (lines 206, 240, 245).
- R21: results hang under the tool line with `  ⎿  ` (lines 210, 244, 276).
- R31 (partial): spinner shows a verb with `…`, elapsed time and `esc to interrupt` (line 189).
- R40: numbered options `1. Yes` / `2. Yes, and don't ask again` / `3. No` with the command shown (lines 213-220).
- R41, R42: option order is allow once, allow-for-session, deny; session option shown only because offered.
- R4, R8: Shift+Tab produces a mode indicator line `⏵⏵ accept edits on` (line 161).

## Violations
- R3: footer hint is `ctrl+/ or ctrl+^ for agents`; `? for shortcuts` is absent in every capture (line 33 onward).
- R4: indicator text repeats: `⏵⏵ accept edits on · accept edits on` (line 161). Rule shows one indicator.
- R1: header has no `<model> with <effort> effort · <plan>` line; model shows only in the divider (line 11) and footer.
- R11: a bare `/` highlights `/advisor` (line 54) with no letters typed; rule highlights only on a letter match.
- R20: one tool call renders as two `⏺` rows, `⏺ Terminal` then `⏺ \`printf ...\`` (lines 207-208, 241-242).
- R31: spinner has no token count; rule expects `(10s · ↓ N tokens)`. Line 189 and line 211 both lack it.
- R40: dialog is two horizontal rules, not a bordered panel (lines 212-213, 222-223).
- R40: footer reads `Esc to say no`; rule says `Esc to cancel` (line 221).

## Quick wins
1. Footer: show `? for shortcuts` (R3) instead of `ctrl+/ or ctrl+^ for agents`; move the agent hotkey into help. All captures.
2. Shift+Tab indicator: render once as `⏵⏵ accept edits on`, not twice (capture 5, line 161).
3. Permission dialog: change `Esc to say no` to `Esc to cancel` and draw a real box; drop the doubled rule (lines 221-223).
4. Pause the spinner while the permission dialog waits; line 211 shows `Mulling… (10s)` while approval is pending.
5. Merge the two tool rows into one `⏺ Terminal: <cmd>` line with the `⎿` result beneath (capture 7, lines 207-208).
6. Dialog command wrap: indent continuation lines 2 spaces and break at spaces, not inside `LOOK.`/`txt` (lines 214-215).
7. Palette: wrap or truncate descriptions at word boundaries; `canvas-de`/`deep-rese` cut mid-word (lines 56-58, 60).
8. Palette noise: drop the `(carta-investors)` prefix in descriptions (lines 90-92); show namespaced skills only when `:` is typed.

## Do not copy
- Placeholder `Try "fix the failing test"` and `Claude Code wants to run a command`: codemax also runs Codex, OpenCode and Grok, so Claude-specific copy misattributes agents.
- Shift+Tab cycle list (default/acceptEdits/plan/bypass/auto): each agent exposes different modes; codemax must list each agent's own modes (capture 4 is Claude-only).
- Fixed "don't ask again for this session" option: not every agent protocol offers session-allow; render only what the agent offers.
- Queueing typed input while busy (R35) and Ctrl+Enter: depends on whether each agent accepts mid-turn input.
- Status line as a settings.json shell script (R5-R9): ties the footer to Claude config; each agent has its own.
- Claude-only command discovery and commands (`.claude/commands`, `/status`, `/tasks`, `/usage`): other agents have different command sets.

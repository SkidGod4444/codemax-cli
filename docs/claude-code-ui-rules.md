# Claude Code interactive TUI: observable rules

Sources: [IM]=https://code.claude.com/docs/en/interactive-mode, [SC]=https://code.claude.com/docs/en/commands, [SL]=https://code.claude.com/docs/en/statusline, [OS]=https://code.claude.com/docs/en/output-styles, [CW]=https://code.claude.com/docs/en/common-workflows, [CAP]=user-provided terminal captures of Claude Code 2.1.x (ground truth for glyphs/layout).

## 1. Layout and chrome
1. Startup header: ASCII logo, "Claude Code vX.Y.Z", "<model> with <effort> effort · <plan>", working directory, then the prompt. [CAP]
2. Prompt is a bordered box; placeholder text is a grey hint such as `Try "..."`. [CAP]
3. Bottom hint line reads `? for shortcuts`; `?` on empty input toggles the shortcut help panel. [CAP] [IM]
4. Mode indicator is toggled by Shift+Tab: `accept edits on`, `plan mode on` (`⏸ plan mode on`), `bypass permissions on`. [CAP] [CW]
5. Status line is one or more rows above the footer badges; it does not replace them, and with a custom one most footer hints (`esc to interrupt`, `? for shortcuts`) disappear. [SL]
6. Status line runs a shell command that gets session JSON on stdin and prints lines to stdout; each echo is a row. [SL]
7. Status line re-runs at session start, after each new assistant message, after `/compact`, on permission-mode or vim-mode change; updates are debounced 300ms. [SL]
8. Status line hides during the help menu and permission prompts; use `COLUMNS`/`LINES` env vars for width, since `tput cols` does not work. [SL]
9. Status line supports ANSI colors, OSC 8 clickable links, and `padding` (extra indent in characters); set via `/statusline` or `settings.json` `statusLine`. [SL]

## 2. Slash command UI
10. Typing `/` at the start of a message opens the command menu; text after letters filters the list live. [IM] [SC]
11. Top suggestion is highlighted only when typed letters match a command name or alias from its start or a word inside it (`:`, `_`, `-` ignored). Enter runs the highlighted item. [SC]
12. After a typo nothing is highlighted; Enter submits text as typed and reports `Unknown command`; Tab or arrows can pick a close match. [SC]
13. Mid-prompt `/` after a space also completes; in fullscreen the list opens with no row highlighted (Enter sends the prompt as typed), outside fullscreen the top match shows as ghost text with a `+N` count. [IM]
14. Tab inserts the top match; Tab on a bare mid-prompt `/` lists every command. [IM]
15. Commands run only when they start the message; text after the name becomes its arguments. [SC]
16. Skill frontmatter `argument-hint` (e.g. `[issue-number]`) is shown as a hint during autocomplete. [SC]
17. Custom commands: `.claude/commands/*.md` and `.claude/skills/<name>/SKILL.md` both create `/<name>`; subfolders become colon names (`frontend/component.md` -> `/frontend:component`). [SC]
18. Plugin skills appear as `/plugin-name:skill-name`, and a bare name still matches them. [SC] [IM]
19. Name collisions: skill beats command file; personal beats project. Commands run mid-response are queued until the turn ends (except `/status`, `/tasks`, `/usage`). [SC]

## 3. Message and tool rendering
20. Each assistant message block and each tool call starts with `⏺ ` (e.g. `⏺ Running 1 shell command…`, then `⏺ Ran 1 shell command`). [CAP]
21. Nested results hang under the tool line with `  ⎿  ` (two spaces, corner glyph, two spaces); error lines follow the same form. [CAP]
22. Shell mode (`! cmd`) shows command and output in the transcript and the output is sent to Claude as context. [IM]
23. `Ctrl+O` toggles the transcript viewer with tool detail, timestamps and model per assistant message; it also expands lines collapsed by default (e.g. `Called slack 3 times`). [IM]
24. `/focus` shows only the last prompt, a one-line tool-call summary with diffstats, and the final response. [SC]
25. Diffs: `/diff` lists changed files with added/removed line counts; the panel needs fullscreen rendering and at least 110 columns (auto-opens at 144+). [IM]
26. Diff panel rows are clickable to jump; `Ctrl+X B` cycles the comparison basis; the classic diff dialog is a bordered block above the prompt. [IM]
27. Code block syntax coloring is controlled by `Ctrl+T` inside the `/theme` picker; themes include `auto` (follows terminal background), light/dark, and colorblind-friendly variants. [IM] [SC]
28. Prompt bar color is set per session with `/color` (red, blue, green, yellow, purple, orange, pink, cyan). [SC]
29. Output styles (`Default`, `Proactive`, `Concise`, `Explanatory`, `Learning`) change response form; `Explanatory`/`Learning` add `Insight` blocks, shown with a `★ Insight ───` rule. [OS]
30. Thinking display details are not documented in these sources; `Option+T`/`Alt+T` toggles extended thinking on models where it is optional. [IM]

## 4. Working state, spinner, interruption
31. While a turn runs: spinner glyph cycles `✻ ✶ ✳ ✢ · ✽`, followed by a verb with an ellipsis (e.g. `Elucidating…`), then `(10s · ↓ 441 tokens)` and `esc to interrupt`. [CAP]
32. `Esc` interrupts mid-turn and keeps completed work; a dialog open gets closed by `Esc` first. [IM]
33. `Ctrl+C` interrupts a running operation; when idle, first press clears the prompt and second press exits. `Up` on an empty prompt restores the cleared draft. [IM]
34. `Ctrl+D` exits: first press shows a hint, second within 800ms exits; with text in the prompt it deletes the next character. [IM]
35. Typing while Claude works queues the message (listed in the transcript) instead of interrupting; `Ctrl+Enter` sends queued items now; `Up` takes them back. [IM]
36. `Esc Esc` clears a non-empty draft (saved to history); on an empty prompt it opens the rewind menu. [IM]
37. After a usage limit, Claude shows `Usage limit reached · limit resets <time>` with `esc to cancel` and continues automatically. [IM]
38. Session recap: after 3+ minutes away with terminal unfocused, a one-line summary appears on return. [IM]
39. Task checklist toggled with `Ctrl+T` shows up to five tasks; `/tasks` shows background shells and subagents. [IM]

## 5. Permission and confirmation dialogs
40. Dialogs are bordered panels naming the tool and command, with numbered options (`1. Yes`, `2. Yes, and don't ask again ... this session`, `3. No, and tell Claude what to do differently`) and `Esc to cancel`. [CAP]
41. Option order is fixed: allow once, allow-for-session when offered, then deny with feedback; `Esc` declines, same as `No`. [CAP] [IM]
42. The allow-for-session option appears only when the prompt offers it; choosing it applies to the rest of the session. [IM]
43. `Tab` on Yes or No opens a comment field for that answer; `Tab` again closes it; `Shift+Tab` closes it on file prompts. [IM]
44. `Left`/`Right` move between tabs in tabbed dialogs and menus. [IM]
45. First-run trust dialog: bordered panel, `❯ No, exit` / `Yes, I trust this folder`, footer `Enter to confirm · Esc to cancel`. [CAP]

## 6. Keyboard shortcuts (from [IM] unless noted)
46. Mode and model: `Shift+Tab` cycles default/acceptEdits/plan/(bypass, auto); `Option+P`/`Alt+P` switch model; `Option+O`/`Alt+O` fast mode; `Option+T`/`Alt+T` thinking.
47. Editing: `Ctrl+A`/`Ctrl+E` line start/end; `Ctrl+K` kill to end; `Ctrl+U` kill to start; `Ctrl+W` kill word; `Ctrl+Y` yank; `Ctrl+_` undo; `Alt+B`/`Alt+F`/`Alt+D` word moves (need Option-as-Meta on macOS).
48. History and search: `Up`/`Down` (or `Ctrl+P`/`Ctrl+N`) move through lines then history; `Ctrl+R` reverse search (`Enter` runs, `Tab`/`Esc` edits); `Ctrl+S` stashes prompt.
49. Views: `Ctrl+O` transcript; `Ctrl+L` full redraw; `Ctrl+G` or `Ctrl+X Ctrl+E` open external editor; `Ctrl+Z` suspend (Unix).
50. Input and paste: `Ctrl+V` (`Cmd+V` iTerm2, `Alt+V` Windows/WSL) pastes an image as `[Image #N]`; `Tab` accepts autocomplete.
51. Multiline: `\` then `Enter` (all terminals); `Shift+Enter` (native in several terminals); `Ctrl+J` (any terminal); `Option+Enter` after Option-as-Meta. [IM]
52. Background: `Ctrl+B` backgrounds a Bash call (tmux: press twice); `Ctrl+X Ctrl+K` stops background subagents (press twice in 3s). [IM]
53. Voice: hold `Space` for dictation (needs voice enabled). Editor mode vim is set via `/config` → Editor mode. [IM]

## 7. Feel: speed, polish, extras
54. Shell mode shows real-time progress and output while a command runs. [IM]
55. Prompt suggestions: greyed example in the empty prompt and next-prompt guesses after a reply; `Tab` or `Right` accepts, typing dismisses. [IM]
56. Autocomplete for `@` file paths (with `Tab`/`Enter` to accept), `!` shell history, and `:` emoji shortcodes. [IM] [CW]
57. Vim editor mode keeps mode and cursor when you toggle the transcript or open `/config`. [IM]
58. Mouse wheel scroll speed is adjustable with `/scroll-speed` in fullscreen mode. [SC]
59. Not covered by the cited sources: terminal title updates, notification bell, auto-scroll, response streaming. Do not copy these without verification. [IM] [SL]

## Top 10 rules to copy first
1. Header, then a bordered prompt box with a grey placeholder and a `? for shortcuts` hint line. [CAP]
2. `⏺ ` starts each message and tool line; `  ⎿  ` nests results beneath it. [CAP]
3. Working line: cycling spinner glyph, verb with `…`, elapsed time and token count, `esc to interrupt`. [CAP]
4. `Esc` interrupts and keeps work; `Ctrl+C` clears the prompt first, then exits on second press. [IM]
5. Typing while busy queues the message instead of interrupting it. [IM]
6. `/` opens a live-filtered command menu; Enter runs the highlighted item; typos are never auto-run. [SC]
7. Permission dialog: bordered, numbered options, Yes / allow-for-session / No, `Esc` declines. [CAP] [IM]
8. Shift+Tab cycles permission modes and shows an indicator line (`plan mode on`, etc.). [CAP] [CW]
9. `Ctrl+O` for a detailed transcript view; `Ctrl+R` for history search. [IM]
10. Status line as a script on stdin/stdout with debounced updates and `COLUMNS`/`LINES`. [SL]

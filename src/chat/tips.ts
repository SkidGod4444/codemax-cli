/**
 * Tips in the empty prompt: a different codemax feature after each message you send, each
 * with what to type and when it helps. Tips for things this setup cannot do (one agent
 * installed, no check command) are skipped. /config → Tips in the prompt turns them off.
 */

export interface TipContext {
  /** Installed agents with an engine. */
  agents: number;
  /** The project defines a check command (/verify can be set). */
  checks: boolean;
  /** The agent menu hotkey as shown ("ctrl+^"). */
  hotkey: string;
}

export interface Tip {
  text: string;
  when?: (c: TipContext) => boolean;
}

/** One tip per feature, a new feature gets one here. Grouped by area; shown in rotation. */
export const TIPS: Tip[] = [
  // Several agents
  { text: "Tip: /debate <goal> · 2-3 agents argue out a plan before anything is built", when: (c) => c.agents >= 2 },
  { text: "Tip: /config → Handoff order · the next agent and model take over when one hits its limit", when: (c) => c.agents >= 2 },
  { text: "Tip: /config → At a usage limit → hand off automatically, for unattended runs", when: (c) => c.agents >= 2 },
  { text: "Tip: {hotkey} or /switch changes agent · the next one picks up the task where it stopped", when: (c) => c.agents >= 2 },
  { text: "Tip: /ask <agent> <question> asks another agent without switching", when: (c) => c.agents >= 2 },
  { text: "Tip: \"routes\" in ~/.codemax/config.json sends matching messages to the agent you name", when: (c) => c.agents >= 2 },
  { text: "Tip: /config → Side agent · a second agent reviews the work and flags problems in a note" },
  { text: "Tip: /task shows the shared task: request, plan, who did what and where it stopped" },
  { text: "Tip: /compact has the agent write a project summary that every handoff includes" },
  { text: "Tip: /agents lists your agents, their sessions and how much of their limit is left" },
  // Model and permissions
  { text: "Tip: /model picks the agent's model from its own list" },
  { text: "Tip: /effort sets how hard the agent thinks, when its model offers levels" },
  { text: "Tip: Shift+Tab (or /mode) changes how often the agent asks permission" },
  { text: "Tip: in a permission prompt, Ctrl+O shows more of the diff and PgUp/PgDn scroll it" },
  { text: "Tip: /config → Agent questions · let agents stop and ask you instead of guessing" },
  // Files and code
  { text: "Tip: drop a screenshot or file here · the agent sees the image or gets the file" },
  { text: "Tip: @path attaches a file from the project to your message" },
  { text: "Tip: !<command> runs a shell command · its output goes with your next message" },
  { text: "Tip: /verify <command> runs your tests after every edit, and failures go back to the agent", when: (c) => c.checks },
  { text: "Tip: /diff shows the uncommitted changes in this repo" },
  { text: "Tip: /undo takes back the last turn's file changes" },
  { text: "Tip: Esc Esc (or /rewind) goes back to an earlier message · files (and Claude's or Codex's memory) too" },
  { text: "Tip: /checkpoints lists the snapshots taken before each message (your git is never touched)" },
  // The conversation
  { text: "Tip: ↑ recalls your earlier messages · Ctrl+R searches all of them in this project" },
  { text: "Tip: type while the agent works · messages queue, ↑ edits a queued one" },
  { text: "Tip: Ctrl+O expands thinking and output that was cut short" },
  { text: "Tip: select text with the mouse to copy it" },
  { text: "Tip: codemax --resume reopens an earlier conversation here · codemax threads lists them" },
  { text: "Tip: /new starts a fresh session with this agent · the conversation history stays" },
  { text: "Tip: helper agents the agent starts are listed under the prompt with their latest step" },
  { text: "Tip: /clear clears the screen · nothing is lost" },
  { text: "Tip: Ctrl+G writes your message in your own editor ($EDITOR) · /editor does the same" },
  { text: "Tip: /copy copies the last reply · /copy 2 the one before" },
  { text: "Tip: /export saves this conversation as Markdown" },
  // Usage, machine and codemax
  { text: "Tip: /usage shows tokens and what your subscription use would cost on the API" },
  { text: "Tip: /config → Daily budget caps the day's usage value · /budget shows where you are" },
  { text: "Tip: /awake on keeps the machine awake for long runs (lid closed: /awake lid)" },
  { text: "Tip: /config → Desktop notifications · a notice when an agent needs you while you are in another window" },
  { text: "Tip: /status shows the agent, session, thread and plan limits" },
  { text: "Tip: codemax doctor --fix checks that nothing bills an API key instead of your subscription" },
  { text: "Tip: /update installs a new codemax and restarts into this conversation" },
  { text: "Tip: /theme dark, light or auto · /config and /setup change everything else" },
  { text: "Tip: /help lists every shortcut and command" },
];


/**
 * The tip after `index` that applies here (wrapping), and its index. It fits on one line of
 * `width` columns: the "/ for commands" ending goes first, then the tip is cut with "…".
 */
export function nextTip(index: number, c: TipContext, tips: Tip[] = TIPS, width = Infinity): { text: string; index: number } {
  for (let k = 1; k <= tips.length; k++) {
    const i = (index + k) % tips.length;
    const t = tips[i]!;
    if (t.when && !t.when(c)) continue;
    const tip = t.text.replace("{hotkey}", c.hotkey);
    const full = `${tip} · / for commands`;
    const text = full.length <= width ? full : tip.length <= width ? tip : `${tip.slice(0, Math.max(10, width - 1))}…`;
    return { text, index: i };
  }
  return { text: "/ for commands", index };
}

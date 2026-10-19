import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { C, G } from "./theme.ts";

/** One question of the first-run setup: a /config setting with a line on why it matters. */
export interface OnboardingStep {
  key: string;
  label: string;
  /** One line on what the setting does for you. */
  why: string;
  /** The value now (shown as current, and where the cursor starts). */
  value: string;
  choices: { value: string; label?: string; description?: string }[];
}

/**
 * First-run setup: every /config setting, one per screen. ↑/↓ choose, Enter applies the
 * choice (it takes effect at once, like in /config) and moves on, ← goes back, Esc keeps
 * the defaults for the rest. The steps are asked for again after each answer, so a choice
 * can add or drop the questions that follow (no side agent: no side-agent details).
 */
export class Onboarding {
  readonly box: BoxRenderable;
  private header: TextRenderable;
  private title: TextRenderable;
  private why: TextRenderable;
  private rows: TextRenderable[] = [];
  private footer: TextRenderable;
  private steps: OnboardingStep[] = [];
  private index = 0;
  private cursor = 0;
  /** Keys answered so far, in order (← goes back through them). */
  private answered: string[] = [];
  private busy = false;

  constructor(
    renderer: CliRenderer,
    private o: {
      steps: () => OnboardingStep[];
      apply: (step: OnboardingStep, value: string) => Promise<void>;
      onDone: (skipped: boolean) => void;
    },
  ) {
    this.box = new BoxRenderable(renderer, { id: "onboarding", width: "100%", flexShrink: 0, border: true, borderStyle: "rounded", borderColor: C.accent, paddingX: 1, flexDirection: "column" });
    this.header = new TextRenderable(renderer, { content: "", fg: C.accent, wrapMode: "none", truncate: true, width: "100%" });
    this.title = new TextRenderable(renderer, { content: "", wrapMode: "none", truncate: true, width: "100%" });
    this.why = new TextRenderable(renderer, { content: "", fg: C.dim, wrapMode: "word", width: "100%" });
    this.footer = new TextRenderable(renderer, { content: "", fg: C.dim, wrapMode: "none", truncate: true, width: "100%" });
    this.box.add(this.header);
    this.box.add(this.title);
    this.box.add(this.why);
    this.box.add(new TextRenderable(renderer, { content: "" }));
    for (let i = 0; i < 8; i++) {
      const t = new TextRenderable(renderer, { content: "", wrapMode: "none", truncate: true, width: "100%" });
      this.rows.push(t);
      this.box.add(t);
    }
    this.box.add(new TextRenderable(renderer, { content: "" }));
    this.box.add(this.footer);
    this.steps = this.o.steps();
    this.show();
  }

  private get step(): OnboardingStep | undefined {
    return this.steps[this.index];
  }

  /** The step at `index`, with the cursor on its current value. */
  private show() {
    const st = this.step;
    if (!st) return this.o.onDone(false);
    const at = st.choices.findIndex((c) => c.value === st.value || (c.label ?? c.value) === st.value);
    this.cursor = Math.max(0, at);
    this.render();
  }

  private render() {
    const st = this.step;
    if (!st) return;
    this.header.content = `Welcome to codemax · setup ${this.index + 1} of ${this.steps.length}`;
    this.title.content = st.label;
    this.why.content = st.why;
    // Long lists scroll with the cursor.
    const n = this.rows.length;
    const offset = Math.max(0, Math.min(this.cursor - n + 1, st.choices.length - n));
    // Descriptions line up in one column.
    const w = Math.max(...st.choices.map((c) => (c.label ?? c.value).length + (c.value === st.value || (c.label ?? c.value) === st.value ? 7 : 0))) + 2;
    this.rows.forEach((row, i) => {
      const ch = st.choices[offset + i];
      row.visible = !!ch;
      if (!ch) return;
      const sel = offset + i === this.cursor;
      const now = ch.value === st.value || (ch.label ?? ch.value) === st.value;
      row.content = `${sel ? G.prompt : " "} ${`${ch.label ?? ch.value}${now ? "  (now)" : ""}`.padEnd(w)}${ch.description ?? ""}`;
      row.fg = sel ? C.accent : C.text;
    });
    const more = st.choices.length > n ? ` · ${this.cursor + 1}/${st.choices.length}` : "";
    this.footer.content = `↑↓ choose · Enter ${this.index + 1 === this.steps.length ? "finish" : "next"} · ← back · Esc keep the defaults for the rest${more} · change any of it later in /config`;
  }

  handleKey(key: KeyEvent): boolean {
    if (this.busy) return true;
    const st = this.step;
    if (!st) return true;
    const n = key.name;
    if (n === "up" || (n === "p" && key.ctrl)) {
      this.cursor = (this.cursor - 1 + st.choices.length) % st.choices.length;
      this.render();
    } else if (n === "down" || (n === "n" && key.ctrl) || n === "tab") {
      this.cursor = (this.cursor + 1) % st.choices.length;
      this.render();
    } else if (n === "left" || n === "backspace") {
      const prev = this.answered.pop();
      if (prev === undefined) return true;
      this.steps = this.o.steps();
      this.index = Math.max(0, this.steps.findIndex((s) => s.key === prev));
      this.show();
    } else if (n === "escape") {
      this.o.onDone(true);
    } else if (n === "return") {
      const choice = st.choices[this.cursor];
      if (!choice) return true;
      this.busy = true;
      void (async () => {
        try {
          if (choice.value !== st.value && (choice.label ?? choice.value) !== st.value) await this.o.apply(st, choice.value);
        } finally {
          this.busy = false;
        }
        this.answered.push(st.key);
        // The answer can change which questions follow: ask for them again, after this one.
        this.steps = this.o.steps();
        const here = this.steps.findIndex((s) => s.key === st.key);
        this.index = (here >= 0 ? here : this.index) + 1;
        this.show();
      })();
    }
    return true;
  }

  destroy() {
    this.box.destroyRecursively();
  }
}

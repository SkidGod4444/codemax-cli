import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { CliRenderer } from "@opentui/core";
import { CODEMAX_HOME, ensureDir } from "../core/paths.ts";
import { debugEvent, debugLogOn } from "../core/debuglog.ts";

/**
 * `CODEMAX_PERF=1 codemax`: a log of what made the UI slow, for lag that only shows up in a
 * real session. Each line is JSON in ~/.codemax/perf.log: keys slower than 4 ms to handle,
 * event-loop stalls over 16 ms (a key typed then waits that long), and seconds whose slowest
 * frame took over 16 ms, each with what was on screen. With the debug log on (the default)
 * these go to the debug log instead.
 */
export class PerfLog {
  private file = join(ensureDir(CODEMAX_HOME), "perf.log");
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private renderer: CliRenderer, private context: () => Record<string, unknown>) {
    this.write({ event: "start", pid: process.pid, cols: renderer.width, rows: renderer.height, term: process.env.TERM_PROGRAM ?? process.env.TERM });
    let last = performance.now();
    this.timers.push(setInterval(() => {
      const now = performance.now();
      // 20 checks a second: cheap enough to run all the time, and any stall over 16 ms still shows.
      const lag = now - last - 50;
      last = now;
      if (lag > 16) this.write({ event: "stall", ms: round(lag) });
    }, 50));
    this.timers.push(setInterval(() => {
      try {
        const s = this.renderer.getStats();
        if (s.maxFrameTime > 16) this.write({ event: "slow-frames", maxMs: round(s.maxFrameTime), avgMs: round(s.averageFrameTime), fps: s.fps });
      } catch {
        /* stats unavailable */
      }
    }, 1000));
    for (const t of this.timers) (t as any).unref?.();
    // Key → screen and selection → screen: the first frame after each one closes it.
    this.onFrame = () => this.frameDone();
    this.onSelection = () => {
      const now = performance.now();
      this.selections++;
      this.pendingSelection ??= now;
    };
    renderer.on("frame", this.onFrame);
    renderer.on("selection", this.onSelection);
    this.timers.push(setInterval(() => this.flushSecond(), 1000));
    (this.timers.at(-1) as any).unref?.();
  }

  private onFrame: () => void;
  private onSelection: () => void;
  /** Keys handled but not yet on screen: when each arrived, and its kind. */
  private pendingKeys: { at: number; kind: string }[] = [];
  private pendingSelection: number | null = null;
  private selections = 0;
  private lastKeyAt = 0;
  private burst = 0;
  /** Per second: keys, the slowest key → screen, and selection updates (logged when something was slow). */
  private second = { keys: 0, worstKeyMs: 0, worstSelectionMs: 0 };

  /**
   * A key arrived (before codemax handles it). Only its kind is kept, never which key it was:
   * letter, digit, space, punct, or the name of a special key (enter, backspace, up…).
   */
  keyIn(key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }): { kind: string; at: number } {
    const now = performance.now();
    const kind = keyKind(key);
    // Keys arriving almost together that were typed (not pasted) piled up waiting for codemax.
    if (now - this.lastKeyAt < 2) this.burst++;
    else {
      if (this.burst >= 5) this.write({ event: "keys-piled-up", count: this.burst + 1 });
      this.burst = 0;
    }
    this.lastKeyAt = now;
    this.second.keys++;
    return { kind, at: now };
  }

  /**
   * After codemax handled a printable key that should have gone into the prompt: did it?
   * `before`/`after` are the prompt's lengths (never its text).
   */
  keyLanded(k: { kind: string; at: number }, expected: boolean, before: number, after: number) {
    if (expected && after === before) this.write({ event: "key-missed", keyKind: k.kind, promptChars: before });
    // Only a key that changed the prompt must reach the screen: time it to the next frame.
    if (after !== before) {
      this.pendingKeys.push(k);
      if (this.pendingKeys.length > 200) this.pendingKeys.shift();
    }
  }

  private frameDone() {
    const now = performance.now();
    for (const k of this.pendingKeys) {
      const ms = now - k.at;
      this.second.worstKeyMs = Math.max(this.second.worstKeyMs, ms);
      if (ms > 50) this.write({ event: "slow-key-to-screen", keyKind: k.kind, ms: round(ms) });
    }
    this.pendingKeys.length = 0;
    if (this.pendingSelection !== null) {
      const ms = now - this.pendingSelection;
      this.second.worstSelectionMs = Math.max(this.second.worstSelectionMs, ms);
      if (ms > 50) this.write({ event: "slow-selection", ms: round(ms) });
      this.pendingSelection = null;
    }
  }

  private flushSecond() {
    // A key still not on screen after a second: the screen did not update at all.
    const now = performance.now();
    const stuck = this.pendingKeys.filter((k) => now - k.at > 1000);
    if (stuck.length) {
      this.write({ event: "keys-not-drawn", count: stuck.length, oldestMs: round(now - stuck[0]!.at) });
      this.pendingKeys = this.pendingKeys.filter((k) => now - k.at <= 1000);
    }
    if (this.selections > 120) this.write({ event: "selection-flood", perSecond: this.selections });
    this.selections = 0;
    this.second = { keys: 0, worstKeyMs: 0, worstSelectionMs: 0 };
  }

  key(name: string | undefined, ms: number) {
    if (ms > 4) this.write({ event: "slow-key", key: name, ms: round(ms) });
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    try {
      this.renderer.off("frame", this.onFrame);
      this.renderer.off("selection", this.onSelection);
    } catch {
      /* renderer gone */
    }
    this.write({ event: "stop" });
  }

  private write(o: Record<string, unknown>) {
    // With the debug log on, stalls go there too, so one exported file has everything.
    if (debugLogOn()) {
      const { event, ...rest } = o;
      debugEvent(`ui-${String(event)}`, { ...rest, ...this.context() });
      if (!perfEnabled()) return;
    }
    try {
      appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...o, ...this.context() }) + "\n", { mode: 0o600 });
    } catch {
      /* never in the way */
    }
  }
}

const round = (n: number) => Math.round(n * 10) / 10;

export function perfEnabled(): boolean {
  return process.env.CODEMAX_PERF === "1";
}

/** A key's kind, never the key itself (what you type stays out of every log). */
export function keyKind(key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }): string {
  const seq = key.sequence ?? "";
  const mod = key.ctrl ? "ctrl+" : key.meta ? "meta+" : "";
  if (seq.length === 1 && seq >= " " && !key.ctrl && !key.meta) {
    if (seq === " ") return "space";
    if (/[a-z]/i.test(seq)) return "letter";
    if (/[0-9]/.test(seq)) return "digit";
    return "punct";
  }
  if (seq.length > 1 && !key.name) return "text"; // several characters at once (IME, a paste without brackets)
  // With Ctrl or Alt it is a shortcut, not text: its letter can be named (ctrl+o, ctrl+r).
  const name = key.name && (key.name.length > 1 || mod) ? key.name : "key";
  return mod + name;
}

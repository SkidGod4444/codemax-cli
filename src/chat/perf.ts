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
  }

  key(name: string | undefined, ms: number) {
    if (ms > 4) this.write({ event: "slow-key", key: name, ms: round(ms) });
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
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

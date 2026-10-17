import { termSize } from "./terminal.ts";

const NESTED_SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CODEX_SANDBOX|CODEX_THREAD_ID|CURSOR_AGENT_SESSION)/;

export interface AgentProcessOptions {
  cmd: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Env vars removed from the child's environment. */
  dropEnv?: string[];
  onData: (chunk: Uint8Array) => void;
  onExit: (code: number | null) => void;
}

/** One agent TUI running inside a Bun PTY. */
export class AgentProcess {
  private term: Bun.Terminal;
  private proc: Bun.Subprocess;
  private closed = false;
  readonly startedAt = Date.now();

  constructor(private opts: AgentProcessOptions) {
    const { cols, rows } = termSize();
    this.term = new Bun.Terminal({
      cols,
      rows,
      data: (_t, chunk) => {
        if (!this.closed) opts.onData(chunk);
      },
    });
    const env: Record<string, string | undefined> = { ...process.env, TERM: process.env.TERM ?? "xterm-256color", CODEMAX: "1", ...(opts.env ?? {}) };
    for (const k of opts.dropEnv ?? []) delete env[k];
    // Never let an agent think it is a child of another agent session
    // (e.g. codemax started from inside Claude Code).
    for (const k of Object.keys(env)) if (NESTED_SESSION_ENV.test(k)) delete env[k];
    this.proc = Bun.spawn(opts.cmd, { cwd: opts.cwd, terminal: this.term, env });
    this.proc.exited.then((code) => {
      this.closed = true;
      try {
        this.term.close();
      } catch {
        /* already closed */
      }
      opts.onExit(code);
    });
  }

  get pid() {
    return this.proc.pid;
  }

  get exited() {
    return this.closed;
  }

  write(data: string | Uint8Array) {
    if (this.closed) return;
    this.term.write(data);
  }

  resize(cols: number, rows: number) {
    if (this.closed) return;
    try {
      this.term.resize(cols, rows);
    } catch {
      /* ignore */
    }
  }

  /** Force a full repaint: most TUIs redraw on SIGWINCH. */
  jiggle() {
    const { cols, rows } = termSize();
    this.resize(Math.max(20, cols - 1), rows);
    setTimeout(() => this.resize(cols, rows), 30);
  }

  async kill(graceMs = 1500): Promise<void> {
    if (this.closed) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (!this.closed) this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, graceMs);
    await this.proc.exited;
    clearTimeout(timer);
  }
}

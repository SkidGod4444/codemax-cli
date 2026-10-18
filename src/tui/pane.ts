import { EmbeddedTerminalRenderable, type CliRenderer } from "@opentui/core";
import { AgentProcess } from "../core/pty.ts";

export interface AgentPaneOptions {
  id: string;
  cmd: string[];
  cwd: string;
  env?: Record<string, string>;
  dropEnv?: string[];
  cols: number;
  rows: number;
  /** Decoded child output, for quota scanning and idle detection. */
  onOutput: (text: string) => void;
  onExit: (code: number | null) => void;
}

/**
 * One agent TUI: a PTY-backed process whose bytes are parsed by an embedded
 * virtual terminal (Ghostty VT via OpenTUI) and painted inside codemax's own
 * screen. The host terminal never sees the child's escape sequences, so alt
 * screen, mouse and keyboard modes cannot leak between agents.
 */
export class AgentPane {
  readonly terminal: EmbeddedTerminalRenderable;
  readonly proc: AgentProcess;
  private decoder = new TextDecoder();
  private destroyed = false;

  constructor(renderer: CliRenderer, opts: AgentPaneOptions) {
    this.terminal = new EmbeddedTerminalRenderable(renderer, {
      id: opts.id,
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      cols: opts.cols,
      rows: opts.rows,
      maxScrollback: 8 * 1024 * 1024,
      transparentBackground: true,
      // Both key input and the emulator's own replies (DSR, DA, colour queries) go to the child.
      onData: (data) => this.proc.write(data),
      onTerminalResize: (cols, rows) => this.proc.resize(cols, rows),
    });
    this.proc = new AgentProcess({
      cmd: opts.cmd,
      cwd: opts.cwd,
      env: { COLORTERM: "truecolor", ...(opts.env ?? {}) },
      dropEnv: opts.dropEnv,
      cols: opts.cols,
      rows: opts.rows,
      onData: (chunk) => {
        if (this.destroyed) return;
        this.terminal.write(chunk);
        opts.onOutput(this.decoder.decode(chunk, { stream: true }));
      },
      onExit: opts.onExit,
    });
  }

  get startedAt() {
    return this.proc.startedAt;
  }

  get exited() {
    return this.proc.exited;
  }

  /** Send text to the child as a paste, encoded for the child's current paste mode, then Enter. */
  paste(text: string) {
    this.proc.write(this.terminal.encodePaste(new TextEncoder().encode(text)));
    setTimeout(() => this.proc.write("\r"), 200);
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.proc.kill();
    this.terminal.destroy();
  }
}

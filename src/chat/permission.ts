import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import type { PermissionRequest } from "../engines/types.ts";
import { C, G } from "./theme.ts";

export type PermissionChoice = { optionId: string | null; tellAgent?: boolean };

/**
 * Permission dialog in Claude Code's words:
 *   1. Yes
 *   2. Yes, and don't ask again for this session   (when offered)
 *   3. No, and tell <agent> what to do differently
 * Esc = No. Option 3 denies and hands focus back to the input.
 */
export class PermissionDialog {
  readonly box: BoxRenderable;
  private cursor = 0;
  private rows: TextRenderable[] = [];
  private choices: { label: string; optionId: string | null; tellAgent?: boolean }[];

  constructor(
    renderer: CliRenderer,
    readonly request: PermissionRequest,
    agentName: string,
    private onChoice: (c: PermissionChoice) => void,
  ) {
    const once = request.options.find((o) => o.kind === "allow_once") ?? request.options.find((o) => o.kind.startsWith("allow"));
    const always = request.options.find((o) => o.kind === "allow_always");
    const reject = request.options.find((o) => o.kind === "reject_once") ?? request.options.find((o) => o.kind.startsWith("reject"));
    this.choices = [
      { label: "Yes", optionId: once?.id ?? request.options[0]!.id },
      ...(always ? [{ label: "Yes, and don't ask again for this session", optionId: always.id }] : []),
      { label: `No, and tell ${agentName} what to do differently`, optionId: reject?.id ?? null, tellAgent: true },
    ];
    this.box = new BoxRenderable(renderer, {
      id: `perm-${request.id}`,
      width: "100%",
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: C.accent,
      paddingX: 1,
      flexDirection: "column",
    });
    const what = request.title.length > 160 ? request.title.slice(0, 157) + "…" : request.title;
    this.box.add(new TextRenderable(renderer, { content: `${agentName} wants to ${verb(request.kind, what)}`, fg: C.accent }));
    this.box.add(new TextRenderable(renderer, { content: what, wrapMode: "word", width: "100%" }));
    const detail = request.detail && !request.title.includes(request.detail.split("\n")[0]!.replace(/^\w+: /, "")) ? request.detail : undefined;
    if (detail) this.box.add(new TextRenderable(renderer, { content: detail.slice(0, 500), fg: C.dim, wrapMode: "word", width: "100%" }));
    this.box.add(new TextRenderable(renderer, { content: "" }));
    this.box.add(new TextRenderable(renderer, { content: "Do you want to proceed?" }));
    this.rows = this.choices.map(() => {
      const t = new TextRenderable(renderer, { content: "", wrapMode: "none", truncate: true, width: "100%" });
      this.box.add(t);
      return t;
    });
    this.box.add(new TextRenderable(renderer, { content: "1-3 or ↑/↓ then Enter · Esc to cancel", fg: C.dim }));
    this.render();
  }

  private render() {
    this.choices.forEach((c, i) => {
      const sel = i === this.cursor;
      this.rows[i]!.content = ` ${sel ? G.prompt : " "} ${i + 1}. ${c.label}`;
      this.rows[i]!.fg = sel ? C.accent : undefined;
    });
  }

  handleKey(key: KeyEvent): boolean {
    const n = key.name;
    const len = this.choices.length;
    if (n === "up") this.cursor = (this.cursor - 1 + len) % len;
    else if (n === "down" || n === "tab") this.cursor = (this.cursor + 1) % len;
    else if (n === "return") return this.pick(this.cursor);
    else if (/^[1-9]$/.test(n) && Number(n) <= len) return this.pick(Number(n) - 1);
    // No letter shortcuts: text typed while the dialog is open must never pick an option.
    else if (n === "escape") return this.pick(len - 1);
    this.render();
    return false;
  }

  private pick(i: number): boolean {
    const c = this.choices[i]!;
    this.onChoice({ optionId: c.optionId, tellAgent: c.tellAgent });
    return true;
  }

  destroy() {
    this.box.destroyRecursively();
  }
}

function verb(kind: string | undefined, title: string): string {
  switch (kind) {
    case "execute":
      return "run a command";
    case "edit":
    case "delete":
    case "move":
      return "edit files";
    case "fetch":
      return "access the web";
    case "read":
    case "search":
      return "read files";
  }
  const t = title.toLowerCase();
  if (/^(write|edit|create|update|delete|edit files)/.test(t)) return "edit files";
  if (/^(`|bash|run|terminal|\$|command|sh\b)/.test(t)) return "run a command";
  if (/fetch|http|web/.test(t)) return "access the web";
  return "use a tool";
}

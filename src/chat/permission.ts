import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import type { PermissionRequest } from "../engines/types.ts";

/** Overlay asking the user to allow or deny one tool action. */
export class PermissionOverlay {
  readonly box: BoxRenderable;
  private cursor: number;

  constructor(
    renderer: CliRenderer,
    readonly request: PermissionRequest,
    agentName: string,
    private onChoice: (optionId: string | null) => void,
  ) {
    // Preselect the least sticky "yes": allow once. Never preselect "always".
    const once = request.options.findIndex((o) => o.kind === "allow_once");
    this.cursor = once >= 0 ? once : 0;
    const width = Math.min(Math.max(50, renderer.width - 8), 100);
    this.box = new BoxRenderable(renderer, {
      id: `perm-${request.id}`,
      position: "absolute",
      top: Math.max(1, Math.floor(renderer.height / 2) - 6),
      left: Math.floor((renderer.width - width) / 2),
      width,
      zIndex: 900,
      border: true,
      borderStyle: "rounded",
      borderColor: "#fbbf24",
      backgroundColor: "#1c1917",
      title: ` ${agentName} asks permission `,
      titleColor: "#fbbf24",
      paddingX: 1,
      flexDirection: "column",
    });
    this.box.add(new TextRenderable(renderer, { content: request.title, fg: "#fde68a", width: "100%" }));
    if (request.detail) this.box.add(new TextRenderable(renderer, { content: request.detail.slice(0, 600), fg: "#a8a29e", width: "100%" }));
    this.box.add(new TextRenderable(renderer, { content: "" }));
    this.rows = request.options.map((o, i) => {
      const t = new TextRenderable(renderer, { content: "", fg: "#e7e5e4" });
      this.box.add(t);
      return t;
    });
    this.box.add(new TextRenderable(renderer, { content: "↑/↓ or number · Enter choose · y allow once · n deny · Esc deny", fg: "#78716c" }));
    this.render();
  }

  private rows: TextRenderable[];

  private render() {
    this.request.options.forEach((o, i) => {
      const sel = i === this.cursor;
      this.rows[i]!.content = `${sel ? "›" : " "} ${i + 1}. ${o.label}${o.kind.includes("always") ? "  (remembered for this session)" : ""}`;
      this.rows[i]!.fg = sel ? "#fbbf24" : o.kind.startsWith("reject") ? "#fca5a5" : "#e7e5e4";
    });
  }

  handleKey(key: KeyEvent): boolean {
    const n = this.request.options.length;
    const byKind = (k: string) => this.request.options.find((o) => o.kind === k) ?? this.request.options.find((o) => o.kind.startsWith(k.split("_")[0]!));
    if (key.name === "up") this.cursor = (this.cursor - 1 + n) % n;
    else if (key.name === "down") this.cursor = (this.cursor + 1) % n;
    else if (key.name === "return") return this.pick(this.request.options[this.cursor]!.id);
    else if (/^[1-9]$/.test(key.name) && Number(key.name) <= n) return this.pick(this.request.options[Number(key.name) - 1]!.id);
    else if (key.name === "y") return this.pick(byKind("allow_once")?.id ?? this.request.options[0]!.id);
    else if (key.name === "a") return this.pick(byKind("allow_always")?.id ?? byKind("allow_once")?.id ?? this.request.options[0]!.id);
    else if (key.name === "n" || key.name === "escape") return this.pick(byKind("reject_once")?.id ?? null);
    this.render();
    return false;
  }

  private pick(id: string | null): boolean {
    this.onChoice(id);
    return true;
  }

  destroy() {
    this.box.destroyRecursively();
  }
}

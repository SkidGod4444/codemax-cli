import type { DetectResult } from "./types.ts";
import { platformArgv } from "../core/spawn.ts";

export async function detectBin(bin: string, versionArgs: string[] = ["--version"]): Promise<DetectResult> {
  const path = Bun.which(bin);
  if (!path) return { installed: false };
  try {
    const p = Bun.spawn(platformArgv([path, ...versionArgs]), { stdout: "pipe", stderr: "pipe" });
    const text = (await new Response(p.stdout).text()).trim();
    await p.exited;
    const m = text.match(/\d+\.\d+(\.\d+)?/);
    return { installed: true, path, version: m?.[0] ?? text.split("\n")[0] };
  } catch {
    return { installed: true, path };
  }
}

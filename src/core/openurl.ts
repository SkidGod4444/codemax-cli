import { debugEvent, errorFields } from "./debuglog.ts";

/** Open a web address in the user's browser (macOS `open`, Windows `start`, Linux `xdg-open`), without waiting. */
export function openInBrowser(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url.replace(/&/g, "^&")] : ["xdg-open", url];
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    (p as any).unref?.();
    debugEvent("open-url", { host: new URL(url).host });
    return true;
  } catch (e) {
    debugEvent("open-url-failed", { host: new URL(url).host, ...errorFields(e) });
    return false;
  }
}

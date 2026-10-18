"use client";

import { useEffect, useState } from "react";
import CopyCommand from "@/components/CopyCommand";

type Os = "unix" | "windows";

/**
 * The install one-liner for the visitor's own device: PowerShell on Windows,
 * the shell command everywhere else (macOS, Linux, phones). Server render
 * shows the shell command; Windows visitors switch right after load.
 */
export default function InstallCommand({ commands, note = false }: { commands: Record<Os, string>; note?: boolean }) {
  const [os, setOs] = useState<Os>("unix");

  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = `${nav.userAgentData?.platform ?? ""} ${navigator.platform ?? ""} ${navigator.userAgent}`;
    if (/windows|win32|win64/i.test(platform)) setTimeout(() => setOs("windows"), 0);
  }, []);

  return (
    <div>
      <CopyCommand command={commands[os]} prompt={os === "windows" ? "PS>" : "$"} />
      {note && (
        <p className="mt-3 font-mono text-[10.5px] tracking-[0.14em] text-[var(--ink-3)] uppercase">
          {os === "windows" ? "Windows · paste in PowerShell" : "macOS · Linux · paste in your terminal"} — installs Bun if you need it
        </p>
      )}
    </div>
  );
}

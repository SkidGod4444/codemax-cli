"use client";

import { useState } from "react";

export default function CopyCommand({ command, className = "" }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard blocked */
        }
      }}
      className={`group flex w-full items-center gap-3 rounded-none border border-[var(--line-strong)] bg-[var(--soft)] px-5 py-3 text-left font-mono text-sm text-[var(--ink)] transition hover:bg-[var(--hover)] ${className}`}
    >
      <span className="text-[var(--label)]">$</span>
      <span className="flex-1 truncate">{command}</span>
      <span className="text-xs text-[var(--ink-3)] transition group-hover:text-[var(--ink)]">{copied ? "copied" : "copy"}</span>
    </button>
  );
}

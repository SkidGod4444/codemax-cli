"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/**
 * A command in a terminal-style strip. Long commands scroll sideways instead of
 * being cut off; the copy button sits in its own small pink box.
 */
export default function CopyCommand({ command, prompt = "$", className = "" }: { command: string; prompt?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className={`flex w-full items-center gap-3 border border-[var(--line-strong)] bg-[var(--soft)] py-2 pr-2 pl-4 font-mono text-sm text-[var(--ink)] ${className}`}>
      <span aria-hidden className="shrink-0 text-[var(--label)] select-none">{prompt}</span>
      <code
        tabIndex={0}
        aria-label="Install command"
        className="min-w-0 flex-1 overflow-x-auto py-1 whitespace-nowrap outline-none [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]"
      >
        {command}
        <span className="inline-block w-6" />
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy install command"}
        className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--copy-bg)] px-2.5 py-1.5 text-[11px] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_2px_6px_-2px_rgb(150_12_62/0.45)] ring-1 ring-white/40 transition hover:brightness-110 active:translate-y-px"
      >
        {copied ? <Check className="size-3.5" strokeWidth={2.5} /> : <Copy className="size-3.5" strokeWidth={2} />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";

/*
 * Phone-sized navigation: the right nav cell becomes a Menu button, and a
 * full-height panel of quilted rows drops in under the nav. Closes on a link
 * tap, Escape, or when the screen grows past the tablet breakpoint.
 */
export default function MobileMenu({ links, repo }: { links: [string, string][]; repo: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const mq = window.matchMedia("(min-width: 768px)");
    const onMq = () => mq.matches && setOpen(false);
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onMq);
    return () => {
      root.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onMq);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((o) => !o)}
        className="tone-pink col-start-2 flex items-center justify-center gap-3 border-l border-[var(--line)] bg-[#ff5c8d] font-mono text-[11px] tracking-[0.18em] text-white uppercase md:hidden"
      >
        <span>{open ? "Close" : "Menu"}</span>
        <span aria-hidden className="relative block h-2.5 w-4">
          <span className={`absolute left-0 h-[1.5px] w-4 bg-white transition-transform duration-300 ${open ? "top-1/2 -translate-y-1/2 rotate-45" : "top-0"}`} />
          <span className={`absolute left-0 h-[1.5px] w-4 bg-white transition-transform duration-300 ${open ? "top-1/2 -translate-y-1/2 -rotate-45" : "bottom-0"}`} />
        </span>
      </button>

      <div
        id="mobile-menu"
        data-overlay
        className={`tone-white fixed inset-x-0 top-14 bottom-0 z-30 overflow-y-auto border-t border-[var(--line)] transition-[opacity,transform] duration-300 md:hidden ${open ? "visible translate-y-0 opacity-100" : "pointer-events-none invisible -translate-y-2 opacity-0"}`}
      >
        <nav aria-label="Sections" className="quilt grid">
          {links.map(([label, id], i) => (
            <a
              key={id}
              href={`#${id}`}
              onClick={() => setOpen(false)}
              className="flex items-baseline gap-5 border-b border-[var(--line)] px-5 py-7"
            >
              <span className="font-mono text-xs text-[var(--label)]">{String(i + 1).padStart(2, "0")}</span>
              <span className="font-serif text-4xl leading-none">{label}</span>
              <span aria-hidden className="ml-auto text-xl text-[var(--mark)]">→</span>
            </a>
          ))}
          <a
            href={repo}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
            className="tone-pink flex items-center justify-between px-5 py-7 font-mono text-xs tracking-[0.18em] text-white uppercase"
          >
            Star on GitHub <span aria-hidden className="text-xl">↗</span>
          </a>
        </nav>
      </div>
    </>
  );
}

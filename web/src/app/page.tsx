import {
  ArrowRight,
  ArrowUpRight,
  CircleDollarSign,
  FileSearch,
  Gauge,
  Handshake,
  History,
  Layers,
  MessagesSquare,
  ShieldCheck,
  Undo2,
  Wallet,
} from "lucide-react";
import AsciiArt from "@/components/AsciiArt";
import CopyCommand from "@/components/CopyCommand";
import { Logo } from "@/components/Logo";
import TerminalDemo from "@/components/TerminalDemo";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";

const REPO = "https://github.com/SkidGod4444/codemax-cli";

/* ───────────────────────── primitives */

function GitHubMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.96 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.08-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** A "+" registration mark centred on a grid intersection. */
function Cross({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`pointer-events-none absolute z-10 font-mono text-[15px] leading-none text-[var(--mark)] ${className}`}>+</span>;
}

/** One band of the page: a full-width hairline on top, crosses where it meets the frame. */
function Band({ id, children, className = "", tone = "pink" }: { id?: string; children: React.ReactNode; className?: string; tone?: "pink" | "white" }) {
  return (
    <section id={id} className={`tone-${tone} relative scroll-mt-16 border-t border-[var(--line)] ${className}`}>
      <div className="relative mx-auto max-w-[1240px] border-x border-[var(--line)]">
        <Cross className="-top-[8px] -left-[5px]" />
        <Cross className="-top-[8px] -right-[5px]" />
        {children}
      </div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[11px] tracking-[0.24em] text-[var(--label)] uppercase">{children}</p>;
}

/** Artwork set straight on the section: the halftone render with a small caption, no frame. */
function Figure({ scene, caption, n, className = "", cell, ink }: { scene: "rings" | "planet" | "cubes" | "wordmark"; caption: string; n: string; className?: string; cell?: number; ink?: string }) {
  return (
    <figure className={`relative ${className}`}>
      <div className="relative min-h-0 flex-1">
        <AsciiArt scene={scene} cell={cell} ink={ink} />
      </div>
      <figcaption className="flex items-center gap-3 pt-3 font-mono text-[10.5px] tracking-[0.2em] text-[var(--label)] uppercase">
        <span>Fig. {n}</span>
        <span aria-hidden className="h-px w-6 bg-[var(--line-strong)]" />
        <span className="truncate">{caption}</span>
      </figcaption>
    </figure>
  );
}

/* ───────────────────────── content */

const agents = [
  { name: "Claude Code", plan: "Claude Pro & Max", status: "Supported" },
  { name: "Codex", plan: "ChatGPT Plus & Pro", status: "Supported" },
  { name: "OpenCode", plan: "Your OpenCode login", status: "Supported" },
  { name: "Grok", plan: "SuperGrok", status: "Supported" },
  { name: "Gemini CLI", plan: "Google AI plans", status: "Coming soon" },
  { name: "Cursor · Copilot", plan: "Cursor & GitHub plans", status: "Coming soon" },
] as const;

const features = [
  { icon: Handshake, title: "Never stalls on a limit", body: "When one agent runs out mid-task, the next one carries on with the request you were working on." },
  { icon: History, title: "Context that follows you", body: "Every agent sees what the others did: the conversation, the changes, what's still to do." },
  { icon: Wallet, title: "Daily budgets", body: "Decide how much of each plan to use per day. codemax hands off before you hit the wall." },
  { icon: CircleDollarSign, title: "See what you get", body: "Know exactly how much work each subscription is doing for you, side by side." },
  { icon: Undo2, title: "One-step undo", body: "Didn't like what an agent changed? Roll its last turn back instantly." },
  { icon: MessagesSquare, title: "Second opinions", body: "Ask another agent a quick question without leaving the one you're working with." },
  { icon: FileSearch, title: "Bring any file", body: "Type @ and pick a file; every agent gets it in context." },
  { icon: ShieldCheck, title: "You stay in charge", body: "Agents still ask before they edit or run anything. Nothing happens behind your back." },
];

const faqs = [
  { q: "Will codemax cost me extra?", a: "No. codemax is free and open source, and it only uses the subscriptions you already pay for. It never bills an API key, and it warns you if anything on your machine would." },
  { q: "Does it replace Claude Code or Codex?", a: "No. Those agents still do the work. codemax is the one place you use them from, so you can move between them freely and never start from scratch." },
  { q: "Is my code safe?", a: "Everything runs on your machine. Your code goes only to the agents you already use, under your own accounts, and every edit asks for your approval first." },
  { q: "Which agents does it work with?", a: "Claude Code, Codex, OpenCode and Grok today, with Gemini CLI, Cursor and Copilot next." },
  { q: "Who is it for?", a: "Developers who pay for more than one AI coding plan and are tired of hitting a limit in the middle of real work." },
];

/* ───────────────────────── page */

export default function Home() {
  return (
    <main className="min-h-svh bg-white">
      {/* nav */}
      <header className="tone-white sticky top-0 z-40 border-b border-[var(--line)] !bg-white">
        <nav className="mx-auto flex h-14 max-w-[1240px] items-center justify-between border-x border-[var(--line)] px-5 sm:px-8">
          <a href="#" aria-label="codemax home" className="-ml-5 flex h-full items-center self-stretch border-r border-[var(--line)] bg-[#ff5c8d] px-6 transition-colors hover:bg-[#f24a80] sm:-ml-8 sm:px-8">
            <Logo className="h-[18px] w-auto" color="#ffffff" />
          </a>
          <div className="hidden gap-8 font-mono text-[11px] tracking-[0.2em] uppercase md:flex">
            {[["Why", "why"], ["Agents", "agents"], ["Features", "features"], ["Get started", "start"]].map(([l, id]) => (
              <a key={id} href={`#${id}`} className="text-[var(--ink-3)] transition hover:text-[var(--ink)]">/ {l}</a>
            ))}
          </div>
          <a href={REPO} target="_blank" rel="noreferrer" className="-mr-5 flex h-full items-center gap-2 self-stretch border-l border-[var(--line)] bg-[#ff5c8d] px-6 font-mono text-[11px] tracking-[0.18em] text-white uppercase transition-colors hover:bg-[#f24a80] sm:-mr-8 sm:px-8">
            <GitHubMark /> Star on GitHub
          </a>
        </nav>
      </header>

      {/* hero */}
      <Band className="border-t-0">
        <div className="grid lg:grid-cols-[1fr_1.05fr]">
          <div className="flex flex-col justify-center px-5 py-16 sm:px-10 lg:py-24">
            <Label>Free · Open source</Label>
            <h1 className="mt-6 text-[clamp(3rem,5.8vw,5rem)] leading-[0.95] font-serif font-normal tracking-[-0.02em] text-balance">
              Every AI coding plan you pay for. One terminal.
            </h1>
            <p className="mt-6 max-w-md text-[17px] leading-relaxed text-pretty text-[var(--ink-2)]">
              Use Claude, Codex, Grok and more side by side. When one hits its limit, the next carries on with your task — same context, no restart.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button size="lg" className="rounded-none px-6" render={<a href="#start" />}>
                Get codemax free <ArrowRight />
              </Button>
              <Button size="lg" variant="outline" className="rounded-none border-[var(--line-strong)] bg-transparent px-6 text-[var(--ink)] hover:bg-[var(--hover)]" render={<a href={REPO} target="_blank" rel="noreferrer" />}>
                <GitHubMark /> Star on GitHub
              </Button>
            </div>
          </div>
          <div className="border-t border-[var(--line)] p-5 sm:p-8 lg:border-t-0 lg:border-l">
            <Figure scene="rings" n="01" caption="Five agents, one chain" className="flex aspect-[5/4] flex-col" cell={6} />
          </div>
        </div>
        {/* stat row */}
        <div className="grid grid-cols-2 border-t border-[var(--line)] md:grid-cols-4">
          {[
            ["Coding agents", "4+"],
            ["Plans you can combine", "All"],
            ["Extra cost", "$0"],
            ["Restarts after a limit", "None"],
          ].map(([k, v], i) => (
            <div key={k} className={`px-5 py-6 sm:px-8 ${i % 2 ? "border-l border-[var(--line)]" : ""} ${i === 2 ? "md:border-l" : ""} ${i > 1 ? "border-t border-[var(--line)] md:border-t-0" : ""}`}>
              <Label>{k}</Label>
              <p className="mt-2 font-serif text-4xl">{v}</p>
            </div>
          ))}
        </div>
      </Band>

      {/* handoff */}
      <Band id="why" tone="white">
        <div className="grid lg:grid-cols-[0.9fr_1.1fr]">
          <div className="px-5 py-16 sm:px-10 lg:py-24">
            <Label>The problem</Label>
            <h2 className="mt-5 text-[clamp(2.4rem,4.2vw,3.6rem)] leading-[1] font-serif font-normal tracking-[-0.015em] text-balance">Limits always hit mid-task.</h2>
            <p className="mt-5 max-w-md text-pretty text-[var(--ink-2)]">
              You pay for two or three AI coding plans, yet you still get stopped: one runs dry, and switching means re-explaining your whole project. With codemax, your work simply moves to the next agent and keeps going.
            </p>
            <ol className="mt-10 border-t border-[var(--line)]">
              {[
                ["01", "Claude reaches its limit", "codemax offers to continue elsewhere"],
                ["02", "Press Enter", "Codex picks up the exact task, fully briefed"],
                ["03", "Keep shipping", "same project, same history, no restart"],
              ].map(([n, a, b]) => (
                <li key={n} className="flex gap-5 border-b border-[var(--line)] py-4">
                  <span className="font-mono text-xs text-[var(--ink-3)]">{n}</span>
                  <span className="text-sm"><span className="font-medium">{a}</span><span className="text-[var(--ink-3)]"> — {b}</span></span>
                </li>
              ))}
            </ol>
          </div>
          <div className="border-t border-[var(--line)] bg-[#ef4a80] p-5 sm:p-10 lg:border-t-0 lg:border-l lg:py-16">
            <TerminalDemo />
          </div>
        </div>
      </Band>

      {/* principles */}
      <Band>
        <div className="grid md:grid-cols-3">
          {[
            { icon: Layers, title: "Get the most from every plan", body: "Stop letting one subscription sit idle while another runs out. Use all of them, from one place." },
            { icon: Gauge, title: "Stay in flow", body: "No more copy-pasting context into a new tool. Your task, history and changes travel with you." },
            { icon: ShieldCheck, title: "No surprise bills", body: "codemax only ever uses the plans you already pay for. Never a pay-per-token API key." },
          ].map(({ icon: Icon, title, body }, i) => (
            <div key={title} className={`px-5 py-12 sm:px-8 ${i ? "border-t border-[var(--line)] md:border-t-0 md:border-l" : ""}`}>
              <Icon className="size-6" strokeWidth={1.5} />
              <h3 className="mt-8 text-xl font-semibold tracking-tight">{title}</h3>
              <p className="mt-3 text-pretty text-[var(--ink-2)]">{body}</p>
            </div>
          ))}
        </div>
      </Band>

      {/* agents */}
      <Band id="agents" tone="white">
        <div className="grid lg:grid-cols-[1.05fr_1fr]">
          <div className="order-2 border-t border-[var(--line)] p-5 sm:p-8 lg:order-1 lg:border-t-0 lg:border-r">
            <Figure scene="planet" n="02" caption="One hub, every agent" className="flex aspect-square flex-col" cell={6} ink="255,79,134" />
          </div>
          <div className="order-1 flex flex-col justify-center px-5 py-16 sm:px-10 lg:order-2">
            <Label>Agents</Label>
            <h2 className="mt-5 text-[clamp(2.4rem,4.2vw,3.6rem)] leading-[1] font-serif font-normal tracking-[-0.015em] text-balance">Works with the agents you already pay for.</h2>
            <p className="mt-5 max-w-md text-pretty text-[var(--ink-2)]">Sign in once with each, the way you do today. codemax brings them together.</p>
            <ul className="mt-10 border-t border-[var(--line)]">
              {agents.map((a) => (
                <li key={a.name} className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-[var(--line)] py-3.5 sm:grid-cols-[1fr_1fr_auto]">
                  <span className="font-medium">{a.name}</span>
                  <span className="hidden text-sm text-[var(--ink-3)] sm:block">{a.plan}</span>
                  <span className={`px-2 py-0.5 font-mono text-[10.5px] tracking-[0.12em] uppercase ${a.status === "Supported" ? "bg-[var(--pill-bg)] text-[var(--pill-fg)]" : "border border-[var(--line-strong)]"}`}>{a.status}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Band>

      {/* features */}
      <Band id="features">
        <div className="grid lg:grid-cols-[1fr_0.75fr]">
          <div className="flex flex-col justify-center px-5 py-16 sm:px-10">
            <Label>Features</Label>
            <h2 className="mt-5 text-[clamp(2.4rem,4.2vw,3.6rem)] leading-[1] font-serif font-normal tracking-[-0.015em] text-balance">Everything you need to keep shipping.</h2>
            <p className="mt-5 max-w-md text-pretty text-[var(--ink-2)]">
              The agents you love, plus the things none of them can do alone.
            </p>
          </div>
          <div className="border-t border-[var(--line)] p-5 sm:p-8 lg:border-t-0 lg:border-l">
            <Figure scene="cubes" n="03" caption="Pieces that fit together" className="flex aspect-square flex-col" cell={6} />
          </div>
        </div>
        <div className="grid border-t border-[var(--line)] sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, title, body }, i) => (
            <div key={title} className={`relative px-6 py-8 ${i % 4 ? "lg:border-l" : ""} ${i % 2 ? "sm:border-l" : ""} ${i >= 2 ? "border-t sm:border-t" : ""} ${i < 4 ? "lg:border-t-0" : ""} ${i === 1 ? "border-t sm:border-t-0" : ""} border-[var(--line)]`}>
              <Icon className="size-5" strokeWidth={1.6} />
              <h3 className="mt-6 font-semibold tracking-tight">{title}</h3>
              <p className="mt-2 text-sm text-pretty text-[var(--ink-2)]">{body}</p>
            </div>
          ))}
        </div>
      </Band>

      {/* start + faq */}
      <Band id="start" tone="white">
        <div className="grid lg:grid-cols-2">
          <div className="px-5 py-16 sm:px-10 lg:py-20">
            <Label>Get started</Label>
            <h2 className="mt-5 text-[clamp(2.4rem,4.2vw,3.6rem)] leading-[1] font-serif font-normal tracking-[-0.015em] text-balance">Up and running in a minute.</h2>
            <p className="mt-5 max-w-md text-pretty text-[var(--ink-2)]">Free and open source. Uses the logins you already have — nothing new to sign up for.</p>
            <div className="mt-8 max-w-lg"><CopyCommand command="git clone https://github.com/SkidGod4444/codemax-cli && cd codemax-cli && bun i && bun link" /></div>
            <ol className="mt-8 max-w-lg border-t border-[var(--line)]">
              {[
                ["01", "Install codemax", "one command, about a minute"],
                ["02", "Open your project", "run codemax in any repo"],
                ["03", "Just ask", "switch agents any time with one key"],
              ].map(([n, a, b]) => (
                <li key={n} className="flex gap-5 border-b border-[var(--line)] py-4">
                  <span className="font-mono text-xs text-[var(--ink-3)]">{n}</span>
                  <span className="text-sm"><span className="font-medium">{a}</span><span className="text-[var(--ink-3)]"> — {b}</span></span>
                </li>
              ))}
            </ol>
          </div>
          <div className="border-t border-[var(--line)] px-5 py-16 sm:px-10 lg:border-t-0 lg:border-l lg:py-20">
            <Label>Questions</Label>
            <h2 className="mt-5 text-[clamp(2.4rem,4.2vw,3.6rem)] leading-[1] font-serif font-normal tracking-[-0.015em]">Good to know.</h2>
            <Accordion className="mt-8">
              {faqs.map((f) => (
                <AccordionItem key={f.q} value={f.q} className="border-[var(--line)]">
                  <AccordionTrigger className="text-left text-base text-[var(--ink)]">{f.q}</AccordionTrigger>
                  <AccordionPanel className="text-pretty text-[var(--ink-2)]">{f.a}</AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </div>
      </Band>

      {/* closing */}
      <Band>
        <div className="px-5 pt-20 pb-12 text-center sm:px-10">
          <h2 className="mx-auto max-w-2xl text-[clamp(2.6rem,5vw,4.2rem)] leading-[0.98] font-serif font-normal tracking-[-0.015em] text-balance">Stop babysitting usage limits.</h2>
          <p className="mx-auto mt-5 max-w-md text-pretty text-[var(--ink-2)]">Get the full value of every AI plan you pay for — and never lose your flow to a limit again.</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="rounded-none px-6" render={<a href="#start" />}>
              Get codemax free <ArrowRight />
            </Button>
            <Button size="lg" variant="outline" className="rounded-none border-[var(--line-strong)] bg-transparent px-6 text-[var(--ink)] hover:bg-[var(--hover)]" render={<a href={REPO} target="_blank" rel="noreferrer" />}>
              <GitHubMark /> Star on GitHub <ArrowUpRight />
            </Button>
          </div>
        </div>
        <div className="px-5 pb-8 sm:px-8">
          <Figure scene="wordmark" n="04" caption="codemax" className="flex aspect-[4/1] flex-col" cell={8} />
        </div>
      </Band>

      <footer className="tone-white border-t border-[var(--line)]">
        <div className="mx-auto flex max-w-[1240px] flex-col items-center justify-between gap-2 border-x border-[var(--line)] px-5 py-6 font-mono text-[11px] tracking-[0.14em] text-[var(--ink-3)] uppercase sm:flex-row sm:px-8">
          <span className="inline-flex items-center gap-3"><Logo className="h-3.5 w-auto" /> · Apache 2.0</span>
          <span>Not affiliated with Anthropic, OpenAI, xAI or Google</span>
        </div>
      </footer>
    </main>
  );
}

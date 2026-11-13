import {
  ArrowRight,
  ArrowUpRight,
  CircleDollarSign,
  Gauge,
  Handshake,
  Eye,
  History,
  Hourglass,
  Layers,
  ListChecks,
  Scale,
  Share2,
  Package,
  ShieldCheck,
  Undo2,
  Users,
  Wallet,
} from "lucide-react";
import AsciiArt from "@/components/AsciiArt";
import InstallCommand from "@/components/InstallCommand";
import { Logo } from "@/components/Logo";
import MobileMenu from "@/components/MobileMenu";
import TerminalDemo from "@/components/TerminalDemo";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";

import { Suspense } from "react";
import { count, downloads, KNOWN, type Downloads } from "@/lib/downloads";
import { INSTALL_COMMANDS, SITE } from "@/lib/site";

const REPO = SITE.github;
const NAV: [string, string][] = [["Why", "why"], ["Agents", "agents"], ["Features", "features"], ["Get started", "start"]];

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
  return <span aria-hidden className={`tuft ${className}`} />;
}

/**
 * "+" marks where interior grid lines meet a horizontal line. Every section
 * splits on the same 4-column grid (25 / 50 / 75 %), so the vertical lines
 * run straight down the page and these crosses sit on true intersections.
 */
function Marks({ at, from = "lg" }: { at: number[]; from?: "md" | "lg" }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 hidden ${from === "md" ? "md:block" : "lg:block"}`}>
      {at.map((x) => (
        <span key={x} className="tuft top-0" style={{ left: `${x}%` }} />
      ))}
    </div>
  );
}

/** One band of the page: a full-width hairline on top, crosses where it meets the frame. */
function Band({ id, children, className = "", tone = "pink", marks, corners = true }: { id?: string; children: React.ReactNode; className?: string; tone?: "pink" | "white"; marks?: number[]; corners?: boolean }) {
  return (
    <section id={id} className={`tone-${tone} relative scroll-mt-16 border-t border-[var(--line)] ${className}`}>
      <div className="relative mx-auto max-w-[1240px] border-x border-[var(--line)]">
        {corners && <Cross className="top-0 left-0" />}
        {corners && <Cross className="top-0 left-full" />}
        {marks && <Marks at={marks} />}
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
  { name: "Cursor", plan: "Cursor plans", status: "Supported" },
  { name: "Antigravity CLI", plan: "Google AI plans", status: "Supported" },
  { name: "Copilot CLI", plan: "GitHub Copilot plans", status: "Supported" },
] as const;

const features = [
  { icon: Handshake, title: "Never stalls on a limit", body: "When one agent runs out mid-task, the next one carries on with the request you were working on." },
  { icon: History, title: "Context that follows you", body: "Every agent sees what the others did: the conversation, the changes, what's still to do." },
  { icon: Users, title: "A team on one task", body: "Ask for a team: your agent splits the work, several agents build their parts at the same time, and you get one checked result." },
  { icon: Scale, title: "Plans argued out first", body: "Have two or three agents each propose a plan, challenge the others and settle on the best one before anything is built." },
  { icon: Hourglass, title: "Waits out a limit", body: "Every plan used up? codemax waits for the first one to reset and carries on with the task by itself." },
  { icon: Share2, title: "Your setup, everywhere", body: "Project rules, custom commands, skills and connected tools you set up for one agent work in all of them." },
  { icon: Eye, title: "A second pair of eyes", body: "A second agent reads the work after each step and speaks up only when something looks wrong. Or ask one a quick question any time." },
  { icon: ListChecks, title: "Tests after every change", body: "Your own test command runs after each change, and a failure goes straight back to the agent to fix." },
  { icon: Undo2, title: "Undo and rewind", body: "Didn't like a change? Undo the last turn, or go back to any earlier message, files included." },
  { icon: Wallet, title: "Daily budgets", body: "Decide how much of each plan to use per day. codemax hands off before you hit the wall." },
  { icon: CircleDollarSign, title: "See what you get", body: "Know exactly how much work each subscription is doing for you, side by side." },
  { icon: ShieldCheck, title: "You stay in charge", body: "Agents ask before they edit or run anything. Trust a task? Turn the questions off for that one run." },
];

const faqs = [
  { q: "Will codemax cost me extra?", a: "No. codemax is free and open source, and it only uses the subscriptions you already pay for. It never bills an API key, and it warns you if anything on your machine would." },
  { q: "Does it replace Claude Code or Codex?", a: "No. Those agents still do the work. codemax is the one place you use them from, so you can move between them freely and never start from scratch." },
  { q: "Is my code safe?", a: "Everything runs on your machine. Your code goes only to the agents you already use, under your own accounts. Agents ask before they change or run anything, unless you turn that off yourself for a run." },
  { q: "Can several agents work on one task?", a: "Yes. Ask for a team and your agent splits the task, each agent builds its part at the same time in its own copy of your project, and the parts are merged and checked. Your own files change only at the end." },
  { q: "What if every plan runs out?", a: "codemax waits for the first limit to reset and continues the task on its own. You can also set a daily budget per plan so that never happens." },
  { q: "Which agents does it work with?", a: "Claude Code, Codex, OpenCode, Grok, Cursor, Google's Antigravity CLI and GitHub Copilot CLI." },
  { q: "Who is it for?", a: "Developers who pay for more than one AI coding plan and are tired of hitting a limit in the middle of real work." },
];

/** Every download npm and GitHub count, added up (refreshed about hourly). */
async function TotalDownloads() {
  return <>{count((await downloads()).total)}</>;
}

/** Where the downloads come from: one badge for npm, one for GitHub, each linking to the place that counts it. */
function DownloadBadgeRow({ d }: { d: Downloads }) {
  const badge = "inline-flex cursor-pointer items-center gap-2 border border-[var(--line-strong)] px-2.5 py-1.5 font-mono text-[10.5px] tracking-[0.12em] text-[var(--ink-2)] uppercase transition-colors hover:bg-[var(--hover)]";
  const n = "font-medium text-[var(--ink)] tabular-nums";
  return (
    <div className="flex flex-wrap gap-2">
      <a className={badge} href="https://www.npmjs.com/package/codemax-cli" target="_blank" rel="noreferrer" aria-label={`${count(d.npm)} downloads on npm`}>
        <Package className="size-3.5" aria-hidden />
        npm <span className={n}>{count(d.npm)}</span> downloads
        {d.npmWeek > 0 && (
          <span className="border-l border-[var(--line-strong)] pl-2">
            <span className={n}>{count(d.npmWeek)}</span> this week
          </span>
        )}
      </a>
      <a className={badge} href={`${SITE.repo}/releases`} target="_blank" rel="noreferrer" aria-label={`${count(d.github)} downloads on GitHub`}>
        <GitHubMark className="size-3.5" />
        GitHub <span className={n}>{count(d.github)}</span> downloads
      </a>
    </div>
  );
}

async function DownloadBadges() {
  return <DownloadBadgeRow d={await downloads()} />;
}

/** Structured data: the app itself, plus the FAQ for rich results. */
function JsonLd() {
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: SITE.name,
      description: SITE.description,
      url: SITE.url,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      license: "https://www.gnu.org/licenses/agpl-3.0.html",
      sameAs: [SITE.repo],
      author: { "@type": "Person", name: SITE.author.name, url: SITE.author.url },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}

/* ───────────────────────── page */

export default function Home() {
  return (
    <main className="min-h-svh overflow-x-clip bg-white">
      <JsonLd />
      {/* nav */}
      <header className="tone-white sticky top-0 z-40 border-b border-[var(--line)] !bg-white">
        <div aria-hidden className="pointer-events-none relative mx-auto max-w-[1240px]">
          <span className="tuft top-14 left-0" />
          <span className="tuft top-14 left-full" />
          <span className="tuft top-14 left-1/2 md:hidden" />
          <span className="tuft top-14 left-1/4 hidden md:block" />
          <span className="tuft top-14 left-3/4 hidden md:block" />
          <span className="tuft top-14 left-1/2 hidden lg:block" />
        </div>
        <nav className="quilt mx-auto grid h-14 max-w-[1240px] grid-cols-2 border-x border-[var(--line)] md:grid-cols-4">
          <div className="tone-pink flex items-center border-r border-[var(--line)] bg-[#ff5c8d] px-5 transition-colors hover:bg-[#f24a80] sm:px-10">
            <a href="#" aria-label="codemax home">
              <Logo className="h-[18px] w-auto" color="#ffffff" />
            </a>
          </div>
          <div className="hidden items-center justify-center gap-4 font-mono text-[10.5px] tracking-[0.1em] whitespace-nowrap uppercase md:col-span-2 md:flex lg:gap-8 lg:text-[11px] lg:tracking-[0.2em]">
            {NAV.map(([l, id]) => (
              <a key={id} href={`#${id}`} className="text-[var(--ink-3)] transition hover:text-[var(--ink)]">/ {l}</a>
            ))}
          </div>
          <a href={REPO} target="_blank" rel="noreferrer" className="tone-pink hidden items-center justify-center gap-2 border-l border-[var(--line)] bg-[#ff5c8d] px-5 font-mono text-[11px] tracking-[0.18em] text-white uppercase transition-colors hover:bg-[#f24a80] md:col-start-4 md:flex">
            <GitHubMark /> Star on GitHub
          </a>
          <MobileMenu links={NAV} repo={REPO} />
        </nav>
      </header>

      {/* hero */}
      <Band className="border-t-0" corners={false}>
        <div className="quilt grid lg:grid-cols-2">
          <div className="flex flex-col justify-center px-5 py-16 sm:px-10 lg:py-24">
            <Label>Free · Open source</Label>
            <h1 className="mt-6 text-[clamp(3rem,5.8vw,5rem)] leading-[0.95] font-serif font-normal tracking-[-0.02em] text-balance">
              Every AI coding plan you pay for. One terminal.
            </h1>
            <p className="mt-6 max-w-md text-[17px] leading-relaxed text-pretty text-[var(--ink-2)]">
              Use Claude, Codex, Antigravity and more side by side. When one hits its limit, the next carries on with your task — same context, no restart.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button size="lg" className="rounded-none px-6" render={<a href="#start" />}>
                Get codemax free <ArrowRight />
              </Button>
              <Button size="lg" variant="outline" className="rounded-none border-[var(--line-strong)] bg-transparent px-6 text-[var(--ink)] hover:bg-[var(--hover)]" render={<a href={REPO} target="_blank" rel="noreferrer" />}>
                <GitHubMark /> Star on GitHub
              </Button>
            </div>
            <div className="mt-6 max-w-md">
              <InstallCommand commands={INSTALL_COMMANDS} />
            </div>
            <div className="mt-4">
              <Suspense fallback={<DownloadBadgeRow d={KNOWN} />}>
                <DownloadBadges />
              </Suspense>
            </div>
          </div>
          <div className="border-t border-[var(--line)] p-5 sm:p-8 lg:border-t-0 lg:border-l">
            <Figure scene="rings" n="01" caption="Seven agents, one chain" className="flex aspect-[4/3] flex-col sm:aspect-[16/9] lg:aspect-[5/4]" cell={6} />
          </div>
        </div>
        {/* stat row */}
        <div className="quilt relative grid grid-cols-2 border-t border-[var(--line)] md:grid-cols-4">
          <Marks at={[25, 50, 75]} from="md" />
          {(
            [
              ["Downloads", <Suspense key="d" fallback={count(KNOWN.total)}><TotalDownloads /></Suspense>],
              ["Coding agents", "7"],
              ["Extra cost", "$0"],
              ["Restarts after a limit", "None"],
            ] as [string, React.ReactNode][]
          ).map(([k, v], i) => (
            <div key={k} className={`px-5 py-6 sm:px-8 ${i % 2 ? "border-l border-[var(--line)]" : ""} ${i === 2 ? "md:border-l" : ""} ${i > 1 ? "border-t border-[var(--line)] md:border-t-0" : ""}`}>
              <Label>{k}</Label>
              <p className="mt-2 font-serif text-4xl">{v}</p>
            </div>
          ))}
        </div>
      </Band>

      {/* handoff */}
      <Band id="why" tone="white" marks={[25, 50, 75]}>
        <div className="quilt grid lg:grid-cols-2">
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
          <div className="border-t border-[var(--line)] bg-[#ef4a80] p-5 sm:p-8 lg:border-t-0 lg:border-l lg:py-12">
            <TerminalDemo />
          </div>
        </div>
      </Band>

      {/* principles */}
      <Band>
        <Marks at={[25, 50, 75]} from="md" />
        <div className="quilt grid md:grid-cols-4">
          <div className="px-5 py-12 sm:px-8">
            <Label>Why codemax</Label>
            <p className="mt-8 font-serif text-3xl leading-[1.05]">Three reasons people switch.</p>
          </div>
          {[
            { icon: Layers, title: "Get the most from every plan", body: "Stop letting one subscription sit idle while another runs out. Use all of them, from one place." },
            { icon: Gauge, title: "Stay in flow", body: "No more copy-pasting context into a new tool. Your task, history and changes travel with you." },
            { icon: ShieldCheck, title: "No surprise bills", body: "codemax only ever uses the plans you already pay for. Never a pay-per-token API key." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className={`border-t border-[var(--line)] px-5 py-12 sm:px-8 md:border-t-0 md:border-l`}>
              <Icon className="size-6" strokeWidth={1.5} />
              <h3 className="mt-8 text-xl font-semibold tracking-tight">{title}</h3>
              <p className="mt-3 text-pretty text-[var(--ink-2)]">{body}</p>
            </div>
          ))}
        </div>
      </Band>

      {/* agents */}
      <Band id="agents" tone="white" marks={[25, 50, 75]}>
        <div className="quilt grid lg:grid-cols-2">
          <div className="order-2 border-t border-[var(--line)] p-5 sm:p-8 lg:order-1 lg:border-t-0 lg:border-r">
            <Figure scene="planet" n="02" caption="One hub, every agent" className="flex aspect-square flex-col sm:aspect-[16/10] lg:aspect-square" cell={6} ink="255,79,134" />
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
      <Band id="features" marks={[50]}>
        <div className="quilt grid lg:grid-cols-2">
          <div className="flex flex-col justify-center px-5 py-16 sm:px-10">
            <Label>Features</Label>
            <h2 className="mt-5 text-[clamp(2.4rem,4.2vw,3.6rem)] leading-[1] font-serif font-normal tracking-[-0.015em] text-balance">Everything you need to keep shipping.</h2>
            <p className="mt-5 max-w-md text-pretty text-[var(--ink-2)]">
              The agents you love, plus the things none of them can do alone.
            </p>
          </div>
          <div className="border-t border-[var(--line)] p-5 sm:p-8 lg:border-t-0 lg:border-l">
            <Figure scene="cubes" n="03" caption="Pieces that fit together" className="flex aspect-square flex-col sm:aspect-[16/10] lg:aspect-square" cell={6} />
          </div>
        </div>
        <div className="quilt relative grid border-t border-[var(--line)] sm:grid-cols-2 lg:grid-cols-4">
          <Marks at={[25, 50, 75]} />
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
      <Band id="start" tone="white" marks={[25, 50, 75]}>
        <div className="quilt grid lg:grid-cols-2">
          <div className="px-5 py-16 sm:px-10 lg:py-20">
            <Label>Get started</Label>
            <h2 className="mt-5 text-[clamp(2.4rem,4.2vw,3.6rem)] leading-[1] font-serif font-normal tracking-[-0.015em] text-balance">Up and running in a minute.</h2>
            <p className="mt-5 max-w-md text-pretty text-[var(--ink-2)]">Free and open source. Uses the logins you already have — nothing new to sign up for.</p>
            <div className="mt-8 max-w-lg">
              <InstallCommand commands={INSTALL_COMMANDS} note />
            </div>
            <ol className="mt-8 max-w-lg border-t border-[var(--line)]">
              {[
                ["01", "Install with npm", "one command on macOS, Linux or Windows"],
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
      <Band marks={[50]}>
        <div className="quilt-cell">
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
        </div>
      </Band>

      <footer className="tone-white border-t border-[var(--line)]">
        <div className="quilt relative mx-auto grid max-w-[1240px] border-x border-[var(--line)] font-mono text-[11px] tracking-[0.14em] text-[var(--ink-3)] uppercase md:grid-cols-2">
          <Cross className="top-0 left-0" />
          <Cross className="top-0 left-full" />
          <Cross className="top-full left-0" />
          <Cross className="top-full left-full" />
          <Marks at={[50]} from="md" />
          <span aria-hidden className="tuft top-full left-1/2 hidden md:block" />
          <span className="inline-flex flex-wrap items-center gap-3 px-5 py-6 sm:px-10">
            <Logo className="h-3.5 w-auto" /> · AGPL-3.0 ·
            <a href="https://saidev.codes" target="_blank" rel="noreferrer" className="text-[var(--label)] underline-offset-4 transition hover:text-[var(--ink)] hover:underline">by Saidev Dhal</a>
          </span>
          <span className="border-t border-[var(--line)] px-5 py-6 sm:px-10 md:border-t-0 md:border-l md:text-right">Not affiliated with Anthropic, OpenAI, xAI, Google, Cursor or GitHub</span>
        </div>
      </footer>
    </main>
  );
}

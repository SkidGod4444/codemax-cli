type Line = { k: "user" | "agent" | "tool" | "nest" | "done" | "rule" | "warn" | "add" | "del"; t: string };

const SCRIPT: Line[] = [
  { k: "user", t: "fix the failing auth test in @src/auth.ts" },
  { k: "agent", t: "Reading the test and the token check." },
  { k: "tool", t: "Edit src/auth.ts" },
  { k: "del", t: "-  if (exp < now) return true" },
  { k: "add", t: "+  if (exp <= now) return false" },
  { k: "agent", t: "Fixed the off-by-one in token expiry. 14 tests pass." },
  { k: "done", t: "Worked for 22s · done 8:14 PM" },
  { k: "warn", t: "Claude Code reached its $20 daily budget · Enter to continue in Codex" },
  { k: "rule", t: "Codex 0.159 · gpt-5.6-terra · new session" },
  { k: "nest", t: "handing over 6 earlier turns and the repo state" },
  { k: "user", t: "now add a test for the refresh path" },
  { k: "tool", t: "Edit src/auth.test.ts" },
  { k: "agent", t: "Added refresh-expiry coverage. 15 tests pass." },
  { k: "done", t: "Cooked for 18s · done 8:15 PM" },
];

function Row({ l }: { l: Line }) {
  switch (l.k) {
    case "user":
      return <div className="text-plum"><span className="text-plum/40">❯ </span>{l.t}</div>;
    case "agent":
      return <div className="text-plum/85"><span className="text-pink-500">⏺ </span>{l.t}</div>;
    case "tool":
      return <div className="text-plum/70"><span className="text-pink-300">⏺ </span>{l.t}</div>;
    case "del":
      return <div className="pl-6 text-[#c2264f]"><span className="text-plum/30">⎿ </span>{l.t}</div>;
    case "add":
      return <div className="pl-6 text-[#13804b]"><span className="invisible">⎿ </span>{l.t}</div>;
    case "nest":
      return <div className="pl-2 text-plum/55"><span className="text-plum/30">⎿ </span>{l.t}</div>;
    case "warn":
      return <div className="pl-2 text-pink-600"><span className="text-plum/30">⎿ </span>{l.t}</div>;
    case "done":
      return <div className="text-plum/45">✻ {l.t}</div>;
    case "rule":
      return (
        <div className="my-1.5 flex items-center gap-3">
          <span className="h-px flex-1 bg-plum/15" />
          <span className="text-plum/55">{l.t}</span>
          <span className="h-px flex-1 bg-plum/15" />
        </div>
      );
  }
}

/** A still frame of a real codemax session: Claude hits its budget, Codex continues. */
export default function TerminalDemo() {
  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-[0_40px_100px_-30px_rgba(58,13,37,0.45)] ring-1 ring-white/60">
      <div className="flex items-center gap-2 border-b border-plum/10 px-4 py-3">
        <span className="size-3 rounded-full bg-pink-300" />
        <span className="size-3 rounded-full bg-pink-200" />
        <span className="size-3 rounded-full bg-pink-100" />
        <span className="ml-3 font-mono text-xs text-plum/50">~/app — codemax</span>
      </div>
      <div className="space-y-0.5 px-5 py-4 font-mono text-[12.5px] leading-6">
        {SCRIPT.map((l, i) => <Row key={i} l={l} />)}
      </div>
      <div className="border-t border-plum/10 px-5 py-2 font-mono text-[12.5px] text-plum">
        <span className="text-pink-500">❯ </span>
        <span className="inline-block h-4 w-2 translate-y-0.5 bg-plum/70" />
      </div>
      <div className="flex justify-between border-t border-plum/10 px-5 py-2 font-mono text-[11px] text-plum/45">
        <span>⏵ asks before acting · shift+tab to cycle</span>
        <span>Codex · gpt-5.6-terra</span>
      </div>
    </div>
  );
}

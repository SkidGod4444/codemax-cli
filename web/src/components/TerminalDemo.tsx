"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * A playable codemax session, simulated in the browser. Nothing is sent
 * anywhere: requests are answered from a small script library. Claude Code
 * runs out mid-task on the third request (or on demand), and Enter hands the
 * unfinished task to Codex with the conversation, which is the product.
 */

type Kind = "user" | "agent" | "tool" | "nest" | "done" | "rule" | "warn" | "add" | "del" | "sys" | "pre";
type Line = { id: number; k: Kind; t: string };
type AgentId = "claude" | "codex" | "grok";

const AGENTS: Record<AgentId, { name: string; model: string }> = {
  claude: { name: "Claude Code", model: "claude-sonnet-5-5" },
  codex: { name: "Codex", model: "gpt-5.6-terra" },
  grok: { name: "Grok", model: "grok-code" },
};
const CLAUDE_TASKS_BEFORE_LIMIT = 2;

type Plan = { read: string; edit?: string; diff?: [string, string]; result: string; secs: number; tokens: number };

function planFor(msg: string): Plan {
  const m = msg.toLowerCase();
  if (/test|spec|auth/.test(m))
    return { read: "Read src/auth.ts, test/auth.test.ts", edit: "src/auth.ts", diff: ["-  if (exp < now) return true", "+  if (exp <= now) return false"], result: "Fixed the off-by-one in token expiry. 14 tests pass.", secs: 22, tokens: 14200 };
  if (/readme|doc/.test(m))
    return { read: "Read README.md", edit: "README.md", diff: ["-Run npm start", "+Run bun dev, then open localhost:3000"], result: "Updated the quick start to match the scripts in package.json.", secs: 9, tokens: 6100 };
  if (/refactor|clean|simplif/.test(m))
    return { read: "Read src/api/client.ts", edit: "src/api/client.ts", diff: ["-  return fetch(url).then((r) => r.json())", "+  return http.get(url, { retries: 2 })"], result: "Moved retries into one helper. Behaviour unchanged, 14 tests pass.", secs: 31, tokens: 18800 };
  if (/bug|fix|error|broken|crash/.test(m))
    return { read: "Read src/cart.ts", edit: "src/cart.ts", diff: ["-  total += item.price", "+  total += item.price * item.qty"], result: "The cart total ignored quantity. Fixed, and added a test for it.", secs: 17, tokens: 11900 };
  if (/\?|explain|what|how|why|where/.test(m))
    return { read: "Read package.json, src/", result: "A small Next.js app: auth lives in src/auth.ts, the API client in src/api/, tests under test/.", secs: 6, tokens: 5200 };
  return { read: "Search the repo", edit: "src/app.ts", diff: ["-  // TODO", `+  // ${msg.slice(0, 42)}`], result: "Done. One file changed, tests still pass.", secs: 14, tokens: 9400 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const money = (agent: AgentId, tok: number) => (tok / 1e6) * (agent === "claude" ? 9 : agent === "codex" ? 6 : 4);

const SUGGESTIONS = [
  { label: "fix the failing test", run: "fix the failing auth test" },
  { label: "/usage", run: "/usage" },
  { label: "/switch grok", run: "/switch grok" },
  { label: "Hit Claude's limit", run: "#limit" },
];

export default function TerminalDemo() {
  const [lines, setLines] = useState<Line[]>([]);
  const [agent, setAgent] = useState<AgentId>("claude");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [handoff, setHandoff] = useState<string | null>(null);
  const idRef = useRef(0);
  const alive = useRef(true);
  const state = useRef({ agent: "claude" as AgentId, claudeTasks: 0, forceLimit: false, turns: 0, lastEdit: "" as string, usage: { claude: 0, codex: 0, grok: 0 } as Record<AgentId, number> });
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const push = useCallback((k: Kind, t: string) => {
    const id = ++idRef.current;
    setLines((ls) => [...ls.slice(-80), { id, k, t }]);
    return id;
  }, []);
  const typeOut = useCallback(async (k: Kind, text: string) => {
    const id = push(k, "");
    for (let i = 0; i <= text.length && alive.current; i += 3) {
      const part = text.slice(0, i);
      setLines((ls) => ls.map((l) => (l.id === id ? { ...l, t: part } : l)));
      await sleep(14);
    }
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, t: text } : l)));
  }, [push]);

  useEffect(() => {
    alive.current = true;
    const t = setTimeout(() => {
      push("sys", "codemax 0.5 · ~/app · Claude Code · claude-sonnet-5-5");
      push("sys", "Simulated session. Type a request, or try a suggestion below.");
    }, 0);
    return () => {
      alive.current = false;
      clearTimeout(t);
    };
  }, [push]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const switchTo = useCallback(async (to: AgentId, reason?: string) => {
    const s = state.current;
    s.agent = to;
    setAgent(to);
    push("rule", `${AGENTS[to].name} · ${AGENTS[to].model} · new session`);
    await sleep(250);
    push("nest", `handing over ${s.turns} earlier turn${s.turns === 1 ? "" : "s"} and the repo state${reason ? ` · ${reason}` : ""}`);
    await sleep(350);
  }, [push]);

  const runTask = useCallback(async (msg: string, who: AgentId = state.current.agent, continued = false) => {
    const s = state.current;
    const plan = planFor(msg);
    await sleep(300);
    if (continued) await typeOut("agent", `Picking up from Claude Code: "${msg}".`);
    push("tool", plan.read);
    await sleep(500);
    // Claude runs dry mid-task on its third request, or when the demo asks it to
    if (who === "claude" && (s.forceLimit || s.claudeTasks >= CLAUDE_TASKS_BEFORE_LIMIT)) {
      s.forceLimit = false;
      s.usage.claude += Math.round(plan.tokens / 3);
      await sleep(400);
      push("warn", "Claude Code reached its usage limit · Enter to continue in Codex");
      setHandoff(msg);
      return;
    }
    if (plan.edit && plan.diff) {
      push("tool", `Edit ${plan.edit}`);
      await sleep(250);
      push("del", plan.diff[0]);
      push("add", plan.diff[1]);
      s.lastEdit = plan.edit;
      await sleep(350);
    }
    await typeOut("agent", plan.result);
    s.usage[who] += plan.tokens;
    s.turns += 1;
    if (who === "claude") s.claudeTasks += 1;
    const now = new Date();
    push("done", `${who === "claude" ? "Worked" : "Cooked"} for ${plan.secs}s · done ${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  }, [push, typeOut]);

  const command = useCallback(async (raw: string) => {
    const s = state.current;
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
        ["/switch <agent>  move the conversation to another agent", "/ask <agent> <msg>  one message elsewhere, stay here", "/usage  tokens and API-equivalent cost per agent", "/undo  revert the files the last turn changed", "/clear  clear the screen"].forEach((t) => push("pre", t));
        return;
      case "clear":
        setLines([]);
        return;
      case "usage": {
        push("sys", "Usage today · API-equivalent value, covered by your plans");
        (Object.keys(AGENTS) as AgentId[]).forEach((a) => {
          const tok = s.usage[a];
          push("pre", `${AGENTS[a].name.padEnd(12)} ${(tok / 1000).toFixed(1).padStart(6)}k tok  $${money(a, tok).toFixed(2)}`);
        });
        return;
      }
      case "undo":
        if (!s.lastEdit) push("nest", "Nothing to undo yet");
        else {
          push("nest", `Restored ${s.lastEdit} from the checkpoint before that turn`);
          s.lastEdit = "";
        }
        return;
      case "switch": {
        const to = arg.toLowerCase() as AgentId;
        if (!(to in AGENTS)) {
          push("nest", "Agents: claude, codex, grok · try /switch codex");
          return;
        }
        if (to === s.agent) {
          push("nest", `Already on ${AGENTS[to].name}`);
          return;
        }
        setHandoff(null);
        await switchTo(to);
        return;
      }
      case "ask": {
        const [who, ...words] = arg.split(/\s+/);
        const to = (who ?? "").toLowerCase() as AgentId;
        if (!(to in AGENTS) || !words.length) {
          push("nest", "Usage: /ask codex review my last change");
          return;
        }
        push("nest", `asking ${AGENTS[to].name} once · you stay on ${AGENTS[s.agent].name}`);
        await runTask(words.join(" "), to);
        return;
      }
      default:
        push("nest", `Unknown command /${cmd} · /help lists them`);
    }
  }, [push, runTask, switchTo]);

  const submit = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (busy) return;
    setBusy(true);
    try {
      if (!text && handoff) {
        const msg = handoff;
        setHandoff(null);
        await switchTo("codex", "unfinished request included");
        await runTask(msg, "codex", true);
        return;
      }
      if (text === "#limit") {
        state.current.forceLimit = true;
        if (state.current.agent !== "claude") {
          setHandoff(null);
          await switchTo("claude");
        }
        push("user", "fix the failing auth test");
        await runTask("fix the failing auth test", "claude");
        return;
      }
      if (!text) return;
      push("user", text);
      if (text.startsWith("/")) await command(text);
      else {
        if (handoff) setHandoff(null);
        await runTask(text);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [busy, handoff, command, push, runTask, switchTo]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = input;
    setInput("");
    void submit(v);
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex min-h-0 flex-1 cursor-text flex-col overflow-hidden rounded-xl bg-white shadow-[0_40px_100px_-30px_rgba(58,13,37,0.45)] ring-1 ring-white/60"
        onClick={() => inputRef.current?.focus({ preventScroll: true })}
      >
        <div className="flex items-center gap-2 border-b border-plum/10 px-4 py-3">
          <span className="size-3 rounded-full bg-pink-300" />
          <span className="size-3 rounded-full bg-pink-200" />
          <span className="size-3 rounded-full bg-pink-100" />
          <span className="ml-3 font-mono text-xs text-plum/50">~/app — codemax</span>
        </div>
        <div ref={bodyRef} className="h-[340px] space-y-0.5 overflow-y-auto overscroll-contain px-5 py-4 font-mono text-[12.5px] leading-6" aria-live="polite">
          {lines.map((l) => <Row key={l.id} l={l} />)}
          {busy && <div className="text-plum/40"><span className="inline-block animate-pulse text-pink-500">✻</span> working…</div>}
        </div>
        <label className="flex items-center border-t border-plum/10 px-5 py-2.5 font-mono text-[12.5px] text-plum">
          <span className="text-pink-500">❯&nbsp;</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            aria-label="Type a request for the demo agent"
            placeholder={handoff ? "Press Enter to continue in Codex" : busy ? "" : 'Try "fix the cart bug" · / for commands'}
            className="min-w-0 flex-1 bg-transparent text-[16px] caret-pink-500 outline-none placeholder:text-plum/35 sm:text-[12.5px]"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <div className="flex justify-between gap-3 border-t border-plum/10 px-5 py-2 font-mono text-[11px] text-plum/45">
          <span className="truncate">⏵ asks before acting · shift+tab to cycle</span>
          <span className="shrink-0">{AGENTS[agent].name} · {AGENTS[agent].model}</span>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={busy}
            onClick={() => void submit(s.run)}
            className="border border-white/60 px-3 py-1.5 font-mono text-[11px] text-white transition hover:bg-white hover:text-pink-600 disabled:opacity-50"
          >
            {s.label}
          </button>
        ))}
        {handoff && (
          <button type="button" disabled={busy} onClick={() => void submit("")} className="bg-white px-3 py-1.5 font-mono text-[11px] text-pink-600 transition hover:bg-pink-50 disabled:opacity-50">
            ⏎ Continue in Codex
          </button>
        )}
      </div>
    </div>
  );
}

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
    case "sys":
      return <div className="text-plum/45">{l.t}</div>;
    case "pre":
      return <div className="pl-2 whitespace-pre text-plum/70">{l.t}</div>;
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

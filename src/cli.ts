import { loadConfig, CONFIG_PATH, hotkeyLabel } from "./config.ts";
import { canonicalCwd } from "./core/paths.ts";
import { Ledger } from "./core/ledger.ts";
import { Orchestrator } from "./core/orchestrator.ts";
import { runApp } from "./tui/app.ts";
import { runChat } from "./chat/app.ts";
import { hasEngine } from "./engines/index.ts";
import { listAdapters, getAdapter } from "./adapters/index.ts";
import { buildBrief } from "./core/brief.ts";
import { quotaLabel } from "./core/quota.ts";
import type { AgentId } from "./adapters/types.ts";
import { describeBytes, findHotkey, parseHotkeys } from "./core/hotkey.ts";
import { diagnose } from "./core/doctor.ts";

const HELP = `codemax — one terminal for all your coding agents

usage:
  codemax [start] [--agent <id>] [--fresh]   codemax chat UI driving the agent over its protocol (default)
                 [--tui]                     show the agent's own TUI inside the codemax screen instead
                 [--raw]                     legacy passthrough mode without the codemax screen
  codemax agents                             show detected agents, saved sessions, quota
  codemax status                             project ledger summary
  codemax history [-n <count>]               print recorded turns for this project
  codemax brief [--to <id>]                  print the handoff brief that would be injected
  codemax config                             print config path and values
  codemax keys                               show the raw bytes your terminal sends per keypress (hotkey debugging)
  codemax quota [clear [<id>]]               show or clear remembered quota state for this project
  codemax doctor [--fix]                     check agent auth/permission setup (API keys that would be billed, silent modes)

inside an agent, press the hotkey (default Ctrl+/ or Ctrl+^) to open the codemax menu.
set "hotkeys": ["ctrl+<key>", ...] in the config to change it.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]) {
  const config = loadConfig();
  const cwd = canonicalCwd();
  const [cmdRaw, ...rest] = argv;
  const cmd = cmdRaw && !cmdRaw.startsWith("-") ? cmdRaw : "start";
  const args = cmdRaw && !cmdRaw.startsWith("-") ? rest : argv;

  if (args.includes("--help") || args.includes("-h") || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  switch (cmd) {
    case "start": {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error("codemax start needs a TTY");
        process.exit(2);
      }
      const ledger = new Ledger(cwd);
      const agent = (flag(args, "--agent") ?? flag(args, "-a") ?? config.order[0] ?? "claude") as AgentId;
      getAdapter(agent); // validate
      if (args.includes("--raw")) {
        const orch = new Orchestrator(config, ledger, cwd);
        await orch.start(agent, args.includes("--fresh"));
      } else if (args.includes("--tui") || !hasEngine(agent)) {
        await runApp(config, ledger, cwd, agent, args.includes("--fresh"));
      } else {
        await runChat(config, ledger, cwd, agent, args.includes("--fresh"));
      }
      process.exit(0);
    }
    case "agents": {
      const ledger = new Ledger(cwd);
      const sessions = ledger.sessions();
      const quota = ledger.quota();
      for (const a of listAdapters(config.order)) {
        const d = await a.detect();
        const s = sessions[a.id];
        const q = quota[a.id];
        console.log(
          `${a.id.padEnd(9)} ${a.name.padEnd(13)} ${d.installed ? `✓ ${d.version ?? ""}`.padEnd(14) : "✗ not found".padEnd(14)} ` +
            `${s ? `session ${s.id.slice(0, 8)}…` : "no session".padEnd(16)} ${q ? quotaLabel(q) : ""}`,
        );
      }
      return;
    }
    case "status": {
      const ledger = new Ledger(cwd);
      const turns = ledger.turns();
      const events = ledger.events();
      console.log(`project: ${cwd}\nledger:  ${ledger.dir}\nturns:   ${turns.length}\nevents:  ${events.length}`);
      const byAgent = new Map<string, number>();
      for (const t of turns) byAgent.set(t.agent, (byAgent.get(t.agent) ?? 0) + 1);
      for (const [a, n] of byAgent) console.log(`  ${a}: ${n} turns`);
      const last = events.slice(-5);
      if (last.length) {
        console.log("recent events:");
        for (const e of last) console.log(`  ${new Date(e.ts).toLocaleString()}  ${e.kind}  ${e.agent ?? ""}${e.to ? ` → ${e.to}` : ""}  ${e.detail ?? ""}`);
      }
      return;
    }
    case "history": {
      const n = Number(flag(args, "-n") ?? 20);
      const turns = new Ledger(cwd).turns().slice(-n);
      for (const t of turns) {
        const who = t.role === "user" ? "USER" : `${t.agent.toUpperCase()}`;
        console.log(`\n[${new Date(t.ts).toLocaleTimeString()}] ${who}${t.tools?.length ? ` (tools: ${t.tools.join(", ")})` : ""}\n${t.text.slice(0, 600)}`);
      }
      return;
    }
    case "brief": {
      const to = (flag(args, "--to") ?? "codex") as AgentId;
      console.log(await buildBrief({ ledger: new Ledger(cwd), cwd, to, config }));
      return;
    }
    case "config": {
      console.log(`${CONFIG_PATH}\nhotkeys: ${hotkeyLabel(config.hotkeys)}\n${JSON.stringify(config, null, 2)}`);
      return;
    }
    case "doctor": {
      const findings = diagnose();
      if (!findings.length) return console.log("all clear: no API-key billing or silent-permission issues found");
      for (const f of findings) {
        console.log(`${f.severity === "block" ? "BLOCK" : "warn "} [${f.agent}] ${f.message}`);
        if (f.fix) console.log(`      fix: ${f.fix.description}${args.includes("--fix") ? "" : "  (run: codemax doctor --fix)"}`);
        if (f.fix && args.includes("--fix")) console.log(`      → ${f.fix.apply()}`);
      }
      return;
    }
    case "quota": {
      const ledger = new Ledger(cwd);
      if (args[0] === "clear") {
        ledger.clearQuota(args[1] as AgentId | undefined);
        console.log(args[1] ? `cleared quota state for ${args[1]}` : "cleared all quota state");
        return;
      }
      const all = ledger.quota();
      if (!Object.keys(all).length) return console.log("no quota state recorded");
      for (const q of Object.values(all)) console.log(`${q.agent.padEnd(9)} ${quotaLabel(q) || "ok"}  (${q.source}, ${new Date(q.at).toLocaleString()}${q.detail ? `, ${q.detail}` : ""})`);
      return;
    }
    case "keys": {
      if (!process.stdin.isTTY) {
        console.error("codemax keys needs a TTY");
        process.exit(2);
      }
      const specs = parseHotkeys(config.hotkeys);
      console.log(`press keys to see what your terminal sends. configured hotkeys: ${hotkeyLabel(config.hotkeys)}. q or Ctrl+C to quit.\n`);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (chunk: Buffer) => {
        const bytes = new Uint8Array(chunk);
        const hit = findHotkey(bytes, specs);
        process.stdout.write(`${describeBytes(bytes)}${hit ? `   ← matches hotkey ${hit.name}` : ""}\r\n`);
        if (bytes.length === 1 && (bytes[0] === 0x03 || bytes[0] === 0x71)) {
          process.stdin.setRawMode(false);
          process.exit(0);
        }
      });
      await new Promise(() => {});
      return;
    }
    default:
      console.error(`unknown command "${cmd}"\n\n${HELP}`);
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`codemax: ${e?.message ?? e}`);
  process.exit(1);
});

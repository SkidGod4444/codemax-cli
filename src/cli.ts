import { loadConfig, CONFIG_PATH, hotkeyLabel } from "./config.ts";
import { canonicalCwd } from "./core/paths.ts";
import { Ledger } from "./core/ledger.ts";
import { Orchestrator } from "./core/orchestrator.ts";
import { listAdapters, getAdapter } from "./adapters/index.ts";
import { buildBrief } from "./core/brief.ts";
import { quotaLabel } from "./core/quota.ts";
import type { AgentId } from "./adapters/types.ts";

const HELP = `codemax — one terminal for all your coding agents

usage:
  codemax [start] [--agent <id>] [--fresh]   run an agent TUI under codemax (default: first in config order)
  codemax agents                             show detected agents, saved sessions, quota
  codemax status                             project ledger summary
  codemax history [-n <count>]               print recorded turns for this project
  codemax brief [--to <id>]                  print the handoff brief that would be injected
  codemax config                             print config path and values

inside an agent, press the hotkey (default Ctrl+/) to open the codemax menu.
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
      const orch = new Orchestrator(config, ledger, cwd);
      await orch.start(agent, args.includes("--fresh"));
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
      console.log(`${CONFIG_PATH}\nhotkey: ${hotkeyLabel(config.hotkey)}\n${JSON.stringify(config, null, 2)}`);
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

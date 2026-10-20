import { loadConfig, CONFIG_PATH, hotkeyLabel, saveConfigKey } from "./config.ts";
import { defaultAwakeDeps, recoverAwake } from "./core/awake.ts";
import { checkForUpdate, installKind, isNewer, RESTART_AGENT_ENV, RESTART_THREAD_ENV, updatePlan } from "./core/update.ts";
import { platformArgv } from "./core/spawn.ts";
import pkg from "../package.json" with { type: "json" };
import { canonicalCwd } from "./core/paths.ts";
import { resolve } from "node:path";
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
import { renderUsageTable, resetOldUsageOnce, sumCost } from "./core/usage.ts";
import { debugEvent, debugLogPath, errorFields, exportDebugLog, setDebugLog } from "./core/debuglog.ts";
import { fmtUsd, priceFor, priceProvenance, resetPriceCache } from "./core/pricing.ts";
import { fetchLivePrices, loadLivePrices, LIVE_PRICES_PATH } from "./core/prices-live.ts";
import { fmtDateTime12 } from "./core/time.ts";

const HELP = `codemax — one terminal for all your coding agents

usage:
  codemax [start] [--agent <id>] [--fresh]   codemax chat UI driving the agent over its protocol (default);
                                             continues this folder's latest thread, --fresh starts a new one
  codemax --resume [<id>] [--agent <id>]     reopen a thread (no id: pick one); --agent continues it with another agent
  codemax threads                            list this folder's threads
                 [--tui]                     show the agent's own TUI inside the codemax screen instead
                 [--raw]                     legacy passthrough mode without the codemax screen
  codemax agents                             show detected agents, saved sessions, quota
  codemax status                             project ledger summary
  codemax history [-n <count>]               print recorded turns for this project
  codemax brief [--to <id>]                  print the handoff brief that would be injected
  codemax config                             print config path and values
  codemax keys                               show the raw bytes your terminal sends per keypress (hotkey debugging)
  codemax update [--check]                    update codemax the way it was installed (--check only reports)
  codemax awake [on|lid|off|status]          keep the machine awake while codemax runs (lid: also with the lid closed)
  codemax quota [clear [<id>]]               show or clear remembered quota state for this project
  codemax doctor [--fix]                     check agent auth/permission setup (API keys that would be billed, silent modes)
  codemax debug [on|off|export [file]]       debug log of errors and odd behaviour (never your chat); export makes a file to send
  codemax usage [--all]                      tokens and API-equivalent cost per agent for this project (or every project)
  codemax prices [update] [<model>]          show price source and age, refresh the public list, or look up one model

inside an agent, press the hotkey (default Ctrl+/ or Ctrl+^) to open the codemax menu.
set "hotkeys": ["ctrl+<key>", ...] in the config to change it.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]) {
  const config = loadConfig();
  // On unless turned off (/debug off, /config); CODEMAX_DEBUG=0 turns it off for one run.
  setDebugLog(process.env.CODEMAX_DEBUG === "0" ? false : config.debugLog !== false);
  // codemax needs Bun 1.3+; the launchers make sure of it, so this only shows when Bun is run by hand.
  if (!isNewer(process.versions.bun ?? "0", "1.2.999")) {
    debugEvent("old-bun", { bun: process.versions.bun });
    console.error(`codemax: running on Bun ${process.versions.bun}, but it needs 1.3 or newer (some things, typing among them, may misbehave). Update Bun: bun upgrade`);
  }
  // Crashes are recorded (debug log on) without changing how codemax reacts to them.
  process.on("uncaughtExceptionMonitor", (e, origin) => debugEvent("crash", { origin, ...errorFields(e) }));
  // Once: older usage logs overcounted Claude, so /usage starts fresh with this version.
  try {
    const cleared = resetOldUsageOnce(config, (k, v) => saveConfigKey(k, v));
    if (cleared) process.env.CODEMAX_USAGE_RESET = String(cleared);
  } catch {
    /* never blocks start */
  }
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
      const agentFlag = flag(args, "--agent") ?? flag(args, "-a");
      // After /update, the new codemax resumes the thread and agent that were in use, without the picker.
      const resumed = process.env[RESTART_AGENT_ENV];
      const restartThread = process.env[RESTART_THREAD_ENV];
      delete process.env[RESTART_AGENT_ENV];
      delete process.env[RESTART_THREAD_ENV];
      const ri = Math.max(args.indexOf("--resume"), args.indexOf("-r"));
      const resumeId = restartThread ?? (ri >= 0 && args[ri + 1] && !args[ri + 1]!.startsWith("-") ? args[ri + 1] : undefined);
      const pickThread = ri >= 0 && !resumeId;
      let ledger: Ledger;
      try {
        ledger = new Ledger(cwd, undefined, resumeId ?? (args.includes("--fresh") ? "new" : undefined));
      } catch (e: any) {
        console.error(`codemax: ${e?.message ?? e}`);
        process.exit(2);
      }
      // A resumed thread continues with the agent that last worked in it.
      const threadAgent = resumeId ? Ledger.threads(ledger.dir).find((t) => t.id === ledger.threadId)?.agent : undefined;
      const agent = (agentFlag ?? resumed ?? threadAgent ?? config.order[0] ?? "claude") as AgentId;
      getAdapter(agent); // validate
      if (args.includes("--raw")) {
        const orch = new Orchestrator(config, ledger, cwd);
        await orch.start(agent, args.includes("--fresh"));
      } else if (args.includes("--tui") || !hasEngine(agent)) {
        await runApp(config, ledger, cwd, agent, args.includes("--fresh"), !!agentFlag);
      } else {
        await runChat(config, ledger, cwd, agent, args.includes("--fresh"), !agentFlag && !resumed && !resumeId && !pickThread, !!agentFlag, pickThread, config.onboarded !== true);
      }
      process.exit(0);
    }
    case "debug": {
      const sub = args[0] ?? "";
      if (sub === "on" || sub === "off") {
        saveConfigKey("debugLog", sub === "on");
        console.log(sub === "on" ? `debug log on: ${debugLogPath()}\nerrors and odd behaviour, never your messages or replies; error lines can name files, paths and commands, or quote a line of code` : "debug log off");
      } else if (sub === "export") {
        const os = await import("node:os");
        const path = exportDebugLog({ codemax: pkg.version, os: `${process.platform} ${os.release()} ${process.arch}`, bun: process.versions.bun, terminal: process.env.TERM_PROGRAM ?? process.env.TERM ?? "unknown", debugLog: config.debugLog === false ? "off" : "on" }, args[1] ? resolve(cwd, args[1]) : undefined);
        console.log(`saved ${path}\nno messages or replies, but error lines in it can name your files and commands or quote a line of code: skim it before sending`);
      } else console.log(`debug log is ${config.debugLog === false ? "off" : "on"} (${debugLogPath()})\ncodemax debug on | off | export [file]`);
      process.exit(0);
    }
    case "threads": {
      // Opening the ledger copies a pre-threads history into its first thread.
      const dir = new Ledger(cwd).dir;
      const threads = Ledger.threads(dir).filter((t) => t.title);
      if (!threads.length) console.log("no threads in this folder yet");
      for (const t of threads) console.log(`${t.id}  ${fmtDateTime12(t.updatedAt).padEnd(20)} ${(t.agent ?? "").padEnd(12)} ${t.title ?? "(empty)"}`);
      if (threads.length) console.log(`\ncodemax --resume <id> reopens one (add --agent <id> to continue it with another agent)`);
      return;
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
          `${a.id.padEnd(12)} ${a.name.padEnd(16)} ${d.installed ? `✓ ${d.version ?? ""}`.padEnd(14) : (d.problem ? "✗ broken" : "✗ not found").padEnd(14)} ` +
            `${s ? `session ${s.id.slice(0, 8)}…` : "no session".padEnd(16)} ${q ? quotaLabel(q) : ""}`,
        );
        if (d.problem) console.log(`          ${d.problem}`);
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
        for (const e of last) console.log(`  ${fmtDateTime12(e.ts)}  ${e.kind}  ${e.agent ?? ""}${e.to ? ` → ${e.to}` : ""}  ${e.detail ?? ""}`);
      }
      return;
    }
    case "history": {
      const n = Number(flag(args, "-n") ?? 20);
      const turns = new Ledger(cwd).turns().slice(-n);
      for (const t of turns) {
        const who = t.role === "user" ? "USER" : `${t.agent.toUpperCase()}`;
        console.log(`\n[${fmtDateTime12(t.ts)}] ${who}${t.tools?.length ? ` (tools: ${t.tools.join(", ")})` : ""}\n${t.text.slice(0, 600)}`);
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
    case "prices": {
      if (args[0] === "update") {
        const l = await fetchLivePrices();
        if (!l) return console.log("could not reach openrouter.ai or the LiteLLM list; keeping the current table");
        resetPriceCache();
        console.log(`updated: ${Object.keys(l.prices).length} models from ${l.source} → ${LIVE_PRICES_PATH}`);
      }
      const prov = priceProvenance();
      const cache = loadLivePrices();
      console.log(`price source: ${prov.source} list as of ${prov.asOf}${cache ? ` (${Object.keys(cache.prices).length} models cached, refreshed weekly)` : " (built-in table; run codemax prices update to download the current list)"}`);
      console.log(`overrides: ~/.codemax/prices.json`);
      const model = args.find((a) => a !== "update");
      if (model) {
        const hit = priceFor(model);
        console.log(hit ? `${model}: $${hit.price.input}/M in · $${hit.price.output}/M out · cache read $${hit.price.cacheRead ?? hit.price.input * 0.1}/M (matched "${hit.key}" from ${hit.source})` : `${model}: no price found`);
      }
      return;
    }
    case "usage": {
      if (args.includes("--all")) {
        const { readdirSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { CODEMAX_HOME } = await import("./core/paths.ts");
        const root = join(CODEMAX_HOME, "projects");
        const all = existsSync(root) ? readdirSync(root).flatMap((d) => new Ledger("/", join(root, d), false).usage()) : [];
        for (const l of renderUsageTable(all, { title: "Usage across all projects" })) console.log(l);
        return;
      }
      const u = new Ledger(cwd, undefined, false).usage();
      for (const l of renderUsageTable(u, { title: `Usage for ${cwd}` })) console.log(l);
      console.log(`  total ${fmtUsd(sumCost(u))} · prices: ~/.codemax/prices.json overrides the built-in list`);
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
    case "update": {
      const latest = await checkForUpdate(pkg.version, { force: true });
      console.log(latest ? `codemax ${latest} is available (you have ${pkg.version})` : `codemax ${pkg.version} is the latest`);
      if (args.includes("--check") || !latest) return;
      const plan = updatePlan();
      if (plan.manual) return console.log(plan.manual);
      console.log(`updating with ${plan.label} (${installKind().kind} install)\n`);
      for (const cmd of plan.cmd) {
        const p = Bun.spawn(platformArgv(cmd), { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...(plan.env ?? {}) } });
        if ((await p.exited) !== 0) {
          console.error(`\nupdate failed · run it yourself: ${plan.cmd.map((c) => c.join(" ")).join(" && ")}`);
          process.exit(1);
        }
      }
      console.log("\ncodemax updated.");
      return;
    }
    case "awake": {
      const v = (args[0] ?? "status").toLowerCase();
      const support = process.platform === "linux" ? "sleep, lid close and shutdown are blocked (systemd-inhibit)" : process.platform === "darwin" ? "sleep is blocked; lid close needs your admin password once; macOS cannot block shutdown" : process.platform === "win32" ? "sleep is blocked; lid close switches the lid action to 'do nothing' and back; Windows cannot block shutdown" : "not supported on this platform";
      if (v === "status") {
        console.log(`awake: ${config.awake ?? "off"} (applies while codemax runs)\n${process.platform}: ${support}`);
        return;
      }
      if (v !== "on" && v !== "lid" && v !== "off") {
        console.error("usage: codemax awake [on|lid|off|status]");
        process.exit(2);
      }
      if (v === "off") for (const n of await recoverAwake({ ...defaultAwakeDeps(), pid: -1, interactive: (fn) => fn() })) console.log(n);
      if (v === "lid" && process.platform === "darwin") {
        console.log("macOS needs your admin password to keep working with the lid closed (pmset disablesleep).");
        const ok = Bun.spawnSync(["sudo", "-v"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode === 0;
        if (!ok) console.log("no admin rights: lid-close will not be enabled; the Mac still will not idle-sleep.");
      }
      saveConfigKey("awake", v);
      console.log(v === "off" ? "awake off: the machine sleeps normally" : `awake ${v}: applies whenever codemax is running · ${support}`);
      if (v === "lid") console.log("With the lid closed, keep the laptop somewhere it can breathe: not in a bag.");
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
      for (const q of Object.values(all)) console.log(`${q.agent.padEnd(9)} ${quotaLabel(q) || "ok"}  (${q.source}, ${fmtDateTime12(q.at)}${q.detail ? `, ${q.detail}` : ""})`);
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
  debugEvent("fatal", errorFields(e));
  console.error(`codemax: ${e?.message ?? e}`);
  process.exit(1);
});

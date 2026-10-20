#!/usr/bin/env node
// codemax launcher for npm installs (`npm i -g codemax-cli`, `npx codemax-cli`).
// codemax runs on Bun; this finds a Bun binary and starts src/cli.ts with it:
//   1. the matching @oven/bun-<platform> package: the Bun codemax ships with (an
//      optional dependency; npm installs only the one for this machine, no install
//      script), so every npm install runs the version codemax was tested on,
//   2. the `bun` npm package, then a `bun` on PATH, only when 1 is missing.
// A Bun older than MIN_BUN is never used (a stale global `bun` package once ran
// codemax on 1.2 while it needs 1.3+). With no Bun 1.3+ on PATH, the bundled one is
// also linked as the user's global `bun`, once (linkGlobalBun).
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, symlinkSync, linkSync, copyFileSync, unlinkSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { homedir } = require("node:os");

const cli = join(__dirname, "..", "src", "cli.ts");
const exe = process.platform === "win32" ? "bun.exe" : "bun";

const MIN_BUN = [1, 3, 0];

/** The Bun at `path` runs and is at least MIN_BUN. */
function works(path) {
  if (!path || !existsSync(path)) return false;
  const r = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (r.status !== 0) return false;
  const v = String(r.stdout || "").trim().split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) if ((v[i] || 0) !== MIN_BUN[i]) return (v[i] || 0) > MIN_BUN[i];
  return true;
}

function resolveIn(pkg, ...rest) {
  try {
    return join(dirname(require.resolve(`${pkg}/package.json`)), ...rest);
  } catch {
    return null;
  }
}

function isMusl() {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report && process.report.getReport();
    return !(report && report.header && report.header.glibcVersionRuntime);
  } catch {
    return false;
  }
}

function platformPackage() {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x64" : null;
  if (!arch) return null;
  if (process.platform === "darwin") return `@oven/bun-darwin-${arch}`;
  if (process.platform === "win32") return `@oven/bun-windows-${arch}`;
  if (process.platform === "linux") return `@oven/bun-linux-${arch}${isMusl() ? "-musl" : ""}`;
  return null;
}

/** The first `bun` on PATH, if any. */
function bunOnPath() {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : null;
}

/**
 * Once, when there is no Bun 1.3+ on PATH: the Bun npm installed with codemax becomes the
 * user's global `bun` (~/.bun/bin/bun, where Bun's own installer puts it), and that folder
 * goes first on PATH. Nothing is downloaded, and an existing ~/.bun/bin/bun is never
 * replaced. CODEMAX_NO_GLOBAL_BUN=1 skips it. Returns a line to show, or null.
 */
function linkGlobalBun(bundled) {
  if (process.env.CODEMAX_NO_GLOBAL_BUN === "1" || process.env.CI) return null;
  const home = homedir();
  const marker = join(home, ".codemax", "global-bun.json");
  if (existsSync(marker) || works(bunOnPath())) return null;
  const binDir = join(process.env.BUN_INSTALL || join(home, ".bun"), "bin");
  const target = join(binDir, exe);
  try {
    mkdirSync(binDir, { recursive: true });
    let present = false;
    try {
      lstatSync(target);
      present = true;
    } catch {}
    if (present && !works(target)) return null; // someone else's (old) Bun: left alone
    if (!present) {
      // A link follows codemax's updates; Windows needs no admin rights for a hard link (or a copy).
      if (process.platform === "win32") {
        try {
          linkSync(bundled, target);
        } catch {
          copyFileSync(bundled, target);
        }
      } else symlinkSync(bundled, target);
    }
    addToPath(binDir);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), target, bundled }) + "\n");
    return `codemax: ${target.replace(home, "~")} is now Bun ${String(spawnSync(target, ["--version"], { encoding: "utf8" }).stdout || "").trim()} (you had no Bun 1.3+ on PATH) · open a new terminal to use \`bun\``;
  } catch {
    return null; // never in the way of starting codemax
  }
}

/** Put `dir` first on PATH for new terminals: the shell profile (macOS, Linux) or the user PATH (Windows). */
function addToPath(dir) {
  if (process.platform === "win32") {
    const ps = `$p=[Environment]::GetEnvironmentVariable('Path','User'); if (-not (($p -split ';') -contains '${dir}')) { [Environment]::SetEnvironmentVariable('Path', '${dir};' + $p, 'User') }`;
    spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 15000 });
    return;
  }
  const shell = require("node:path").basename(process.env.SHELL || "bash");
  const home = homedir();
  const profile = shell === "zsh" ? join(home, ".zshrc") : shell === "fish" ? join(home, ".config", "fish", "config.fish") : join(home, process.platform === "darwin" ? ".bash_profile" : ".bashrc");
  const line = shell === "fish" ? `fish_add_path --prepend "${dir}"` : `export PATH="${dir}:$PATH"`;
  const current = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  if (current.includes(dir)) return;
  mkdirSync(dirname(profile), { recursive: true });
  appendFileSync(profile, `\n# Bun (linked by codemax)\n${line}\n`);
}

function findBun() {
  const pp = platformPackage();
  const fromPlatform = pp && resolveIn(pp, "bin", exe);
  if (works(fromPlatform)) return fromPlatform;
  const fromPackage = resolveIn("bun", "bin", "bun.exe");
  if (works(fromPackage)) return fromPackage;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { encoding: "utf8" });
  const onPath = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : null;
  if (works(onPath)) return onPath;
  return null;
}

const bun = findBun();
if (bun) {
  const pp = platformPackage();
  const bundled = pp && resolveIn(pp, "bin", exe);
  if (bundled && bun === bundled) {
    const note = linkGlobalBun(bundled);
    if (note) console.error(note);
  }
}
if (!bun) {
  console.error(`codemax: could not find Bun ${MIN_BUN.join(".")} or newer, which codemax runs on.`);
  console.error("Reinstall with `npm i -g codemax-cli` (it installs its own Bun), or update Bun: `bun upgrade` (https://bun.sh)");
  process.exit(1);
}

const child = spawn(bun, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    // The TUI handles Ctrl+C itself; forward only what the child would not see.
    if (sig !== "SIGINT") child.kill(sig);
  });
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

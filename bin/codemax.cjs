#!/usr/bin/env node
// codemax launcher for npm installs (`npm i -g codemax-cli`, `npx codemax-cli`).
// codemax runs on Bun; this finds a Bun binary and starts src/cli.ts with it:
//   1. the `bun` npm package installed alongside codemax (a dependency),
//   2. its platform package directly (when install scripts were skipped),
//   3. a `bun` already on PATH.
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const cli = join(__dirname, "..", "src", "cli.ts");
const exe = process.platform === "win32" ? "bun.exe" : "bun";

function works(path) {
  if (!path || !existsSync(path)) return false;
  const r = spawnSync(path, ["--version"], { stdio: "ignore", timeout: 10000 });
  return r.status === 0;
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

function findBun() {
  const fromPackage = resolveIn("bun", "bin", "bun.exe");
  if (works(fromPackage)) return fromPackage;
  const pp = platformPackage();
  const fromPlatform = pp && resolveIn(pp, "bin", exe);
  if (works(fromPlatform)) return fromPlatform;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { encoding: "utf8" });
  const onPath = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : null;
  if (works(onPath)) return onPath;
  return null;
}

const bun = findBun();
if (!bun) {
  console.error("codemax: could not find Bun, which codemax runs on.");
  console.error("Reinstall with `npm i -g codemax-cli` (it installs Bun), or install Bun from https://bun.sh");
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

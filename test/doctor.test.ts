import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose } from "../src/core/doctor.ts";

test("doctor flags an API key injected by Claude settings and can remove it with a backup", () => {
  const home = mkdtempSync(join(tmpdir(), "codemax-doctor-"));
  mkdirSync(join(home, ".claude"));
  const file = join(home, ".claude", "settings.json");
  writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-test", OTHER: "1" }, permissions: { defaultMode: "auto" } }));
  const findings = diagnose(home, {});
  const block = findings.find((f) => f.severity === "block");
  expect(block?.agent).toBe("claude");
  expect(block?.message).toContain("ANTHROPIC_API_KEY");
  expect(findings.some((f) => f.agent === "grok" && f.severity === "warn")).toBe(true);
  block!.fix!.apply();
  const after = JSON.parse(readFileSync(file, "utf8"));
  expect(after.env).toEqual({ OTHER: "1" });
  expect(existsSync(`${file}.codemax-backup`)).toBe(true);
  expect(diagnose(home, {}).some((f) => f.severity === "block")).toBe(false);
});

test("doctor is clear on a clean home", () => {
  const home = mkdtempSync(join(tmpdir(), "codemax-doctor-clean-"));
  expect(diagnose(home, {})).toEqual([]);
});

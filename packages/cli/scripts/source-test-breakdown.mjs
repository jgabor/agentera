#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(packageRoot, "../..");

function finiteNonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite nonnegative number`);
  return value;
}

function tableText(value) {
  return String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

function duration(ms) {
  const seconds = finiteNonnegative(ms, "duration") / 1000;
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(3)}s`;
}

function relativeSuiteName(name, testRoot) {
  const relative = path.relative(testRoot, name).split(path.sep).join("/");
  return relative.startsWith("../") || path.isAbsolute(relative) ? name : relative;
}

export function summarizeSourceReport(report, { testRoot = path.join(packageRoot, "test") } = {}) {
  if (report === null || typeof report !== "object" || !Array.isArray(report.testResults) || report.testResults.length === 0) {
    throw new Error("timing report must contain at least one test result");
  }

  const suites = report.testResults.map((suite, suiteIndex) => {
    if (suite === null || typeof suite !== "object" || typeof suite.name !== "string" || !Array.isArray(suite.assertionResults)) {
      throw new Error(`test result ${suiteIndex} is malformed`);
    }
    const start = finiteNonnegative(suite.startTime, `test result ${suiteIndex} startTime`);
    const end = finiteNonnegative(suite.endTime, `test result ${suiteIndex} endTime`);
    if (end < start) throw new Error(`test result ${suiteIndex} ends before it starts`);
    const file = relativeSuiteName(suite.name, testRoot);
    const assertions = suite.assertionResults.map((assertion, assertionIndex) => {
      if (assertion === null || typeof assertion !== "object" || typeof assertion.fullName !== "string" || typeof assertion.status !== "string") {
        throw new Error(`assertion ${suiteIndex}:${assertionIndex} is malformed`);
      }
      return {
        file,
        name: assertion.fullName,
        status: assertion.status,
        durationMs: assertion.duration === undefined ? 0 : finiteNonnegative(assertion.duration, `assertion ${suiteIndex}:${assertionIndex} duration`),
      };
    });
    return {
      file,
      area: file.includes("/") ? file.split("/", 1)[0] : "(root)",
      start,
      end,
      durationMs: end - start,
      assertionMs: assertions.reduce((total, assertion) => total + assertion.durationMs, 0),
      assertions,
    };
  });

  const assertions = suites.flatMap((suite) => suite.assertions);
  const suiteSpanMs = Math.max(...suites.map((suite) => suite.end)) - Math.min(...suites.map((suite) => suite.start));
  const cumulativeSuiteMs = suites.reduce((total, suite) => total + suite.durationMs, 0);
  const cumulativeAssertionMs = assertions.reduce((total, assertion) => total + assertion.durationMs, 0);
  const statuses = Object.fromEntries(["passed", "failed", "skipped", "todo"].map((status) => [status, assertions.filter((assertion) => assertion.status === status).length]));
  const areas = new Map();
  for (const suite of suites) {
    const area = areas.get(suite.area) ?? { area: suite.area, files: 0, tests: 0, workerMs: 0 };
    area.files += 1;
    area.tests += suite.assertions.length;
    area.workerMs += suite.durationMs;
    areas.set(suite.area, area);
  }

  return {
    success: report.success === true,
    counts: { files: suites.length, tests: assertions.length, ...statuses },
    suiteSpanMs,
    cumulativeSuiteMs,
    cumulativeAssertionMs,
    nonAssertionMs: Math.max(0, cumulativeSuiteMs - cumulativeAssertionMs),
    averageConcurrency: suiteSpanMs === 0 ? 0 : cumulativeSuiteMs / suiteSpanMs,
    areas: [...areas.values()].sort((left, right) => right.workerMs - left.workerMs || left.area.localeCompare(right.area)),
    slowFiles: [...suites].sort((left, right) => right.durationMs - left.durationMs || left.file.localeCompare(right.file)).slice(0, 10),
    slowTests: [...assertions].sort((left, right) => right.durationMs - left.durationMs || left.name.localeCompare(right.name)).slice(0, 5),
  };
}

export function formatSourceBreakdown(summary, { ownerWallMs }) {
  finiteNonnegative(ownerWallMs, "owner wall time");
  const harnessMs = Math.max(0, ownerWallMs - summary.suiteSpanMs);
  const lines = [
    "# Source test timing breakdown",
    "",
    `Status: **${summary.success ? "PASS" : "FAIL"}**`,
    "",
    `- Owner wall time: **${duration(ownerWallMs)}**`,
    `- Reporter suite span: **${duration(summary.suiteSpanMs)}**`,
    `- Harness/startup/shutdown time: **${duration(harnessMs)}**`,
    `- Files: **${summary.counts.files}**`,
    `- Tests: **${summary.counts.tests}** (${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.skipped} skipped, ${summary.counts.todo} todo)`,
    `- Cumulative suite worker time: **${duration(summary.cumulativeSuiteMs)}**`,
    `- Average suite concurrency: **${summary.averageConcurrency.toFixed(2)}**`,
    `- Assertion time: **${duration(summary.cumulativeAssertionMs)}**; non-assertion suite overhead: **${duration(summary.nonAssertionMs)}**`,
    "",
    "Worker times overlap and are not additive wall time.",
    "",
    "## By test area",
    "",
    "| Area | Files | Tests | Worker time | Share |",
    "|---|---:|---:|---:|---:|",
    ...summary.areas.map((area) => `| ${tableText(area.area)} | ${area.files} | ${area.tests} | ${duration(area.workerMs)} | ${(summary.cumulativeSuiteMs === 0 ? 0 : (area.workerMs / summary.cumulativeSuiteMs) * 100).toFixed(1)}% |`),
    "",
    "## Slowest files",
    "",
    "| File | Tests | Duration |",
    "|---|---:|---:|",
    ...summary.slowFiles.map((suite) => `| \`${tableText(suite.file)}\` | ${suite.assertions.length} | ${duration(suite.durationMs)} |`),
    "",
    "## Slowest individual tests",
    "",
    "| File | Test | Duration |",
    "|---|---|---:|",
    ...summary.slowTests.map((test) => `| \`${tableText(test.file)}\` | ${tableText(test.name)} | ${duration(test.durationMs)} |`),
  ];
  return `${lines.join("\n")}\n`;
}

function sourceInventory() {
  const result = spawnSync(process.execPath, ["scripts/verify-lane.mjs", "inventory", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) throw new Error(`source inventory failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  const inventory = JSON.parse(result.stdout);
  if (!Array.isArray(inventory.files?.source) || inventory.files.source.length === 0) throw new Error("source inventory is empty or malformed");
  return inventory.files.source.map((file) => {
    const relative = path.relative(packageRoot, path.join(repoRoot, file));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`source inventory path escapes package root: ${file}`);
    return relative.split(path.sep).join("/");
  });
}

export function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-source-breakdown-"));
  const reportPath = path.join(temporaryRoot, "source-timings.json");
  try {
    const files = sourceInventory();
    const started = process.hrtime.bigint();
    const result = spawnSync("pnpm", ["exec", "vp", "test", "run", "--config", "vite.config.ts", ...files, "--reporter=json", `--outputFile=${reportPath}`], {
      cwd: packageRoot,
      stdio: "inherit",
      env: { ...process.env, AGENTERA_VERIFICATION_OWNER: "source" },
    });
    const ownerWallMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (!fs.existsSync(reportPath)) throw new Error(`source test runner produced no timing report${result.error ? `: ${result.error.message}` : ""}`);
    const summary = summarizeSourceReport(JSON.parse(fs.readFileSync(reportPath, "utf8")));
    process.stdout.write(formatSourceBreakdown(summary, { ownerWallMs }));
    if (result.error || result.status !== 0 || !summary.success) return result.status && result.status > 0 ? result.status : 1;
    return 0;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`source-test-breakdown: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

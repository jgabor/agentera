import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadYamlMapping } from "../../../src/core/yaml.js";

const PACKAGE_ROOT = path.resolve(__dirname, "../../..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
let buildRoot = "";
let cliBundle = "";

beforeAll(() => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-writer-process-test-"));
  cliBundle = path.join(buildRoot, "agentera.mjs");
  const built = spawnSync(
    "pnpm",
    [
      "exec",
      "esbuild",
      "src/bin/agentera.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--external:yaml",
      `--outfile=${cliBundle}`,
    ],
    { cwd: PACKAGE_ROOT, encoding: "utf8" },
  );
  if (built.status !== 0)
    throw new Error(`failed to bundle writer process fixture: ${built.stderr}`);
  fs.symlinkSync(
    path.join(PACKAGE_ROOT, "node_modules"),
    path.join(buildRoot, "node_modules"),
    "dir",
  );
});

afterAll(() => {
  if (buildRoot) fs.rmSync(buildRoot, { recursive: true, force: true });
});

function runProcess(
  project: string,
  artifact: "progress" | "decisions",
  suffix: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const args =
    artifact === "progress"
      ? [
          "state",
          "progress",
          "append",
          "--project",
          project,
          "--type",
          "test",
          "--phase",
          "build",
          "--what",
          `process ${suffix}`,
          "--intent",
          "prove serialization",
          "--format",
          "json",
        ]
      : [
          "state",
          "decisions",
          "append",
          "--project",
          project,
          "--question",
          `Question ${suffix}?`,
          "--context",
          "process coverage",
          "--alternative-chosen",
          "writer lock",
          "--choice",
          "serialize",
          "--reasoning",
          "prevent lost updates",
          "--confidence",
          "firm",
          "--format",
          "json",
        ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliBundle, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("real-process writer serialization", () => {
  it("serializes same-artifact writers without lost entries or duplicate numbers", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-writer-same-"));
    try {
      const results = await Promise.all([
        runProcess(project, "progress", "one"),
        runProcess(project, "progress", "two"),
      ]);
      expect(
        results.map((result) => result.code),
        JSON.stringify(results),
      ).toEqual([0, 0]);
      const doc = loadYamlMapping(
        fs.readFileSync(path.join(project, ".agentera", "progress.yaml"), "utf8"),
      );
      const cycles = doc.cycles as Array<Record<string, unknown>>;
      expect(cycles).toHaveLength(2);
      expect(new Set(cycles.map((cycle) => cycle.number))).toEqual(new Set([1, 2]));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("uses the project lock across different artifacts", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-writer-cross-"));
    try {
      const results = await Promise.all([
        runProcess(project, "progress", "progress"),
        runProcess(project, "decisions", "decision"),
      ]);
      expect(
        results.map((result) => result.code),
        JSON.stringify(results),
      ).toEqual([0, 0]);
      expect(fs.existsSync(path.join(project, ".agentera", "progress.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(project, ".agentera", "decisions.yaml"))).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

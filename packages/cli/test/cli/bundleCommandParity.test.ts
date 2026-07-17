import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpYamlMapping } from "../../src/core/yaml.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const BUNDLE = path.join(ROOT, "packages/cli/bundle");
const SOURCE_CLI = path.join(ROOT, "packages/cli/dist/bin/agentera.js");
let temp = "", packed = "", entityProject = "", legacyProject = "";

function entity(root: string, artifact: string, boundary: string, id: string, record: Record<string, unknown>): void {
  const file = path.join(root, ".agentera/entities", artifact, boundary, `${id}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, dumpYamlMapping({ id, artifact, record }));
}

function run(cwd: string, args: string[], sourceRoot: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SOURCE_CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), PATH: "", AGENTERA_BOOTSTRAP_SOURCE_ROOT: sourceRoot } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return typeof value === "string"
    ? value.replaceAll(BUNDLE, "<APP>").replaceAll(packed, "<APP>").replaceAll(ROOT, "<APP>")
    : value;
  const ignored = new Set(["app", "app_home", "appHomeSource", "runtime_lifecycle", "project_integration", "v1_migration", "corpus_coverage", "utf8_bytes"]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !ignored.has(key))
    .map(([key, child]) => [key, normalize(child)]));
}

beforeAll(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-bundle-command-parity-"));
  packed = path.join(temp, "package"); entityProject = path.join(temp, "entity"); legacyProject = path.join(temp, "legacy");
  fs.mkdirSync(packed, { recursive: true }); fs.mkdirSync(entityProject); fs.mkdirSync(legacyProject); fs.mkdirSync(path.join(temp, "home"));
  fs.mkdirSync(path.join(entityProject, ".agentera"));
  fs.writeFileSync(path.join(entityProject, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  entity(entityProject, "progress", "progress_cycle", "aaaaaaaaaa", { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "parity", context: { intent: "test" } });
});

afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

describe("source and generated-bundle command parity", () => {
  it("matches normalized JSON envelopes and exit codes for final protocol commands", () => {
    const commands: Array<[string, string[]]> = [
      [entityProject, ["prime", "--format", "json"]],
      [entityProject, ["prime", "--context", "build", "--format", "json"]],
      [entityProject, ["state", "progress", "list", "--format", "json"]],
      [entityProject, ["state", "progress", "get", "--id", "aaaaaaaaaa", "--format", "json"]],
      [entityProject, ["state", "progress", "get", "--id", "zzzzzzzzzz", "--format", "json"]],
      [entityProject, ["schema", "--format", "json"]],
      [legacyProject, ["prime", "--format", "json"]],
    ];
    for (const [cwd, args] of commands) {
      const source = run(cwd, args, ROOT); const bundle = run(cwd, args, BUNDLE);
      expect(bundle.status, args.join(" ")).toBe(source.status);
      expect(normalize(JSON.parse(bundle.stdout)), args.join(" ")).toEqual(normalize(JSON.parse(source.stdout)));
    }
  });

  it("matches final help text exactly", () => {
    const args = ["state", "plan", "--help"];
    const source = run(entityProject, args, ROOT); const bundle = run(entityProject, args, BUNDLE);
    expect(bundle).toEqual(source);
  });
});

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpYamlMapping } from "../../src/core/yaml.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const BUILT = path.join(ROOT, "packages/cli/dist");
const GENERATED = path.join(ROOT, "packages/cli/bundle");
let temp = "";
let sourceLayout = "", bundleLayout = "", sourceData = "", bundleData = "";
let sourceBinary = "", bundleBinary = "", sourceProject = "", bundleProject = "";

function entity(root: string, artifact: string, boundary: string, id: string, record: Record<string, unknown>): void {
  const file = path.join(root, ".agentera/entities", artifact, boundary, `${id}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, dumpYamlMapping({ id, artifact, record }));
}

function fixture(root: string): void {
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  entity(root, "progress", "progress_cycle", "aaaaaaaaaa", { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "parity", verified: "pass", context: { intent: "test" } });
  entity(root, "plan", "plan", "bbbbbbbbbb", { header: { level: "light", created: "2026-07-17", status: "open", title: "Parity plan" }, what: "test", why: "test", scope: { included: ["state"], excluded: [] } });
  entity(root, "plan", "plan_task", "cccccccccc", { plan: "bbbbbbbbbb", name: "Parity task", status: "pending", depends_on: [], acceptance: ["pass"] });
  entity(root, "objective", "objective", "dddddddddd", { header: { created: "2026-07-17", status: "active", title: "Parity objective" }, objective: { description: "test", measurement: "test" }, metric: { description: "metric", direction: "maximize", unit: "score" }, baseline: { description: "zero" }, scope: { included: ["state"], excluded: [] } });
  entity(root, "experiments", "experiment", "eeeeeeeeee", { objective: "dddddddddd", date: "2026-07-17 12:00", label: "baseline", hypothesis: "baseline", method: "locked fixture", change: "none", metric: { primary_value: "0", delta_vs_baseline: "0" }, regression: "pass", status: "baseline", conclusion: "zero", provenance: { command: "fixture", revision: "fixed" } });
}

function digest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name); const stat = fs.lstatSync(file);
      hash.update(path.relative(root, file)).update("\0");
      if (stat.isDirectory()) visit(file); else hash.update(fs.readFileSync(file));
    }
  };
  visit(root); return hash.digest("hex");
}

type Result = { status: number | null; stdout: string; stderr: string };

function run(layout: "source" | "bundle", args: string[], legacy = false): Result {
  const binary = layout === "source" ? sourceBinary : bundleBinary;
  const project = legacy ? path.join(temp, `${layout}-legacy-project`) : layout === "source" ? sourceProject : bundleProject;
  const home = path.join(layout === "source" ? sourceLayout : bundleLayout, "home");
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, PATH: "" };
  delete env.AGENTERA_HOME;
  delete env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  if (layout === "source") env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = sourceData;
  const result = spawnSync(process.execPath, [binary, ...args], { cwd: project, encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function normalizedText(text: string, layout: "source" | "bundle"): string {
  const replacements: Array<[string, string]> = layout === "source"
    ? [[sourceProject, "<PROJECT>"], [path.join(temp, "source-legacy-project"), "<LEGACY_PROJECT>"], [sourceData, "<DATA>"], [sourceLayout, "<LAYOUT>"]]
    : [[bundleProject, "<PROJECT>"], [path.join(temp, "bundle-legacy-project"), "<LEGACY_PROJECT>"], [bundleData, "<DATA>"], [bundleLayout, "<LAYOUT>"]];
  return replacements.sort((a, b) => b[0].length - a[0].length)
    .reduce((value, [from, to]) => value.replaceAll(from, to), text)
    .replace(/("snapshotId"\s*:\s*")sha256:[0-9a-f]+(")/g, "$1<PATH_DERIVED_SNAPSHOT>$2");
}

function expectParity(args: string[], legacy = false): void {
  const source = run("source", args, legacy); const bundle = run("bundle", args, legacy);
  const sourceNormalized = { ...source, stdout: normalizedText(source.stdout, "source"), stderr: normalizedText(source.stderr, "source") };
  const bundleNormalized = { ...bundle, stdout: normalizedText(bundle.stdout, "bundle"), stderr: normalizedText(bundle.stderr, "bundle") };
  expect(bundleNormalized, args.join(" ")).toEqual(sourceNormalized);
  if (args.includes("--format") && args.includes("json") && source.stdout.trim()) {
    expect(JSON.parse(bundleNormalized.stdout), args.join(" ")).toEqual(JSON.parse(sourceNormalized.stdout));
  }
}

beforeAll(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-independent-command-parity-"));
  sourceLayout = path.join(temp, "source-layout"); bundleLayout = path.join(temp, "bundle-layout");
  sourceData = path.join(sourceLayout, "source"); bundleData = path.join(bundleLayout, "bundle");
  for (const layout of [sourceLayout, bundleLayout]) {
    fs.mkdirSync(layout, { recursive: true });
    fs.cpSync(BUILT, path.join(layout, "dist"), { recursive: true });
    fs.mkdirSync(path.join(layout, "home"));
    fs.symlinkSync(path.join(ROOT, "packages/cli/node_modules"), path.join(layout, "node_modules"), "dir");
  }
  fs.cpSync(GENERATED, sourceData, { recursive: true });
  for (const name of ["skills", "references"]) fs.cpSync(path.join(ROOT, name), path.join(sourceData, name), { recursive: true, force: true });
  for (const name of ["registry.json", "README.md", "UPGRADE.md", "CHANGELOG.md", "DESIGN.md", "LICENSE"]) {
    fs.mkdirSync(sourceData, { recursive: true }); fs.copyFileSync(path.join(ROOT, name), path.join(sourceData, name));
  }
  fs.cpSync(GENERATED, bundleData, { recursive: true });
  sourceBinary = path.join(sourceLayout, "dist/bin/agentera.js"); bundleBinary = path.join(bundleLayout, "dist/bin/agentera.js");
  sourceProject = path.join(temp, "source-project"); bundleProject = path.join(temp, "bundle-project");
  fixture(sourceProject); fs.cpSync(sourceProject, bundleProject, { recursive: true, preserveTimestamps: true });
  for (const layout of ["source", "bundle"] as const) fs.mkdirSync(path.join(temp, `${layout}-legacy-project`));
});

afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

describe("independent source and generated-bundle command parity", () => {
  it("uses distinct executable, data, home, and byte-equivalent project layouts", () => {
    expect(sourceBinary).not.toBe(bundleBinary);
    expect(sourceData).not.toBe(bundleData);
    expect(sourceProject).not.toBe(bundleProject);
    expect(path.dirname(path.dirname(path.dirname(sourceBinary)))).toBe(sourceLayout);
    expect(path.dirname(path.dirname(path.dirname(bundleBinary)))).toBe(bundleLayout);
    expect(fs.realpathSync(path.join(sourceLayout, "node_modules"))).toBe(fs.realpathSync(path.join(bundleLayout, "node_modules")));
    expect(digest(sourceProject)).toBe(digest(bundleProject));
    expect(digest(path.join(sourceData, "skills"))).toBe(digest(path.join(bundleData, "skills")));
    expect(digest(path.join(sourceData, "references"))).toBe(digest(path.join(bundleData, "references")));
  });

  it("matches complete command results across representative final-protocol behavior", () => {
    const commands: Array<[string[], boolean?]> = [
      [["prime", "--format", "json"]],
      [["prime", "--context", "build", "--format", "json"]],
      [["state", "progress", "list", "--format", "json"]],
      [["state", "progress", "get", "--id", "aaaaaaaaaa", "--format", "json"]],
      [["state", "progress", "get", "--id", "zzzzzzzzzz", "--format", "json"]],
      [["state", "plan", "list", "--format", "json"]],
      [["state", "plan", "get", "--id", "bbbbbbbbbb", "--format", "json"]],
      [["state", "plan", "tasks", "list", "bbbbbbbbbb", "--format", "json"]],
      [["state", "objective", "list", "--format", "json"]],
      [["state", "experiments", "list", "--objective", "dddddddddd", "--format", "json"]],
      [["state", "experiments", "get", "--objective", "dddddddddd", "--id", "eeeeeeeeee", "--format", "json"]],
      [["state", "progress", "explain", "--format", "json"]],
      [["schema", "--format", "json"]],
      [["prime", "--format", "json"], true],
      [["state", "plan", "--help"]],
    ];
    for (const [args, legacy] of commands) expectParity(args, legacy);
    expect(run("source", ["prime", "--format", "json"]).status).toBe(0);
    expect(run("bundle", ["prime", "--format", "json"]).status).toBe(0);
  });

  it("does not normalize away a sentinel field difference", () => {
    const source: Result = { status: 0, stdout: '{"provenance":{"sentinel":"source"}}\n', stderr: "" };
    const bundle: Result = { status: 0, stdout: '{"provenance":{"sentinel":"bundle"}}\n', stderr: "" };
    expect({ ...bundle, stdout: normalizedText(bundle.stdout, "bundle") })
      .not.toEqual({ ...source, stdout: normalizedText(source.stdout, "source") });
    expect(JSON.parse(bundle.stdout)).not.toEqual(JSON.parse(source.stdout));
  });
});

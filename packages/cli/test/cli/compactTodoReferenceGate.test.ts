import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { sourceModuleUrl, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

const CLI = fileURLToPath(sourceModuleUrl("bin/agentera.js"));
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];

function temporary(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `compact-todo-reference-${label}-`));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

function write(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function progressId(index: number): string {
  return `${"a".repeat(9)}${String.fromCharCode("a".charCodeAt(0) + index)}`;
}

function writeProgressEntity(root: string, index: number, what: string, intent = "fixture"): void {
  const id = progressId(index);
  write(
    root,
    `.agentera/entities/progress/progress_cycle/${id}.yaml`,
    [`id: ${id}`, "artifact: progress", "record:", '  timestamp: "2026-08-09 10:00"', "  type: test", "  phase: build", `  what: ${JSON.stringify(what)}`, "  context:", `    intent: ${JSON.stringify(intent)}`, `  publication_order: ${index + 1}`, ""].join("\n"),
  );
}

function runGate(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, "check", "compact", "--project", root, ...args, "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...sourceSubprocessEnv(),
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
    },
  });
}

function fixtureFiles(root: string): Record<string, string> {
  const files: Array<[string, string]> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push([path.relative(root, target), fs.readFileSync(target, "utf8")]);
    }
  };
  visit(root);
  return Object.fromEntries(files.sort(([left], [right]) => left.localeCompare(right)));
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("check compact stable TODO reference gate", () => {
  it("passes unchanged when active state is clean and history alone uses volatile references", () => {
    const root = temporary("history");
    write(root, ".agentera/docs.yaml", ["# TODO line 8", '"TODO.md:9": quoted key', "note: stable TODO anchor", "near_miss: TODO.md line 8", ""].join("\n"));
    writeProgressEntity(root, 0, "Stable progress reference");
    write(root, ".agentera/archive/progress-1.yaml", "note: TODO line 13\n");
    write(root, ".agentera/migrations/legacy.yaml", "note: TODO.md:14\n");
    const before = fixtureFiles(root);

    const result = runGate(root);

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      summary: Record<string, unknown>;
      operations: Array<Record<string, unknown>>;
    };
    expect(payload.summary).toMatchObject({
      status: "pass",
      mode: "check",
      artifact_count: 1,
      changed_count: 0,
      action_counts: { skipped: 1 },
    });
    expect(payload.operations).toEqual([expect.objectContaining({ artifact: "entity_state", action: "skipped" })]);
    expect(fixtureFiles(root)).toEqual(before);
  });

  it("fails with capped path-sorted active-state diagnostics and never rewrites fixtures", () => {
    const root = temporary("violations");
    write(root, ".agentera/aaa.yaml", "first: TODO line 1\nsecond: TODO.md:2\n");
    for (let index = 20; index >= 0; index -= 1) {
      writeProgressEntity(root, index, `TODO.md:${index + 1}`, index === 0 ? "TODO line 3" : undefined);
    }
    const before = fixtureFiles(root);

    const check = runGate(root);

    expect(check.status, check.stderr).toBe(1);
    const checkPayload = JSON.parse(check.stdout) as {
      status: string;
      summary: Record<string, unknown>;
      operations: Array<Record<string, unknown>>;
    };
    const hygiene = checkPayload.operations.find((operation) => operation.action === "volatile_todo_reference")!;
    const diagnostics = hygiene.diagnostics as Array<{ path: string; reference: string }>;
    expect(checkPayload.status).toBe("fail");
    expect(checkPayload.summary).toMatchObject({
      status: "fail",
      mode: "check",
      error_count: 0,
      action_counts: { volatile_todo_reference: 1 },
    });
    expect(hygiene).toMatchObject({
      artifact: "state_todo_references",
      classification: "hygiene",
      active_count: 24,
      omitted_count: 4,
    });
    expect(diagnostics).toHaveLength(20);
    const diagnosticPaths = diagnostics.map(({ path }) => path);
    expect(diagnosticPaths).toEqual(diagnosticPaths.toSorted());
    expect(diagnostics.slice(0, 2)).toEqual([
      { path: ".agentera/aaa.yaml", reference: "TODO line 1" },
      { path: ".agentera/aaa.yaml", reference: "TODO.md:2" },
    ]);
    expect(diagnostics).toContainEqual({
      path: ".agentera/entities/progress/progress_cycle/aaaaaaaaaa.yaml",
      reference: "TODO.md:1",
    });
    expect(diagnostics).toContainEqual({
      path: ".agentera/entities/progress/progress_cycle/aaaaaaaaaa.yaml",
      reference: "TODO line 3",
    });
    expect(fixtureFiles(root)).toEqual(before);

    const apply = runGate(root, "--apply");

    expect(apply.status, apply.stderr).toBe(1);
    const applyPayload = JSON.parse(apply.stdout) as {
      status: string;
      summary: Record<string, unknown>;
      operations: Array<Record<string, unknown>>;
    };
    expect(applyPayload).toMatchObject({
      status: "fail",
      summary: { status: "fail", mode: "fix", changed_count: 0 },
    });
    expect(applyPayload.operations).toContainEqual(
      expect.objectContaining({
        action: "volatile_todo_reference",
        omitted_count: 4,
      }),
    );
    expect(fixtureFiles(root)).toEqual(before);
  });
});

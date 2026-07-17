import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { dumpYamlMapping } from "../../src/core/yaml.js";
import { runStateGet } from "../../src/cli/commands/state/get.js";
import { runStateList } from "../../src/cli/commands/state/list.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import {
  appendProgressEntity,
  getProgressEntity,
  listProgressEntities,
} from "../../src/state/progressEntities.js";
import { detectStateMode } from "../../src/state/stateMode.js";
import { executeStateWrite } from "../../src/state/write/transaction.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";
import { buildExplain } from "../../src/state/write/explain.js";

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-progress-entities-"));
  roots.push(root);
  return root;
}

function activate(root: string): void {
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agentera/state-mode.yaml"),
    "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
  );
}

function request(
  root: string,
  what = "shipped",
  timestamp = "2026-07-17 12:00",
): StateWriteRequest {
  const spec = operationSpec("progress", "append");
  if (!spec) throw new Error("progress append spec missing");
  const values = {
    timestamp,
    type: "feat",
    phase: "build",
    what,
    verified: `verified ${what}`,
    context: { intent: `deliver ${what}`, constraints: "progress only" },
  };
  return {
    artifact: "progress",
    spec,
    projectRoot: root,
    dryRun: false,
    force: false,
    values,
    callerPayload: structuredClone(values),
    input: null,
  };
}

function git(root: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("progress entity authority", () => {
  it("selects exactly one authority from the read-only cutover marker", () => {
    const legacy = project();
    expect(detectStateMode(legacy)).toBe("legacy");
    executeStateWrite(request(legacy));
    expect(fs.existsSync(path.join(legacy, ".agentera/progress.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(legacy, ".agentera/entities"))).toBe(false);

    const entities = project();
    activate(entities);
    expect(detectStateMode(entities)).toBe("entities");
    const result = executeStateWrite(request(entities));
    expect(result).toMatchObject({
      artifact: "progress",
      id: expect.stringMatching(/^[a-z]{10}$/),
    });
    expect(fs.existsSync(path.join(entities, ".agentera/progress.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(entities, ".agentera/archive/progress"))).toBe(false);
    expect(buildExplain("progress", entities, "append")).toMatchObject({
      artifact: "progress",
      path: ".agentera/entities/progress/progress_cycle/<id>.yaml",
      next: {},
    });

    const dryRunRoot = project();
    activate(dryRunRoot);
    const dryRun = request(dryRunRoot);
    dryRun.dryRun = true;
    expect(executeStateWrite(dryRun)).toMatchObject({
      artifact: "progress",
      operation: { dry_run: true },
    });
    expect(fs.existsSync(path.join(dryRunRoot, ".agentera/entities"))).toBe(false);

    const corruptMarker = project();
    activate(corruptMarker);
    fs.writeFileSync(path.join(corruptMarker, ".agentera/state-mode.yaml"), "mode: entities\n");
    expect(() => detectStateMode(corruptMarker)).toThrow(/must declare schemaVersion/);
    expect(fs.existsSync(path.join(corruptMarker, ".agentera/entities"))).toBe(false);
  });

  it("appends, replays, retrieves, and rejects divergent content by bare ID", () => {
    const root = project();
    activate(root);
    const first = appendProgressEntity(request(root), { id: "aaaaaaaaaa" });
    const replay = appendProgressEntity(request(root), { id: "aaaaaaaaaa" });
    expect(first).toMatchObject({
      id: "aaaaaaaaaa",
      artifact: "progress",
      operation: { idempotent_replay: false },
    });
    expect(replay).toMatchObject({ id: "aaaaaaaaaa", operation: { idempotent_replay: true } });
    expect(first.record).not.toHaveProperty("number");
    expect(getProgressEntity(root, "aaaaaaaaaa")).toMatchObject({
      entry: {
        id: "aaaaaaaaaa",
        artifact: "progress",
        record: { what: "shipped" },
        provenance: { storage: "canonical_entity_file", detail: "full" },
      },
    });
    expect(() => appendProgressEntity(request(root, "different"), { id: "aaaaaaaaaa" })).toThrow(
      /divergent content/,
    );

    let output = "";
    expect(
      runStateGet(
        "progress",
        ["--id", "aaaaaaaaaa", "--format", "json"],
        {
          out: (text) => {
            output += text;
          },
        },
        root,
      ),
    ).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ entry: { id: "aaaaaaaaaa", artifact: "progress" } });
    output = "";
    expect(
      runStateGet(
        "progress",
        ["--number", "1", "--format", "json"],
        {
          out: (text) => {
            output += text;
          },
        },
        root,
      ),
    ).toBe(2);
    const numericFailure = JSON.parse(output);
    expect(numericFailure.error).toMatchObject({ class: "invalid_request", artifact: "progress" });
    expect(numericFailure.error).not.toHaveProperty("artifact_id");
    expect(numericFailure.error.syntax).toContain("--id ID");
    output = "";
    expect(
      runStateList(
        "progress",
        ["--limit", "0", "--format", "json"],
        {
          out: (text) => {
            output += text;
          },
        },
        root,
      ),
    ).toBe(2);
    const listFailure = JSON.parse(output);
    expect(listFailure.error).toMatchObject({ class: "invalid_request", artifact: "progress" });
    expect(listFailure.error).not.toHaveProperty("artifact_id");
  });

  it("pages whole full-detail entries with deterministic ordering and snapshot-bound cursors", () => {
    const root = project();
    activate(root);
    appendProgressEntity(request(root, "older", "2026-07-17 10:00"), { id: "bbbbbbbbbb" });
    appendProgressEntity(request(root, "tie-b", "2026-07-17 11:00"), { id: "cccccccccc" });
    appendProgressEntity(request(root, "tie-a", "2026-07-17 11:00"), { id: "aaaaaaaaaa" });

    const first = listProgressEntities(root, 2) as any;
    expect(first.entries.map((entry: any) => entry.id)).toEqual(["aaaaaaaaaa", "cccccccccc"]);
    expect(first).toMatchObject({
      omitted: true,
      omitted_count: 1,
      omission_reason: "page_limit",
      counts: { total: 3, returned: 2, remaining: 1 },
    });
    expect(
      first.entries.every(
        (entry: any) => entry.record.verified && entry.provenance.detail === "full",
      ),
    ).toBe(true);
    const second = listProgressEntities(root, 2, {}, first.next_cursor) as any;
    expect(second.entries.map((entry: any) => entry.id)).toEqual(["bbbbbbbbbb"]);
    expect(getProgressEntity(root, "bbbbbbbbbb")).toMatchObject({
      entry: { record: { what: "older" } },
    });

    appendProgressEntity(request(root, "new", "2026-07-17 12:00"), { id: "dddddddddd" });
    expect(() => listProgressEntities(root, 2, {}, first.next_cursor)).toThrow(/source changed/);

    const filtered = listProgressEntities(root, 1, { status: "feat" }) as any;
    expect(filtered.retrieval.continue).toContain('--status "feat"');
  });

  it("refuses scalar truncation when one canonical entry exceeds the list budget", () => {
    const root = project();
    activate(root);
    appendProgressEntity(request(root, "x".repeat(40_000)), { id: "aaaaaaaaaa" });
    expect(() => listProgressEntities(root, 20)).toThrow(/cannot fit.*list budget/);
    expect((getProgressEntity(root, "aaaaaaaaaa") as any).entry.record.what).toHaveLength(40_000);
  });

  it("returns actionable not-found, corrupt, and duplicate failures", () => {
    const root = project();
    activate(root);
    expect(() => getProgressEntity(root, "aaaaaaaaaa")).toThrow(/no progress entity exists/);
    const progressDir = path.join(root, ".agentera/entities/progress/progress_cycle");
    fs.mkdirSync(progressDir, { recursive: true });
    fs.writeFileSync(path.join(progressDir, "bbbbbbbbbb.yaml"), "not: [valid\n");
    expect(() => getProgressEntity(root, "bbbbbbbbbb")).toThrow(/corrupt/);
    fs.writeFileSync(
      path.join(progressDir, "dddddddddd.yaml"),
      dumpYamlMapping({ id: "eeeeeeeeee", artifact: "progress", record: {} }),
    );
    expect(() => getProgressEntity(root, "dddddddddd")).toThrow(/does not match its canonical ID/);

    fs.writeFileSync(
      path.join(progressDir, "cccccccccc.yaml"),
      dumpYamlMapping({
        id: "cccccccccc",
        artifact: "progress",
        record: { timestamp: "2026-07-17 12:00" },
      }),
    );
    const duplicateDir = path.join(root, ".agentera/entities/health/health_audit");
    fs.mkdirSync(duplicateDir, { recursive: true });
    fs.writeFileSync(
      path.join(duplicateDir, "cccccccccc.yaml"),
      dumpYamlMapping({ id: "cccccccccc", artifact: "health", record: {} }),
    );
    expect(() => getProgressEntity(root, "cccccccccc")).toThrow(/multiple canonical candidates/);
  });

  it("lets ordinary Git merge unrelated progress appends without an aggregate conflict", () => {
    const root = project();
    activate(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.test");
    git(root, "add", ".agentera/state-mode.yaml");
    git(root, "commit", "-m", "base");

    const left = `${root}-left`;
    const right = `${root}-right`;
    roots.push(left, right);
    git(root, "worktree", "add", "-b", "left", left, "main");
    git(root, "worktree", "add", "-b", "right", right, "main");
    appendProgressEntity(request(left, "left"), { id: "aaaaaaaaaa" });
    git(left, "add", ".agentera/entities");
    git(left, "commit", "-m", "left progress");
    appendProgressEntity(request(right, "right"), { id: "bbbbbbbbbb" });
    git(right, "add", ".agentera/entities");
    git(right, "commit", "-m", "right progress");

    git(root, "merge", "--ff-only", "left");
    git(root, "merge", "--no-edit", "right");
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 });
    expect(
      (listProgressEntities(root, 20) as any).entries.map((entry: any) => entry.id).sort(),
    ).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
    expect(fs.existsSync(path.join(root, ".agentera/progress.yaml"))).toBe(false);
  });
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { dumpYamlMapping } from "../../src/core/yaml.js";
import { main } from "../../src/cli/dispatch.js";
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

function writeProgressEnvelope(root: string, id: string, caveat: unknown): string {
  const target = path.join(root, ".agentera/entities/progress/progress_cycle", `${id}.yaml`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, dumpYamlMapping({
    id,
    artifact: "progress",
    record: {
      timestamp: "2026-07-27 09:30",
      type: "test",
      phase: "build",
      what: "fixture",
      context: { intent: "validate caveat" },
      glossary_caveat: caveat,
    },
  }));
  return target;
}

function validCaveat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caveat_id: "caveatidxx",
    event: "current",
    capability: "build",
    reason: "inferred_equivalence",
    ownership_state: "review_required",
    transition_id: null,
    ...overrides,
  };
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
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function expectNoProgressWrite(...projectRoots: string[]): void {
  for (const root of projectRoots) {
    expect(fs.existsSync(path.join(root, ".agentera/progress.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/entities/progress"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/.writer.lock"))).toBe(false);
    if (fs.existsSync(path.join(root, ".agentera"))) {
      expect(fs.readdirSync(path.join(root, ".agentera")).some((name) => name.startsWith(".writer."))).toBe(false);
    }
  }
}

describe("progress entity authority", () => {
  it("publishes bounded Build caveat lifecycle events idempotently without glossary writes", () => {
    const root = project(); activate(root);
    const append = (extra: string[], what = "conservative work") => { let out = ""; let err = ""; const rc = main(["node", "agentera", "state", "progress", "append", "--project", root, "--type", "feat", "--phase", "build", "--what", what, "--intent", "Avoid disputed terminology", "--verified", "bounded caveat verified", "--format", "json", ...extra], { out: (text) => { out += text; }, err: (text) => { err += text; } }); return { rc, out, err, json: out ? JSON.parse(out) : null }; };
    const currentFlags = ["--glossary-caveat-event", "current", "--glossary-caveat-reason", "inferred_equivalence", "--glossary-caveat-ownership-state", "review_required"];
    const current = append(currentFlags);
    expect(current.rc).toBe(0);
    expect(current.json.record.glossary_caveat).toEqual({ caveat_id: expect.stringMatching(/^[a-z]{10}$/), event: "current", capability: "build", reason: "inferred_equivalence", ownership_state: "review_required", transition_id: null });
    const caveatId = current.json.record.glossary_caveat.caveat_id as string;
    expect(append(currentFlags, "retried work").json).toMatchObject({ id: current.json.id, operation: { idempotent_replay: true } });
    const successor = append(["--glossary-caveat-event", "current", "--glossary-caveat-reason", "authority_unavailable", "--glossary-caveat-ownership-state", "authority_unavailable"]);
    const successorId = successor.json.record.glossary_caveat.caveat_id as string;
    const supersededFlags = ["--glossary-caveat-event", "superseded", "--glossary-caveat-reason", "inferred_equivalence", "--glossary-caveat-ownership-state", "review_required", "--glossary-caveat-id", caveatId, "--glossary-caveat-transition-id", successorId];
    const superseded = append(supersededFlags);
    expect(superseded.json.record.glossary_caveat).toMatchObject({ caveat_id: caveatId, event: "superseded", transition_id: successorId });
    expect(append(supersededFlags).json).toMatchObject({ id: superseded.json.id, operation: { idempotent_replay: true } });
    const resolvedFlags = ["--glossary-caveat-event", "resolved", "--glossary-caveat-reason", "authority_unavailable", "--glossary-caveat-ownership-state", "authority_unavailable", "--glossary-caveat-id", successorId];
    expect(append(resolvedFlags).json.record.glossary_caveat).toMatchObject({ caveat_id: successorId, event: "resolved", transition_id: null });
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
    expect(fs.readdirSync(path.join(root, ".agentera/entities/progress/progress_cycle"))).toHaveLength(4);
  });

  it("rejects private caveat vocabulary without echoing or writing it", () => {
    const root = project(); activate(root); const trap = "PRIVATE_TERM_MEANING_ANCHOR_PATH_PROVENANCE"; let out = ""; let err = "";
    const rc = main(["node", "agentera", "state", "progress", "append", "--project", root, "--type", "feat", "--phase", "build", "--what", "safe", "--intent", "safe", "--glossary-caveat-event", "current", "--glossary-caveat-reason", trap, "--glossary-caveat-ownership-state", "review_required", "--format", "json"], { out: (text) => { out += text; }, err: (text) => { err += text; } });
    expect(rc).not.toBe(0); expect(out + err).not.toContain(trap); expectNoProgressWrite(root); expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
  });

  it("distinguishes absent caveats from present-invalid mutation input", () => {
    const root = project(); activate(root);
    expect(executeStateWrite(request(root))).toMatchObject({ status: "pass" });
    for (const glossary_caveat of [
      null,
      { event: "current", reason: "inferred_equivalence", ownership_state: "review_required", PRIVATE_TRAP_FIELD: "PRIVATE_TRAP_VALUE" },
    ]) {
      const candidate = request(root, "invalid mutation");
      candidate.values.glossary_caveat = glossary_caveat;
      expect(() => executeStateWrite(candidate)).toThrow(/glossary caveat mutation/);
    }
    expect(fs.readdirSync(path.join(root, ".agentera/entities/progress/progress_cycle"))).toHaveLength(1);
  });

  it.each([
    ["null envelope", null],
    ["malformed ID", validCaveat({ caveat_id: "PRIVATE_TRAP_VALUE" })],
    ["capability", validCaveat({ capability: "PRIVATE_TRAP_VALUE" })],
    ["reason", validCaveat({ reason: "PRIVATE_TRAP_VALUE" })],
    ["ownership", validCaveat({ ownership_state: "PRIVATE_TRAP_VALUE" })],
    ["null reason", validCaveat({ reason: null })],
    ["over bound", validCaveat({ reason: "P".repeat(65) })],
    ["current transition", validCaveat({ transition_id: "privatetrap" })],
    ["superseded null transition", validCaveat({ event: "superseded" })],
    ["private field", { ...validCaveat(), PRIVATE_TRAP_FIELD: "PRIVATE_TRAP_VALUE" }],
  ])("fails closed across validation, retrieval, and append for %s", (_name, caveat) => {
    const root = project();
    activate(root);
    executeStateWrite(request(root, "preserved ordinary progress"));
    writeProgressEnvelope(root, "zzzzzzzzzz", caveat);
    const before = fs.readdirSync(path.join(root, ".agentera/entities/progress/progress_cycle")).sort();

    const validation = validateEntityState(root);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "malformed_entity", id: "zzzzzzzzzz" }),
    ]));

    for (const argv of [
      ["state", "progress", "list", "--format", "json"],
      ["state", "progress", "get", "--id", "zzzzzzzzzz", "--format", "json"],
      ["state", "progress", "append", "--type", "test", "--phase", "build", "--what", "blocked", "--intent", "fail before effects", "--format", "json"],
      ["check", "validate", "state", "--cwd", root, "--format", "json"],
    ]) {
      let out = ""; let err = "";
      const rc = main(["node", "agentera", ...argv, ...(argv[0] === "state" ? ["--project", root] : [])], { out: (text) => { out += text; }, err: (text) => { err += text; } });
      expect(rc).not.toBe(0);
      expect(out + err).not.toContain("PRIVATE_TRAP");
      expect(out + err).not.toContain("P".repeat(65));
    }
    expect(fs.readdirSync(path.join(root, ".agentera/entities/progress/progress_cycle")).sort()).toEqual(before);
    expect(getProgressEntity(root, before.find((name) => name !== "zzzzzzzzzz.yaml")!.replace(".yaml", ""))).toMatchObject({ entry: { record: { what: "preserved ordinary progress" } } });
  });

  it("marks invalid caveat lifecycle relationships malformed while accepting valid lifecycles", () => {
    const valid = project(); activate(valid);
    writeProgressEnvelope(valid, "aaaaaaaaaa", validCaveat({ caveat_id: "firstcavea" }));
    writeProgressEnvelope(valid, "bbbbbbbbbb", validCaveat({ caveat_id: "firstcavea", event: "resolved" }));
    writeProgressEnvelope(valid, "cccccccccc", validCaveat({ caveat_id: "nextcaveat", reason: "authority_unavailable", ownership_state: "authority_unavailable" }));
    writeProgressEnvelope(valid, "dddddddddd", validCaveat({ caveat_id: "oldcaveatx" }));
    writeProgressEnvelope(valid, "eeeeeeeeee", validCaveat({ caveat_id: "oldcaveatx", event: "superseded", transition_id: "nextcaveat" }));
    expect(validateEntityState(valid)).toMatchObject({ valid: true, entityCount: 5 });

    const missingCurrent = project(); activate(missingCurrent);
    writeProgressEnvelope(missingCurrent, "aaaaaaaaaa", validCaveat({ event: "resolved" }));
    expect(validateEntityState(missingCurrent)).toMatchObject({ valid: false });

    const duplicateCurrent = project(); activate(duplicateCurrent);
    writeProgressEnvelope(duplicateCurrent, "aaaaaaaaaa", validCaveat());
    writeProgressEnvelope(duplicateCurrent, "bbbbbbbbbb", validCaveat());
    expect(validateEntityState(duplicateCurrent)).toMatchObject({ valid: false });

    const missingSuccessor = project(); activate(missingSuccessor);
    writeProgressEnvelope(missingSuccessor, "aaaaaaaaaa", validCaveat());
    writeProgressEnvelope(missingSuccessor, "bbbbbbbbbb", validCaveat({ event: "superseded", transition_id: "nextcaveat" }));
    expect(validateEntityState(missingSuccessor)).toMatchObject({ valid: false });
  });

  it("requires entity authority and never publishes a marker-absent aggregate", () => {
    const legacy = project();
    expect(detectStateMode(legacy)).toBe("legacy");
    expect(() => executeStateWrite(request(legacy))).toThrow(/durable entity-state marker/);
    expect(fs.existsSync(path.join(legacy, ".agentera/progress.yaml"))).toBe(false);
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

  it("rejects root replacement through lock publication and cleans descriptors and lock residue", () => {
    const parent = project();
    const root = path.join(parent, "project");
    const held = path.join(parent, "held");
    const replacement = path.join(parent, "replacement");
    fs.mkdirSync(root);
    fs.mkdirSync(replacement);
    activate(root);
    activate(replacement);
    const writeRequest = request(root);
    const originalRename = fs.renameSync.bind(fs);
    const originalOpen = fs.openSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    const openDescriptors = new Set<number>();
    let replaced = false;

    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      const descriptor = Reflect.apply(originalOpen, fs, args);
      if (typeof args[0] === "string" && (args[0].includes(".writer") || args[0].includes(".agentera"))) {
        openDescriptors.add(descriptor);
      }
      return descriptor;
    });
    vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      openDescriptors.delete(descriptor);
      return originalClose(descriptor);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (!replaced && String(destination).endsWith("/.writer.lock")) {
        originalRename(root, held);
        originalRename(replacement, root);
        replaced = true;
      }
      return originalRename(source, destination);
    });

    expect(() => executeStateWrite(writeRequest)).toThrow(/project root .* changed after validation.*exact real directory/i);
    expect(replaced).toBe(true);
    expect(openDescriptors).toEqual(new Set());
    expectNoProgressWrite(held, root);
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

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

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
import { decodeListCursor, encodeListCursor } from "../../src/state/listCursor.js";
import { sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

const roots: string[] = [];
const progressPublicationWorker = fileURLToPath(new URL("./progressPublicationWorker.mjs", import.meta.url));
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-progress-entities-"));
  roots.push(root);
  return root;
}

function authoritySource(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-progress-authority-"));
  roots.push(root);
  const directory = path.join(root, "references", "artifacts");
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ["state-storage-authority.yaml", "glossary-entry-contract.yaml"])
    fs.copyFileSync(path.join(SOURCE_ROOT, "references", "artifacts", name), path.join(directory, name));
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
  it("refreshes glossary authority when unchanged state authority remains cached", () => {
    const root = project(); activate(root); writeProgressEnvelope(root, "caveatidxx", validCaveat());
    const sourceRoot = authoritySource();
    const statePath = path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml");
    const glossaryPath = path.join(sourceRoot, "references/artifacts/glossary-entry-contract.yaml");
    const stateBytes = fs.readFileSync(statePath);
    expect(validateEntityState(root, sourceRoot).valid).toBe(true);

    const glossary = fs.readFileSync(glossaryPath, "utf8");
    const changed = glossary.replace(
      "reasons: [inferred_equivalence, authority_unavailable, personal_input_unavailable]",
      "reasons: [authority_unavailable, personal_input_unavailable]",
    );
    expect(changed).not.toBe(glossary);
    fs.writeFileSync(glossaryPath, changed);

    const refreshed = validateEntityState(root, sourceRoot);
    expect(fs.readFileSync(statePath)).toEqual(stateBytes);
    expect(refreshed.valid).toBe(false);
    expect(refreshed.entities).toEqual([expect.objectContaining({ id: "caveatidxx", classification: "malformed" })]);
    expect(refreshed.issues.some(({ message }) => message.includes("glossary_caveat"))).toBe(true);
  });

  it("publishes bounded Build caveat lifecycle events idempotently without glossary writes", () => {
    const root = project(); activate(root);
    const append = (extra: string[], what = "conservative work") => {
      let out = ""; let err = "";
      const caveat: Record<string, unknown> = {};
      const fields: Record<string, string> = { "--glossary-caveat-event": "event", "--glossary-caveat-reason": "reason", "--glossary-caveat-ownership-state": "ownership_state", "--glossary-caveat-id": "caveat_id", "--glossary-caveat-transition-id": "transition_id" };
      for (let index = 0; index < extra.length; index += 2) caveat[fields[extra[index]]] = extra[index + 1];
      const input = { type: "feat", phase: "build", what, verified: "bounded caveat verified", context: { intent: "Avoid disputed terminology" }, glossary_caveat: caveat };
      const rc = main(["node", "agentera", "state", "progress", "append", "--project", root, "--input", "-", "--format", "json"], { out: (text) => { out += text; }, err: (text) => { err += text; }, stdin: () => JSON.stringify(input) });
      return { rc, out, err, json: out ? JSON.parse(out) : null };
    };
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
    const rc = main(["node", "agentera", "state", "progress", "append", "--project", root, "--input", "-", "--format", "json"], { out: (text) => { out += text; }, err: (text) => { err += text; }, stdin: () => JSON.stringify({ type: "feat", phase: "build", what: "safe", context: { intent: "safe" }, glossary_caveat: { event: "current", reason: trap, ownership_state: "review_required" } }) });
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
      ["state", "progress", "append", "--input", "-", "--format", "json"],
      ["check", "validate", "state", "--cwd", root, "--format", "json"],
    ]) {
      let out = ""; let err = "";
      const rc = main(["node", "agentera", ...argv, ...(argv[0] === "state" ? ["--project", root] : [])], { out: (text) => { out += text; }, err: (text) => { err += text; }, stdin: () => JSON.stringify({ type: "test", phase: "build", what: "blocked", context: { intent: "fail before effects" } }) });
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
      writer_owned_fields: ["id", "artifact", "publication_order"],
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

  it("rejects marker replacement through lock publication and cleans lock residue", () => {
    const root = project();
    activate(root);
    const writeRequest = request(root);
    const originalRename = fs.renameSync.bind(fs);
    let replaced = false;

    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (!replaced && String(destination).endsWith("/.writer.lock")) {
        fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n# changed\n");
        replaced = true;
      }
      return originalRename(source, destination);
    });

    expect(() => executeStateWrite(writeRequest)).toThrow(/state mode marker .* changed.*conflict/i);
    expect(replaced).toBe(true);
    expectNoProgressWrite(root);
    expect(fs.existsSync(path.join(root, ".agentera/.writer.lock"))).toBe(false);
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
    expect(first.record).toMatchObject({ publication_order: 1 });
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
    expect(first.entries.map((entry: any) => entry.record.publication_order)).toEqual([3, 2]);
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

    const filtered = listProgressEntities(root, 1, { topic: "deliver", status: "feat" }, undefined, { selector: { idsOnly: true } }) as any;
    expect(filtered.retrieval.continue).toMatch(/^agentera state progress list --topic 'deliver' --status 'feat' --ids-only --limit 1 --cursor \S+$/);

    const authorityPath = path.resolve(import.meta.dirname, "../../../..", "references/artifacts/state-storage-authority.yaml");
    const prior = decodeListCursor(first.next_cursor, root, authorityPath) as any;
    const priorCursor = encodeListCursor({
      ...prior,
      version: 1,
      order: "timestamp_desc_then_id_asc",
    }, root, authorityPath);
    expect(() => listProgressEntities(root, 2, {}, priorCursor)).toThrow(/version 2 progress ordering contract/);
  });

  it("makes the last same-minute publication latest across restart and copy regardless of opaque ID", () => {
    const root = project();
    activate(root);
    appendProgressEntity(request(root, "published first"), { id: "aaaaaaaaaa" });
    appendProgressEntity(request(root, "published last"), { id: "zzzzzzzzzz" });

    const listed = listProgressEntities(root, 20) as any;
    expect(listed.entries.map((entry: any) => [entry.id, entry.record.publication_order])).toEqual([
      ["zzzzzzzzzz", 2],
      ["aaaaaaaaaa", 1],
    ]);

    const copied = project();
    fs.rmSync(copied, { recursive: true });
    fs.cpSync(root, copied, { recursive: true });
    expect((listProgressEntities(copied, 1) as any).entries[0]).toMatchObject({
      id: "zzzzzzzzzz",
      record: { what: "published last", publication_order: 2 },
    });
  });

  it("projects the final same-minute publication as latest in complete Prime JSON, status, and text", () => {
    const root = project();
    activate(root);
    appendProgressEntity(request(root, "lexically first but published first"), { id: "aaaaaaaaaa" });
    appendProgressEntity(request(root, "final resolved publication"), { id: "zzzzzzzzzz" });
    const prime = (args: string[]) => {
      const cwd = process.cwd();
      let out = "";
      let err = "";
      process.chdir(root);
      try {
        const rc = main(["node", "agentera", "prime", ...args], {
          out: (text) => { out += text; },
          err: (text) => { err += text; },
        });
        expect(rc, err || out).toBe(0);
        return out;
      } finally {
        process.chdir(cwd);
      }
    };
    const json = JSON.parse(prime(["--format", "json"]));
    expect(json.progress.latest).toMatchObject({ id: "zzzzzzzzzz", what: "final resolved publication" });
    const status = JSON.parse(prime(["--context", "status", "--format", "json"]));
    expect(JSON.stringify(status.capability_context.context.status_context)).toContain("final resolved publication");
    const text = prime([]);
    expect(text).toContain("final resolved publication");
    expect(text).not.toContain("lexically first but published first");
  });

  it("assigns unique monotonic same-minute order under the cross-process publication lock", async () => {
    const root = project();
    activate(root);
    const start = path.join(root, "race.start");
    const ready = ["first", "second"].map((name) => path.join(root, `${name}.ready`));
    const results = ["first", "second"].map((name) => path.join(root, `${name}.json`));
    const children = results.map((result, index) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [progressPublicationWorker], {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env: {
          ...sourceSubprocessEnv(),
          AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.resolve(import.meta.dirname, "../../../.."),
          AGENTERA_PROGRESS_RACE_ROOT: root,
          AGENTERA_PROGRESS_RACE_READY: ready[index],
          AGENTERA_PROGRESS_RACE_START: start,
          AGENTERA_PROGRESS_RACE_RESULT: result,
          AGENTERA_PROGRESS_RACE_WHAT: `publisher ${index}`,
        },
        stdio: "pipe",
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`progress worker exited ${code}: ${stderr}`)));
    }));
    const deadline = Date.now() + 10_000;
    while (!ready.every((file) => fs.existsSync(file))) {
      if (Date.now() > deadline) throw new Error("progress workers did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(start, "start\n");
    await Promise.all(children);
    for (const result of results.map((file) => JSON.parse(fs.readFileSync(file, "utf8")))) {
      expect(result.code, result.stderr).toBe(0);
    }
    expect((listProgressEntities(root, 20) as any).entries.map((entry: any) => entry.record.publication_order)).toEqual([2, 1]);
  });

  it("orders mixed legacy and duplicate-marker ties deterministically without inventing chronology", () => {
    const root = project();
    activate(root);
    const directory = path.join(root, ".agentera/entities/progress/progress_cycle");
    fs.mkdirSync(directory, { recursive: true });
    const write = (id: string, what: string, publicationOrder?: number) => fs.writeFileSync(
      path.join(directory, `${id}.yaml`),
      dumpYamlMapping({
        id,
        artifact: "progress",
        record: {
          timestamp: "2026-07-17 12:00",
          type: "feat",
          phase: "build",
          what,
          context: { intent: what },
          ...(publicationOrder === undefined ? {} : { publication_order: publicationOrder }),
        },
      }),
    );
    write("dddddddddd", "legacy d");
    write("bbbbbbbbbb", "legacy b");
    write("cccccccccc", "duplicate c", 4);
    write("aaaaaaaaaa", "duplicate a", 4);

    expect(validateEntityState(root).valid).toBe(true);
    expect((listProgressEntities(root, 20) as any).entries.map((entry: any) => entry.id)).toEqual([
      "aaaaaaaaaa",
      "cccccccccc",
      "bbbbbbbbbb",
      "dddddddddd",
    ]);
    const published = appendProgressEntity(request(root, "new publication"), { id: "zzzzzzzzzz" });
    expect(published.record.publication_order).toBe(5);
    expect((listProgressEntities(root, 1) as any).entries[0].id).toBe("zzzzzzzzzz");
  });

  it("rejects malformed or spoofed publication order and leaves dry-run ordering unconsumed", () => {
    const root = project();
    activate(root);
    let out = "";
    let err = "";
    const rc = main([
      "node", "agentera", "state", "progress", "append", "--project", root,
      "--input", "-", "--format", "json",
    ], { out: (text) => { out += text; }, err: (text) => { err += text; }, stdin: () => JSON.stringify({ timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "spoofed", context: { intent: "spoofed" }, publication_order: 99 }) });
    expect(rc).toBe(2);
    expect(out + err).toMatch(/publication[_-]order|unrecognized/);
    expect(Buffer.byteLength(out + err)).toBeLessThan(2048);
    expectNoProgressWrite(root);

    const spoofed = request(root, "spoofed");
    spoofed.values.publication_order = 99;
    spoofed.callerPayload.publication_order = 99;
    expect(() => appendProgressEntity(spoofed)).toThrow(/writer-owned/);
    expectNoProgressWrite(root);

    const preview = request(root, "preview");
    preview.dryRun = true;
    expect(appendProgressEntity(preview, { id: "aaaaaaaaaa" }).record).not.toHaveProperty("publication_order");
    expectNoProgressWrite(root);
    expect(appendProgressEntity(request(root, "published"), { id: "zzzzzzzzzz" }).record.publication_order).toBe(1);

    const target = path.join(root, ".agentera/entities/progress/progress_cycle/zzzzzzzzzz.yaml");
    const malformed = YAML.parse(fs.readFileSync(target, "utf8"));
    malformed.record.publication_order = "private-spoof";
    fs.writeFileSync(target, dumpYamlMapping(malformed));
    const validation = validateEntityState(root);
    expect(validation.valid).toBe(false);
    expect(validation.issues[0]?.message).toMatch(/positive safe integer/);
    expect(() => listProgressEntities(root, 20)).toThrow(/corrupt/);
  });

  it("degrades oversized optional detail without dropping the summary row", () => {
    const root = project();
    activate(root);
    appendProgressEntity(request(root, "x".repeat(40_000)), { id: "aaaaaaaaaa" });
    expect(listProgressEntities(root, 20)).toMatchObject({
      status: "degraded",
      entries: [{ id: "aaaaaaaaaa", retrieval: { get: "agentera state progress get --id aaaaaaaaaa" } }],
      counts: { candidate: 1, returned: 1, omitted: 0 },
      degradation: { reason: "optional_detail_byte_budget", detail_omitted_count: 1 },
    });
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
    expect(() => getProgressEntity(root, "dddddddddd")).toThrow(/canonical progress evidence is corrupt/);

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
    expect((listProgressEntities(root, 20) as any).entries.map((entry: any) => entry.id)).toEqual([
      "aaaaaaaaaa",
      "bbbbbbbbbb",
    ]);
    expect(fs.existsSync(path.join(root, ".agentera/progress.yaml"))).toBe(false);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../../src/cli/dispatch.js";
import { dumpYamlMapping, loadYamlMapping } from "../../../src/core/yaml.js";
import { operationSpec } from "../../../src/state/write/operations.js";
import { executeStateWrite } from "../../../src/state/write/transaction.js";
import { InjectedMutationFailure } from "../../../src/state/write/mutation.js";

const roots: string[] = [];
const objectiveId = "objective:123e4567-e89b-42d3-a456-426614174000";
const otherObjectiveId = "objective:223e4567-e89b-42d3-a456-426614174000";

function experiment(label = "cache keys"): Record<string, unknown> {
  return {
    date: "2026-07-15 09:00",
    label,
    hypothesis: "Stable keys reduce lookup time",
    method: "Run the locked benchmark",
    change: "Use stable cache keys",
    metric: { primary_value: "80 ms", delta_vs_baseline: "-20 ms" },
    regression: "pnpm test passed",
    status: "kept",
    conclusion: "Stable keys improved lookup time",
  };
}

function project(existing: Record<string, unknown> | null = null): {
  root: string;
  experimentsPath: string;
  objectivePath: string;
  archivePath: (number: number) => string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-experiment-publication-"));
  roots.push(root);
  const directory = path.join(root, ".agentera", "optimize", "latency");
  fs.mkdirSync(directory, { recursive: true });
  const objectivePath = path.join(directory, "objective.yaml");
  fs.writeFileSync(objectivePath, dumpYamlMapping({
    header: { id: objectiveId, title: "Latency", status: "open" },
    objective: { description: "Reduce latency", measurement: "p95", constraints: [] },
    metric: { direction: "minimize", unit: "ms" },
    baseline: { description: "100 ms" },
    gates: {},
    scope: { included: ["CLI"], excluded: [] },
  }));
  const experimentsPath = path.join(directory, "experiments.yaml");
  if (existing) fs.writeFileSync(experimentsPath, dumpYamlMapping(existing));
  return {
    root,
    experimentsPath,
    objectivePath,
    archivePath: (number) => path.join(directory, "archive", "experiments", `${number}.yaml`),
  };
}

function run(root: string, args: string[], input: Record<string, unknown>): {
  rc: number;
  out: string;
  err: string;
  json: Record<string, any> | null;
} {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", "state", "experiments", ...args, "--project", root], {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
    stdin: () => dumpYamlMapping(input),
  });
  return { rc, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
}

function request(root: string, number: number, input: Record<string, unknown>) {
  const spec = operationSpec("experiments", "publish");
  if (!spec) throw new Error("experiment publication operation is unavailable");
  return {
    artifact: "experiments" as const,
    spec,
    projectRoot: root,
    dryRun: false,
    force: false,
    values: { objective: objectiveId, number },
    callerPayload: structuredClone(input),
    input: structuredClone(input),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("validated experiment publication", () => {
  it("discovers the narrow typed publish operation before mutation", () => {
    const { root } = project();
    const result = run(root, ["explain", "--verb", "publish", "--format", "json"], {});

    expect(result).toMatchObject({ rc: 0, err: "" });
    expect(result.json).toMatchObject({
      artifact: "experiments",
      requested_verb: "publish",
      path: ".agentera/optimize/<objective>/experiments.yaml",
      input_schema: { root: "one experiment entry", cli_owned_fields: ["number"] },
      example: expect.stringContaining("state experiments publish"),
    });
    expect(result.json?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ flag: "--objective", required: true }),
      expect.objectContaining({ flag: "--number", required: true }),
    ]));
  });

  it("validates input and assigns objective-scoped identity before publication", () => {
    const { root, experimentsPath, archivePath } = project();
    const result = run(root, [
      "publish", "--objective", objectiveId, "--number", "0", "--input", "-", "--format", "json",
    ], experiment("baseline"));

    expect(result).toMatchObject({ rc: 0, err: "" });
    expect(result.json).toMatchObject({
      schemaVersion: "agentera.stateWrite.v1",
      status: "pass",
      command: "state experiments publish",
      operation: { verb: "publish", idempotent_replay: false },
      assigned: { objective: objectiveId, number: 0, stable_id: `${objectiveId}/experiment:0` },
    });
    expect(loadYamlMapping(fs.readFileSync(experimentsPath, "utf8")).experiments).toEqual([
      { number: 0, ...experiment("baseline") },
    ]);
    expect(loadYamlMapping(fs.readFileSync(archivePath(0), "utf8"))).toMatchObject({
      schemaVersion: "agentera.experimentArchive.v1",
      stable_id: `${objectiveId}/experiment:0`,
      objective_id: objectiveId,
      experiment_number: 0,
      record: { number: 0, ...experiment("baseline") },
      record_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      provenance: {
        authority: "references/artifacts/state-storage-authority.yaml",
        objective_id: objectiveId,
        experiment_id: `${objectiveId}/experiment:0`,
        storage_scope: "objective_directory",
        publication_order: "archive_before_projection",
      },
    });
  });

  it("preserves the 10/40/50 projection while publishing", () => {
    const existing = Array.from({ length: 10 }, (_, number) => ({ number, ...experiment(`experiment ${number}`) }));
    const { root, experimentsPath, archivePath } = project({ experiments: existing });

    const result = run(root, [
      "publish", "--objective", objectiveId, "--number", "10", "--input", "-", "--format", "json",
    ], experiment("experiment 10"));

    expect(result).toMatchObject({ rc: 0, err: "" });
    const document = loadYamlMapping(fs.readFileSync(experimentsPath, "utf8"));
    expect(document.experiments).toHaveLength(10);
    expect(document.archive).toEqual([
      expect.objectContaining({ number: 0, summary: expect.any(String) }),
    ]);
    const archived = loadYamlMapping(fs.readFileSync(archivePath(10), "utf8"));
    expect(archived.record).toEqual({ number: 10, ...experiment("experiment 10") });
    expect(archived.provenance).toMatchObject({ publication_order: "archive_before_projection" });
  });

  it("preserves active and archive bytes on identity, schema, collision, and staged publication failures", () => {
    const initial = { experiments: [{ number: 0, ...experiment("baseline") }], archive: [{ number: 9, summary: "older" }] };
    const { root, experimentsPath, archivePath } = project(initial);
    const before = fs.readFileSync(experimentsPath);

    const invalidIdentity = run(root, [
      "publish", "--objective", "objective:not-valid", "--number", "1", "--input", "-", "--format", "json",
    ], experiment());
    expect(invalidIdentity.rc).toBe(2);
    expect(fs.readFileSync(experimentsPath)).toEqual(before);

    const invalidSchema = run(root, [
      "publish", "--objective", objectiveId, "--number", "1", "--input", "-", "--format", "json",
    ], { label: "incomplete" });
    expect(invalidSchema.rc).toBe(2);
    expect(fs.readFileSync(experimentsPath)).toEqual(before);

    const collision = run(root, [
      "publish", "--objective", objectiveId, "--number", "0", "--input", "-", "--format", "json",
    ], experiment("different"));
    expect(collision.rc).toBe(2);
    expect(fs.readFileSync(experimentsPath)).toEqual(before);

    const legacyDirectory = path.join(root, ".agentera", "optimera", "latency");
    fs.mkdirSync(legacyDirectory, { recursive: true });
    fs.writeFileSync(path.join(legacyDirectory, "objective.yaml"), dumpYamlMapping({
      header: { id: otherObjectiveId, title: "Conflicting latency", status: "open" },
      objective: { description: "Different objective", measurement: "p95", constraints: [] },
      metric: { direction: "minimize", unit: "ms" },
      baseline: { description: "100 ms" },
      gates: {},
      scope: { included: ["CLI"], excluded: [] },
    }));
    const ambiguous = run(root, [
      "publish", "--objective", objectiveId, "--number", "1", "--input", "-", "--format", "json",
    ], experiment());
    expect(ambiguous.rc).toBe(2);
    expect(fs.readFileSync(experimentsPath)).toEqual(before);
    fs.rmSync(path.join(root, ".agentera", "optimera"), { recursive: true });

    expect(() => executeStateWrite(request(root, 1, experiment()), { failAfter: "staged-write" })).toThrowError(
      expect.objectContaining<Partial<InjectedMutationFailure>>({ boundary: "staged-write" }),
    );
    expect(fs.readFileSync(experimentsPath)).toEqual(before);
    expect(fs.existsSync(archivePath(1))).toBe(false);
  });

  it("retries idempotently after interruption following atomic publication", () => {
    const { root, experimentsPath, archivePath } = project();
    const publication = request(root, 0, experiment("baseline"));

    expect(() => executeStateWrite(publication, { failAfter: "projection-publication" })).toThrowError(
      expect.objectContaining<Partial<InjectedMutationFailure>>({ boundary: "projection-publication" }),
    );
    const archiveBytes = fs.readFileSync(archivePath(0));
    expect((loadYamlMapping(fs.readFileSync(experimentsPath, "utf8")).experiments as unknown[])).toHaveLength(1);

    const retry = executeStateWrite(publication);
    expect(retry.operation).toMatchObject({ idempotent_replay: true });
    expect(fs.readFileSync(archivePath(0))).toEqual(archiveBytes);
    expect((loadYamlMapping(fs.readFileSync(experimentsPath, "utf8")).experiments as unknown[])).toHaveLength(1);
  });

  it("keeps archive identity and provenance stable across objective directory rename", () => {
    const { root, archivePath } = project();
    const args = [
      "publish", "--objective", objectiveId, "--number", "0", "--input", "-", "--format", "json",
    ];
    expect(run(root, args, experiment("baseline"))).toMatchObject({ rc: 0, err: "" });
    const archiveBytes = fs.readFileSync(archivePath(0));
    fs.renameSync(
      path.join(root, ".agentera", "optimize", "latency"),
      path.join(root, ".agentera", "optimize", "renamed"),
    );

    const retry = run(root, args, experiment("baseline"));
    expect(retry).toMatchObject({ rc: 0, err: "" });
    expect(retry.json?.operation).toMatchObject({ idempotent_replay: true });
    expect(fs.readFileSync(path.join(root, ".agentera", "optimize", "renamed", "archive", "experiments", "0.yaml"))).toEqual(archiveBytes);
  });

  it("leaves a durable archive before projection replacement and reuses it on retry", () => {
    const { root, experimentsPath, archivePath } = project({
      experiments: [{ number: 0, ...experiment("baseline") }],
    });
    const beforeProjection = fs.readFileSync(experimentsPath);
    const publication = request(root, 1, experiment("candidate"));

    expect(() => executeStateWrite(publication, { failAfter: "archive-publication" })).toThrowError(
      expect.objectContaining<Partial<InjectedMutationFailure>>({ boundary: "archive-publication" }),
    );
    const archiveBytes = fs.readFileSync(archivePath(1));
    expect(fs.readFileSync(experimentsPath)).toEqual(beforeProjection);

    const retry = executeStateWrite(publication);
    expect(retry.operation).toMatchObject({ idempotent_replay: false });
    expect(fs.readFileSync(archivePath(1))).toEqual(archiveBytes);
    expect((loadYamlMapping(fs.readFileSync(experimentsPath, "utf8")).experiments as unknown[])).toHaveLength(2);
    expect(fs.readdirSync(path.dirname(archivePath(1)))).toEqual(["1.yaml"]);
  });

  it("converges across first-publication directory-sync interruptions before replacing projection", () => {
    const { root, experimentsPath, archivePath } = project({
      experiments: [{ number: 0, ...experiment("baseline") }],
    });
    const beforeProjection = fs.readFileSync(experimentsPath);
    const publication = request(root, 1, experiment("candidate"));
    const archiveDirectory = path.dirname(path.dirname(archivePath(1)));
    const experimentsDirectory = path.dirname(archivePath(1));

    expect(() => executeStateWrite(publication, { failAfter: "archive-directory-publication" })).toThrowError(
      expect.objectContaining<Partial<InjectedMutationFailure>>({ boundary: "archive-directory-publication" }),
    );
    expect(fs.readFileSync(experimentsPath)).toEqual(beforeProjection);
    expect(fs.existsSync(archiveDirectory)).toBe(true);
    expect(fs.existsSync(experimentsDirectory)).toBe(false);

    expect(() => executeStateWrite(publication, { failAfter: "archive-directory-publication" })).toThrowError(
      expect.objectContaining<Partial<InjectedMutationFailure>>({ boundary: "archive-directory-publication" }),
    );
    expect(fs.readFileSync(experimentsPath)).toEqual(beforeProjection);
    expect(fs.existsSync(experimentsDirectory)).toBe(true);
    expect(fs.existsSync(archivePath(1))).toBe(false);

    const retry = executeStateWrite(publication);
    expect(retry.archive).toMatchObject({ idempotent_replay: false });
    expect(fs.existsSync(archivePath(1))).toBe(true);
    expect((loadYamlMapping(fs.readFileSync(experimentsPath, "utf8")).experiments as unknown[])).toHaveLength(2);
  });

  it("reconstructs a missing archive from an exact full projection replay before success", () => {
    const { root, experimentsPath, archivePath } = project({
      experiments: [{ number: 0, ...experiment("baseline") }],
    });
    const beforeProjection = fs.readFileSync(experimentsPath);

    const replay = executeStateWrite(request(root, 0, experiment("baseline")));

    expect(replay.operation).toMatchObject({ idempotent_replay: true });
    expect(replay.archive).toMatchObject({ idempotent_replay: false });
    expect(fs.readFileSync(experimentsPath)).toEqual(beforeProjection);
    expect(loadYamlMapping(fs.readFileSync(archivePath(0), "utf8")).record).toEqual({
      number: 0,
      ...experiment("baseline"),
    });
  });

  it("retries interrupted exact-full reconstruction without duplicating archive detail", () => {
    const { root, experimentsPath, archivePath } = project({
      experiments: [{ number: 0, ...experiment("baseline") }],
    });
    const beforeProjection = fs.readFileSync(experimentsPath);
    const publication = request(root, 0, experiment("baseline"));

    expect(() => executeStateWrite(publication, { failAfter: "archive-publication" })).toThrowError(
      expect.objectContaining<Partial<InjectedMutationFailure>>({ boundary: "archive-publication" }),
    );
    const archiveBytes = fs.readFileSync(archivePath(0));
    expect(fs.readFileSync(experimentsPath)).toEqual(beforeProjection);

    const retry = executeStateWrite(publication);
    expect(retry.operation).toMatchObject({ idempotent_replay: true });
    expect(retry.archive).toMatchObject({ idempotent_replay: true });
    expect(fs.readFileSync(archivePath(0))).toEqual(archiveBytes);
    expect(fs.readdirSync(path.dirname(archivePath(0)))).toEqual(["0.yaml"]);
  });

  it("rejects conflicting archive bytes during exact-full reconstruction", () => {
    const { root, experimentsPath, archivePath } = project({
      experiments: [{ number: 0, ...experiment("baseline") }],
    });
    fs.mkdirSync(path.dirname(archivePath(0)), { recursive: true });
    fs.writeFileSync(archivePath(0), "conflicting: bytes\n");
    const beforeProjection = fs.readFileSync(experimentsPath);
    const beforeArchive = fs.readFileSync(archivePath(0));

    expect(() => executeStateWrite(request(root, 0, experiment("baseline")))).toThrow(/immutable experiment archive/);
    expect(fs.readFileSync(experimentsPath)).toEqual(beforeProjection);
    expect(fs.readFileSync(archivePath(0))).toEqual(beforeArchive);
  });

  it("keeps reconstructed full detail recoverable after later projection compaction without duplicates", () => {
    const { root, experimentsPath, archivePath } = project({
      experiments: [{ number: 0, ...experiment("baseline") }],
    });
    executeStateWrite(request(root, 0, experiment("baseline")));
    for (let number = 1; number <= 10; number += 1) {
      executeStateWrite(request(root, number, experiment(`candidate ${number}`)));
    }

    const projection = loadYamlMapping(fs.readFileSync(experimentsPath, "utf8"));
    expect(projection.experiments).toHaveLength(10);
    expect(projection.archive).toEqual([expect.objectContaining({ number: 0 })]);
    expect(loadYamlMapping(fs.readFileSync(archivePath(0), "utf8")).record).toEqual({
      number: 0,
      ...experiment("baseline"),
    });
    expect(fs.readdirSync(path.dirname(archivePath(0))).sort()).toEqual(
      Array.from({ length: 11 }, (_, number) => `${number}.yaml`).sort(),
    );
  });

  it("does not fabricate a full archive from a legacy summary-only projection row", () => {
    const { root, experimentsPath, archivePath } = project({
      archive: [{ number: 0, summary: "baseline result" }],
    });
    const beforeProjection = fs.readFileSync(experimentsPath);

    expect(() => executeStateWrite(request(root, 0, experiment("baseline")))).toThrow();
    expect(fs.readFileSync(experimentsPath)).toEqual(beforeProjection);
    expect(fs.existsSync(archivePath(0))).toBe(false);
  });

  it("rejects conflicting immutable archive content without changing projection", () => {
    const { root, experimentsPath, archivePath } = project({
      experiments: [{ number: 0, ...experiment("baseline") }],
    });
    fs.mkdirSync(path.dirname(archivePath(1)), { recursive: true });
    fs.writeFileSync(archivePath(1), "conflicting: bytes\n");
    const beforeProjection = fs.readFileSync(experimentsPath);
    const beforeArchive = fs.readFileSync(archivePath(1));

    expect(() => executeStateWrite(request(root, 1, experiment("candidate")))).toThrow(/immutable experiment archive/);
    expect(fs.readFileSync(experimentsPath)).toEqual(beforeProjection);
    expect(fs.readFileSync(archivePath(1))).toEqual(beforeArchive);
  });
});

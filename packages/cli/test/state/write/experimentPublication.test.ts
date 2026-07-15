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
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-experiment-publication-"));
  roots.push(root);
  const directory = path.join(root, ".agentera", "optimize", "latency");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "objective.yaml"), dumpYamlMapping({
    header: { id: objectiveId, title: "Latency", status: "open" },
    objective: { description: "Reduce latency", measurement: "p95", constraints: [] },
    metric: { direction: "minimize", unit: "ms" },
    baseline: { description: "100 ms" },
    gates: {},
    scope: { included: ["CLI"], excluded: [] },
  }));
  const experimentsPath = path.join(directory, "experiments.yaml");
  if (existing) fs.writeFileSync(experimentsPath, dumpYamlMapping(existing));
  return { root, experimentsPath };
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
    const { root, experimentsPath } = project();
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
  });

  it("preserves the 10/40/50 projection while publishing", () => {
    const existing = Array.from({ length: 10 }, (_, number) => ({ number, ...experiment(`experiment ${number}`) }));
    const { root, experimentsPath } = project({ experiments: existing });

    const result = run(root, [
      "publish", "--objective", objectiveId, "--number", "10", "--input", "-", "--format", "json",
    ], experiment("experiment 10"));

    expect(result).toMatchObject({ rc: 0, err: "" });
    const document = loadYamlMapping(fs.readFileSync(experimentsPath, "utf8"));
    expect(document.experiments).toHaveLength(10);
    expect(document.archive).toEqual([
      expect.objectContaining({ number: 0, summary: expect.any(String) }),
    ]);
  });

  it("preserves active and archive bytes on identity, schema, collision, and staged publication failures", () => {
    const initial = { experiments: [{ number: 0, ...experiment("baseline") }], archive: [{ number: 9, summary: "older" }] };
    const { root, experimentsPath } = project(initial);
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
  });

  it("retries idempotently after interruption following atomic publication", () => {
    const { root, experimentsPath } = project();
    const publication = request(root, 0, experiment("baseline"));

    expect(() => executeStateWrite(publication, { failAfter: "projection-publication" })).toThrowError(
      expect.objectContaining<Partial<InjectedMutationFailure>>({ boundary: "projection-publication" }),
    );
    expect((loadYamlMapping(fs.readFileSync(experimentsPath, "utf8")).experiments as unknown[])).toHaveLength(1);

    const retry = executeStateWrite(publication);
    expect(retry.operation).toMatchObject({ idempotent_replay: true });
    expect((loadYamlMapping(fs.readFileSync(experimentsPath, "utf8")).experiments as unknown[])).toHaveLength(1);
  });
});

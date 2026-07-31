import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../../src/cli/dispatch.js";
import { dumpYamlMapping } from "../../../src/core/yaml.js";
import { loadMutationGrammar } from "../../../src/state/write/grammar.js";
import { mutationParityMatrix, stateWriterContract } from "../../../src/state/write/operations.js";
import { runtimeOperationSpecs } from "../../../src/state/write/runtimeOperations.js";

const roots: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-mutation-grammar-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

function runCli(root: string, args: string[], stdin = "", selectProject = true): { rc: number; out: string; err: string; json: any } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args, ...(selectProject ? ["--project", root] : [])], {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
    stdin: () => stdin,
  });
  return { rc, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
}

function run(root: string, args: string[], stdin = ""): { rc: number; out: string; err: string; json: any } {
  return runCli(root, ["state", ...args], stdin);
}

function requiredness(fields: Array<{ flag: string; required?: boolean }>): Record<string, boolean> {
  return Object.fromEntries(fields.map((field) => [field.flag, field.required === true]));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("declarative state mutation grammar", () => {
  it("has one digest-bound operation and parity row for every public verb", () => {
    const grammar = loadMutationGrammar();
    const contract = stateWriterContract();
    const matrix = mutationParityMatrix() as any;
    const keys = grammar.operations.map((operation) => `${operation.artifact}.${operation.verb}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(matrix.contract_digest).toBe(contract.contract_digest);
    expect(matrix.rows).toHaveLength(grammar.operations.length);
    expect(new Set(matrix.rows.map((row: any) => `${row.artifact}.${row.verb}`)).size).toBe(keys.length);
    for (const kind of grammar.operationClasses) {
      const rows = matrix.rows.filter((row: any) => row.class === kind);
      expect(rows.length, kind).toBeGreaterThan(0);
      expect(rows.every((row: any) => row.success.expected === "pass" && row.rejection.before_effects)).toBe(true);
    }
  });

  it("keeps requiredness identical across all 25 runtime, authority, schema, and explain operations", () => {
    const root = project();
    const runtime = runtimeOperationSpecs();
    const grammar = loadMutationGrammar();
    const schema = runCli(root, ["schema", "--format", "json"], "", false);
    expect(schema.rc, schema.err).toBe(0);
    expect(runtime).toHaveLength(25);
    expect(grammar.operations).toHaveLength(25);

    const schemaOperations = new Map<string, any>();
    for (const artifact of schema.json.state_writer.artifacts) {
      for (const operation of artifact.operations) {
        schemaOperations.set(`${artifact.artifact}.${operation.verb}`, operation);
      }
    }
    expect(schemaOperations.size).toBe(25);

    const explainAllOperations = new Map<string, any>();
    for (const artifact of [...new Set(runtime.map((operation) => operation.artifact))]) {
      const all = run(root, [artifact, "explain", "--all", "--format", "json"]);
      expect(all.rc, all.err).toBe(0);
      for (const operation of all.json.operations) {
        explainAllOperations.set(`${artifact}.${operation.requested_verb}`, operation);
      }
    }
    expect(explainAllOperations.size).toBe(25);

    for (const operation of runtime) {
      const key = `${operation.artifact}.${operation.verb}`;
      const authority = grammar.operations.find((candidate) => `${candidate.artifact}.${candidate.verb}` === key);
      const schemaOperation = schemaOperations.get(key);
      const explainAll = explainAllOperations.get(key);
      const explain = run(root, [operation.artifact, "explain", "--verb", operation.verb, "--format", "json"]);
      expect(explain.rc, `${key}: ${explain.err}`).toBe(0);

      const expected = requiredness(operation.fields);
      expect(requiredness(authority?.fields ?? []), `${key}: authority`).toEqual(expected);
      expect(requiredness(schemaOperation?.fields ?? []), `${key}: schema`).toEqual(expected);
      expect(requiredness(explainAll?.fields ?? []), `${key}: explain --all`).toEqual(expected);
      expect(requiredness(explain.json.fields), `${key}: per-verb explain`).toEqual(expected);
      for (const selector of operation.selectors) {
        expect(expected, `${key}: selector ${selector}`).toHaveProperty(selector);
      }
    }
  });

  it("keeps complete structured descriptors identical across schema, explain, and explain --all", () => {
    const root = project();
    const schema = runCli(root, ["schema", "--format", "json"], "", false);
    expect(schema.rc, schema.err).toBe(0);
    const schemaOperations = new Map<string, any>();
    for (const artifact of schema.json.state_writer.artifacts)
      for (const operation of artifact.operations) schemaOperations.set(`${artifact.artifact}.${operation.verb}`, operation);

    for (const [artifact, verb] of [["progress", "append"], ["decisions", "append"], ["decisions", "amend"]]) {
      const key = `${artifact}.${verb}`;
      const explain = run(root, [artifact, "explain", "--verb", verb, "--format", "json"]);
      const all = run(root, [artifact, "explain", "--all", "--format", "json"]);
      expect(explain.rc, explain.err).toBe(0);
      expect(all.rc, all.err).toBe(0);
      const operation = schemaOperations.get(key);
      const allOperation = all.json.operations.find((entry: any) => entry.requested_verb === verb);
      const input = explain.json.input_schema;
      expect(operation.input.schema.fields).toEqual(input.structured_fields);
      expect(operation.input.schema.semantics).toEqual(input.semantics);
      expect(operation.input.schema.owned_fields).toEqual(input.owned_fields);
      expect(operation.input.schema.immutable_fields).toEqual(input.immutable_fields);
      expect(operation.input.schema.bounds).toEqual(input.bounds);
      expect(operation.input.schema.examples).toEqual(input.examples);
      expect(allOperation.input_schema.structured_fields).toEqual(input.structured_fields);
      expect(input.structured_fields.every((entry: any) => typeof entry.path === "string" && typeof entry.type === "string" && typeof entry.required === "boolean" && typeof entry.update === "string")).toBe(true);
    }
  });

  it("preserves optional selector inference and rejects mandatory decision omissions before effects", () => {
    const root = project();
    const planInput = dumpYamlMapping({
      header: { level: "light", created: "2026-07-31", status: "open", title: "Selector inference" },
      what: "Verify optional selector inference in packages/cli/src/state/planEntities.ts.",
      why: "Discovery requiredness must preserve executable defaults.",
      scope: { included: ["selector inference"], excluded: ["downstream conversions"] },
      tasks: [{ number: 1, name: "Existing task", status: "pending", depends_on: [] }],
    });
    const createdPlan = run(root, ["plan", "create", "--input", "-", "--format", "json"], planInput);
    expect(createdPlan.rc, createdPlan.err).toBe(0);
    const appended = run(root, ["plan", "append", "--name", "Inferred plan", "--format", "json"]);
    expect(appended.rc, appended.err).toBe(0);
    expect(appended.json.record.plan).toBe(createdPlan.json.id);

    const objectiveInput = dumpYamlMapping({
      header: { title: "Selector objective", status: "open", created: "2026-07-31" },
      objective: { description: "Verify selector defaults", why: "Discovery must be truthful", measurement: "Focused regression", constraints: [] },
      metric: { description: "parity", direction: "maximize", unit: "operations" },
      baseline: { description: "22 operations" },
      gates: {},
      scope: { included: ["mutation grammar"], excluded: ["downstream conversions"] },
    });
    const objective = run(root, ["objective", "create", "--input", "-", "--format", "json"], objectiveInput);
    expect(objective.rc, objective.err).toBe(0);
    const experimentInput = dumpYamlMapping({
      date: "2026-07-31 00:30",
      label: "selector-baseline",
      hypothesis: "Optional identity is assigned",
      method: "Run the typed writer",
      change: "Omit --id",
      metric: { primary_value: "22", delta_vs_baseline: "0" },
      regression: "Focused selector tests pass",
      status: "baseline",
      conclusion: "The CLI assigned identity",
      provenance: { command: "mutationGrammar.test.ts", revision: "working-tree" },
    });
    const experiment = run(root, ["experiments", "publish", "--objective", objective.json.id, "--input", "-", "--format", "json"], experimentInput);
    expect(experiment.rc, experiment.err).toBe(0);
    expect(experiment.json.id).toMatch(/^[a-z]{10}$/);

    const rejectRoot = project();
    const update = run(rejectRoot, ["decisions", "update", "--satisfaction-state", "open", "--format", "json"]);
    expect(update.rc).toBe(2);
    expect(update.json.error).toEqual({
      class: "missing_argument",
      message: "--id is required for decisions update",
      syntax: "--id VALUE",
      example: "agentera state decisions update --id qjtrmnpvka --satisfaction-state provisionally_satisfied --satisfaction-evidence \"...\" --format json",
      recovery: "Correct the input and retry; no state was changed.",
    });
    const amendId = run(rejectRoot, ["decisions", "amend", "--base-sha256", "abc", "--input", "-", "--format", "json"]);
    expect(amendId.rc).toBe(2);
    expect(amendId.json.error).toMatchObject({
      class: "missing_argument",
      message: "--id is required for decisions amend",
      syntax: "--id VALUE",
      recovery: "Correct the input and retry; no state was changed.",
    });
    const amendBase = run(rejectRoot, ["decisions", "amend", "--id", "qjtrmnpvka", "--input", "-", "--format", "json"]);
    expect(amendBase.rc).toBe(2);
    expect(amendBase.json.error).toMatchObject({
      class: "missing_argument",
      message: "--base-sha256 is required for decisions amend",
      syntax: "--base-sha256 VALUE",
      recovery: "Correct the input and retry; no state was changed.",
    });
    expect(fs.readdirSync(path.join(rejectRoot, ".agentera"))).toEqual(["state-mode.yaml"]);
  });

  it("makes --all and per-verb discovery agree without advertising health repair", () => {
    const root = project();
    const all = run(root, ["progress", "explain", "--all", "--format", "json"]);
    expect(all.rc, all.err).toBe(0);
    expect(all.json.operations).toHaveLength(1);
    expect(all.json.operations[0]).toMatchObject({
      requested_verb: "append",
      mutation_class: "record_payload",
      selectors: [],
      recovery: expect.any(String),
      bounds: expect.any(Object),
    });
    const one = run(root, ["progress", "explain", "--verb", "append", "--format", "json"]);
    expect(one.rc, one.err).toBe(0);
    expect(one.json.contract_digest).toBe(all.json.contract_digest);
    expect(one.json.mutation_class).toBe(all.json.operations[0].mutation_class);

    const health = run(root, ["health", "explain", "--all", "--format", "json"]);
    expect(health.rc, health.err).toBe(0);
    expect(health.json.verbs).toEqual(["append"]);
    const repair = run(root, ["health", "repair", "--number", "1", "--force", "--format", "json"]);
    expect(repair.rc).not.toBe(0);
    expect(repair.json.error.class).toBe("invalid_choice");
    expect(fs.readdirSync(path.join(root, ".agentera"))).toEqual(["state-mode.yaml"]);
  });

  it("proves one pass and one fail-before-effects for each mutation class", () => {
    const root = project();
    const recordPass = run(root, ["progress", "append", "--input", "-", "--dry-run", "--format", "json"], "type: test\nphase: build\nwhat: grammar\ncontext:\n  intent: record\n");
    expect(recordPass.rc, recordPass.err).toBe(0);
    const recordReject = run(root, ["progress", "append", "--input", "-", "--format", "json"], "{}");
    expect(recordReject.rc).not.toBe(0);
    expect(recordReject.json.error.class).toBe("schema_violation");

    const decision = run(root, ["decisions", "append", "--input", "-", "--format", "json"], "question: q\ncontext: c\nalternatives:\n  chosen: a\nchoice: a\nreasoning: r\nconfidence: firm\n");
    expect(decision.rc, decision.err).toBe(0);
    const transitionPass = run(root, ["decisions", "update", "--id", decision.json.id, "--satisfaction-state", "open", "--format", "json"]);
    expect(transitionPass.rc, transitionPass.err).toBe(0);
    const transitionReject = run(root, ["decisions", "update", "--id", decision.json.id, "--satisfaction-state", "open", "--input", "-", "--format", "json"]);
    expect(transitionReject.rc).not.toBe(0);
    expect(transitionReject.json.error.class).toBe("mutually_exclusive");

    const input = path.join(root, "plan.yaml");
    fs.writeFileSync(input, dumpYamlMapping({
      header: { level: "light", created: "2026-07-30", status: "open", title: "Grammar" },
      what: "Prove packages/cli/src/state/write/grammar.ts batch publication.",
      why: "Parity needs one batch success at packages/cli/src/state/write/grammar.ts.",
      scope: { included: ["grammar"], excluded: ["legacy aggregate"] },
      tasks: [{ number: 1, name: "Batch", status: "pending", depends_on: [] }],
    }));
    const batchPass = run(root, ["plan", "create", "--input", input, "--dry-run", "--format", "json"]);
    expect(batchPass.rc, JSON.stringify(batchPass)).toBe(0);
    const beforeBatchReject = fs.readdirSync(path.join(root, ".agentera", "entities"));
    const batchReject = run(root, ["plan", "create", "--input", "-", "--format", "json"], "tasks: [");
    expect(batchReject.rc).not.toBe(0);
    expect(batchReject.json.error.class).toBe("invalid_format");
    expect(fs.readdirSync(path.join(root, ".agentera", "entities"))).toEqual(beforeBatchReject);
  });

  it("rejects a UTF-8 oversized structured payload before publication", () => {
    const root = project();
    const input = path.join(root, "oversized-plan.yaml");
    fs.writeFileSync(input, `value: ${JSON.stringify("é".repeat(17000))}\n`);

    const result = run(root, ["plan", "create", "--input", input, "--format", "json"]);

    expect(result.rc).not.toBe(0);
    expect(result.json.error.class).toBe("schema_violation");
    expect(result.json.error.message).toContain("32768-byte UTF-8 limit");
    expect(fs.readdirSync(path.join(root, ".agentera"))).toEqual(["state-mode.yaml"]);
  });

  it("fails closed when declarative discovery diverges from runtime grammar", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-mutation-authority-"));
    roots.push(sourceRoot);
    const authorityDir = path.join(sourceRoot, "references", "artifacts");
    fs.mkdirSync(authorityDir, { recursive: true });
    const authority = path.join(repoRoot, "references", "artifacts", "state-storage-authority.yaml");
    const altered = fs.readFileSync(authority, "utf8").replace("      verb: append\n", "      verb: retired\n");
    fs.writeFileSync(path.join(authorityDir, "state-storage-authority.yaml"), altered);

    expect(() => loadMutationGrammar(sourceRoot)).toThrow(/mutation grammar parity failure/);
    loadMutationGrammar();
  });
});

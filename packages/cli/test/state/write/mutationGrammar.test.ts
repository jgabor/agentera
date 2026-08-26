import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../../src/cli/dispatch.js";
import { dumpYamlMapping, loadYamlMapping } from "../../../src/core/yaml.js";
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

  it("keeps source and bundled plan schema identity boundaries explicit", () => {
    const schemaPaths = [path.join(repoRoot, "skills/agentera/schemas/artifacts/plan.yaml")];
    const bundled = path.join(repoRoot, "packages/cli/bundle/skills/agentera/schemas/artifacts/plan.yaml");
    if (fs.existsSync(bundled)) schemaPaths.push(bundled);
    for (const schemaPath of schemaPaths) {
      expect(fs.existsSync(schemaPath), schemaPath).toBe(true);
      const schema = fs.readFileSync(schemaPath, "utf8");
      expect(schema).toContain("CANONICAL_ENTITY_CONTRACT");
      expect(schema).toContain("format: bare_ten_letter_id");
      expect(schema.toLowerCase()).toContain("create-local symbolic task ordinal");
      expect(schema).toContain("migration_only_noncanonical");
      expect(schema).toContain("public_selector: forbidden");
      expect(schema).not.toContain("Stable plan identity assigned by the typed writer at first publication");
      expect(schema).not.toContain("Must match plan:<lowercase RFC 9562 UUID> when present");
      const dependencyField = (loadYamlMapping(schema).TASK as any)?.[3];
      expect(dependencyField.type).toBe("list[integer|string]");
      expect(dependencyField.accepted_forms).toEqual({
        atomic_plan_create: ["positive_integer", "canonical_numeric_string"],
        legacy_migration_only: ["legacy_task_reference_string"],
      });
      expect((loadYamlMapping(schema).CANONICAL_ENTITY_CONTRACT as any)?.create_local_symbols).toMatchObject({
        dependency_accepted_forms: ["positive_integer", "canonical_numeric_string"],
        dependency_normalization: "canonical_numeric_string_before_resolution",
      });
      const dependencyDescription = String(dependencyField.description ?? "").toLowerCase();
      expect(dependencyDescription).toContain("numeric or numeric-string");
      expect(dependencyDescription).toContain("create-local symbolic task ordinals");
      expect(dependencyDescription).toContain("current complete plan create input");
      expect(dependencyDescription).toContain("within that atomic document");
      expect(dependencyDescription).toContain("bare ten-letter task envelope ids");
      expect(dependencyDescription).not.toContain("legacy migration input");
    }
  });

  it("projects schema-owned plan-create dependency forms through public schema and explain output", () => {
    const root = project();
    const expected = {
      id: "PT17",
      group: "TASK",
      field: "depends_on",
      path: "tasks[].depends_on",
      type: "list[integer|string]",
      required: false,
      format: null,
      validation: [
        "positive_integer_or_canonical_numeric_string",
        "unique_after_normalization_within_task",
        "resolves_to_declared_task_ordinal_in_same_atomic_document",
      ],
      accepted_forms: {
        atomic_plan_create: ["positive_integer", "canonical_numeric_string"],
        legacy_migration_only: ["legacy_task_reference_string"],
      },
      normalization: "canonical_numeric_string_before_same_document_resolution",
      write_operations: ["create"],
    };
    const schemaJson = runCli(root, ["schema", "--format", "json"], "", false);
    const schemaYaml = runCli(root, ["schema", "--format", "yaml"], "", false);
    expect(schemaJson.rc, schemaJson.err).toBe(0);
    expect(schemaYaml.rc, schemaYaml.err).toBe(0);
    for (const payload of [schemaJson.json, loadYamlMapping(schemaYaml.out)]) {
      const plan = payload.artifact_schemas.find((artifact: any) => artifact.name === "plan");
      expect(plan.fields.find((field: any) => field.id === "PT17")).toEqual(expected);
    }
    const explainJson = run(root, ["plan", "explain", "--verb", "create", "--format", "json"]);
    const explainAll = run(root, ["plan", "explain", "--all", "--format", "json"]);
    expect(explainJson.rc, explainJson.err).toBe(0);
    expect(explainAll.rc, explainAll.err).toBe(0);
    expect(explainJson.json.input_schema.artifact_schema_fields).toEqual([expected]);
    expect(explainAll.json.operations.find((operation: any) => operation.requested_verb === "create").input_schema.artifact_schema_fields).toEqual([expected]);
    expect(Buffer.byteLength(explainJson.out, "utf8")).toBeLessThan(32_768);
  });

  it("keeps requiredness identical across all 29 runtime, authority, schema, and explain operations", () => {
    const root = project();
    const runtime = runtimeOperationSpecs();
    const grammar = loadMutationGrammar();
    const schema = runCli(root, ["schema", "--format", "json"], "", false);
    expect(schema.rc, schema.err).toBe(0);
    expect(runtime).toHaveLength(29);
    expect(grammar.operations).toHaveLength(29);

    const schemaOperations = new Map<string, any>();
    for (const artifact of schema.json.state_writer.artifacts) {
      for (const operation of artifact.operations) {
        schemaOperations.set(`${artifact.artifact}.${operation.verb}`, operation);
      }
    }
    expect(schemaOperations.size).toBe(29);

    const explainAllOperations = new Map<string, any>();
    for (const artifact of [...new Set(runtime.map((operation) => operation.artifact))]) {
      const all = run(root, [artifact, "explain", "--all", "--format", "json"]);
      expect(all.rc, all.err).toBe(0);
      for (const operation of all.json.operations) {
        explainAllOperations.set(`${artifact}.${operation.requested_verb}`, operation);
      }
    }
    expect(explainAllOperations.size).toBe(29);

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

    const schemaParityRows = new Map(schema.json.state_writer.parity_matrix.rows.map((row: any) => [`${row.artifact}.${row.verb}`, row]));

    for (const [artifact, verb] of [["progress", "append"], ["decisions", "append"], ["decisions", "amend"], ["plan", "append"], ["plan", "update"]]) {
      const key = `${artifact}.${verb}`;
      const explain = run(root, [artifact, "explain", "--verb", verb, "--format", "json"]);
      const all = run(root, [artifact, "explain", "--all", "--format", "json"]);
      expect(explain.rc, explain.err).toBe(0);
      expect(all.rc, all.err).toBe(0);
      const operation = schemaOperations.get(key);
      const allOperation = all.json.operations.find((entry: any) => entry.requested_verb === verb);
      const input = explain.json.input_schema;
      expect(operation.input.schema).toEqual({
        root: input.root,
        fields: input.structured_fields,
        semantics: input.semantics,
        owned_fields: input.owned_fields,
        immutable_fields: input.immutable_fields,
        bounds: input.bounds,
        examples: input.examples,
      });
      expect(allOperation).toEqual(explain.json);
      expect(operation).toMatchObject({
        verb,
        class: explain.json.mutation_class,
        selectors: explain.json.selectors,
        preconditions: explain.json.preconditions,
        owned_fields: explain.json.owned_fields,
        recovery: explain.json.recovery,
        examples: explain.json.examples,
        bounds: explain.json.bounds,
      });
      const explainParityRow = all.json.parity_matrix.rows.find((row: any) => `${row.artifact}.${row.verb}` === key);
      expect(explainParityRow).toEqual(schemaParityRows.get(key));
      expect(explainParityRow.rejection).toMatchObject({ expected: "fail", before_effects: true });
      expect(input.structured_fields.every((entry: any) => typeof entry.path === "string" && typeof entry.type === "string" && typeof entry.required === "boolean" && typeof entry.update === "string")).toBe(true);
    }
  });

  it("projects optional plan replacement input consistently into schema and explain", () => {
    const root = project();
    const schema = runCli(root, ["schema", "--format", "json"], "", false);
    const explain = run(root, ["plan", "explain", "--verb", "replace", "--format", "json"]);
    const all = run(root, ["plan", "explain", "--all", "--format", "json"]);
    expect(schema.rc, schema.err).toBe(0);
    expect(explain.rc, explain.err).toBe(0);
    expect(all.rc, all.err).toBe(0);
    const plan = schema.json.state_writer.artifacts.find((artifact: any) => artifact.artifact === "plan");
    const operation = plan.operations.find((candidate: any) => candidate.verb === "replace");
    const allOperation = all.json.operations.find((candidate: any) => candidate.requested_verb === "replace");
    expect(operation.input).toMatchObject({ mode: "structured", optional: true, root: "complete plan document when creating a successor" });
    expect(explain.json.input).toMatchObject({ mode: "structured", optional: true, root: "complete plan document when creating a successor" });
    expect(allOperation.input).toEqual(explain.json.input);
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
    const appended = run(root, ["plan", "append", "--input", "-", "--format", "json"], "name: Inferred plan\ndepends_on: []\nacceptance: [\"GIVEN input WHEN selected THEN the inferred plan is used\"]\n");
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
    expect(repair.json.error).toMatchObject({ class: "invalid_request", syntax: expect.stringContaining("state health list") });
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

    expect(() => loadMutationGrammar(sourceRoot)).toThrow(/not code-owned|mutation grammar parity failure/);
    loadMutationGrammar();
  });

  it.each([
    ["unknown command", "npx -y agentera@next destroy --yes"],
    ["composed command", "npx -y agentera@next state progress append --input progress.yaml --format json && printf x"],
    ["numeric redirect", "npx -y agentera@next state progress append --input progress.yaml --format json 2>err"],
    ["substitution", "npx -y agentera@next state progress append --input $(printf x) --format json"],
    ["wrong channel", "npx -y agentera@latest state progress append --input progress.yaml --format json"],
    ["malformed quote", 'npx -y agentera@next state progress append --input "progress.yaml --format json'],
    ["extra sibling", "npx -y agentera@next state progress append --input progress.yaml --format json npx -y agentera@next prime"],
    ["force", "npx -y agentera@next state progress append --input progress.yaml --format json --force"],
    ["garbage", "npx -y agentera@next state progress append --input progress.yaml --format json garbage"],
    ["quoted operator", 'npx -y agentera@next state progress append --input progress.yaml --format json "&&"'],
    ["adjacent prefix", "xnpx -y agentera@next state progress append --input progress.yaml --format json"],
    ["adjacent suffix", "npx -y agentera@next state progress append --input progress.yaml --format jsonoops"],
    ["continuation", "npx -y agentera@next state progress append --input progress.yaml --format json " + "\\" + "\n--force"],
    ["invalid format", "npx -y agentera@next state progress append --input progress.yaml --format invalid"],
    ["wrong operation family", "npx -y agentera@next state decisions append --input progress.yaml --format json"],
    ["duplicate flag", "npx -y agentera@next state progress append --input progress.yaml --input other.yaml --format json"],
    ["omitted required value", "npx -y agentera@next state progress append --input --format json"],
    ["extra positional", "npx -y agentera@next state progress append extra --input progress.yaml --format json"],
    ["option-like value", "npx -y agentera@next state progress append --input -- --format json"],
  ])("rejects an inexact recovery or example before projection: %s", (_label, badCommand) => {
    for (const field of ["recovery", "examples"] as const) {
      const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-mutation-guidance-"));
      roots.push(sourceRoot);
      const authorityDir = path.join(sourceRoot, "references", "artifacts");
      fs.mkdirSync(authorityDir, { recursive: true });
      const source = loadYamlMapping(fs.readFileSync(
        path.join(repoRoot, "references", "artifacts", "state-storage-authority.yaml"),
        "utf8",
      )) as any;
      const operation = source.mutation_grammar.operations.find(
        (candidate: any) => candidate.artifact === "progress" && candidate.verb === "append",
      );
      operation[field] = field === "examples" ? [badCommand] : badCommand;
      fs.writeFileSync(
        path.join(authorityDir, "state-storage-authority.yaml"),
        dumpYamlMapping(source),
      );
      expect(() => loadMutationGrammar(sourceRoot), `${field}: ${badCommand}`)
        .toThrow(/invalid development command projection/);
    }
    loadMutationGrammar();
  });

  it("binds recovery and example parity to every code-owned mutation operation", () => {
    const authorityPath = path.join(repoRoot, "references", "artifacts", "state-storage-authority.yaml");
    const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8")) as any;
    expect(authority.mutation_grammar.operations).toHaveLength(29);
    expect(runtimeOperationSpecs()).toHaveLength(29);
    for (const operation of authority.mutation_grammar.operations) {
      for (const field of ["recovery", "examples"] as const) {
        const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-mutation-owner-"));
        roots.push(sourceRoot);
        const authorityDir = path.join(sourceRoot, "references", "artifacts");
        fs.mkdirSync(authorityDir, { recursive: true });
        const changed = structuredClone(authority);
        const target = changed.mutation_grammar.operations.find(
          (candidate: any) => candidate.artifact === operation.artifact && candidate.verb === operation.verb,
        );
        if (field === "recovery") target.recovery = `${target.recovery} oops`;
        else target.examples[0] = `${target.examples[0]} oops`;
        fs.writeFileSync(path.join(authorityDir, "state-storage-authority.yaml"), dumpYamlMapping(changed));
        expect(() => loadMutationGrammar(sourceRoot), `${operation.artifact}.${operation.verb}.${field}`)
          .toThrow(/invalid development command projection/);
      }
    }
    const grammar = loadMutationGrammar();
    for (const operation of grammar.operations) {
      const runtime = runtimeOperationSpecs().find(
        (candidate) => candidate.artifact === operation.artifact && candidate.verb === operation.verb,
      )!;
      expect(operation.recovery).toBe(runtime.projection.recovery.runtime);
      expect(operation.examples).toEqual(runtime.projection.examples.map(({ runtime: value }) => value));
    }
  });

  it("rejects invalid enum and format examples before schema or help can consume them", () => {
    const authority = loadYamlMapping(fs.readFileSync(
      path.join(repoRoot, "references", "artifacts", "state-storage-authority.yaml"),
      "utf8",
    )) as any;
    for (const [artifact, verb, mutate] of [
      ["plan", "set-status", (value: string) => value.replace("--status complete", "--status retired")],
      ["progress", "append", (value: string) => value.replace("--format json", "--format invalid")],
    ] as const) {
      const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-mutation-domain-"));
      roots.push(sourceRoot);
      const authorityDir = path.join(sourceRoot, "references", "artifacts");
      fs.mkdirSync(authorityDir, { recursive: true });
      const changed = structuredClone(authority);
      const operation = changed.mutation_grammar.operations.find(
        (candidate: any) => candidate.artifact === artifact && candidate.verb === verb,
      );
      operation.examples[0] = mutate(operation.examples[0]);
      fs.writeFileSync(path.join(authorityDir, "state-storage-authority.yaml"), dumpYamlMapping(changed));
      expect(() => loadMutationGrammar(sourceRoot)).toThrow(/invalid development command projection/);
    }
    loadMutationGrammar();
  });
});

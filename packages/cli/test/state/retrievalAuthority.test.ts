import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  loadStateRetrievalAuthority,
  STATE_RETRIEVAL_AUTHORITY_PATH,
  validateStateRetrievalAuthority,
} from "../../src/state/retrievalAuthority.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

type Authority = Record<string, any>;
type NegativeCase = {
  rule: string;
  expected: string;
  mutate: (value: Authority) => void;
};

function authority(): Authority {
  return YAML.parse(fs.readFileSync(path.join(REPO_ROOT, STATE_RETRIEVAL_AUTHORITY_PATH), "utf8"));
}

function removeListValue(value: Authority, path: string[], removed: string): void {
  let target: Authority = value;
  for (const segment of path.slice(0, -1)) target = target[segment];
  const field = path.at(-1)!;
  target[field] = target[field].filter((item: string) => item !== removed);
}

function patternCases(rule: string, selector: (value: Authority) => Authority): NegativeCase[] {
  return [
    {
      rule: `${rule}.pattern-present`,
      expected: `${rule}.pattern`,
      mutate: (value) => delete selector(value).pattern,
    },
    {
      rule: `${rule}.pattern-valid-regex`,
      expected: `${rule}.pattern_invalid`,
      mutate: (value) => { selector(value).pattern = "["; },
    },
    {
      rule: `${rule}.accepted-examples`,
      expected: `${rule}.accepted_examples`,
      mutate: (value) => { selector(value).pattern = "^never$"; },
    },
    {
      rule: `${rule}.rejected-examples`,
      expected: `${rule}.rejected_examples`,
      mutate: (value) => { selector(value).pattern = ".*"; },
    },
  ];
}

const envelopeFields = [
  "schemaVersion",
  "command",
  "status",
  "entries",
  "counts",
  "order",
  "filters",
  "snapshot",
  "source",
  "source_contract",
];
const cursorFields = ["vocabulary", "response_field", "binding", "invalid_behavior", "unavailable_behavior"];
const omissionFields = ["omitted", "omitted_count", "omission_reason", "retrieval"];
const planIdentityFields = ["canonical_format", "persistence", "transition", "legacy_format", "legacy_derivation", "collision"];
const objectiveIdentityFields = ["canonical_format", "persistence", "canonical_root", "legacy_root", "legacy_format", "legacy_derivation", "path_compatibility"];
const collectionFields = ["collection_id", "artifact_id", "growth", "identity", "storage_ownership", "ordering", "bounds", "cursor", "omission", "get"];
const collectionIds = ["progress.records", "decisions.records", "health.records", "plan.plans", "plan.tasks", "experiments.records", "todo.items", "docs.entries", "changelog.entries"];
const failureFields = ["class", "message", "syntax", "example", "recovery"];
const failureClasses = ["invalid_request", "unsupported_artifact", "not_found", "ambiguous", "corrupt", "incomplete", "cursor_invalid", "cursor_snapshot_unavailable", "unsupported_state"];

/**
 * One mutation per validation rule/branch in validateStateRetrievalAuthority.
 * The matrix is intentionally data-driven so adding an enforced rule requires
 * adding its explicit failing contract example here.
 */
const negativeCases: NegativeCase[] = [
  { rule: "retrieval schema version", expected: "retrieval.schema_version", mutate: (value) => { value.retrieval.schema_version = "wrong"; } },
  { rule: "authority boundary", expected: "retrieval.authority_boundary", mutate: (value) => { delete value.retrieval.authority_boundary; } },
  ...envelopeFields.map((field): NegativeCase => ({
    rule: `envelope requires ${field}`,
    expected: `retrieval.envelope.required_fields.${field}`,
    mutate: (value) => removeListValue(value, ["retrieval", "envelope", "required_fields"], field),
  })),
  ...cursorFields.map((field): NegativeCase => ({
    rule: `cursor requires ${field}`,
    expected: `retrieval.cursor.${field}`,
    mutate: (value) => { delete value.retrieval.cursor[field]; },
  })),
  ...omissionFields.map((field): NegativeCase => ({
    rule: `omission requires ${field}`,
    expected: `retrieval.omission.required_when_any_entry_is_not_returned.${field}`,
    mutate: (value) => removeListValue(value, ["retrieval", "omission", "required_when_any_entry_is_not_returned"], field),
  })),
  { rule: "omission semantics", expected: "retrieval.omission.semantics", mutate: (value) => { value.retrieval.omission.semantics = ""; } },
  ...["plan", "task", "objective", "experiment"].map((identity): NegativeCase => ({
    rule: `identity section ${identity}`,
    expected: `retrieval.identity.${identity}`,
    mutate: (value) => { delete value.retrieval.identity[identity]; },
  })),
  ...planIdentityFields.map((field): NegativeCase => ({
    rule: `plan identity requires ${field}`,
    expected: `retrieval.identity.plan.${field}`,
    mutate: (value) => { delete value.retrieval.identity.plan[field]; },
  })),
  { rule: "plan identity vectors", expected: "retrieval.identity.plan.test_vectors", mutate: (value) => { value.retrieval.identity.plan.test_vectors = []; } },
  { rule: "plan vector canonical JSON", expected: "retrieval.identity.plan.test_vectors[0].canonical_json", mutate: (value) => { value.retrieval.identity.plan.test_vectors[0].canonical_json = "{"; } },
  { rule: "plan vector stable ID", expected: "retrieval.identity.plan.test_vectors[0].stable_id", mutate: (value) => { value.retrieval.identity.plan.test_vectors[0].stable_id = "legacy-plan:wrong"; } },
  { rule: "plan vector mirrored result", expected: "retrieval.identity.plan.test_vectors[0].identical_result", mutate: (value) => { value.retrieval.identity.plan.test_vectors[0].identical_result = "ambiguous"; } },
  ...objectiveIdentityFields.map((field): NegativeCase => ({
    rule: `objective identity requires ${field}`,
    expected: `retrieval.identity.objective.${field}`,
    mutate: (value) => { delete value.retrieval.identity.objective[field]; },
  })),
  { rule: "objective identity vectors", expected: "retrieval.identity.objective.test_vectors", mutate: (value) => { value.retrieval.identity.objective.test_vectors = []; } },
  { rule: "objective vector canonical JSON", expected: "retrieval.identity.objective.test_vectors[0].canonical_json", mutate: (value) => { value.retrieval.identity.objective.test_vectors[0].canonical_json = "{"; } },
  { rule: "objective vector stable ID", expected: "retrieval.identity.objective.test_vectors[0].stable_id", mutate: (value) => { value.retrieval.identity.objective.test_vectors[0].stable_id = "legacy-objective:wrong"; } },
  { rule: "experiment identity format", expected: "retrieval.identity.experiment.format", mutate: (value) => { value.retrieval.identity.experiment.format = "positive-only"; } },
  { rule: "experiment zero", expected: "retrieval.identity.experiment.zero", mutate: (value) => { value.retrieval.identity.experiment.zero = "experiment 1 starts the sequence"; } },
  ...["scope", "collision", "compatibility", "publication_validation"].map((field): NegativeCase => ({
    rule: `experiment identity requires ${field}`,
    expected: `retrieval.identity.experiment.${field}`,
    mutate: (value) => { delete value.retrieval.identity.experiment[field]; },
  })),
  ...(["plan_tasks", "plans", "experiments"] as const).flatMap((command) => (["list", "get"] as const).map((verb): NegativeCase => ({
    rule: `${command} ${verb} grammar`,
    expected: `retrieval.commands.${command}.${verb}`,
    mutate: (value) => { value.retrieval.commands[command][verb] = "agentera invalid"; },
  }))),
  { rule: "plan-task list selector optional", expected: "retrieval.commands.plan_tasks.selectors.plan.required", mutate: (value) => { value.retrieval.commands.plan_tasks.selectors.plan.list_required = true; } },
  { rule: "plan-task get defaults to active plan", expected: "retrieval.commands.plan_tasks.selectors.plan.required", mutate: (value) => { value.retrieval.commands.plan_tasks.selectors.plan.get_required = true; } },
  { rule: "plan-task get default is declared", expected: "retrieval.commands.plan_tasks.selectors.plan.get_default", mutate: (value) => { delete value.retrieval.commands.plan_tasks.selectors.plan.get_default; } },
  ...patternCases("retrieval.commands.plan_tasks.selectors.plan", (value) => value.retrieval.commands.plan_tasks.selectors.plan),
  { rule: "plan-task get task selector required", expected: "retrieval.commands.plan_tasks.selectors.task.get_required", mutate: (value) => { value.retrieval.commands.plan_tasks.selectors.task.get_required = false; } },
  ...patternCases("retrieval.commands.plan_tasks.selectors.task", (value) => value.retrieval.commands.plan_tasks.selectors.task),
  { rule: "plan get selector required", expected: "retrieval.commands.plans.selectors.plan.get_required", mutate: (value) => { value.retrieval.commands.plans.selectors.plan.get_required = false; } },
  ...patternCases("retrieval.commands.plans.selectors.plan", (value) => value.retrieval.commands.plans.selectors.plan),
  { rule: "experiment list objective required", expected: "retrieval.commands.experiments.selectors.objective.required", mutate: (value) => { value.retrieval.commands.experiments.selectors.objective.list_required = false; } },
  { rule: "experiment get objective required", expected: "retrieval.commands.experiments.selectors.objective.required", mutate: (value) => { value.retrieval.commands.experiments.selectors.objective.get_required = false; } },
  ...patternCases("retrieval.commands.experiments.selectors.objective", (value) => value.retrieval.commands.experiments.selectors.objective),
  { rule: "experiment get number required", expected: "retrieval.commands.experiments.selectors.number.get_required", mutate: (value) => { value.retrieval.commands.experiments.selectors.number.get_required = false; } },
  ...patternCases("retrieval.commands.experiments.selectors.number", (value) => value.retrieval.commands.experiments.selectors.number),
  ...failureFields.map((field): NegativeCase => ({
    rule: `failure envelope requires ${field}`,
    expected: `retrieval.failures.required_fields.${field}`,
    mutate: (value) => removeListValue(value, ["retrieval", "failures", "required_fields"], field),
  })),
  ...failureClasses.map((failureClass): NegativeCase => ({
    rule: `failure class ${failureClass}`,
    expected: `retrieval.failures.classes.${failureClass}`,
    mutate: (value) => { delete value.retrieval.failures.classes[failureClass]; },
  })),
  ...collectionFields.map((field): NegativeCase => ({
    rule: `collection classification requires ${field}`,
    expected: `retrieval.collections[0].${field}`,
    mutate: (value) => { delete value.retrieval.collections[0][field]; },
  })),
  { rule: "collection IDs unique", expected: "retrieval.collections.duplicate_collection_id", mutate: (value) => { value.retrieval.collections.push(structuredClone(value.retrieval.collections[0])); } },
  ...collectionIds.map((collectionId): NegativeCase => ({
    rule: `collection classified ${collectionId}`,
    expected: `retrieval.collections.missing.${collectionId}`,
    mutate: (value) => { value.retrieval.collections = value.retrieval.collections.filter((item: Authority) => item.collection_id !== collectionId); },
  })),
  { rule: "plan gap closure evidence", expected: "retrieval.gap_closure_evidence.plan", mutate: (value) => { value.retrieval.gap_closure_evidence = value.retrieval.gap_closure_evidence.filter((item: Authority) => !item.surface.includes("plan")); } },
  { rule: "experiment gap closure evidence", expected: "retrieval.gap_closure_evidence.experiments", mutate: (value) => { value.retrieval.gap_closure_evidence = value.retrieval.gap_closure_evidence.filter((item: Authority) => !item.surface.includes("experiments")); } },
  { rule: "gap closure declared gap", expected: "retrieval.gap_closure_evidence[0].declared_gap", mutate: (value) => { delete value.retrieval.gap_closure_evidence[0].declared_gap; } },
  { rule: "gap closure evidence", expected: "retrieval.gap_closure_evidence[0].closure", mutate: (value) => { delete value.retrieval.gap_closure_evidence[0].closure; } },
  { rule: "gap closure outcome", expected: "retrieval.gap_closure_evidence[0].outcome", mutate: (value) => { value.retrieval.gap_closure_evidence[0].outcome = "pending"; } },
  { rule: "archive diagnostic classification", expected: "retrieval.plan_archive_diagnostics.classification", mutate: (value) => { value.retrieval.plan_archive_diagnostics.classification = "fail_all_reads"; } },
  { rule: "archive diagnostic smoke behavior", expected: "retrieval.plan_archive_diagnostics.smoke_test_behavior", mutate: (value) => { delete value.retrieval.plan_archive_diagnostics.smoke_test_behavior; } },
];

describe("state retrieval authority", () => {
  it("accepts the canonical authority and exposes it through the executable loader", () => {
    expect(validateStateRetrievalAuthority(authority())).toEqual([]);
    const loaded = loadStateRetrievalAuthority(REPO_ROOT);
    expect(loaded.authority).toBe(STATE_RETRIEVAL_AUTHORITY_PATH);
    expect(loaded.retrieval.schema_version).toBe("agentera.stateRetrievalAuthority.v1");
  });

  it("has one uniquely named negative fixture for every enforced rule", () => {
    expect(negativeCases).toHaveLength(127);
    expect(new Set(negativeCases.map(({ rule }) => rule)).size).toBe(negativeCases.length);
  });

  it.each(negativeCases)("rejects invalid contract: $rule", ({ expected, mutate }) => {
    const value = structuredClone(authority());
    mutate(value);
    expect(validateStateRetrievalAuthority(value)).toContain(expected);
  });

  it("keeps deterministic positive identity vectors and experiment zero", () => {
    const retrieval = authority().retrieval;
    const plan = retrieval.identity.plan.test_vectors[0];
    const objective = retrieval.identity.objective.test_vectors[0];
    expect(`legacy-plan:${createHash("sha256").update(plan.canonical_json).digest("hex")}`).toBe(plan.stable_id);
    expect(`legacy-objective:${createHash("sha256").update(objective.canonical_json).digest("hex")}`).toBe(objective.stable_id);
    const experimentNumber = new RegExp(retrieval.commands.experiments.selectors.number.pattern);
    expect(["0", "1", "42"].every((value) => experimentNumber.test(value))).toBe(true);
    expect(["-1", "01", "1.0"].every((value) => !experimentNumber.test(value))).toBe(true);
  });

  it("accounts for every declared Task 1 plan and experiment gap", () => {
    const gaps = authority().retrieval.gap_closure_evidence;
    expect(gaps.map((gap: Authority) => [gap.surface, gap.outcome])).toEqual([
      ["agentera state plan --format json / plans", "closed"],
      ["agentera state plan --format json / source.archive_paths", "closed"],
      ["agentera state plan text / tasks", "closed"],
      ["agentera state plan --format json / tasks", "closed"],
      ["legacy agentera state experiments projection", "out_of_scope"],
    ]);
    expect(gaps.every((gap: Authority) => typeof gap.declared_gap === "string" && typeof gap.closure === "string")).toBe(true);
  });
});

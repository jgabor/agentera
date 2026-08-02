import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { entityListAuthorityProjection } from "./entityRetrievalHelp.js";

export const STATE_RETRIEVAL_AUTHORITY_PATH = "references/artifacts/state-storage-authority.yaml";
export const STATE_RETRIEVAL_SCHEMA_VERSION = "agentera.stateRetrievalAuthority.v1";

const COLLECTION_FIELDS = [
  "collection_id",
  "artifact_id",
  "growth",
  "identity",
  "storage_ownership",
  "ordering",
  "bounds",
  "cursor",
  "omission",
  "get",
] as const;

const EXPECTED_COLLECTIONS = [
  "progress.records",
  "decisions.records",
  "health.records",
  "plan.plans",
  "plan.tasks",
  "experiments.records",
  "todo.items",
  "docs.entries",
  "changelog.entries",
] as const;

const EXPECTED_FAILURES = [
  "invalid_request",
  "unsupported_artifact",
  "not_found",
  "ambiguous",
  "corrupt",
  "incomplete",
  "cursor_invalid",
  "cursor_snapshot_unavailable",
  "unsupported_state",
] as const;

const EXPECTED_COMMANDS = {
  plan_tasks: {
    list: "agentera state plan tasks list [PLAN_ID] [--limit N] [--cursor TOKEN] [--ids-only | --fields FIELDS] --format json",
    get: "agentera state plan tasks get --id ID --format json",
  },
  plans: {
    list: "agentera state plan list [--limit N] [--cursor TOKEN] [--ids-only | --fields FIELDS] --format json",
    get: "agentera state plan get --id ID --format json",
  },
  experiments: {
    list: "agentera state experiments list --objective OBJECTIVE_ID [--limit N] [--cursor TOKEN] [--ids-only | --fields FIELDS] --format json",
    get: "agentera state experiments get --objective OBJECTIVE_ID --number N --format json",
    publish: "agentera state experiments publish --objective OBJECTIVE_ID --number N --input EXPERIMENT.yaml --format json",
  },
} as const;

const EXPECTED_IMPLEMENTATION = {
  plan_tasks: "implemented",
  plans: "implemented",
  experiments: "implemented",
} as const;

function mapping(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requireNonEmpty(record: Record<string, unknown>, field: string, prefix: string, errors: string[]): void {
  if (typeof record[field] !== "string" || String(record[field]).trim() === "") errors.push(`${prefix}.${field}`);
}

function patternAccepts(pattern: unknown, accepted: string[], rejected: string[], prefix: string, errors: string[]): void {
  if (typeof pattern !== "string") {
    errors.push(`${prefix}.pattern`);
    return;
  }
  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch {
    errors.push(`${prefix}.pattern_invalid`);
    return;
  }
  if (accepted.some((value) => !expression.test(value))) errors.push(`${prefix}.accepted_examples`);
  if (rejected.some((value) => expression.test(value))) errors.push(`${prefix}.rejected_examples`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function deriveLegacyPlanIdentity(canonicalJson: string): string {
  return `legacy-plan:${sha256(canonicalJson)}`;
}

export function deriveLegacyObjectiveIdentity(canonicalJson: string): string {
  return `legacy-objective:${sha256(canonicalJson)}`;
}

export function validateExperimentPublicationParity(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const publication = mapping(mapping(mapping(value.retrieval).identity).experiment);
  const publicationContract = mapping(publication.publication);
  const archive = mapping(value.experiment_archival);
  const archiveLayout = mapping(archive.layout);
  const archivePublication = mapping(archive.publication);
  const archiveProjection = mapping(archive.projection);

  if (publicationContract.authority !== "typed_state_writer") {
    errors.push("retrieval.identity.experiment.publication.authority");
  }
  if (publicationContract.archive_ownership !== "experiment_archival" || archive.status !== "implemented") {
    errors.push("retrieval.identity.experiment.publication.archive_ownership");
  }
  if (
    publicationContract.storage_scope !== "objective_directory"
    || publicationContract.storage_scope !== archiveLayout.ownership
  ) {
    errors.push("retrieval.identity.experiment.publication.storage_scope");
  }
  if (
    publicationContract.publication_order !== "archive_before_projection"
    || archivePublication.archive_before_projection !== true
  ) {
    errors.push("retrieval.identity.experiment.publication.publication_order");
  }
  if (
    publicationContract.projection_policy !== "uniform_10_40_50"
    || publicationContract.projection_policy !== archiveProjection.policy
  ) {
    errors.push("retrieval.identity.experiment.publication.projection_policy");
  }
  return errors;
}

/** Validate executable retrieval fields and their declared publication/storage seams. */
export function validateStateRetrievalAuthority(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const retrieval = mapping(value.retrieval);
  if (retrieval.schema_version !== STATE_RETRIEVAL_SCHEMA_VERSION) errors.push("retrieval.schema_version");
  if (retrieval.status !== "plan_task_plan_and_experiment_retrieval_implemented") errors.push("retrieval.status");
  const implementation = mapping(retrieval.implementation);
  for (const [surface, status] of Object.entries(EXPECTED_IMPLEMENTATION)) {
    if (implementation[surface] !== status) errors.push(`retrieval.implementation.${surface}`);
  }
  requireNonEmpty(retrieval, "authority_boundary", "retrieval", errors);

  const envelope = mapping(retrieval.envelope);
  for (const field of ["schemaVersion", "command", "status", "entries", "counts", "order", "filters", "snapshot", "source", "source_contract"]) {
    if (!strings(envelope.required_fields).includes(field)) errors.push(`retrieval.envelope.required_fields.${field}`);
  }
  const cursor = mapping(retrieval.cursor);
  for (const field of ["vocabulary", "response_field", "binding", "invalid_behavior", "unavailable_behavior"]) {
    if (!(field in cursor)) errors.push(`retrieval.cursor.${field}`);
  }
  const omission = mapping(retrieval.omission);
  for (const field of ["omitted", "omitted_count", "omission_reason", "retrieval"]) {
    if (!strings(omission.required_when_any_entry_is_not_returned).includes(field)) {
      errors.push(`retrieval.omission.required_when_any_entry_is_not_returned.${field}`);
    }
  }
  requireNonEmpty(omission, "semantics", "retrieval.omission", errors);
  const outputBounds = mapping(retrieval.output_bounds);
  if (outputBounds.maximum_limit !== 100) errors.push("retrieval.output_bounds.maximum_limit");
  if (outputBounds.max_serialized_utf8_bytes !== 32_768) errors.push("retrieval.output_bounds.max_serialized_utf8_bytes");
  if (outputBounds.scalar_truncation !== "forbidden") errors.push("retrieval.output_bounds.scalar_truncation");
  if (outputBounds.omission_unit !== "candidates_beyond_the_summary_row_window") errors.push("retrieval.output_bounds.omission_unit");
  if (outputBounds.optional_detail !== "degrade_before_any_summary_row_omission") errors.push("retrieval.output_bounds.optional_detail");
  const summaryProjection = mapping(mapping(retrieval.envelope).bounded_summary_projection);
  if (summaryProjection.cardinality_owner !== "summary_rows_after_filters_and_cursor") errors.push("retrieval.envelope.bounded_summary_projection.cardinality_owner");
  if (summaryProjection.summary_required_fields === undefined) errors.push("retrieval.envelope.bounded_summary_projection.summary_required_fields");

  const identities = mapping(retrieval.identity);
  for (const name of ["plan", "task", "objective", "experiment"]) {
    if (Object.keys(mapping(identities[name])).length === 0) errors.push(`retrieval.identity.${name}`);
  }
  const planIdentity = mapping(identities.plan);
  for (const field of ["canonical_format", "persistence", "transition", "legacy_format", "legacy_derivation", "collision"]) {
    requireNonEmpty(planIdentity, field, "retrieval.identity.plan", errors);
  }
  if (!Array.isArray(planIdentity.test_vectors) || planIdentity.test_vectors.length === 0) {
    errors.push("retrieval.identity.plan.test_vectors");
  } else {
    for (const [index, raw] of planIdentity.test_vectors.entries()) {
      const vector = mapping(raw);
      const canonicalJson = String(vector.canonical_json ?? "");
      try {
        JSON.parse(canonicalJson);
      } catch {
        errors.push(`retrieval.identity.plan.test_vectors[${index}].canonical_json`);
      }
      if (vector.stable_id !== deriveLegacyPlanIdentity(canonicalJson)) errors.push(`retrieval.identity.plan.test_vectors[${index}].stable_id`);
      if (vector.identical_result !== "mirrored_provenance") errors.push(`retrieval.identity.plan.test_vectors[${index}].identical_result`);
    }
  }
  const objectiveIdentity = mapping(identities.objective);
  for (const field of ["canonical_format", "persistence", "canonical_root", "legacy_root", "legacy_format", "legacy_derivation", "path_compatibility"]) {
    requireNonEmpty(objectiveIdentity, field, "retrieval.identity.objective", errors);
  }
  if (!Array.isArray(objectiveIdentity.test_vectors) || objectiveIdentity.test_vectors.length === 0) {
    errors.push("retrieval.identity.objective.test_vectors");
  } else {
    for (const [index, raw] of objectiveIdentity.test_vectors.entries()) {
      const vector = mapping(raw);
      const canonicalJson = String(vector.canonical_json ?? "");
      try {
        JSON.parse(canonicalJson);
      } catch {
        errors.push(`retrieval.identity.objective.test_vectors[${index}].canonical_json`);
      }
      if (vector.stable_id !== deriveLegacyObjectiveIdentity(canonicalJson)) {
        errors.push(`retrieval.identity.objective.test_vectors[${index}].stable_id`);
      }
    }
  }
  const experimentIdentity = mapping(identities.experiment);
  if (!String(experimentIdentity.format ?? "").includes("non-negative-integer")) errors.push("retrieval.identity.experiment.format");
  if (!String(experimentIdentity.zero ?? "").includes("0 is valid")) errors.push("retrieval.identity.experiment.zero");
  for (const field of ["scope", "collision", "compatibility", "publication_validation"]) {
    requireNonEmpty(experimentIdentity, field, "retrieval.identity.experiment", errors);
  }
  errors.push(...validateExperimentPublicationParity(value));

  const commands = mapping(retrieval.commands);
  for (const [name, grammar] of Object.entries(EXPECTED_COMMANDS)) {
    const command = mapping(commands[name]);
    if (command.list !== grammar.list) errors.push(`retrieval.commands.${name}.list`);
    if (command.get !== grammar.get) errors.push(`retrieval.commands.${name}.get`);
    if ("publish" in grammar && command.publish !== grammar.publish) errors.push(`retrieval.commands.${name}.publish`);
  }
  const planTaskSelectors = mapping(mapping(commands.plan_tasks).selectors);
  const planTaskPlanSelector = mapping(planTaskSelectors.plan);
  if (planTaskPlanSelector.list_required !== false || planTaskPlanSelector.get_required !== false) errors.push("retrieval.commands.plan_tasks.selectors.plan.required");
  for (const field of ["list_default", "get_default"]) requireNonEmpty(planTaskPlanSelector, field, "retrieval.commands.plan_tasks.selectors.plan", errors);
  patternAccepts(
    planTaskPlanSelector.pattern,
    ["abcdefghij", "qjtrmnpvka"],
    ["plan:-", "plan:not-a-uuid", "1", "abcdefghijk"],
    "retrieval.commands.plan_tasks.selectors.plan",
    errors,
  );
  const taskSelector = mapping(planTaskSelectors.task);
  if (taskSelector.get_required !== true) errors.push("retrieval.commands.plan_tasks.selectors.task.get_required");
  patternAccepts(taskSelector.pattern, ["abcdefghij", "qjtrmnpvka"], ["1", "plan:abcdefghij", "abcdefghi"], "retrieval.commands.plan_tasks.selectors.task", errors);
  const planSelector = mapping(mapping(mapping(commands.plans).selectors).plan);
  if (planSelector.get_required !== true) errors.push("retrieval.commands.plans.selectors.plan.get_required");
  patternAccepts(
    planSelector.pattern,
    ["abcdefghij", "qjtrmnpvka"],
    ["plan:-", "plan:not-a-uuid", "1", "abcdefghijk"],
    "retrieval.commands.plans.selectors.plan",
    errors,
  );
  const experimentSelectors = mapping(mapping(commands.experiments).selectors);
  const objectiveSelector = mapping(experimentSelectors.objective);
  if (objectiveSelector.list_required !== true || objectiveSelector.get_required !== true) errors.push("retrieval.commands.experiments.selectors.objective.required");
  patternAccepts(
    objectiveSelector.pattern,
    ["objective:018f6b9a-7c2d-7abc-8def-0123456789ab", `legacy-objective:${"b".repeat(64)}`],
    ["objective:-", "objective:not-a-uuid", `legacy-objective:${"b".repeat(63)}`],
    "retrieval.commands.experiments.selectors.objective",
    errors,
  );
  const experimentNumber = mapping(experimentSelectors.number);
  if (experimentNumber.get_required !== true) errors.push("retrieval.commands.experiments.selectors.number.get_required");
  patternAccepts(experimentNumber.pattern, ["0", "1", "42"], ["-1", "01", "1.0"], "retrieval.commands.experiments.selectors.number", errors);

  const failures = mapping(retrieval.failures);
  for (const field of ["class", "message", "syntax", "example", "recovery"]) {
    if (!strings(failures.required_fields).includes(field)) errors.push(`retrieval.failures.required_fields.${field}`);
  }
  const failureClasses = mapping(failures.classes);
  for (const name of EXPECTED_FAILURES) requireNonEmpty(failureClasses, name, "retrieval.failures.classes", errors);

  const collectionValues = Array.isArray(retrieval.collections) ? retrieval.collections : [];
  const collectionIds: string[] = [];
  collectionValues.forEach((value, index) => {
    const collection = mapping(value);
    const prefix = `retrieval.collections[${index}]`;
    for (const field of COLLECTION_FIELDS) requireNonEmpty(collection, field, prefix, errors);
    if (typeof collection.collection_id === "string") collectionIds.push(collection.collection_id);
  });
  if (new Set(collectionIds).size !== collectionIds.length) errors.push("retrieval.collections.duplicate_collection_id");
  for (const id of EXPECTED_COLLECTIONS) {
    if (!collectionIds.includes(id)) errors.push(`retrieval.collections.missing.${id}`);
  }

  const gaps = Array.isArray(retrieval.gap_closure_evidence) ? retrieval.gap_closure_evidence : [];
  for (const surface of ["plan", "experiments"]) {
    if (!gaps.some((value) => String(mapping(value).surface ?? "").includes(surface))) {
      errors.push(`retrieval.gap_closure_evidence.${surface}`);
    }
  }
  gaps.forEach((value, index) => {
    const gap = mapping(value);
    for (const field of ["surface", "declared_gap", "closure"]) {
      requireNonEmpty(gap, field, `retrieval.gap_closure_evidence[${index}]`, errors);
    }
    if (gap.outcome !== "closed" && gap.outcome !== "out_of_scope") {
      errors.push(`retrieval.gap_closure_evidence[${index}].outcome`);
    }
  });
  const diagnostics = mapping(retrieval.plan_archive_diagnostics);
  if (diagnostics.classification !== "pre_existing_compatibility_caveat") {
    errors.push("retrieval.plan_archive_diagnostics.classification");
  }
  requireNonEmpty(diagnostics, "smoke_test_behavior", "retrieval.plan_archive_diagnostics", errors);
  return errors;
}

export interface StateRetrievalAuthority {
  authority: typeof STATE_RETRIEVAL_AUTHORITY_PATH;
  retrieval: JsonObject;
}

export function loadStateRetrievalAuthority(sourceRoot = resolveSourceRoot()): StateRetrievalAuthority {
  const authorityPath = path.join(sourceRoot, STATE_RETRIEVAL_AUTHORITY_PATH);
  const value = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  const errors = validateStateRetrievalAuthority(value);
  if (errors.length > 0) throw new Error(`invalid state retrieval authority: ${errors.join(", ")}`);
  return {
    authority: STATE_RETRIEVAL_AUTHORITY_PATH,
    retrieval: value.retrieval as JsonObject,
  };
}

export function stateRetrievalCommands(sourceRoot = resolveSourceRoot()): JsonObject {
  const commands = mapping(loadStateRetrievalAuthority(sourceRoot).retrieval.commands);
  return commands as JsonObject;
}

export function entityPublicRetrieval(sourceRoot = resolveSourceRoot()): JsonObject {
  const authorityPath = path.join(sourceRoot, STATE_RETRIEVAL_AUTHORITY_PATH);
  const projection = entityListAuthorityProjection(sourceRoot);
  if (projection.schema_version !== "agentera.entityPublicRetrieval.v1" || projection.status !== "final") {
    throw new Error(`state storage authority '${authorityPath}' has no final entity public retrieval projection`);
  }
  return projection as JsonObject;
}

export function startupSurfaceBudget(
  surface: "prime_briefing" | "prime_dashboard" | "prime_status_context" | "prime_sparse",
  sourceRoot = resolveSourceRoot(),
): number {
  const authorityPath = path.join(sourceRoot, STATE_RETRIEVAL_AUTHORITY_PATH);
  const value = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  const surfaces = mapping(mapping(mapping(value.budgets).startup).surfaces);
  const budget = Number(mapping(surfaces[surface]).max_utf8_bytes);
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new Error(`state storage authority '${authorityPath}' has no positive startup budget for '${surface}'`);
  }
  return budget;
}

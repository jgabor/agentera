import { createHash } from "node:crypto";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { validateEntityListHelp } from "./entityRetrievalHelp.js";
import { loadStateStorageAuthority } from "./stateStorageAuthority.js";

export const STATE_RETRIEVAL_AUTHORITY_PATH = "references/artifacts/state-storage-authority.yaml";
export const STATE_RETRIEVAL_SCHEMA_VERSION = "agentera.entityPublicRetrieval.v1";

const POLICY_SCHEMA_VERSION = "agentera.entityPublicRetrievalPolicy.v1";
const FAILURE_CLASSES = [
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

function mapping(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function requireNonEmpty(
  record: Record<string, unknown>,
  field: string,
  prefix: string,
  errors: string[],
): void {
  if (typeof record[field] !== "string" || String(record[field]).trim() === "") {
    errors.push(`${prefix}.${field}`);
  }
}

export function deriveLegacyPlanIdentity(canonicalJson: string): string {
  return `legacy-plan:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`;
}

/** Validate the canonical archive projection against its owning archive contract. */
export function validateExperimentPublicationParity(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const retrieval = mapping(mapping(value.entity_target).public_retrieval);
  const archivePolicy = mapping(mapping(mapping(retrieval.policy).archive_policy).experiments);
  const archive = mapping(value.experiment_archival);
  const layout = mapping(archive.layout);
  const publication = mapping(archive.publication);
  const projection = mapping(archive.projection);
  const prefix = "entity_target.public_retrieval.policy.archive_policy.experiments";

  if (archivePolicy.owner !== "experiment_archival" || archive.status !== "implemented") {
    errors.push(`${prefix}.owner`);
  }
  if (archivePolicy.storage_scope !== "objective_directory" || archivePolicy.storage_scope !== layout.ownership) {
    errors.push(`${prefix}.storage_scope`);
  }
  if (archivePolicy.publication_order !== "archive_before_projection" || publication.archive_before_projection !== true) {
    errors.push(`${prefix}.publication_order`);
  }
  if (archivePolicy.projection_policy !== "uniform_10_40_50" || archivePolicy.projection_policy !== projection.policy) {
    errors.push(`${prefix}.projection_policy`);
  }
  return errors;
}

/** Validate the sole active public retrieval projection and its unique policy. */
export function validateStateRetrievalAuthority(value: Record<string, unknown>): string[] {
  const errors = validateEntityListHelp(value);
  const retrieval = mapping(mapping(value.entity_target).public_retrieval);
  const policy = mapping(retrieval.policy);
  const prefix = "entity_target.public_retrieval";

  if (retrieval.schema_version !== STATE_RETRIEVAL_SCHEMA_VERSION) errors.push(`${prefix}.schema_version`);
  if (retrieval.status !== "final") errors.push(`${prefix}.status`);
  if (policy.schema_version !== POLICY_SCHEMA_VERSION) errors.push(`${prefix}.policy.schema_version`);
  const identity = mapping(mapping(value.entity_target).identity);
  if (identity.accepted_pattern !== "^[a-z]{10}$") errors.push(`${prefix}.identity.accepted_pattern`);

  const envelope = mapping(policy.envelope);
  for (const field of ["schemaVersion", "command", "status", "entries", "counts", "filters", "snapshot", "source", "source_contract"]) {
    if (!strings(envelope.required_fields).includes(field)) errors.push(`${prefix}.policy.envelope.required_fields.${field}`);
  }
  const projection = mapping(envelope.bounded_summary_projection);
  if (projection.cardinality_owner !== "summary_rows_after_filters_and_cursor") {
    errors.push(`${prefix}.policy.envelope.bounded_summary_projection.cardinality_owner`);
  }
  const degradation = mapping(projection.optional_detail_degradation);
  for (const field of ["reason", "detail_omitted_count", "omitted_fields", "recovery"]) {
    if (!strings(degradation.required_metadata).includes(field)) {
      errors.push(`${prefix}.policy.envelope.bounded_summary_projection.optional_detail_degradation.required_metadata.${field}`);
    }
  }
  if (degradation.row_omission !== "forbidden" || degradation.scalar_truncation !== "forbidden") {
    errors.push(`${prefix}.policy.envelope.bounded_summary_projection.optional_detail_degradation.loss`);
  }

  const cursor = mapping(policy.cursor);
  for (const field of ["vocabulary", "response_field", "binding", "invalid_behavior", "unavailable_behavior"]) {
    if (!(field in cursor)) errors.push(`${prefix}.policy.cursor.${field}`);
  }
  const omission = mapping(policy.omission);
  for (const field of ["omitted", "omitted_count", "omission_reason", "retrieval"]) {
    if (!strings(omission.required_when_candidates_remain).includes(field)) {
      errors.push(`${prefix}.policy.omission.required_when_candidates_remain.${field}`);
    }
  }
  requireNonEmpty(omission, "semantics", `${prefix}.policy.omission`, errors);

  const output = mapping(policy.output_bounds);
  if (!Number.isSafeInteger(output.maximum_limit) || Number(output.maximum_limit) < 1 || Number(output.maximum_limit) > 100) {
    errors.push(`${prefix}.policy.output_bounds.maximum_limit`);
  }
  if (!Number.isSafeInteger(output.max_serialized_utf8_bytes) || Number(output.max_serialized_utf8_bytes) < 1_024) {
    errors.push(`${prefix}.policy.output_bounds.max_serialized_utf8_bytes`);
  }
  if (output.scalar_truncation !== "forbidden") errors.push(`${prefix}.policy.output_bounds.scalar_truncation`);
  if (output.row_omission_under_byte_pressure !== "forbidden") errors.push(`${prefix}.policy.output_bounds.row_omission_under_byte_pressure`);

  const failures = mapping(policy.failures);
  for (const field of ["class", "message", "syntax", "example", "recovery"]) {
    if (!strings(failures.required_fields).includes(field)) errors.push(`${prefix}.policy.failures.required_fields.${field}`);
  }
  const classes = mapping(failures.classes);
  for (const name of FAILURE_CLASSES) requireNonEmpty(classes, name, `${prefix}.policy.failures.classes`, errors);

  const planArchive = mapping(mapping(policy.archive_policy).plan);
  for (const field of ["owner", "diagnostics", "unselected_diagnostics"]) {
    requireNonEmpty(planArchive, field, `${prefix}.policy.archive_policy.plan`, errors);
  }
  errors.push(...validateExperimentPublicationParity(value));
  return [...new Set(errors)];
}

export interface StateRetrievalAuthority {
  authority: typeof STATE_RETRIEVAL_AUTHORITY_PATH;
  retrieval: JsonObject;
}

export function loadStateRetrievalAuthority(sourceRoot = resolveSourceRoot()): StateRetrievalAuthority {
  const authority = loadStateStorageAuthority(sourceRoot);
  const errors = validateStateRetrievalAuthority(authority.document);
  if (errors.length > 0) throw new Error(`invalid state retrieval authority: ${errors.join(", ")}`);
  return {
    authority: STATE_RETRIEVAL_AUTHORITY_PATH,
    retrieval: mapping(mapping(authority.document.entity_target).public_retrieval) as JsonObject,
  };
}

export function stateRetrievalCommands(sourceRoot = resolveSourceRoot()): JsonObject {
  return mapping(loadStateRetrievalAuthority(sourceRoot).retrieval.commands) as JsonObject;
}

export function entityPublicRetrieval(sourceRoot = resolveSourceRoot()): JsonObject {
  return loadStateRetrievalAuthority(sourceRoot).retrieval;
}

export function startupSurfaceBudget(
  surface: "prime_briefing" | "prime_dashboard" | "prime_status_context" | "prime_sparse",
  sourceRoot = resolveSourceRoot(),
): number {
  const authority = loadStateStorageAuthority(sourceRoot);
  const surfaces = mapping(mapping(mapping(authority.document.budgets).startup).surfaces);
  const budget = Number(mapping(surfaces[surface]).max_utf8_bytes);
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new Error(`state storage authority '${authority.authorityPath}' has no positive startup budget for '${surface}'`);
  }
  return budget;
}

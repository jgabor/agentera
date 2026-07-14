import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

const AUTHORITY_RELATIVE_PATH = "references/artifacts/state-storage-authority.yaml";

export interface StateGitBackfillContract {
  authorityPath: string;
  command: string;
  formats: string[];
  defaultLimit: number;
  maximumLimit: number;
  maximumCommits: number;
  maximumHistoryBytes: number;
  supportedArtifacts: string[];
  reachableRefs: string[];
  excludedRefs: string[];
  applyRequires: string[];
  ambiguityReasons: string[];
  statusValues: string[];
  responseRequiredFields: string[];
  responseEntryFields: string[];
  guarantees: {
    readOnlyInventoryAndPreview: boolean;
    applyRequiresForce: boolean;
    previewOptional: boolean;
    applyRevalidation: string;
    remoteContact: string;
    customRefs: string;
    projectionWrites: string;
    immutableConflicts: string;
    retry: string;
    failureProjectionRule: string;
  };
  omission: {
    fields: string[];
    completeReason: string;
    boundedReason: string;
    continuation: string;
  };
  traceabilityFields: string[];
  archiveRecordForbids: string[];
  recovery: string;
}

export interface StateGitBackfillSourceContract {
  authority: string;
  command: string;
  formats: string[];
  supported_artifacts: string[];
  limits: {
    results: number;
    history_units: number;
    history_bytes: number;
  };
  reachable_refs: string[];
  excluded_refs: string[];
  apply_requires: string[];
  status_values: string[];
  response: {
    required_fields: string[];
    entry_fields: string[];
  };
  ambiguity_reasons: string[];
  consent: {
    inventory: string;
    preview: string;
    apply: string;
  };
  revalidation: string;
  failure_projection: string;
  recovery: {
    operation: string;
    retry: string;
    omission: string;
  };
  traceability: {
    provenance_fields: string[];
    archive_record_forbids: string[];
  };
}

function mapping(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`state storage authority field '${field}' must be a non-empty string`);
  }
  return value;
}

function requiredList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`state storage authority field '${field}' must be a list of non-empty strings`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`state storage authority field '${field}' must be a positive integer`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`state storage authority field '${field}' must be a boolean`);
  }
  return value;
}

function requiredMapping(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`state storage authority field '${field}' must be a mapping`);
  }
  return value as Record<string, unknown>;
}

export function stateGitBackfillContract(
  sourceRoot: string = resolveSourceRoot(),
): StateGitBackfillContract {
  const authority = loadYamlMapping(
    fs.readFileSync(path.join(sourceRoot, AUTHORITY_RELATIVE_PATH), "utf8"),
  );
  if (authority.schema_version !== "agentera.stateStorageAuthority.v1") {
    throw new Error("state storage authority schema_version is unsupported");
  }
  if (authority.status !== "active_authority") {
    throw new Error("state storage authority must be active_authority");
  }
  const api = mapping(authority.api);
  const backfill = mapping(api.backfill);
  const formats = requiredList(backfill.formats, "api.backfill.formats");
  if (formats.join(",") !== "text,json,yaml") {
    throw new Error("state storage authority backfill formats must be text, json, yaml");
  }
  const defaultLimit = requiredPositiveInteger(backfill.default_limit, "api.backfill.default_limit");
  const maximumLimit = requiredPositiveInteger(backfill.maximum_limit, "api.backfill.maximum_limit");
  if (defaultLimit > maximumLimit) {
    throw new Error("state storage authority backfill default limit exceeds maximum limit");
  }
  const guarantees = requiredMapping(backfill.guarantees, "api.backfill.guarantees");
  const omission = requiredMapping(backfill.omission, "api.backfill.omission");
  const traceability = requiredMapping(backfill.traceability, "api.backfill.traceability");
  const response = requiredMapping(backfill.response, "api.backfill.response");
  return {
    authorityPath: AUTHORITY_RELATIVE_PATH,
    command: requiredString(backfill.command, "api.backfill.command"),
    formats,
    defaultLimit,
    maximumLimit,
    maximumCommits: requiredPositiveInteger(backfill.maximum_commits, "api.backfill.maximum_commits"),
    maximumHistoryBytes: requiredPositiveInteger(
      backfill.maximum_history_bytes,
      "api.backfill.maximum_history_bytes",
    ),
    supportedArtifacts: requiredList(backfill.supported_artifacts, "api.backfill.supported_artifacts"),
    reachableRefs: requiredList(backfill.reachable_refs, "api.backfill.reachable_refs"),
    excludedRefs: requiredList(backfill.excluded_refs, "api.backfill.excluded_refs"),
    applyRequires: requiredList(backfill.apply_requires, "api.backfill.apply_requires"),
    ambiguityReasons: requiredList(backfill.ambiguity_reasons, "api.backfill.ambiguity_reasons"),
    statusValues: requiredList(backfill.status_values, "api.backfill.status_values"),
    responseRequiredFields: requiredList(
      response.required_fields,
      "api.backfill.response.required_fields",
    ),
    responseEntryFields: requiredList(response.entry_fields, "api.backfill.response.entry_fields"),
    guarantees: {
      readOnlyInventoryAndPreview: requiredBoolean(
        guarantees.read_only_inventory_and_preview,
        "api.backfill.guarantees.read_only_inventory_and_preview",
      ),
      applyRequiresForce: requiredBoolean(
        guarantees.apply_requires_force,
        "api.backfill.guarantees.apply_requires_force",
      ),
      previewOptional: requiredBoolean(
        guarantees.preview_optional,
        "api.backfill.guarantees.preview_optional",
      ),
      applyRevalidation: requiredString(
        guarantees.apply_revalidation,
        "api.backfill.guarantees.apply_revalidation",
      ),
      remoteContact: requiredString(guarantees.remote_contact, "api.backfill.guarantees.remote_contact"),
      customRefs: requiredString(guarantees.custom_refs, "api.backfill.guarantees.custom_refs"),
      projectionWrites: requiredString(
        guarantees.projection_writes,
        "api.backfill.guarantees.projection_writes",
      ),
      immutableConflicts: requiredString(
        guarantees.immutable_conflicts,
        "api.backfill.guarantees.immutable_conflicts",
      ),
      retry: requiredString(guarantees.retry, "api.backfill.guarantees.retry"),
      failureProjectionRule: requiredString(
        guarantees.failure_projection_rule,
        "api.backfill.guarantees.failure_projection_rule",
      ),
    },
    omission: {
      fields: requiredList(omission.fields, "api.backfill.omission.fields"),
      completeReason: requiredString(omission.complete_reason, "api.backfill.omission.complete_reason"),
      boundedReason: requiredString(omission.bounded_reason, "api.backfill.omission.bounded_reason"),
      continuation: requiredString(omission.continuation, "api.backfill.omission.continuation"),
    },
    traceabilityFields: requiredList(
      traceability.provenance_fields,
      "api.backfill.traceability.provenance_fields",
    ),
    archiveRecordForbids: requiredList(
      traceability.archive_record_forbids,
      "api.backfill.traceability.archive_record_forbids",
    ),
    recovery: requiredString(backfill.recovery, "api.backfill.recovery"),
  };
}

export function gitBackfillContractProjection(
  contract: StateGitBackfillContract,
): StateGitBackfillSourceContract {
  return {
    authority: contract.authorityPath,
    command: contract.command,
    formats: contract.formats,
    supported_artifacts: contract.supportedArtifacts,
    limits: {
      results: contract.maximumLimit,
      history_units: contract.maximumCommits,
      history_bytes: contract.maximumHistoryBytes,
    },
    reachable_refs: contract.reachableRefs,
    excluded_refs: contract.excludedRefs,
    apply_requires: contract.applyRequires,
    status_values: contract.statusValues,
    ambiguity_reasons: contract.ambiguityReasons,
    response: {
      required_fields: contract.responseRequiredFields,
      entry_fields: contract.responseEntryFields,
    },
    consent: {
      inventory: contract.guarantees.readOnlyInventoryAndPreview ? "read_only" : "mutation",
      preview: contract.guarantees.previewOptional ? "optional_read_only" : "required_read_only",
      apply: contract.guarantees.applyRequiresForce ? "--apply --force" : "--apply",
    },
    revalidation: contract.guarantees.applyRevalidation,
    failure_projection: contract.guarantees.failureProjectionRule,
    recovery: {
      operation: contract.recovery,
      retry: contract.guarantees.retry,
      omission: contract.omission.continuation,
    },
    traceability: {
      provenance_fields: contract.traceabilityFields,
      archive_record_forbids: contract.archiveRecordForbids,
    },
  };
}

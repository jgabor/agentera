import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

const AUTHORITY_RELATIVE_PATH = "references/artifacts/state-storage-authority.yaml";
const EXPECTED_AUTHORITY_SCHEMA = "agentera.stateStorageAuthority.v1";
const EXPECTED_ARTIFACTS = ["progress", "decisions", "health"];
const EXPECTED_FORMATS = ["text", "json", "yaml"];

type Mapping = Record<string, unknown>;

export interface StateMigrationContract {
  authorityPath: string;
  migration: Mapping;
  command: string;
  formats: string[];
  defaultLimit: number;
  maximumLimit: number;
  supportedArtifacts: string[];
}

function mapping(value: unknown, field: string): Mapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`state storage authority field '${field}' must be a mapping`);
  }
  return value as Mapping;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`state storage authority field '${field}' must be a non-empty string`);
  }
  return value;
}

function requiredList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`state storage authority field '${field}' must be a list of non-empty strings`);
  }
  return [...value] as string[];
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`state storage authority field '${field}' must be a positive integer`);
  }
  return value;
}

function requireKeys(value: Mapping, keys: string[], field: string): void {
  for (const key of keys) {
    if (!(key in value))
      throw new Error(`state storage authority field '${field}.${key}' is required`);
  }
}

/** Load and validate the local migration command from the canonical authority. */
export function stateMigrationContract(
  sourceRoot: string = resolveSourceRoot(),
): StateMigrationContract {
  const authorityPath = path.join(sourceRoot, AUTHORITY_RELATIVE_PATH);
  const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  if (authority.schema_version !== EXPECTED_AUTHORITY_SCHEMA) {
    throw new Error("state storage authority schema_version is unsupported");
  }
  if (authority.status !== "active_authority") {
    throw new Error("state storage authority must be active_authority");
  }

  const scope = mapping(authority.scope, "scope");
  if (
    !Array.isArray(scope.supported_artifacts) ||
    scope.supported_artifacts.some(
      (artifact) => artifact === null || typeof artifact !== "object" || Array.isArray(artifact),
    )
  ) {
    throw new Error(
      "state storage authority field 'scope.supported_artifacts' must be a list of mappings",
    );
  }
  const supportedArtifacts = scope.supported_artifacts as Array<Mapping>;
  const artifactIds = supportedArtifacts.map((artifact) => artifact.artifact_id);
  if (artifactIds.join(",") !== EXPECTED_ARTIFACTS.join(",")) {
    throw new Error(
      "state storage authority supported artifacts must be progress, decisions, health",
    );
  }

  const api = mapping(authority.api, "api");
  const migration = mapping(api.migrate, "api.migrate");
  const namespace = requiredString(migration.namespace, "api.migrate.namespace");
  if (namespace !== "agentera state migrate") {
    throw new Error("state storage authority migrate namespace must be agentera state migrate");
  }
  const command = requiredString(migration.command, "api.migrate.command");
  const formats = requiredList(migration.formats, "api.migrate.formats");
  if (formats.join(",") !== EXPECTED_FORMATS.join(",")) {
    throw new Error("state storage authority migrate formats must be text, json, yaml");
  }
  const defaultLimit = requiredPositiveInteger(
    migration.default_limit,
    "api.migrate.default_limit",
  );
  const maximumLimit = requiredPositiveInteger(
    migration.maximum_limit,
    "api.migrate.maximum_limit",
  );
  if (defaultLimit > maximumLimit) {
    throw new Error("state storage authority migrate default limit exceeds maximum limit");
  }
  const migrationArtifacts = requiredList(
    migration.supported_artifacts,
    "api.migrate.supported_artifacts",
  );
  if (migrationArtifacts.join(",") !== EXPECTED_ARTIFACTS.join(",")) {
    throw new Error(
      "state storage authority migrate artifacts must be progress, decisions, health",
    );
  }

  const selectors = mapping(migration.selectors, "api.migrate.selectors");
  requireKeys(
    selectors,
    ["project", "artifact", "number", "path", "limit"],
    "api.migrate.selectors",
  );
  const modes = mapping(migration.modes, "api.migrate.modes");
  requireKeys(
    modes,
    ["inventory", "preview", "apply", "invalid_combinations"],
    "api.migrate.modes",
  );
  const inventory = mapping(migration.inventory, "api.migrate.inventory");
  requireKeys(
    inventory,
    [
      "bounded_scan",
      "candidate_rule",
      "fixed_names",
      "custom_name_rule",
      "deterministic_rejections",
    ],
    "api.migrate.inventory",
  );
  const boundary = mapping(migration.project_boundary, "api.migrate.project_boundary");
  requireKeys(
    boundary,
    ["selected_root", "candidate_rule", "reject"],
    "api.migrate.project_boundary",
  );
  const compatibility = mapping(migration.compatibility_window, "api.migrate.compatibility_window");
  requireKeys(
    compatibility,
    ["name", "scope", "supported_sources", "classifications", "cases", "no_reconstruction"],
    "api.migrate.compatibility_window",
  );
  const backups = mapping(migration.backups, "api.migrate.backups");
  requireKeys(
    backups,
    [
      "required_for_apply",
      "root",
      "path_template",
      "identity",
      "publication",
      "existing_backup",
      "cleanup",
    ],
    "api.migrate.backups",
  );
  const publication = mapping(migration.publication, "api.migrate.publication");
  requireKeys(
    publication,
    ["order", "archive_before_projection", "projection_failure", "monotonic_states", "retry"],
    "api.migrate.publication",
  );
  const git = mapping(migration.git, "api.migrate.git");
  requireKeys(
    git,
    ["required", "reads", "remote_contact", "completion_independent"],
    "api.migrate.git",
  );
  const result = mapping(migration.result, "api.migrate.result");
  requireKeys(
    result,
    ["schema_version", "statuses", "required_fields", "entry_fields", "count_fields", "omission"],
    "api.migrate.result",
  );
  const failures = mapping(migration.failures, "api.migrate.failures");
  requireKeys(failures, ["schema_version", "deterministic", "classes"], "api.migrate.failures");
  const guarantees = mapping(migration.guarantees, "api.migrate.guarantees");
  requireKeys(
    guarantees,
    [
      "read_only_inventory_and_preview",
      "apply_requires_force",
      "archive_before_projection",
      "backups_before_projection",
      "monotonic_retry",
      "archive_immutability",
      "project_local",
      "remote_contact",
      "git_independent",
    ],
    "api.migrate.guarantees",
  );

  return {
    authorityPath: AUTHORITY_RELATIVE_PATH,
    migration,
    command,
    formats,
    defaultLimit,
    maximumLimit,
    supportedArtifacts: migrationArtifacts,
  };
}

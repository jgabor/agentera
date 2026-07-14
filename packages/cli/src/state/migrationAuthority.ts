import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

const AUTHORITY_RELATIVE_PATH = "references/artifacts/state-storage-authority.yaml";

export type StateMigrationMapping = Record<string, unknown>;

export interface StateMigrationContract {
  authorityPath: string;
  schemaVersion: string;
  migration: StateMigrationMapping;
  namespace: string;
  command: string;
  formats: string[];
  defaultLimit: number;
  minimumLimit: number;
  maximumLimit: number;
  supportedArtifacts: string[];
  selectors: Record<string, StateMigrationMapping>;
  modes: Record<string, StateMigrationMapping>;
  candidatePattern: string;
  numberPattern: string;
  scanRoots: Array<{ path: string; maximumDepth: number }>;
  resultSchemaVersion: string;
  resultStatuses: string[];
}

function mapping(value: unknown, field: string): StateMigrationMapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`state storage authority field '${field}' must be a mapping`);
  }
  return value as StateMigrationMapping;
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
  if (value.length === 0) {
    throw new Error(`state storage authority field '${field}' must not be empty`);
  }
  return [...value] as string[];
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`state storage authority field '${field}' must be a positive integer`);
  }
  return value;
}

function requireKeys(value: StateMigrationMapping, keys: string[], field: string): void {
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
  const schemaVersion = requiredString(authority.schema_version, "schema_version");
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
  const supportedArtifacts = scope.supported_artifacts as Array<StateMigrationMapping>;
  const artifactIds = supportedArtifacts.map((artifact, index) =>
    requiredString(artifact.artifact_id, `scope.supported_artifacts[${index}].artifact_id`),
  );

  const api = mapping(authority.api, "api");
  const migration = mapping(api.migrate, "api.migrate");
  const namespace = requiredString(migration.namespace, "api.migrate.namespace");
  const command = requiredString(migration.command, "api.migrate.command");
  if (!command.startsWith(`${namespace} `)) {
    throw new Error("state storage authority migrate command must begin with its namespace");
  }
  const formats = requiredList(migration.formats, "api.migrate.formats");
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
  if (JSON.stringify(migrationArtifacts) !== JSON.stringify(artifactIds)) {
    throw new Error("state storage authority migrate artifacts must match scope artifacts");
  }

  const selectors = mapping(migration.selectors, "api.migrate.selectors");
  const selectorContracts: Record<string, StateMigrationMapping> = {};
  for (const name of ["project", "artifact", "number", "path", "limit", "format"]) {
    const selector = mapping(selectors[name], `api.migrate.selectors.${name}`);
    requiredString(selector.flag, `api.migrate.selectors.${name}.flag`);
    selectorContracts[name] = selector;
  }
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

  const boundedScan = mapping(inventory.bounded_scan, "api.migrate.inventory.bounded_scan");
  if (!Array.isArray(boundedScan.roots) || boundedScan.roots.length === 0) {
    throw new Error(
      "state storage authority field 'api.migrate.inventory.bounded_scan.roots' must be a non-empty list",
    );
  }
  const scanRoots = boundedScan.roots.map((root, index) => {
    const rootMapping = mapping(root, `api.migrate.inventory.bounded_scan.roots[${index}]`);
    return {
      path: requiredString(
        rootMapping.path,
        `api.migrate.inventory.bounded_scan.roots[${index}].path`,
      ),
      maximumDepth: requiredPositiveInteger(
        rootMapping.maximum_depth,
        `api.migrate.inventory.bounded_scan.roots[${index}].maximum_depth`,
      ),
    };
  });
  const candidatePattern = requiredString(
    selectorContracts.path.pattern,
    "api.migrate.selectors.path.pattern",
  );
  const numberPattern = requiredString(
    selectorContracts.number.pattern,
    "api.migrate.selectors.number.pattern",
  );
  const minimumLimit = requiredPositiveInteger(
    selectorContracts.limit.minimum,
    "api.migrate.selectors.limit.minimum",
  );
  const selectorMaximumLimit = requiredPositiveInteger(
    selectorContracts.limit.maximum,
    "api.migrate.selectors.limit.maximum",
  );
  if (selectorMaximumLimit !== maximumLimit) {
    throw new Error("state storage authority selector maximum must match migrate maximum limit");
  }
  const resultSchemaVersion = requiredString(
    result.schema_version,
    "api.migrate.result.schema_version",
  );
  const resultStatuses = requiredList(result.statuses, "api.migrate.result.statuses");
  const modeContracts: Record<string, StateMigrationMapping> = {};
  for (const name of ["inventory", "preview", "apply"]) {
    modeContracts[name] = mapping(modes[name], `api.migrate.modes.${name}`);
    requiredString(modeContracts[name].selector, `api.migrate.modes.${name}.selector`);
  }

  return {
    authorityPath: AUTHORITY_RELATIVE_PATH,
    schemaVersion,
    migration,
    namespace,
    command,
    formats,
    defaultLimit,
    minimumLimit,
    maximumLimit,
    supportedArtifacts: migrationArtifacts,
    selectors: selectorContracts,
    modes: modeContracts,
    candidatePattern,
    numberPattern,
    scanRoots,
    resultSchemaVersion,
    resultStatuses,
  };
}

export function migrationSelectorFlag(contract: StateMigrationContract, selector: string): string {
  const value = contract.selectors[selector];
  if (!value) throw new Error(`state migration selector '${selector}' is unavailable`);
  return requiredString(value.flag, `api.migrate.selectors.${selector}.flag`).split(/\s+/, 1)[0];
}

export function migrationModeFlags(contract: StateMigrationContract, mode: string): string[] {
  const value = contract.modes[mode];
  if (!value) throw new Error(`state migration mode '${mode}' is unavailable`);
  return requiredString(value.selector, `api.migrate.modes.${mode}.selector`)
    .split(/\s+/)
    .filter((token) => token.startsWith("--"));
}

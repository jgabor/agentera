import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

const AUTHORITY_RELATIVE_PATH = "references/artifacts/state-storage-authority.yaml";

export type StateMigrationMapping = Record<string, unknown>;

export interface StateMigrationInvalidCombination {
  flags: string[];
  requires?: string;
  failureClass: string;
  message: string;
}

export interface StateMigrationOmissionContract {
  fields: string[];
  fieldSources: Record<string, string>;
  completeReason: string;
  boundedReason: string;
  retry: string;
  retrieval: string;
  semantics: string;
}

export interface StateMigrationCountRule {
  source: string;
  operation: string;
  field?: string;
  predicates: Array<{ field: string; equals?: unknown; notEquals?: unknown }>;
}

export interface StateMigrationInventoryContract {
  roots: Array<{ path: string; maximumDepth: number }>;
  excludedRelativePaths: string[];
  maximumCandidateFiles: number;
  maximumFileBytes: number;
  maximumTotalBytes: number;
  ordering: string;
}

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
  invalidCombinations: StateMigrationInvalidCombination[];
  requiredSelectors: Record<string, string[]>;
  inventory: StateMigrationInventoryContract;
  fixedNames: Record<string, string>;
  candidatePattern: string;
  numberPattern: string;
  selectorValidValues: Record<string, string[]>;
  resultRequiredFields: string[];
  resultEntryFields: string[];
  resultCountFields: string[];
  resultCountRules: Record<string, StateMigrationCountRule>;
  omission: StateMigrationOmissionContract;
  failureClasses: Record<string, StateMigrationMapping>;
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

function requireUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`state storage authority field '${field}' must not contain duplicates`);
  }
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`state storage authority field '${field}' must be a positive integer`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
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
  requireUnique(formats, "api.migrate.formats");
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
  requireUnique(migrationArtifacts, "api.migrate.supported_artifacts");
  if (JSON.stringify(migrationArtifacts) !== JSON.stringify(artifactIds)) {
    throw new Error("state storage authority migrate artifacts must match scope artifacts");
  }

  const selectors = mapping(migration.selectors, "api.migrate.selectors");
  const selectorContracts: Record<string, StateMigrationMapping> = {};
  const selectorValidValues: Record<string, string[]> = {};
  for (const name of ["project", "artifact", "number", "path", "limit", "format"]) {
    const selector = mapping(selectors[name], `api.migrate.selectors.${name}`);
    requiredString(selector.flag, `api.migrate.selectors.${name}.flag`);
    if (name === "artifact" || name === "format") {
      selectorValidValues[name] = requiredList(
        selector.valid_values,
        `api.migrate.selectors.${name}.valid_values`,
      );
      requireUnique(
        selectorValidValues[name],
        `api.migrate.selectors.${name}.valid_values`,
      );
    }
    selectorContracts[name] = selector;
  }
  if (JSON.stringify(selectorValidValues.artifact) !== JSON.stringify(migrationArtifacts)) {
    throw new Error("state storage authority artifact valid values must match supported artifacts");
  }
  if (JSON.stringify(selectorValidValues.format) !== JSON.stringify(formats)) {
    throw new Error("state storage authority format valid values must match formats");
  }
  const selectorFlags = Object.entries(selectorContracts).map(([name, selector]) =>
    requiredString(selector.flag, `api.migrate.selectors.${name}.flag`).split(/\s+/, 1)[0],
  );
  requireUnique(selectorFlags, "api.migrate.selectors.*.flag");
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
    [
      "schema_version",
      "statuses",
      "required_fields",
      "entry_fields",
      "count_fields",
      "count_rules",
      "omission",
    ],
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
  requireKeys(
    boundedScan,
    [
      "roots",
      "excluded_relative_paths",
      "maximum_candidate_files",
      "maximum_file_bytes",
      "maximum_total_bytes",
      "ordering",
    ],
    "api.migrate.inventory.bounded_scan",
  );
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
  requireUnique(
    scanRoots.map((root) => root.path),
    "api.migrate.inventory.bounded_scan.roots.path",
  );
  const excludedRelativePaths = requiredList(
    boundedScan.excluded_relative_paths,
    "api.migrate.inventory.bounded_scan.excluded_relative_paths",
  );
  requireUnique(
    excludedRelativePaths,
    "api.migrate.inventory.bounded_scan.excluded_relative_paths",
  );
  const fixedNamesValue = inventory.fixed_names;
  if (!Array.isArray(fixedNamesValue) || fixedNamesValue.length === 0) {
    throw new Error("state storage authority field 'api.migrate.inventory.fixed_names' must be a non-empty list");
  }
  const fixedNames: Record<string, string> = {};
  const fixedArtifacts: string[] = [];
  for (const [index, value] of fixedNamesValue.entries()) {
    const fixed = mapping(value, `api.migrate.inventory.fixed_names[${index}]`);
    const fixedPath = requiredString(
      fixed.path,
      `api.migrate.inventory.fixed_names[${index}].path`,
    );
    const artifact = requiredString(
      fixed.artifact,
      `api.migrate.inventory.fixed_names[${index}].artifact`,
    );
    if (fixedNames[fixedPath] !== undefined) {
      throw new Error("state storage authority field 'api.migrate.inventory.fixed_names.path' must not contain duplicates");
    }
    if (fixedArtifacts.includes(artifact)) {
      throw new Error("state storage authority field 'api.migrate.inventory.fixed_names.artifact' must not contain duplicates");
    }
    if (!migrationArtifacts.includes(artifact)) {
      throw new Error(
        `state storage authority fixed name references unsupported artifact '${artifact}'`,
      );
    }
    fixedNames[fixedPath] = artifact;
    fixedArtifacts.push(artifact);
  }
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
  const requiredSelectors: Record<string, string[]> = {};
  for (const name of ["inventory", "preview", "apply"]) {
    modeContracts[name] = mapping(modes[name], `api.migrate.modes.${name}`);
    requiredString(modeContracts[name].selector, `api.migrate.modes.${name}.selector`);
    if (name === "apply") {
      requiredSelectors[name] = requiredList(
        modeContracts[name].selectors_required,
        `api.migrate.modes.${name}.selectors_required`,
      );
    } else {
      requiredSelectors[name] = [];
    }
  }
  if (!Array.isArray(modes.invalid_combinations)) {
    throw new Error("state storage authority field 'api.migrate.modes.invalid_combinations' must be a list");
  }
  const invalidCombinations = modes.invalid_combinations.map((value, index) => {
    const combination = mapping(value, `api.migrate.modes.invalid_combinations[${index}]`);
    const flags = requiredList(
      combination.flags,
      `api.migrate.modes.invalid_combinations[${index}].flags`,
    );
    return {
      flags,
      ...(optionalString(
        combination.requires,
        `api.migrate.modes.invalid_combinations[${index}].requires`,
      )
        ? { requires: optionalString(combination.requires, "requires") }
        : {}),
      failureClass: requiredString(
        combination.failure_class,
        `api.migrate.modes.invalid_combinations[${index}].failure_class`,
      ),
      message: requiredString(
        combination.message,
        `api.migrate.modes.invalid_combinations[${index}].message`,
      ),
    };
  });
  const invalidCombinationKeys = invalidCombinations.map((combination) => {
    requireUnique(combination.flags, "api.migrate.modes.invalid_combinations.*.flags");
    return [...combination.flags].sort().join("\u0000");
  });
  requireUnique(invalidCombinationKeys, "api.migrate.modes.invalid_combinations.*.flags");

  const resultRequiredFields = requiredList(
    result.required_fields,
    "api.migrate.result.required_fields",
  );
  const resultEntryFields = requiredList(result.entry_fields, "api.migrate.result.entry_fields");
  const resultCountFields = requiredList(result.count_fields, "api.migrate.result.count_fields");
  requireUnique(resultRequiredFields, "api.migrate.result.required_fields");
  requireUnique(resultEntryFields, "api.migrate.result.entry_fields");
  requireUnique(resultCountFields, "api.migrate.result.count_fields");
  const countRulesMapping = mapping(result.count_rules, "api.migrate.result.count_rules");
  const countRuleNames = Object.keys(countRulesMapping);
  if (
    countRuleNames.length !== resultCountFields.length ||
    resultCountFields.some((field) => !countRuleNames.includes(field))
  ) {
    throw new Error("state storage authority count rules must classify every count field exactly once");
  }
  const resultCountRules: Record<string, StateMigrationCountRule> = {};
  for (const field of resultCountFields) {
    const rule = mapping(countRulesMapping[field], `api.migrate.result.count_rules.${field}`);
    const source = requiredString(rule.source, `api.migrate.result.count_rules.${field}.source`);
    const operation = requiredString(
      rule.operation,
      `api.migrate.result.count_rules.${field}.operation`,
    );
    if (!new Set(["all_candidates", "visible_entries", "omitted_count"]).has(source)) {
      throw new Error(`state storage authority count rule '${field}' has an unsupported source`);
    }
    if (!new Set(["count", "distinct", "value"]).has(operation)) {
      throw new Error(`state storage authority count rule '${field}' has an unsupported operation`);
    }
    const predicatesValue = rule.predicates ?? [];
    if (!Array.isArray(predicatesValue)) {
      throw new Error(`state storage authority count rule '${field}' predicates must be a list`);
    }
    const predicates = predicatesValue.map((value, index) => {
      const predicate = mapping(
        value,
        `api.migrate.result.count_rules.${field}.predicates[${index}]`,
      );
      const predicateField = requiredString(
        predicate.field,
        `api.migrate.result.count_rules.${field}.predicates[${index}].field`,
      );
      const hasEquals = "equals" in predicate;
      const hasNotEquals = "not_equals" in predicate;
      if (hasEquals === hasNotEquals) {
        throw new Error(
          `state storage authority count rule '${field}' predicates must declare exactly one comparison`,
        );
      }
      return hasEquals
        ? { field: predicateField, equals: predicate.equals }
        : { field: predicateField, notEquals: predicate.not_equals };
    });
    if (operation === "distinct") {
      const distinctField = requiredString(
        rule.field,
        `api.migrate.result.count_rules.${field}.field`,
      );
      resultCountRules[field] = { source, operation, field: distinctField, predicates };
    } else {
      resultCountRules[field] = { source, operation, predicates };
    }
  }
  const omission = mapping(result.omission, "api.migrate.result.omission");
  requireKeys(
    omission,
    ["fields", "complete_reason", "bounded_reason", "retry", "retrieval", "semantics"],
    "api.migrate.result.omission",
  );
  const omissionFields = requiredList(omission.fields, "api.migrate.result.omission.fields");
  requireUnique(omissionFields, "api.migrate.result.omission.fields");
  const omissionFieldSourcesMapping = mapping(
    omission.field_sources,
    "api.migrate.result.omission.field_sources",
  );
  const omissionFieldSourceNames = Object.keys(omissionFieldSourcesMapping);
  if (
    omissionFieldSourceNames.length !== omissionFields.length ||
    omissionFields.some((field) => !omissionFieldSourceNames.includes(field))
  ) {
    throw new Error("state storage authority omission sources must classify every omission field exactly once");
  }
  const omissionFieldSources: Record<string, string> = {};
  for (const field of omissionFields) {
    omissionFieldSources[field] = requiredString(
      omissionFieldSourcesMapping[field],
      `api.migrate.result.omission.field_sources.${field}`,
    );
    if (!new Set(["has_omissions", "omitted_count", "omission_reason", "retrieval"]).has(omissionFieldSources[field])) {
      throw new Error(
        `state storage authority omission field '${field}' has an unsupported source`,
      );
    }
  }
  const omissionContract: StateMigrationOmissionContract = {
    fields: omissionFields,
    fieldSources: omissionFieldSources,
    completeReason: requiredString(
      omission.complete_reason,
      "api.migrate.result.omission.complete_reason",
    ),
    boundedReason: requiredString(
      omission.bounded_reason,
      "api.migrate.result.omission.bounded_reason",
    ),
    retry: requiredString(omission.retry, "api.migrate.result.omission.retry"),
    retrieval: requiredString(omission.retrieval, "api.migrate.result.omission.retrieval"),
    semantics: requiredString(omission.semantics, "api.migrate.result.omission.semantics"),
  };
  if (omissionFields.some((field) => !resultRequiredFields.includes(field))) {
    throw new Error("state storage authority omission fields must be required result fields");
  }

  if (!Array.isArray(failures.classes)) {
    throw new Error("state storage authority field 'api.migrate.failures.classes' must be a list");
  }
  const failureClasses: Record<string, StateMigrationMapping> = {};
  for (const [index, value] of failures.classes.entries()) {
    const failure = mapping(value, `api.migrate.failures.classes[${index}]`);
    const name = requiredString(failure.class, `api.migrate.failures.classes[${index}].class`);
    requireKeys(
      failure,
      ["message", "example", "recovery"],
      `api.migrate.failures.classes[${index}]`,
    );
    requiredString(failure.message, `api.migrate.failures.classes[${index}].message`);
    requiredString(failure.example, `api.migrate.failures.classes[${index}].example`);
    requiredString(failure.recovery, `api.migrate.failures.classes[${index}].recovery`);
    failureClasses[name] = failure;
  }
  for (const combination of invalidCombinations) {
    if (!failureClasses[combination.failureClass]) {
      throw new Error(
        `state storage authority invalid combination references unknown failure class '${combination.failureClass}'`,
      );
    }
  }
  const selectorFlagSet = new Set(selectorFlags);
  for (const required of requiredSelectors.apply) {
    if (!selectorFlagSet.has(required)) {
      throw new Error(
        `state storage authority apply selector requirement '${required}' is not a selector flag`,
      );
    }
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
    invalidCombinations,
    requiredSelectors,
    inventory: {
      roots: scanRoots,
      excludedRelativePaths,
      maximumCandidateFiles: requiredPositiveInteger(
        boundedScan.maximum_candidate_files,
        "api.migrate.inventory.bounded_scan.maximum_candidate_files",
      ),
      maximumFileBytes: requiredPositiveInteger(
        boundedScan.maximum_file_bytes,
        "api.migrate.inventory.bounded_scan.maximum_file_bytes",
      ),
      maximumTotalBytes: requiredPositiveInteger(
        boundedScan.maximum_total_bytes,
        "api.migrate.inventory.bounded_scan.maximum_total_bytes",
      ),
      ordering: requiredString(
        boundedScan.ordering,
        "api.migrate.inventory.bounded_scan.ordering",
      ),
    },
    fixedNames,
    candidatePattern,
    numberPattern,
    selectorValidValues,
    resultRequiredFields,
    resultEntryFields,
    resultCountFields,
    resultCountRules,
    omission: omissionContract,
    failureClasses,
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

export function migrationFailure(
  contract: StateMigrationContract,
  failureClass: string,
): StateMigrationMapping {
  const failure = contract.failureClasses[failureClass];
  if (!failure) throw new Error(`state migration failure class '${failureClass}' is unavailable`);
  return failure;
}

export function migrationSelectorNames(contract: StateMigrationContract): string[] {
  return Object.keys(contract.selectors);
}

import fs from "node:fs";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";

/**
 * Capability schema contract loader and bootstrap model. Faithful TS port of
 * `scripts/capability_contract.py`. `capability_schema_contract.yaml` owns
 * capability schema structure; protocol primitive values stay in protocol.yaml.
 */

export const BOOTSTRAP_RULE_SECTIONS = [
  "DIRECTORY_REQUIREMENTS",
  "ENTRY_REQUIREMENTS",
  "FIELD_RULES",
  "PRIMITIVE_REFERENCE_FIELDS",
  "ROUTE_ALIASES",
  "TRIGGER_ENRICHMENT",
] as const;

export class ContractBootstrapError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "ContractBootstrapError";
    this.errors = errors;
  }
}

export interface DirectoryRules {
  instructionPath: string;
  instructionModulePath: string;
  schemasPath: string;
  schemaGlob: string;
  minimumSchemaFiles: number;
}

export interface EntrySchema {
  fields: Record<string, Record<string, unknown>>;
}

export interface EntryRules {
  defaultRequiredFields: string[];
  requiredFieldsByGroup: Record<string, string[]>;
  deprecation: Record<string, unknown>;
}

export interface TriggerPriorityRules {
  required: boolean;
  allowedValues: string[];
}

export interface PrimitiveReferenceRules {
  protocolValuesAuthority: string;
  fields: Record<string, string[]>;
}

export interface RouteAlias {
  alias: string;
  capability: string;
}

export interface RouteAliasRules {
  routePrefix: string;
  canonicalNamePrecedence: boolean;
  cliBoundary: string;
  primaryAliases: RouteAlias[];
}

/**
 * Per-entry field rule inside a `disambiguates_against` list element.
 * Owned by TRIGGER_ENRICHMENT.fields.disambiguates_against.entries.
 */
export interface DisambiguateAgainstEntryRule {
  readonly type: string;
  readonly required: boolean;
  readonly nonEmpty: boolean;
  readonly enumSource: string;
}

/**
 * Optional trigger-entry enrichment field rule (TRIGGER_ENRICHMENT.fields),
 * the single authority for the four enriched-field shapes and their contract
 * defaults per Decision 75 / references/cli/trigger-schema-enrichment.md.
 */
export interface TriggerEnrichmentFieldRule {
  readonly type: string;
  readonly required: boolean;
  readonly default: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly eachMustBeValidRegex?: boolean;
  readonly entries?: Record<string, DisambiguateAgainstEntryRule>;
}

/**
 * Resolved TRIGGER_ENRICHMENT model. `allowedCapabilityIds` is resolved from
 * ROUTE_ALIASES.primary_aliases.capability values so the validator can enforce
 * `disambiguates_against.capability` without re-reading ROUTE_ALIASES.
 */
export interface TriggerEnrichmentRules {
  readonly spec: string;
  readonly contractDefaults: { readonly confidenceThreshold: number; readonly borderlineBand: number };
  readonly fields: Record<string, TriggerEnrichmentFieldRule>;
  readonly allowedCapabilityIds: string[];
}

export interface CapabilitySchemaContract {
  path: string;
  requiredGroups: string[];
  directoryRules: DirectoryRules;
  entrySchema: EntrySchema;
  entryRules: EntryRules;
  triggerPriorityRules: TriggerPriorityRules;
  deprecationRules: Record<string, unknown>;
  groupPrefixes: Record<string, string>;
  primitiveReferences: PrimitiveReferenceRules;
  routeAliases: RouteAliasRules;
  triggerEnrichment: TriggerEnrichmentRules;
}

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadCapabilitySchemaContract(contractPath: string): CapabilitySchemaContract {
  let data: JsonObject;
  try {
    data = loadYamlMapping(fs.readFileSync(contractPath, "utf8")) as JsonObject; // cast: YAML parse IO boundary
  } catch (exc) {
    throw new ContractBootstrapError([
      `contract root in ${contractPath} must be a mapping: ${(exc as Error).message}`,
    ]);
  }
  const errors = validateContractBootstrap(data, contractPath);
  if (errors.length > 0) {
    throw new ContractBootstrapError(errors);
  }
  return buildCapabilitySchemaContract(data, contractPath);
}

export function validateContractBootstrap(data: JsonObject, sourceLabel: string): string[] {
  const errors: string[] = [];
  const requiredGroups = requiredGroupsOf(data, sourceLabel, errors);
  checkEntrySchema(data, sourceLabel, errors);
  checkGroupPrefixes(data, sourceLabel, requiredGroups, errors);
  checkRuleSections(data, sourceLabel, errors);
  checkSelfGroups(data, sourceLabel, requiredGroups, errors);
  return errors;
}

export function buildCapabilitySchemaContract(
  data: JsonObject,
  contractPath: string,
): CapabilitySchemaContract {
  const directory = data.DIRECTORY_REQUIREMENTS as JsonObject;
  const schemaFiles = directory.schema_files as JsonObject;
  const entryRequirements = data.ENTRY_REQUIREMENTS as JsonObject;
  const triggerPriority = ((data.FIELD_RULES as JsonObject).TRIGGERS as JsonObject).priority as JsonObject;
  const primitiveRefs = data.PRIMITIVE_REFERENCE_FIELDS as JsonObject;
  const routeAliases = data.ROUTE_ALIASES as JsonObject;

  const groups = entryRequirements.groups as Record<string, JsonObject>;
  const requiredFieldsByGroup: Record<string, string[]> = {};
  for (const [groupName, groupRule] of Object.entries(groups)) {
    requiredFieldsByGroup[groupName] = [...((groupRule as JsonObject).required_fields as string[])];
  }

  const entryRules: EntryRules = {
    defaultRequiredFields: [...(entryRequirements.default_required_fields as string[])],
    requiredFieldsByGroup,
    deprecation: { ...(entryRequirements.deprecation as JsonObject) },
  };

  const primitiveFields: Record<string, string[]> = {};
  for (const [fieldName, fieldRule] of Object.entries(primitiveRefs.fields as Record<string, JsonObject>)) {
    primitiveFields[fieldName] = [...((fieldRule as JsonObject).protocol_groups as string[])];
  }

  return {
    path: contractPath,
    requiredGroups: [...(data.REQUIRED_GROUPS as string[])],
    directoryRules: {
      instructionPath: (directory.instruction_module as JsonObject).path as string,
      instructionModulePath: (directory.instruction_module as JsonObject).path as string,
      schemasPath: (directory.schemas_directory as JsonObject).path as string,
      schemaGlob: schemaFiles.glob as string,
      minimumSchemaFiles: schemaFiles.minimum_count as number,
    },
    entrySchema: { fields: { ...((data.ENTRY_SCHEMA as JsonObject).fields as Record<string, JsonObject>) } },
    entryRules,
    triggerPriorityRules: {
      required: Boolean(triggerPriority.required),
      allowedValues: [...(triggerPriority.allowed_values as string[])],
    },
    deprecationRules: entryRules.deprecation,
    groupPrefixes: { ...(data.GROUP_PREFIXES as Record<string, string>) },
    primitiveReferences: {
      protocolValuesAuthority: primitiveRefs.protocol_values_authority as string,
      fields: primitiveFields,
    },
    routeAliases: {
      routePrefix: routeAliases.route_prefix as string,
      canonicalNamePrecedence: Boolean(routeAliases.canonical_name_precedence),
      cliBoundary: routeAliases.cli_boundary as string,
      primaryAliases: (routeAliases.primary_aliases as JsonObject[]).map((entry) => ({
        alias: entry.alias as string,
        capability: entry.capability as string,
      })),
    },
    triggerEnrichment: buildTriggerEnrichmentRules(data),
  };
}

function buildTriggerEnrichmentRules(data: JsonObject): TriggerEnrichmentRules {
  const enrichment = data.TRIGGER_ENRICHMENT as JsonObject;
  const defaults = enrichment.contract_defaults as JsonObject;
  const fields = enrichment.fields as Record<string, JsonObject>;
  const primaryAliases = (data.ROUTE_ALIASES as JsonObject).primary_aliases as JsonObject[];
  const allowedCapabilityIds: string[] = primaryAliases.map((entry) => entry.capability as string);

  return {
    spec: enrichment.spec as string,
    contractDefaults: {
      confidenceThreshold: defaults.confidence_threshold as number,
      borderlineBand: defaults.borderline_band as number,
    },
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, raw]) => [name, buildEnrichmentFieldRule(raw)]),
    ),
    allowedCapabilityIds,
  };
}

function buildEnrichmentFieldRule(raw: JsonObject): TriggerEnrichmentFieldRule {
  const rule: {
    type: string;
    required: boolean;
    default: unknown;
    min?: number;
    max?: number;
    eachMustBeValidRegex?: boolean;
    entries?: Record<string, DisambiguateAgainstEntryRule>;
  } = {
    type: raw.type as string,
    required: Boolean(raw.required),
    default: raw.default,
  };
  if (typeof raw.min === "number") rule.min = raw.min;
  if (typeof raw.max === "number") rule.max = raw.max;
  if (raw.each_must_be_valid_regex === true) rule.eachMustBeValidRegex = true;
  if (isMapping(raw.entries)) {
    const entries: Record<string, DisambiguateAgainstEntryRule> = {};
    for (const [entryName, entryRaw] of Object.entries(raw.entries)) {
      const e = entryRaw as JsonObject;
      entries[entryName] = {
        type: e.type as string,
        required: Boolean(e.required),
        nonEmpty: e.non_empty === true,
        enumSource: typeof e.enum_source === "string" ? (e.enum_source as string) : "",
      };
    }
    rule.entries = entries;
  }
  return rule;
}

function requiredGroupsOf(data: JsonObject, sourceLabel: string, errors: string[]): string[] {
  const groups = data.REQUIRED_GROUPS;
  if (
    !Array.isArray(groups) ||
    groups.length === 0 ||
    !groups.every((group) => typeof group === "string" && group)
  ) {
    errors.push(
      `bootstrap [error]: REQUIRED_GROUPS in ${sourceLabel} must be a non-empty list of strings`,
    );
    return [];
  }
  return [...(groups as string[])];
}

function checkEntrySchema(data: JsonObject, sourceLabel: string, errors: string[]): void {
  const entrySchema = data.ENTRY_SCHEMA;
  if (!isMapping(entrySchema)) {
    errors.push(`bootstrap [error]: ENTRY_SCHEMA in ${sourceLabel} must be a mapping`);
    return;
  }
  const fields = entrySchema.fields;
  if (!isMapping(fields)) {
    errors.push(`bootstrap [error]: ENTRY_SCHEMA.fields in ${sourceLabel} must be a mapping`);
    return;
  }
  for (const fieldName of ["id", "description"]) {
    const fieldRule = fields[fieldName];
    if (!isMapping(fieldRule) || fieldRule.required !== true) {
      errors.push(
        `bootstrap [error]: ENTRY_SCHEMA.fields.${fieldName} in ${sourceLabel} must exist with required=true`,
      );
    }
  }
}

function checkGroupPrefixes(
  data: JsonObject,
  sourceLabel: string,
  requiredGroups: string[],
  errors: string[],
): void {
  const prefixes = data.GROUP_PREFIXES;
  if (!isMapping(prefixes)) {
    errors.push(`bootstrap [error]: GROUP_PREFIXES in ${sourceLabel} must be a mapping`);
    return;
  }
  for (const groupName of requiredGroups) {
    const prefix = prefixes[groupName];
    if (typeof prefix !== "string" || !prefix) {
      errors.push(
        `bootstrap [error]: GROUP_PREFIXES.${groupName} in ${sourceLabel} must be a non-empty string`,
      );
    }
  }
}

function checkRuleSections(data: JsonObject, sourceLabel: string, errors: string[]): void {
  for (const section of BOOTSTRAP_RULE_SECTIONS) {
    if (!isMapping(data[section])) {
      errors.push(`bootstrap [error]: ${section} in ${sourceLabel} must be present as a mapping`);
    }
  }
  checkDirectoryRules(data, sourceLabel, errors);
  checkEntryRules(data, sourceLabel, errors);
  checkTriggerPriorityRules(data, sourceLabel, errors);
  checkPrimitiveReferenceRules(data, sourceLabel, errors);
  checkRouteAliasRules(data, sourceLabel, errors);
  checkTriggerEnrichmentRules(data, sourceLabel, errors);
}

function checkDirectoryRules(data: JsonObject, sourceLabel: string, errors: string[]): void {
  const directory = data.DIRECTORY_REQUIREMENTS;
  if (!isMapping(directory)) {
    return;
  }
  for (const section of ["instruction_module", "schemas_directory", "schema_files"]) {
    if (!isMapping(directory[section])) {
      errors.push(
        `bootstrap [error]: DIRECTORY_REQUIREMENTS.${section} in ${sourceLabel} must be a mapping`,
      );
    }
  }
  if ("required_files" in directory) {
    errors.push(
      `bootstrap [error]: DIRECTORY_REQUIREMENTS.required_files in ${sourceLabel} duplicates instruction_module and schemas_directory authority`,
    );
  }
  const instructionModule = directory.instruction_module;
  if (isMapping(instructionModule)) {
    if (instructionModule.path !== "packages/cli/src/capabilities/<name>/instructions.ts") {
      errors.push(
        `bootstrap [error]: DIRECTORY_REQUIREMENTS.instruction_module.path in ${sourceLabel} must be packages/cli/src/capabilities/<name>/instructions.ts`,
      );
    }
    if (instructionModule.type !== "file") {
      errors.push(
        `bootstrap [error]: DIRECTORY_REQUIREMENTS.instruction_module.type in ${sourceLabel} must be file`,
      );
    }
    if (instructionModule.required !== true) {
      errors.push(
        `bootstrap [error]: DIRECTORY_REQUIREMENTS.instruction_module.required in ${sourceLabel} must be true`,
      );
    }
  }
  const schemaFiles = directory.schema_files;
  if (isMapping(schemaFiles)) {
    if (typeof schemaFiles.glob !== "string" || !schemaFiles.glob) {
      errors.push(
        `bootstrap [error]: DIRECTORY_REQUIREMENTS.schema_files.glob in ${sourceLabel} must be a non-empty string`,
      );
    }
    const minimumCount = schemaFiles.minimum_count;
    if (typeof minimumCount !== "number" || !Number.isInteger(minimumCount) || minimumCount < 1) {
      errors.push(
        `bootstrap [error]: DIRECTORY_REQUIREMENTS.schema_files.minimum_count in ${sourceLabel} must be a positive integer`,
      );
    }
  }
}

function checkEntryRules(data: JsonObject, sourceLabel: string, errors: string[]): void {
  const rules = data.ENTRY_REQUIREMENTS;
  if (!isMapping(rules)) {
    return;
  }
  if (!Array.isArray(rules.default_required_fields)) {
    errors.push(
      `bootstrap [error]: ENTRY_REQUIREMENTS.default_required_fields in ${sourceLabel} must be a list`,
    );
  }
  if (!isMapping(rules.groups)) {
    errors.push(`bootstrap [error]: ENTRY_REQUIREMENTS.groups in ${sourceLabel} must be a mapping`);
  }
  if (!isMapping(rules.deprecation)) {
    errors.push(
      `bootstrap [error]: ENTRY_REQUIREMENTS.deprecation in ${sourceLabel} must be a mapping`,
    );
  }
}

function checkTriggerPriorityRules(data: JsonObject, sourceLabel: string, errors: string[]): void {
  const fieldRules = data.FIELD_RULES;
  if (!isMapping(fieldRules)) {
    return;
  }
  const triggers = isMapping(fieldRules.TRIGGERS) ? fieldRules.TRIGGERS : {};
  const priority = (triggers as JsonObject).priority;
  if (!isMapping(priority)) {
    errors.push(
      `bootstrap [error]: FIELD_RULES.TRIGGERS.priority in ${sourceLabel} must be a mapping`,
    );
    return;
  }
  if (priority.required !== true) {
    errors.push(
      `bootstrap [error]: FIELD_RULES.TRIGGERS.priority.required in ${sourceLabel} must be true`,
    );
  }
  const allowed = priority.allowed_values;
  if (
    !Array.isArray(allowed) ||
    allowed.length === 0 ||
    !allowed.every((v) => typeof v === "string")
  ) {
    errors.push(
      `bootstrap [error]: FIELD_RULES.TRIGGERS.priority.allowed_values in ${sourceLabel} must be a non-empty list of strings`,
    );
  }
}

function checkPrimitiveReferenceRules(data: JsonObject, sourceLabel: string, errors: string[]): void {
  const primitiveRefs = data.PRIMITIVE_REFERENCE_FIELDS;
  if (!isMapping(primitiveRefs)) {
    return;
  }
  if (primitiveRefs.protocol_values_authority !== "protocol.yaml") {
    errors.push(
      `bootstrap [error]: PRIMITIVE_REFERENCE_FIELDS.protocol_values_authority in ${sourceLabel} must be protocol.yaml`,
    );
  }
  const fields = primitiveRefs.fields;
  if (!isMapping(fields)) {
    errors.push(
      `bootstrap [error]: PRIMITIVE_REFERENCE_FIELDS.fields in ${sourceLabel} must be a mapping`,
    );
    return;
  }
  for (const [fieldName, fieldRule] of Object.entries(fields)) {
    const protocolGroups = isMapping(fieldRule) ? fieldRule.protocol_groups : null;
    if (
      !Array.isArray(protocolGroups) ||
      protocolGroups.length === 0 ||
      !protocolGroups.every((group) => typeof group === "string" && group)
    ) {
      errors.push(
        `bootstrap [error]: PRIMITIVE_REFERENCE_FIELDS.fields.${fieldName}.protocol_groups in ${sourceLabel} must be a non-empty list of strings`,
      );
    }
  }
}

function checkRouteAliasRules(data: JsonObject, sourceLabel: string, errors: string[]): void {
  const aliases = data.ROUTE_ALIASES;
  if (!isMapping(aliases)) {
    return;
  }
  if (typeof aliases.route_prefix !== "string" || !aliases.route_prefix) {
    errors.push(
      `bootstrap [error]: ROUTE_ALIASES.route_prefix in ${sourceLabel} must be a non-empty string`,
    );
  }
  if (aliases.canonical_name_precedence !== true) {
    errors.push(
      `bootstrap [error]: ROUTE_ALIASES.canonical_name_precedence in ${sourceLabel} must be true`,
    );
  }
  if (typeof aliases.cli_boundary !== "string" || !aliases.cli_boundary) {
    errors.push(
      `bootstrap [error]: ROUTE_ALIASES.cli_boundary in ${sourceLabel} must be a non-empty string`,
    );
  }

  const primaryAliases = aliases.primary_aliases;
  if (!Array.isArray(primaryAliases) || primaryAliases.length === 0) {
    errors.push(
      `bootstrap [error]: ROUTE_ALIASES.primary_aliases in ${sourceLabel} must be a non-empty list`,
    );
    return;
  }

  const seenAliases = new Set<string>();
  const seenCapabilities = new Set<string>();
  primaryAliases.forEach((entry, idx) => {
    const index = idx + 1;
    if (!isMapping(entry)) {
      errors.push(
        `bootstrap [error]: ROUTE_ALIASES.primary_aliases[${index}] in ${sourceLabel} must be a mapping`,
      );
      return;
    }
    const alias = entry.alias;
    const capability = entry.capability;
    if (typeof alias !== "string" || !alias) {
      errors.push(
        `bootstrap [error]: ROUTE_ALIASES.primary_aliases[${index}].alias in ${sourceLabel} must be a non-empty string`,
      );
    } else if (seenAliases.has(alias)) {
      errors.push(
        `bootstrap [error]: ROUTE_ALIASES.primary_aliases alias '${alias}' in ${sourceLabel} must be unique`,
      );
    } else {
      seenAliases.add(alias);
    }
    if (typeof capability !== "string" || !capability) {
      errors.push(
        `bootstrap [error]: ROUTE_ALIASES.primary_aliases[${index}].capability in ${sourceLabel} must be a non-empty string`,
      );
    } else if (seenCapabilities.has(capability)) {
      errors.push(
        `bootstrap [error]: ROUTE_ALIASES.primary_aliases capability '${capability}' in ${sourceLabel} must be unique`,
      );
    } else {
      seenCapabilities.add(capability);
    }
  });
}

function checkSelfGroups(
  data: JsonObject,
  sourceLabel: string,
  requiredGroups: string[],
  errors: string[],
): void {
  for (const groupName of requiredGroups) {
    if (!(groupName in data)) {
      errors.push(`bootstrap [error]: self group ${groupName} missing in ${sourceLabel}`);
    } else if (!isMapping(data[groupName])) {
      errors.push(`bootstrap [error]: self group ${groupName} in ${sourceLabel} must be a mapping`);
    }
  }
}

/**
 * Required integer range field inside TRIGGER_ENRICHMENT (defaults and
 * per-field min/max). Used by both the contract_defaults and field-level
 * constraint checks below.
 */
function checkEnrichmentIntegerField(
  value: unknown,
  label: string,
  sourceLabel: string,
  errors: string[],
): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    errors.push(
      `bootstrap [error]: ${label} in ${sourceLabel} must be an integer in range 0..100`,
    );
  }
}

function checkTriggerEnrichmentRules(data: JsonObject, sourceLabel: string, errors: string[]): void {
  const enrichment = data.TRIGGER_ENRICHMENT;
  if (!isMapping(enrichment)) {
    errors.push(
      `bootstrap [error]: TRIGGER_ENRICHMENT in ${sourceLabel} must be present as a mapping`,
    );
    return;
  }
  if (typeof enrichment.spec !== "string" || !enrichment.spec) {
    errors.push(
      `bootstrap [error]: TRIGGER_ENRICHMENT.spec in ${sourceLabel} must be a non-empty string`,
    );
  }
  const defaults = enrichment.contract_defaults;
  if (!isMapping(defaults)) {
    errors.push(
      `bootstrap [error]: TRIGGER_ENRICHMENT.contract_defaults in ${sourceLabel} must be a mapping`,
    );
  } else {
    checkEnrichmentIntegerField(
      defaults.confidence_threshold,
      "TRIGGER_ENRICHMENT.contract_defaults.confidence_threshold",
      sourceLabel,
      errors,
    );
    checkEnrichmentIntegerField(
      defaults.borderline_band,
      "TRIGGER_ENRICHMENT.contract_defaults.borderline_band",
      sourceLabel,
      errors,
    );
  }

  const fields = enrichment.fields;
  if (!isMapping(fields)) {
    errors.push(`bootstrap [error]: TRIGGER_ENRICHMENT.fields in ${sourceLabel} must be a mapping`);
    return;
  }
  // The four canonical enrichment field names. Each must exist as a mapping
  // with the documented shape; the loader reads them faithfully.
  const expected: Record<string, string> = {
    confidence_threshold: "integer",
    borderline_band: "integer",
    patterns_regex: "list_of_strings",
    disambiguates_against: "list_of_mappings",
  };
  for (const [fieldName, expectedType] of Object.entries(expected)) {
    if (!isMapping(fields[fieldName])) {
      errors.push(
        `bootstrap [error]: TRIGGER_ENRICHMENT.fields.${fieldName} in ${sourceLabel} must be a mapping`,
      );
      continue;
    }
    if (fields[fieldName].type !== expectedType) {
      errors.push(
        `bootstrap [error]: TRIGGER_ENRICHMENT.fields.${fieldName}.type in ${sourceLabel} must be ${expectedType}`,
      );
    }
    if (fields[fieldName].required !== false) {
      errors.push(
        `bootstrap [error]: TRIGGER_ENRICHMENT.fields.${fieldName}.required in ${sourceLabel} must be false (enrichment is opt-in)`,
      );
    }
    const min = fields[fieldName].min;
    const max = fields[fieldName].max;
    if (expectedType === "integer") {
      if (typeof min !== "number" || min !== 0) {
        errors.push(
          `bootstrap [error]: TRIGGER_ENRICHMENT.fields.${fieldName}.min in ${sourceLabel} must be 0`,
        );
      }
      if (typeof max !== "number" || max !== 100) {
        errors.push(
          `bootstrap [error]: TRIGGER_ENRICHMENT.fields.${fieldName}.max in ${sourceLabel} must be 100`,
        );
      }
      checkEnrichmentIntegerField(
        fields[fieldName].default,
        `TRIGGER_ENRICHMENT.fields.${fieldName}.default`,
        sourceLabel,
        errors,
      );
    }
    if (expectedType === "list_of_strings" && fields[fieldName].each_must_be_valid_regex !== true) {
      errors.push(
        `bootstrap [error]: TRIGGER_ENRICHMENT.fields.${fieldName}.each_must_be_valid_regex in ${sourceLabel} must be true`,
      );
    }
  }

  // disambiguates_against.entries capability/hint shape
  const disambig = isMapping(fields.disambiguates_against) ? fields.disambiguates_against : null;
  const entriesList = disambig && isMapping(disambig.entries) ? disambig.entries : null;
  if (disambig && !entriesList) {
    errors.push(
      `bootstrap [error]: TRIGGER_ENRICHMENT.fields.disambiguates_against.entries in ${sourceLabel} must be a mapping`,
    );
  }
  if (entriesList) {
    if (!isMapping(entriesList.capability)) {
      errors.push(
        `bootstrap [error]: TRIGGER_ENRICHMENT.fields.disambiguates_against.entries.capability in ${sourceLabel} must be a mapping`,
      );
    } else {
      if (entriesList.capability.required !== true) {
        errors.push(
          `bootstrap [error]: TRIGGER_ENRICHMENT.fields.disambiguates_against.entries.capability.required in ${sourceLabel} must be true`,
        );
      }
      if (entriesList.capability.enum_source !== "ROUTE_ALIASES.primary_aliases.capability") {
        errors.push(
          `bootstrap [error]: TRIGGER_ENRICHMENT.fields.disambiguates_against.entries.capability.enum_source in ${sourceLabel} must be ROUTE_ALIASES.primary_aliases.capability`,
        );
      }
    }
    if (!isMapping(entriesList.hint)) {
      errors.push(
        `bootstrap [error]: TRIGGER_ENRICHMENT.fields.disambiguates_against.entries.hint in ${sourceLabel} must be a mapping`,
      );
    } else {
      if (entriesList.hint.required !== true) {
        errors.push(
          `bootstrap [error]: TRIGGER_ENRICHMENT.fields.disambiguates_against.entries.hint.required in ${sourceLabel} must be true`,
        );
      }
      if (entriesList.hint.non_empty !== true) {
        errors.push(
          `bootstrap [error]: TRIGGER_ENRICHMENT.fields.disambiguates_against.entries.hint.non_empty in ${sourceLabel} must be true`,
        );
      }
    }
  }
}

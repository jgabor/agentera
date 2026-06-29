import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import type { CapabilitySchemaContract } from "./capabilityContract.js";

/**
 * Trigger schema loader. Reads the twelve
 * `skills/agentera/capabilities/<name>/schemas/triggers.yaml` files into a
 * typed runtime model the Layer 3-4 routing engine consumes. Applies the
 * TRIGGER_ENRICHMENT contract defaults for absent fields and compiles
 * `patterns_regex` entries into real RegExp objects.
 *
 * Spec: references/cli/trigger-schema-enrichment.md
 * Contract: skills/agentera/capability_schema_contract.yaml (TRIGGER_ENRICHMENT)
 */

export interface DisambiguationEntry {
  readonly capability: string;
  readonly hint: string;
}

export interface CompiledTriggerEntry {
  readonly id: string;
  readonly description: string;
  readonly priority: "high" | "medium" | "low";
  readonly patterns: readonly string[];
  readonly patternsRegex: readonly RegExp[];
  readonly confidenceThreshold: number;
  readonly disambiguatesAgainst: readonly DisambiguationEntry[];
  readonly borderlineBand: number;
  readonly fallback: boolean;
}

export interface CompiledCapabilityTriggers {
  readonly capability: string;
  readonly triggers: readonly CompiledTriggerEntry[];
}

export interface TriggerModel {
  readonly capabilities: ReadonlyMap<string, CompiledCapabilityTriggers>;
}

export class TriggerLoaderError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "TriggerLoaderError";
    this.errors = errors;
  }
}

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNumericKey(key: string): boolean {
  return /^\d+$/.test(key) && Number(key) >= 1;
}

/** Absolute directory holding the Agentera capability schemas. */
export function capabilitiesBaseDir(sourceRoot: string = resolveSourceRoot()): string {
  return path.join(sourceRoot, "skills", "agentera", "capabilities");
}

/** Absolute path to a capability's triggers.yaml. */
export function triggersYamlPath(capability: string, sourceRoot: string = resolveSourceRoot()): string {
  return path.join(capabilitiesBaseDir(sourceRoot), capability, "schemas", "triggers.yaml");
}

function readTriggersYaml(filePath: string): JsonObject {
  if (!fs.existsSync(filePath)) {
    throw new TriggerLoaderError([`triggers.yaml not found at ${filePath}`]);
  }
  return loadYamlMapping(fs.readFileSync(filePath, "utf8")) as JsonObject; // cast: YAML parse IO boundary
}

function asStringArray(value: unknown, location: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new TriggerLoaderError([`${location} must be a list of strings`]);
  }
  return [...(value as string[])];
}

function compileRegexPatterns(patterns: readonly string[], location: string): RegExp[] {
  const compiled: RegExp[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const source = patterns[i];
    try {
      compiled.push(new RegExp(source, "i"));
    } catch (exc) {
      throw new TriggerLoaderError([
        `${location} patterns_regex[${i}]=${JSON.stringify(source)} is not a valid regular expression: ${
          (exc as Error).message
        }`,
      ]);
    }
  }
  return compiled;
}

function resolveDisambiguation(
  value: unknown,
  location: string,
  allowedCapabilityIds: readonly string[],
): DisambiguationEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TriggerLoaderError([
      `${location} disambiguates_against must be a list of mappings`,
    ]);
  }
  const entries: DisambiguationEntry[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isMapping(item)) {
      throw new TriggerLoaderError([
        `${location} disambiguates_against[${i}] must be a mapping with 'capability' and 'hint'`,
      ]);
    }
    const capability = item.capability;
    if (typeof capability !== "string" || !capability) {
      throw new TriggerLoaderError([
        `${location} disambiguates_against[${i}] missing 'capability' (must be one of: ${allowedCapabilityIds.join(", ")})`,
      ]);
    }
    if (!allowedCapabilityIds.includes(capability)) {
      throw new TriggerLoaderError([
        `${location} disambiguates_against[${i}].capability=${JSON.stringify(capability)} is not a canonical capability ID (must be one of: ${allowedCapabilityIds.join(", ")})`,
      ]);
    }
    const hint = item.hint;
    if (typeof hint !== "string" || hint.trim() === "") {
      throw new TriggerLoaderError([
        `${location} disambiguates_against[${i}] missing or empty 'hint' (must be a non-empty string)`,
      ]);
    }
    entries.push({ capability, hint });
  }
  return entries;
}

function buildTriggerEntry(
  key: string,
  raw: JsonObject,
  capability: string,
  contract: CapabilitySchemaContract,
): CompiledTriggerEntry {
  const enrichment = contract.triggerEnrichment;
  const location = `TRIGGERS entry ${key} in ${capability}/schemas/triggers.yaml`;

  const id = raw.id;
  if (typeof id !== "string" || !id) {
    throw new TriggerLoaderError([`${location} missing 'id'`]);
  }
  const description = raw.description;
  if (typeof description !== "string" || description.trim() === "") {
    throw new TriggerLoaderError([`${location} missing 'description'`]);
  }
  const priorityRaw = raw.priority;
  if (
    typeof priorityRaw !== "string" ||
    !contract.triggerPriorityRules.allowedValues.includes(priorityRaw)
  ) {
    throw new TriggerLoaderError([
      `${location} has invalid priority=${JSON.stringify(priorityRaw)} (must be one of: ${contract.triggerPriorityRules.allowedValues.join(", ")})`,
    ]);
  }
  const priority = priorityRaw as "high" | "medium" | "low";

  const patterns = asStringArray(raw.patterns, `${location} patterns`);

  const patternsRegexSources = asStringArray(raw.patterns_regex, `${location} patterns_regex`);
  const patternsRegex = compileRegexPatterns(patternsRegexSources, location);

  const confidenceThreshold =
    typeof raw.confidence_threshold === "number" && Number.isInteger(raw.confidence_threshold)
      ? raw.confidence_threshold
      : (enrichment.fields.confidence_threshold.default as number);
  const borderlineBand =
    typeof raw.borderline_band === "number" && Number.isInteger(raw.borderline_band)
      ? raw.borderline_band
      : (enrichment.fields.borderline_band.default as number);

  const disambiguatesAgainst = resolveDisambiguation(
    raw.disambiguates_against,
    location,
    enrichment.allowedCapabilityIds,
  );

  const fallback = raw.fallback === true;

  return {
    id,
    description,
    priority,
    patterns,
    patternsRegex,
    confidenceThreshold,
    disambiguatesAgainst,
    borderlineBand,
    fallback,
  };
}

function buildCapabilityTriggers(
  capability: string,
  contract: CapabilitySchemaContract,
  sourceRoot: string,
): CompiledCapabilityTriggers {
  const filePath = triggersYamlPath(capability, sourceRoot);
  const data = readTriggersYaml(filePath);
  const triggersGroup = data.TRIGGERS;
  if (!isMapping(triggersGroup)) {
    throw new TriggerLoaderError([
      `${capability}/schemas/triggers.yaml is missing the TRIGGERS group`,
    ]);
  }

  const triggers: CompiledTriggerEntry[] = [];
  for (const key of Object.keys(triggersGroup)) {
    if (!isNumericKey(key)) {
      throw new TriggerLoaderError([
        `${capability}/schemas/triggers.yaml has non-numeric key ${JSON.stringify(key)} in TRIGGERS`,
      ]);
    }
    const entry = (triggersGroup as JsonObject)[key];
    if (!isMapping(entry)) {
      throw new TriggerLoaderError([
        `TRIGGERS entry ${key} in ${capability}/schemas/triggers.yaml is not a mapping`,
      ]);
    }
    triggers.push(buildTriggerEntry(key, entry, capability, contract));
  }

  return { capability, triggers };
}

/**
 * Load all twelve capability triggers.yaml files into a typed TriggerModel.
 * The capability set is the ROUTE_ALIASES.primary_aliases list owned by the
 * capability schema contract. Enrichment defaults are applied for absent
 * fields; `disambiguates_against.capability` references are validated against
 * the canonical capability IDs and each must resolve to a capability present
 * in the returned model.
 */
export function loadTriggerModel(
  contract: CapabilitySchemaContract,
  options: { sourceRoot?: string } = {},
): TriggerModel {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const capabilities = contract.routeAliases.primaryAliases.map((alias) => alias.capability);

  const errors: string[] = [];
  const model = new Map<string, CompiledCapabilityTriggers>();

  for (const capability of capabilities) {
    try {
      model.set(capability, buildCapabilityTriggers(capability, contract, sourceRoot));
    } catch (exc) {
      if (exc instanceof TriggerLoaderError) {
        errors.push(...exc.errors);
      } else {
        throw exc;
      }
    }
  }

  if (errors.length > 0) {
    throw new TriggerLoaderError(errors);
  }

  // Resolve disambiguates_against references: each capability referenced must
  // resolve to a capability present in the model with at least one trigger.
  const resolutionErrors: string[] = [];
  for (const { capability, triggers } of model.values()) {
    for (const entry of triggers) {
      for (const ref of entry.disambiguatesAgainst) {
        const referenced = model.get(ref.capability);
        if (!referenced) {
          resolutionErrors.push(
            `TRIGGERS entry ${entry.id} in ${capability}/schemas/triggers.yaml disambiguates_against.capability=${JSON.stringify(ref.capability)} does not resolve to a loaded capability`,
          );
        } else if (referenced.triggers.length === 0) {
          resolutionErrors.push(
            `TRIGGERS entry ${entry.id} in ${capability}/schemas/triggers.yaml disambiguates_against.capability=${JSON.stringify(ref.capability)} resolves to a capability with no trigger entries`,
          );
        }
      }
    }
  }
  if (resolutionErrors.length > 0) {
    throw new TriggerLoaderError(resolutionErrors);
  }

  return { capabilities: model };
}

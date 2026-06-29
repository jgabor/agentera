import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import {
  CapabilitySchemaContract,
  loadCapabilitySchemaContract,
} from "../registries/capabilityContract.js";

/**
 * Validate a capability directory against the capability schema contract.
 * Faithful TS port of scripts/validate_capability.py.
 *
 * Note: YAML integer keys (`1:`) parse to JS string keys ("1"); numeric-key
 * detection uses a digit regex, which matches Python's `isinstance(key, int)`
 * for all real (bare-integer) schema keys.
 */

export const PROTOCOL_GROUPS = [
  "CONFIDENCE_SCALE",
  "SEVERITY_FINDING",
  "SEVERITY_ISSUE",
  "SEVERITY_MAPPING",
  "DECISION_LABELS",
  "EXIT_SIGNALS",
  "VISUAL_TOKENS",
  "SKILL_GLYPHS",
  "PHASES",
] as const;

export { loadCapabilitySchemaContract };

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when a YAML key string represents a positive integer (`>= 1`). */
function isNumericKey(key: string): boolean {
  return /^\d+$/.test(key) && Number(key) >= 1;
}

/** Render a key for diagnostics roughly like Python repr: bare for ints, quoted otherwise. */
function keyRepr(key: string): string {
  return /^-?\d+(?:\.\d+)?$/.test(key) ? key : `'${key}'`;
}

function valueRepr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    return `'${value}'`;
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return String(value);
}

function pyListRepr(values: readonly string[]): string {
  return "[" + values.map((v) => `'${v}'`).join(", ") + "]";
}

export function loadContract(contractPath: string): JsonObject {
  return loadYamlMapping(fs.readFileSync(contractPath, "utf8")) as JsonObject; // cast: YAML parse IO boundary
}

export function loadSchemaFile(p: string): JsonObject {
  return loadYamlMapping(fs.readFileSync(p, "utf8")) as JsonObject; // cast: YAML parse IO boundary
}

export function loadProtocol(protocolPath: string): JsonObject {
  return loadYamlMapping(fs.readFileSync(protocolPath, "utf8")) as JsonObject; // cast: YAML parse IO boundary
}

function listSchemaFiles(schemasDir: string, glob: string): string[] {
  // Agentera schema globs are always "*.yaml"; match on suffix.
  const suffix = glob.replace(/^\*/, "");
  if (!fs.existsSync(schemasDir) || !fs.statSync(schemasDir).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(schemasDir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => path.join(schemasDir, name));
}

export function collectSchemaGroups(
  schemasDir: string,
  requiredGroups: readonly string[],
  schemaGlob = "*.yaml",
): JsonObject {
  const combined: JsonObject = {};
  for (const yamlFile of listSchemaFiles(schemasDir, schemaGlob)) {
    const data = loadSchemaFile(yamlFile);
    for (const [groupName, groupData] of Object.entries(data)) {
      if (requiredGroups.includes(groupName)) {
        if (!(groupName in combined)) {
          combined[groupName] = {};
        }
        if (isMapping(groupData)) {
          Object.assign(combined[groupName] as JsonObject, groupData); // cast: parsed schema IO data
        }
      }
    }
  }
  return combined;
}

export function checkDirectoryStructure(capDir: string, contract: CapabilitySchemaContract): string[] {
  const errors: string[] = [];
  const directoryRules = contract.directoryRules;
  const schemas = path.join(capDir, directoryRules.schemasPath);
  // The instruction module path is a repo-relative path under
  // packages/cli/src/capabilities/<name>/instructions.ts (D65). Resolve the
  // capability name from the capDir (last path segment) and look up the
  // module against the resolved Agentera source root, not the capDir.
  const capabilityName = path.basename(capDir);
  const instructionModulePath = (directoryRules.instructionModulePath ?? directoryRules.instructionPath).replace(
    /<name>/g,
    capabilityName,
  );
  const sourceRoot = resolveSourceRoot();
  const instructionModuleAbs = path.join(sourceRoot, instructionModulePath);
  const isFile = fs.existsSync(instructionModuleAbs) && fs.statSync(instructionModuleAbs).isFile();
  if (!isFile) {
    errors.push(`V1 [error]: ${instructionModulePath} not found in ${capDir}`);
  }
  const isDir = fs.existsSync(schemas) && fs.statSync(schemas).isDirectory();
  if (!isDir) {
    errors.push(`V1 [error]: ${directoryRules.schemasPath}/ directory not found in ${capDir}`);
  } else if (listSchemaFiles(schemas, directoryRules.schemaGlob).length < directoryRules.minimumSchemaFiles) {
    errors.push(`V1 [error]: ${directoryRules.schemasPath}/ contains no .yaml files in ${capDir}`);
  }
  return errors;
}

export function checkRequiredGroups(
  groups: JsonObject,
  sourceLabel: string,
  contract: CapabilitySchemaContract,
): string[] {
  const errors: string[] = [];
  for (const rg of contract.requiredGroups) {
    if (!(rg in groups)) {
      errors.push(`V2 [error]: required group ${rg} missing in ${sourceLabel}`);
    }
  }
  return errors;
}

export function checkNumberedEntries(
  groups: JsonObject,
  sourceLabel: string,
  contract: CapabilitySchemaContract,
): string[] {
  const errors: string[] = [];
  for (const [groupName, entries] of Object.entries(groups)) {
    if (!contract.requiredGroups.includes(groupName)) {
      continue;
    }
    if (!isMapping(entries)) {
      errors.push(`V3 [error]: ${groupName} in ${sourceLabel} is not a mapping`);
      continue;
    }
    for (const key of Object.keys(entries)) {
      if (!isNumericKey(key)) {
        errors.push(`V3 [error]: non-numeric key ${keyRepr(key)} in ${groupName} in ${sourceLabel}`);
      }
    }
  }
  return errors;
}

export function checkStableIds(
  groups: JsonObject,
  sourceLabel: string,
  contract: CapabilitySchemaContract,
): string[] {
  const errors: string[] = [];
  for (const [groupName, entries] of Object.entries(groups)) {
    if (!contract.requiredGroups.includes(groupName)) {
      continue;
    }
    if (!isMapping(entries)) {
      continue;
    }
    const requiredFields =
      contract.entryRules.requiredFieldsByGroup[groupName] ?? contract.entryRules.defaultRequiredFields;
    for (const [key, entry] of Object.entries(entries)) {
      if (!isMapping(entry)) {
        errors.push(`V4 [error]: entry ${key} in ${groupName} in ${sourceLabel} is not a mapping`);
        continue;
      }
      for (const fieldName of requiredFields) {
        if (groupName === "TRIGGERS" && fieldName === "priority") {
          continue;
        }
        if (!(fieldName in entry)) {
          errors.push(`V4 [error]: entry ${key} in ${groupName} in ${sourceLabel} missing '${fieldName}'`);
        }
      }
    }
  }
  return errors;
}

export function checkTriggerPriorities(
  groups: JsonObject,
  sourceLabel: string,
  contract: CapabilitySchemaContract,
): string[] {
  const errors: string[] = [];
  const triggers = groups.TRIGGERS ?? {};
  if (!isMapping(triggers)) {
    return errors;
  }
  const priorityRules = contract.triggerPriorityRules;
  for (const [key, entry] of Object.entries(triggers)) {
    if (!isMapping(entry)) {
      continue;
    }
    const priority = entry.priority ?? null;
    if (priority === null && priorityRules.required) {
      errors.push(`V5b [error]: TRIGGERS entry ${key} in ${sourceLabel} missing 'priority'`);
    } else if (priority !== null && !priorityRules.allowedValues.includes(priority as string)) { // cast: parsed schema IO data
      errors.push(
        `V5b [error]: TRIGGERS entry ${key} in ${sourceLabel} has invalid priority=${valueRepr(priority)} ` +
          `(must be one of: ${priorityRules.allowedValues.join(", ")})`,
      );
    }
  }
  return errors;
}

/**
 * V7 trigger-entry enrichment validation. Enforces the four optional fields
 * declared in TRIGGER_ENRICHMENT in capability_schema_contract.yaml. Every
 * field is OPTIONAL; a triggers.yaml entry that omits all enriched fields
 * passes (backward compatibility per spec §6). Error messages include the
 * valid range/value and the offending entry ID so authors can locate the
 * violation without grepping the contract.
 */
export function checkTriggerEnrichment(
  groups: JsonObject,
  sourceLabel: string,
  contract: CapabilitySchemaContract,
): string[] {
  const errors: string[] = [];
  const triggers = groups.TRIGGERS ?? {};
  if (!isMapping(triggers)) {
    return errors;
  }
  const enrichment = contract.triggerEnrichment;
  const confidenceField = enrichment.fields.confidence_threshold;
  const borderlineField = enrichment.fields.borderline_band;
  const allowedIds = enrichment.allowedCapabilityIds;

  for (const [key, entry] of Object.entries(triggers)) {
    if (!isMapping(entry)) {
      continue;
    }
    const entryId = entry.id ?? key;
    const location = `TRIGGERS entry ${key} (${entryId}) in ${sourceLabel}`;

    if (entry.confidence_threshold !== undefined) {
      const value = entry.confidence_threshold;
      const min = confidenceField.min ?? 0;
      const max = confidenceField.max ?? 100;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < min ||
        value > max
      ) {
        errors.push(
          `V7 [error]: ${location} has confidence_threshold=${valueRepr(value)} ` +
            `(must be an integer in range ${min}..${max})`,
        );
      }
    }

    if (entry.borderline_band !== undefined) {
      const value = entry.borderline_band;
      const min = borderlineField.min ?? 0;
      const max = borderlineField.max ?? 100;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < min ||
        value > max
      ) {
        errors.push(
          `V7 [error]: ${location} has borderline_band=${valueRepr(value)} ` +
            `(must be an integer in range ${min}..${max})`,
        );
      }
    }

    if (entry.patterns_regex !== undefined) {
      const value = entry.patterns_regex;
      if (!Array.isArray(value)) {
        errors.push(
          `V7 [error]: ${location} has patterns_regex=${valueRepr(value)} ` +
            `(must be a list of regex strings)`,
        );
      } else {
        for (let i = 0; i < value.length; i++) {
          const pattern = value[i];
          if (typeof pattern !== "string") {
            errors.push(
              `V7 [error]: ${location} patterns_regex[${i}] is not a string`,
            );
            continue;
          }
          try {
            new RegExp(pattern);
          } catch {
            errors.push(
              `V7 [error]: ${location} patterns_regex[${i}]=${valueRepr(pattern)} ` +
                `is not a valid regular expression`,
            );
          }
        }
      }
    }

    if (entry.disambiguates_against !== undefined) {
      const value = entry.disambiguates_against;
      if (!Array.isArray(value)) {
        errors.push(
          `V7 [error]: ${location} has disambiguates_against=${valueRepr(value)} ` +
            `(must be a list of mappings each with 'capability' and 'hint')`,
        );
        continue;
      }
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (!isMapping(item)) {
          errors.push(
            `V7 [error]: ${location} disambiguates_against[${i}] must be a mapping with 'capability' and 'hint'`,
          );
          continue;
        }
        const capability = item.capability;
        if (typeof capability !== "string" || !capability) {
          errors.push(
            `V7 [error]: ${location} disambiguates_against[${i}] missing 'capability' ` +
              `(must be one of: ${allowedIds.join(", ")})`,
          );
        } else if (!allowedIds.includes(capability)) {
          errors.push(
            `V7 [error]: ${location} disambiguates_against[${i}].capability=${valueRepr(capability)} ` +
              `is not a canonical capability ID (must be one of: ${allowedIds.join(", ")})`,
          );
        }
        const hint = item.hint;
        if (typeof hint !== "string" || hint.trim() === "") {
          errors.push(
            `V7 [error]: ${location} disambiguates_against[${i}] missing or empty 'hint' ` +
              `(must be a non-empty string distinguishing this trigger from the named capability)`,
          );
        }
      }
    }
  }
  return errors;
}

export function checkDeprecation(
  groups: JsonObject,
  sourceLabel: string,
  contract: CapabilitySchemaContract,
): string[] {
  const warnings: string[] = [];
  const markerField = contract.deprecationRules.marker_field as string;
  const markerValue = contract.deprecationRules.marker_value;
  const replacementField = contract.deprecationRules.replacement_field as string;
  const replacementTarget = contract.deprecationRules.replacement_target_field as string;
  for (const [groupName, entries] of Object.entries(groups)) {
    if (!contract.requiredGroups.includes(groupName)) {
      continue;
    }
    if (!isMapping(entries)) {
      continue;
    }
    const validIds = new Set<unknown>();
    for (const entry of Object.values(entries)) {
      if (isMapping(entry) && replacementTarget in entry) {
        validIds.add(entry[replacementTarget]);
      }
    }
    for (const [key, entry] of Object.entries(entries)) {
      if (!isMapping(entry)) {
        continue;
      }
      if (entry[markerField] === markerValue) {
        const replaced = entry[replacementField];
        if (!replaced) {
          warnings.push(
            `V5 [warning]: entry ${key} (${entry.id ?? "?"}) ` +
              `in ${groupName} in ${sourceLabel} is deprecated but has no ${replacementField}`,
          );
        } else if (!validIds.has(replaced)) {
          warnings.push(
            `V5 [warning]: entry ${key} (${entry.id ?? "?"}) ` +
              `in ${groupName} in ${sourceLabel} has ${replacementField}=${valueRepr(replaced)} ` +
              `which does not match any entry ID`,
          );
        }
      }
    }
  }
  return warnings;
}

export function validateContractSelf(contractPath: string): string[] {
  const contract = loadCapabilitySchemaContract(contractPath);
  const data = loadContract(contractPath);
  const errors: string[] = [];

  const groups: JsonObject = {};
  for (const groupName of contract.requiredGroups) {
    if (groupName in data && isMapping(data[groupName])) {
      groups[groupName] = data[groupName];
    }
  }

  errors.push(...checkRequiredGroups(groups, contractPath, contract));
  errors.push(...checkNumberedEntries(groups, contractPath, contract));
  errors.push(...checkStableIds(groups, contractPath, contract));
  errors.push(...checkTriggerPriorities(groups, contractPath, contract));
  errors.push(...checkTriggerEnrichment(groups, contractPath, contract));

  for (const w of checkDeprecation(groups, contractPath, contract)) {
    process.stderr.write(w + "\n");
  }

  return errors;
}

export function validateCapability(capDir: string, contractPath: string): string[] {
  const contract = loadCapabilitySchemaContract(contractPath);
  const allErrors: string[] = [];

  allErrors.push(...checkDirectoryStructure(capDir, contract));

  const schemasDir = path.join(capDir, contract.directoryRules.schemasPath);
  if (fs.existsSync(schemasDir) && fs.statSync(schemasDir).isDirectory()) {
    const groups = collectSchemaGroups(
      schemasDir,
      contract.requiredGroups,
      contract.directoryRules.schemaGlob,
    );
    allErrors.push(...checkRequiredGroups(groups, capDir, contract));
    allErrors.push(...checkNumberedEntries(groups, capDir, contract));
    allErrors.push(...checkStableIds(groups, capDir, contract));
    allErrors.push(...checkTriggerPriorities(groups, capDir, contract));
    allErrors.push(...checkTriggerEnrichment(groups, capDir, contract));

    for (const w of checkDeprecation(groups, capDir, contract)) {
      process.stderr.write(w + "\n");
    }
  }

  return allErrors;
}

export function buildProtocolValueLookup(protocolData: JsonObject): Record<string, Set<string>> {
  const lookup: Record<string, Set<string>> = {};
  for (const groupName of PROTOCOL_GROUPS) {
    const group = protocolData[groupName];
    if (!isMapping(group)) {
      continue;
    }
    const values = new Set<string>();
    for (const [key, entry] of Object.entries(group)) {
      if (!isNumericKey(key) || !isMapping(entry)) {
        continue;
      }
      if ("value" in entry) {
        values.add(entry.value as string); // cast: parsed protocol IO data
      }
    }
    if (values.size > 0) {
      lookup[groupName] = values;
    }
  }
  return lookup;
}

export function checkProtocolStructure(protocolData: JsonObject, sourceLabel: string): string[] {
  const errors: string[] = [];
  const prefixes = protocolData.GROUP_PREFIXES ?? {};
  if (!isMapping(prefixes)) {
    errors.push(`[error]: GROUP_PREFIXES missing or not a mapping in ${sourceLabel}`);
    return errors;
  }

  for (const groupName of PROTOCOL_GROUPS) {
    const group = protocolData[groupName];
    if (!isMapping(group)) {
      errors.push(`[error]: group ${groupName} missing in ${sourceLabel}`);
      continue;
    }

    const expectedPrefix = (prefixes[groupName] ?? "") as string; // cast: parsed protocol IO data
    const validIds = new Set<string>();
    for (const [key, entry] of Object.entries(group)) {
      if (!isNumericKey(key)) {
        continue;
      }
      if (!isMapping(entry)) {
        errors.push(`[error]: entry ${key} in ${groupName} is not a mapping`);
        continue;
      }
      if (!("id" in entry)) {
        errors.push(`[error]: entry ${key} in ${groupName} missing 'id'`);
      } else {
        const eid = entry.id as string;
        if (expectedPrefix && !eid.startsWith(expectedPrefix)) {
          errors.push(
            `[error]: entry ${key} id=${valueRepr(eid)} in ${groupName} ` +
              `does not match prefix ${valueRepr(expectedPrefix)}`,
          );
        }
        validIds.add(eid);
      }
    }

    for (const [key, entry] of Object.entries(group)) {
      if (!isNumericKey(key) || !isMapping(entry)) {
        continue;
      }
      if (entry.deprecated) {
        const replaced = entry.replaced_by;
        if (!replaced) {
          errors.push(
            `[warning]: entry ${key} (${entry.id ?? "?"}) ` +
              `in ${groupName} is deprecated but has no replaced_by`,
          );
        } else if (!validIds.has(replaced as string)) { // cast: parsed protocol IO data
          errors.push(
            `[warning]: entry ${key} (${entry.id ?? "?"}) ` +
              `in ${groupName} has replaced_by=${valueRepr(replaced)} ` +
              `which does not match any entry ID`,
          );
        }
      }
    }
  }

  return errors;
}

export function checkPhaseTransitions(protocolData: JsonObject, sourceLabel: string): string[] {
  const errors: string[] = [];
  void sourceLabel;
  const phasesGroup = protocolData.PHASES;
  if (!isMapping(phasesGroup)) {
    return errors;
  }

  const phaseValues = new Set<string>();
  for (const [key, entry] of Object.entries(phasesGroup)) {
    if (isNumericKey(key) && isMapping(entry) && "value" in entry) {
      phaseValues.add(entry.value as string); // cast: parsed protocol IO data
    }
  }

  for (const [key, entry] of Object.entries(phasesGroup)) {
    if (!isNumericKey(key) || !isMapping(entry)) {
      continue;
    }
    const successors = (entry.valid_successors ?? []) as string[]; // cast: parsed protocol IO data
    const entryId = entry.id ?? `entry ${key}`;
    for (const s of successors) {
      if (!phaseValues.has(s)) {
        errors.push(
          `[error]: ${entryId} in PHASES has valid_successors entry ` +
            `${valueRepr(s)} which is not a defined phase value`,
        );
      }
    }
    if (entry.self_transition && !successors.includes(entry.value as string)) {
      errors.push(
        `[error]: ${entryId} in PHASES has self_transition=true ` +
          `but ${valueRepr(entry.value)} not in valid_successors`,
      );
    }
  }

  return errors;
}

export function validateProtocolSelf(protocolPath: string): string[] {
  const data = loadProtocol(protocolPath);
  const errors: string[] = [];
  errors.push(...checkProtocolStructure(data, protocolPath));
  errors.push(...checkPhaseTransitions(data, protocolPath));
  return errors;
}

export function checkPrimitiveReferences(
  capDir: string,
  protocolPath: string,
  contractPath = "skills/agentera/capability_schema_contract.yaml",
): string[] {
  const contract = loadCapabilitySchemaContract(contractPath);
  const protocolData = loadProtocol(protocolPath);
  const lookup = buildProtocolValueLookup(protocolData);
  const errors: string[] = [];

  const schemasDir = path.join(capDir, "schemas");
  if (!fs.existsSync(schemasDir) || !fs.statSync(schemasDir).isDirectory()) {
    return errors;
  }

  for (const yamlFile of listSchemaFiles(schemasDir, "*.yaml")) {
    const data = loadSchemaFile(yamlFile);
    for (const [groupName, groupData] of Object.entries(data)) {
      if (!isMapping(groupData)) {
        continue;
      }
      for (const [key, entry] of Object.entries(groupData)) {
        if (!isNumericKey(key) || !isMapping(entry)) {
          continue;
        }
        const entryId = entry.id ?? `${groupName}.${key}`;
        for (const [fieldName, protocolGroups] of Object.entries(contract.primitiveReferences.fields)) {
          if (!(fieldName in entry)) {
            continue;
          }
          const value = entry[fieldName];
          const valuesToCheck = Array.isArray(value) ? value : [value];
          for (const v of valuesToCheck) {
            let resolved = false;
            for (const pg of protocolGroups) {
              if (pg in lookup && lookup[pg].has(v as string)) { // cast: parsed schema/protocol IO data
                resolved = true;
                break;
              }
            }
            if (!resolved) {
              errors.push(
                `[error]: ${entryId} field ${fieldName}=${valueRepr(v)} ` +
                  `does not resolve to any protocol primitive ` +
                  `in groups ${pyListRepr(protocolGroups)}`,
              );
            }
          }
        }
      }
    }
  }

  return errors;
}

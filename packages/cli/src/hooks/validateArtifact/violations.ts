/**
 * YAML-side violation orchestrators.
 *
 * `validateYamlContent` is the single entry point: parse, walk the
 * schema singleton groups, run sequence validation, apply artifact-
 * specific rules (plan, decisions), and finally run BUDGET and
 * VALIDATION_RULES checks. Lower-level helpers live in `schema.ts`.
 */

import path from "node:path";

import { parseYaml } from "../../core/yaml.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { loadYamlMapping } from "../../core/yaml.js";
import {
  expectedSequenceOrder,
  isEmptyRequired,
  isMapping,
  schemaFieldNames,
  sequenceInOrder,
  validationRuleSeverity,
  validateDecisionAlternatives,
  validateDecisionSatisfaction,
  validateField,
  validateFullPlanContract,
  validatePlanKnownFields,
  validateSequences,
  validateSingletonGroup,
  collectSingletonGroups,
  wordCount,
} from "./schema.js";

import type { JsonObject } from "../../core/jsonValue.js";

function schemasDirDefault(): string {
  return path.join(resolveSourceRoot(), "skills", "agentera", "schemas", "artifacts");
}

export function validateYamlContent(content: string, schema: JsonObject, name: string): string[] {
  const violations: string[] = [];
  let data: unknown;
  try {
    data = parseYaml(content);
  } catch (exc) {
    return [`${name}: invalid YAML: ${(exc as Error).message}`];
  }
  if (!isMapping(data)) {
    return [`${name}: root must be a mapping`];
  }
  for (const [group, groupLower, fields] of collectSingletonGroups(schema)) {
    let scope: JsonObject;
    if (groupLower in data && isMapping(data[groupLower])) {
      scope = data[groupLower];
    } else if (fields.some((f) => f in data)) {
      scope = data as JsonObject;
    } else {
      continue;
    }
    validateSingletonGroup(violations, name, schema, group, scope, groupLower);
  }
  if (name === "plan") {
    validatePlanKnownFields(data as JsonObject, schema, violations);
    validateFullPlanContract(data as JsonObject, violations);
  }
  validateSequences(data as JsonObject, schema, name, violations);
  if (name === "decisions") {
    violations.push(...validateDecisionAlternatives(data as JsonObject, name));
    violations.push(...validateDecisionSatisfaction(data as JsonObject, name));
  }
  const wordBudgetSeverity = validationRuleSeverity(schema, "word_budget");
  for (const be of Object.values(schema.BUDGET ?? {})) {
    if (!isMapping(be)) continue;
    const mw = be.max_words;
    const scope = be.scope ?? "";
    if (mw && String(scope).includes("full_file") && wordBudgetSeverity === "error") {
      const wc = wordCount(content);
      if (wc > Number(mw)) violations.push(`${name}: word count (${wc}) exceeds budget (${mw})`);
    }
  }
  for (const groupKey of ["VALIDATION", "VALIDATION_RULES"]) {
    for (const ve of Object.values(schema[groupKey] ?? {})) {
      if (!isMapping(ve)) continue;
      const rule = String(ve.rule ?? "");
      if (ve.severity !== "error") continue;
      if (rule.includes("unique") && rule.includes("number")) {
        for (const [key, val] of Object.entries(data)) {
          if (Array.isArray(val)) {
            const nums = val.filter((e): e is JsonObject => isMapping(e) && "number" in e).map((e) => e.number as number);
            if (nums.length > 0) {
              if (nums.length !== new Set(nums).size) {
                violations.push(`${name}: duplicate numbers in '${key}'`);
              }
              const direction = expectedSequenceOrder(name, key);
              if (!sequenceInOrder(nums, direction)) {
                violations.push(`${name}: '${key}' not in ${direction} order`);
              }
            }
          }
        }
      } else if (rule === "closure_consistency") {
        const header: JsonObject = isMapping(data.header) ? data.header : {};
        const status = data.status ?? header.status;
        if (typeof status === "string" && status === "closed") {
          for (const field of ["closed_at", "final_value", "target_ref", "reason"]) {
            let val = data[field];
            if (val === null || val === undefined) val = header[field];
            if (val === null || val === undefined || (typeof val === "string" && !val.trim())) {
              violations.push(`${name}: closure field '${field}' is required when status is 'closed'`);
            }
          }
        }
      }
    }
  }
  return violations;
}

export { loadYamlMapping, schemasDirDefault };

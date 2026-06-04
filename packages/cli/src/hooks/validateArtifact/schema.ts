/**
 * Schema-driven validation helpers for the v2 artifact protocol.
 *
 * Walks the schema (skills/agentera/schemas/artifacts/<name>.yaml) and
 * a parsed artifact mapping, producing a list of human-readable
 * violation strings. The helpers in this file are pure (no I/O) and
 * are orchestrated by `violations.ts` for the YAML side and by
 * `markdown.ts` for the human-facing side.
 */

type Dict = Record<string, any>;

export function isMapping(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") return "dict";
  return typeof v;
}

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

const SKIP_META = new Set(["meta", "GROUP_PREFIXES", "BUDGET", "COMPACTION", "VALIDATION", "CONVENTION"]);
const LIST_INDICATORS = new Set(["number", "entry", "summary"]);
const SEQUENCE_KEYS_BY_ARTIFACT: Record<string, Record<string, string>> = {
  decisions: { DECISION: "decisions", ARCHIVE: "archive" },
  docs: { MAPPING: "mapping", INDEX: "index", AUDIT_LOG: "audit_log" },
  experiments: { EXPERIMENT: "experiments", ARCHIVE: "archive" },
  plan: { TASK: "tasks" },
  progress: { CYCLE: "cycles", ARCHIVE: "archive" },
  session: { BOOKMARK: "bookmarks" },
  vision: { PERSONA: "personas", PRINCIPLE: "principles" },
};
const NESTED_SEQUENCE_KEYS: Array<[[string, string], string]> = [[["DECISION", "ALTERNATIVE"], "alternatives"]];
const SEQUENCE_ORDER_BY_ARTIFACT: Record<string, string> = { "progress\0cycles": "descending" };

export function collectSingletonGroups(schema: Dict): Array<[string, string, string[]]> {
  const result: Array<[string, string, string[]]> = [];
  for (const [gk, gv] of Object.entries(schema)) {
    if (SKIP_META.has(gk) || !isMapping(gv)) continue;
    let isListOrSub = false;
    for (const e of Object.values(gv)) {
      if (isMapping(e) && (LIST_INDICATORS.has(e.field) || e.parent)) {
        isListOrSub = true;
        break;
      }
    }
    if (isListOrSub) continue;
    const fields: string[] = [];
    for (const e of Object.values(gv)) {
      if (isMapping(e) && e.required && "field" in e) fields.push(e.field);
    }
    if (fields.length > 0) result.push([gk, gk.toLowerCase(), fields]);
  }
  return result;
}

export function isEmptyRequired(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function* iterGroupEntries(schema: Dict, group: string): Generator<Dict> {
  const gv = schema[group];
  if (!isMapping(gv)) return;
  for (const entry of Object.values(gv)) {
    if (isMapping(entry) && "field" in entry) yield entry;
  }
}

export function validateField(violations: string[], name: string, scope: Dict, field: string, p: string): void {
  const fullPath = p ? `${p}.${field}` : field;
  if (!(field in scope)) {
    violations.push(`${name}: missing required field '${fullPath}'`);
  } else if (isEmptyRequired(scope[field])) {
    violations.push(`${name}: empty required field '${fullPath}'`);
  }
}

export function allowedValues(entry: Dict): string[] {
  for (const rule of entry.validation ?? []) {
    if (typeof rule === "string" && rule.startsWith("Must be one of: ")) {
      return rule.slice("Must be one of: ".length).split(",").map((v) => v.trim());
    }
  }
  return [];
}

export function validateAllowedValue(violations: string[], name: string, scope: Dict, entry: Dict, p: string): void {
  const field = entry.field;
  const allowed = allowedValues(entry);
  if (!field || allowed.length === 0 || !(field in scope) || isEmptyRequired(scope[field])) return;
  const value = scope[field];
  if (typeof value === "string" && !allowed.includes(value)) {
    violations.push(`${name}: invalid value '${value}' for '${p}.${field}' (expected one of: ${allowed.join(", ")})`);
  }
}

export function validateFieldType(violations: string[], name: string, scope: Dict, entry: Dict, p: string): boolean {
  const field = entry.field;
  if (!field || !(field in scope)) return true;
  const value = scope[field];
  const expectedType = entry.type;
  if (!expectedType || isEmptyRequired(value)) return true;
  const fullPath = p ? `${p}.${field}` : field;
  let isValid = true;
  if (expectedType === "integer") {
    if (typeof value === "boolean" || !(typeof value === "number" && Number.isInteger(value))) {
      violations.push(`${name}: '${fullPath}' must be an integer, got ${pyTypeName(value)}`);
      isValid = false;
    }
  } else if (expectedType === "string") {
    if (typeof value !== "string") {
      violations.push(`${name}: '${fullPath}' must be a string, got ${pyTypeName(value)}`);
      isValid = false;
    }
  } else if (expectedType === "map") {
    if (!isMapping(value)) {
      violations.push(`${name}: '${fullPath}' must be a mapping, got ${pyTypeName(value)}`);
      isValid = false;
    }
  } else if (expectedType === "list[string]") {
    if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
      violations.push(`${name}: '${fullPath}' must be a list of strings`);
      isValid = false;
    }
  } else if (expectedType === "list[map]") {
    if (!Array.isArray(value) || !value.every((x) => isMapping(x))) {
      violations.push(`${name}: '${fullPath}' must be a list of mappings`);
      isValid = false;
    }
  }
  return isValid;
}

export function validateFieldConstraints(violations: string[], name: string, scope: Dict, entry: Dict, p: string): void {
  const field = entry.field;
  if (!field || !(field in scope)) return;
  const value = scope[field];
  for (const rule of entry.validation ?? []) {
    if (typeof rule !== "string") continue;
    if (rule === "Must be a positive integer") {
      if (typeof value === "boolean" || !(typeof value === "number" && Number.isInteger(value)) || value <= 0) {
        const fullPath = p ? `${p}.${field}` : field;
        violations.push(`${name}: '${fullPath}' must be a positive integer`);
      }
    }
  }
}

export function validateRequiredFields(violations: string[], name: string, schema: Dict, group: string, scope: Dict, p: string): void {
  for (const entry of iterGroupEntries(schema, group)) {
    const field = entry.field;
    if (entry.parent || field === "entry") continue;
    if (entry.required) validateField(violations, name, scope, field, p);
    if (field in scope && !isEmptyRequired(scope[field])) {
      if (validateFieldType(violations, name, scope, entry, p)) {
        validateAllowedValue(violations, name, scope, entry, p);
        validateFieldConstraints(violations, name, scope, entry, p);
      }
    }
    const value = scope[field];
    if (isMapping(value)) {
      for (const child of entry.children ?? []) {
        if (isMapping(child) && child.field) {
          const childField = child.field;
          const childPath = p ? `${p}.${field}` : field;
          if (child.required) validateField(violations, name, value, childField, childPath);
          if (childField in value && !isEmptyRequired(value[childField])) {
            if (validateFieldType(violations, name, value, child, childPath)) {
              validateAllowedValue(violations, name, value, child, childPath);
              validateFieldConstraints(violations, name, value, child, childPath);
            }
          }
        }
      }
    }
  }
}

export function validateSingletonGroup(violations: string[], name: string, schema: Dict, group: string, scope: Dict, p: string): void {
  for (const entry of iterGroupEntries(schema, group)) {
    const field = entry.field;
    if (entry.parent || field === "entry") continue;
    if (entry.required) validateField(violations, name, scope, field, p);
    if (field in scope && !isEmptyRequired(scope[field])) {
      if (validateFieldType(violations, name, scope, entry, p)) {
        validateAllowedValue(violations, name, scope, entry, p);
        validateFieldConstraints(violations, name, scope, entry, p);
      }
    }
  }
}

export function schemaFieldNames(schema: Dict, group: string): Set<string> {
  const out = new Set<string>();
  for (const entry of iterGroupEntries(schema, group)) {
    if (entry.field && !entry.parent && entry.field !== "entry") out.add(entry.field);
  }
  return out;
}

export function validateUnknownFields(violations: string[], name: string, scope: Dict, allowed: Set<string>, p: string): void {
  for (const field of Object.keys(scope)) {
    if (!allowed.has(field)) {
      const fullPath = p ? `${p}.${field}` : field;
      violations.push(`${name}: unsupported field '${fullPath}'`);
    }
  }
}

export function validatePlanKnownFields(data: Dict, schema: Dict, violations: string[]): void {
  const groupedScopes: Record<string, string> = { header: "HEADER", scope: "SCOPE" };
  const sequenceKeys = new Set(Object.values(SEQUENCE_KEYS_BY_ARTIFACT.plan ?? {}));
  const allowedTopLevel = new Set<string>([
    ...schemaFieldNames(schema, "PLAN"),
    ...Object.keys(groupedScopes),
    ...sequenceKeys,
  ]);
  validateUnknownFields(violations, "plan", data, allowedTopLevel, "");
  for (const [key, group] of Object.entries(groupedScopes)) {
    const scope = data[key];
    if (isMapping(scope)) {
      validateUnknownFields(violations, "plan", scope, schemaFieldNames(schema, group), key);
    }
  }
}

export function validateFullPlanContract(data: Dict, violations: string[]): void {
  const header = isMapping(data.header) ? data.header : {};
  if (String(header.level ?? "").toLowerCase() !== "full") return;
  for (const field of ["reviewed", "critic_issues"]) {
    validateField(violations, "plan", header, field, "header");
  }
  validateField(violations, "plan", data, "design", "");
  const criticIssues = header.critic_issues;
  if (!isEmptyRequired(criticIssues)) {
    const match = /^\s*(\d+)\s+found,\s*(\d+)\s+addressed,\s*(\d+)\s+dismissed\s*$/.exec(String(criticIssues));
    if (!match) {
      violations.push("plan: header.critic_issues must match 'N found, M addressed, K dismissed'");
    } else {
      const [found, addressed, dismissed] = [match[1], match[2], match[3]].map((v) => parseInt(v, 10));
      if (found < 1) violations.push("plan: header.critic_issues must record at least 1 found issue");
      if (addressed + dismissed !== found) {
        violations.push("plan: header.critic_issues counts must satisfy addressed + dismissed == found");
      }
    }
  }
  const tasks = data.tasks;
  if (!Array.isArray(tasks)) return;
  tasks.forEach((task, index) => {
    if (isMapping(task)) validateField(violations, "plan", task, "acceptance", `tasks[${index}]`);
  });
}

export function entryMinCount(schema: Dict, group: string): number | null {
  for (const entry of iterGroupEntries(schema, group)) {
    if (entry.field === "entry" && entry.required) return entry.min_count || 1;
  }
  return null;
}

export function parentRequirements(schema: Dict, parentGroup: string): Record<string, string[]> {
  const requirements: Record<string, string[]> = {};
  const prefix = `${parentGroup}.`;
  for (const group of Object.keys(schema)) {
    if (SKIP_META.has(group)) continue;
    for (const entry of iterGroupEntries(schema, group)) {
      const parent = entry.parent;
      if (
        typeof parent === "string" &&
        parent.startsWith(prefix) &&
        parent !== `${group}.entry` &&
        entry.required &&
        entry.field
      ) {
        const parentField = parent.slice(prefix.length);
        (requirements[parentField] ??= []).push(entry.field);
      }
    }
  }
  return requirements;
}

export function entryRequirements(schema: Dict, group: string): string[] {
  const parent = `${group}.entry`;
  const out: string[] = [];
  for (const entry of iterGroupEntries(schema, group)) {
    if (entry.parent === parent && entry.required && entry.field) out.push(entry.field);
  }
  return out;
}

export function validateSequences(data: Dict, schema: Dict, name: string, violations: string[]): void {
  for (const [group, key] of Object.entries(SEQUENCE_KEYS_BY_ARTIFACT[name] ?? {})) {
    const seq = data[key];
    if (seq === null || seq === undefined) continue;
    if (!Array.isArray(seq)) {
      violations.push(`${name}: '${key}' must be a list`);
      continue;
    }
    if (seq.length === 0) {
      violations.push(`${name}: '${key}' requires at least 1 entry`);
      continue;
    }
    const childRequirements = parentRequirements(schema, group);
    seq.forEach((item, index) => {
      const p = `${key}[${index}]`;
      if (!isMapping(item)) {
        violations.push(`${name}: '${p}' must be a mapping`);
        return;
      }
      validateRequiredFields(violations, name, schema, group, item, p);
      for (const [parentField, childFields] of Object.entries(childRequirements)) {
        const childScope = item[parentField];
        if (!isMapping(childScope)) continue;
        for (const childField of childFields) {
          validateField(violations, name, childScope, childField, `${p}.${parentField}`);
        }
      }
      for (const [[parentGroup, childGroup], childKey] of NESTED_SEQUENCE_KEYS) {
        if (parentGroup !== group) continue;
        const childSeq = item[childKey];
        const minCount = entryMinCount(schema, childGroup);
        if (minCount && (!Array.isArray(childSeq) || childSeq.length < minCount)) {
          violations.push(`${name}: '${p}.${childKey}' requires at least ${minCount} entry`);
          continue;
        }
        if (!Array.isArray(childSeq)) continue;
        const required = entryRequirements(schema, childGroup);
        childSeq.forEach((child, childIndex) => {
          const childPath = `${p}.${childKey}[${childIndex}]`;
          if (!isMapping(child)) {
            violations.push(`${name}: '${childPath}' must be a mapping`);
            return;
          }
          for (const field of required) validateField(violations, name, child, field, childPath);
        });
      }
    });
  }
}

export function validateDecisionAlternatives(data: Dict, name: string): string[] {
  const violations: string[] = [];
  (data.decisions ?? []).forEach((decision: unknown, index: number) => {
    if (!isMapping(decision)) return;
    const alternatives = decision.alternatives ?? [];
    if (!Array.isArray(alternatives)) return;
    const chosen = alternatives.filter((alt) => isMapping(alt) && alt.status === "chosen");
    if (chosen.length !== 1) {
      violations.push(`${name}: 'decisions[${index}].alternatives' must have exactly one chosen entry`);
    }
  });
  return violations;
}

export function validateDecisionSatisfaction(data: Dict, name: string): string[] {
  const violations: string[] = [];
  const allowedStates = new Set(["open", "provisionally_satisfied", "user_confirmed_satisfied"]);
  const entries: Array<[string, unknown]> = [
    ...(data.decisions ?? []).map((d: unknown, i: number): [string, unknown] => [`decisions[${i}]`, d]),
    ...(data.archive ?? []).map((d: unknown, i: number): [string, unknown] => [`archive[${i}]`, d]),
  ];
  for (const [entryPath, decision] of entries) {
    if (!isMapping(decision) || !("satisfaction" in decision)) continue;
    const p = `${entryPath}.satisfaction`;
    const satisfaction = decision.satisfaction;
    if (!isMapping(satisfaction)) {
      violations.push(`${name}: '${p}' must be a mapping`);
      continue;
    }
    validateUnknownFields(violations, name, satisfaction, new Set(["state", "evidence", "user_confirmation"]), p);
    const state = satisfaction.state;
    if (typeof state !== "string" || !state.trim()) {
      violations.push(`${name}: missing required field '${p}.state'`);
      continue;
    }
    if (!allowedStates.has(state)) {
      violations.push(
        `${name}: invalid value '${state}' for '${p}.state' (expected one of: open, provisionally_satisfied, user_confirmed_satisfied)`,
      );
      continue;
    }
    if (state === "provisionally_satisfied" && isEmptyRequired(satisfaction.evidence)) {
      violations.push(`${name}: '${p}.evidence' is required for provisionally_satisfied`);
    }
    if (state === "user_confirmed_satisfied") {
      const confirmation = satisfaction.user_confirmation;
      if (confirmation === null || confirmation === undefined) {
        violations.push(`${name}: '${p}.user_confirmation' is required for user_confirmed_satisfied`);
        continue;
      }
      if (!isMapping(confirmation)) {
        violations.push(
          `${name}: '${p}.user_confirmation' must be a mapping with confirmed_by and confirmed_at, got ${pyTypeName(confirmation)}`,
        );
        continue;
      }
      for (const field of ["confirmed_by", "confirmed_at"]) {
        if (isEmptyRequired(confirmation[field])) {
          violations.push(`${name}: missing required field '${p}.user_confirmation.${field}'`);
        }
      }
    }
  }
  return violations;
}

export function validationRuleSeverity(schema: Dict, rule: string): string | null {
  for (const groupKey of ["VALIDATION", "VALIDATION_RULES"]) {
    for (const entry of Object.values(schema[groupKey] ?? {})) {
      if (isMapping(entry) && entry.rule === rule) {
        const severity = entry.severity;
        return severity ? String(severity) : null;
      }
    }
  }
  return null;
}

export function expectedSequenceOrder(name: string, key: string): string {
  return SEQUENCE_ORDER_BY_ARTIFACT[`${name}\0${key}`] ?? "ascending";
}

export function sequenceInOrder(nums: number[], direction: string): boolean {
  const reverse = direction === "descending";
  const sorted = [...nums].sort((a, b) => (reverse ? b - a : a - b));
  return nums.length === sorted.length && nums.every((n, i) => n === sorted[i]);
}

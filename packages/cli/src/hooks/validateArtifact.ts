import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping, parseYaml } from "../core/yaml.js";
import { resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { DEFAULT_ARTIFACT_PATHS } from "./common.js";
import { COMPACTABLE_YAML_ARTIFACTS, compactFile, compactYamlFile } from "./compaction.js";

/**
 * PostToolUse validation hook for artifact writes (v2 schema-backed). Faithful
 * TS port of hooks/validate_artifact.py.
 */

type Dict = Record<string, any>;

function schemasDirDefault(): string {
  return path.join(resolveSourceRoot(), "skills", "agentera", "schemas", "artifacts");
}

const AGENT_YAML_RE = /\.agentera\/([a-z_]+)\.yaml$/;
const HUMAN_FACING = new Set(["TODO.md", "CHANGELOG.md", "DESIGN.md"]);
const HUMAN_FACING_SCHEMA_NAMES: Record<string, string> = {
  "TODO.md": "todo",
  "CHANGELOG.md": "changelog",
  "DESIGN.md": "design",
};
const CANONICAL_SCHEMA_NAMES: Record<string, string> = {
  "DECISIONS.md": "decisions",
  "DOCS.md": "docs",
  "EXPERIMENTS.md": "experiments",
  "HEALTH.md": "health",
  "PLAN.md": "plan",
  "PROGRESS.md": "progress",
  "VISION.md": "vision",
};
const ARTIFACT_BY_SCHEMA_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_SCHEMA_NAMES).map(([a, s]) => [s, a]),
);

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

function isMapping(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") return "dict";
  return typeof v;
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

// ── Runtime event parsing ──────────────────────────────────────────

export class ArtifactWrite {
  file_path: string;
  content: string | null;
  constructor(filePath: string, content: string | null = null) {
    this.file_path = filePath;
    this.content = content;
  }
}

export class RuntimeEventParser {
  parseClaude(data: Dict): ArtifactWrite | null {
    const ti = data.tool_input;
    if (!isMapping(ti)) return null;
    const fp = ti.file_path;
    if (fp) return new ArtifactWrite(String(fp), ti.content ?? null);
    return null;
  }

  parseOpencode(data: Dict): ArtifactWrite | null {
    const inp = data.input;
    if (!isMapping(inp)) return null;
    const fp = inp.path;
    if (fp) return new ArtifactWrite(String(fp), inp.content ?? null);
    return null;
  }

  parseCodex(data: Dict): ArtifactWrite | null {
    const ti = data.tool_input;
    if (!isMapping(ti)) return null;
    const fp = ti.path;
    const patchBody = ti.patch || ti.command || "";
    if (fp) return new ArtifactWrite(String(fp));
    if (typeof patchBody === "string") {
      const headers = [...patchBody.matchAll(/^\*\*\*\s+(?:Add File|Update File):\s+(.+?)\s*$/gm)];
      if (headers.length > 0) return new ArtifactWrite(headers[0][1]);
    }
    return null;
  }

  parseCopilot(data: Dict): ArtifactWrite | null {
    const inp = data.input;
    if (!isMapping(inp)) return null;
    const fp = inp.filePath || inp.file_path;
    if (fp) return new ArtifactWrite(String(fp), inp.content ?? null);
    return null;
  }

  parse(data: Dict): ArtifactWrite | null {
    const tn = data.tool_name ?? "";
    if (tn === "apply_patch") {
      const candidate = this.parseCodex(data);
      if (candidate) return candidate;
    }
    if (tn === "Edit" || tn === "Write" || (isMapping(data.tool_input) && "file_path" in data.tool_input)) {
      const candidate = this.parseClaude(data);
      if (candidate) return candidate;
    }
    if (isMapping(data.input)) {
      const inp = data.input;
      if ("filePath" in inp || "file_path" in inp) return this.parseCopilot(data);
      if ("path" in inp) return this.parseOpencode(data);
    }
    return null;
  }
}

// ── Validation helpers ─────────────────────────────────────────────

function collectSingletonGroups(schema: Dict): Array<[string, string, string[]]> {
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

function isEmptyRequired(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function* iterGroupEntries(schema: Dict, group: string): Generator<Dict> {
  const gv = schema[group];
  if (!isMapping(gv)) return;
  for (const entry of Object.values(gv)) {
    if (isMapping(entry) && "field" in entry) yield entry;
  }
}

function validateField(violations: string[], name: string, scope: Dict, field: string, p: string): void {
  const fullPath = p ? `${p}.${field}` : field;
  if (!(field in scope)) {
    violations.push(`${name}: missing required field '${fullPath}'`);
  } else if (isEmptyRequired(scope[field])) {
    violations.push(`${name}: empty required field '${fullPath}'`);
  }
}

function allowedValues(entry: Dict): string[] {
  for (const rule of entry.validation ?? []) {
    if (typeof rule === "string" && rule.startsWith("Must be one of: ")) {
      return rule.slice("Must be one of: ".length).split(",").map((v) => v.trim());
    }
  }
  return [];
}

function validateAllowedValue(violations: string[], name: string, scope: Dict, entry: Dict, p: string): void {
  const field = entry.field;
  const allowed = allowedValues(entry);
  if (!field || allowed.length === 0 || !(field in scope) || isEmptyRequired(scope[field])) return;
  const value = scope[field];
  if (typeof value === "string" && !allowed.includes(value)) {
    violations.push(`${name}: invalid value '${value}' for '${p}.${field}' (expected one of: ${allowed.join(", ")})`);
  }
}

function validateFieldType(violations: string[], name: string, scope: Dict, entry: Dict, p: string): boolean {
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

function validateFieldConstraints(violations: string[], name: string, scope: Dict, entry: Dict, p: string): void {
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

function validateRequiredFields(violations: string[], name: string, schema: Dict, group: string, scope: Dict, p: string): void {
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

function validateSingletonGroup(violations: string[], name: string, schema: Dict, group: string, scope: Dict, p: string): void {
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

function schemaFieldNames(schema: Dict, group: string): Set<string> {
  const out = new Set<string>();
  for (const entry of iterGroupEntries(schema, group)) {
    if (entry.field && !entry.parent && entry.field !== "entry") out.add(entry.field);
  }
  return out;
}

function validateUnknownFields(violations: string[], name: string, scope: Dict, allowed: Set<string>, p: string): void {
  for (const field of Object.keys(scope)) {
    if (!allowed.has(field)) {
      const fullPath = p ? `${p}.${field}` : field;
      violations.push(`${name}: unsupported field '${fullPath}'`);
    }
  }
}

function validatePlanKnownFields(data: Dict, schema: Dict, violations: string[]): void {
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

function validateFullPlanContract(data: Dict, violations: string[]): void {
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

function entryMinCount(schema: Dict, group: string): number | null {
  for (const entry of iterGroupEntries(schema, group)) {
    if (entry.field === "entry" && entry.required) return entry.min_count || 1;
  }
  return null;
}

function parentRequirements(schema: Dict, parentGroup: string): Record<string, string[]> {
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

function entryRequirements(schema: Dict, group: string): string[] {
  const parent = `${group}.entry`;
  const out: string[] = [];
  for (const entry of iterGroupEntries(schema, group)) {
    if (entry.parent === parent && entry.required && entry.field) out.push(entry.field);
  }
  return out;
}

function validateSequences(data: Dict, schema: Dict, name: string, violations: string[]): void {
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

function validateDecisionAlternatives(data: Dict, name: string): string[] {
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

function validateDecisionSatisfaction(data: Dict, name: string): string[] {
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

function validationRuleSeverity(schema: Dict, rule: string): string | null {
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

function expectedSequenceOrder(name: string, key: string): string {
  return SEQUENCE_ORDER_BY_ARTIFACT[`${name}\0${key}`] ?? "ascending";
}

function sequenceInOrder(nums: number[], direction: string): boolean {
  const reverse = direction === "descending";
  const sorted = [...nums].sort((a, b) => (reverse ? b - a : a - b));
  return nums.length === sorted.length && nums.every((n, i) => n === sorted[i]);
}

function validateYamlContent(content: string, schema: Dict, name: string): string[] {
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
    let scope: Dict;
    if (groupLower in data && isMapping((data as Dict)[groupLower])) {
      scope = (data as Dict)[groupLower];
    } else if (fields.some((f) => f in (data as Dict))) {
      scope = data as Dict;
    } else {
      continue;
    }
    validateSingletonGroup(violations, name, schema, group, scope, groupLower);
  }
  if (name === "plan") {
    validatePlanKnownFields(data as Dict, schema, violations);
    validateFullPlanContract(data as Dict, violations);
  }
  validateSequences(data as Dict, schema, name, violations);
  if (name === "decisions") {
    violations.push(...validateDecisionAlternatives(data as Dict, name));
    violations.push(...validateDecisionSatisfaction(data as Dict, name));
  }
  const wordBudgetSeverity = validationRuleSeverity(schema, "word_budget");
  for (const be of Object.values(schema.BUDGET ?? {})) {
    if (!isMapping(be)) continue;
    const mw = be.max_words;
    const scope = be.scope ?? "";
    if (mw && String(scope).includes("full_file") && wordBudgetSeverity === "error") {
      const wc = wordCount(content);
      if (wc > mw) violations.push(`${name}: word count (${wc}) exceeds budget (${mw})`);
    }
  }
  for (const groupKey of ["VALIDATION", "VALIDATION_RULES"]) {
    for (const ve of Object.values(schema[groupKey] ?? {})) {
      if (!isMapping(ve)) continue;
      const rule = ve.rule ?? "";
      if (ve.severity !== "error") continue;
      if (rule.includes("unique") && rule.includes("number")) {
        for (const [key, val] of Object.entries(data as Dict)) {
          if (Array.isArray(val)) {
            const nums = val.filter((e) => isMapping(e) && "number" in e).map((e) => e.number);
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
        const header = isMapping((data as Dict).header) ? (data as Dict).header : {};
        const status = (data as Dict).status ?? header.status;
        if (typeof status === "string" && status === "closed") {
          for (const field of ["closed_at", "final_value", "target_ref", "reason"]) {
            let val = (data as Dict)[field];
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

function validateMd(content: string, name: string, schema: Dict | null = null): string[] {
  const violations: string[] = [];
  if (!content.trim()) violations.push(`${name}: empty content`);
  const fences = (content.match(/^```/gm) ?? []).length;
  if (fences % 2) violations.push(`${name}: unclosed code fence`);
  if (schema) violations.push(...validateMdSchema(content, name, schema));
  return violations;
}

function validateMdSchema(content: string, name: string, schema: Dict): string[] {
  const violations: string[] = [];
  if (!content.trim()) return violations;
  for (const [groupKey, groupValue] of Object.entries(schema)) {
    if (SKIP_META.has(groupKey) || !isMapping(groupValue)) continue;
    const hasRequired = Object.values(groupValue).some((e) => isMapping(e) && e.required && e.field);
    if (!hasRequired) continue;
    if (groupKey === "ITEM") validateMdItems(content, name, violations);
    else if (groupKey === "RELEASE") validateMdReleases(content, name, violations);
    else if (groupKey === "TOKEN") validateMdTokens(content, name, violations);
  }
  return violations;
}

function validateMdItems(content: string, name: string, violations: string[]): void {
  const versionHeading = /^##\s+/m.exec(content);
  if (!versionHeading) {
    violations.push(`${name}: missing severity sections (expected '## <glyph> <name>' headings)`);
    return;
  }
  const severityGlyphs = ["⇶", "⇉", "→", "⇢"];
  let found = false;
  for (const glyph of severityGlyphs) {
    const g = glyph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^##\\s*${g}`, "m").test(content)) {
      found = true;
      const sectionStart = new RegExp(`^##\\s*${g}.+$`, "m").exec(content);
      if (sectionStart) {
        const idx = sectionStart.index + sectionStart[0].length;
        const nextSection = content.indexOf("\n##", idx);
        const sectionBody = nextSection >= 0 ? content.slice(idx, nextSection) : content.slice(idx);
        if (!/^\s*-/m.test(sectionBody)) {
          const headingSlice = content.slice(sectionStart.index, sectionStart.index + sectionStart[0].length);
          const glyphNameMatch = new RegExp(`^##\\s*(${g}.+)$`, "m").exec(headingSlice);
          const headingText = glyphNameMatch ? glyphNameMatch[1] : glyph;
          violations.push(
            `${name}: severity section '${headingText}' has no list entries (expected '- [type]' items)`,
          );
        }
      }
    }
  }
  if (!found) {
    violations.push(
      `${name}: missing severity glyph in section headings (expected '## ⇶ Critical', '## ⇉ Degraded', '## → Normal', '## ⇢ Annoying')`,
    );
  }
}

function validateMdReleases(content: string, name: string, violations: string[]): void {
  if (!/^##\s*\[/m.test(content)) {
    violations.push(`${name}: missing version header (expected '## [X.Y.Z]')`);
  }
  const changeSections = new Set(["### Added", "### Changed", "### Fixed", "### Removed"]);
  const lines = new Set(content.split("\n"));
  if (![...changeSections].some((s) => lines.has(s))) {
    violations.push(
      `${name}: missing change sections (expected '### Added', '### Changed', '### Fixed', or '### Removed')`,
    );
  }
}

function validateMdTokens(content: string, name: string, violations: string[]): void {
  if (!/^##\s/m.test(content)) {
    violations.push(`${name}: missing section heading (expected '## SectionName')`);
  }
  const yamlBlocks = (content.match(/^```yaml\s*$/gm) ?? []).length;
  if (!yamlBlocks) {
    violations.push(`${name}: missing YAML code block with token definitions (expected '\`\`\`yaml')`);
  }
}

// ── Path resolution ────────────────────────────────────────────────

function resolvePathRel(fp: string, cwd: string): string {
  return path.isAbsolute(fp) ? fp : path.join(cwd, fp);
}

function docsPathOverrides(cwd: string): Record<string, string> {
  const docsPath = path.join(cwd, ".agentera", "docs.yaml");
  if (!fs.existsSync(docsPath) || !fs.statSync(docsPath).isFile()) return {};
  let data: Dict;
  try {
    data = loadYamlMapping(fs.readFileSync(docsPath, "utf8"));
  } catch (exc) {
    process.stderr.write(`warning: failed to load docs path overrides: ${(exc as Error).message}\n`);
    return {};
  }
  const mapping = data.mapping;
  if (!Array.isArray(mapping)) return {};
  const overrides: Record<string, string> = {};
  for (const entry of mapping) {
    if (!isMapping(entry)) continue;
    const artifact = entry.artifact;
    const p = entry.path;
    if (typeof artifact === "string" && typeof p === "string") overrides[artifact] = p;
  }
  return overrides;
}

function defaultArtifactPath(artifact: string, cwd: string): string {
  const rel = docsPathOverrides(cwd)[artifact] ?? DEFAULT_ARTIFACT_PATHS[artifact] ?? "";
  return rel ? resolvePathRel(rel, cwd) : "";
}

function artifactPaths(cwd: string): Record<string, string> {
  const paths: Record<string, string> = { ...DEFAULT_ARTIFACT_PATHS, ...docsPathOverrides(cwd) };
  const resolved: Record<string, string> = {};
  for (const [artifact, p] of Object.entries(paths)) resolved[artifact] = resolvePathRel(p, cwd);
  return resolved;
}

function samePath(left: string, right: string): boolean {
  return resolvePath(left) === resolvePath(right);
}

function artifactForWrite(absPath: string, relPath: string, basename: string, cwd: string): string | null {
  for (const [artifact, mappedPath] of Object.entries(artifactPaths(cwd))) {
    if (samePath(absPath, mappedPath)) return artifact;
  }
  const match = AGENT_YAML_RE.exec(relPath);
  if (match) return ARTIFACT_BY_SCHEMA_NAME[match[1]] ?? null;
  if (HUMAN_FACING.has(basename)) return basename;
  return null;
}

function readIfNeeded(content: string | null, absPath: string): string | null {
  if (content !== null && content !== undefined) return content;
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function compactAfterValidWrite(artifact: string, absPath: string): string[] {
  if (!fs.existsSync(absPath)) return [];
  try {
    if (artifact === "TODO.md") {
      compactFile(absPath, "todo-resolved");
    } else if (artifact in COMPACTABLE_YAML_ARTIFACTS) {
      compactYamlFile(absPath, artifact);
    } else {
      return [];
    }
  } catch (exc) {
    return [`${artifact}: compaction failed: ${(exc as Error).message}`];
  }
  return [];
}

// ── Validator + adapter ────────────────────────────────────────────

export class ArtifactSchemaValidator {
  schemasDir: string;
  private schemaCache: Map<string, Dict | null>;

  constructor(schemasDir: string = schemasDirDefault()) {
    this.schemasDir = schemasDir;
    this.schemaCache = new Map();
  }

  loadSchema(name: string): Dict | null {
    if (!this.schemaCache.has(name)) {
      const p = path.join(this.schemasDir, `${name}.yaml`);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        this.schemaCache.set(name, loadYamlMapping(fs.readFileSync(p, "utf8")));
      } else {
        this.schemaCache.set(name, null);
      }
    }
    return this.schemaCache.get(name) ?? null;
  }

  validateYaml(content: string, schema: Dict, name: string): string[] {
    return validateYamlContent(content, schema, name);
  }

  validateMarkdown(content: string, name: string, schema: Dict | null = null): string[] {
    return validateMd(content, name, schema);
  }

  validateWrite(write: ArtifactWrite, cwd: string): string[] {
    const absPath = resolvePathRel(write.file_path, cwd);
    const rel = path.relative(cwd, absPath).replace(/\\/g, "/");
    const basename = path.basename(absPath);
    const artifact = artifactForWrite(absPath, rel, basename, cwd);

    if (artifact && artifact in CANONICAL_SCHEMA_NAMES) {
      const name = CANONICAL_SCHEMA_NAMES[artifact];
      const schema = this.loadSchema(name);
      if (schema === null) return [];
      if (Object.keys(schema).length === 0) return [`${name}: schema file is empty or contains no valid definitions`];
      const content = readIfNeeded(write.content, absPath);
      if (content === null) return [];
      let violations = this.validateYaml(content, schema, name);
      if (violations.length > 0) return violations;
      return compactAfterValidWrite(artifact, absPath);
    }

    if (artifact && HUMAN_FACING.has(artifact)) {
      const content = readIfNeeded(write.content, absPath);
      if (content === null) return [];
      const schemaName = HUMAN_FACING_SCHEMA_NAMES[artifact];
      const schema = schemaName ? this.loadSchema(schemaName) : null;
      const violations = this.validateMarkdown(content, artifact, schema);
      if (violations.length > 0) return violations;
      return compactAfterValidWrite(artifact, absPath);
    }

    return [];
  }

  validateExplicit(artifact: string, filePath: string, cwd: string): string[] {
    const content = readIfNeeded(null, filePath);
    if (content === null) return [`${artifact}: cannot read artifact file '${filePath}'`];
    if (artifact in CANONICAL_SCHEMA_NAMES) {
      const name = CANONICAL_SCHEMA_NAMES[artifact];
      const schema = this.loadSchema(name);
      if (schema === null) return [`${artifact}: schema '${name}' is not available`];
      if (Object.keys(schema).length === 0) return [`${artifact}: schema '${name}' file is empty or contains no valid definitions`];
      let violations = this.validateYaml(content, schema, name);
      return violations;
    }
    if (HUMAN_FACING.has(artifact)) {
      const schemaName = HUMAN_FACING_SCHEMA_NAMES[artifact];
      const schema = schemaName ? this.loadSchema(schemaName) : null;
      return this.validateMarkdown(content, artifact, schema);
    }
    return [
      `${artifact}: unsupported artifact; expected one of: ${Object.keys(DEFAULT_ARTIFACT_PATHS).sort().join(", ")}`,
    ];
  }
}

export function loadSchema(name: string): Dict | null {
  return new ArtifactSchemaValidator().loadSchema(name);
}

export class HookCliAdapter {
  parser: RuntimeEventParser;
  validator: ArtifactSchemaValidator;

  constructor(parser?: RuntimeEventParser, validator?: ArtifactSchemaValidator) {
    this.parser = parser ?? new RuntimeEventParser();
    this.validator = validator ?? new ArtifactSchemaValidator();
  }

  run(raw: string, defaultCwd: string | null = null): [number, string[]] {
    let data: unknown;
    try {
      if (!raw.trim()) return [0, []];
      data = JSON.parse(raw);
    } catch {
      return [0, []];
    }
    if (!isMapping(data)) return [0, []];
    const write = this.parser.parse(data);
    if (write === null) return [0, []];
    const cwd = (data as Dict).cwd ?? defaultCwd ?? process.cwd();
    const violations = this.validator.validateWrite(write, cwd);
    return violations.length > 0 ? [2, violations] : [0, []];
  }

  runExplicit(artifact: string, filePath: string | null, cwd: string): [number, Dict] {
    artifact = artifact.trim();
    const defaultPath = defaultArtifactPath(artifact, cwd);
    const resolvedFile = filePath ? resolvePathRel(filePath, cwd) : defaultPath;
    const violations = this.validator.validateExplicit(artifact, resolvedFile, cwd);
    const payload: Dict = {
      command: "validate-artifact",
      status: violations.length > 0 ? "fail" : "pass",
      artifact,
      file: resolvedFile,
      docs_mapped_default: defaultPath || null,
      path_source: filePath ? "provided" : "docs_mapped_default",
      violations,
    };
    return violations.length > 0 ? [2, payload] : [0, payload];
  }
}

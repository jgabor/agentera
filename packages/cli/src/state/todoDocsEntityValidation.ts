import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { loadTodoReadinessContract, todoReadinessRecordViolations } from "../registries/todoReadinessContract.js";

export const TODO_SEVERITIES = ["critical", "degraded", "normal", "annoying"] as const;
export const TODO_STATUSES = ["open", "resolved"] as const;
export const TODO_KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const DOC_STATUSES = ["current", "stale", "missing", "intent", "generated"] as const;

const TODO_INPUT_FIELDS = new Set([
  "kind", "target_version", "title", "requirements", "acceptance", "release_blocker", "severity", "readiness",
]);
const TODO_CLEARABLE_FIELDS = new Set(["target_version", "requirements", "acceptance", "readiness"]);
const TODO_LIFECYCLE_REASON_MAX_CODE_POINTS = 500;

function mapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return [`${field} must be a list of strings`];
  return [];
}

function publicTodoViolations(record: JsonObject): string[] {
  const violations: string[] = [];
  const typed = record.title !== undefined || record.kind !== undefined || record.target_version !== undefined
    || record.requirements !== undefined || record.acceptance !== undefined || record.release_blocker !== undefined;
  if (!typed && (typeof record.description !== "string" || !record.description.trim())) violations.push("title or legacy description is required");
  if (typed) {
    if (typeof record.kind !== "string" || !TODO_KIND_RE.test(record.kind)) violations.push("kind must be a lowercase identifier of at most 32 characters");
    if (typeof record.title !== "string" || !record.title.trim()) violations.push("title is required");
    if (record.target_version !== undefined && record.target_version !== null && (typeof record.target_version !== "string" || !record.target_version.trim())) violations.push("target_version must be a non-empty string or null");
    if (record.requirements !== undefined) violations.push(...stringList(record.requirements, "requirements"));
    if (record.acceptance !== undefined) violations.push(...stringList(record.acceptance, "acceptance"));
    if (record.release_blocker !== undefined && typeof record.release_blocker !== "boolean") violations.push("release_blocker must be a boolean");
  }
  return violations;
}

export function todoInputViolations(input: JsonObject, mode: "create" | "update"): string[] {
  const violations: string[] = [];
  for (const field of Object.keys(input)) {
    if (!TODO_INPUT_FIELDS.has(field)) violations.push(`unsupported TODO input field '${field}'`);
  }
  if (mode === "create") {
    for (const field of ["kind", "target_version", "title", "requirements", "acceptance", "release_blocker", "severity"]) {
      if (!(field in input)) violations.push(`${field} is required in a full typed TODO record`);
    }
  } else if (Object.keys(input).length === 0) {
    violations.push("TODO update requires at least one patch field");
  }
  if (input.kind !== undefined && (typeof input.kind !== "string" || !TODO_KIND_RE.test(input.kind))) violations.push("kind must be a lowercase identifier of at most 32 characters");
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) violations.push("title must be a non-empty string");
  if (input.target_version !== undefined && input.target_version !== null && (typeof input.target_version !== "string" || !input.target_version.trim())) violations.push("target_version must be a non-empty string or null");
  if (input.requirements !== undefined && input.requirements !== null) violations.push(...stringList(input.requirements, "requirements"));
  if (input.acceptance !== undefined && input.acceptance !== null) violations.push(...stringList(input.acceptance, "acceptance"));
  if (input.release_blocker !== undefined && typeof input.release_blocker !== "boolean") violations.push("release_blocker must be a boolean; false is the typed non-blocking value");
  if (input.severity !== undefined && !TODO_SEVERITIES.includes(input.severity as typeof TODO_SEVERITIES[number])) violations.push(`severity must be one of: ${TODO_SEVERITIES.join(", ")}`);
  if (input.description !== undefined) violations.push("description is a retired legacy field; use title and the typed TODO record");
  if (mode === "update") {
    for (const field of ["kind", "title", "severity", "release_blocker", "description"]) if (input[field] === null) violations.push(`${field} cannot be cleared; omit it or supply a typed value`);
    for (const field of ["target_version", "requirements", "acceptance", "readiness"]) if (input[field] === null && !TODO_CLEARABLE_FIELDS.has(field)) violations.push(`${field} is not clearable`);
  }
  if (input.readiness !== undefined && input.readiness !== null) {
    const readiness = mapping(input.readiness) ? input.readiness : null;
    if (!readiness) violations.push("readiness must be a complete mapping or null");
    else {
      const dependencies = readiness.dependencies;
      const normalized = Array.isArray(dependencies)
        ? dependencies.map((dependency) => typeof dependency === "string" ? { artifact: "todo", id: dependency } : dependency)
        : dependencies;
      violations.push(...todoReadinessRecordViolations({ ...readiness, dependencies: normalized }));
    }
  }
  return [...new Set(violations)];
}

export function todoDocsRecordViolations(boundary: string, record: JsonObject, sourceRoot?: string): string[] {
  const violations: string[] = [];
  if (boundary === "todo_item") {
    if (!TODO_SEVERITIES.includes(record.severity as typeof TODO_SEVERITIES[number])) violations.push(`severity must be one of: ${TODO_SEVERITIES.join(", ")}`);
    if (!TODO_STATUSES.includes(record.status as typeof TODO_STATUSES[number])) violations.push(`status must be one of: ${TODO_STATUSES.join(", ")}`);
    violations.push(...publicTodoViolations(record));
    if (record.lifecycle !== undefined) {
      if (!mapping(record.lifecycle)) violations.push("lifecycle must be a mapping");
      else {
        const lifecycle = record.lifecycle;
        if (!["set-severity", "supersede", "resolve", "reopen"].includes(String(lifecycle.operation))) violations.push("lifecycle.operation is invalid");
        if (typeof lifecycle.reason !== "string" || !lifecycle.reason.trim()) violations.push("lifecycle.reason must be a non-empty string");
        else if ([...lifecycle.reason].length > TODO_LIFECYCLE_REASON_MAX_CODE_POINTS) violations.push(`lifecycle.reason must be at most ${TODO_LIFECYCLE_REASON_MAX_CODE_POINTS} code points`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lifecycle.date ?? ""))) violations.push("lifecycle.date must be YYYY-MM-DD");
        if (lifecycle.replacement !== undefined && !/^[a-z]{10}$/.test(String(lifecycle.replacement))) violations.push("lifecycle.replacement must be a ten-letter TODO ID");
      }
    }
    if (record.readiness !== undefined) {
      const contract = sourceRoot
        ? loadTodoReadinessContract(
          path.join(sourceRoot, "skills/agentera/schemas/artifacts/todo.yaml"),
          path.join(sourceRoot, "skills/agentera/protocol.yaml"),
          path.join(sourceRoot, "skills/agentera/capability_schema_contract.yaml"),
        )
        : undefined;
      violations.push(...todoReadinessRecordViolations(record.readiness, contract));
    }
  }
  if (boundary === "documentation_inventory_entry") {
    if (typeof record.document !== "string" || !record.document.trim()) violations.push("document is required");
    if (typeof record.path !== "string" || !record.path.trim()) violations.push("path is required record data");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(record.last_updated ?? ""))) violations.push("last_updated must be YYYY-MM-DD");
    if (!DOC_STATUSES.includes(record.status as typeof DOC_STATUSES[number])) violations.push(`status must be one of: ${DOC_STATUSES.join(", ")}`);
  }
  return violations;
}

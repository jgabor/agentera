import { createHash } from "node:crypto";

import type { JsonObject } from "../core/jsonValue.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { todoInputViolations } from "./todoDocsEntityValidation.js";
import { reject } from "./write/errors.js";

export const TODO_UPDATE_BATCH_VERSION = "agentera.todoUpdateBatch.v1";

const ID = /^[a-z]{10}$/;

export interface TodoUpdateBatchEntry {
  id: string;
  patch: JsonObject;
}

export interface TodoUpdateBatchInspection {
  strictEnvelope: boolean;
  updates: TodoUpdateBatchEntry[];
  violations: string[];
}

export interface TodoUpdateBatchEffectTarget {
  path: string;
  before_sha256: string | null;
  after_sha256: string;
}

function mapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function inspectTodoUpdateBatch(input: Record<string, unknown> | null): TodoUpdateBatchInspection | null {
  if (!input || input.schema_version !== TODO_UPDATE_BATCH_VERSION) return null;
  const strictEnvelope = Object.keys(input).sort().join(",") === "schema_version,updates" && Array.isArray(input.updates);
  const violations: string[] = [];
  if (Object.keys(input).sort().join(",") !== "schema_version,updates") violations.push("batch envelope must contain exactly schema_version and updates");
  if (!Array.isArray(input.updates) || input.updates.length < 1 || input.updates.length > 256) violations.push("updates must contain 1 to 256 entries");
  const updates = (Array.isArray(input.updates) ? input.updates : []).map((value, index) => {
    if (!mapping(value) || Object.keys(value).sort().join(",") !== "id,patch" || !ID.test(String(value.id ?? "")) || !mapping(value.patch)) {
      violations.push(`updates[${index}] must contain exactly one bare id and one patch mapping`);
      return { id: "", patch: {} as JsonObject };
    }
    violations.push(...todoInputViolations(value.patch, "update").map((item) => `updates[${index}].patch: ${item}`));
    return { id: String(value.id), patch: value.patch };
  });
  const seen = new Set<string>();
  for (const { id } of updates) {
    if (id && seen.has(id)) violations.push(`duplicate update target '${id}'`);
    seen.add(id);
  }
  return { strictEnvelope, updates, violations };
}

export function parseTodoUpdateBatch(input: Record<string, unknown> | null): TodoUpdateBatchEntry[] | null {
  const inspected = inspectTodoUpdateBatch(input);
  if (!inspected) return null;
  if (inspected.violations.length) reject({ class: "schema_violation", message: "todo update batch input is invalid", violations: inspected.violations, recovery: "Correct the strict agentera.todoUpdateBatch.v1 envelope, then preview it again; no state was changed." });
  return inspected.updates;
}

export function todoUpdateBatchEffectSha256(
  input: JsonObject,
  mappingSha256: string,
  targets: TodoUpdateBatchEffectTarget[],
): string {
  return createHash("sha256").update(canonicalRecordJson({
    schema_version: TODO_UPDATE_BATCH_VERSION,
    input,
    mapping_sha256: mappingSha256,
    targets,
  })).digest("hex");
}

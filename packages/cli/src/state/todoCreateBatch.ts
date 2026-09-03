import { createHash } from "node:crypto";

import type { JsonObject } from "../core/jsonValue.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { todoInputViolations } from "./todoDocsEntityValidation.js";
import { reject } from "./write/errors.js";

export const TODO_CREATE_BATCH_VERSION = "agentera.todoCreateBatch.v1";

export interface TodoCreateBatchEntry {
  local_ref: string;
  record: JsonObject;
}
export interface TodoCreateBatchInspection {
  strictEnvelope: boolean;
  creates: TodoCreateBatchEntry[];
  violations: string[];
}
export interface TodoCreateBatchEffectTarget {
  path: string;
  before_sha256: string | null;
  after_sha256: string;
}

function mapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function inspectTodoCreateBatch(input: Record<string, unknown> | null): TodoCreateBatchInspection | null {
  if (!input || input.schema_version !== TODO_CREATE_BATCH_VERSION) return null;
  const strictEnvelope = Object.keys(input).sort().join(",") === "creates,schema_version" && Array.isArray(input.creates);
  const violations: string[] = [];
  if (!strictEnvelope) violations.push("batch envelope must contain exactly schema_version and creates");
  if (!Array.isArray(input.creates) || input.creates.length < 1 || input.creates.length > 256) violations.push("creates must contain 1 to 256 entries");
  const creates = (Array.isArray(input.creates) ? input.creates : []).map((value, index) => {
    if (!mapping(value) || Object.keys(value).sort().join(",") !== "local_ref,record" || typeof value.local_ref !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.local_ref) || !mapping(value.record)) {
      violations.push(`creates[${index}] must contain exactly one valid local_ref and one record mapping`);
      return { local_ref: "", record: {} as JsonObject };
    }
    const validationRecord = structuredClone(value.record);
    if (mapping(validationRecord.readiness) && Array.isArray(validationRecord.readiness.dependencies))
      validationRecord.readiness.dependencies = validationRecord.readiness.dependencies.map((dependency) => (mapping(dependency) && typeof dependency.local_ref === "string" ? { artifact: "todo", id: "aaaaaaaaaa" } : dependency));
    violations.push(...todoInputViolations(validationRecord, "create").map((item) => `creates[${index}].record: ${item}`));
    return { local_ref: value.local_ref, record: value.record };
  });
  const refs = new Set<string>();
  for (const { local_ref } of creates) {
    if (local_ref && refs.has(local_ref)) violations.push(`duplicate local reference '${local_ref}'`);
    refs.add(local_ref);
  }
  for (const [index, { record }] of creates.entries()) {
    const dependencies = mapping(record.readiness) ? record.readiness.dependencies : undefined;
    if (!Array.isArray(dependencies)) continue;
    for (const dependency of dependencies) {
      if (mapping(dependency) && Object.keys(dependency).sort().join(",") === "artifact,id" && dependency.artifact === "todo" && typeof dependency.id === "string" && /^[a-z]{10}$/.test(dependency.id)) continue;
      if (mapping(dependency) && Object.keys(dependency).join(",") === "local_ref" && typeof dependency.local_ref === "string" && refs.has(dependency.local_ref)) continue;
      violations.push(`creates[${index}].record.readiness.dependencies contains a missing or invalid local reference`);
    }
  }
  const edges = new Map(creates.map(({ local_ref, record }) => [local_ref, (mapping(record.readiness) && Array.isArray(record.readiness.dependencies) ? record.readiness.dependencies : []).flatMap((value) => (mapping(value) && typeof value.local_ref === "string" ? [value.local_ref] : []))]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = (ref: string): boolean => {
    if (visiting.has(ref)) return true;
    if (visited.has(ref)) return false;
    visiting.add(ref);
    const found = (edges.get(ref) ?? []).some(cyclic);
    visiting.delete(ref);
    visited.add(ref);
    return found;
  };
  if ([...edges.keys()].some(cyclic)) violations.push("request-local dependency graph contains a cycle");
  return { strictEnvelope, creates, violations: [...new Set(violations)] };
}

export function parseTodoCreateBatch(input: Record<string, unknown> | null): TodoCreateBatchEntry[] | null {
  const inspected = inspectTodoCreateBatch(input);
  if (!inspected) return null;
  if (inspected.violations.length)
    reject({
      class: "schema_violation",
      message: "todo create batch input is invalid",
      violations: inspected.violations,
      recovery: "Correct the strict agentera.todoCreateBatch.v1 envelope, then preview it again; no state was changed.",
    });
  return inspected.creates;
}

export function resolveTodoCreateBatchRecords(entries: TodoCreateBatchEntry[], ids: Map<string, string>): TodoCreateBatchEntry[] {
  return entries.map(({ local_ref, record }) => {
    const copy = structuredClone(record);
    if (mapping(copy.readiness) && Array.isArray(copy.readiness.dependencies)) copy.readiness.dependencies = copy.readiness.dependencies.map((value) => (mapping(value) && "local_ref" in value ? { artifact: "todo", id: ids.get(String(value.local_ref))! } : value));
    return { local_ref, record: copy };
  });
}

export function todoCreateBatchEffectSha256(input: JsonObject, mappingSha256: string, localRefs: Record<string, string>, targets: TodoCreateBatchEffectTarget[]): string {
  return createHash("sha256")
    .update(
      canonicalRecordJson({
        schema_version: TODO_CREATE_BATCH_VERSION,
        input,
        mapping_sha256: mappingSha256,
        local_refs: localRefs,
        targets,
      }),
    )
    .digest("hex");
}

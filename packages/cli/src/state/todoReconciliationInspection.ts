import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { renderTodoPublicRecord } from "../cli/todoMarkdown.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { detectStateMode } from "./stateMode.js";
import { StateWriteInputError } from "./write/errors.js";
import type { EntityDiscoveryResult } from "./entityStorage.js";
import {
  TODO_ACTIVATION_APPLY_COMMAND,
  TODO_ACTIVATION_PREVIEW_COMMAND,
  TODO_OWNER_CORRECTION_APPLY_COMMAND,
  TODO_OWNER_CORRECTION_PREVIEW_COMMAND,
  TODO_RECONCILIATION_ACTIVATION_PATH,
  TODO_REPAIR_APPLY_COMMAND,
  TODO_REPAIR_PREVIEW_COMMAND,
  TODO_UNSAFE_INACTIVE_RECOVERY,
  loadTodoReconciliationActivation,
  todoReconciliationActivationBytes,
} from "./todoReconciliationActivation.js";
import { planTodoRepair } from "./todoReconciliationRepair.js";
import { readTodoMarkdown } from "./todoMarkdownProjection.js";
import { inactiveTodoActivationSafety } from "./todoActivationSafety.js";
import { managedRows, relevant, todoPublicPath, type ManagedRow } from "./todoDocsEntities.js";

export type TodoReconciliationState = "inactive" | "unsafe_inactive" | "healthy_active" | "unsafe_active" | "invalid_lifecycle";

export interface TodoReconciliationInspection {
  state: TodoReconciliationState;
  status: "operable" | "action_required";
  counts: {
    matched: number;
    converted: number;
    retained: number;
    duplicate: number;
    stale: number;
    conflicting: number;
  };
  omitted_count: number;
  risks?: JsonObject;
  preview_command: string | null;
  apply_command: string | null;
  recovery_command: string;
}

const DIAGNOSTIC_LIMIT = 20;

function mapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function boundedCounts(value: JsonObject): TodoReconciliationInspection["counts"] & { omitted: number } {
  const raw = {
    matched: numberValue(value.matched),
    converted: numberValue(value.converted),
    retained: numberValue(value.retained),
    duplicate: numberValue(value.duplicate),
    stale: numberValue(value.stale),
    conflicting: numberValue(value.conflicting),
  };
  const counts = Object.fromEntries(
    Object.entries(raw).map(([key, count]) => [key, Math.min(count, DIAGNOSTIC_LIMIT)]),
  ) as TodoReconciliationInspection["counts"];
  const omitted = Object.values(raw).reduce(
    (total, count) => total + Math.max(0, count - DIAGNOSTIC_LIMIT),
    numberValue(value.omitted_count),
  );
  return { ...counts, omitted: Math.min(DIAGNOSTIC_LIMIT, omitted) };
}

function recovery(preview: string, apply: string): string {
  return `Run exactly '${preview}', review its bounded read-only effect, then run exactly the preview's exact apply_command (the supported form is '${apply}'); no state was changed.`;
}

function invalidLifecycle(): TodoReconciliationInspection {
  return {
    state: "invalid_lifecycle",
    status: "action_required",
    counts: { matched: 0, converted: 0, retained: 0, duplicate: 0, stale: 0, conflicting: 0 },
    omitted_count: 0,
    preview_command: null,
    apply_command: null,
    recovery_command: "Restore the valid committed TODO reconciliation lifecycle metadata, then rerun `npx -y agentera@next check validate state --format json`; no state was changed.",
  };
}

function inspection(state: TodoReconciliationState, rawCounts: JsonObject, risks?: JsonObject): TodoReconciliationInspection {
  const bounded = boundedCounts(rawCounts);
  const active = state === "healthy_active" || state === "unsafe_active";
  const preview = state === "unsafe_inactive" ? TODO_OWNER_CORRECTION_PREVIEW_COMMAND : state === "inactive" ? TODO_ACTIVATION_PREVIEW_COMMAND : active ? TODO_REPAIR_PREVIEW_COMMAND : null;
  const apply = state === "unsafe_inactive" ? TODO_OWNER_CORRECTION_APPLY_COMMAND : state === "inactive" ? TODO_ACTIVATION_APPLY_COMMAND : active ? TODO_REPAIR_APPLY_COMMAND : null;
  return {
    state,
    status: state === "healthy_active" ? "operable" : "action_required",
    counts: {
      matched: bounded.matched,
      converted: bounded.converted,
      retained: bounded.retained,
      duplicate: bounded.duplicate,
      stale: bounded.stale,
      conflicting: bounded.conflicting,
    },
    omitted_count: bounded.omitted,
    ...(risks === undefined ? {} : { risks }),
    preview_command: preview,
    apply_command: apply,
    recovery_command: state === "unsafe_inactive" ? TODO_UNSAFE_INACTIVE_RECOVERY : preview && apply ? recovery(preview, apply) : "",
  };
}

function errorCounts(error: unknown): JsonObject {
  if (!(error instanceof StateWriteInputError) || !mapping(error.body.diagnosis)) return { conflicting: 1 };
  const diagnosis = error.body.diagnosis;
  return {
    ...(mapping(diagnosis.counts) ? diagnosis.counts : { conflicting: 1 }),
    ...(diagnosis.omitted_count !== undefined ? { omitted_count: diagnosis.omitted_count } : {}),
  };
}

/** Read-only classification shared by prime, doctor, and whole-state validation. */
export function inspectTodoReconciliationState(
  root: string,
  sourceRoot = resolveSourceRoot(),
  discovery?: EntityDiscoveryResult,
): TodoReconciliationInspection | null {
  try {
    if (detectStateMode(root, sourceRoot) !== "entities") return null;
  } catch {
    return invalidLifecycle();
  }
  const activationPath = path.join(root, TODO_RECONCILIATION_ACTIVATION_PATH);
  if (!fs.existsSync(activationPath)) {
    try {
      if (!fs.existsSync(todoPublicPath(root, sourceRoot))) return null;
    } catch {
      return null;
    }
  }
  const entities = relevant(root, sourceRoot, "todo", discovery).filter(({ boundary }) => boundary === "todo_item");
  let activation: ReturnType<typeof loadTodoReconciliationActivation>;
  try {
    activation = loadTodoReconciliationActivation(root);
  } catch {
    return invalidLifecycle();
  }
  if (!activation) {
    try {
      const scan = managedRows(readTodoMarkdown(todoPublicPath(root, sourceRoot)).text, null, entities);
      if (entities.length === 0 && scan.matchedRows === 0 && scan.retainedLegacyRows.length === 0) return null;
      const safety = inactiveTodoActivationSafety(scan, entities);
      return inspection(safety.safe ? "inactive" : "unsafe_inactive", safety.counts, safety.safe ? undefined : safety.risks);
    } catch (error) {
      return inspection("unsafe_inactive", errorCounts(error));
    }
  }
  try {
    const plan = planTodoRepair(readTodoMarkdown(todoPublicPath(root, sourceRoot)).text, activation.record, entities);
    const counts = mapping(plan.diagnosis.counts) ? plan.diagnosis.counts : {};
    const unsafe = numberValue(counts.duplicate) > 0 || numberValue(counts.stale) > 0 || numberValue(counts.conflicting) > 0;
    return inspection(unsafe ? "unsafe_active" : "healthy_active", counts);
  } catch (error) {
    return inspection("unsafe_active", errorCounts(error));
  }
}

function publicSnapshot(record: JsonObject, order?: number): Record<string, unknown> {
  return { present: true, description: renderTodoPublicRecord(record), severity: String(record.severity), status: String(record.status), ...(order === undefined ? {} : { order }) };
}

function baseline(record: JsonObject): Record<string, unknown> | null {
  const reconciliation = record.reconciliation;
  if (!mapping(reconciliation) || reconciliation.schema_version !== "agentera.todoReconciliation.v1" || !mapping(reconciliation.public)) return null;
  return structuredClone(reconciliation.public) as Record<string, unknown>;
}

function rowSnapshot(row: ManagedRow, record: JsonObject): Record<string, unknown> {
  return { ...row.snapshot, severity: row.section === "resolved" ? String(record.severity) : row.snapshot.severity };
}

function samePublic(left: Record<string, unknown>, right: Record<string, unknown>, includeOrder = true): boolean {
  const fields = includeOrder ? ["present", "description", "severity", "status", "order"] : ["present", "description", "severity", "status"];
  return fields.every((field) => left[field] === right[field]);
}

export function todoCutoverPublicProjectionViolations(
  markdown: string,
  targets: readonly { id: string; record: JsonObject }[],
): string[] {
  let rows: Map<string, ManagedRow>;
  try {
    const activation = JSON.parse(todoReconciliationActivationBytes([]));
    rows = managedRows(markdown, activation, targets.map(({ id, record }) => ({ boundary: "todo_item", id, record }))).rows;
  } catch (error) {
    return [error instanceof StateWriteInputError ? error.body.message : (error as Error).message];
  }
  const targetIds = new Set(targets.map(({ id }) => id));
  if (targetIds.size !== targets.length) return ["pending TODO cutover target IDs are not unique"];
  const unexpected = [...rows.keys()].find((id) => !targetIds.has(id));
  if (unexpected) return [`final managed TODO Markdown ID '${unexpected}' has no journal entity target`];
  for (const { id, record } of targets) {
    const row = rows.get(id);
    if (!row) return [`journal TODO entity '${id}' has no final managed Markdown row`];
    const projected = rowSnapshot(row, record);
    const prior = baseline(record);
    if (!prior || canonicalRecordJson(prior) !== canonicalRecordJson(projected)) return [`journal TODO entity '${id}' has no exact final public baseline`];
    if (!samePublic(publicSnapshot(record), projected, false)) return [`journal TODO entity '${id}' public values do not match its final managed Markdown row`];
  }
  return rows.size === targets.length ? [] : ["final managed TODO Markdown rows do not match the journal entity target set"];
}

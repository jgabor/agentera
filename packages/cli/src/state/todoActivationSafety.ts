import type { JsonObject } from "../core/jsonValue.js";
import { renderTodoPublicRecord } from "../cli/todoMarkdown.js";
import { todoActivationRisks, TODO_UNSAFE_INACTIVE_RECOVERY } from "./todoReconciliationActivation.js";
import { reject } from "./write/errors.js";

interface TodoPublicSnapshot {
  present: boolean;
  description?: string;
  severity?: string;
  status?: string;
  order?: number;
}

export interface TodoActivationRow {
  section: string;
  snapshot: TodoPublicSnapshot;
  item: { id?: string | null };
}

export interface TodoActivationEntity {
  boundary?: string | null;
  id?: string | null;
  record?: JsonObject | null;
}

export interface InactiveTodoActivationSafety {
  safe: boolean;
  counts: JsonObject;
  risks: JsonObject;
  resurrectedIds: string[];
}

function publicSnapshot(record: JsonObject): TodoPublicSnapshot {
  return {
    present: true,
    description: renderTodoPublicRecord(record),
    severity: String(record.severity),
    status: String(record.status),
  };
}

function rowSnapshot(row: TodoActivationRow, record: JsonObject): TodoPublicSnapshot {
  return {
    ...row.snapshot,
    severity: row.section === "resolved" ? String(record.severity) : row.snapshot.severity,
  };
}

function samePublic(left: TodoPublicSnapshot, right: TodoPublicSnapshot): boolean {
  return ["present", "description", "severity", "status"].every((field) => left[field as keyof TodoPublicSnapshot] === right[field as keyof TodoPublicSnapshot]);
}

export function unsafeInactiveDuplicateDiagnosis(conflicting = 0): JsonObject {
  return {
    counts: { matched: 0, converted: 0, retained: 0, duplicate: 1, stale: 0, conflicting },
    risks: todoActivationRisks([]),
  };
}

/** The one read-only decision that gates both activation preview and apply. */
export function inactiveTodoActivationSafety(
  scan: {
    rows: ReadonlyMap<string, TodoActivationRow>;
    retainedLegacyRows: readonly string[];
    matchedRows: number;
    convertedRows: number;
  },
  entities: readonly TodoActivationEntity[],
): InactiveTodoActivationSafety {
  const todoEntities = entities.filter(({ boundary, id, record }) => boundary === "todo_item" && id && record);
  const entityIds = new Set(todoEntities.map(({ id }) => id!));
  const unmatched = todoEntities.filter(({ id }) => !scan.rows.has(id!));
  const stale = todoEntities.filter(({ id, record }) => {
    const row = scan.rows.get(id!);
    return row !== undefined && !samePublic(publicSnapshot(record!), rowSnapshot(row, record!));
  });
  const orphaned = [...scan.rows.keys()].filter((id) => !entityIds.has(id));
  const resurrectedIds = todoEntities
    .filter(({ id, record }) => {
      const row = scan.rows.get(id!);
      return row === undefined ? record!.status === "open" : record!.status === "resolved" && !row.item.id;
    })
    .map(({ id }) => id!)
    .sort();
  const counts: JsonObject = {
    matched: scan.matchedRows,
    converted: scan.convertedRows,
    retained: scan.retainedLegacyRows.length,
    duplicate: 0,
    stale: stale.length,
    conflicting: unmatched.length + orphaned.length,
  };
  return {
    safe: unmatched.length === 0 && stale.length === 0 && orphaned.length === 0 && resurrectedIds.length === 0,
    counts,
    risks: todoActivationRisks(resurrectedIds),
    resurrectedIds,
  };
}

export function rejectUnsafeInactiveTodoActivation(safety: InactiveTodoActivationSafety): never {
  reject({
    class: "conflict",
    message: "TODO activation requires complete one-to-one inactive public projections",
    diagnosis: { counts: safety.counts, risks: safety.risks },
    recovery: TODO_UNSAFE_INACTIVE_RECOVERY,
  });
}

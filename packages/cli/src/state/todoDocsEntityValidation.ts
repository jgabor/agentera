import type { JsonObject } from "../core/jsonValue.js";

export const TODO_SEVERITIES = ["critical", "degraded", "normal", "annoying"] as const;
export const TODO_STATUSES = ["open", "resolved"] as const;
export const DOC_STATUSES = ["current", "stale", "missing", "intent", "generated"] as const;

export function todoDocsRecordViolations(boundary: string, record: JsonObject): string[] {
  const violations: string[] = [];
  if (boundary === "todo_item") {
    if (!TODO_SEVERITIES.includes(record.severity as typeof TODO_SEVERITIES[number])) violations.push(`severity must be one of: ${TODO_SEVERITIES.join(", ")}`);
    if (!TODO_STATUSES.includes(record.status as typeof TODO_STATUSES[number])) violations.push(`status must be one of: ${TODO_STATUSES.join(", ")}`);
    if (typeof record.description !== "string" || !record.description.trim()) violations.push("description is required");
  }
  if (boundary === "documentation_inventory_entry") {
    if (typeof record.document !== "string" || !record.document.trim()) violations.push("document is required");
    if (typeof record.path !== "string" || !record.path.trim()) violations.push("path is required record data");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(record.last_updated ?? ""))) violations.push("last_updated must be YYYY-MM-DD");
    if (!DOC_STATUSES.includes(record.status as typeof DOC_STATUSES[number])) violations.push(`status must be one of: ${DOC_STATUSES.join(", ")}`);
  }
  return violations;
}

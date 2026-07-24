import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { loadTodoReadinessContract, todoReadinessRecordViolations } from "../registries/todoReadinessContract.js";

export const TODO_SEVERITIES = ["critical", "degraded", "normal", "annoying"] as const;
export const TODO_STATUSES = ["open", "resolved"] as const;
export const DOC_STATUSES = ["current", "stale", "missing", "intent", "generated"] as const;

export function todoDocsRecordViolations(boundary: string, record: JsonObject, sourceRoot?: string): string[] {
  const violations: string[] = [];
  if (boundary === "todo_item") {
    if (!TODO_SEVERITIES.includes(record.severity as typeof TODO_SEVERITIES[number])) violations.push(`severity must be one of: ${TODO_SEVERITIES.join(", ")}`);
    if (!TODO_STATUSES.includes(record.status as typeof TODO_STATUSES[number])) violations.push(`status must be one of: ${TODO_STATUSES.join(", ")}`);
    if (typeof record.description !== "string" || !record.description.trim()) violations.push("description is required");
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

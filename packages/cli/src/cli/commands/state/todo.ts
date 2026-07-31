import type { SchemaInfo } from "../../appContext.js";
import { emitStructured } from "../../structured.js";
import { TODO_SEVERITY_ORDER_KEYS } from "../../todoSeverity.js";
import { renderTodoPublicRecord } from "../../todoMarkdown.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { listTodoDocsEntities } from "../../../state/todoDocsEntities.js";
import YAML from "yaml";
import { err, out, type Io, type StateArgs } from "./shared.js";

export function normalizeSeverity(value: unknown, deflt = "normal"): string {
  const text = String(value || deflt).toLowerCase();
  for (const key of TODO_SEVERITY_ORDER_KEYS) {
    if (text.includes(key)) return key;
  }
  return deflt;
}

export function queryTodo(
  args: StateArgs,
  _schemas: Record<string, SchemaInfo>,
  io: Io,
  openOnly = false,
): number {
  const output = out(io);
  const format = args.format ?? "text";
  try {
    const response = listTodoDocsEntities(process.cwd(), "todo", args.limit ?? undefined, undefined, {
      ...(args.severity ? { severity: args.severity } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(openOnly ? { status: "open" } : {}),
    }, { format });
    if (format === "json" || format === "yaml") emitStructured(response, format, output);
    else for (const entry of response.entries as Array<{ id: string; record: Record<string, unknown> & { severity: string; status: string } }>) {
      output(`[${entry.record.severity}] ${entry.id} ${entry.record.status}: ${renderTodoPublicRecord(entry.record)}\n`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof StateRetrievalFailure)) throw error;
    if (format === "json" || format === "yaml") emitStructured(error.body, format, output);
    else err(io)(YAML.stringify(error.body));
    return error.exitCode;
  }
}

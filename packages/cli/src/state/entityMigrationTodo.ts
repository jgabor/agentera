import { createHash } from "node:crypto";

import type { JsonObject } from "../core/jsonValue.js";
import { parseTodoMarkdownListItem, renderTodoPublicRecord } from "../cli/todoMarkdown.js";
import { discoverEntities } from "./entityStorage.js";
import { todoDocsRecordViolations } from "./todoDocsEntityValidation.js";
import { TODO_RECONCILIATION_ACTIVATION_PATH, todoReconciliationActivationBytes } from "./todoReconciliationActivation.js";

type MigrationSourceFile =
  | {
      relative: string;
      bytes: Buffer;
      kind: "file";
      dev: bigint;
      ino: bigint;
      type: "file";
      mode: number;
    }
  | { relative: string; bytes: null; kind: "missing" | "unsafe" };

interface MigrationObservation {
  key: string;
  artifact: string;
  boundary: string;
  path: string;
  provenance: string;
  record: JsonObject | null;
  detail: "full" | "summary" | "corrupt";
  relationships: Array<{ field: string; target: string | null }>;
  message?: string;
  explicitId?: string;
}

interface MigrationTodoRow {
  index: number;
  section: string;
  order: number;
  item: NonNullable<ReturnType<typeof parseTodoMarkdownListItem>>;
  record: JsonObject;
}

interface TodoMigrationEntry {
  source_identity: string;
  boundary: string | null;
  proposed_target: { id: string; path: string } | null;
  record: JsonObject;
}

export interface TodoReconciliationMigrationPlan {
  public_path: string;
  mapping_sha256: string;
  markdown_before_base64: string;
  markdown_after: string;
  activation_after: string;
}

function migrationTodoRows(text: string): MigrationTodoRow[] {
  let section = "normal";
  const orders = new Map<string, number>();
  const rows: MigrationTodoRow[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const heading = line
      .trim()
      .match(/^##\s+(.+)$/)?.[1]
      ?.toLowerCase();
    if (heading) {
      if (heading.includes("critical")) section = "critical";
      else if (heading.includes("degraded")) section = "degraded";
      else if (heading.includes("annoying")) section = "annoying";
      else if (heading.includes("resolved")) section = "resolved";
      else if (heading.includes("normal")) section = "normal";
      else if (heading === "notes") section = "unmanaged";
    }
    const item = parseTodoMarkdownListItem(line.trim());
    if (!item || section === "unmanaged") return;
    const severity = section === "resolved" ? "normal" : section;
    const order = (orders.get(section) ?? 0) + 1;
    orders.set(section, order);
    const record: JsonObject =
      item.kind && item.kind !== "x"
        ? {
            kind: item.kind,
            target_version: item.target_version ?? null,
            title: item.title ?? item.description,
            requirements: [],
            acceptance: [],
            release_blocker: false,
            severity,
            status: item.status,
          }
        : {
            severity,
            status: item.status,
            description: item.public_description ?? item.description,
          };
    rows.push({ index, section, order, item, record });
  });
  return rows;
}

function importMigrationTodoPublic(entity: JsonObject, row: MigrationTodoRow): JsonObject {
  const record = structuredClone(entity);
  if (row.record.title !== undefined) {
    delete record.description;
    record.kind = row.record.kind;
    record.target_version = row.record.target_version;
    record.title = row.record.title;
  } else {
    for (const field of ["kind", "target_version", "title"]) delete record[field];
    record.description = row.record.description;
  }
  if (row.section !== "resolved") record.severity = row.record.severity;
  record.status = row.record.status;
  return record;
}

export function todoMigrationObservations(root: string, sourceRoot: string, todoPath: string, files: readonly MigrationSourceFile[]): MigrationObservation[] {
  const observations: MigrationObservation[] = [];
  const todo = files.find((source) => source.relative === todoPath);
  const activation = files.find((source) => source.relative === TODO_RECONCILIATION_ACTIVATION_PATH);
  if (activation?.kind === "file")
    observations.push({
      key: "todo:activation:stale",
      artifact: "todo",
      boundary: "todo_item",
      path: TODO_RECONCILIATION_ACTIVATION_PATH,
      provenance: "preexisting_activation",
      record: null,
      detail: "corrupt",
      relationships: [],
      message: "TODO reconciliation activation exists before entity cutover",
    });
  if (todo?.kind === "file" && todo.bytes) {
    const rows = migrationTodoRows(todo.bytes.toString("utf8"));
    const existing = discoverEntities(root, sourceRoot).entities.filter((entity) => entity.boundary === "todo_item");
    if (existing.length > 0) {
      const invalid = existing.find((entity) => entity.classification !== "valid" || !entity.id || !entity.record);
      if (invalid)
        observations.push({
          key: `todo:entity:invalid:${invalid.relativePath}`,
          artifact: "todo",
          boundary: "todo_item",
          path: invalid.relativePath,
          provenance: "precreated_entity",
          record: null,
          detail: "corrupt",
          relationships: [],
          message: "pre-created TODO entity evidence is not canonical",
        });
      const claimed = new Set<string>();
      for (const row of rows) {
        let matches = existing.filter((entity) => entity.classification === "valid" && entity.id && entity.record && !claimed.has(entity.id));
        if (row.item.id) matches = matches.filter((entity) => entity.id === row.item.id);
        else matches = matches.filter((entity) => renderTodoPublicRecord(entity.record!) === (row.item.public_description ?? row.item.description) && (row.section === "resolved" || entity.record!.severity === row.record.severity));
        if (matches.length !== 1) {
          observations.push({
            key: `todo:row:${row.index + 1}`,
            artifact: "todo",
            boundary: "todo_item",
            path: todoPath,
            provenance: "precreated_entity_match",
            record: null,
            detail: "corrupt",
            relationships: [],
            message: matches.length === 0 ? `TODO.md line ${row.index + 1} has no one-to-one canonical entity match` : `TODO.md line ${row.index + 1} has multiple canonical entity matches`,
          });
          continue;
        }
        const entity = matches[0]!;
        claimed.add(entity.id!);
        const record = importMigrationTodoPublic(entity.record!, row);
        const violations = todoDocsRecordViolations("todo_item", record, sourceRoot);
        observations.push({
          key: `${todoPath}:line:${row.index + 1}`,
          artifact: "todo",
          boundary: "todo_item",
          path: todoPath,
          provenance: "precreated_entity_match",
          record,
          detail: violations.length ? "corrupt" : "full",
          relationships: [],
          message: violations.length ? violations.join("; ") : undefined,
          explicitId: entity.id!,
        });
      }
      for (const entity of existing)
        if (entity.id && !claimed.has(entity.id))
          observations.push({
            key: `todo:entity:unmatched:${entity.id}`,
            artifact: "todo",
            boundary: "todo_item",
            path: entity.relativePath,
            provenance: "precreated_entity_match",
            record: null,
            detail: "corrupt",
            relationships: [],
            message: `canonical TODO entity '${entity.id}' has no one-to-one TODO.md row match`,
          });
    } else {
      for (const row of rows) {
        const violations = todoDocsRecordViolations("todo_item", row.record, sourceRoot);
        observations.push({
          key: `${todoPath}:line:${row.index + 1}`,
          artifact: "todo",
          boundary: "todo_item",
          path: todoPath,
          provenance: "current_canonical",
          record: row.record,
          detail: violations.length ? "corrupt" : "full",
          relationships: [],
          message: violations.length ? violations.join("; ") : undefined,
        });
      }
    }
  } else if (todo?.kind === "unsafe")
    observations.push({
      key: "todo:document",
      artifact: "todo",
      boundary: "todo_item",
      path: todoPath,
      provenance: "current_canonical",
      record: null,
      detail: "corrupt",
      relationships: [],
      message: `source path '${todoPath}' is a symbolic link, non-file, or unreadable; replace it with a readable regular file inside the project`,
    });
  return observations;
}

export function todoReconciliationMigrationPlan(todoPath: string, files: readonly MigrationSourceFile[], entries: TodoMigrationEntry[]): TodoReconciliationMigrationPlan | undefined {
  const todo = files.find((source) => source.relative === todoPath);
  if (todo?.kind !== "file" || !todo.bytes) return undefined;
  const rows = migrationTodoRows(todo.bytes.toString("utf8"));
  const byLine = new Map(
    entries
      .filter((entry) => entry.boundary === "todo_item" && entry.proposed_target)
      .flatMap((entry) => {
        const match = new RegExp(`^${todoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:line:(\\d+)$`).exec(entry.source_identity);
        return match ? [[Number(match[1]) - 1, entry] as const] : [];
      }),
  );
  if (byLine.size !== rows.length) return undefined;
  const lines = todo.bytes
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => (line === "## Resolved" ? "## ✓ Resolved" : line));
  for (const row of rows) {
    const entry = byLine.get(row.index);
    if (!entry?.proposed_target) return undefined;
    const record = structuredClone(entry.record);
    record.reconciliation = {
      schema_version: "agentera.todoReconciliation.v1",
      public: {
        present: true,
        description: renderTodoPublicRecord(record),
        severity: String(record.severity),
        status: String(record.status),
        order: row.order,
      },
    };
    entry.record = record;
    if (!row.item.id) lines[row.index] = lines[row.index]!.replace(/^(\s*-\s+\[[ xX]\]\s+)/, `$1[id:${entry.proposed_target.id}] `);
  }
  const docs = files.find((source) => source.relative === ".agentera/docs.yaml");
  const mappingBytes = docs?.kind === "file" ? docs.bytes : Buffer.from("<absent>");
  return {
    public_path: todoPath,
    mapping_sha256: createHash("sha256").update(todoPath).update("\0").update(mappingBytes).digest("hex"),
    markdown_before_base64: todo.bytes.toString("base64"),
    markdown_after: `${lines.join("\n").replace(/\n*$/, "")}\n`,
    activation_after: todoReconciliationActivationBytes([]),
  };
}

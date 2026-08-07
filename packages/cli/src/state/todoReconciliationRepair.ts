import type { JsonObject } from "../core/jsonValue.js";
import { parseTodoMarkdownListItem, renderTodoPublicRecord } from "../cli/todoMarkdown.js";
import { reject } from "./write/errors.js";
import { todoLegacyRowFingerprint, TODO_REPAIR_PREVIEW_COMMAND, type TodoReconciliationActivation } from "./todoReconciliationActivation.js";

const RECONCILIATION_VERSION = "agentera.todoReconciliation.v1";
const DIAGNOSTIC_LIMIT = 20;
interface Snapshot { present: boolean; description?: string; severity?: string; status?: string; order?: number }
interface Row { line: number; section: string; sourceLine: string; snapshot: Snapshot; item: NonNullable<ReturnType<typeof parseTodoMarkdownListItem>> }
interface ManagedRow extends Row { id: string }
interface Entity { id: string | null; record: JsonObject | null }
export interface TodoRepairPlan { records: Map<string, JsonObject>; retainedLegacyRows: string[]; rendered: string; diagnosis: JsonObject }

function mapping(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function severity(section: string): string | null { return ["critical", "degraded", "normal", "annoying"].includes(section) ? section : null; }
function baseline(record: JsonObject): Snapshot | null {
  const reconciliation = mapping(record.reconciliation) ? record.reconciliation : null;
  const value = reconciliation?.schema_version === RECONCILIATION_VERSION && mapping(reconciliation.public) ? reconciliation.public : null;
  return value && typeof value.present === "boolean" ? structuredClone(value) as unknown as Snapshot : null;
}
function publicSnapshot(record: JsonObject): Snapshot { return { present: true, description: renderTodoPublicRecord(record), severity: String(record.severity), status: String(record.status) }; }
function rowSnapshot(row: Row, record: JsonObject): Snapshot { return { ...row.snapshot, severity: row.section === "resolved" ? String(record.severity) : row.snapshot.severity }; }
function samePublic(left: Snapshot, right: Snapshot): boolean { return ["present", "description", "severity", "status"].every((field) => left[field as keyof Snapshot] === right[field as keyof Snapshot]); }
function withBaseline(record: JsonObject, value: Snapshot): JsonObject { return { ...record, reconciliation: { schema_version: RECONCILIATION_VERSION, public: Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) } }; }
function importMarkdown(record: JsonObject, row: Row): JsonObject {
  const result = structuredClone(record); const description = row.item.public_description ?? row.item.description;
  if (result.title !== undefined) { result.kind = row.item.kind ?? result.kind; result.target_version = row.item.target_version ?? null; result.title = row.item.title ?? description; } else result.description = description;
  if (row.section !== "resolved") result.severity = row.snapshot.severity!;
  result.status = row.item.status; return result;
}
function rowFor(id: string, record: JsonObject): string { return `- [${record.status === "resolved" ? "x" : " "}] [id:${id}] ${renderTodoPublicRecord(record)}`; }
function scanRows(markdown: string): { managed: Map<string, ManagedRow[]>; legacy: Row[] } {
  const managed = new Map<string, ManagedRow[]>(); const legacy: Row[] = []; const order = new Map<string, number>(); let section: string | null = null;
  markdown.split(/\r?\n/).forEach((line, index) => {
    const heading = line.trim().match(/^##\s+(.+)$/)?.[1]?.toLowerCase();
    if (heading) section = heading.includes("critical") ? "critical" : heading.includes("degraded") ? "degraded" : heading.includes("annoying") ? "annoying" : heading.includes("resolved") ? "resolved" : heading.includes("normal") ? "normal" : heading === "notes" ? null : section;
    const item = parseTodoMarkdownListItem(line.trim()); if (!item) return;
    const rowSeverity = section ? severity(section) : null;
    if (item.id && !rowSeverity && section !== "resolved") reject({ class: "conflict", message: `TODO repair found managed ID '${item.id}' outside a managed section`, recovery: `Move '${item.id}' under one declared TODO severity or the resolved section, then preview repair again; no state was changed.` });
    if (!section) return;
    const key = section === "resolved" ? "resolved" : rowSeverity!; const publicOrder = (order.get(key) ?? 0) + 1; order.set(key, publicOrder);
    const row = { line: index, section: key, sourceLine: line, item, snapshot: { present: true, description: item.public_description ?? item.description, ...(section === "resolved" ? {} : { severity: rowSeverity! }), status: item.status, order: publicOrder } };
    if (item.id) { const rows = managed.get(item.id) ?? []; rows.push({ ...row, id: item.id }); managed.set(item.id, rows); } else legacy.push(row);
  });
  return { managed, legacy };
}

export function planTodoRepair(markdown: string, activation: TodoReconciliationActivation, entities: readonly Entity[]): TodoRepairPlan {
  const { managed, legacy } = scanRows(markdown); const retained = new Set(activation.retained_legacy_rows); const retainedRows: Row[] = []; const conflicts: string[] = [];
  for (const row of legacy) { const fingerprint = todoLegacyRowFingerprint(row.section, row.sourceLine); if (retained.has(fingerprint)) retainedRows.push(row); else conflicts.push(`line ${row.line + 1}: ID-less managed row has no activation provenance`); }
  for (const [id, rows] of managed) { if (rows.length > 1) conflicts.push(`ID '${id}' occurs at lines ${rows.map((row) => row.line + 1).join(", ")}`); if (!entities.some((entity) => entity.id === id)) conflicts.push(`ID '${id}' has no canonical entity`); }
  const identityKey = (description: unknown, rowSeverity: unknown): string => `${String(description)}\0${String(rowSeverity)}`;
  const rowKey = (row: Row, record: JsonObject): string => identityKey(row.snapshot.description, row.section === "resolved" ? baseline(record)?.severity ?? record.severity : row.snapshot.severity);
  const entityKeys = (record: JsonObject): Set<string> => { const current = publicSnapshot(record); const keys = new Set([identityKey(current.description, current.severity)]); const prior = baseline(record); if (prior?.present) keys.add(identityKey(prior.description, prior.severity)); return keys; };
  const legacyCandidates = new Map<number, Entity[]>();
  const items: JsonObject[] = [];
  for (const row of retainedRows) {
    const matches = entities.filter((entity) => entity.id && entity.record && managed.get(entity.id)?.length === 1 && rowKey(managed.get(entity.id)![0]!, entity.record) === rowKey(row, entity.record));
    const unproven = entities.filter((entity) => entity.id && entity.record && !managed.has(entity.id) && entityKeys(entity.record).has(rowKey(row, entity.record)));
    legacyCandidates.set(row.line, matches);
    if (matches.length > 1) conflicts.push(`line ${row.line + 1}: retained row matches multiple canonical managed IDs`);
    else if (matches.length === 0 && unproven.length) {
      conflicts.push(`line ${row.line + 1}: decision legacy_without_managed_identity cannot assign canonical ID '${unproven[0]!.id}'`);
      if (items.length < DIAGNOSTIC_LIMIT) items.push({ decision: "legacy_without_managed_identity", id: unproven.length === 1 ? unproven[0]!.id : null, source_line: row.line + 1 });
    } else if (matches.length === 0 && items.length < DIAGNOSTIC_LIMIT) items.push({ decision: "retained_unrelated", source_line: row.line + 1 });
  }
  const records = new Map<string, JsonObject>(); const selected = new Map<string, Row>(); const remove = new Set<number>(); const claimedLegacy = new Set<number>();
  let duplicate = 0; let stale = 0; let matched = 0;
  for (const entity of entities) {
    if (!entity.id || !entity.record) continue;
    const managedRows = managed.get(entity.id) ?? []; if (managedRows.length > 1) continue; const managedRow = managedRows[0];
    const candidates = retainedRows.filter((row) => legacyCandidates.get(row.line)?.length === 1 && legacyCandidates.get(row.line)?.[0]?.id === entity.id);
    if (candidates.length > 1) { conflicts.push(`ID '${entity.id}' matches retained rows at lines ${candidates.map((row) => row.line + 1).join(", ")}`); continue; }
    const legacyRow = candidates[0]; let chosen: Row | undefined; let decision: string;
    if (managedRow && legacyRow) { duplicate += 1; decision = "duplicate_collapsed"; chosen = legacyRow; remove.add(managedRow.line); claimedLegacy.add(legacyRow.line); }
    else if (managedRow) { matched += 1; decision = "managed_matched"; chosen = managedRow; }
    else { const prior = baseline(entity.record); if (entity.record.status === "open" || prior?.present) conflicts.push(`ID '${entity.id}' has no one-to-one public row`); records.set(entity.id, withBaseline(entity.record, { present: false })); continue; }
    const projected = rowSnapshot(chosen, entity.record); const stalePublic = !samePublic(publicSnapshot(entity.record), projected); const imported = importMarkdown(entity.record, chosen);
    if (stalePublic) stale += 1; records.set(entity.id, imported); selected.set(entity.id, chosen);
    if (items.length < DIAGNOSTIC_LIMIT) items.push({ id: entity.id, decision, source_line: chosen.line + 1, stale_public: stalePublic });
  }
  for (const row of retainedRows) if ((legacyCandidates.get(row.line) ?? []).length === 1 && !claimedLegacy.has(row.line)) conflicts.push(`line ${row.line + 1}: retained row was not claimed by its canonical entity`);
  const retainedCount = retainedRows.filter((row) => !claimedLegacy.has(row.line)).length;
  if (conflicts.length) reject({ class: "conflict", message: `TODO repair requires complete one-to-one evidence; found ${conflicts.length} conflicting decision${conflicts.length === 1 ? "" : "s"}`, violations: [...conflicts.slice(0, DIAGNOSTIC_LIMIT), ...(conflicts.length > DIAGNOSTIC_LIMIT ? [`${conflicts.length - DIAGNOSTIC_LIMIT} additional conflicts omitted`] : [])], diagnosis: { counts: { duplicate, stale, matched, retained: retainedCount, conflicting: conflicts.length }, items, omitted_count: Math.max(0, duplicate + matched + retainedCount - items.length), conflicts_omitted_count: Math.max(0, conflicts.length - DIAGNOSTIC_LIMIT) }, recovery: `Resolve every reported identity or provenance conflict, then rerun exactly '${TODO_REPAIR_PREVIEW_COMMAND}'; no state was changed.` });
  const replacements = new Map<number, string>(); for (const [id, row] of selected) replacements.set(row.line, rowFor(id, records.get(id)!));
  const rendered = `${markdown.split(/\r?\n/).flatMap((line, index) => remove.has(index) ? [] : [replacements.get(index) ?? line]).join("\n").replace(/\n*$/, "")}\n`;
  const final = scanRows(rendered).managed;
  for (const [id, record] of records) { const row = final.get(id)?.[0]; records.set(id, withBaseline(record, row ? rowSnapshot(row, record) : { present: false })); }
  const retainedLegacyRows = retainedRows.filter((row) => !claimedLegacy.has(row.line)).map((row) => todoLegacyRowFingerprint(row.section, row.sourceLine)).sort();
  return { records, retainedLegacyRows, rendered, diagnosis: { counts: { duplicate, stale, matched, retained: retainedLegacyRows.length, conflicting: 0 }, items, omitted_count: Math.max(0, duplicate + matched + retainedLegacyRows.length - items.length) } };
}

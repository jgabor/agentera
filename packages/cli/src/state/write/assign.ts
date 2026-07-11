import { yamlEntryNumber } from "../../hooks/compaction/index.js";

function list(doc: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(doc[key]) ? (doc[key] as unknown[]) : [];
}

export function nextEntryNumber(doc: Record<string, unknown>, activeKey: string): number {
  const numbers = [...list(doc, activeKey), ...list(doc, "archive")].map(yamlEntryNumber);
  return Math.max(0, ...numbers) + 1;
}

export function nextTaskNumber(doc: Record<string, unknown>): number {
  return Math.max(0, ...list(doc, "tasks").map(yamlEntryNumber)) + 1;
}

export function localDate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function localTimestamp(now = new Date()): string {
  return `${localDate(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

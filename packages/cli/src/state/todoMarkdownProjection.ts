import fs from "node:fs";

import type { JsonObject } from "../core/jsonValue.js";
import { renderTodoPublicRecord } from "../cli/todoMarkdown.js";
import { reject } from "./write/errors.js";

const TODO_MARKDOWN_MAX_BYTES = 1024 * 1024;
interface ExistingRow { id: string; line: number; section: string; snapshot: { order?: number } }

export function readTodoMarkdown(target: string): { bytes: Buffer; text: string } {
  if (!fs.existsSync(target)) return { bytes: Buffer.from(""), text: "" };
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) reject({ class: "conflict", message: "managed TODO Markdown must be a regular file", recovery: "Restore the docs-mapped TODO artifact as a regular file within the project and retry; no state was changed." });
  if (stat.size > TODO_MARKDOWN_MAX_BYTES) reject({ class: "conflict", message: `managed TODO Markdown exceeds the ${TODO_MARKDOWN_MAX_BYTES}-byte reconciliation bound`, recovery: "Compact unmanaged or resolved Markdown content below the declared bound and retry; no state was changed." });
  const bytes = fs.readFileSync(target); let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { reject({ class: "conflict", message: "managed TODO Markdown is not valid UTF-8", recovery: "Restore valid UTF-8 TODO Markdown and retry; no state was changed." }); }
  return { bytes, text: text! };
}

function sectionFor(record: JsonObject): string { return record.status === "resolved" ? "resolved" : String(record.severity); }
function headingFor(section: string): string { return section === "resolved" ? "## ✓ Resolved" : `## → ${section[0]!.toUpperCase()}${section.slice(1)}`; }
function rowFor(id: string, record: JsonObject): string { return `- [${record.status === "resolved" ? "x" : " "}] [id:${id}] ${renderTodoPublicRecord(record)}`; }

export function renderManagedMarkdown(markdown: string, records: Map<string, JsonObject>, existing: Map<string, ExistingRow>): string {
  const byLine = new Map([...existing.values()].map((row) => [row.line, row])); const retained = new Set<string>();
  const lines = markdown.split(/\r?\n/).flatMap((line, index) => { const row = byLine.get(index); if (!row) return [line]; const record = records.get(row.id); if (!record || sectionFor(record) !== row.section) return []; retained.add(row.id); return [rowFor(row.id, record)]; });
  for (const section of ["critical", "degraded", "normal", "annoying", "resolved"]) {
    const ids = [...records.entries()].filter(([id, record]) => !retained.has(id) && sectionFor(record) === section).sort(([left], [right]) => { const a = existing.get(left); const b = existing.get(right); return (a?.section === section ? a.snapshot.order! : Number.MAX_SAFE_INTEGER) - (b?.section === section ? b.snapshot.order! : Number.MAX_SAFE_INTEGER) || left.localeCompare(right); }).map(([id]) => id);
    if (!ids.length) continue;
    let heading = lines.findIndex((line) => line.trim().toLowerCase() === headingFor(section).toLowerCase());
    if (heading < 0) { if (lines.at(-1)?.trim()) lines.push(""); lines.push(headingFor(section)); heading = lines.length - 1; }
    let insert = heading + 1; while (insert < lines.length && !/^##\s+/.test(lines[insert]!.trim())) insert += 1;
    while (insert > heading + 1 && !lines[insert - 1]!.trim()) insert -= 1;
    lines.splice(insert, 0, ...ids.map((id) => rowFor(id, records.get(id)!)));
  }
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

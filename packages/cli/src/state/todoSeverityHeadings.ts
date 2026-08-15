import type { JsonObject } from "../core/jsonValue.js";
import { reject } from "./write/errors.js";

export const TODO_SEVERITY_HEADINGS = [
  { section: "critical", name: "Critical", heading: "## ⇶ Critical" },
  { section: "degraded", name: "Degraded", heading: "## ⇉ Degraded" },
  { section: "normal", name: "Normal", heading: "## → Normal" },
  { section: "annoying", name: "Annoying", heading: "## ⇢ Annoying" },
  { section: "resolved", name: "Resolved", heading: "## ✓ Resolved" },
] as const;

export type TodoSeveritySection = typeof TODO_SEVERITY_HEADINGS[number]["section"];
export interface TodoSeverityHeadingDiagnostic {
  code: "todo_severity_heading_mismatch" | "todo_severity_heading_duplicate" | "todo_severity_heading_out_of_order";
  classification: "glyph_name_mismatch" | "duplicate" | "out_of_order";
  line: number;
  expected_heading: string;
  recovery: string;
}

const DIAGNOSTIC_LIMIT = 20;
const byName = new Map(TODO_SEVERITY_HEADINGS.map((entry) => [entry.name.toLowerCase(), entry]));

function candidate(line: string): typeof TODO_SEVERITY_HEADINGS[number] | null {
  const content = line.trim().match(/^##\s+(.+?)\s*$/)?.[1];
  if (!content) return null;
  const name = content.match(/^(?:[^\p{L}\p{N}\s]+\s+)?(Critical|Degraded|Normal|Annoying|Resolved)$/iu)?.[1];
  return name ? byName.get(name.toLowerCase()) ?? null : null;
}

export function todoSeveritySectionForHeading(line: string): TodoSeveritySection | null {
  const entry = candidate(line);
  return entry && line.trim() === entry.heading ? entry.section : null;
}

export function inspectTodoSeverityHeadings(markdown: string): {
  diagnostics: TodoSeverityHeadingDiagnostic[];
  omitted_count: number;
} {
  const diagnostics: TodoSeverityHeadingDiagnostic[] = [];
  const seen = new Set<TodoSeveritySection>();
  let greatestOrder = -1;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const entry = candidate(line);
    if (!entry) continue;
    const order = TODO_SEVERITY_HEADINGS.indexOf(entry);
    const add = (diagnostic: TodoSeverityHeadingDiagnostic): void => { diagnostics.push(diagnostic); };
    if (line.trim() !== entry.heading) add({
      code: "todo_severity_heading_mismatch",
      classification: "glyph_name_mismatch",
      line: index + 1,
      expected_heading: entry.heading,
      recovery: `Replace TODO.md line ${index + 1} with '${entry.heading}'.`,
    });
    if (seen.has(entry.section)) add({
      code: "todo_severity_heading_duplicate",
      classification: "duplicate",
      line: index + 1,
      expected_heading: entry.heading,
      recovery: `Keep exactly one '${entry.heading}' section and move its rows there.`,
    });
    if (order < greatestOrder) add({
      code: "todo_severity_heading_out_of_order",
      classification: "out_of_order",
      line: index + 1,
      expected_heading: entry.heading,
      recovery: "Order managed TODO sections as Critical, Degraded, Normal, Annoying, then Resolved; missing sections are allowed.",
    });
    seen.add(entry.section);
    greatestOrder = Math.max(greatestOrder, order);
  }
  return { diagnostics: diagnostics.slice(0, DIAGNOSTIC_LIMIT), omitted_count: Math.max(0, diagnostics.length - DIAGNOSTIC_LIMIT) };
}

export function assertTodoSeverityHeadingStructure(markdown: string): void {
  const diagnosis = inspectTodoSeverityHeadings(markdown);
  if (!diagnosis.diagnostics.length) return;
  reject({
    class: "conflict",
    message: "TODO.md managed severity section structure is malformed",
    diagnosis: { classification: "todo_severity_heading_structure", ...diagnosis } as unknown as JsonObject,
    recovery: "Apply every bounded TODO.md heading correction exactly as reported, then retry; no state was changed.",
  });
}

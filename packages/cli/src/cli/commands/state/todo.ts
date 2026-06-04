/**
 * `state todo` query (TODO.md).
 *
 * Reads TODO.md, partitions entries by severity band (using the
 * protocol glyphs as the section heading), and reports each entry
 * with its severity, status, and description. Supports both the
 * legacy structured YAML shape and the current markdown layout.
 */

import fs from "node:fs";

import {
  emitStateStructured,
  extractEntries,
  filterByFieldValue,
  formatEntry,
  loadArtifact,
  printStatusCounts,
  sourceMetadata,
  statusCounts,
  structuredState,
} from "../../stateQuery.js";
import { SchemaInfo, artifactPath } from "../../appContext.js";
import { isResolvedTodoMarkdownStatus, parseTodoMarkdownListItem } from "../../todoMarkdown.js";
import { out, err, StateArgs, Io } from "./shared.js";

const TODO_SEVERITY_ORDER_KEYS = ["critical", "degraded", "warning", "normal", "info", "annoying"];
const TODO_SEV_GLYPHS: Record<string, string> = {
  critical: "⇶",
  degraded: "⇉",
  warning: "⇉",
  normal: "→",
  info: "⇢",
  annoying: "⇢",
};

export function normalizeSeverity(value: unknown, deflt = "normal"): string {
  const text = String(value || deflt).toLowerCase();
  for (const key of TODO_SEVERITY_ORDER_KEYS) {
    if (text.includes(key)) return key;
  }
  return deflt;
}

export function queryTodo(
  args: StateArgs,
  schemas: Record<string, SchemaInfo>,
  io: Io,
  openOnly = false,
): number {
  const o = out(io);
  const info: SchemaInfo = schemas.todo ?? { path: "TODO.md", record: undefined, schema: {}, fields: {} };
  const todoPath = artifactPath(info, "todo");
  const severity = args.severity ?? null;
  const status = args.status ?? null;
  const format = args.format ?? "text";

  if (!fs.existsSync(todoPath)) {
    if (format !== "text") {
      return emitStateStructured(
        "todo",
        structuredState("todo", [], sourceMetadata("todo", todoPath), {
          filters: { severity, status },
        }),
        format,
        args.fields,
        o,
        err(io),
      );
    }
    return 0;
  }

  const data = loadArtifact(todoPath);
  let entries = extractEntries(data);
  if (entries.length > 0) {
    if (severity) entries = filterByFieldValue(entries, "severity", severity);
    if (status) entries = filterByFieldValue(entries, "status", status);
    if (openOnly) {
      entries = entries.filter(
        (entry) => !["done", "closed", "resolved"].includes(String(entry.status ?? "open").toLowerCase()),
      );
    }
    if (format !== "text") {
      return emitStateStructured(
        "todo",
        structuredState("todo", entries, sourceMetadata("todo", todoPath), {
          filters: { severity, status, open_only: openOnly || null },
        }),
        format,
        args.fields,
        o,
        err(io),
      );
    }
    printStatusCounts("TODO status", statusCounts(entries), o);
    for (const entry of entries) {
      const line = formatEntry(entry, ["severity", "status", "description", "title"]);
      if (line) o(line + "\n");
    }
    return 0;
  }

  const text = fs.readFileSync(todoPath, "utf8");
  const marker = severity ? TODO_SEV_GLYPHS[severity.toLowerCase()] ?? severity : null;
  let currentSection: string | null = null;
  const markdownEntries: Record<string, any>[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const sline = rawLine.trim();
    if (sline.startsWith("## ")) {
      const section = sline.slice(3).trim();
      if (section.toLowerCase().includes("resolved")) {
        currentSection = null;
        continue;
      }
      currentSection = section;
      continue;
    }
    if (currentSection === null) continue;
    const parsed = parseTodoMarkdownListItem(sline);
    if (!parsed) continue;
    if (marker && !currentSection.includes(marker)) continue;
    const itemStatus = parsed.status;
    if (openOnly && isResolvedTodoMarkdownStatus(itemStatus)) continue;
    if (status) {
      const want = status.toLowerCase();
      const have = itemStatus.toLowerCase();
      if (want === "open" || want === "todo") {
        if (isResolvedTodoMarkdownStatus(have)) continue;
      } else if (have !== want) {
        continue;
      }
    }
    markdownEntries.push({
      severity: normalizeSeverity(currentSection),
      status: itemStatus,
      description: parsed.description,
      section: currentSection,
    });
    if (format === "text") o(`[${currentSection}] ${parsed.description}\n`);
  }
  if (format !== "text") {
    return emitStateStructured(
      "todo",
      structuredState("todo", markdownEntries, sourceMetadata("todo", todoPath), {
        filters: { severity, status, open_only: openOnly || null },
      }),
      format,
      args.fields,
      o,
      err(io),
    );
  }
  return 0;
}

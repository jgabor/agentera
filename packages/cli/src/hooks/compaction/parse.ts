/**
 * Markdown entry parsing for the compaction writer.
 *
 * Splits a markdown artifact into "full" and "oneline" entries by
 * walking the spec's heading regex, then collects the trailing
 * detail body up to the next heading. The TODO-resolved section
 * uses indented detail lines as the body delimiter; open items stay
 * in severity bands and resolved items belong only under
 * `## ✓ Resolved`.
 */

import { parseTodoMarkdownListItem } from "../../cli/todoMarkdown.js";
import { ArtifactSpec, SPECS, escapeRe } from "./dryRun.js";

type Dict = Record<string, any>;
type TodoSectionKind = "severity" | "resolved" | "other";

const SEVERITY_HEADING_RE = /^##\s*(⇶|⇉|→|⇢)\s/m;
const STRIKETHROUGH_ITEM_RE = /^(\s*)-\s+~~(.+?)~~\s*(.*)$/;

export function splitArchive(text: string, archiveHeading: string): [string, string] {
  if (!archiveHeading) return [text, ""];
  const pattern = new RegExp(`^${escapeRe(archiveHeading)}\\s*$`, "m");
  const match = pattern.exec(text);
  if (!match) return [text, ""];
  const pre = text.slice(0, match.index).replace(/\s+$/, "");
  const after = text.slice(match.index + match[0].length);
  const nextSection = /^##\s/m.exec(after);
  if (nextSection) {
    const archiveBody = after.slice(0, nextSection.index);
    const trailing = after.slice(nextSection.index);
    return [pre, archiveBody.trim() + (trailing ? "\n\n" + trailing : "")];
  }
  return [pre, after.trim()];
}

export function parseFullEntries(text: string, spec: ArtifactSpec): Dict[] {
  const entries: Dict[] = [];
  const re = new RegExp(spec.entryHeadingRe.source, "gm");
  const matches = [...text.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const lineStart = text.lastIndexOf("\n", m.index! - 1) + 1;
    let lineEnd = text.indexOf("\n", m.index!);
    if (lineEnd === -1) lineEnd = text.length;
    const headerLine = text.slice(lineStart, lineEnd).trim();
    const glyphMatch = /^(■)\s*/.exec(headerLine);
    const glyph = glyphMatch ? glyphMatch[1] + " " : "";
    const remainder = glyphMatch ? headerLine.slice(glyphMatch[0].length) : headerLine;
    const header = glyph + remainder.replace(/^#+/, "").trim();
    const bodyStart = lineEnd + 1;
    let bodyEnd: number;
    if (i + 1 < matches.length) {
      bodyEnd = text.lastIndexOf("\n", matches[i + 1].index! - 1) + 1;
    } else {
      bodyEnd = text.length;
    }
    const body = text.slice(bodyStart, bodyEnd).trim();
    entries.push({ header, body, kind: "full" });
  }
  return entries;
}

export function parseOnelineEntries(text: string, spec: ArtifactSpec): Dict[] {
  if (spec.onelineHeadingRe === null) return [];
  const entries: Dict[] = [];
  const re = new RegExp(spec.onelineHeadingRe.source);
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (re.test(line)) {
      entries.push({ header: line.replace(/\s+$/, ""), body: "", kind: "oneline" });
    }
  }
  return entries;
}

export function extractResolvedSection(text: string): [number, number, string] {
  const m = /^##\s+(?:✓\s+)?Resolved\s*$/m.exec(text);
  if (!m) return [-1, -1, ""];
  const bodyStart = m.index + m[0].length + 1;
  const nextSection = /^##\s/m.exec(text.slice(bodyStart));
  const bodyEnd = nextSection ? bodyStart + nextSection.index : text.length;
  return [m.index, bodyEnd, text.slice(bodyStart, bodyEnd)];
}

export function parseTodoResolved(text: string, spec: ArtifactSpec): Dict[] {
  const [, , body] = extractResolvedSection(text);
  if (!body) return [];
  const entries: Dict[] = [];
  const lines = body.split(/\r\n|\r|\n/);
  const headRe = new RegExp(spec.entryHeadingRe.source);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (headRe.test(line)) {
      const detailLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (nxt.startsWith(" ") || nxt.startsWith("\t")) {
          detailLines.push(nxt);
          j += 1;
        } else if (nxt.trim() === "") {
          if (j + 1 < lines.length && (lines[j + 1].startsWith(" ") || lines[j + 1].startsWith("\t"))) {
            detailLines.push(nxt);
            j += 1;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      const bodyText = detailLines.join("\n").trim();
      entries.push({ header: line.replace(/\s+$/, ""), body: bodyText, kind: bodyText ? "full" : "oneline" });
      i = j;
    } else {
      i += 1;
    }
  }
  return entries;
}

export function isTodoSeveritySectionHeading(line: string): boolean {
  return SEVERITY_HEADING_RE.test(line.trim());
}

export function isTodoResolvedSectionHeading(line: string): boolean {
  return /^##\s*(?:✓\s+)?Resolved\s*$/im.test(line.trim());
}

export function classifyTodoSectionHeading(line: string): TodoSectionKind {
  if (isTodoSeveritySectionHeading(line)) return "severity";
  if (isTodoResolvedSectionHeading(line)) return "resolved";
  if (/^##\s/.test(line.trim())) return "other";
  return "other";
}

export function strikethroughTodoLineToCheckbox(line: string): string | null {
  const m = STRIKETHROUGH_ITEM_RE.exec(line);
  if (!m) return null;
  const tail = m[3]?.trim();
  const body = m[2].trim();
  return `${m[1]}- [x] ${body}${tail ? (tail.startsWith("·") ? ` ${tail}` : ` ${tail}`) : ""}`;
}

export function isLegacyStrikethroughTodoLine(line: string): boolean {
  return /^(\s*)-\s+~~/.test(line);
}

export function countTodoResolvedInSeverityBands(content: string): number {
  let count = 0;
  let section: TodoSectionKind = "other";
  for (const line of content.split(/\r\n|\r|\n/)) {
    const kind = classifyTodoSectionHeading(line);
    if (kind !== "other" || /^##\s/.test(line.trim())) {
      section = kind;
      continue;
    }
    if (section !== "severity") continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;
    const parsed = parseTodoMarkdownListItem(trimmed);
    if (parsed?.status === "resolved" || isLegacyStrikethroughTodoLine(trimmed)) {
      count += 1;
    }
  }
  return count;
}

export function countTodoResolvedEntries(content: string): { full: number; oneline: number } {
  const spec = SPECS["todo-resolved"];
  const resolvedSection = parseTodoResolved(content, spec);
  const misplaced = countTodoResolvedInSeverityBands(content);
  return {
    full: resolvedSection.filter((e) => e.kind === "full").length,
    oneline: resolvedSection.filter((e) => e.kind === "oneline").length + misplaced,
  };
}

/**
 * Move resolved rows from severity bands into `## ✓ Resolved`, creating the
 * section when absent. Newly migrated rows are prepended (newest-first folds).
 */
export function normalizeTodoResolvedLayout(content: string): { text: string; changed: boolean } {
  const lines = content.split(/\r\n|\r|\n/);
  const beforeResolved: string[] = [];
  const migratedResolved: string[] = [];
  const existingResolved: string[] = [];
  const afterResolved: string[] = [];

  let section: TodoSectionKind = "other";
  let seenResolvedHeading = false;

  for (const line of lines) {
    const headingKind = classifyTodoSectionHeading(line);
    if (headingKind === "resolved") {
      seenResolvedHeading = true;
      section = "resolved";
      continue;
    }
    if (headingKind === "severity") {
      section = "severity";
      if (!seenResolvedHeading) beforeResolved.push(line);
      else afterResolved.push(line);
      continue;
    }
    if (/^##\s/.test(line.trim())) {
      section = "other";
      if (!seenResolvedHeading) beforeResolved.push(line);
      else afterResolved.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (section === "resolved") {
      if (trimmed) existingResolved.push(line);
      continue;
    }

    if (section === "severity" && trimmed.startsWith("-")) {
      const converted = strikethroughTodoLineToCheckbox(line) ?? line;
      const parsed = parseTodoMarkdownListItem(converted.trim());
      if (parsed?.status === "resolved" || isLegacyStrikethroughTodoLine(trimmed)) {
        migratedResolved.push(converted.trim());
        continue;
      }
    }

    if (!seenResolvedHeading) beforeResolved.push(line);
    else afterResolved.push(line);
  }

  if (migratedResolved.length === 0) {
    return { text: content, changed: false };
  }

  const rebuilt = [...beforeResolved];
  if (rebuilt.length > 0 && rebuilt[rebuilt.length - 1]?.trim() !== "") rebuilt.push("");
  rebuilt.push("## ✓ Resolved");
  rebuilt.push(...migratedResolved, ...existingResolved);
  if (afterResolved.length > 0) {
    rebuilt.push("");
    rebuilt.push(...afterResolved);
  }

  const text = rebuilt.join("\n").replace(/\n*$/, "\n");
  return { text, changed: text !== content };
}

export function parseEntries(text: string, specName: string): Dict[] {
  const spec = SPECS[specName];
  if (spec.name === "todo-resolved") {
    return parseTodoResolved(text, spec);
  }
  const [pre, archiveBody] = splitArchive(text, spec.archiveHeading || "");
  const fullEntries = parseFullEntries(pre, spec);
  const onelineEntries = parseOnelineEntries(archiveBody, spec);
  return [...fullEntries, ...onelineEntries];
}

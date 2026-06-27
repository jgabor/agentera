/**
 * Markdown validation for human-facing artifacts (TODO.md, CHANGELOG.md,
 * SKILL.md, ...). Walks the artifact's schema looking for any group
 * with required `field` entries and dispatches to the appropriate
 * section check (ITEM, RELEASE, TOKEN).
 */

import { parseTodoMarkdownListItem } from "../../cli/todoMarkdown.js";
import {
  classifyTodoSectionHeading,
  isLegacyStrikethroughTodoLine,
} from "../compaction/parse.js";
import { isMapping, isEmptyRequired } from "./schema.js";

const TODO_RESOLVED_HEADING_RE = /^##\s*(?:✓\s+)?Resolved\s*$/im;

function validateTodoResolvedPlacement(content: string, name: string): string[] {
  const violations: string[] = [];
  let section: "severity" | "resolved" | "other" = "other";
  let hasResolvedHeading = TODO_RESOLVED_HEADING_RE.test(content);
  let hasResolvedItems = false;

  for (const line of content.split(/\r\n|\r|\n/)) {
    const kind = classifyTodoSectionHeading(line);
    if (kind === "resolved") {
      hasResolvedHeading = true;
      section = "resolved";
      continue;
    }
    if (kind === "severity") {
      section = "severity";
      continue;
    }
    if (/^##\s/.test(line.trim())) {
      section = "other";
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;

    const parsed = parseTodoMarkdownListItem(trimmed);
    if (parsed?.status === "resolved") {
      hasResolvedItems = true;
      if (section === "severity") {
        violations.push(
          `${name}: resolved checkbox item must live under '## ✓ Resolved', not in severity bands`,
        );
        break;
      }
    }

    if (isLegacyStrikethroughTodoLine(trimmed)) {
      hasResolvedItems = true;
      violations.push(
        `${name}: legacy strikethrough resolved items are not allowed; use '- [x]' under '## ✓ Resolved'`,
      );
      break;
    }
  }

  if (hasResolvedItems && !hasResolvedHeading) {
    violations.push(`${name}: missing '## ✓ Resolved' section for resolved items`);
  }

  return violations;
}

import type { JsonObject } from "../../core/jsonValue.js";

const SKIP_META = new Set(["meta", "GROUP_PREFIXES", "BUDGET", "COMPACTION", "VALIDATION", "CONVENTION"]);

export function validateMd(content: string, name: string, schema: JsonObject | null = null): string[] {
  const violations: string[] = [];
  if (!content.trim()) violations.push(`${name}: empty content`);
  const fences = (content.match(/^```/gm) ?? []).length;
  if (fences % 2) violations.push(`${name}: unclosed code fence`);
  if (schema) violations.push(...validateMdSchema(content, name, schema));
  return violations;
}

export function validateMdSchema(content: string, name: string, schema: JsonObject): string[] {
  const violations: string[] = [];
  if (!content.trim()) return violations;
  for (const [groupKey, groupValue] of Object.entries(schema)) {
    if (SKIP_META.has(groupKey) || !isMapping(groupValue)) continue;
    const hasRequired = Object.values(groupValue).some((e) => isMapping(e) && e.required && e.field);
    if (!hasRequired) continue;
    if (groupKey === "ITEM") validateMdItems(content, name, violations);
    else if (groupKey === "RELEASE") validateMdReleases(content, name, violations);
    else if (groupKey === "TOKEN") validateMdTokens(content, name, violations);
  }
  return violations;
}

export function validateMdItems(content: string, name: string, violations: string[]): void {
  const versionHeading = /^##\s+/m.exec(content);
  if (!versionHeading) {
    violations.push(`${name}: missing severity sections (expected '## <glyph> <name>' headings)`);
    return;
  }
  const severityGlyphs = ["⇶", "⇉", "→", "⇢"];
  let found = false;
  for (const glyph of severityGlyphs) {
    const g = glyph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^##\\s*${g}`, "m").test(content)) {
      found = true;
      const sectionStart = new RegExp(`^##\\s*${g}.+$`, "m").exec(content);
      if (sectionStart) {
        const idx = sectionStart.index + sectionStart[0].length;
        const nextMatch = content.slice(idx).match(/\n##\s/);
        let bodyStart = idx;
        if (content.startsWith("\r\n", bodyStart)) bodyStart += 2;
        else if (content[bodyStart] === "\n") bodyStart += 1;
        const sectionEnd = nextMatch ? idx + nextMatch.index! : content.length;
        const sectionBody = content.slice(bodyStart, sectionEnd);
        const headingSlice = content.slice(sectionStart.index, sectionStart.index + sectionStart[0].length);
        const glyphNameMatch = new RegExp(`^##\\s*(${g}.+)$`, "m").exec(headingSlice);
        const headingText = glyphNameMatch ? glyphNameMatch[1] : glyph;
        const gluedNextSection = nextMatch?.index === 0;
        if (gluedNextSection || /^\s*##\s/m.test(sectionBody)) {
          violations.push(
            `${name}: severity section '${headingText}' body contains a nested heading; add a blank line before the next '##' section`,
          );
        }
        if (glyph === "⇶" && /^\s*-\s+\[x\]/im.test(sectionBody)) {
          violations.push(
            `${name}: severity section '⇶ Critical' must not contain resolved '- [x]' items; move them to '## ✓ Resolved'`,
          );
        }
      }
    }
  }
  if (name === "TODO.md" || name === "todo") {
    violations.push(...validateTodoResolvedPlacement(content, name));
  }
  if (!found) {
    violations.push(
      `${name}: missing severity glyph in section headings (expected '## ⇶ Critical', '## ⇉ Degraded', '## → Normal', '## ⇢ Annoying')`,
    );
  }
}

export function validateMdReleases(content: string, name: string, violations: string[]): void {
  if (!/^##\s*\[/m.test(content)) {
    violations.push(`${name}: missing version header (expected '## [X.Y.Z]')`);
  }
  const changeSections = new Set(["### Added", "### Changed", "### Fixed", "### Removed"]);
  const lines = new Set(content.split("\n"));
  if (![...changeSections].some((s) => lines.has(s))) {
    violations.push(
      `${name}: missing change sections (expected '### Added', '### Changed', '### Fixed', or '### Removed')`,
    );
  }
}

export function validateMdTokens(content: string, name: string, violations: string[]): void {
  if (!/^##\s/m.test(content)) {
    violations.push(`${name}: missing section heading (expected '## SectionName')`);
  }
  const yamlBlocks = (content.match(/^```yaml\s*$/gm) ?? []).length;
  if (!yamlBlocks) {
    violations.push(`${name}: missing YAML code block with token definitions (expected '\`\`\`yaml')`);
  }
}

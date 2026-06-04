/**
 * Markdown validation for human-facing artifacts (TODO.md, CHANGELOG.md,
 * SKILL.md, ...). Walks the artifact's schema looking for any group
 * with required `field` entries and dispatches to the appropriate
 * section check (ITEM, RELEASE, TOKEN).
 */

import { isMapping, isEmptyRequired } from "./schema.js";

type Dict = Record<string, any>;

const SKIP_META = new Set(["meta", "GROUP_PREFIXES", "BUDGET", "COMPACTION", "VALIDATION", "CONVENTION"]);

export function validateMd(content: string, name: string, schema: Dict | null = null): string[] {
  const violations: string[] = [];
  if (!content.trim()) violations.push(`${name}: empty content`);
  const fences = (content.match(/^```/gm) ?? []).length;
  if (fences % 2) violations.push(`${name}: unclosed code fence`);
  if (schema) violations.push(...validateMdSchema(content, name, schema));
  return violations;
}

export function validateMdSchema(content: string, name: string, schema: Dict): string[] {
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
  const requiredItemGlyphs = new Set(["⇶"]);
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
        if (requiredItemGlyphs.has(glyph) && !/^\s*-/m.test(sectionBody)) {
          const headingSlice = content.slice(sectionStart.index, sectionStart.index + sectionStart[0].length);
          const glyphNameMatch = new RegExp(`^##\\s*(${g}.+)$`, "m").exec(headingSlice);
          const headingText = glyphNameMatch ? glyphNameMatch[1] : glyph;
          violations.push(
            `${name}: severity section '${headingText}' has no list entries (expected '- [type]' items)`,
          );
        }
      }
    }
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

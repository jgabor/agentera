import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { resolvePath } from "../core/paths.js";
import { confirmedVariantGuardContract } from "../registries/glossaryEntryContract.js";
import { containsGlossaryTerm } from "../registries/glossaryTermOccurrence.js";
import {
  loadProjectGlossaryDocument,
  type ProjectGlossaryDocument,
} from "../state/write/glossaryPublication.js";

const EXCLUDED_DIRECTORIES = new Set(confirmedVariantGuardContract().excludedDirectories);
// Lowercased extensions classify ASCII path suffixes; they are not term identities.
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".go", ".html", ".js", ".json", ".jsonc", ".jsx",
  ".md", ".mjs", ".py", ".rs", ".sh", ".toml", ".ts", ".tsx", ".txt",
  ".xml", ".yaml", ".yml",
]);
const RERUN = "pnpm -C packages/cli exec vitest run test/cli/v1LegacyCruft.test.ts";

interface ConfirmedVariant {
  variant: string;
  canonical: string;
  approvalDigest: string;
  evidence: Array<{ source_path: string; line: number; source_record_sha256: string }>;
}

function fixedLegacyViolations(root: string): string[] {
  const violations: string[] = [];
  if (fs.existsSync(path.join(root, "skills/hej"))) violations.push("skills/hej/ bridge directory present");
  if (fs.existsSync(path.join(root, "references/v1-section-mapping.md"))) {
    violations.push("references/v1-section-mapping.md present");
  }
  if (fs.existsSync(path.join(root, ".opencode/commands/hej.md"))) {
    violations.push(".opencode/commands/hej.md legacy bridge command present");
  }
  const marketplacePath = path.join(root, ".claude-plugin/marketplace.json");
  if (fs.existsSync(marketplacePath)) {
    const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
    const names = (marketplace.plugins ?? []).map((item: { name?: string }) => item.name);
    if (names.includes("status")) violations.push(".claude-plugin/marketplace.json still lists hej plugin");
  }
  const codexPath = path.join(root, ".codex-plugin/plugin.json");
  if (fs.existsSync(codexPath)) {
    const codex = JSON.parse(fs.readFileSync(codexPath, "utf8"));
    const names = (codex.skillMetadata ?? []).map((item: { name?: string }) => item.name);
    if (names.includes("status")) violations.push(".codex-plugin/plugin.json still lists hej skillMetadata");
  }
  const packageRegistryPath = path.join(root, "references/adapters/package-registry.yaml");
  if (fs.existsSync(packageRegistryPath)) {
    const registry = YAML.parse(fs.readFileSync(packageRegistryPath, "utf8"));
    const versionFiles: string[] = registry.records?.[0]?.docs_targets?.version_files ?? [];
    if (versionFiles.includes("skills/hej/SKILL.md")) {
      violations.push("package-registry docs_targets still lists skills/hej/SKILL.md");
    }
  }
  return violations;
}

function confirmedVariants(document: ProjectGlossaryDocument): ConfirmedVariant[] {
  return document.approvals.flatMap((approval, index) => {
    const entry = document.entries[index]!;
    const canonical = String(entry.term);
    // Project-glossary validation already rejects every canonical/variant
    // identity collision. Preserve all validated variants for guard scanning.
    return approval.proposal.variants
      .map(({ term, evidence }) => ({
        variant: term,
        canonical,
        approvalDigest: approval.proposal_digest,
        evidence,
      }));
  });
}

function projectTextFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) visit(target);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase())) {
        files.push(target);
      }
    }
  };
  visit(root);
  return files;
}

function lineDigest(line: string): string {
  return crypto.createHash("sha256").update(line).digest("hex");
}

function isApprovedEvidence(
  variant: ConfirmedVariant,
  sourcePath: string,
  line: number,
  text: string,
): boolean {
  const digest = lineDigest(text);
  return variant.evidence.some((item) =>
    item.source_path === sourcePath && item.line === line && item.source_record_sha256 === digest
  );
}

function variantViolations(
  root: string,
  document: ProjectGlossaryDocument,
  glossaryPath: string,
): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const file of projectTextFiles(root)) {
    if (path.resolve(file) === path.resolve(glossaryPath)) continue;
    const sourcePath = path.relative(root, file).split(path.sep).join(path.posix.sep);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const variant of confirmedVariants(document)) {
      for (const [index, text] of lines.entries()) {
        const line = index + 1;
        if (!containsGlossaryTerm(text, variant.variant) || isApprovedEvidence(variant, sourcePath, line, text)) continue;
        const identity = `${variant.approvalDigest}\0${variant.variant}\0${sourcePath}\0${line}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const evidence = variant.evidence.map((item) => `${item.source_path}:${item.line}`).join(", ");
        violations.push(
          `confirmed variant '${variant.variant}' reintroduced at ${sourcePath}:${line}; canonical term '${variant.canonical}' ` +
          `from approval ${variant.approvalDigest} (confirmed variant evidence: ${evidence}). ` +
          `Correction: replace '${variant.variant}' with '${variant.canonical}' at ${sourcePath}:${line}; rerun: ${RERUN}`,
        );
      }
    }
  }
  return violations.sort();
}

export function scanPost30CruftViolations(root: string): string[] {
  const resolved = resolvePath(root);
  const violations = fixedLegacyViolations(resolved);
  try {
    const loaded = loadProjectGlossaryDocument(resolved);
    if (loaded) violations.push(...variantViolations(resolved, loaded.document, loaded.path));
  } catch (error) {
    violations.push(
      `project glossary is malformed: ${(error as Error).message}. ` +
      `Correction: restore a valid confirmed document or rerun agentera state glossary publish --input REQUEST.yaml --format json; rerun: ${RERUN}`,
    );
  }
  return violations.sort();
}

import { previewEntityMigration, type EntityMigrationPreview } from "../../src/state/entityMigrationPreview.js";

export function collectMigrationPreviewPages(projectRoot: string, sourceRoot: string): {
  identities: string[];
  pages: EntityMigrationPreview[];
} {
  const identities: string[] = [];
  const pages: EntityMigrationPreview[] = [];
  let after: string | undefined;
  let sourceFingerprint: string | undefined;
  let previewDigest: string | undefined;
  do {
    const page = previewEntityMigration(projectRoot, sourceRoot, {
      limit: 1000,
      after,
      sourceFingerprint,
      previewDigest,
    });
    pages.push(page);
    identities.push(...page.entries.map((entry) => entry.source_identity));
    after = page.next_after ?? undefined;
    sourceFingerprint = page.source_fingerprint;
    previewDigest = page.preview_digest;
  } while (after);
  return { identities, pages };
}

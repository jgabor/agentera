import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ENTITY_MIGRATION_PREVIEW_MAX_OUTPUT_BYTES } from "../../src/state/entityMigrationPreview.js";
import { collectMigrationPreviewPages } from "../helpers/entityMigrationPagination.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("entity migration preview production cap", () => {
  it("preserves paged recovery within the 32768-byte response cap", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-migration-cap-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "TODO.md"), `# TODO\n\n## → Normal\n${Array.from({ length: 40 }, (_, index) => `- [ ] Item ${index} ${"x".repeat(2000)}`).join("\n")}\n`);

    const { identities, pages } = collectMigrationPreviewPages(root, REPO_ROOT);

    expect(ENTITY_MIGRATION_PREVIEW_MAX_OUTPUT_BYTES).toBe(32_768);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.some((page) => page.omission_reason === "output_byte_budget")).toBe(true);
    expect(pages.every((page) => Buffer.byteLength(JSON.stringify(page, null, 2), "utf8") <= ENTITY_MIGRATION_PREVIEW_MAX_OUTPUT_BYTES)).toBe(true);
    expect(new Set(identities).size).toBe(40);
    expect(identities).toHaveLength(40);
  }, 60_000);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { previewEntityMigration } from "../../src/state/entityMigrationPreview.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../../.."); const roots: string[] = [];
function project(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-migration-adapters-")); roots.push(root); fs.mkdirSync(path.join(root, ".agentera/archive"), { recursive: true }); return root; }
function write(root: string, relative: string, bytes: string): void { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("entity migration legacy adapters", () => {
  it("normalizes docs statuses, Task dependencies, mobile task shape, and incomplete completed plans with provenance", () => {
    const root = project();
    write(root, ".agentera/docs.yaml", "index:\n  - document: Idea\n    path: IDEA.md\n    last_updated: 2026-07-17\n    status: draft\n  - document: Old\n    path: OLD.md\n    last_updated: 2026-07-17\n    status: archived\n");
    write(root, ".agentera/plan.yaml", "header:\n  id: plan:123e4567-e89b-42d3-a456-426614174000\n  title: Legacy\n  created: 2026-07-17\n  status: completed\nwhat: migrate\nwhy: preserve\nconstraints: none\noverall_acceptance: pass\nscope: {included: [x], excluded: []}\ntasks:\n  - id: T1\n    title: First\n    status: complete\n    depends_on: []\n    acceptance: [pass]\n  - id: T2\n    title: Second\n    status: pending\n    depends_on: [Task 1]\n    acceptance: [pass]\nsurprises: []\n");
    const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 }); const docs = preview.entries.filter((entry) => entry.artifact === "docs"); const plan = preview.entries.find((entry) => entry.boundary === "plan"); const second = preview.entries.find((entry) => entry.source_identity.endsWith("/task:2"));
    expect(docs).toHaveLength(2); expect(docs.every((entry) => entry.classification !== "corrupt")).toBe(true); expect(docs.map((entry) => entry.migration_provenance).every(Boolean)).toBe(true); expect(plan?.migration_provenance).toBeTruthy(); expect(second?.relationships.find((relationship) => relationship.field === "depends_on")?.status).toBe("resolved");
  });

  it("keeps an empty completed archived plan valid and classifies ambiguous D references as residue", () => {
    const root = project(); write(root, ".agentera/docs.yaml", "index: []\n"); write(root, ".agentera/decisions.yaml", "decisions: []\narchive:\n  - summary: Staging D3+D4 remained projection-only.\n");
    write(root, ".agentera/archive/PLAN-empty.yaml", "header:\n  id: plan:223e4567-e89b-42d3-a456-426614174000\n  title: Empty\n  created: 2026-07-17\n  status: complete\nwhat: done\nwhy: done\nconstraints: none\noverall_acceptance: pass\nscope: {included: [], excluded: []}\ntasks: []\nsurprises: []\n");
    const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 }); const residue = preview.entries.find((entry) => entry.classification === "historical_projection_residue"); expect(residue).toMatchObject({ proposed_target: null, recovery: "none" }); expect(residue?.migration_provenance).toBeTruthy(); expect(preview.entries.some((entry) => entry.source_identity === "plan:223e4567-e89b-42d3-a456-426614174000")).toBe(true);
  });
});

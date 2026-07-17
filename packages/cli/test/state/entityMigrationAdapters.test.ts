import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { planEntityMigration, previewEntityMigration, validateEntityMigrationTargets } from "../../src/state/entityMigrationPreview.js";
import { applyEntityMigration, resumeEntityMigration } from "../../src/state/entityMigrationApply.js";

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
    const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 }); const residue = preview.preserved_residues.find((entry) => entry.classification === "historical_projection_residue"); expect(residue).toMatchObject({ proposed_target: null, recovery: "none" }); expect(residue?.migration_provenance).toBeTruthy(); expect(preview.entries.some((entry) => entry.source_identity === "plan:223e4567-e89b-42d3-a456-426614174000")).toBe(true); expect(preview.entries).not.toContainEqual(expect.objectContaining({ classification: "historical_projection_residue" }));
  });

  it("normalizes absent and legacy-empty task lists while preserving exact provenance", () => {
    const root = project(); write(root, ".agentera/docs.yaml", "index: []\n");
    write(root, ".agentera/plan.yaml", "header:\n  id: plan:323e4567-e89b-42d3-a456-426614174000\n  title: Empty fields\n  created: 2026-07-17\n  status: open\nwhat: migrate\nwhy: preserve absence\nconstraints: none\noverall_acceptance: pass\nscope: {included: [x], excluded: []}\ntasks:\n  - number: 1\n    name: Absent\n    status: pending\n  - number: 2\n    name: Null and empty\n    status: pending\n    depends_on: null\n    acceptance: \"\"\n  - number: 3\n    name: Scalars\n    status: pending\n    depends_on: Task 1\n    acceptance: criterion\n  - number: 4\n    name: Legacy YAML mapping\n    status: completed\n    depends_on: []\n    acceptance:\n      - 'GIVEN a value WHEN parsed THEN preserve punctuation': exactly\nsurprises: []\n");
    const plan = planEntityMigration(root, SOURCE_ROOT); const tasks = plan.entries.filter((entry) => entry.boundary === "plan_task");
    expect(tasks.map((entry) => entry.record)).toEqual([
      expect.objectContaining({ depends_on: [], acceptance: [] }),
      expect.objectContaining({ depends_on: [], acceptance: [] }),
      expect.objectContaining({ depends_on: [tasks[0].proposed_target?.id], acceptance: ["criterion"] }),
      expect.objectContaining({ depends_on: [], acceptance: ["GIVEN a value WHEN parsed THEN preserve punctuation: exactly"], status: "complete" }),
    ]);
    expect(tasks[0].migration_provenance).toEqual(expect.arrayContaining([expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ index: 0, normalized_list_fields: ["depends_on", "acceptance"], source_list_forms: { depends_on: "absent", acceptance: "absent" } })]) })]));
    expect(tasks[1].migration_provenance).toEqual(expect.arrayContaining([expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ index: 1, normalized_list_fields: ["depends_on", "acceptance"], source_list_forms: { depends_on: "null", acceptance: "empty_scalar" } })]) })]));
    expect(tasks[3].migration_provenance).toEqual(expect.arrayContaining([expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ index: 3, status: { original: "completed", normalized: "complete" }, acceptance_mapping_items: [expect.objectContaining({ index: 0, normalized: "GIVEN a value WHEN parsed THEN preserve punctuation: exactly" })] })]) })]));
    expect(validateEntityMigrationTargets(root, plan.entries, SOURCE_ROOT)).toEqual([]);
    expect(previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 })).toMatchObject({ status: "ready", counts: { blockers: 0 } });
  });

  it.each([
    ["absent", ""],
    ["null", "scope: null\n"],
    ["empty_scalar", 'scope: ""\n'],
  ])("normalizes %s legacy scope losslessly across preview, apply, resume, and state validation", (sourceForm, scope) => {
    const root = project(); write(root, ".agentera/docs.yaml", "index: []\n");
    write(root, ".agentera/plan.yaml", `header:\n  id: plan:523e4567-e89b-42d3-a456-426614174000\n  title: Legacy scope\n  created: 2026-07-17\n  status: open\nwhat: migrate\nwhy: preserve absence\n${scope}tasks:\n  - number: 1\n    name: Preserve scope\n    status: pending\n    depends_on: []\n    acceptance: [pass]\nsurprises: []\n`);
    const migration = planEntityMigration(root, SOURCE_ROOT);
    const plan = migration.entries.find((entry) => entry.boundary === "plan");
    const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 });
    expect(preview).toMatchObject({ status: "ready", counts: { blockers: 0 } });
    expect(plan?.record.scope).toEqual({ included: [], excluded: [] });
    expect(plan?.migration_provenance).toEqual(expect.arrayContaining([expect.objectContaining({ scope: { source_form: sourceForm, normalized: "explicit_empty_lists" } })]));
    const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
    expect(applied.status).toBe("complete");
    expect(resumeEntityMigration(root, SOURCE_ROOT, applied.migration_id)).toMatchObject({ status: "complete", idempotent: true });
  });

  it.each([
    ["scalar", "scope: state\n"],
    ["list", "scope: [state]\n"],
    ["missing included", "scope: {excluded: []}\n"],
    ["missing excluded", "scope: {included: [state]}\n"],
    ["non-list", "scope: {included: state, excluded: []}\n"],
    ["non-string element", "scope: {included: [state], excluded: [2]}\n"],
  ])("blocks malformed nonempty %s plan scope before migration effects", (_name, scope) => {
    const root = project(); write(root, ".agentera/docs.yaml", "index: []\n");
    write(root, ".agentera/plan.yaml", `header:\n  id: plan:623e4567-e89b-42d3-a456-426614174000\n  title: Malformed scope\n  created: 2026-07-17\n  status: open\nwhat: migrate\nwhy: reject ambiguity\n${scope}tasks:\n  - number: 1\n    name: Reject scope\n    status: pending\n    depends_on: []\n    acceptance: [pass]\nsurprises: []\n`);
    const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 });
    expect(preview).toMatchObject({ status: "blocked", counts: { blockers: 1 } });
    expect(preview.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ classification: "corrupt", source_identity: "plan:623e4567-e89b-42d3-a456-426614174000", message: expect.stringMatching(/target_invalid:.*scope/) })]));
    expect(() => applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest)).toThrow(/inventory has 1 blocker/);
    expect(fs.existsSync(path.join(root, ".agentera/migrations"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
  });

  it("blocks nonempty malformed task lists during preview target validation", () => {
    const root = project(); write(root, ".agentera/docs.yaml", "index: []\n");
    write(root, ".agentera/plan.yaml", "header:\n  id: plan:423e4567-e89b-42d3-a456-426614174000\n  title: Malformed fields\n  created: 2026-07-17\n  status: open\nwhat: migrate\nwhy: reject ambiguity\nconstraints: none\noverall_acceptance: pass\nscope: {included: [x], excluded: []}\ntasks:\n  - number: 1\n    name: Invalid\n    status: pending\n    depends_on: {task: 2}\n    acceptance: [pass, 2]\nsurprises: []\n");
    const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 });
    expect(preview).toMatchObject({ status: "blocked", counts: { blockers: 1 } });
    expect(preview.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ classification: "corrupt", source_identity: expect.stringContaining("/task:1"), message: expect.stringContaining("target_invalid") })]));
    expect(() => applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest)).toThrow(/inventory has 1 blocker/);
    expect(fs.existsSync(path.join(root, ".agentera/migrations"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
  });
});

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { planEntityMigration } from "../../src/state/entityMigrationPreview.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { canonicalMigrationRecord } from "../../src/state/canonicalMigrationRecord.js";
import { entityForbiddenCanonicalAliases } from "../../src/state/entityStorage.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "packages/cli/test/fixtures/v2-compaction-2.7.11");
const manifest = YAML.parse(fs.readFileSync(path.join(FIXTURE_ROOT, "manifest.yaml"), "utf8")) as Record<string, any>;
const roots: string[] = [];

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function files(root: string, relative = ""): string[] {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(relative, entry.name);
      return entry.isDirectory() ? files(root, child) : [child];
    })
    .sort();
}

function treeHash(root: string): string {
  const digest = createHash("sha256");
  for (const relative of files(root)) {
    digest.update(`${relative.split(path.sep).join("/")}\0${sha256(fs.readFileSync(path.join(root, relative)))}\n`, "utf8");
  }
  return digest.digest("hex");
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v2-compaction-evidence-"));
  roots.push(root);
  fs.cpSync(path.join(FIXTURE_ROOT, "output"), root, { recursive: true });
  return root;
}

function yaml(relative: string): Record<string, any> {
  return YAML.parse(fs.readFileSync(path.join(FIXTURE_ROOT, relative), "utf8")) as Record<string, any>;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("pinned v2.7.11 compaction evidence", () => {
  it("pins the v2 source, command, and input/output bytes without requiring the v2 runtime", () => {
    expect(manifest.generator).toMatchObject({
      version: "2.7.11",
      source_commit: "b54a10a6bf4dfca5097101e60e18d5eaec7e5026",
      compactor_path: "hooks/compaction.py",
      compactor_blob: "b54c449a66e7842bd00f9343097a443d606c05b8",
      runtime: { pyyaml: "6.0.3" },
    });
    expect(manifest.generator.command).toContain("git archive b54a10a6bf4dfca5097101e60e18d5eaec7e5026");
    expect(manifest.generator.command).toContain("uv run --frozen --project");
    expect(manifest.generator.command).toContain("compact --mode fix");
    expect(manifest.tree_hash.canonicalization).toContain("NUL");

    for (const kind of ["input", "output"] as const) {
      const expected = manifest[kind].files as Record<string, string>;
      expect(files(path.join(FIXTURE_ROOT, kind)).map((relative) => relative.split(path.sep).join("/"))).toEqual(Object.keys(expected).sort());
      for (const [relative, hash] of Object.entries(expected)) {
        expect(sha256(fs.readFileSync(path.join(FIXTURE_ROOT, kind, relative)))).toBe(hash);
      }
      expect(treeHash(path.join(FIXTURE_ROOT, kind))).toBe(manifest[kind].tree_sha256);
    }
  });

  it("captures the v2 summaries and the full legacy-label matrix", () => {
    const progress = yaml("output/.agentera/progress.yaml");
    const health = yaml("output/.agentera/health.yaml");
    const decisions = yaml("output/.agentera/decisions.yaml");

    expect(progress).toMatchObject({ cycles: expect.any(Array), archive: [{ summary: expect.stringContaining("Cycle 1") }] });
    expect(health).toMatchObject({ audits: expect.any(Array), archive: [{ summary: expect.stringContaining("Audit 1") }] });
    expect(decisions.archive).toEqual(expect.arrayContaining([
      expect.objectContaining({ number: 1, summary: expect.stringContaining("Decision 1"), satisfaction: expect.any(Object) }),
      expect.objectContaining({ number: 0, summary: expect.stringContaining("without satisfaction") }),
    ]));
    expect(decisions.archive.find((entry: any) => entry.number === 0)).not.toHaveProperty("satisfaction");

    for (const [label, withoutSatisfaction, withSatisfaction] of [["high", 6, 7], ["medium", 8, 9], ["low", 10, 11]]) {
      expect(decisions.decisions.find((entry: any) => entry.number === withoutSatisfaction)).toMatchObject({ confidence: label });
      expect(decisions.decisions.find((entry: any) => entry.number === withoutSatisfaction)).not.toHaveProperty("satisfaction");
      expect(decisions.decisions.find((entry: any) => entry.number === withSatisfaction)).toMatchObject({ confidence: label, satisfaction: expect.any(Object) });
    }
  });

  it("keeps protected experiments and compacted TODO rows in their declared migration scopes", () => {
    const inputExperiments = fs.readFileSync(path.join(FIXTURE_ROOT, "input/.agentera/optimera/fixture/experiments.yaml"));
    const outputExperiments = fs.readFileSync(path.join(FIXTURE_ROOT, "output/.agentera/optimera/fixture/experiments.yaml"));
    const root = project();
    fs.mkdirSync(path.join(root, ".agentera/runtime/sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/runtime/sessions/local.yaml"), "session: runtime-local\n");

    expect(outputExperiments).toEqual(inputExperiments);
    expect(manifest.scope_notes.experiments).toContain("protected");
    const plan = planEntityMigration(root, REPO_ROOT);
    const experiments = plan.entries.filter((entry) => entry.source_paths.includes(".agentera/optimera/fixture/experiments.yaml"));
    expect(experiments).toHaveLength(11);
    expect(experiments.every((entry) => entry.artifact === "experiments" && entry.boundary === "experiment" && entry.classification === "corrupt" && entry.detail_availability === "full" && !entry.record.migration_provenance)).toBe(true);
    expect(experiments.some((entry) => entry.boundary === "experiment_summary")).toBe(false);
    const todos = plan.entries.filter((entry) => entry.source_paths.includes("TODO.md"));
    expect(todos).toHaveLength(11);
    expect(todos.every((entry) => entry.artifact === "todo" && entry.boundary === "todo_item" && entry.classification === "verified_full" && entry.detail_availability === "full" && entry.proposed_target !== null)).toBe(true);
    expect(fs.readFileSync(path.join(FIXTURE_ROOT, "output/TODO.md"), "utf8")).toContain("- [x] ~~Resolved fixture TODO 11~~");
    expect(todos.find((entry) => entry.source_identity === "TODO.md:line:25")).toMatchObject({
      artifact: "todo",
      boundary: "todo_item",
      classification: "verified_full",
      detail_availability: "full",
      proposed_target: expect.any(Object),
    });
    expect(plan.entries.some((entry) => entry.source_paths.includes(".agentera/runtime/sessions/local.yaml"))).toBe(false);
  });

  it("publishes compacted summaries and only known inherited decision labels", () => {
    const baseline = planEntityMigration(project(), REPO_ROOT);

    expect(baseline.counts).toMatchObject({
      verified_full: 12,
      recoverable_degraded_full_projection: 37,
      valid_compacted_summary: 4,
      duplicate: 0,
      conflict: 0,
      corrupt: 11,
      unsupported: 0,
      historical_projection_residue: 0,
      total: 64,
      publishable_entities: 53,
      blockers: 11,
    });

    expect(baseline.entries.find((entry) => entry.artifact === "progress" && entry.classification === "valid_compacted_summary")).toMatchObject({ boundary: "progress_summary", detail_availability: "summary", compatibility: "degraded", proposed_target: expect.any(Object), record: { summary: expect.any(String), migration_provenance: { source_path: ".agentera/progress.yaml", source_record_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(baseline.entries.find((entry) => entry.artifact === "health" && entry.classification === "valid_compacted_summary")).toMatchObject({ boundary: "health_summary", detail_availability: "summary", compatibility: "degraded", proposed_target: expect.any(Object), record: { summary: expect.any(String), migration_provenance: { source_path: ".agentera/health.yaml", source_record_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    const summaryDecision = baseline.entries.find((entry) => entry.source_identity === "decisions:1");
    expect(summaryDecision).toMatchObject({ boundary: "decision_summary", classification: "valid_compacted_summary", detail_availability: "summary", compatibility: "degraded", proposed_target: expect.any(Object), record: { summary: expect.any(String), satisfaction: expect.any(Object), migration_provenance: { source_path: ".agentera/decisions.yaml", source_record_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(baseline.entries.find((entry) => entry.source_identity === "decision_satisfaction:decisions:1")).toBeUndefined();
    expect(baseline.entries.find((entry) => entry.source_identity === "decisions:archive[1]")).toMatchObject({ boundary: "decision_summary", classification: "valid_compacted_summary", proposed_target: expect.any(Object) });
    for (const [entry, source] of [
      [baseline.entries.find((candidate) => candidate.artifact === "progress" && candidate.classification === "valid_compacted_summary"), yaml("output/.agentera/progress.yaml").archive[0]],
      [summaryDecision, yaml("output/.agentera/decisions.yaml").archive.find((candidate: any) => candidate.number === 1)],
      [baseline.entries.find((candidate) => candidate.artifact === "health" && candidate.classification === "valid_compacted_summary"), yaml("output/.agentera/health.yaml").archive[0]],
    ] as const) {
      expect(entry?.record.migration_provenance.source_record_sha256).toBe(sha256(canonicalRecordJson(source)));
      expect(entry?.record).not.toHaveProperty("number");
    }
    for (const [label, withoutSatisfaction, withSatisfaction] of [["high", 6, 7], ["medium", 8, 9], ["low", 10, 11]]) {
      const without = baseline.entries.find((entry) => entry.source_identity === `decisions:${withoutSatisfaction}`)!;
      const satisfied = baseline.entries.find((entry) => entry.source_identity === `decisions:${withSatisfaction}`)!;
      expect(without).toMatchObject({ classification: "recoverable_degraded_full_projection", proposed_target: expect.any(Object), record: { confidence: label } });
      expect(satisfied).toMatchObject({ classification: "recoverable_degraded_full_projection", proposed_target: expect.any(Object), record: { confidence: label } });
      expect(without.canonical_migration_provenance).toMatchObject({ kind: "inherited_decision_confidence", source: "current_projection", source_path: ".agentera/decisions.yaml", confidence: label, source_record_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(satisfied.canonical_migration_provenance).toMatchObject({ kind: "inherited_decision_confidence", source: "current_projection", confidence: label });
      expect(baseline.entries.find((entry) => entry.source_identity === `decision_satisfaction:decisions:${withSatisfaction}`)).toMatchObject({
        classification: "recoverable_degraded_full_projection",
        proposed_target: expect.any(Object),
        relationships: [{ field: "decision", target_id: satisfied.proposed_target!.id, status: "resolved" }],
      });
    }

    const archivedLegacy = project();
    const archivedDecisions = YAML.parse(fs.readFileSync(path.join(archivedLegacy, ".agentera/decisions.yaml"), "utf8"));
    const archiveRoot = path.join(archivedLegacy, ".agentera/archive/decisions");
    fs.mkdirSync(archiveRoot, { recursive: true });
    for (const number of [6, 7, 8, 9, 10, 11]) {
      const record = archivedDecisions.decisions.find((entry: any) => entry.number === number);
      fs.writeFileSync(path.join(archiveRoot, `${number}.yaml`), YAML.stringify({
        schemaVersion: "agentera.stateArchiveEntry.v1",
        artifact_id: "decisions",
        entry_number: number,
        record,
        record_sha256: sha256(canonicalRecordJson(record)),
      }));
    }
    const archivedPlan = planEntityMigration(archivedLegacy, REPO_ROOT);
    for (const [label, withoutSatisfaction, withSatisfaction] of [["high", 6, 7], ["medium", 8, 9], ["low", 10, 11]]) {
      for (const number of [withoutSatisfaction, withSatisfaction]) {
        expect(archivedPlan.entries.find((entry) => entry.source_identity === `decisions:${number}`)).toMatchObject({
          classification: "verified_full",
          proposed_target: expect.any(Object),
          record: { confidence: label },
          canonical_migration_provenance: { kind: "inherited_decision_confidence", source: "verified_archive", source_path: `.agentera/archive/decisions/${number}.yaml`, confidence: label },
        });
      }
      expect(archivedPlan.entries.find((entry) => entry.source_identity === `decision_satisfaction:decisions:${withSatisfaction}`)).toMatchObject({ classification: "verified_full", proposed_target: expect.any(Object) });
    }
    const archiveSixPath = path.join(archiveRoot, "6.yaml");
    const unsupportedArchive = YAML.parse(fs.readFileSync(archiveSixPath, "utf8"));
    unsupportedArchive.record.confidence = "certain";
    unsupportedArchive.record_sha256 = sha256(canonicalRecordJson(unsupportedArchive.record));
    fs.writeFileSync(archiveSixPath, YAML.stringify(unsupportedArchive));
    expect(planEntityMigration(archivedLegacy, REPO_ROOT).entries.find((entry) => entry.source_identity === "decisions:6")).toMatchObject({ classification: "corrupt", proposed_target: null });
    unsupportedArchive.record.confidence = "high";
    delete unsupportedArchive.record.reasoning;
    unsupportedArchive.record_sha256 = sha256(canonicalRecordJson(unsupportedArchive.record));
    fs.writeFileSync(archiveSixPath, YAML.stringify(unsupportedArchive));
    expect(planEntityMigration(archivedLegacy, REPO_ROOT).entries.find((entry) => entry.source_identity === "decisions:6")).toMatchObject({ classification: "corrupt", proposed_target: null });

    const backed = project();
    const archivePath = path.join(backed, ".agentera/archive/decisions/1.yaml");
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, "backed-summary/decisions-1.archive.yaml"), archivePath);
    const backedEntry = planEntityMigration(backed, REPO_ROOT).entries.find((entry) => entry.source_identity === "decisions:1");
    expect(backedEntry).toMatchObject({ boundary: "decision", classification: "verified_full", detail_availability: "full", compatibility: "current" });
    expect(backedEntry?.record).not.toHaveProperty("migration_provenance");
    expect(planEntityMigration(backed, REPO_ROOT).entries.find((entry) => entry.source_identity === "decision_satisfaction:decisions:1")).toMatchObject({
      classification: "verified_full",
      relationships: [{ field: "decision", target_id: backedEntry?.proposed_target?.id, status: "resolved" }],
    });

    const corrupt = project();
    fs.copyFileSync(path.join(FIXTURE_ROOT, "cases/non-confidence-corruption.progress.yaml"), path.join(corrupt, ".agentera/progress.yaml"));
    expect(planEntityMigration(corrupt, REPO_ROOT).entries.find((entry) => entry.source_identity === "progress:99")).toMatchObject({ classification: "corrupt" });

    const unsupportedLabel = project();
    const decisionsPath = path.join(unsupportedLabel, ".agentera/decisions.yaml");
    const decisions = YAML.parse(fs.readFileSync(decisionsPath, "utf8"));
    decisions.decisions.find((entry: any) => entry.number === 6).confidence = "certain";
    fs.writeFileSync(decisionsPath, YAML.stringify(decisions));
    expect(planEntityMigration(unsupportedLabel, REPO_ROOT).entries.find((entry) => entry.source_identity === "decisions:6")).toMatchObject({ classification: "corrupt", proposed_target: null });

    const additionalViolation = project();
    const additionalPath = path.join(additionalViolation, ".agentera/decisions.yaml");
    const additionalDecisions = YAML.parse(fs.readFileSync(additionalPath, "utf8"));
    delete additionalDecisions.decisions.find((entry: any) => entry.number === 6).reasoning;
    fs.writeFileSync(additionalPath, YAML.stringify(additionalDecisions));
    expect(planEntityMigration(additionalViolation, REPO_ROOT).entries.find((entry) => entry.source_identity === "decisions:6")).toMatchObject({ classification: "corrupt", proposed_target: null });
  });

  it("removes every authority-prohibited persisted alias from canonical migration records", () => {
    const forbiddenAliases = entityForbiddenCanonicalAliases(REPO_ROOT);
    const source = Object.fromEntries(forbiddenAliases.map((alias) => [alias, `forbidden ${alias}`]));
    expect(canonicalMigrationRecord("progress_summary", { ...source, summary: "retained" }, forbiddenAliases)).toEqual({ summary: "retained" });
  });
});

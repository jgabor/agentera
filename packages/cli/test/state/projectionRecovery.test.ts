import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";
import { yamlArchiveEntry } from "../../src/hooks/compaction/retention.js";
import { applyProjectionRecovery, parseLegacyHealthMarkdown, previewProjectionRecovery } from "../../src/state/projectionRecovery.js";
import { runBackfill } from "../../src/cli/commands/backfill.js";
import { planEntityMigration } from "../../src/state/entityMigrationPreview.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];
function git(root: string, args: string[]): string { const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); if (result.status) throw new Error(String(result.stderr)); return String(result.stdout).trim(); }
function write(root: string, relative: string, value: Record<string, unknown>): void { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, dumpYamlMapping(value)); }
function commit(root: string, message: string): void { git(root, ["add", "."]); git(root, ["commit", "--quiet", "-m", message]); }
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-projection-recovery-")); roots.push(root); git(root, ["init", "--quiet"]); git(root, ["config", "user.name", "Recovery Test"]); git(root, ["config", "user.email", "recovery@example.invalid"]); git(root, ["config", "commit.gpgsign", "false"]);
  const decision = { number: 1, date: "2026-07-17", question: "Recover?", context: "Exact causal fixture.", alternatives: [{ name: "yes", status: "chosen" }, { name: "no", status: "rejected" }], choice: "yes", reasoning: "validated", confidence: "firm", feeds_into: "Task 13", satisfaction: { state: "provisionally_satisfied", evidence: "full archive evidence" } };
  const health = { number: 10, date: "2026-07-17", dimensions: ["architecture_alignment"], findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }, trajectory: "stable", grades: { architecture_alignment: "A" } };
  write(root, ".agentera/decisions.yaml", { decisions: [decision] }); write(root, ".agentera/health.yaml", { audits: [health] }); commit(root, "full records");
  write(root, ".agentera/decisions.yaml", { decisions: [], archive: [yamlArchiveEntry("decisions", decision)] }); write(root, ".agentera/health.yaml", { audits: [], archive: [yamlArchiveEntry("health", health)] }); commit(root, "compact records");
  const current = loadYamlMapping(fs.readFileSync(path.join(root, ".agentera/decisions.yaml"), "utf8")); delete (current.archive as Record<string, unknown>[])[0].satisfaction; (current.archive as Record<string, unknown>[])[0].choice = "editorial overlay"; (current.archive as Record<string, unknown>[])[0].outcome = "editorial overlay"; write(root, ".agentera/decisions.yaml", current); commit(root, "overlay compact decision");
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("projection recovery", () => {
  it("requires the exact reviewed digest for an editorial replacement, binds a manifest, and replays", () => {
    const root = fixture(); const before = git(root, ["status", "--short"]); const preview = previewProjectionRecovery(root, SOURCE_ROOT);
    expect(preview).toMatchObject({ status: "blocked", read_only: true, mutation_performed: false, counts: { selected: 2, approval_required: 1, decisions: 1, health: 1, refused: 0 } }); expect(git(root, ["status", "--short"])).toBe(before);
    expect(applyProjectionRecovery(root, SOURCE_ROOT)).toMatchObject({ status: "blocked", mutation_performed: false });
    expect(applyProjectionRecovery(root, SOURCE_ROOT, "0".repeat(64))).toMatchObject({ status: "blocked", mutation_performed: false });
    expect(fs.existsSync(path.join(root, ".agentera/archive"))).toBe(false);
    const applied = applyProjectionRecovery(root, SOURCE_ROOT, preview.recovery_set_digest); expect(applied.counts.applied).toBe(2);
    const decision = loadYamlMapping(fs.readFileSync(path.join(root, ".agentera/archive/decisions/1.yaml"), "utf8")); expect((decision.record as Record<string, unknown>).choice).toBe("editorial overlay"); expect(decision).toHaveProperty("recovery_provenance.projection_transition.parent_count", 1);
    expect(fs.readFileSync(path.join(root, applied.correlation_manifest.path), "utf8")).toContain(preview.recovery_set_digest);
    const replay = applyProjectionRecovery(root, SOURCE_ROOT); expect(replay).toMatchObject({ status: "complete", mutation_performed: false, counts: { replayed: 2, refused: 0 } });
  });

  it("refuses a divergent immutable recovery envelope", () => {
    const root = fixture(); const preview = previewProjectionRecovery(root, SOURCE_ROOT); applyProjectionRecovery(root, SOURCE_ROOT, preview.recovery_set_digest); fs.appendFileSync(path.join(root, ".agentera/archive/health/10.yaml"), "unexpected: true\n");
    const changed = previewProjectionRecovery(root, SOURCE_ROOT); expect(changed.status).toBe("blocked"); expect(changed.entries.find((entry) => entry.artifact === "health")?.refusal?.class).toBe("immutable_conflict");
  });

  it("defaults the recovery selector to dry-run and requires apply plus force", () => {
    const root = fixture(); let output = "";
    expect(runBackfill(["--recover-projections", "--project", root, "--format", "json"], { out: (text) => { output += text; }, err: () => undefined }, SOURCE_ROOT)).toBe(1);
    const preview = JSON.parse(output); expect(preview).toMatchObject({ mode: "preview", read_only: true, mutation_performed: false, counts: { approval_required: 1 } }); output = "";
    expect(runBackfill(["--recover-projections", "--project", root, "--apply", "--format", "json"], { out: (text) => { output += text; }, err: () => undefined }, SOURCE_ROOT)).toBe(2);
    expect(JSON.parse(output)).toMatchObject({ status: "fail", error: { message: "--apply requires explicit --force intent" } });
    output = ""; expect(runBackfill(["--recover-projections", "--project", root, "--apply", "--force", "--recovery-digest", preview.recovery_set_digest, "--format", "json"], { out: (text) => { output += text; }, err: () => undefined }, SOURCE_ROOT)).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ status: "complete", correlation_manifest: { present: true } });
  });

  it("preserves exact legacy health section bytes without inventing absent fields", () => {
    const raw = "# Health\n\n## Audit 1 · 2026-03-30\n\n**Dimensions assessed**: architecture alignment, pattern consistency\n**Findings**: 0 critical, 1 warning, 2 info (0 filtered by confidence)\n**Grades**: Architecture [B] | Patterns [C]\n\nUnmodeled prose.\n";
    const [section] = parseLegacyHealthMarkdown(raw); expect(section.raw).toBe(raw.slice(raw.indexOf("## Audit"))); expect(section.record).toMatchObject({ number: 1, historical_baseline: true, findings_summary: { warning: 1 }, grades: { Architecture: "B" } }); expect(section.record).not.toHaveProperty("trajectory");
  });

  it("refuses a summary that has no exact causal projection transition", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-projection-mismatch-")); roots.push(root); git(root, ["init", "--quiet"]); git(root, ["config", "user.name", "Recovery Test"]); git(root, ["config", "user.email", "recovery@example.invalid"]); git(root, ["config", "commit.gpgsign", "false"]);
    write(root, ".agentera/decisions.yaml", { decisions: [], archive: [{ summary: "Decision 1 (2026-07-17): unrelated replacement" }] }); write(root, ".agentera/health.yaml", { audits: [] }); commit(root, "summary without parent");
    const preview = previewProjectionRecovery(root, SOURCE_ROOT); expect(preview.entries.find((entry) => entry.artifact === "decisions")?.refusal?.class).toBe("candidate_missing");
  });

  it("prefers the exact deterministic projection of the final parent over older transitions", () => {
    const root = fixture(); const full = { number: 1, date: "2026-07-17", question: "Recover differently?", context: "Second exact parent.", alternatives: [{ name: "no", status: "chosen" }], choice: "no", reasoning: "different", confidence: "firm", feeds_into: "Task 13" };
    write(root, ".agentera/decisions.yaml", { decisions: [full] }); commit(root, "second full parent"); write(root, ".agentera/decisions.yaml", { decisions: [], archive: [yamlArchiveEntry("decisions", full)] }); commit(root, "second compact child");
    const preview = previewProjectionRecovery(root, SOURCE_ROOT); const decision = preview.entries.find((entry) => entry.artifact === "decisions"); expect(decision?.status).toBe("ready"); expect(decision).not.toHaveProperty("refusal");
  });

  it("never auto-readies a same-number unrelated replacement by label alone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-projection-adversarial-")); roots.push(root); git(root, ["init", "--quiet"]); git(root, ["config", "user.name", "Recovery Test"]); git(root, ["config", "user.email", "recovery@example.invalid"]); git(root, ["config", "commit.gpgsign", "false"]);
    const full = { number: 1, date: "2026-07-17", question: "Trusted?", context: "Original", alternatives: [{ name: "yes", status: "chosen" }], choice: "yes", reasoning: "original", confidence: "firm" };
    write(root, ".agentera/decisions.yaml", { decisions: [full] }); write(root, ".agentera/health.yaml", { audits: [] }); commit(root, "full");
    write(root, ".agentera/decisions.yaml", { decisions: [], archive: [{ summary: "Decision 1: unrelated adversarial text" }] }); commit(root, "unrelated replacement");
    const preview = previewProjectionRecovery(root, SOURCE_ROOT); expect(preview).toMatchObject({ status: "blocked", counts: { ready: 0, approval_required: 1 } });
    expect(applyProjectionRecovery(root, SOURCE_ROOT)).toMatchObject({ mutation_performed: false }); expect(fs.existsSync(path.join(root, ".agentera/archive"))).toBe(false);
  });

  it("fails when the immutable correlation manifest is changed", () => {
    const root = fixture(); const preview = previewProjectionRecovery(root, SOURCE_ROOT); applyProjectionRecovery(root, SOURCE_ROOT, preview.recovery_set_digest);
    fs.appendFileSync(path.join(root, preview.correlation_manifest.path), "unexpected: true\n");
    expect(previewProjectionRecovery(root, SOURCE_ROOT)).toMatchObject({ status: "blocked", counts: { refused: 2 } });
  });

  it("fails an unlisted recovered archive after the manifest is bound", () => {
    const root = fixture(); const preview = previewProjectionRecovery(root, SOURCE_ROOT); applyProjectionRecovery(root, SOURCE_ROOT, preview.recovery_set_digest);
    fs.copyFileSync(path.join(root, ".agentera/archive/decisions/1.yaml"), path.join(root, ".agentera/archive/decisions/2.yaml"));
    const changed = previewProjectionRecovery(root, SOURCE_ROOT); expect(changed).toMatchObject({ status: "blocked", counts: { refused: 1 } }); expect(changed.entries.find((entry) => entry.number === 2)?.refusal?.class).toBe("manifest_mismatch");
  });

  it("emits archive-authoritative nested satisfaction exactly once without inventing revisions", () => {
    const root = fixture(); const recovery = previewProjectionRecovery(root, SOURCE_ROOT); applyProjectionRecovery(root, SOURCE_ROOT, recovery.recovery_set_digest);
    const plan = planEntityMigration(root, SOURCE_ROOT); const satisfactions = plan.entries.filter((entry) => entry.boundary === "decision_satisfaction");
    expect(satisfactions).toHaveLength(1); expect(satisfactions[0]).toMatchObject({ source_identity: "decision_satisfaction:decisions:1", provenance: ["verified_archive"], record: { state: "provisionally_satisfied", evidence: "full archive evidence", decision: expect.stringMatching(/^[a-z]{10}$/) } });
    expect(plan.entries.filter((entry) => entry.boundary === "decision_revision")).toHaveLength(0);
    expect(new Set(plan.entries.map((entry) => entry.proposed_target?.id).filter(Boolean)).size).toBe(plan.entries.filter((entry) => entry.proposed_target).length);
  });
});

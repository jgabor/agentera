import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";
import { yamlArchiveEntry } from "../../src/hooks/compaction/retention.js";
import { applyProjectionRecovery, parseLegacyHealthMarkdown, previewProjectionRecovery } from "../../src/state/projectionRecovery.js";
import { runBackfill } from "../../src/cli/commands/backfill.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];
function git(root: string, args: string[]): string { const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); if (result.status) throw new Error(String(result.stderr)); return String(result.stdout).trim(); }
function write(root: string, relative: string, value: Record<string, unknown>): void { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, dumpYamlMapping(value)); }
function commit(root: string, message: string): void { git(root, ["add", "."]); git(root, ["commit", "--quiet", "-m", message]); }
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-projection-recovery-")); roots.push(root); git(root, ["init", "--quiet"]); git(root, ["config", "user.name", "Recovery Test"]); git(root, ["config", "user.email", "recovery@example.invalid"]); git(root, ["config", "commit.gpgsign", "false"]);
  const decision = { number: 1, date: "2026-07-17", question: "Recover?", context: "Exact causal fixture.", alternatives: [{ name: "yes", status: "chosen" }, { name: "no", status: "rejected" }], choice: "yes", reasoning: "validated", confidence: "firm", feeds_into: "Task 13" };
  const health = { number: 10, date: "2026-07-17", dimensions: ["architecture_alignment"], findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }, trajectory: "stable", grades: { architecture_alignment: "A" } };
  write(root, ".agentera/decisions.yaml", { decisions: [decision] }); write(root, ".agentera/health.yaml", { audits: [health] }); commit(root, "full records");
  write(root, ".agentera/decisions.yaml", { decisions: [], archive: [yamlArchiveEntry("decisions", decision)] }); write(root, ".agentera/health.yaml", { audits: [], archive: [yamlArchiveEntry("health", health)] }); commit(root, "compact records");
  const current = loadYamlMapping(fs.readFileSync(path.join(root, ".agentera/decisions.yaml"), "utf8")); (current.archive as Record<string, unknown>[])[0].choice = "editorial overlay"; (current.archive as Record<string, unknown>[])[0].outcome = "editorial overlay"; write(root, ".agentera/decisions.yaml", current); commit(root, "overlay compact decision");
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("projection recovery", () => {
  it("previews without writes, overlays explicit current fields, applies atomically, and replays", () => {
    const root = fixture(); const before = git(root, ["status", "--short"]); const preview = previewProjectionRecovery(root, SOURCE_ROOT);
    expect(preview).toMatchObject({ status: "ready", read_only: true, mutation_performed: false, counts: { selected: 2, decisions: 1, health: 1, refused: 0 } }); expect(git(root, ["status", "--short"])).toBe(before);
    const applied = applyProjectionRecovery(root, SOURCE_ROOT); expect(applied.counts.applied).toBe(2);
    const decision = loadYamlMapping(fs.readFileSync(path.join(root, ".agentera/archive/decisions/1.yaml"), "utf8")); expect((decision.record as Record<string, unknown>).choice).toBe("editorial overlay"); expect(decision).toHaveProperty("recovery_provenance.projection_transition.parent_count", 1);
    const replay = applyProjectionRecovery(root, SOURCE_ROOT); expect(replay).toMatchObject({ status: "complete", mutation_performed: false, counts: { replayed: 2, refused: 0 } });
  });

  it("refuses a divergent immutable recovery envelope", () => {
    const root = fixture(); applyProjectionRecovery(root, SOURCE_ROOT); fs.appendFileSync(path.join(root, ".agentera/archive/health/10.yaml"), "unexpected: true\n");
    const preview = previewProjectionRecovery(root, SOURCE_ROOT); expect(preview.status).toBe("blocked"); expect(preview.entries.find((entry) => entry.artifact === "health")?.refusal?.class).toBe("immutable_conflict");
  });

  it("defaults the recovery selector to dry-run and requires apply plus force", () => {
    const root = fixture(); let output = "";
    expect(runBackfill(["--recover-projections", "--project", root, "--format", "json"], { out: (text) => { output += text; }, err: () => undefined }, SOURCE_ROOT)).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ mode: "preview", read_only: true, mutation_performed: false }); output = "";
    expect(runBackfill(["--recover-projections", "--project", root, "--apply", "--format", "json"], { out: (text) => { output += text; }, err: () => undefined }, SOURCE_ROOT)).toBe(2);
    expect(JSON.parse(output)).toMatchObject({ status: "fail", error: { message: "--apply requires explicit --force intent" } });
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

  it("refuses distinct valid causal parents for one identity", () => {
    const root = fixture(); const full = { number: 1, date: "2026-07-17", question: "Recover differently?", context: "Second exact parent.", alternatives: [{ name: "no", status: "chosen" }], choice: "no", reasoning: "different", confidence: "firm", feeds_into: "Task 13" };
    write(root, ".agentera/decisions.yaml", { decisions: [full] }); commit(root, "second full parent"); write(root, ".agentera/decisions.yaml", { decisions: [], archive: [yamlArchiveEntry("decisions", full)] }); commit(root, "second compact child");
    const preview = previewProjectionRecovery(root, SOURCE_ROOT); expect(preview.entries.find((entry) => entry.artifact === "decisions")?.refusal?.class).toBe("candidate_ambiguous");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { entityMigrateHelp } from "../../src/cli/commands/entityMigrate.js";
import { applyEntityMigration, EntityMigrationOperationError, resumeEntityMigration, rollbackEntityMigration } from "../../src/state/entityMigrationApply.js";
import { previewEntityMigration } from "../../src/state/entityMigrationPreview.js";
import { detectStateMode } from "../../src/state/stateMode.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../../..");
const WORKER = path.join(import.meta.dirname, "entityMigrationWorker.mjs");
const roots: string[] = [];
const fixtures: Record<string, string> = {
  "TODO.md": "# TODO\n\n## → Normal\n- [ ] Preserve exact state.\n",
  ".agentera/docs.yaml": "index:\n  - document: README\n    path: README.md\n    last_updated: 2026-07-17\n    status: current\n",
  ".agentera/progress.yaml": "cycles:\n  - number: 1\n    timestamp: 2026-07-17 10:00\n    type: feat\n    phase: build\n    what: migrated\n    context:\n      intent: test\n",
  ".agentera/decisions.yaml": "decisions:\n  - number: 1\n    date: 2026-07-17\n    question: Migrate?\n    context: Test migration.\n    alternatives:\n      - name: yes\n        status: chosen\n    choice: yes\n    reasoning: Durable.\n    confidence: firm\n",
  ".agentera/health.yaml": "audits:\n  - number: 1\n    date: 2026-07-17\n    dimensions: [architecture_alignment]\n    findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }\n    trajectory: stable\n    grades: { architecture_alignment: A }\n",
  ".agentera/plan.yaml": "header:\n  level: light\n  created: 2026-07-17\n  status: open\n  title: Migration fixture\n  id: plan:123e4567-e89b-42d3-a456-426614174000\nwhat: migrate\nwhy: durability\nscope: { included: [state], excluded: [] }\ntasks:\n  - number: 1\n    name: migrate\n    status: pending\n    depends_on: []\n    acceptance: [pass]\n",
};

function project(extra: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-entity-apply-")); roots.push(root);
  for (const [relative, bytes] of Object.entries({ ...fixtures, ...extra })) { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); }
  return root;
}
function capture(args: string[]): { rc: number; out: string; err: string } {
  let out = "", err = ""; const rc = main(["node", "agentera", ...args], { out: (value) => out += value, err: (value) => err += value }); return { rc, out, err };
}
function files(root: string, relative: string): string[] {
  const start = path.join(root, relative); if (!fs.existsSync(start)) return [];
  return fs.readdirSync(start, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("durable entity migration", () => {
  it("publishes apply, resume, rollback, JSON, help, and schema as one headless contract", () => {
    const help = entityMigrateHelp(); expect(help).toContain("--resume ID --force"); expect(help).toContain("--rollback ID --force"); expect(help).toContain("without prompting");
    const schema = buildSchemaPayload(); expect(schema.entity_migration).toMatchObject({ status: "durable_apply_resume_rollback_implemented", invocation: { resume_command: expect.stringContaining("--resume MIGRATION_ID"), rollback_command: expect.stringContaining("--rollback MIGRATION_ID") } });
    const invalid = capture(["state", "migrate", "entities", "--resume", "bad", "--force", "--format", "json"]); expect(invalid.rc).toBe(2); expect(() => JSON.parse(invalid.out)).not.toThrow(); expect(invalid.err).toBe("");
  });
  it("requires explicit approval and leaves blocked inventory with zero durable effects", () => {
    const root = project({ ".agentera/progress.yaml": "cycles: [broken]\n" });
    const noIntent = capture(["state", "migrate", "entities", "--project", root, "--format", "json"]);
    expect(noIntent.rc).toBe(2); expect(JSON.parse(noIntent.out).error.message).toContain("choose exactly one");
    const preview = previewEntityMigration(root, SOURCE_ROOT);
    const apply = capture(["state", "migrate", "entities", "--project", root, "--apply", "--force", "--source-fingerprint", preview.source_fingerprint, "--preview-digest", preview.preview_digest, "--format", "json"]);
    expect(apply.rc).toBe(1); expect(JSON.parse(apply.out).error.class).toBe("inventory_blocked");
    expect(fs.existsSync(path.join(root, ".agentera/migrations"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
  });

  it("prepares immutable evidence, cuts over once, repeats without rewrites, and rolls back exactly", () => {
    const root = project(); const legacy = new Map(Object.keys(fixtures).map((relative) => [relative, fs.readFileSync(path.join(root, relative))]));
    fs.chmodSync(path.join(root, "TODO.md"), 0o640); const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 });
    expect(preview.status).toBe("ready"); expect(detectStateMode(root, SOURCE_ROOT)).toBe("legacy");
    const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
    expect(applied).toMatchObject({ status: "complete", phase: "cutover_complete", idempotent: false, mutation_performed: true });
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    const evidenceFiles = Object.values(applied.evidence).map((relative) => path.join(root, relative)); expect(evidenceFiles.every((file) => fs.existsSync(file))).toBe(true);
    const entityFiles = files(root, ".agentera/entities"); expect(entityFiles).toHaveLength(preview.counts.total);
    const before = new Map(entityFiles.map((file) => [file, { bytes: fs.readFileSync(file), stat: fs.statSync(file) }]));
    const replay = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
    expect(replay).toMatchObject({ status: "complete", idempotent: true, mutation_performed: false, migration_id: applied.migration_id });
    for (const [file, value] of before) { const stat = fs.statSync(file); expect(fs.readFileSync(file)).toEqual(value.bytes); expect(stat.ino).toBe(value.stat.ino); expect(stat.mtimeMs).toBe(value.stat.mtimeMs); }
    const rolled = rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id);
    expect(rolled).toMatchObject({ status: "rolled_back", idempotent: false }); expect(detectStateMode(root, SOURCE_ROOT)).toBe("legacy"); expect(files(root, ".agentera/entities")).toEqual([]);
    for (const [relative, bytes] of legacy) expect(fs.readFileSync(path.join(root, relative))).toEqual(bytes);
    expect(fs.statSync(path.join(root, "TODO.md")).mode & 0o777).toBe(0o640);
    expect(rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id)).toMatchObject({ idempotent: true, mutation_performed: false });
  });

  it("refuses rollback after a post-cutover write and retains all recovery evidence", () => {
    const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
    const entity = files(root, ".agentera/entities")[0]; fs.appendFileSync(entity, "# post-cutover\n");
    expect(() => rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id)).toThrow(EntityMigrationOperationError);
    expect(fs.existsSync(path.join(root, applied.evidence.journal))).toBe(true); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(true); expect(fs.existsSync(entity)).toBe(true);
  });

  it("resumes every durable phase boundary without reallocating IDs or duplicating relationships", () => {
    for (const phase of ["prepare_recovery", "publish_entities", "validate_graph", "cutover", "cutover_complete"]) {
      const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 });
      const child = spawnSync(process.execPath, [WORKER], {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test", AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE: phase, AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT: root, AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT: SOURCE_ROOT, AGENTERA_ENTITY_MIGRATION_CRASH_FINGERPRINT: preview.source_fingerprint, AGENTERA_ENTITY_MIGRATION_CRASH_DIGEST: preview.preview_digest },
      });
      expect(child.status, `${phase}: ${child.stdout}\n${child.stderr}`).not.toBe(0);
      const migrations = fs.readdirSync(path.join(root, ".agentera/migrations/entities")); expect(migrations).toHaveLength(1);
      for (const name of ["manifest.yaml", "snapshot.yaml", "journal.yaml"]) expect(fs.existsSync(path.join(root, ".agentera/migrations/entities", migrations[0], name))).toBe(true);
      const markerExists = fs.existsSync(path.join(root, ".agentera/state-mode.yaml")); expect(markerExists).toBe(["cutover", "cutover_complete"].includes(phase));
      if (markerExists) expect(files(root, ".agentera/entities")).toHaveLength(preview.counts.total);
      const resumed = resumeEntityMigration(root, SOURCE_ROOT, migrations[0]); expect(resumed.status).toBe("complete");
      const ids = files(root, ".agentera/entities").map((file) => path.basename(file, ".yaml")).sort(); expect(new Set(ids).size).toBe(ids.length); expect(ids).toEqual(preview.entries.map((entry) => entry.proposed_target!.id).sort());
      expect(rollbackEntityMigration(root, SOURCE_ROOT, migrations[0]).status).toBe("rolled_back");
    }
  }, 120_000);

  it("refuses source drift after durable preparation before publishing any entity", () => {
    const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT);
    spawnSync(process.execPath, [WORKER], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE: "prepare_recovery", AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT: root, AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT: SOURCE_ROOT, AGENTERA_ENTITY_MIGRATION_CRASH_FINGERPRINT: preview.source_fingerprint, AGENTERA_ENTITY_MIGRATION_CRASH_DIGEST: preview.preview_digest } });
    const id = fs.readdirSync(path.join(root, ".agentera/migrations/entities"))[0]; fs.appendFileSync(path.join(root, "TODO.md"), "- [ ] changed\n");
    expect(() => resumeEntityMigration(root, SOURCE_ROOT, id)).toThrow(/legacy source changed/); expect(files(root, ".agentera/entities")).toEqual([]); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
  }, 30_000);

  it("serializes concurrent approved applies into one canonical graph", async () => {
    const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT);
    const env = { ...process.env, AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT: root, AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT: SOURCE_ROOT, AGENTERA_ENTITY_MIGRATION_CRASH_FINGERPRINT: preview.source_fingerprint, AGENTERA_ENTITY_MIGRATION_CRASH_DIGEST: preview.preview_digest };
    const run = () => new Promise<number | null>((resolve) => { const child = spawn(process.execPath, [WORKER], { env, stdio: "ignore" }); child.on("exit", resolve); });
    const results = (await Promise.all([run(), run()])).sort(); expect(results[0]).toBe(0); expect([0, 1]).toContain(results[1]); expect(files(root, ".agentera/entities")).toHaveLength(preview.counts.total); expect(fs.readdirSync(path.join(root, ".agentera/migrations/entities"))).toHaveLength(1);
  }, 30_000);

  it("round-trips every itemized entity family while preserving singleton documents", () => {
    const objective = "objective:323e4567-e89b-42d3-a456-426614174000";
    const root = project({
      ".agentera/overlays/decisions.yaml": "decisions:1:\n  satisfaction:\n    state: provisionally_satisfied\n    evidence: fixture\n",
      ".agentera/revisions/decisions.yaml": "decisions:1:\n  - date: 2026-07-17\n    choice: revised\n    provenance: historical_revision\n",
      ".agentera/optimize/latency/objective.yaml": `header:\n  id: ${objective}\n  title: Reduce latency\n  status: open\nobjective: { description: Reduce latency, measurement: p95, constraints: [] }\nmetric: { direction: minimize, unit: ms }\nbaseline: { description: 100 ms }\ngates: {}\nscope: { included: [CLI], excluded: [] }\n`,
      ".agentera/optimize/latency/experiments.yaml": "experiments:\n  - number: 1\n    date: 2026-07-17 10:00\n    label: baseline\n    hypothesis: establish baseline\n    method: measure\n    change: none\n    metric: 100\n    regression: none\n    status: baseline\n    conclusion: established\n",
      ".agentera/vision.yaml": "north_star: preserved\n", "DESIGN.md": "# Design\n", "CHANGELOG.md": "# Changelog\n",
    });
    const singletonPaths = [".agentera/vision.yaml", "DESIGN.md", "CHANGELOG.md", ".agentera/docs.yaml"]; const singletonBytes = singletonPaths.map((relative) => fs.readFileSync(path.join(root, relative)));
    const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 }); expect(preview.status).toBe("ready");
    const boundaries = new Set(preview.entries.map(({ boundary }) => boundary)); expect(boundaries).toEqual(new Set(["progress_cycle", "decision", "decision_satisfaction", "decision_revision", "health_audit", "plan", "plan_task", "objective", "experiment", "todo_item", "documentation_inventory_entry"]));
    const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest); expect(applied.entity_count).toBe(preview.counts.total);
    singletonPaths.forEach((relative, index) => expect(fs.readFileSync(path.join(root, relative))).toEqual(singletonBytes[index]));
    rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id); singletonPaths.forEach((relative, index) => expect(fs.readFileSync(path.join(root, relative))).toEqual(singletonBytes[index]));
  });

  it("never removes an exact-byte successor entity or marker during rollback", () => {
    for (const replace of ["entity", "marker"] as const) {
      const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
      const target = replace === "entity" ? files(root, ".agentera/entities")[0] : path.join(root, ".agentera/state-mode.yaml"); const bytes = fs.readFileSync(target); const prior = fs.statSync(target).ino;
      fs.renameSync(target, `${target}.prior`); fs.writeFileSync(target, bytes); const successor = fs.statSync(target).ino; expect(successor).not.toBe(prior);
      expect(() => rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id)).toThrow(/changed after cutover/); expect(fs.statSync(target).ino).toBe(successor); expect(fs.readFileSync(target)).toEqual(bytes); expect(fs.existsSync(path.join(root, applied.evidence.snapshot))).toBe(true);
    }
  });

  it("rejects migration evidence path symlinks before creating a journal or entity", () => {
    const root = project(); const outside = project(); const outsideBefore = files(outside, "."); fs.mkdirSync(path.join(root, ".agentera/migrations")); fs.symlinkSync(outside, path.join(root, ".agentera/migrations/entities"), "dir"); const preview = previewEntityMigration(root, SOURCE_ROOT);
    expect(() => applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest)).toThrow(/must be a real project directory/); expect(files(root, ".agentera/entities")).toEqual([]); expect(files(outside, ".")).toEqual(outsideBefore);
  });

  it("detects evidence-parent replacement and removes only its detached preparation", () => {
    const root = project(); const external = project(); const preview = previewEntityMigration(root, SOURCE_ROOT); const parent = path.join(root, ".agentera/migrations/entities"); const held = path.join(external, "held-entities"); const successor = path.join(external, "successor"); fs.mkdirSync(successor);
    const rename = fs.renameSync.bind(fs); let replaced = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (!replaced && String(source).includes(".prepare-") && String(target).startsWith("/proc/self/fd/")) { replaced = true; rename(parent, held); fs.symlinkSync(successor, parent, "dir"); }
      return rename(source, target);
    });
    expect(() => applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest)).toThrow(/changed during preparation/); expect(replaced).toBe(true); expect(files(held, ".")).toEqual([]); expect(files(successor, ".")).toEqual([]); expect(files(root, ".agentera/entities")).toEqual([]); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
  });

  it("resumes interruption at every guarded rollback boundary without deleting successors", () => {
    for (const phase of ["rollback_prepared", "rollback_cutover", "rolled_back"]) {
      const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
      const child = spawnSync(process.execPath, [WORKER], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE: phase, AGENTERA_ENTITY_MIGRATION_WORKER_OPERATION: "rollback", AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT: root, AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT: SOURCE_ROOT, AGENTERA_ENTITY_MIGRATION_ID: applied.migration_id } });
      expect(child.status, `${phase}: ${child.stdout}\n${child.stderr}`).not.toBe(0); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(phase === "rollback_prepared");
      expect(rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id).status).toBe("rolled_back"); expect(files(root, ".agentera/entities")).toEqual([]); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    }
  });
});

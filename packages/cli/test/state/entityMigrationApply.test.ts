import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { entityMigrateHelp } from "../../src/cli/commands/entityMigrate.js";
import { applyEntityMigration, EntityMigrationOperationError, resumeEntityMigration, rollbackEntityMigration } from "../../src/state/entityMigrationApply.js";
import { EntityPublicationContext } from "../../src/state/entityPublicationContext.js";
import { previewEntityMigration } from "../../src/state/entityMigrationPreview.js";
import { detectStateMode } from "../../src/state/stateMode.js";
import { loadYamlMapping } from "../../src/core/yaml.js";
import { generateEntityMigrationApproval } from "../../src/state/entityMigrationApproval.js";

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
function git(root: string, args: string[]): string { const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); if (result.status) throw new Error(String(result.stderr)); return String(result.stdout).trim(); }
function gitProject(): string {
  const root = project({ "README.md": "approved\n" }); git(root, ["init", "--quiet"]); git(root, ["config", "user.name", "Approval Test"]); git(root, ["config", "user.email", "approval@example.invalid"]); git(root, ["config", "commit.gpgsign", "false"]); git(root, ["add", "."]); git(root, ["commit", "--quiet", "-m", "approved"]); return root;
}
function approvalFile(root: string, source: string, digest: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-approval-envelope-")); roots.push(directory); const file = path.join(directory, "approval.json"); fs.writeFileSync(file, JSON.stringify(generateEntityMigrationApproval(root, source, digest))); return file;
}
function expectNoMigrationEffects(root: string): void { expect(fs.existsSync(path.join(root, ".agentera/migrations"))).toBe(false); expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false); }

afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("durable entity migration", () => {
  it("makes maintenance validation fail read-only when a manifest target is missing", () => {
    const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 }); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
    const manifest = loadYamlMapping(fs.readFileSync(path.join(root, applied.evidence.manifest), "utf8")); const entry = (manifest.entries as Array<Record<string, any>>)[0];
    fs.rmSync(path.join(root, entry.proposed_target.path));
    const before = files(root, ".agentera").map((file) => [file, fs.readFileSync(file, "utf8")]);
    const result = capture(["check", "validate", "state", "--cwd", root, "--format", "json"]);
    expect(result.rc).toBe(1); expect(JSON.parse(result.out).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_migrated_entity", path: entry.proposed_target.path })]));
    expect(files(root, ".agentera").map((file) => [file, fs.readFileSync(file, "utf8")])).toEqual(before);
  });
  it("rejects an atomic same-ID marker replacement with fabricated completed binding", () => {
    const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 }); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
    const marker = path.join(root, ".agentera/state-mode.yaml");
    fs.renameSync(marker, `${marker}.original`); fs.writeFileSync(marker, `schemaVersion: agentera.stateMode.v1\nmode: entities\nmigration_id: ${applied.migration_id}\nsource_fingerprint: ${"0".repeat(64)}\npreview_digest: ${"1".repeat(64)}\n`);
    const result = capture(["check", "validate", "state", "--cwd", root, "--format", "json"]);
    expect(result.rc).toBe(1); expect(JSON.parse(result.out).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_state_marker_or_manifest", message: expect.stringMatching(/marker does not match immutable evidence/) })]));
  });
  it("accepts byte-identical marker and canonical entity inode replacements", () => {
    const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 }); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
    const manifest = loadYamlMapping(fs.readFileSync(path.join(root, applied.evidence.manifest), "utf8")); const target = path.join(root, (manifest.entries as Array<Record<string, any>>)[0].proposed_target.path);
    for (const file of [path.join(root, ".agentera/state-mode.yaml"), target]) { const bytes = fs.readFileSync(file); const old = `${file}.old`; fs.renameSync(file, old); fs.writeFileSync(file, bytes); fs.rmSync(old); }
    const result = capture(["check", "validate", "state", "--cwd", root, "--format", "json"]); expect(result.rc, result.out).toBe(0); expect(JSON.parse(result.out).valid).toBe(true);
  });
  it("publishes apply, resume, rollback, JSON, help, and schema as one headless contract", () => {
    const help = entityMigrateHelp(); expect(help).toContain("--resume ID --force"); expect(help).toContain("--rollback ID --force"); expect(help).toContain("without prompting"); expect(help).toContain("mode, type, and file-identity");
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

  it.each([
    ["dirty tracked bytes", (root: string) => fs.appendFileSync(path.join(root, "README.md"), "dirty\n")],
    ["staged index", (root: string) => { fs.appendFileSync(path.join(root, "README.md"), "staged\n"); git(root, ["add", "README.md"]); }],
    ["changed HEAD", (root: string) => { fs.writeFileSync(path.join(root, "HEAD.txt"), "next\n"); git(root, ["add", "HEAD.txt"]); git(root, ["commit", "--quiet", "-m", "next"]); }],
    ["missing tracked path", (root: string) => fs.rmSync(path.join(root, "README.md"))],
    ["added untracked path", (root: string) => fs.writeFileSync(path.join(root, "untracked.txt"), "extra\n")],
  ])("rejects %s against the approval envelope before effects", (_label, mutate) => {
    const root = gitProject(); const preview = previewEntityMigration(root, SOURCE_ROOT); const approval = approvalFile(root, preview.source_fingerprint, preview.preview_digest); mutate(root);
    expect(() => applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest, approval)).toThrow(); expectNoMigrationEffects(root);
  });

  it("rejects wrong-root, malformed, and symbolic-link approval files before effects", () => {
    const root = gitProject(); const other = gitProject(); const preview = previewEntityMigration(root, SOURCE_ROOT); const otherPreview = previewEntityMigration(other, SOURCE_ROOT); const wrong = approvalFile(other, otherPreview.source_fingerprint, otherPreview.preview_digest);
    expect(() => applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest, wrong)).toThrow(/approval root|fingerprint/); expectNoMigrationEffects(root);
    const malformed = path.join(path.dirname(wrong), "malformed.json"); fs.writeFileSync(malformed, "{}\n"); expect(() => applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest, malformed)).toThrow(/does not satisfy/); expectNoMigrationEffects(root);
    const valid = approvalFile(root, preview.source_fingerprint, preview.preview_digest); const link = `${valid}.link`; fs.symlinkSync(valid, link);
    expect(() => applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest, link)).toThrow(/symbolic link/); expectNoMigrationEffects(root);
  });

  it("applies with a complete approval while PATH traps Git subprocess invocation", () => {
    const root = gitProject(); const preview = previewEntityMigration(root, SOURCE_ROOT); const approval = approvalFile(root, preview.source_fingerprint, preview.preview_digest); const oldPath = process.env.PATH;
    process.env.PATH = "/path/that/contains/no/git";
    try {
      const result = capture(["state", "migrate", "entities", "--project", root, "--apply", "--force", "--approval-file", approval, "--source-fingerprint", preview.source_fingerprint, "--preview-digest", preview.preview_digest, "--format", "json"]);
      expect(result.rc, result.out).toBe(0); expect(JSON.parse(result.out)).toMatchObject({ status: "complete" });
    } finally { process.env.PATH = oldPath; }
  });

  it("prepares immutable evidence, cuts over once, repeats without rewrites, and rolls back exactly", () => {
    const root = project(); const legacy = new Map(Object.keys(fixtures).map((relative) => [relative, fs.readFileSync(path.join(root, relative))]));
    fs.chmodSync(path.join(root, "TODO.md"), 0o640); const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 });
    expect(preview.status).toBe("ready"); expect(detectStateMode(root, SOURCE_ROOT)).toBe("legacy");
    const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
    expect(applied).toMatchObject({ status: "complete", phase: "cutover_complete", idempotent: false, mutation_performed: true });
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    const evidenceFiles = Object.values(applied.evidence).map((relative) => path.join(root, relative)); expect(evidenceFiles.every((file) => fs.existsSync(file))).toBe(true);
    for (const relative of [applied.evidence.manifest, applied.evidence.snapshot]) expect(fs.readFileSync(path.join(root, relative), "utf8")).toMatch(/mode: \d+[\s\S]*dev: ['"]?\d+[\s\S]*ino: ['"]?\d+[\s\S]*type: file/);
    const entityFiles = files(root, ".agentera/entities"); expect(entityFiles).toHaveLength(preview.counts.total);
    const immutableFiles = [...entityFiles, path.join(root, ".agentera/state-mode.yaml"), ...files(root, ".agentera/migrations")];
    const before = new Map(immutableFiles.map((file) => [file, { bytes: fs.readFileSync(file), stat: fs.statSync(file) }]));
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

  it("binds apply approval to source mode and inode before durable effects", () => {
    for (const mutate of ["chmod", "replace"] as const) {
      const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT); const source = path.join(root, "TODO.md");
      if (mutate === "chmod") fs.chmodSync(source, 0o600);
      else { const bytes = fs.readFileSync(source); const mode = fs.statSync(source).mode & 0o777; fs.renameSync(source, `${source}.old`); fs.writeFileSync(source, bytes, { mode }); }
      expect(() => applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest)).toThrow(/source or authority changed after approval/);
      expect(fs.existsSync(path.join(root, ".agentera/migrations"))).toBe(false); expect(files(root, ".agentera/entities")).toEqual([]); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    }
  });

  it("refuses byte-identical legacy source inode replacement before rollback effects", () => {
    const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest); const source = path.join(root, "TODO.md"); const bytes = fs.readFileSync(source); const mode = fs.statSync(source).mode & 0o777;
    fs.renameSync(source, `${source}.old`); fs.writeFileSync(source, bytes, { mode });
    expect(() => rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id)).toThrow(/legacy path 'TODO.md' changed/);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(true); expect(files(root, ".agentera/entities")).toHaveLength(preview.counts.total);
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

  it("converges after intra-loop entity and marker publication crashes", () => {
    for (const point of ["publish_entity", "publish_marker"]) {
      const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 });
      const child = spawnSync(process.execPath, [WORKER], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE: point, AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT: root, AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT: SOURCE_ROOT, AGENTERA_ENTITY_MIGRATION_CRASH_FINGERPRINT: preview.source_fingerprint, AGENTERA_ENTITY_MIGRATION_CRASH_DIGEST: preview.preview_digest } });
      expect(child.status, `${point}: ${child.stdout}\n${child.stderr}`).toBe(86);
      const published = point === "publish_entity" ? files(root, ".agentera/entities")[0] : path.join(root, ".agentera/state-mode.yaml"); const publishedInode = fs.statSync(published).ino;
      const [id] = fs.readdirSync(path.join(root, ".agentera/migrations/entities")); const resumed = resumeEntityMigration(root, SOURCE_ROOT, id);
      expect(resumed).toMatchObject({ migration_id: id, status: "complete" }); expect(files(root, ".agentera/entities")).toHaveLength(preview.counts.total);
      expect(fs.statSync(published).ino).toBe(publishedInode); expect(new Set(files(root, ".agentera/entities").map((file) => path.basename(file))).size).toBe(preview.counts.total); expect(files(root, ".agentera").filter((file) => /\.(tmp|rollback)$/.test(file))).toEqual([]);
      expect(rollbackEntityMigration(root, SOURCE_ROOT, id).status).toBe("rolled_back"); expect(fs.existsSync(published)).toBe(false);
    }
  });

  it("refuses byte-identical successor inodes after entity and marker publication crashes", () => {
    for (const point of ["publish_entity", "publish_marker"] as const) {
      const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 });
      const child = spawnSync(process.execPath, [WORKER], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE: point, AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT: root, AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT: SOURCE_ROOT, AGENTERA_ENTITY_MIGRATION_CRASH_FINGERPRINT: preview.source_fingerprint, AGENTERA_ENTITY_MIGRATION_CRASH_DIGEST: preview.preview_digest } });
      expect(child.status).toBe(86); const [id] = fs.readdirSync(path.join(root, ".agentera/migrations/entities"));
      const target = point === "publish_entity" ? files(root, ".agentera/entities")[0] : path.join(root, ".agentera/state-mode.yaml"); const bytes = fs.readFileSync(target); const owned = fs.statSync(target).ino;
      fs.renameSync(target, `${target}.owned`); fs.writeFileSync(target, bytes); const successor = fs.statSync(target).ino; expect(successor).not.toBe(owned);
      expect(() => resumeEntityMigration(root, SOURCE_ROOT, id)).toThrow(/collides with migration ownership receipt/);
      expect(() => rollbackEntityMigration(root, SOURCE_ROOT, id)).toThrow(); expect(fs.statSync(target).ino).toBe(successor); expect(fs.readFileSync(target)).toEqual(bytes);
    }
  }, 60_000);

  it("refuses removed, replaced, or modified entity and marker ownership receipts", () => {
    for (const receiptName of ["0000.yaml", "marker.yaml"]) for (const mutation of ["remove", "replace", "tamper"] as const) {
      const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT);
      const child = spawnSync(process.execPath, [WORKER], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE: "prepare_recovery", AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT: root, AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT: SOURCE_ROOT, AGENTERA_ENTITY_MIGRATION_CRASH_FINGERPRINT: preview.source_fingerprint, AGENTERA_ENTITY_MIGRATION_CRASH_DIGEST: preview.preview_digest } });
      expect(child.status).toBe(86); const [id] = fs.readdirSync(path.join(root, ".agentera/migrations/entities")); const receipt = path.join(root, ".agentera/migrations/entities", id, "receipts", receiptName); const bytes = fs.readFileSync(receipt);
      if (mutation === "remove") fs.unlinkSync(receipt);
      else if (mutation === "replace") { fs.renameSync(receipt, `${receipt}.prior`); fs.writeFileSync(receipt, bytes); }
      else fs.appendFileSync(receipt, "# tampered\n");
      expect(() => resumeEntityMigration(root, SOURCE_ROOT, id), `${receiptName}:${mutation}`).toThrow(/receipt/); expect(files(root, ".agentera/entities")).toEqual([]); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    }
  }, 120_000);

  it("never removes an exact-byte successor entity or marker during rollback", () => {
    for (const replace of ["entity", "marker"] as const) {
      const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
      const target = replace === "entity" ? files(root, ".agentera/entities")[0] : path.join(root, ".agentera/state-mode.yaml"); const bytes = fs.readFileSync(target); const prior = fs.statSync(target).ino;
      fs.renameSync(target, `${target}.prior`); fs.writeFileSync(target, bytes); const successor = fs.statSync(target).ino; expect(successor).not.toBe(prior);
      expect(() => rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id)).toThrow(/changed after cutover/); expect(fs.statSync(target).ino).toBe(successor); expect(fs.readFileSync(target)).toEqual(bytes); expect(fs.existsSync(path.join(root, applied.evidence.snapshot))).toBe(true);
    }
  });

  it("refuses marker replacement between rollback preflight and exact removal without deleting the graph", () => {
    const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest); const marker = path.join(root, ".agentera/state-mode.yaml"); const bytes = fs.readFileSync(marker); const original = EntityPublicationContext.prototype.removeExact; let replaced = false;
    vi.spyOn(EntityPublicationContext.prototype, "removeExact").mockImplementation(function (target, expected) { if (!replaced && target === ".agentera/state-mode.yaml") { replaced = true; fs.renameSync(marker, `${marker}.prior`); fs.writeFileSync(marker, bytes); } return original.call(this, target, expected); });
    expect(() => rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id)).toThrow(/marker changed during rollback cutover/); expect(replaced).toBe(true); expect(fs.readFileSync(marker)).toEqual(bytes); expect(files(root, ".agentera/entities")).toHaveLength(preview.counts.total); expect(fs.readFileSync(path.join(root, applied.evidence.journal), "utf8")).toContain("phase: rollback_prepared");
  });

  it("never deletes or completes over an entity successor during rollback removal or final revalidation", () => {
    for (const timing of ["during", "after"] as const) {
      const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest); const target = files(root, ".agentera/entities")[0]; const relativeTarget = path.relative(root, target).replaceAll(path.sep, "/"); const bytes = fs.readFileSync(target); const original = EntityPublicationContext.prototype.removeExact; let replaced = false;
      vi.spyOn(EntityPublicationContext.prototype, "removeExact").mockImplementation(function (relative, expected) {
        if (!replaced && relative === relativeTarget && timing === "during") { replaced = true; fs.renameSync(target, `${target}.prior`); fs.writeFileSync(target, bytes); }
        const result = original.call(this, relative, expected);
        if (!replaced && relative === relativeTarget && timing === "after") { replaced = true; fs.writeFileSync(target, bytes); }
        return result;
      });
      expect(() => rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id)).toThrow(/rollback successor/); expect(replaced).toBe(true); expect(fs.readFileSync(target)).toEqual(bytes); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false); expect(fs.readFileSync(path.join(root, applied.evidence.journal), "utf8")).not.toContain("phase: rolled_back");
      vi.restoreAllMocks();
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

  it("converges after marker and intra-loop entity removal crashes with legacy authority", () => {
    for (const point of ["rollback_remove_marker", "rollback_remove_entity"]) {
      const root = project(); const preview = previewEntityMigration(root, SOURCE_ROOT); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
      const child = spawnSync(process.execPath, [WORKER], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE: point, AGENTERA_ENTITY_MIGRATION_WORKER_OPERATION: "rollback", AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT: root, AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT: SOURCE_ROOT, AGENTERA_ENTITY_MIGRATION_ID: applied.migration_id } });
      expect(child.status, `${point}: ${child.stdout}\n${child.stderr}`).toBe(86); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
      const resumed = rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id); expect(resumed).toMatchObject({ migration_id: applied.migration_id, status: "rolled_back" }); expect(files(root, ".agentera/entities")).toEqual([]); expect(files(root, ".agentera").filter((file) => /\.(tmp|rollback)$/.test(file))).toEqual([]);
      expect(rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id)).toMatchObject({ idempotent: true, mutation_performed: false });
    }
  });

  it("refuses rollback continuation when legacy source changes after entity cleanup starts", () => {
    const root = project(); const source = path.join(root, "TODO.md"); const sourceBytes = fs.readFileSync(source); const preview = previewEntityMigration(root, SOURCE_ROOT); const applied = applyEntityMigration(root, SOURCE_ROOT, preview.source_fingerprint, preview.preview_digest);
    const child = spawnSync(process.execPath, [WORKER], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE: "rollback_remove_entity", AGENTERA_ENTITY_MIGRATION_WORKER_OPERATION: "rollback", AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT: root, AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT: SOURCE_ROOT, AGENTERA_ENTITY_MIGRATION_ID: applied.migration_id } });
    expect(child.status).toBe(86); expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false); const remaining = files(root, ".agentera/entities").length;
    fs.appendFileSync(source, "changed after authority returned\n");
    expect(() => rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id)).toThrow(/legacy path 'TODO.md' changed/); expect(files(root, ".agentera/entities")).toHaveLength(remaining); expect(fs.readFileSync(path.join(root, applied.evidence.journal), "utf8")).toContain("phase: rollback_cutover"); expect(files(root, ".agentera/migrations").length).toBeGreaterThan(3);
    fs.writeFileSync(source, sourceBytes); expect(rollbackEntityMigration(root, SOURCE_ROOT, applied.migration_id).status).toBe("rolled_back"); expect(files(root, ".agentera/entities")).toEqual([]);
  });
});

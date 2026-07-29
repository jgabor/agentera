import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { collectEntityOrientation } from "../../src/cli/commands/prime/collectEntityOrientation.js";
import { printStateHelp } from "../../src/cli/help.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { decisionRevisionContract, decisionRevisionViolations } from "../../src/state/decisionRevision.js";
import { getDecisionEntity, listDecisionEntities } from "../../src/state/decisionEntities.js";
import { applyPreparedEntityCutover, prepareEntityCutoverForUpgrade } from "../../src/state/entityCutover.js";
import { yamlArchiveEntry } from "../../src/hooks/compaction/retention.js";
import { collectMigrationPreviewPages } from "../helpers/entityMigrationPagination.js";
import {
  assertEntityMigrationBinding,
  ENTITY_MIGRATION_PREVIEW_MAX_OUTPUT_BYTES,
  planEntityMigration,
  previewEntityMigration,
  validateEntityMigrationTargets,
  type EntityMigrationPreview,
} from "../../src/state/entityMigrationPreview.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];

const VALID_PLAN = `header:
  level: light
  created: 2026-07-16
  status: open
  title: exact source fixture
  id: plan:123e4567-e89b-42d3-a456-426614174000
what: test exact source inspection
why: preserve the project boundary
constraints: none
overall_acceptance: pass
scope:
  included: [test]
  excluded: []
tasks:
  - number: 1
    name: one
    depends_on: []
    status: pending
    acceptance: [pass]
surprises: []
`;

const ACTIVE_PLAN_ID = "plan:123e4567-e89b-42d3-a456-426614174000";
const ARCHIVED_PLAN_ID = "plan:223e4567-e89b-42d3-a456-426614174000";
const OBJECTIVE_ID = "objective:323e4567-e89b-42d3-a456-426614174000";
const VALID_ARCHIVED_PLAN = VALID_PLAN
  .replace(ACTIVE_PLAN_ID, ARCHIVED_PLAN_ID)
  .replace("status: open", "status: complete")
  .replace("status: pending", "status: complete");
const VALID_OBJECTIVE = `header:
  id: ${OBJECTIVE_ID}
  title: Reduce latency
  status: open
objective:
  description: Reduce latency
  measurement: p95
  constraints: []
metric:
  direction: minimize
  unit: ms
baseline:
  description: 100 ms
gates: {}
scope:
  included: [CLI]
  excluded: []
`;
const VALID_EXPERIMENTS = "experiments:\n  - number: 7\n    result: pinned source\n";

const EXACT_SOURCE_FIXTURES = {
  "TODO.md": "# TODO\n\n## → Normal\n- [ ] Preserve this exact item.\n",
  ".agentera/docs.yaml": "index:\n  - document: README\n    path: README.md\n    last_updated: 2026-07-17\n    status: current\n",
  ".agentera/progress.yaml": "cycles:\n  - number: 1\n    timestamp: 2026-07-16 10:00\n    type: feat\n    phase: build\n    what: complete\n    inspiration: test\n    discovered: none\n    verified: passed\n    next: done\n    context:\n      intent: test\n      constraints: none\n      unknowns: none\n      scope: fixture\n",
  ".agentera/decisions.yaml": "decisions:\n  - number: 7\n    date: 2026-07-16\n    question: Question?\n    context: Test exact source inspection.\n    alternatives:\n      - name: Preserve project boundaries\n        status: chosen\n      - name: Follow external paths\n        status: rejected\n    choice: Preserve project boundaries.\n    reasoning: External bytes cannot define project state.\n    confidence: firm\n    feeds_into: Task 19\n",
  ".agentera/health.yaml": "audits:\n  - number: 1\n    date: 2026-07-16\n    dimensions: [architecture_alignment]\n    findings_summary:\n      critical: 0\n      warning: 0\n      info: 0\n      filtered_by_confidence: 0\n    trajectory: stable\n    grades:\n      architecture_alignment: A\n",
  ".agentera/plan.yaml": VALID_PLAN,
  ".agentera/overlays/decisions.yaml": "decisions:7:\n  satisfaction:\n    state: provisionally_satisfied\n    evidence: exact source fixture\n",
  ".agentera/revisions/decisions.yaml": "decisions:7:\n  - date: 2026-07-17\n    choice: Revised choice.\n    provenance: historical_revision\n",
} as const;

const EXACT_SOURCE_PATHS = Object.keys(EXACT_SOURCE_FIXTURES) as Array<keyof typeof EXACT_SOURCE_FIXTURES>;
const NESTED_EXACT_SOURCE_PATHS = EXACT_SOURCE_PATHS.filter((relative) => relative.includes("/"));

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-entity-preview-"));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, bytes: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function replaceWithExternalSymlink(target: string, externalTarget: string, externalRoot: string): void {
  fs.renameSync(target, path.join(externalRoot, "pinned-source"));
  fs.symlinkSync(externalTarget, target, "file");
}

function replaceDirectoryWithExternalSymlink(target: string, externalTarget: string, heldPath: string): () => void {
  fs.renameSync(target, heldPath);
  fs.symlinkSync(externalTarget, target, "dir");
  return () => {
    fs.unlinkSync(target);
    fs.renameSync(heldPath, target);
  };
}

const REPRESENTATIVE_SOURCES = [
  {
    name: "active plan",
    relative: ".agentera/plan.yaml",
    bytes: VALID_PLAN,
    identity: ACTIVE_PLAN_ID,
    externalBytes: VALID_PLAN.replace(ACTIVE_PLAN_ID, "plan:923e4567-e89b-42d3-a456-426614174000"),
    externalIdentity: "plan:923e4567-e89b-42d3-a456-426614174000",
    prerequisites: {},
  },
  {
    name: "decision sidecar",
    relative: ".agentera/revisions/decisions.yaml",
    bytes: EXACT_SOURCE_FIXTURES[".agentera/revisions/decisions.yaml"],
    identity: "decision_revision:decisions:7:0",
    externalBytes: "decisions:999:\n  - choice: External choice.\n    provenance: historical_revision\n",
    externalIdentity: "decision_revision:decisions:999:0",
    prerequisites: {},
  },
  {
    name: "plan archive",
    relative: ".agentera/archive/plan-race.yaml",
    bytes: VALID_ARCHIVED_PLAN,
    identity: ARCHIVED_PLAN_ID,
    externalBytes: VALID_ARCHIVED_PLAN.replace(ARCHIVED_PLAN_ID, "plan:823e4567-e89b-42d3-a456-426614174000"),
    externalIdentity: "plan:823e4567-e89b-42d3-a456-426614174000",
    prerequisites: {},
  },
  {
    name: "objective",
    relative: ".agentera/optimize/latency/objective.yaml",
    bytes: VALID_OBJECTIVE,
    identity: OBJECTIVE_ID,
    externalBytes: VALID_OBJECTIVE.replace(OBJECTIVE_ID, "objective:723e4567-e89b-42d3-a456-426614174000"),
    externalIdentity: "objective:723e4567-e89b-42d3-a456-426614174000",
    prerequisites: {},
  },
  {
    name: "experiment",
    relative: ".agentera/optimize/latency/experiments.yaml",
    bytes: VALID_EXPERIMENTS,
    identity: `${OBJECTIVE_ID}/experiment:7`,
    externalBytes: "experiments:\n  - number: 999\n    result: external source\n",
    externalIdentity: `${OBJECTIVE_ID}/experiment:999`,
    prerequisites: { ".agentera/optimize/latency/objective.yaml": VALID_OBJECTIVE },
  },
] as const;

function tree(root: string): string[] {
  const visit = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isSymbolicLink()) return [`${relative}->${fs.readlinkSync(absolute)}`];
    return entry.isDirectory() ? [relative + "/", ...visit(absolute)] : [relative + ":" + fs.readFileSync(absolute).toString("hex")];
  });
  return visit(root).sort();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("entity migration read-only preview", () => {
  it.each(["empty", "valid", "malformed"])("writes nothing for %s projects", (kind) => {
    const root = project();
    if (kind === "valid") write(root, ".agentera/progress.yaml", "cycles:\n  - number: 1\n    timestamp: 2026-07-16 10:00\n    type: feat\n    phase: build\n    what: complete\n    inspiration: test\n    discovered: none\n    verified: passed\n    next: done\n");
    if (kind === "malformed") write(root, ".agentera/progress.yaml", "cycles: [\n");
    const before = tree(root);
    previewEntityMigration(root, REPO_ROOT);
    expect(tree(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".agentera", ".writer.lock"))).toBe(false);
  });

  it("is deterministic and refuses changed sources before effects", () => {
    const root = project();
    write(root, "TODO.md", "# TODO\n\n## → Normal\n- [ ] Preserve this exact item.\n");
    const first = previewEntityMigration(root, REPO_ROOT);
    expect(previewEntityMigration(root, REPO_ROOT)).toEqual(first);
    const effect = vi.fn();
    write(root, "TODO.md", "# TODO\n\n## → Normal\n- [ ] Changed.\n");
    const changed = previewEntityMigration(root, REPO_ROOT);
    expect(() => assertEntityMigrationBinding(first.source_fingerprint, first.preview_digest, changed, effect)).toThrow(/source or migration authority changed/);
    expect(effect).not.toHaveBeenCalled();
  });

  it("binds approval to the active migration authority before effects", () => {
    const root = project();
    const sourceRoot = project();
    fs.cpSync(path.join(REPO_ROOT, "references"), path.join(sourceRoot, "references"), { recursive: true });
    write(root, "TODO.md", "# TODO\n\n## → Normal\n- [ ] Bound source.\n");
    const first = previewEntityMigration(root, sourceRoot);
    const authority = path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml");
    fs.appendFileSync(authority, "\n# authority-only binding mutation\n");
    const changed = previewEntityMigration(root, sourceRoot);
    const effect = vi.fn();
    expect(changed.source_fingerprint).toBe(first.source_fingerprint);
    expect(changed.preview_digest).not.toBe(first.preview_digest);
    expect(() => assertEntityMigrationBinding(first.source_fingerprint, first.preview_digest, changed, effect)).toThrow(/source or migration authority changed/);
    expect(effect).not.toHaveBeenCalled();
  });

  it("inventories authority-valid ordered decision revisions and classifies malformed provenance separately", () => {
    const root = project();
    write(root, ".agentera/decisions.yaml", `decisions:\n  - number: 7\n    date: 2026-07-16\n    question: Question?\n    context: Validate revision targets.\n    alternatives:\n      - name: Preserve\n        status: chosen\n    choice: Choice.\n    reasoning: Reason.\n    confidence: firm\n`);
    write(root, ".agentera/revisions/decisions.yaml", `decisions:7:\n  - date: 2026-07-16\n    choice: First revision.\n    provenance: historical_revision\n  - date: 2026-07-17\n    reasoning: Second revision.\n    provenance: degraded_projection\n  - date: 2026-07-18\n    choice: Stale base claim.\n    provenance: historical_revision\n    base_sha256: ${"f".repeat(64)}\ndecisions:8:\n  - choice: Invalid provenance.\n    provenance: revision\ndecisions:9:\n  - number: 9\n    choice: Identity is immutable.\n    provenance: historical_revision\ndecisions:10:\n  - satisfaction:\n      state: open\n    provenance: historical_revision\ndecisions:11:\n  - provenance: historical_revision\ndecisions:12:\n  - choice: Wrong provenance claim.\n    provenance: historical_archive\ndecisions:bad: not-a-list\n`);
    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    const revisions = preview.entries.filter((entry) => entry.boundary === "decision_revision");
    const byIdentity = new Map(revisions.map((entry) => [entry.source_identity, entry]));
    const valid = [byIdentity.get("decision_revision:decisions:7:0")!, byIdentity.get("decision_revision:decisions:7:1")!];
    expect(valid.every((entry) => entry.relationships.some((relation) => relation.field === "decision" && relation.target_source_identity === "decisions:7" && relation.status === "resolved"))).toBe(true);
    expect(valid.every((entry) => entry.classification === "verified_full")).toBe(true);
    expect(valid.map((entry) => entry.provenance)).toEqual([["revision"], ["revision"]]);
    for (const identity of ["decision_revision:decisions:7:2", "decision_revision:decisions:8:0", "decision_revision:decisions:9:0", "decision_revision:decisions:10:0", "decision_revision:decisions:11:0", "decision_revision:decisions:12:0", "decision_revision:decisions:bad"]) {
      expect(byIdentity.get(identity)?.classification, identity).toBe("corrupt");
    }
    expect(byIdentity.get("decision_revision:decisions:7:2")?.recovery).toContain("claims base");
    const violations = decisionRevisionViolations({
      "decisions:8": [{ choice: "Invalid provenance.", provenance: "revision" }],
      "decisions:9": [{ number: 9, choice: "Identity is immutable.", provenance: "historical_revision" }],
      "decisions:10": [{ satisfaction: { state: "open" }, provenance: "historical_revision" }],
      "decisions:11": [{ provenance: "historical_revision" }],
      "decisions:12": [{ choice: "Wrong provenance claim.", provenance: "historical_archive" }],
      "decisions:bad": "not-a-list",
    }, decisionRevisionContract(REPO_ROOT));
    expect(violations.join("\n")).toMatch(/not one of/);
    expect(violations.join("\n")).toMatch(/not an amendable content path/);
    expect(violations.join("\n")).toMatch(/must amend at least one content field/);
    expect(violations.join("\n")).toMatch(/must never claim historical_archive provenance/);
    expect(violations.join("\n")).toMatch(/not a valid decisions:<decision-number> key/);
  });

  it("cuts aggregate revisions over to effective exact, list, and startup entity reads", () => {
    const root = project();
    const base = {
      number: 7,
      date: "2026-07-16",
      question: "Where should revision authority live?",
      context: "Migration must preserve ordered evidence.",
      alternatives: [{ name: "Entities", status: "chosen" }, { name: "Legacy aggregate", status: "rejected" }],
      choice: "Aggregate files",
      reasoning: "Legacy source.",
      confidence: "firm",
    };
    const baseSha256 = createHash("sha256").update(canonicalRecordJson(base)).digest("hex");
    write(root, ".agentera/decisions.yaml", YAML.stringify({ decisions: [base] }));
    write(root, ".agentera/revisions/decisions.yaml", YAML.stringify({
      "decisions:7": [{ question: "Where do canonical revisions live?", alternatives: [{ name: "Canonical entities", status: "chosen" }, { name: "Aggregate files", status: "rejected" }], choice: "Canonical entities", reasoning: "Current authority.", confidence: "high", provenance: "historical_revision", base_sha256: baseSha256 }],
    }));
    write(root, ".agentera/overlays/decisions.yaml", YAML.stringify({
      "decisions:7": { satisfaction: { state: "provisionally_satisfied", evidence: "migration verified", review_needed: true } },
    }));
    const sourcePaths = [".agentera/decisions.yaml", ".agentera/revisions/decisions.yaml", ".agentera/overlays/decisions.yaml"];
    const sourceBytes = new Map(sourcePaths.map((relative) => [relative, fs.readFileSync(path.join(root, relative))]));
    const env = { ...process.env };
    delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE; delete env.GIT_COMMON_DIR;
    execFileSync("git", ["init", "--quiet"], { cwd: root, env });
    execFileSync("git", ["add", "."], { cwd: root, env });
    execFileSync("git", ["-c", "user.email=entity-migration@example.invalid", "-c", "user.name=Entity Migration", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "legacy state"], { cwd: root, env });

    expect(applyPreparedEntityCutover(prepareEntityCutoverForUpgrade(root, REPO_ROOT))).toMatchObject({ status: "complete", mutation_performed: true });
    const listed = listDecisionEntities(root, 10, undefined, undefined, { sourceRoot: REPO_ROOT }) as any;
    const id = listed.entries[0].id as string;
    const expected = { question: "Where do canonical revisions live?", alternatives: [{ name: "Canonical entities", status: "chosen" }, { name: "Aggregate files", status: "rejected" }], choice: "Canonical entities", reasoning: "Current authority.", confidence: "high", satisfaction: { state: "provisionally_satisfied", evidence: "migration verified", review_needed: true } };
    expect(listed.entries[0].record).toMatchObject(expected);
    const exact = (getDecisionEntity(root, id, REPO_ROOT) as any).entry;
    expect(exact.record).toMatchObject(expected);
    expect(exact.caveats).toEqual([expect.stringContaining("explicit legacy state")]);
    expect((collectEntityOrientation(root, REPO_ROOT).decisionAttention?.entries as any[])?.[0]?.title).toBe(expected.question);
    for (const [relative, bytes] of sourceBytes) expect(fs.readFileSync(path.join(root, relative))).toEqual(bytes);
  });

  it("blocks legacy revisions with invalid effective decision values", () => {
    const root = project();
    write(root, ".agentera/decisions.yaml", YAML.stringify({ decisions: [{ number: 7, date: "2026-07-16", question: "Question?", context: "Validate revision values.", alternatives: [{ name: "Preserve", status: "chosen" }], choice: "Preserve", reasoning: "Valid base.", confidence: "firm" }] }));
    write(root, ".agentera/revisions/decisions.yaml", YAML.stringify({ "decisions:7": [{ date: "2026-07-17", choice: 42, provenance: "historical_revision" }] }));

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    expect(preview.entries.find(({ source_identity }) => source_identity === "decision_revision:decisions:7:0")).toMatchObject({ classification: "corrupt", proposed_target: null });
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
  });

  it("retains complete parity for every safe exact source path", () => {
    const root = project();
    for (const [relative, bytes] of Object.entries(EXACT_SOURCE_FIXTURES)) write(root, relative, bytes);

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    const inventoriedPaths = new Set(preview.entries.flatMap((entry) => entry.source_paths));
    expect([...inventoriedPaths]).toEqual(expect.arrayContaining(EXACT_SOURCE_PATHS));
    for (const relative of EXACT_SOURCE_PATHS) {
      expect(preview.entries.some((entry) => entry.source_paths.includes(relative))).toBe(true);
    }
    expect(preview.entries.filter((entry) => entry.source_paths.some((sourcePath) => EXACT_SOURCE_PATHS.includes(sourcePath as keyof typeof EXACT_SOURCE_FIXTURES)) && entry.classification === "corrupt")).toEqual([]);
  });

  it("validates final canonical envelopes and relationships across every entity boundary", () => {
    const root = project();
    for (const [relative, bytes] of Object.entries(EXACT_SOURCE_FIXTURES)) write(root, relative, bytes);
    write(root, ".agentera/optimize/latency/objective.yaml", VALID_OBJECTIVE);
    write(root, ".agentera/optimize/latency/experiments.yaml", "experiments:\n  - number: 7\n    date: 2026-07-17 10:00\n    status: baseline\n    result: pinned source\n");
    const plan = planEntityMigration(root, REPO_ROOT);
    expect([...new Set(plan.entries.map(({ boundary }) => boundary))].sort()).toEqual([
      "decision", "decision_revision", "decision_satisfaction", "documentation_inventory_entry", "experiment", "health_audit", "objective", "plan", "plan_task", "progress_cycle", "todo_item",
    ]);
    expect(validateEntityMigrationTargets(root, plan.entries, REPO_ROOT)).toEqual([]);
    expect(plan.entries.every((entry) => entry.proposed_target === null || /^[a-f0-9]{64}$/.test(entry.target_sha256 ?? ""))).toBe(true);
  });

  it("classifies only itemized TODO/docs records and binds preserved singleton authority", () => {
    const root = project();
    write(root, "TODO.md", "# TODO\n\n## ⇉ Degraded\n- [ ] Repair migration.\n\n## ✓ Resolved\n- [x] Preserve history.\n");
    write(root, ".agentera/docs.yaml", "last_audit: 2026-07-17 (fixture)\nconventions:\n  doc_root: .\nmapping:\n  - artifact: TODO.md\n    path: TODO.md\ncoverage:\n  documented: 1\naudit_log:\n  - date: 2026-07-17\nindex:\n  - document: README\n    path: README.md\n    last_updated: 2026-07-17\n    status: current\n");
    write(root, ".agentera/vision.yaml", "north_star: preserve intent\n");
    write(root, "DESIGN.md", "# Design\n");
    write(root, "CHANGELOG.md", "# Changelog\n");

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    const todo = preview.entries.filter((entry) => entry.boundary === "todo_item");
    const docs = preview.entries.filter((entry) => entry.boundary === "documentation_inventory_entry");
    expect(todo.map((entry) => entry.source_identity)).toEqual(["TODO.md:line:4", "TODO.md:line:7"]);
    expect(todo.map((entry) => entry.content_sha256)).not.toContain(null);
    expect(docs).toHaveLength(1); expect(docs[0].source_identity).toBe("docs:path:README.md");
    expect(preview.entries.some((entry) => entry.source_identity.includes("mapping") || entry.source_paths.includes("DESIGN.md") || entry.source_paths.includes("CHANGELOG.md") || entry.source_paths.includes(".agentera/vision.yaml"))).toBe(false);
    expect(preview.preserved_singletons).toEqual(expect.arrayContaining([
      expect.objectContaining({ boundary: "vision", source_path: ".agentera/vision.yaml", presence: "file", content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ boundary: "design", presence: "file" }),
      expect.objectContaining({ boundary: "changelog", presence: "file" }),
      expect.objectContaining({ boundary: "docs_mapping", presence: "file", preserved_sections: ["last_audit", "conventions", "mapping", "coverage", "audit_log"] }),
      expect.objectContaining({ boundary: "profile", presence: "missing" }),
      expect.objectContaining({ boundary: "runtime_local_session_state", presence: "missing" }),
    ]));
  });

  it("inventories the docs-mapped TODO authority when the root default is absent", () => {
    const root = project();
    write(root, ".agentera/docs.yaml", "mapping:\n  - artifact: TODO.md\n    path: project/TASKS.md\n");
    write(root, "project/TASKS.md", "# TODO\n\n## → Normal\n- [ ] Read the mapped authority.\n");

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    const todo = preview.entries.filter((entry) => entry.boundary === "todo_item");

    expect(todo).toHaveLength(1);
    expect(todo[0]).toMatchObject({
      source_identity: "project/TASKS.md:line:4",
      source_paths: ["project/TASKS.md"],
      provenance: ["current_canonical"],
    });
  });

  it("gives the docs-mapped TODO authority precedence over root TODO.md", () => {
    const root = project();
    write(root, ".agentera/docs.yaml", "mapping:\n  - artifact: TODO.md\n    path: project/TASKS.md\n");
    write(root, "TODO.md", "# TODO\n- [ ] Root item must be ignored.\n");
    write(root, "project/TASKS.md", "# TODO\n- [ ] Mapped item wins.\n");

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    const todo = preview.entries.filter((entry) => entry.boundary === "todo_item");

    expect(todo).toHaveLength(1);
    expect(todo[0].source_identity).toBe("project/TASKS.md:line:2");
    expect(todo[0].source_paths).toEqual(["project/TASKS.md"]);
    expect(preview.entries.some((entry) => entry.source_paths.includes("TODO.md"))).toBe(false);
  });

  it.each([
    ["traversal", "../outside/TODO.md"],
    ["absolute external path", path.join(os.tmpdir(), "external-TODO.md")],
  ])("rejects a mapped TODO %s before inventory effects", (_kind, mappedPath) => {
    const root = project();
    write(root, ".agentera/docs.yaml", `mapping:\n  - artifact: TODO.md\n    path: ${mappedPath}\n`);
    const before = tree(root);
    let out = "";

    const rc = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--dry-run", "--format", "json"], { out: (text) => (out += text), err: () => undefined }, process.cwd(), REPO_ROOT);

    expect(rc).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ status: "fail", mutation_performed: false, error: { class: "inventory_failed", message: expect.stringMatching(/artifact 'todo' path (contains traversal segments|escapes the project boundary)/) } });
    expect(tree(root)).toEqual(before);
  });

  it("rejects a mapped TODO path that escapes through a symlink before inventory effects", () => {
    const root = project();
    const external = project();
    write(root, ".agentera/docs.yaml", "mapping:\n  - artifact: TODO.md\n    path: linked/TODO.md\n");
    write(external, "TODO.md", "# TODO\n- [ ] External item must not be read.\n");
    fs.symlinkSync(external, path.join(root, "linked"), "dir");
    const beforeRoot = tree(root);
    const beforeExternal = tree(external);
    let out = "";

    const rc = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--dry-run", "--format", "json"], { out: (text) => (out += text), err: () => undefined }, process.cwd(), REPO_ROOT);

    expect(rc).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ status: "fail", mutation_performed: false, error: { class: "inventory_failed", message: "artifact 'todo' path escapes the project boundary" } });
    expect(out).not.toContain("External item must not be read");
    expect(tree(root)).toEqual(beforeRoot);
    expect(tree(external)).toEqual(beforeExternal);
  });

  it("binds mapped TODO drift, fingerprints, and pagination to the mapped source", () => {
    const root = project();
    write(root, ".agentera/docs.yaml", "mapping:\n  - artifact: TODO.md\n    path: project/TASKS.md\n");
    write(root, "TODO.md", "# TODO\n- [ ] Ignored root item.\n");
    write(root, "project/TASKS.md", "# TODO\n- [ ] Mapped one.\n- [ ] Mapped two.\n");
    const first = previewEntityMigration(root, REPO_ROOT, { limit: 1 });
    expect(first.next_after).toMatch(/^project\/TASKS\.md:line:/);

    write(root, "TODO.md", "# TODO\n- [ ] Changed ignored root item.\n");
    const rootChanged = previewEntityMigration(root, REPO_ROOT, { limit: 1 });
    expect(rootChanged.source_fingerprint).toBe(first.source_fingerprint);
    expect(rootChanged.preview_digest).toBe(first.preview_digest);

    write(root, "project/TASKS.md", "# TODO\n- [ ] Changed mapped one.\n- [ ] Mapped two.\n");
    const mappedChanged = previewEntityMigration(root, REPO_ROOT, { limit: 1 });
    const effect = vi.fn();
    expect(mappedChanged.source_fingerprint).not.toBe(first.source_fingerprint);
    expect(() => assertEntityMigrationBinding(first.source_fingerprint, first.preview_digest, mappedChanged, effect)).toThrow(/source or migration authority changed/);
    expect(effect).not.toHaveBeenCalled();
  });

  it("retains safe source parity when descriptor path resolution is unavailable", () => {
    const root = project();
    write(root, ".agentera/plan.yaml", VALID_PLAN);

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000, resolveDescriptorPath: () => null });

    expect(preview.entries.filter((entry) => entry.source_identity === ACTIVE_PLAN_ID)).toHaveLength(1);
    expect(preview.entries.filter((entry) => entry.source_identity === `${ACTIVE_PLAN_ID}/task:1`)).toHaveLength(1);
  });

  it("rejects a size-changing same-inode mutation through an external hard link", () => {
    const root = project();
    const external = project();
    const relative = ".agentera/plan.yaml";
    const target = path.join(root, relative);
    const alias = path.join(external, "plan-hard-link.yaml");
    const externalIdentity = "plan:923e4567-e89b-42d3-a456-426614174000";
    write(root, relative, VALID_PLAN);
    fs.linkSync(target, alias);
    const originalOpen = fs.openSync.bind(fs);
    const originalRead = fs.readFileSync.bind(fs);
    let sourceDescriptor: number | undefined;
    let mutated = false;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = originalOpen(candidate, flags, mode);
      if (typeof candidate === "string" && path.resolve(candidate) === target) sourceDescriptor = descriptor;
      return descriptor;
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const bytes = Reflect.apply(originalRead, fs, args);
      if (!mutated && args[0] === sourceDescriptor) {
        fs.appendFileSync(alias, `\nexternal_identity: ${externalIdentity}\n`);
        mutated = true;
      }
      return bytes;
    });

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000, resolveDescriptorPath: () => null });

    expect(mutated).toBe(true);
    expect(fs.statSync(target, { bigint: true }).ino).toBe(fs.statSync(alias, { bigint: true }).ino);
    expect(preview.entries.filter((entry) => entry.source_paths.includes(relative))).toEqual([
      expect.objectContaining({ classification: "corrupt", content_sha256: null, proposed_target: null }),
    ]);
    expect(JSON.stringify(preview)).not.toContain(externalIdentity);
  });

  it("rejects a size-preserving same-inode mutation with changed high-resolution times", () => {
    const root = project();
    const external = project();
    const relative = ".agentera/plan.yaml";
    const target = path.join(root, relative);
    const alias = path.join(external, "plan-hard-link.yaml");
    const externalIdentity = "plan:923e4567-e89b-42d3-a456-426614174000";
    const replacement = VALID_PLAN.replace(ACTIVE_PLAN_ID, externalIdentity);
    write(root, relative, VALID_PLAN);
    fs.linkSync(target, alias);
    const originalOpen = fs.openSync.bind(fs);
    const originalRead = fs.readFileSync.bind(fs);
    let sourceDescriptor: number | undefined;
    let mutated = false;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = originalOpen(candidate, flags, mode);
      if (typeof candidate === "string" && path.resolve(candidate) === target) sourceDescriptor = descriptor;
      return descriptor;
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const bytes = Reflect.apply(originalRead, fs, args);
      if (!mutated && args[0] === sourceDescriptor) {
        fs.writeFileSync(alias, replacement);
        const changed = fs.statSync(alias, { bigint: true });
        fs.utimesSync(alias, new Date(Number(changed.atimeMs)), new Date(Number(changed.mtimeMs) + 1000));
        mutated = true;
      }
      return bytes;
    });

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000, resolveDescriptorPath: () => null });

    expect(mutated).toBe(true);
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(VALID_PLAN));
    expect(preview.entries.filter((entry) => entry.source_paths.includes(relative))).toEqual([
      expect.objectContaining({ classification: "corrupt", content_sha256: null, proposed_target: null }),
    ]);
    expect(JSON.stringify(preview)).not.toContain(externalIdentity);
  });

  it.each(REPRESENTATIVE_SOURCES)("rejects $name replacement after metadata inspection without reading external bytes", ({ relative, bytes, externalBytes, externalIdentity, prerequisites }) => {
    const root = project();
    const external = project();
    for (const [requiredPath, requiredBytes] of Object.entries(prerequisites)) write(root, requiredPath, requiredBytes);
    write(root, relative, bytes);
    write(external, "external-source", externalBytes);
    const target = path.join(root, relative);
    const externalTarget = path.join(external, "external-source");
    const originalOpen = fs.openSync.bind(fs);
    const originalRead = fs.readFileSync.bind(fs);
    let replaced = false;
    let openFlags: number | string | undefined;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      if (!replaced && typeof candidate === "string" && path.resolve(candidate) === target) {
        replaceWithExternalSymlink(target, externalTarget, external);
        replaced = true;
        openFlags = flags;
      }
      return originalOpen(candidate, flags, mode);
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const candidate = args[0];
      if (!replaced && typeof candidate === "string" && path.resolve(candidate) === target) {
        replaceWithExternalSymlink(target, externalTarget, external);
        replaced = true;
      }
      return Reflect.apply(originalRead, fs, args);
    });

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    const observations = preview.entries.filter((entry) => entry.source_paths.includes(relative));

    expect(replaced).toBe(true);
    if (typeof fs.constants.O_NOFOLLOW === "number" && typeof openFlags === "number") {
      expect(openFlags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    }
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ classification: "corrupt", content_sha256: null, proposed_target: null });
    expect(JSON.stringify(preview)).not.toContain(externalIdentity);
    expect(JSON.stringify(preview)).not.toContain("external source");
  });

  it.each(REPRESENTATIVE_SOURCES)("uses collected $name bytes after the pathname is replaced", ({ relative, bytes, identity, externalBytes, externalIdentity, prerequisites }) => {
    const root = project();
    const external = project();
    for (const [requiredPath, requiredBytes] of Object.entries(prerequisites)) write(root, requiredPath, requiredBytes);
    write(root, relative, bytes);
    write(external, "external-source", externalBytes);
    const target = path.join(root, relative);
    const externalTarget = path.join(external, "external-source");
    const originalOpen = fs.openSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    let sourceDescriptor: number | undefined;
    let replaced = false;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = originalOpen(candidate, flags, mode);
      if (typeof candidate === "string" && path.resolve(candidate) === target) sourceDescriptor = descriptor;
      return descriptor;
    });
    vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      originalClose(descriptor);
      if (!replaced && descriptor === sourceDescriptor) {
        replaceWithExternalSymlink(target, externalTarget, external);
        replaced = true;
      }
    });

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });

    expect(replaced).toBe(true);
    expect(preview.entries.filter((entry) => entry.source_identity === identity)).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toContain(externalIdentity);
    expect(JSON.stringify(preview)).not.toContain("external source");
  });

  it("does not reread an empty collected objective pathname", () => {
    const root = project();
    const relative = ".agentera/optimize/empty/objective.yaml";
    const target = path.join(root, relative);
    write(root, relative, "");
    const readSpy = vi.spyOn(fs, "readFileSync");

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });

    expect(readSpy.mock.calls.some(([candidate]) => typeof candidate === "string" && path.resolve(candidate) === target)).toBe(false);
    expect(preview.entries.filter((entry) => entry.source_paths.includes(relative))).toHaveLength(1);
  });

  it("fails closed when an opened source pathname is replaced before descriptor verification", () => {
    const root = project();
    const external = project();
    write(root, ".agentera/plan.yaml", VALID_PLAN);
    write(external, "external-source", VALID_PLAN.replace(ACTIVE_PLAN_ID, "plan:923e4567-e89b-42d3-a456-426614174000"));
    const target = path.join(root, ".agentera/plan.yaml");
    const originalOpen = fs.openSync.bind(fs);
    const originalFstat = fs.fstatSync.bind(fs);
    let sourceDescriptor: number | undefined;
    let replaced = false;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = originalOpen(candidate, flags, mode);
      if (typeof candidate === "string" && path.resolve(candidate) === target) sourceDescriptor = descriptor;
      return descriptor;
    });
    vi.spyOn(fs, "fstatSync").mockImplementation((descriptor, options) => {
      if (!replaced && descriptor === sourceDescriptor) {
        replaceWithExternalSymlink(target, path.join(external, "external-source"), external);
        replaced = true;
      }
      return originalFstat(descriptor, options);
    });

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    expect(replaced).toBe(true);
    expect(preview.entries.filter((entry) => entry.source_paths.includes(".agentera/plan.yaml"))).toEqual([
      expect.objectContaining({ classification: "corrupt", content_sha256: null }),
    ]);
    expect(JSON.stringify(preview)).not.toContain("923e4567-e89b-42d3-a456-426614174000");
  });

  it("fails closed when a recursive source ancestor is replaced before open", () => {
    const root = project();
    const external = project();
    const relative = ".agentera/optimize/latency/objective.yaml";
    const target = path.join(root, relative);
    const ancestor = path.dirname(target);
    const externalAncestor = path.join(external, "external-ancestor");
    write(root, relative, VALID_OBJECTIVE);
    write(externalAncestor, "objective.yaml", VALID_OBJECTIVE.replace(OBJECTIVE_ID, "objective:723e4567-e89b-42d3-a456-426614174000"));
    const originalOpen = fs.openSync.bind(fs);
    let replaced = false;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      if (!replaced && typeof candidate === "string" && path.resolve(candidate) === target) {
        fs.renameSync(ancestor, path.join(external, "pinned-ancestor"));
        fs.symlinkSync(externalAncestor, ancestor, "dir");
        replaced = true;
      }
      return originalOpen(candidate, flags, mode);
    });

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000, resolveDescriptorPath: () => null });
    expect(replaced).toBe(true);
    expect(preview.entries.filter((entry) => entry.source_paths.includes(".agentera/optimize/latency/"))).toEqual([
      expect.objectContaining({ classification: "corrupt", content_sha256: null }),
    ]);
    expect(JSON.stringify(preview)).not.toContain("objective:723e4567-e89b-42d3-a456-426614174000");
  });

  it("rejects an ancestor replacement after open without descriptor path resolution", () => {
    const root = project();
    const external = project();
    const relative = ".agentera/plan.yaml";
    const target = path.join(root, relative);
    const ancestor = path.dirname(target);
    const heldAncestor = path.join(external, "pinned-agentera");
    const externalAncestor = path.join(external, "external-agentera");
    const externalIdentity = "plan:923e4567-e89b-42d3-a456-426614174000";
    write(root, relative, VALID_PLAN);
    write(externalAncestor, "plan.yaml", VALID_PLAN.replace(ACTIVE_PLAN_ID, externalIdentity));
    const originalOpen = fs.openSync.bind(fs);
    const originalRead = fs.readFileSync.bind(fs);
    let sourceDescriptor: number | undefined;
    let replaced = false;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = originalOpen(candidate, flags, mode);
      if (typeof candidate === "string" && path.resolve(candidate) === target) sourceDescriptor = descriptor;
      return descriptor;
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (!replaced && args[0] === sourceDescriptor) {
        replaceDirectoryWithExternalSymlink(ancestor, externalAncestor, heldAncestor);
        replaced = true;
      }
      return Reflect.apply(originalRead, fs, args);
    });

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000, resolveDescriptorPath: () => null });

    expect(replaced).toBe(true);
    expect(preview.entries.filter((entry) => entry.source_paths.includes(relative))).toEqual([
      expect.objectContaining({ classification: "corrupt", content_sha256: null }),
    ]);
    expect(JSON.stringify(preview)).not.toContain(externalIdentity);
  });

  it.each(["vanished", "unreadable"])("classifies a %s source race without exposing raw filesystem errors", (failure) => {
    const root = project();
    const relative = ".agentera/plan.yaml";
    const target = path.join(root, relative);
    write(root, relative, VALID_PLAN);
    const originalOpen = fs.openSync.bind(fs);
    let intercepted = false;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      if (!intercepted && typeof candidate === "string" && path.resolve(candidate) === target) {
        intercepted = true;
        if (failure === "vanished") fs.rmSync(target);
        else {
          const error = new Error("raw access failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      }
      return originalOpen(candidate, flags, mode);
    });

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    expect(intercepted).toBe(true);
    expect(preview.entries.filter((entry) => entry.source_paths.includes(relative))).toEqual([
      expect.objectContaining({ classification: "corrupt", content_sha256: null }),
    ]);
    expect(JSON.stringify(preview)).not.toContain("raw access failure");
    expect(preview.diagnostics.find((diagnostic) => diagnostic.path === relative)?.message).toContain("source path '.agentera/plan.yaml' is");
  });

  it("inventories safe plan, sidecar, objective, and experiment records exactly once", () => {
    const root = project();
    write(root, ".agentera/plan.yaml", VALID_PLAN);
    write(root, ".agentera/archive/PLAN-safe.yaml", VALID_ARCHIVED_PLAN);
    write(root, ".agentera/revisions/decisions.yaml", EXACT_SOURCE_FIXTURES[".agentera/revisions/decisions.yaml"]);
    write(root, ".agentera/optimize/latency/objective.yaml", VALID_OBJECTIVE);
    write(root, ".agentera/optimize/latency/experiments.yaml", VALID_EXPERIMENTS);

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    for (const identity of [
      ACTIVE_PLAN_ID,
      `${ACTIVE_PLAN_ID}/task:1`,
      ARCHIVED_PLAN_ID,
      `${ARCHIVED_PLAN_ID}/task:1`,
      "decision_revision:decisions:7:0",
      OBJECTIVE_ID,
      `${OBJECTIVE_ID}/experiment:7`,
    ]) {
      expect(preview.entries.filter((entry) => entry.source_identity === identity), identity).toHaveLength(1);
    }
  });

  it.each(EXACT_SOURCE_PATHS)("accounts for a symlinked exact source %s without reading its target", (relative) => {
    const root = project();
    const external = project();
    const target = path.join(root, relative);
    const externalTarget = path.join(external, "external-source");
    write(external, "external-source", EXACT_SOURCE_FIXTURES[relative]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(externalTarget, target, "file");
    const before = tree(root);
    const readSpy = vi.spyOn(fs, "readFileSync");

    const first = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    fs.appendFileSync(externalTarget, "\nexternal_identity: must-not-enter-inventory\n");
    const second = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    const observations = second.entries.filter((entry) => entry.source_paths.includes(relative));

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ classification: "corrupt", content_sha256: null, proposed_target: null });
    expect(observations[0].recovery).toContain(`Repair '${relative}'`);
    expect(second.source_fingerprint).toBe(first.source_fingerprint);
    expect(second.preview_digest).toBe(first.preview_digest);
    expect(second.counts).toEqual(first.counts);
    expect(second.entries).toEqual(first.entries);
    expect(JSON.stringify(second)).not.toContain("must-not-enter-inventory");
    expect(readSpy.mock.calls.some(([candidate]) => typeof candidate === "string" && path.resolve(candidate) === target)).toBe(false);
    expect(tree(root)).toEqual(before);
  });

  it.each(EXACT_SOURCE_PATHS)("accounts for a non-file exact source %s without reading it", (relative) => {
    const root = project();
    const target = path.join(root, relative);
    fs.mkdirSync(target, { recursive: true });
    const before = tree(root);
    const readSpy = vi.spyOn(fs, "readFileSync");

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    const observations = preview.entries.filter((entry) => entry.source_paths.includes(relative));

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ classification: "corrupt", content_sha256: null, proposed_target: null });
    expect(observations[0].recovery).toContain(`Repair '${relative}'`);
    expect(readSpy.mock.calls.some(([candidate]) => typeof candidate === "string" && path.resolve(candidate) === target)).toBe(false);
    expect(tree(root)).toEqual(before);
  });

  it.each(NESTED_EXACT_SOURCE_PATHS)("accounts for symlink traversal above exact source %s without reading its target", (relative) => {
    const root = project();
    const external = project();
    const target = path.join(root, relative);
    const targetParent = path.dirname(target);
    const externalParent = path.join(external, "external-parent");
    write(externalParent, path.basename(target), EXACT_SOURCE_FIXTURES[relative]);
    fs.mkdirSync(path.dirname(targetParent), { recursive: true });
    fs.symlinkSync(externalParent, targetParent, "dir");
    const before = tree(root);
    const readSpy = vi.spyOn(fs, "readFileSync");

    const first = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    fs.appendFileSync(path.join(externalParent, path.basename(target)), "\nexternal_identity: must-not-enter-inventory\n");
    const second = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    const observations = second.entries.filter((entry) => entry.source_paths.includes(relative));

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ classification: "corrupt", content_sha256: null, proposed_target: null });
    expect(second.source_fingerprint).toBe(first.source_fingerprint);
    expect(second.preview_digest).toBe(first.preview_digest);
    expect(second.counts).toEqual(first.counts);
    expect(second.entries).toEqual(first.entries);
    expect(JSON.stringify(second)).not.toContain("must-not-enter-inventory");
    expect(readSpy.mock.calls.some(([candidate]) => typeof candidate === "string" && path.resolve(candidate) === target)).toBe(false);
    expect(tree(root)).toEqual(before);
  });

  it("keeps active-plan preview and continuation bound to the unsafe project path", () => {
    const root = project();
    const external = project();
    const externalPlan = path.join(external, "plan.yaml");
    write(external, "plan.yaml", VALID_PLAN);
    write(root, "TODO.md", "# TODO\n\n## → Normal\n- [ ] One.\n- [ ] Two.\n");
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
    fs.symlinkSync(externalPlan, path.join(root, ".agentera", "plan.yaml"), "file");
    const before = tree(root);

    const first = previewEntityMigration(root, REPO_ROOT, { limit: 1 });
    expect(first.next_after).not.toBeNull();
    const continuation = { limit: 1, after: first.next_after as string, sourceFingerprint: first.source_fingerprint, previewDigest: first.preview_digest };
    const continued = previewEntityMigration(root, REPO_ROOT, continuation);
    fs.writeFileSync(externalPlan, VALID_PLAN.replace("123e4567-e89b-42d3-a456-426614174000", "223e4567-e89b-42d3-a456-426614174000"));

    const repeated = previewEntityMigration(root, REPO_ROOT, { limit: 1 });
    const continuedAgain = previewEntityMigration(root, REPO_ROOT, continuation);
    expect(repeated.source_fingerprint).toBe(first.source_fingerprint);
    expect(repeated.preview_digest).toBe(first.preview_digest);
    expect(repeated.counts).toEqual(first.counts);
    expect(repeated.entries).toEqual(first.entries);
    expect(continuedAgain).toEqual(continued);

    expect(tree(root)).toEqual(before);
  });

  it.each(["archive", "optimize", "optimera"])("rejects a symlinked %s inventory root without traversing or writing", (name) => {
    const root = project();
    const external = project();
    const relativeRoot = `.agentera/${name}`;
    if (name === "archive") write(external, "progress/999.yaml", "external-marker: archive\n");
    else write(external, "escape/objective.yaml", `id: objective:123e4567-e89b-42d3-a456-426614174000\nexternal-marker: ${name}\n`);
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
    fs.symlinkSync(external, path.join(root, relativeRoot), "dir");
    const beforeProject = tree(root);
    const beforeExternal = tree(external);
    let out = "";
    const rc = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--dry-run", "--format", "json"], { out: (text) => (out += text), err: () => undefined });
    expect(rc).toBe(1);
    const failure = JSON.parse(out);
    expect(failure).toMatchObject({ status: "fail", mutation_performed: false, error: { class: "inventory_failed" } });
    expect(failure.error.message).toContain(`inventory root '${path.join(root, relativeRoot)}' is a symbolic link`);
    expect(out).not.toContain("external-marker");
    expect(tree(root)).toEqual(beforeProject);
    expect(tree(external)).toEqual(beforeExternal);
  });

  it.each(["archive", "optimize", "optimera"])("rejects a non-directory %s inventory root without writes", (name) => {
    const root = project();
    write(root, `.agentera/${name}`, "not a directory\n");
    const before = tree(root);
    expect(() => previewEntityMigration(root, REPO_ROOT)).toThrow(`inventory root '${path.join(root, `.agentera/${name}`)}' is not a directory`);
    expect(tree(root)).toEqual(before);
  });

  it("discards a replaced recursive root before external names can bind preview or continuation", () => {
    const root = project();
    const external = project();
    const inventoryRoot = path.join(root, ".agentera", "archive");
    const externalRoot = path.join(external, "external-archive");
    const heldRoot = path.join(external, "held-archive");
    write(root, "TODO.md", "# TODO\n\n## → Normal\n- [ ] One.\n- [ ] Two.\n- [ ] Three.\n");
    write(root, ".agentera/archive/progress/1.yaml", "external-marker: internal\n");
    write(externalRoot, "progress/900.yaml", "external-marker: first\n");
    const originalReadDirectory = fs.readdirSync.bind(fs);
    let armed = false;
    let restore: (() => void) | undefined;

    vi.spyOn(fs, "readdirSync").mockImplementation((candidate, options) => {
      if (armed && typeof candidate === "string" && path.resolve(candidate) === inventoryRoot) {
        restore = replaceDirectoryWithExternalSymlink(inventoryRoot, externalRoot, heldRoot);
        armed = false;
      }
      return originalReadDirectory(candidate, options);
    });
    const race = <T>(operation: () => T): T => {
      armed = true;
      const result = operation();
      expect(restore).toBeTypeOf("function");
      restore?.();
      restore = undefined;
      return result;
    };
    const before = tree(root);
    const first = race(() => previewEntityMigration(root, REPO_ROOT, { limit: 1 }));
    expect(first.next_after).not.toBeNull();
    expect(first.entries).toEqual([
      expect.objectContaining({ source_paths: [".agentera/archive/"], classification: "corrupt", content_sha256: null, proposed_target: null }),
    ]);
    const continuation = { limit: 1, after: first.next_after as string, sourceFingerprint: first.source_fingerprint, previewDigest: first.preview_digest };
    const continued = race(() => previewEntityMigration(root, REPO_ROOT, continuation));
    for (let number = 901; number < 910; number += 1) write(externalRoot, `progress/${number}.yaml`, `external-marker: ${number}\n`);
    const repeated = race(() => previewEntityMigration(root, REPO_ROOT, { limit: 1 }));
    const continuedAgain = race(() => previewEntityMigration(root, REPO_ROOT, continuation));

    expect(repeated.source_fingerprint).toBe(first.source_fingerprint);
    expect(repeated.preview_digest).toBe(first.preview_digest);
    expect(repeated.counts).toEqual(first.counts);
    expect(repeated.entries).toEqual(first.entries);
    expect(continuedAgain).toEqual(continued);
    expect(JSON.stringify(repeated)).not.toContain("external-marker");
    expect(tree(root)).toEqual(before);

  });

  it("discards an entire recursive inventory when a nested directory is replaced during readdir", () => {
    const root = project();
    const external = project();
    const nested = path.join(root, ".agentera", "optimize", "latency");
    const externalNested = path.join(external, "external-latency");
    const heldNested = path.join(external, "held-latency");
    const externalIdentity = "objective:723e4567-e89b-42d3-a456-426614174000";
    write(root, ".agentera/optimize/latency/objective.yaml", VALID_OBJECTIVE);
    write(root, ".agentera/optimize/safe/objective.yaml", VALID_OBJECTIVE.replace(OBJECTIVE_ID, "objective:423e4567-e89b-42d3-a456-426614174000"));
    write(externalNested, "objective.yaml", VALID_OBJECTIVE.replace(OBJECTIVE_ID, externalIdentity));
    for (let number = 1; number < 10; number += 1) write(externalNested, `external-${number}.yaml`, `external-marker: ${number}\n`);
    const originalReadDirectory = fs.readdirSync.bind(fs);
    let restore: (() => void) | undefined;

    vi.spyOn(fs, "readdirSync").mockImplementation((candidate, options) => {
      if (!restore && typeof candidate === "string" && path.resolve(candidate) === nested) {
        restore = replaceDirectoryWithExternalSymlink(nested, externalNested, heldNested);
      }
      return originalReadDirectory(candidate, options);
    });

    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });

    expect(restore).toBeTypeOf("function");
    expect(preview.entries.filter((entry) => entry.source_paths.includes(".agentera/optimize/latency/"))).toEqual([
      expect.objectContaining({ classification: "corrupt", content_sha256: null, proposed_target: null }),
    ]);
    expect(JSON.stringify(preview)).not.toContain(OBJECTIVE_ID);
    expect(JSON.stringify(preview)).not.toContain("objective:423e4567-e89b-42d3-a456-426614174000");
    expect(JSON.stringify(preview)).not.toContain(externalIdentity);
    expect(JSON.stringify(preview)).not.toContain("external-marker");
  });

  it("reports an unreadable recursive inventory root without exposing the raw error", () => {
    const root = project();
    const inventoryRoot = path.join(root, ".agentera", "optimize");
    fs.mkdirSync(inventoryRoot, { recursive: true });
    const originalReadDirectory = fs.readdirSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation((candidate, options) => {
      if (typeof candidate === "string" && path.resolve(candidate) === inventoryRoot) {
        throw new Error("raw directory failure");
      }
      return originalReadDirectory(candidate, options);
    });
    let out = "";

    const rc = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--dry-run", "--format", "json"], { out: (text) => (out += text), err: () => undefined });

    expect(rc).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ status: "fail", error: { class: "inventory_failed", message: expect.stringContaining("cannot be read inside project") } });
    expect(out).not.toContain("raw directory failure");
  });

  it.each(["missing", "file", "symlink"])("rejects a %s project root without writes", (kind) => {
    const parent = project();
    const root = path.join(parent, "candidate");
    if (kind === "file") fs.writeFileSync(root, "not a directory");
    if (kind === "symlink") fs.symlinkSync(parent, root, "dir");
    const before = tree(parent);
    let out = "";
    const rc = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--dry-run", "--format", "json"], { out: (text) => (out += text), err: () => undefined });
    expect(rc).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ status: "fail", mutation_performed: false, error: { class: "inventory_failed" } });
    expect(JSON.parse(out).error.recovery).toContain("existing, real directory");
    expect(tree(parent)).toEqual(before);
  });

  it("classifies full, projection, summary, mirror, conflict, corrupt, unsupported, and relationships", () => {
    const root = project();
    const context = `    context:\n      intent: test\n      constraints: none\n      unknowns: none\n      scope: fixture\n`;
    const cycle = (number: number, what: string, timestamp: string) => `  - number: ${number}\n    timestamp: ${timestamp}\n    type: feat\n    phase: build\n    what: ${what}\n    inspiration: test\n    discovered: none\n    verified: passed\n    next: done\n${context}`;
    write(root, ".agentera/progress.yaml", `cycles:\n${cycle(1, "full", "2026-07-16 10:00")}${cycle(2, "projection", "2026-07-16 11:00")}  - number: 3\n    summary: unavailable detail\n${cycle(4, "duplicate", "2026-07-16 12:00")}${cycle(4, "duplicate", "2026-07-16 12:00")}${cycle(5, "first", "2026-07-16 13:00")}${cycle(5, "second", "2026-07-16 13:00")}${cycle(6, "verified", "2026-07-16 14:00")}`);
    write(root, ".agentera/archive/progress/1.yaml", `schemaVersion: agentera.stateArchiveEntry.v1\nartifact_id: progress\nentry_number: 1\nrecord:\n  number: 1\n  timestamp: 2026-07-16 10:00\n  type: feat\n  phase: build\n  what: full\n  inspiration: test\n  discovered: none\n  verified: passed\n  next: done\nrecord_sha256: invalid\n`);
    const verified = { number: 6, timestamp: "2026-07-16 14:00", type: "feat", phase: "build", what: "verified", inspiration: "test", discovered: "none", verified: "passed", next: "done", context: { intent: "test", constraints: "none", unknowns: "none", scope: "fixture" } };
    const verifiedHash = createHash("sha256").update(canonicalRecordJson(verified)).digest("hex");
    write(root, ".agentera/archive/progress/6.yaml", YAML.stringify({ schemaVersion: "agentera.stateArchiveEntry.v1", artifact_id: "progress", entry_number: 6, record: verified, record_sha256: verifiedHash }));
    write(root, ".agentera/archive/progress/unsupported.txt", "record: {}\n");
    write(root, ".agentera/plan.yaml", `header:\n  level: light\n  created: 2026-07-16\n  status: open\n  title: test\n  id: plan:123e4567-e89b-42d3-a456-426614174000\nwhat: test\nwhy: test\nconstraints: none\noverall_acceptance: pass\nscope:\n  included: [test]\n  excluded: []\ntasks:\n  - number: 1\n    name: one\n    depends_on: []\n    status: pending\n    acceptance: [pass]\n  - number: 2\n    name: two\n    depends_on: ["1"]\n    status: pending\n    acceptance: [pass]\nsurprises: []\n`);
    const preview = previewEntityMigration(root, REPO_ROOT);
    expect(preview.counts).toMatchObject({ recoverable_degraded_full_projection: 2, valid_compacted_summary: 1, mirrors: 2, duplicates: 1, conflicts: 1, corrupt: 1, unsupported: 1, physical_records: 14, logical_identities: 10 });
    expect(preview.entries.find((entry) => entry.source_identity === "progress:3")).toMatchObject({ boundary: "progress_summary", classification: "valid_compacted_summary", detail_availability: "summary", compatibility: "degraded", proposed_target: expect.any(Object) });
    expect(preview.entries.find((entry) => entry.source_identity === "progress:4")?.classification).toBe("recoverable_degraded_full_projection");
    expect(preview.entries.find((entry) => entry.source_identity === "progress:5")?.classification).toBe("duplicate");
    expect(preview.entries.find((entry) => entry.source_identity === "progress:6")?.classification).toBe("verified_full");
    expect(preview.entries.some((entry) => entry.boundary === "plan_task" && entry.relationships.some((relation) => relation.field === "depends_on" && relation.status === "resolved"))).toBe(true);
    expect(preview.entries.every((entry) => !("record" in entry))).toBe(true);
  });

  it("blocks divergent compacted summaries independent of source order", () => {
    const summarySource = (rows: string[]) => `cycles:\n${rows.map((summary) => `  - number: 3\n    summary: ${summary}\n`).join("")}`;
    const first = project();
    const second = project();
    write(first, ".agentera/progress.yaml", summarySource(["first retained body", "second retained body"]));
    write(second, ".agentera/progress.yaml", summarySource(["second retained body", "first retained body"]));

    const entries = [planEntityMigration(first, REPO_ROOT), planEntityMigration(second, REPO_ROOT)].map((plan) => plan.entries.find((entry) => entry.source_identity === "progress:3")!);
    expect(entries).toEqual(entries.map(() => expect.objectContaining({
      classification: "conflict",
      detail_availability: "full",
      compatibility: "current",
      proposed_target: null,
      record: { summary: "first retained body" },
    })));
  });

  it("publishes canonical-equivalent summary mirrors deterministically in either source order", () => {
    const summarySource = (rows: Array<{ alias: string; value: string }>) => `cycles:\n${rows.map(({ alias, value }) => `  - number: 3\n    ${alias}: ${value}\n    summary: retained body\n`).join("")}`;
    const first = project();
    const second = project();
    write(first, ".agentera/progress.yaml", summarySource([{ alias: "stable_id", value: "legacy-a" }, { alias: "type_prefixed_id", value: "legacy-b" }]));
    write(second, ".agentera/progress.yaml", summarySource([{ alias: "type_prefixed_id", value: "legacy-b" }, { alias: "stable_id", value: "legacy-a" }]));

    const entries = [planEntityMigration(first, REPO_ROOT), planEntityMigration(second, REPO_ROOT)].map((plan) => plan.entries.find((entry) => entry.source_identity === "progress:3")!);
    expect(entries[0]).toMatchObject({ classification: "valid_compacted_summary", proposed_target: expect.any(Object), record: { summary: "retained body", migration_provenance: expect.any(Object) } });
    expect(entries[1]).toMatchObject({ classification: "valid_compacted_summary", proposed_target: entries[0].proposed_target, record: entries[0].record, target_sha256: entries[0].target_sha256 });
    expect(entries[0].record).not.toHaveProperty("stable_id");
    expect(entries[0].record).not.toHaveProperty("type_prefixed_id");
  });

  it.each([
    ["progress", "cycles", { number: 7, timestamp: "2026-07-16 10:00", type: "fix", phase: "build", what: "retained work", inspiration: "audit", discovered: "none", verified: "tests", next: "done", context: { intent: "verify", constraints: "none", unknowns: "none", scope: "state" } }],
    ["decisions", "decisions", { number: 7, date: "2026-07-16", question: "Keep full?", context: "audit", alternatives: [{ name: "yes", status: "chosen" }], choice: "yes", reasoning: "evidence", confidence: "firm" }],
    ["health", "audits", { number: 7, date: "2026-07-16", dimensions: ["architecture_alignment"], findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }, trajectory: "stable", grades: { architecture_alignment: "A" } }],
  ] as const)("requires every mixed %s summary to mirror the selected full record in every order", (artifact, collection, full) => {
    const matching = yamlArchiveEntry(artifact, full);
    const divergent = { ...matching, summary: `${matching.summary} divergent` };
    for (const summary of [matching, divergent]) {
      const results = [[full, summary], [summary, full]].map((rows) => {
        const root = project();
        write(root, `.agentera/${artifact}.yaml`, YAML.stringify({ [collection]: rows }));
        return planEntityMigration(root, REPO_ROOT).entries.find((entry) => entry.source_identity === `${artifact}:7`)!;
      });
      if (summary === matching) {
        expect(results.every((entry) => entry.proposed_target !== null), JSON.stringify(results)).toBe(true);
        expect(results.map((entry) => entry.record)).toEqual([results[0].record, results[0].record]);
        if (artifact === "decisions") expect(results[0].record).not.toHaveProperty("satisfaction");
      } else {
        expect(results).toEqual(results.map(() => expect.objectContaining({ classification: "conflict", proposed_target: null })));
      }
    }
  });

  it("binds scalar summaries truthfully and reconciles scalar/mapping mirrors without order dependence", () => {
    const scalar = "Cycle 3 retained body";
    const mapping = { number: 3, summary: scalar };
    const scalarOnly = project();
    write(scalarOnly, ".agentera/progress.yaml", YAML.stringify({ cycles: [scalar] }));
    const scalarEntry = planEntityMigration(scalarOnly, REPO_ROOT).entries.find((entry) => entry.source_identity === "progress:3")!;
    expect(scalarEntry).toMatchObject({ classification: "valid_compacted_summary", proposed_target: expect.any(Object), record: { summary: scalar, migration_provenance: { source_record_sha256: createHash("sha256").update(canonicalRecordJson(scalar)).digest("hex") } } });

    const mirrors = [[scalar, mapping], [mapping, scalar]].map((rows) => {
      const root = project(); write(root, ".agentera/progress.yaml", YAML.stringify({ cycles: rows }));
      return planEntityMigration(root, REPO_ROOT).entries.find((entry) => entry.source_identity === "progress:3")!;
    });
    expect(mirrors[1]).toMatchObject({ classification: "valid_compacted_summary", proposed_target: mirrors[0].proposed_target, record: mirrors[0].record, target_sha256: mirrors[0].target_sha256 });

    const divergent = project();
    write(divergent, ".agentera/progress.yaml", YAML.stringify({ cycles: [scalar, { number: 3, summary: "Cycle 3 divergent" }] }));
    expect(planEntityMigration(divergent, REPO_ROOT).entries.find((entry) => entry.source_identity === "progress:3")).toMatchObject({ classification: "conflict", proposed_target: null });
  });

  it.each([
    ["hidden divergent rows", [{ number: 99, summary: "hidden" }]],
    ["benign unknown array", []],
  ])("blocks authority-undeclared aggregate collections: %s", (_label, hidden) => {
    const outcomes = [
      { cycles: [{ number: 1, summary: "Cycle 1 retained" }], hidden },
      { hidden, cycles: [{ number: 1, summary: "Cycle 1 retained" }] },
    ].map((document) => {
      const root = project(); write(root, ".agentera/progress.yaml", YAML.stringify(document)); const before = tree(root);
      const plan = planEntityMigration(root, REPO_ROOT);
      expect(tree(root)).toEqual(before);
      return plan;
    });
    for (const plan of outcomes) {
      expect(plan.counts).toMatchObject({ blockers: 1, corrupt: 1, publishable_entities: 1 });
      expect(plan.diagnostics).toEqual([expect.objectContaining({ source_identity: "progress:undeclared_collection:hidden", path: ".agentera/progress.yaml", message: expect.stringContaining("not declared") })]);
    }
    expect(outcomes.map((plan) => plan.entries.find((entry) => entry.source_identity.includes("undeclared_collection")))).toEqual(outcomes.map(() => expect.objectContaining({ source_identity: "progress:undeclared_collection:hidden", classification: "corrupt", proposed_target: null, source_paths: [".agentera/progress.yaml"] })));
  });

  it("takes aggregate collection allowlists from the selected authority", () => {
    const root = project();
    const sourceRoot = project();
    fs.cpSync(path.join(REPO_ROOT, "references"), path.join(sourceRoot, "references"), { recursive: true });
    const authorityPath = path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml");
    const authority = YAML.parse(fs.readFileSync(authorityPath, "utf8"));
    authority.entity_target.entities.find((entry: any) => entry.boundary === "progress_summary").canonical_metadata.summary_migration_provenance.sources[0].collections.push("hidden");
    fs.writeFileSync(authorityPath, YAML.stringify(authority));
    write(root, ".agentera/progress.yaml", YAML.stringify({ cycles: [{ number: 1, summary: "Cycle 1 retained" }], hidden: [] }));
    expect(planEntityMigration(root, sourceRoot).entries.some((entry) => entry.source_identity.includes("undeclared_collection"))).toBe(false);
  });

  it("omits whole entries under bounds without truncating scalar identities", () => {
    const root = project();
    write(root, "TODO.md", `# TODO\n\n## → Normal\n${Array.from({ length: 30 }, (_, index) => `- [ ] Item ${index} ${"x".repeat(200)}`).join("\n")}\n`);
    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 2 });
    expect(preview.entries).toHaveLength(2);
    expect(preview.omitted).toBe(true);
    expect(preview.omitted_count).toBe(28);
    expect(preview.counts.total).toBe(30);
    expect(preview.entries[0].source_identity).toContain("TODO.md:line:");
  });

  it("uses snapshot-bound whole-entry pagination to recover every entry without gaps or duplicates", () => {
    const root = project();
    write(root, "TODO.md", `# TODO\n\n## → Normal\n${Array.from({ length: 40 }, (_, index) => `- [ ] Item ${index} ${"x".repeat(200)}`).join("\n")}\n`);
    const { identities: recovered, pages } = collectMigrationPreviewPages(root, REPO_ROOT);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8")).toBeLessThanOrEqual(ENTITY_MIGRATION_PREVIEW_MAX_OUTPUT_BYTES);
      if (page.next_after) {
        expect(page.retrieval.command).toContain(`--after '${page.next_after.replaceAll("'", "'\\''")}'`);
        expect(page.retrieval.command).toContain(`--source-fingerprint ${page.source_fingerprint}`);
        expect(page.retrieval.command).toContain(`--preview-digest ${page.preview_digest}`);
      }
    }
    expect(new Set(recovered).size).toBe(40);
    expect(recovered).toHaveLength(40);
  });

  it.each(["source", "authority", "filter", "order", "project"])("refuses a continuation after %s binding mutation with restart guidance", (mutation) => {
    const root = project();
    const sourceRoot = project();
    fs.cpSync(path.join(REPO_ROOT, "references"), path.join(sourceRoot, "references"), { recursive: true });
    write(root, "TODO.md", "# TODO\n- [ ] one\n- [ ] two\n");
    const first = previewEntityMigration(root, sourceRoot, { limit: 1 });
    const continuation = { limit: 1, after: first.next_after as string, sourceFingerprint: first.source_fingerprint, previewDigest: first.preview_digest };
    let selectedRoot = root;
    if (mutation === "source") write(root, "TODO.md", "# TODO\n- [ ] changed\n- [ ] two\n");
    if (mutation === "project") {
      selectedRoot = project();
      write(selectedRoot, "TODO.md", "# TODO\n- [ ] one\n- [ ] two\n");
    }
    if (mutation === "authority" || mutation === "filter" || mutation === "order") {
      const authority = path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml");
      if (mutation === "filter") {
        const bytes = fs.readFileSync(authority, "utf8");
        fs.writeFileSync(authority, bytes.replace("filter: complete_declared_inventory", "filter: changed_inventory_filter"));
      } else if (mutation === "order") {
        const bytes = fs.readFileSync(authority, "utf8");
        fs.writeFileSync(authority, bytes.replace("ordering: artifact_then_boundary_then_source_identity_then_source_path", "ordering: changed_inventory_order"));
      } else fs.appendFileSync(authority, "\n# authority binding mutation\n");
    }
    expect(() => previewEntityMigration(selectedRoot, sourceRoot, continuation)).toThrow(/continuation no longer matches.*restart with agentera state migrate entities --project/s);
    if (mutation === "source") {
      let out = "";
      expect(main(["node", "agentera", "state", "migrate", "entities", "--project", selectedRoot, "--after", continuation.after, "--source-fingerprint", continuation.sourceFingerprint, "--preview-digest", continuation.previewDigest, "--limit", "1", "--dry-run", "--format", "json"], { out: (value) => (out += value), err: () => undefined }, process.cwd(), sourceRoot)).toBe(1);
      expect(JSON.parse(out)).toMatchObject({ status: "fail", mutation_performed: false, error: { class: "continuation_changed", recovery: expect.not.stringContaining("--after") } });
    }
  });

  it("reports unresolved relationship sources as root blockers and recovers omitted diagnostics through continuation", () => {
    const root = project();
    write(root, ".agentera/plan.yaml", `header:\n  level: light\n  created: 2026-07-16\n  status: open\n  title: test\n  id: plan:123e4567-e89b-42d3-a456-426614174000\nwhat: test\nwhy: test\nconstraints: none\noverall_acceptance: pass\nscope:\n  included: [test]\n  excluded: []\ntasks:\n${Array.from({ length: 8 }, (_, index) => `  - number: ${index + 1}\n    name: task ${index + 1}\n    depends_on: [\"${index + 20}\"]\n    status: pending\n    acceptance: [pass]`).join("\n")}\nsurprises: []\n`);
    const diagnostics: EntityMigrationPreview["diagnostics"] = [];
    let page = previewEntityMigration(root, REPO_ROOT, { limit: 2 });
    do {
      diagnostics.push(...page.diagnostics);
      if (!page.next_after) break;
      page = previewEntityMigration(root, REPO_ROOT, { limit: 2, after: page.next_after, sourceFingerprint: page.source_fingerprint, previewDigest: page.preview_digest });
    } while (true);
    const unresolved = diagnostics.filter((diagnostic) => diagnostic.classification === "corrupt" && diagnostic.message.includes("unresolved target"));
    expect(unresolved).toHaveLength(8);
    expect(unresolved[0]).toMatchObject({
      source_identity: "plan:123e4567-e89b-42d3-a456-426614174000/task:1",
      relationship_field: "depends_on",
      target_source_identity: "plan:123e4567-e89b-42d3-a456-426614174000/task:20",
    });
    expect(unresolved[0].recovery).toContain("Repair relationship 'depends_on'");
    expect(unresolved[0].recovery).toContain("task:20");
    expect(new Set(unresolved.map((diagnostic) => diagnostic.source_identity)).size).toBe(8);

    for (const format of ["json", "yaml"] as const) {
      let structured = "";
      expect(main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--limit", "1000", "--dry-run", "--format", format], { out: (value) => (structured += value), err: () => undefined })).toBe(1);
      const body = format === "json" ? JSON.parse(structured) : YAML.parse(structured);
      expect(body.counts).toMatchObject({ root_blockers: 8, dependent_blockers: 0, blockers: 8, corrupt: 8 });
      expect(body.diagnostics.find((diagnostic: EntityMigrationPreview["diagnostics"][number]) => diagnostic.classification === "corrupt")?.recovery).toContain("Repair relationship 'depends_on'");
    }
    let text = "";
    expect(main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--limit", "1000", "--dry-run"], { out: (value) => (text += value), err: () => undefined })).toBe(1);
    expect(text).toContain("blocker corrupt plan:123e4567-e89b-42d3-a456-426614174000/task:1");
    expect(text).toContain("Repair relationship 'depends_on'");
    expect(text).toContain("task:20");
  });

  it("separates corrupt source roots from valid relationship dependents", () => {
    const root = project();
    const decisions = YAML.parse(EXACT_SOURCE_FIXTURES[".agentera/decisions.yaml"]);
    delete decisions.decisions[0].reasoning;
    write(root, ".agentera/decisions.yaml", YAML.stringify(decisions));
    write(root, ".agentera/overlays/decisions.yaml", EXACT_SOURCE_FIXTURES[".agentera/overlays/decisions.yaml"]);

    const plan = planEntityMigration(root, REPO_ROOT);
    const source = plan.entries.find((entry) => entry.source_identity === "decisions:7")!;
    const dependent = plan.entries.find((entry) => entry.source_identity === "decision_satisfaction:decisions:7")!;
    expect(source).toMatchObject({ classification: "corrupt", proposed_target: null });
    expect(dependent).toMatchObject({ classification: "verified_full", proposed_target: null, relationships: [expect.objectContaining({ status: "resolved", target_source_identity: "decisions:7" })] });
    expect(plan.counts).toMatchObject({ corrupt: 1, root_blockers: 1, dependent_blockers: 1, blockers: 2 });
    expect(plan.counts.blockers).toBe(plan.counts.root_blockers + plan.counts.dependent_blockers);
    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: "corrupt", source_identity: "decisions:7" }),
      expect.objectContaining({ classification: "dependent_blocker", source_identity: "decision_satisfaction:decisions:7", root_source_identity: "decisions:7", relationship_field: "decision" }),
    ]));
    let text = "";
    expect(main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--limit", "1000", "--dry-run"], { out: (value) => (text += value), err: () => undefined })).toBe(1);
    expect(text).toContain("blocker dependent_blocker decision_satisfaction:decisions:7 root_source_identity=decisions:7");
    expect(text).toContain("relationship 'decision' is blocked by root source 'decisions:7'");
  });

  it("attributes multiple valid dependents to each of multiple corrupt roots", () => {
    const root = project();
    const decisions = YAML.parse(EXACT_SOURCE_FIXTURES[".agentera/decisions.yaml"]);
    const second = structuredClone(decisions.decisions[0]);
    second.number = 8;
    delete decisions.decisions[0].reasoning;
    delete second.reasoning;
    decisions.decisions.push(second);
    write(root, ".agentera/decisions.yaml", YAML.stringify(decisions));
    write(root, ".agentera/overlays/decisions.yaml", `decisions:7:\n  satisfaction:\n    state: provisionally_satisfied\n    evidence: first\ndecisions:8:\n  satisfaction:\n    state: provisionally_satisfied\n    evidence: second\n`);

    const plan = planEntityMigration(root, REPO_ROOT);
    expect(plan.counts).toMatchObject({ corrupt: 2, root_blockers: 2, dependent_blockers: 2, blockers: 4 });
    expect(plan.diagnostics.filter((diagnostic) => diagnostic.classification === "dependent_blocker")).toEqual([
      expect.objectContaining({ source_identity: "decision_satisfaction:decisions:7", root_source_identity: "decisions:7" }),
      expect.objectContaining({ source_identity: "decision_satisfaction:decisions:8", root_source_identity: "decisions:8" }),
    ]);
  });

  it("roots relationship cycles deterministically and attributes the remaining cycle member", () => {
    const root = project();
    write(root, ".agentera/plan.yaml", VALID_PLAN.replace("depends_on: []", "depends_on: [Task 2]").replace("surprises: []", "  - number: 2\n    name: two\n    depends_on: [Task 1]\n    status: pending\n    acceptance: [pass]\nsurprises: []"));

    const plan = planEntityMigration(root, REPO_ROOT);
    const rootIdentity = `${ACTIVE_PLAN_ID}/task:1`;
    const dependentIdentity = `${ACTIVE_PLAN_ID}/task:2`;
    expect(plan.entries.find((entry) => entry.source_identity === rootIdentity)).toMatchObject({ classification: "corrupt", proposed_target: null });
    expect(plan.entries.find((entry) => entry.source_identity === dependentIdentity)).toMatchObject({ classification: "verified_full", proposed_target: null });
    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: "corrupt", source_identity: rootIdentity, message: expect.stringContaining("cycle") }),
      expect.objectContaining({ classification: "dependent_blocker", source_identity: dependentIdentity, root_source_identity: rootIdentity }),
    ]));
    let text = "";
    expect(main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--limit", "1000", "--dry-run"], { out: (value) => (text += value), err: () => undefined })).toBe(1);
    expect(text).toContain(`blocker dependent_blocker ${dependentIdentity} root_source_identity=${rootIdentity}`);
    expect(text).toContain(`relationship 'depends_on' is blocked by root source '${rootIdentity}'`);
  });

  it("renders a complete text summary and dedicated entity help", () => {
    const root = project();
    write(root, ".agentera/progress.yaml", "cycles:\n  - number: 1\n    summary: unavailable detail\n");
    let out = "";
    const rc = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--dry-run"], { out: (text) => (out += text), err: () => undefined });
    expect(rc).toBe(0);
    expect(out).toContain("status: ready");
    expect(out).toContain("classes:");
    expect(out).toContain("physical_records:");
    expect(out).toContain("blockers:");
    expect(out).toContain("omission:");
    expect(out).toContain("recovery:");
    out = "";
    expect(main(["node", "agentera", "state", "migrate", "entities", "--help"], { out: (text) => (out += text), err: () => undefined })).toBe(0);
    expect(out).toContain("usage: agentera state migrate entities");
    expect(out).toContain("--after SOURCE_IDENTITY --source-fingerprint SHA256 --preview-digest SHA256");
    expect(out).not.toContain("--artifact");
    expect(printStateHelp("migrate")).not.toContain("[--project PATH] [--limit 1..1000]");
  });

  it("exposes the explicit CLI namespace and never performs apply", () => {
    const root = project();
    let out = "";
    const rc = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--dry-run", "--format", "json"], { out: (text) => (out += text), err: () => undefined });
    expect(rc).toBe(0);
    const preview = JSON.parse(out);
    expect(preview).toMatchObject({ command: "state migrate entities", read_only: true, mutation_performed: false });
    write(root, "TODO.md", "# TODO\n- [ ] changed after preview\n");
    const before = tree(root);
    let rejected = "";
    const apply = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--apply", "--force", "--source-fingerprint", preview.source_fingerprint, "--preview-digest", preview.preview_digest, "--format", "json"], { out: (text) => (rejected += text), err: (text) => (rejected += text) });
    expect(apply).toBe(1);
    expect(rejected).toContain("upgrade --channel development");
    expect(rejected).toContain("--yes");
    expect(tree(root)).toEqual(before);
    expect(printStateHelp("migrate")).toContain("agentera state migrate entities");
  });
});

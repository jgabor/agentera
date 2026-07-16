import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { printStateHelp } from "../../src/cli/help.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import {
  assertEntityMigrationBinding,
  previewEntityMigration,
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

const EXACT_SOURCE_FIXTURES = {
  "TODO.md": "# TODO\n\n## → Normal\n- [ ] Preserve this exact item.\n",
  ".agentera/docs.yaml": "index:\n  - path: README.md\n",
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
    write(root, ".agentera/decisions.yaml", `decisions:\n  - number: 7\n    date: 2026-07-16\n    question: Question?\n    choice: Choice.\n    reasoning: Reason.\n    confidence: high\n    status: decided\n    feeds_into: []\n`);
    write(root, ".agentera/revisions/decisions.yaml", `decisions:7:\n  - date: 2026-07-16\n    choice: First revision.\n    provenance: historical_revision\n  - date: 2026-07-17\n    reasoning: Second revision.\n    provenance: degraded_projection\ndecisions:8:\n  - choice: Invalid provenance.\n    provenance: revision\ndecisions:bad: not-a-list\n`);
    const preview = previewEntityMigration(root, REPO_ROOT, { limit: 1000 });
    const revisions = preview.entries.filter((entry) => entry.boundary === "decision_revision");
    expect(revisions.map((entry) => entry.source_identity)).toEqual([
      "decision_revision:decisions:7:0",
      "decision_revision:decisions:7:1",
      "decision_revision:decisions:8:0",
      "decision_revision:decisions:bad",
    ]);
    expect(revisions.slice(0, 2).every((entry) => entry.relationships.some((relation) => relation.field === "decision" && relation.target_source_identity === "decisions:7" && relation.status === "resolved"))).toBe(true);
    expect(revisions.slice(0, 2).every((entry) => entry.classification === "verified_full")).toBe(true);
    expect(revisions.slice(0, 2).map((entry) => entry.provenance)).toEqual([["revision"], ["revision"]]);
    expect(revisions.slice(2).every((entry) => entry.classification === "corrupt")).toBe(true);
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

  it("keeps active-plan preview, continuation, and apply preflight bound to the unsafe project path", () => {
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

    let out = "";
    const rc = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--apply", "--force", "--source-fingerprint", first.source_fingerprint, "--preview-digest", first.preview_digest, "--format", "json"], { out: (value) => (out += value), err: () => undefined }, process.cwd(), REPO_ROOT);
    expect(rc).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ mutation_performed: false, error: { class: "apply_not_implemented" } });
    expect(out).not.toContain("223e4567-e89b-42d3-a456-426614174000");
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
    expect(preview.counts).toMatchObject({ recoverable_degraded_full_projection: 2, irrecoverable_summary_only: 1, mirrors: 2, duplicates: 1, conflicts: 1, corrupt: 1, unsupported: 1, physical_records: 14, logical_identities: 10 });
    expect(preview.entries.find((entry) => entry.source_identity === "progress:4")?.classification).toBe("recoverable_degraded_full_projection");
    expect(preview.entries.find((entry) => entry.source_identity === "progress:5")?.classification).toBe("duplicate");
    expect(preview.entries.find((entry) => entry.source_identity === "progress:6")?.classification).toBe("verified_full");
    expect(preview.entries.some((entry) => entry.boundary === "plan_task" && entry.relationships.some((relation) => relation.field === "depends_on" && relation.status === "resolved"))).toBe(true);
    expect(preview.entries.every((entry) => !("record" in entry))).toBe(true);
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
    write(root, "TODO.md", `# TODO\n\n## → Normal\n${Array.from({ length: 400 }, (_, index) => `- [ ] Item ${index} ${"x".repeat(200)}`).join("\n")}\n`);
    const recovered: string[] = [];
    let after: string | undefined;
    let sourceFingerprint: string | undefined;
    let previewDigest: string | undefined;
    do {
      const page = previewEntityMigration(root, REPO_ROOT, { limit: 1000, after, sourceFingerprint, previewDigest });
      expect(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8")).toBeLessThanOrEqual(32_768);
      recovered.push(...page.entries.map((entry) => entry.source_identity));
      after = page.next_after ?? undefined;
      sourceFingerprint = page.source_fingerprint;
      previewDigest = page.preview_digest;
      if (page.next_after) {
        expect(page.retrieval.command).toContain(`--after '${after?.replaceAll("'", "'\\''")}'`);
        expect(page.retrieval.command).toContain(`--source-fingerprint ${sourceFingerprint}`);
        expect(page.retrieval.command).toContain(`--preview-digest ${previewDigest}`);
      }
    } while (after);
    expect(new Set(recovered).size).toBe(400);
    expect(recovered).toHaveLength(400);
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

  it("emits exact unresolved-relationship diagnostics and recovers omitted diagnostics through continuation", () => {
    const root = project();
    write(root, ".agentera/plan.yaml", `header:\n  level: light\n  created: 2026-07-16\n  status: open\n  title: test\n  id: plan:123e4567-e89b-42d3-a456-426614174000\nwhat: test\nwhy: test\nconstraints: none\noverall_acceptance: pass\nscope:\n  included: [test]\n  excluded: []\ntasks:\n${Array.from({ length: 8 }, (_, index) => `  - number: ${index + 1}\n    name: task ${index + 1}\n    depends_on: [\"${index + 20}\"]\n    status: pending\n    acceptance: [pass]`).join("\n")}\nsurprises: []\n`);
    const diagnostics: EntityMigrationPreview["diagnostics"] = [];
    let page = previewEntityMigration(root, REPO_ROOT, { limit: 2 });
    do {
      diagnostics.push(...page.diagnostics);
      if (!page.next_after) break;
      page = previewEntityMigration(root, REPO_ROOT, { limit: 2, after: page.next_after, sourceFingerprint: page.source_fingerprint, previewDigest: page.preview_digest });
    } while (true);
    const unresolved = diagnostics.filter((diagnostic) => diagnostic.classification === "unresolved_relationship");
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
      expect(body.diagnostics.find((diagnostic: EntityMigrationPreview["diagnostics"][number]) => diagnostic.classification === "unresolved_relationship")?.recovery).toContain("Repair relationship 'depends_on'");
    }
    let text = "";
    expect(main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--limit", "1000", "--dry-run"], { out: (value) => (text += value), err: () => undefined })).toBe(1);
    expect(text).toContain("blocker unresolved_relationship plan:123e4567-e89b-42d3-a456-426614174000/task:1");
    expect(text).toContain("Repair relationship 'depends_on'");
    expect(text).toContain("task:20");
  });

  it("renders a complete text summary and dedicated entity help", () => {
    const root = project();
    write(root, ".agentera/progress.yaml", "cycles:\n  - number: 1\n    summary: unavailable detail\n");
    let out = "";
    const rc = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--dry-run"], { out: (text) => (out += text), err: () => undefined });
    expect(rc).toBe(1);
    expect(out).toContain("status: blocked");
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
    out = "";
    const apply = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--apply", "--force", "--source-fingerprint", preview.source_fingerprint, "--preview-digest", preview.preview_digest, "--format", "json"], { out: (text) => (out += text), err: () => undefined });
    expect(apply).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ mutation_performed: false, error: { class: "source_changed" } });
    expect(tree(root)).toEqual(before);
    expect(printStateHelp("migrate")).toContain("agentera state migrate entities");
  });
});

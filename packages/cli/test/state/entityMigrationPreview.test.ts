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
} from "../../src/state/entityMigrationPreview.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];

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
    return entry.isDirectory() ? [relative + "/", ...visit(absolute)] : [relative + ":" + fs.readFileSync(absolute).toString("hex")];
  });
  return visit(root).sort();
}

afterEach(() => {
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
    expect(() => assertEntityMigrationBinding(first.source_fingerprint, first.preview_digest, changed, effect)).toThrow(/source changed/);
    expect(effect).not.toHaveBeenCalled();
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
    expect(preview.counts).toMatchObject({ recoverable_degraded_full_projection: 1, irrecoverable_summary_only: 1, duplicate_mirror: 1, conflict: 1, corrupt: 1, unsupported: 1 });
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

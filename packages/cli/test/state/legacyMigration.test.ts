import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";

import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectLegacyMigration, applyLegacyMigration } from "../../src/state/legacyMigration.js";
import { inventoryCandidates, runMigrate } from "../../src/cli/commands/migrate.js";
import { stateMigrationContract } from "../../src/state/migrationAuthority.js";
import { listStateEntries } from "../../src/state/listRetrieval.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-legacy-migration-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  return root;
}

function progress(number: number, what = `Cycle ${number}`): Record<string, unknown> {
  return {
    number,
    timestamp: "2026-07-14 09:00",
    type: "fix",
    phase: "build",
    what,
    context: { intent: "test migration" },
  };
}

function inventory(
  root: string,
  args: { artifact: string | null; number?: number; path?: string | null } = { artifact: null },
): ReturnType<typeof inspectLegacyMigration> {
  const contract = stateMigrationContract(REPO_ROOT);
  return inspectLegacyMigration(inventoryCandidates(root, contract), contract, REPO_ROOT, args);
}

function captureMigration(argv: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = runMigrate(
    argv,
    { out: (value) => (out += value), err: (value) => (err += value) },
    REPO_ROOT,
  );
  return { rc, out, err };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded non-Git legacy migration", () => {
  it("archives exact local records, backs up exact bytes, projects compatibly, and converges on retry", () => {
    const root = project();
    const source = path.join(root, ".agentera", "PROGRESS.md");
    const sourceBytes = [
      "## Cycle 1 · 2026-07-14 09:00 · fix: migrate one record",
      "",
      "**Phase**: build",
      "**What**: migrate one record",
      "**Context**: intent: test migration",
      "",
    ].join("\n");
    fs.writeFileSync(source, sourceBytes);
    const projection = path.join(root, ".agentera", "progress.yaml");
    fs.writeFileSync(projection, YAML.stringify({ cycles: [progress(2, "existing record")] }));

    const record = progress(1, "migrate one record");
    const inspected = inventory(root, {
      artifact: "progress",
      number: 1,
      path: ".agentera/PROGRESS.md",
    });
    expect(inspected.operations).toHaveLength(1);
    expect(inspected.entries).toContainEqual(
      expect.objectContaining({
        path: ".agentera/PROGRESS.md",
        artifact_id: "progress",
        entry_number: 1,
        addressable: true,
      }),
    );

    const applied = applyLegacyMigration(
      inspected,
      { artifact: "progress", number: 1, path: ".agentera/PROGRESS.md" },
      { sourceRoot: REPO_ROOT },
    );
    expect(applied.diagnostics).toEqual([]);
    expect(applied.status).toBe("complete");
    expect(applied.mutationPerformed).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentera", "archive", "progress", "1.yaml"))).toBe(true);
    const backupFiles = fs.readdirSync(path.join(root, ".agentera", "migration-backups"));
    expect(backupFiles).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(root, ".agentera", "migration-backups", backupFiles[0]), "utf8"),
    ).toBe(sourceBytes);
    expect(YAML.parse(fs.readFileSync(projection, "utf8")).cycles).toEqual([
      progress(2, "existing record"),
      record,
    ]);
    const listed = listStateEntries(root, "progress", 20, {}, undefined, { sourceRoot: REPO_ROOT });
    expect(listed.counts).toMatchObject({
      physical: 3,
      addressable: 3,
      unaddressable: 0,
      ambiguous: 0,
    });

    const retry = applyLegacyMigration(
      inspected,
      { artifact: "progress", number: 1, path: ".agentera/PROGRESS.md" },
      { sourceRoot: REPO_ROOT },
    );
    expect(retry.status).toBe("complete");
    expect(retry.mutationPerformed).toBe(true);
    expect(fs.readdirSync(path.join(root, ".agentera", "archive", "progress"))).toEqual(["1.yaml"]);
    expect(fs.readdirSync(path.join(root, ".agentera", "migration-backups"))).toEqual(backupFiles);
  });

  it("parses a complete legacy decision without inventing satisfaction or detail", () => {
    const root = project();
    fs.writeFileSync(
      path.join(root, ".agentera", "DECISIONS.md"),
      [
        "## Decision 53 · 2026-07-14",
        "",
        "**Question**: Which local migration path is safe?",
        "**Context**: The source must remain recoverable.",
        "**Alternatives**:",
        "- [Archive first], chosen: preserve source",
        "- [Rewrite source], rejected: unsafe",
        "**Choice**: Archive first",
        "**Reasoning**: Immutable publication prevents accidental loss.",
        "**Confidence**: firm",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(root, ".agentera", "decisions.yaml"),
      YAML.stringify({
        decisions: [
          {
            number: 1,
            date: "2026-07-01",
            question: "Existing decision",
            context: "Existing context",
            alternatives: [{ name: "Keep", status: "chosen" }],
            choice: "Keep",
            reasoning: "Existing reasoning",
            confidence: "firm",
          },
        ],
      }),
    );
    const args = { artifact: "decisions", number: 53, path: ".agentera/DECISIONS.md" } as const;
    const inspected = inventory(root, args);
    expect(inspected.entries).toContainEqual(
      expect.objectContaining({ addressable: true, detail_availability: "full" }),
    );
    const applied = applyLegacyMigration(inspected, args, { sourceRoot: REPO_ROOT });
    expect(applied.diagnostics).toEqual([]);
    expect(applied.status).toBe("complete");
    const archive = YAML.parse(
      fs.readFileSync(path.join(root, ".agentera", "archive", "decisions", "53.yaml"), "utf8"),
    );
    expect(archive.record.satisfaction).toBeUndefined();
  });

  it("refuses summaries, corrupt records, ambiguous identities, and unsupported custom content without archives", () => {
    const root = project();
    fs.writeFileSync(
      path.join(root, ".agentera", "PROGRESS.md"),
      "## Archived Cycles\n- Cycle 4 (2026-07-01): summary only\n",
    );
    fs.writeFileSync(path.join(root, ".agentera", "DECISIONS.md"), "cycles: [\n");
    fs.writeFileSync(
      path.join(root, "CUSTOM.yaml"),
      YAML.stringify({ cycles: [progress(2), progress(2)] }),
    );
    fs.writeFileSync(path.join(root, "NOTES.yaml"), "notes: true\n");
    const outside = path.join(os.tmpdir(), `agentera-legacy-outside-${process.pid}.yaml`);
    fs.writeFileSync(outside, YAML.stringify({ cycles: [progress(7)] }));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(root, "SYMLINK.yaml"));

    const inspected = inventory(root, {
      artifact: "progress",
      number: 4,
      path: ".agentera/PROGRESS.md",
    });
    expect(inspected.entries).toContainEqual(
      expect.objectContaining({ detail_availability: "summary", addressable: false }),
    );
    expect(inspected.entries).toContainEqual(
      expect.objectContaining({
        path: "SYMLINK.yaml",
        classification: "project_boundary",
        rejection: "symlink_escape",
      }),
    );
    const summary = applyLegacyMigration(
      inspected,
      { artifact: "progress", number: 4, path: ".agentera/PROGRESS.md" },
      { sourceRoot: REPO_ROOT },
    );
    expect(summary.status).toBe("blocked");
    expect(summary.diagnostics).toContainEqual(
      expect.objectContaining({
        class: "unsupported_candidate",
        provenance: expect.objectContaining({ path: ".agentera/PROGRESS.md" }),
      }),
    );

    const custom = inventory(root, { artifact: "progress", number: 2, path: "CUSTOM.yaml" });
    expect(custom.entries).toContainEqual(
      expect.objectContaining({ classification: "duplicate", addressable: true }),
    );
    fs.writeFileSync(
      path.join(root, "CONFLICT.yaml"),
      YAML.stringify({ cycles: [progress(2, "different")] }),
    );
    const conflict = inventory(root, { artifact: "progress", number: 2, path: "CONFLICT.yaml" });
    expect(conflict.entries).toContainEqual(
      expect.objectContaining({
        classification: "conflict",
        addressable: true,
        rejection: "conflicting_identity",
      }),
    );
    expect(fs.existsSync(path.join(root, ".agentera", "archive"))).toBe(false);
  });

  it.each([
    "staged-write",
    "archive-publication",
    "backup-publication",
    "projection-publication",
    "directory-sync",
  ] as const)("replays safely after the %s interruption boundary", (failAfter) => {
    const root = project();
    const source = path.join(root, ".agentera", "PROGRESS.md");
    fs.writeFileSync(
      source,
      [
        "## Cycle 1 · 2026-07-14 09:00 · fix: interrupted migration",
        "",
        "**Phase**: build",
        "**What**: interrupted migration",
        "**Context**: intent: test interruption",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(root, ".agentera", "progress.yaml"),
      YAML.stringify({ cycles: [progress(2)] }),
    );
    const inspected = inventory(root, {
      artifact: "progress",
      number: 1,
      path: ".agentera/PROGRESS.md",
    });
    const interrupted = applyLegacyMigration(
      inspected,
      { artifact: "progress", number: 1, path: ".agentera/PROGRESS.md" },
      { sourceRoot: REPO_ROOT, failAfter },
    );
    expect(interrupted.status).toBe("blocked");
    expect(interrupted.mutationPerformed).toBe(true);
    const retry = applyLegacyMigration(
      inspected,
      { artifact: "progress", number: 1, path: ".agentera/PROGRESS.md" },
      { sourceRoot: REPO_ROOT },
    );
    expect(retry.status).toBe("complete");
    expect(
      YAML.parse(fs.readFileSync(path.join(root, ".agentera", "progress.yaml"), "utf8")).cycles[0],
    ).toEqual(progress(2));
    expect(
      YAML.parse(fs.readFileSync(path.join(root, ".agentera", "progress.yaml"), "utf8")).cycles[1],
    ).toMatchObject({ number: 1 });
  });

  it("refuses changed source bytes and immutable backup conflicts before projection mutation", () => {
    const root = project();
    const source = path.join(root, "CUSTOM.yaml");
    fs.writeFileSync(source, YAML.stringify({ cycles: [progress(1)] }));
    const args = { artifact: "progress", number: 1, path: "CUSTOM.yaml" } as const;
    const inspected = inventory(root, args);
    fs.writeFileSync(source, YAML.stringify({ cycles: [progress(1, "changed")] }));
    const changed = applyLegacyMigration(inspected, args, { sourceRoot: REPO_ROOT });
    expect(changed.diagnostics[0]).toMatchObject({ class: "changed_candidate" });
    expect(changed.diagnostics[0].provenance).toMatchObject({
      path: "CUSTOM.yaml",
      artifact_id: "progress",
      entry_number: 1,
    });
    expect(fs.existsSync(path.join(root, ".agentera", "archive"))).toBe(false);

    fs.writeFileSync(source, YAML.stringify({ cycles: [progress(1)] }));
    const replayInspection = inventory(root, args);
    const operation = replayInspection.operations[0] as { backup: string };
    fs.mkdirSync(path.dirname(path.join(root, operation.backup)), { recursive: true });
    fs.writeFileSync(path.join(root, operation.backup), "different bytes\n");
    const conflict = applyLegacyMigration(replayInspection, args, { sourceRoot: REPO_ROOT });
    expect(conflict.diagnostics[0]).toMatchObject({ class: "backup_conflict" });
    expect(conflict.diagnostics[0].provenance).toMatchObject({
      path: "CUSTOM.yaml",
      artifact_id: "progress",
      entry_number: 1,
    });
    expect(fs.existsSync(path.join(root, ".agentera", "archive"))).toBe(false);
  });

  it("refuses an immutable archive target conflict with precise provenance", () => {
    const root = project();
    const source = path.join(root, "CUSTOM.yaml");
    const args = { artifact: "progress", number: 1, path: "CUSTOM.yaml" } as const;
    fs.writeFileSync(source, YAML.stringify({ cycles: [progress(1)] }));
    fs.mkdirSync(path.join(root, ".agentera", "archive", "progress"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agentera", "archive", "progress", "1.yaml"),
      YAML.stringify({ record: progress(1, "different immutable content") }),
    );
    const result = applyLegacyMigration(inventory(root, args), args, { sourceRoot: REPO_ROOT });
    expect(result.diagnostics[0]).toMatchObject({
      class: "immutable_conflict",
      provenance: expect.objectContaining({
        path: "CUSTOM.yaml",
        artifact_id: "progress",
        entry_number: 1,
      }),
    });
    expect(fs.existsSync(path.join(root, ".agentera", "migration-backups"))).toBe(false);
  });

  it("routes CLI preview and explicit apply through the same bounded local contract", () => {
    const root = project();
    fs.writeFileSync(path.join(root, "CUSTOM.yaml"), YAML.stringify({ cycles: [progress(1)] }));
    const common = [
      "--project",
      root,
      "--artifact",
      "progress",
      "--number",
      "1",
      "--path",
      "CUSTOM.yaml",
    ];
    const preview = captureMigration([...common, "--dry-run", "--format", "json"]);
    expect(preview.rc).toBe(1);
    expect(JSON.parse(preview.out)).toMatchObject({
      mode: "preview",
      read_only: true,
      mutation_performed: false,
      remote_contact: false,
    });
    expect(fs.existsSync(path.join(root, ".agentera", "archive"))).toBe(false);
    const applied = captureMigration([...common, "--apply", "--force", "--format", "json"]);
    expect(applied.rc).toBe(1);
    expect(JSON.parse(applied.out)).toMatchObject({
      mode: "apply",
      read_only: false,
      mutation_performed: true,
      status: "complete",
    });
  });

  it("keeps local migration Git-free and hands exact selectors to optional enrichment", () => {
    const root = project();
    fs.writeFileSync(path.join(root, "CUSTOM.yaml"), YAML.stringify({ cycles: [progress(12)] }));
    const spawnSpy = vi.spyOn(childProcess, "spawnSync");
    try {
      const result = captureMigration([
        "--project",
        root,
        "--artifact",
        "progress",
        "--number",
        "12",
        "--path",
        "CUSTOM.yaml",
        "--dry-run",
        "--format",
        "json",
      ]);
      expect(result.rc).toBe(1);
      expect(spawnSpy).not.toHaveBeenCalled();
      const response = JSON.parse(result.out) as Record<string, any>;
      expect(response).toMatchObject({
        mode: "preview",
        mutation_performed: false,
        remote_contact: false,
        source_contract: {
          optional_git_enrichment: {
            requested: false,
            selection: "separate_explicit_operator_invocation",
            remote_contact: false,
          },
        },
      });
      expect(response.operations[0]).toMatchObject({
        artifact_id: "progress",
        entry_number: 12,
        follow_up: {
          kind: "optional_git_enrichment",
          requested: false,
          stable_id: "progress:12",
           selectors: { project: root, artifact: "progress", number: 12 },
           dry_run: `agentera state backfill --project '${root}' --artifact progress --number 12 --dry-run --format json`,
           apply: `agentera state backfill --project '${root}' --artifact progress --number 12 --apply --force --format json`,
          remote_contact: false,
        },
      });
      expect(fs.existsSync(path.join(root, ".agentera", "archive"))).toBe(false);
      const applied = captureMigration([
        "--project",
        root,
        "--artifact",
        "progress",
        "--number",
        "12",
        "--path",
        "CUSTOM.yaml",
        "--apply",
        "--force",
        "--format",
        "json",
      ]);
      expect(applied.rc).toBe(1);
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(JSON.parse(applied.out)).toMatchObject({
        mode: "apply",
        status: "complete",
        mutation_performed: true,
        remote_contact: false,
      });
      expect(fs.existsSync(path.join(root, ".agentera", "archive", "progress", "12.yaml"))).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it("refuses a deterministic projection target failure before creating immutable evidence", () => {
    const root = project();
    fs.writeFileSync(path.join(root, "CUSTOM.yaml"), YAML.stringify({ cycles: [progress(1)] }));
    fs.mkdirSync(path.join(root, ".agentera", "progress.yaml"));
    const args = { artifact: "progress", number: 1, path: "CUSTOM.yaml" } as const;
    const result = applyLegacyMigration(inventory(root, args), args, { sourceRoot: REPO_ROOT });
    expect(result.diagnostics[0]).toMatchObject({ class: "projection_failure" });
    expect(fs.existsSync(path.join(root, ".agentera", "archive"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera", "migration-backups"))).toBe(false);
  });

  it("never lets selectors erase multiple explicit Markdown or YAML identities", () => {
    const root = project();
    const markdown = [
      "## Cycle 1 · 2026-07-14 09:00 · fix: cycle identity",
      "",
      "**Phase**: build",
      "**What**: cycle identity",
      "**Context**: intent: preserve ambiguity",
      "",
      "## Decision 2 · 2026-07-14",
      "",
      "**Question**: Which identity is selected?",
      "**Context**: Both identities are explicit.",
      "**Alternatives**:",
      "- [Keep Cycle], chosen: preserve both",
      "- [Keep Decision], rejected: erase one",
      "**Choice**: Keep Cycle",
      "**Reasoning**: A selector cannot change source identity.",
      "**Confidence**: firm",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(root, "MIXED.md"), markdown);
    fs.writeFileSync(
      path.join(root, "MIXED.yaml"),
      YAML.stringify({ cycles: [progress(1)], decisions: [{ ...progress(2), date: "2026-07-14", question: "q", context: "c", alternatives: [{ name: "a", status: "chosen" }], choice: "a", reasoning: "r", confidence: "firm" }] }),
    );

    for (const pathName of ["MIXED.md", "MIXED.yaml"]) {
      for (const artifact of ["progress", "decisions", "health"] as const) {
        for (const entryNumber of [1, 2]) {
          const args = { artifact, number: entryNumber, path: pathName } as const;
          const inspected = inventory(root, args);
          expect(inspected.entries).toContainEqual(
            expect.objectContaining({
              path: pathName,
              classification: "ambiguous",
              rejection: pathName.endsWith(".yaml")
                ? "multiple_artifact_identities"
                : "multiple_explicit_identities",
              addressable: false,
              provenance: expect.objectContaining({ failure_class: "ambiguous_candidate" }),
            }),
          );
          const applied = applyLegacyMigration(inspected, args, { sourceRoot: REPO_ROOT });
          expect(applied.diagnostics[0]).toMatchObject({
            class: "ambiguous_candidate",
            provenance: expect.objectContaining({ path: pathName }),
          });
          expect(fs.existsSync(path.join(root, ".agentera", "archive"))).toBe(false);
        }
      }
    }
  });

  it("preserves shorthand-collision, corrupt, unsupported, and boundary refusal classes", () => {
    const root = project();
    fs.writeFileSync(path.join(root, "SHORTHAND.md"), "## Archived Decisions\n- D1 + D2\n");
    fs.writeFileSync(path.join(root, "MALFORMED.md"), "## Cycle 1 · 2026-07-14 09:00 · fix: malformed\n\n**Phase**: build\n");
    fs.writeFileSync(path.join(root, "CORRUPT.yaml"), "cycles: [\n");
    fs.writeFileSync(path.join(root, "UNSUPPORTED.yaml"), "notes: true\n");
    const outside = path.join(os.tmpdir(), `agentera-legacy-boundary-${process.pid}.yaml`);
    fs.writeFileSync(outside, "notes: true\n");
    roots.push(outside);
    fs.symlinkSync(outside, path.join(root, "ESCAPE.yaml"));

    const shorthand = inventory(root, { artifact: "decisions", number: 1, path: "SHORTHAND.md" });
    expect(shorthand.entries).toContainEqual(
      expect.objectContaining({
        classification: "ambiguous",
        rejection: "shorthand_collision",
        provenance: expect.objectContaining({ failure_class: "ambiguous_candidate" }),
      }),
    );
    expect(
      applyLegacyMigration(
        shorthand,
        { artifact: "decisions", number: 1, path: "SHORTHAND.md" },
        { sourceRoot: REPO_ROOT },
      ).diagnostics[0],
    ).toMatchObject({ class: "ambiguous_candidate" });
    const malformed = inventory(root, { artifact: "progress", number: 1, path: "MALFORMED.md" });
    expect(malformed.entries).toContainEqual(
      expect.objectContaining({
        rejection: "corrupt_record",
        provenance: expect.objectContaining({ failure_class: "corrupt_candidate" }),
      }),
    );
    expect(
      applyLegacyMigration(
        malformed,
        { artifact: "progress", number: 1, path: "MALFORMED.md" },
        { sourceRoot: REPO_ROOT },
      ).diagnostics[0],
    ).toMatchObject({ class: "corrupt_candidate" });
    const corrupt = inventory(root, { artifact: "progress", number: 1, path: "CORRUPT.yaml" });
    expect(corrupt.entries).toContainEqual(
      expect.objectContaining({
        classification: "corrupt",
        rejection: "invalid_yaml",
        provenance: expect.objectContaining({ failure_class: "corrupt_candidate" }),
      }),
    );
    expect(
      applyLegacyMigration(
        corrupt,
        { artifact: "progress", number: 1, path: "CORRUPT.yaml" },
        { sourceRoot: REPO_ROOT },
      ).diagnostics[0],
    ).toMatchObject({ class: "corrupt_candidate" });
    const unsupported = inventory(root, { artifact: "progress", number: 1, path: "UNSUPPORTED.yaml" });
    expect(unsupported.entries).toContainEqual(
      expect.objectContaining({
        classification: "unsupported",
        rejection: "unsupported_artifact_shape",
        provenance: expect.objectContaining({ failure_class: "unsupported_candidate" }),
      }),
    );
    expect(
      applyLegacyMigration(
        unsupported,
        { artifact: "progress", number: 1, path: "UNSUPPORTED.yaml" },
        { sourceRoot: REPO_ROOT },
      ).diagnostics[0],
    ).toMatchObject({ class: "unsupported_candidate" });
    expect(inventory(root).entries).toContainEqual(
      expect.objectContaining({
        path: "ESCAPE.yaml",
        classification: "project_boundary",
        rejection: "symlink_escape",
        provenance: expect.objectContaining({ failure_class: "project_boundary" }),
      }),
    );
    const boundary = inventory(root, { artifact: "progress", number: 1, path: "ESCAPE.yaml" });
    expect(
      applyLegacyMigration(
        boundary,
        { artifact: "progress", number: 1, path: "ESCAPE.yaml" },
        { sourceRoot: REPO_ROOT },
      ).diagnostics[0],
    ).toMatchObject({ class: "project_boundary" });
  });
});

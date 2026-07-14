import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import {
  deferredResponse,
  inventoryCandidates,
  parseMigrateArgs,
  projectedEntries,
  renderText,
  resultCounts,
  runMigrate,
  validateMigrateArgs,
  type MigrateArgs,
} from "../../src/cli/commands/migrate.js";
import { main } from "../../src/cli/dispatch.js";
import { migrationModeFlags, stateMigrationContract } from "../../src/state/migrationAuthority.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUTHORITY_RELATIVE_PATH = "references/artifacts/state-storage-authority.yaml";
const BUNDLE_AUTHORITY_PATH = path.join("packages", "cli", "bundle", AUTHORITY_RELATIVE_PATH);
const temporaryRoots: string[] = [];

function loadAuthority(filePath: string): Record<string, any> {
  return YAML.parse(fs.readFileSync(filePath, "utf8")) as Record<string, any>;
}

function capture(
  fn: (io: { out: (text: string) => void; err: (text: string) => void }) => number,
): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  const rc = fn({ out: (text) => (out += text), err: (text) => (err += text) });
  return { rc, out, err };
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-migration-authority-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("local migration authority", () => {
  it("publishes the confirmed namespace and bounded custom-name inventory contract", () => {
    const authority = loadAuthority(path.join(REPO_ROOT, AUTHORITY_RELATIVE_PATH));
    const migration = authority.api.migrate;

    expect(migration.namespace).toBe("agentera state migrate");
    expect(migration.formats).toEqual(["text", "json", "yaml"]);
    expect(migration.default_limit).toBe(20);
    expect(migration.maximum_limit).toBe(100);
    expect(migration.supported_artifacts).toEqual(["progress", "decisions", "health"]);
    expect(migration.selectors).toMatchObject({
      artifact: { flag: "--artifact ARTIFACT", required_for_apply: true },
      number: { flag: "--number N", pattern: "^[1-9][0-9]*$" },
      path: { flag: "--path PATH", relative_to: "selected_project_root" },
      limit: { minimum: 1, maximum: 100 },
    });
    expect(migration.modes).toMatchObject({
      inventory: { read_only: true },
      preview: { selector: "--dry-run", read_only: true },
      apply: { selector: "--apply --force", mutation_intent: "explicit_apply_and_force" },
    });
    expect(migration.modes.invalid_combinations).toEqual([
      expect.objectContaining({ flags: ["--apply", "--dry-run"], failure_class: "invalid_selector" }),
      expect.objectContaining({ flags: ["--apply"], requires: "--force" }),
      expect.objectContaining({ flags: ["--force"], requires: "--apply" }),
    ]);
    expect(migration.inventory.bounded_scan).toMatchObject({
      maximum_candidate_files: 256,
      maximum_file_bytes: 1048576,
      maximum_total_bytes: 16777216,
      ordering: "normalized_relative_path_ascending",
    });
    expect(migration.inventory.custom_name_rule).toContain("--path pins it");
    expect(migration.inventory.custom_name_rule).toContain("exactly one supported stable identity");
    expect(migration.project_boundary.reject).toEqual(
      expect.arrayContaining([
        "traversal",
        "encoded_traversal",
        "symlink_escape",
        "outside_project",
      ]),
    );
  });

  it("schema-backs compatibility, backup, retry, and Git-independent publication guarantees", () => {
    const migration = loadAuthority(path.join(REPO_ROOT, AUTHORITY_RELATIVE_PATH)).api.migrate;

    expect(migration.compatibility_window).toMatchObject({
      name: "v2_to_v3_local_state",
      classifications: ["complete", "degraded", "blocked", "unsupported"],
      cases: {
        legacy_full: { classification: "degraded" },
        legacy_summary: { classification: "degraded" },
        non_git: { classification: "complete" },
        ambiguous: { classification: "blocked" },
        corrupt: { classification: "blocked" },
      },
    });
    expect(migration.compatibility_window.no_reconstruction).toContain("Decision 53");
    expect(migration.backups).toMatchObject({
      required_for_apply: true,
      project_local: true,
      root: ".agentera/migration-backups",
      publication: "exclusive_immutable_file",
      cleanup: "forbidden",
    });
    expect(migration.publication).toMatchObject({
      order: [
        "validate_candidate_and_selector",
        "publish_immutable_archive_record",
        "publish_immutable_backup",
        "publish_current_projection",
      ],
      archive_before_projection: true,
      monotonic_states: [
        "inventory",
        "previewed",
        "archive_published",
        "backup_published",
        "projection_published",
      ],
    });
    expect(migration.publication.retry).toContain("idempotent replay");
    expect(migration.git).toMatchObject({
      required: false,
      reads: "forbidden",
      remote_contact: "forbidden",
      completion_independent: true,
    });
    expect(migration.guarantees).toMatchObject({
      read_only_inventory_and_preview: true,
      apply_requires_force: true,
      archive_before_projection: true,
      backups_before_projection: true,
      monotonic_retry: true,
      archive_immutability: true,
      project_local: true,
      remote_contact: "forbidden",
      git_independent: true,
    });
    expect(migration.failures.classes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          class: "project_boundary",
          example: expect.stringContaining("../"),
        }),
        expect.objectContaining({ class: "ambiguous_candidate" }),
        expect.objectContaining({ class: "unsupported_candidate" }),
        expect.objectContaining({ class: "backup_conflict" }),
        expect.objectContaining({ class: "immutable_conflict" }),
        expect.objectContaining({ class: "changed_candidate" }),
        expect.objectContaining({ class: "scan_bounded" }),
      ]),
    );
  });

  it("loads parser values from the authority without a second value registry", () => {
    const contract = stateMigrationContract(REPO_ROOT);
    expect(contract.command).toContain("agentera state migrate");
    expect(contract.formats).toEqual(["text", "json", "yaml"]);
    expect(contract.supportedArtifacts).toEqual(["progress", "decisions", "health"]);

    const brokenRoot = project();
    const authorityPath = path.join(brokenRoot, AUTHORITY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(authorityPath), { recursive: true });
    const authority = loadAuthority(path.join(REPO_ROOT, AUTHORITY_RELATIVE_PATH));
    authority.api.migrate.formats = ["yaml", "json"];
    authority.api.migrate.default_limit = 2;
    authority.api.migrate.maximum_limit = 3;
    authority.api.migrate.selectors.artifact.flag = "--kind ARTIFACT";
    authority.api.migrate.selectors.format.flag = "--output FORMAT";
    authority.api.migrate.selectors.format.valid_values = ["yaml", "json"];
    authority.api.migrate.modes.apply.selectors_required = ["--kind", "--number"];
    authority.api.migrate.selectors.path.pattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\.txt$";
    authority.api.migrate.selectors.limit.maximum = 3;
    authority.api.migrate.command = authority.api.migrate.command
      .replace("{text,json,yaml}", "{yaml,json}")
      .replace("--artifact ARTIFACT", "--kind ARTIFACT")
      .replace("--format", "--output");
    fs.writeFileSync(authorityPath, YAML.stringify(authority));
    const mutated = stateMigrationContract(brokenRoot);
    expect(mutated.formats).toEqual(["yaml", "json"]);
    expect(parseMigrateArgs([], mutated)).toMatchObject({ format: "yaml", limit: 2 });
    const schemaDriven = parseMigrateArgs(
      ["--kind", "progress", "--output", "yaml", "--path", "custom.txt", "--limit", "3"],
      mutated,
    );
    expect(schemaDriven).not.toHaveProperty("error");
    expect(validateMigrateArgs(schemaDriven as any, mutated)).toBeNull();
    expect(parseMigrateArgs(["--output", "text"], mutated)).toMatchObject({
      error: expect.stringContaining("invalid choice"),
    });
  });

  it("parses the default, preview, and explicit mutation modes without executing migration", () => {
    const contract = stateMigrationContract(REPO_ROOT);
    const inventory = parseMigrateArgs([], contract);
    expect(inventory).toMatchObject({
      dryRun: false,
      apply: false,
      force: false,
      format: contract.formats[0],
      limit: contract.defaultLimit,
    });
    const preview = parseMigrateArgs(
      ["--artifact", "progress", "--number", "1", "--dry-run", "--format", "yaml"],
      contract,
    );
    expect(preview).not.toHaveProperty("error");
    expect(validateMigrateArgs(preview as any, contract)).toBeNull();
    const apply = parseMigrateArgs(
      ["--artifact", "progress", "--number", "1", "--apply", "--force", "--format", "json"],
      contract,
    );
    expect(apply).not.toHaveProperty("error");
    expect(validateMigrateArgs(apply as any, contract)).toBeNull();
    expect(
      validateMigrateArgs({ ...(apply as any), apply: true, force: false }, contract),
    ).toContain("--force");
    expect(
      validateMigrateArgs(
        { ...(preview as any), apply: true, dryRun: true, force: true },
        contract,
      ),
    ).toContain("mutually exclusive");
    expect(
      validateMigrateArgs({ ...(preview as any), path: "../outside.yaml" }, contract),
    ).toContain("project boundary");
    expect(
      validateMigrateArgs({ ...(preview as any), path: ".agentera/state.txt" }, contract),
    ).toContain("unsupported");
    expect(validateMigrateArgs({ ...(preview as any), limit: 101 }, contract)).toContain(
      "between 1 and 100",
    );
  });

  it("keeps source-owned parser rules and deterministic bounded omission metadata visible", () => {
    const authoritySource = fs.readFileSync(path.join(REPO_ROOT, AUTHORITY_RELATIVE_PATH), "utf8");
    const authorityRuntime = fs.readFileSync(
      path.join(REPO_ROOT, "packages/cli/src/state/migrationAuthority.ts"),
      "utf8",
    );
    const parserSource = fs.readFileSync(
      path.join(REPO_ROOT, "packages/cli/src/cli/commands/migrate.ts"),
      "utf8",
    );
    expect(authoritySource).toContain("single_source_rule:");
    expect(authorityRuntime).not.toMatch(/EXPECTED_(AUTHORITY_SCHEMA|ARTIFACTS|FORMATS)/);
    expect(authorityRuntime).not.toMatch(/namespace\s*!==/);
    expect(authorityRuntime).not.toMatch(/formats\.join/);
    expect(authorityRuntime).not.toMatch(/migrationArtifacts\.join/);
    expect(parserSource).not.toContain("MIGRATE_SYNTAX");
    expect(parserSource).not.toMatch(/value\s*!==\s*[\"'](?:text|json|yaml)/);

    const migration = loadAuthority(path.join(REPO_ROOT, AUTHORITY_RELATIVE_PATH)).api.migrate;
    expect(migration.result.omission.semantics).toContain("omitted=true");
    expect(migration.result.omission.semantics).toContain("bounded retry/list pointer");
    expect(migration.inventory.bounded_scan.ordering).toBe("normalized_relative_path_ascending");
    expect(migration.inventory.bounded_scan.maximum_candidate_files).toBe(256);
    expect(migration.inventory.bounded_scan.maximum_total_bytes).toBe(16777216);
  });

  it("rejects duplicate selector authority and malformed bounded omission metadata", () => {
    const authority = loadAuthority(path.join(REPO_ROOT, AUTHORITY_RELATIVE_PATH));
    const duplicateRoot = project();
    const duplicatePath = path.join(duplicateRoot, AUTHORITY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(duplicatePath), { recursive: true });
    authority.api.migrate.selectors.format.flag = authority.api.migrate.selectors.artifact.flag;
    fs.writeFileSync(duplicatePath, YAML.stringify(authority));
    expect(() => stateMigrationContract(duplicateRoot)).toThrow("must not contain duplicates");

    const malformedRoot = project();
    const malformedPath = path.join(malformedRoot, AUTHORITY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(malformedPath), { recursive: true });
    authority.api.migrate.selectors.format.flag = "--format FORMAT";
    delete authority.api.migrate.result.omission.bounded_reason;
    fs.writeFileSync(malformedPath, YAML.stringify(authority));
    expect(() => stateMigrationContract(malformedRoot)).toThrow("bounded_reason");

    const duplicateCombinationRoot = project();
    const duplicateCombinationPath = path.join(duplicateCombinationRoot, AUTHORITY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(duplicateCombinationPath), { recursive: true });
    const duplicateCombinationAuthority = loadAuthority(path.join(REPO_ROOT, AUTHORITY_RELATIVE_PATH));
    duplicateCombinationAuthority.api.migrate.modes.invalid_combinations.push(
      duplicateCombinationAuthority.api.migrate.modes.invalid_combinations[0],
    );
    fs.writeFileSync(duplicateCombinationPath, YAML.stringify(duplicateCombinationAuthority));
    expect(() => stateMigrationContract(duplicateCombinationRoot)).toThrow(
      "invalid_combinations.*.flags",
    );
  });

  it("consumes changed authority result fields instead of a handwritten envelope registry", () => {
    const authority = loadAuthority(path.join(REPO_ROOT, AUTHORITY_RELATIVE_PATH));
    authority.api.migrate.result.count_fields.push("authority_defined_count");
    authority.api.migrate.result.count_rules.authority_defined_count = {
      source: "visible_entries",
      operation: "count",
      predicates: [],
    };
    authority.api.migrate.result.omission.complete_reason = "authority_complete";
    authority.api.migrate.result.omission.bounded_reason = "authority_bounded";
    authority.api.migrate.result.omission.retry = "authority retry guidance";
    authority.api.migrate.result.omission.retrieval = "authority retrieval pointer";
    authority.api.migrate.result.required_fields.push("authority_omission");
    authority.api.migrate.result.omission.fields.push("authority_omission");
    authority.api.migrate.result.omission.field_sources.authority_omission = "omission_reason";
    const root = project();
    const authorityPath = path.join(root, AUTHORITY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(authorityPath), { recursive: true });
    fs.writeFileSync(authorityPath, YAML.stringify(authority));

    const contract = stateMigrationContract(root);
    const response = deferredResponse(
      {
        project: root,
        artifact: null,
        dryRun: false,
        apply: false,
        force: false,
        format: "json",
        limit: contract.defaultLimit,
      },
      contract,
    );
    expect((response.counts as Record<string, unknown>).authority_defined_count).toBe(0);
    expect(response.omission_reason).toBe("authority_complete");
    expect(response.authority_omission).toBe("authority_complete");
    expect(response.retrieval).toEqual({
      command: "authority retrieval pointer",
      retry: "authority retry guidance",
    });
  });

  it("projects normalized bounded results from authority-defined fields", () => {
    const contract = stateMigrationContract(REPO_ROOT);
    const args = {
      project: project(),
      artifact: null,
      dryRun: true,
      apply: false,
      force: false,
      format: "json",
      limit: 2,
    } as const;
    const entries = [
      { path: "z.yaml", candidate_id: "z", addressable: true, classification: "canonical" },
      { path: ".agentera/a.yaml", candidate_id: "a", addressable: false, classification: "unaddressable" },
      { path: "a.yaml", candidate_id: "a2", addressable: true, classification: "canonical" },
    ];
    const projected = projectedEntries(entries, args, contract);
    expect(projected.entries.map((entry) => entry.path)).toEqual([".agentera/a.yaml", "a.yaml"]);
    expect(projected.omittedCount).toBe(1);
    const counts = resultCounts(projected.entries, projected.omittedCount, contract);
    expect(Object.keys(counts)).toEqual(contract.resultCountFields);
    expect(counts).toMatchObject({ physical: 3, addressable: 1, unaddressable: 1, omitted: 1 });

    const response = deferredResponse(args, contract, entries);
    expect(response).toMatchObject({
      omitted: true,
      omitted_count: 1,
      omission_reason: contract.omission.boundedReason,
      mutation_performed: false,
      retrieval: { command: contract.omission.retrieval, retry: contract.omission.retry },
    });
    expect(Object.keys(response.counts as Record<string, unknown>)).toEqual(contract.resultCountFields);
    let text = "";
    renderText(response, (value) => (text += value));
    expect(text).toContain(`omitted_count: ${response.omitted_count}`);
    expect(text).toContain(`omission_reason: ${response.omission_reason}`);
    expect(text).toContain(contract.omission.retry);
    expect(YAML.parse(JSON.stringify(response))).toEqual(YAML.parse(YAML.stringify(response)));
  });

  it("enforces the 256-candidate bound before the output limit", () => {
    const root = project();
    const contract = stateMigrationContract(REPO_ROOT);
    for (let index = 0; index < 257; index += 1) {
      fs.writeFileSync(path.join(root, `candidate-${String(index).padStart(3, "0")}.yaml`), "");
    }

    const inventory = inventoryCandidates(root, contract);
    expect(inventory.entries).toHaveLength(contract.inventory.maximumCandidateFiles);
    expect(inventory.omittedCount).toBe(1);
    expect(inventory.status).toBe("degraded");
    const response = deferredResponse(
      {
        project: root,
        artifact: null,
        dryRun: false,
        apply: false,
        force: false,
        format: "json",
        limit: 100,
      },
      contract,
      inventory.entries,
      inventory,
    );
    expect(response.entries.length).toBeLessThanOrEqual(100);
    expect(response.omitted_count).toBeGreaterThanOrEqual(157);
    expect(response.counts).toMatchObject({ physical: 257, omitted: response.omitted_count });
    const verboseEntries = inventory.entries.map((entry) => ({
      ...entry,
      source: "x".repeat(400),
      provenance: { reason: "x".repeat(400) },
    }));
    for (const format of ["json", "yaml", "text"] as const) {
      const bounded = deferredResponse(
        {
          project: root,
          artifact: null,
          dryRun: false,
          apply: false,
          force: false,
          format,
          limit: 100,
        },
        contract,
        verboseEntries,
        inventory,
      );
      const serialized =
        format === "json"
          ? JSON.stringify(bounded, null, 2) + "\n"
          : format === "yaml"
            ? YAML.stringify(bounded, { sortMapEntries: false })
            : (() => {
                let output = "";
                renderText(bounded, (value) => (output += value));
                return output;
              })();
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(contract.outputMaxUtf8Bytes);
      expect(bounded).toMatchObject({
        omitted: true,
        omission_reason: contract.omission.outputBoundedReason,
        retrieval: { retry: expect.stringContaining("--limit") },
      });
      if (format === "json") expect(() => JSON.parse(serialized)).not.toThrow();
      if (format === "yaml") expect(() => YAML.parse(serialized)).not.toThrow();
    }
  });

  it("omits a single file over the authority file-byte bound without reading or writing it", () => {
    const root = project();
    const contract = stateMigrationContract(REPO_ROOT);
    const before = fs.readdirSync(root);
    fs.writeFileSync(
      path.join(root, "oversized.yaml"),
      Buffer.alloc(contract.inventory.maximumFileBytes + 1),
    );
    const inventory = inventoryCandidates(root, contract);
    expect(inventory.entries).toEqual([]);
    expect(inventory.omittedCount).toBe(1);
    expect(inventory.status).toBe("degraded");
    expect(fs.readdirSync(root)).toEqual([...before, "oversized.yaml"]);
  });

  it("stops deterministic inventory at the authority total-byte bound", () => {
    const root = project();
    const contract = stateMigrationContract(REPO_ROOT);
    const megabyte = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < 17; index += 1) {
      fs.writeFileSync(path.join(root, `total-${String(index).padStart(2, "0")}.yaml`), megabyte);
    }
    const inventory = inventoryCandidates(root, contract);
    expect(inventory.entries).toHaveLength(16);
    expect(inventory.omittedCount).toBe(1);
    expect(inventory.entries.map((entry) => entry.path)).toEqual(
      inventory.entries.map((entry) => entry.path).sort(),
    );
    expect(inventory.entries.at(-1)?.path).toBe("total-15.yaml");
  });

  it("rejects symlink escapes, boundary paths, and preserves custom names in normalized order", () => {
    const root = project();
    const outside = project();
    const contract = stateMigrationContract(REPO_ROOT);
    fs.mkdirSync(path.join(root, ".agentera"));
    fs.writeFileSync(path.join(root, "z-custom.yaml"), "");
    fs.writeFileSync(path.join(root, "a-custom.yaml"), "");
    fs.writeFileSync(path.join(root, ".agentera", "PROGRESS.md"), "");
    fs.writeFileSync(path.join(outside, "outside.yaml"), "");
    fs.symlinkSync(path.join(outside, "outside.yaml"), path.join(root, "escape.yaml"));

    const inventory = inventoryCandidates(root, contract);
    expect(inventory.entries.map((entry) => entry.path)).toEqual([
      ".agentera/PROGRESS.md",
      "a-custom.yaml",
      "escape.yaml",
      "z-custom.yaml",
    ]);
    expect(inventory.entries.find((entry) => entry.path === "escape.yaml")).toMatchObject({
      classification: "project_boundary",
      rejection: "symlink_escape",
      addressable: false,
    });
    expect(validateMigrateArgs(
      {
        project: root,
        artifact: null,
        number: undefined,
        path: "../outside.yaml",
        limit: 1,
        dryRun: true,
        apply: false,
        force: false,
        format: "json",
      },
      contract,
    )).toContain("project boundary");

    const symlinkRoot = project();
    const outsideRoot = project();
    fs.symlinkSync(outsideRoot, path.join(symlinkRoot, ".agentera"));
    expect(() => inventoryCandidates(symlinkRoot, contract)).toThrow(
      "symlink roots are forbidden",
    );
  });

  it("keeps limit boundaries and omission recovery equivalent across text, JSON, and YAML", () => {
    const root = project();
    const contract = stateMigrationContract(REPO_ROOT);
    fs.writeFileSync(path.join(root, "a.yaml"), "");
    fs.writeFileSync(path.join(root, "b.yaml"), "");
    expect((parseMigrateArgs(["--limit", "1"], contract) as MigrateArgs).limit).toBe(1);
    expect((parseMigrateArgs(["--limit", "100"], contract) as MigrateArgs).limit).toBe(100);
    expect(validateMigrateArgs({
      ...(parseMigrateArgs(["--limit", "1"], contract) as MigrateArgs),
      limit: 0,
    }, contract)).toContain("between 1 and 100");
    expect(validateMigrateArgs({
      ...(parseMigrateArgs(["--limit", "1"], contract) as MigrateArgs),
      limit: 101,
    }, contract)).toContain("between 1 and 100");

    const args = ["--project", root, "--limit", "1"];
    const json = capture((io) => runMigrate([...args, "--format", "json"], io, REPO_ROOT));
    const yaml = capture((io) => runMigrate([...args, "--format", "yaml"], io, REPO_ROOT));
    const text = capture((io) => runMigrate([...args, "--format", "text"], io, REPO_ROOT));
    const jsonValue = JSON.parse(json.out) as Record<string, any>;
    const yamlValue = YAML.parse(yaml.out) as Record<string, any>;
    expect(jsonValue).toEqual(yamlValue);
    expect(jsonValue).toMatchObject({
      inventory_performed: true,
      omitted: true,
      omitted_count: 1,
      omission_reason: contract.omission.boundedReason,
      retrieval: { command: contract.omission.retrieval, retry: contract.omission.retry },
    });
    expect(text.out).toContain("omitted: true");
    expect(text.out).toContain("omitted_count: 1");
    expect(text.out).toContain(contract.omission.boundedReason);
    expect(text.out).toContain(contract.omission.retry);
  });

  it("exposes help/schema/dispatch and leaves valid invocations filesystem-free", () => {
    const root = project();
    const help = capture((io) => main(["node", "agentera", "state", "migrate", "--help"], io));
    expect(help.rc).toBe(0);
    expect(help.out).toContain("agentera state migrate");
    expect(help.out).toContain("--apply --force");
    expect(help.out).toContain("project-local");

    const schema = buildSchemaPayload("schema");
    const migrationContract = stateMigrationContract(REPO_ROOT);
    expect(schema.state_migration).toMatchObject({
      authority: AUTHORITY_RELATIVE_PATH,
      namespace: "agentera state migrate",
      formats: ["text", "json", "yaml"],
      guarantees: expect.objectContaining({ git_independent: true }),
    });
    expect(schema.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "migrate",
          kind: "state_migration",
          filters: [
            ...Object.keys(migrationContract.selectors),
            ...new Set(
              [...migrationModeFlags(migrationContract, "preview"), ...migrationModeFlags(migrationContract, "apply")].map(
                (flag) => flag.replace(/^--/, "").replaceAll("-", "_"),
              ),
            ),
          ],
          structured_fields: migrationContract.resultRequiredFields,
        }),
      ]),
    );

    const inventory = capture((io) =>
      runMigrate(["--project", root, "--format", "json"], io, REPO_ROOT),
    );
    expect(inventory.rc).toBe(1);
    expect(JSON.parse(inventory.out)).toMatchObject({
      schemaVersion: "agentera.stateMigrationResult.v1",
      status: "complete",
      mode: "inventory",
      read_only: true,
      mutation_intent: false,
      mutation_performed: false,
      remote_contact: false,
      inventory_performed: true,
    });
    expect(fs.existsSync(path.join(root, ".agentera", "migration-backups"))).toBe(false);

    fs.mkdirSync(path.join(root, ".agentera", "archive"), { recursive: true });
    fs.writeFileSync(path.join(root, "target.yaml"), "target: true\n");
    fs.symlinkSync(path.join(root, "target.yaml"), path.join(root, "link.yaml"));
    const symlink = capture((io) =>
      runMigrate(["--project", root, "--path", "link.yaml", "--format", "json"], io, REPO_ROOT),
    );
    expect(symlink.rc).toBe(2);
    expect(JSON.parse(symlink.out).error.message).toContain("symlink");
    const excluded = capture((io) =>
      runMigrate(
        ["--project", root, "--path", ".agentera/archive/legacy.yaml", "--format", "json"],
        io,
        REPO_ROOT,
      ),
    );
    expect(excluded.rc).toBe(2);
    expect(JSON.parse(excluded.out).error.message).toContain("excluded");

    const apply = capture((io) =>
      runMigrate(
        [
          "--project",
          root,
          "--artifact",
          "progress",
          "--number",
          "1",
          "--apply",
          "--force",
          "--format",
          "json",
        ],
        io,
        REPO_ROOT,
      ),
    );
    expect(apply.rc).toBe(1);
    expect(JSON.parse(apply.out)).toMatchObject({
      mutation_intent: true,
      mutation_performed: false,
      read_only: false,
    });
    expect(fs.existsSync(path.join(root, ".agentera", "migration-backups"))).toBe(false);

    const invalid = capture((io) =>
      main(["node", "agentera", "state", "migrate", "--apply", "--format", "json"], io),
    );
    expect(invalid.rc).toBe(2);
    expect(JSON.parse(invalid.out).error.message).toContain("--force");
  });

  it("keeps invalid envelopes equivalent across JSON and YAML and gives text repair guidance", () => {
    const args = ["--artifact", "progress", "--apply"];
    const json = capture((io) => runMigrate([...args, "--format", "json"], io, REPO_ROOT));
    const yaml = capture((io) => runMigrate([...args, "--format", "yaml"], io, REPO_ROOT));
    const text = capture((io) => runMigrate([...args, "--format", "text"], io, REPO_ROOT));

    expect(json.rc).toBe(2);
    expect(yaml.rc).toBe(2);
    expect(JSON.parse(json.out)).toEqual(YAML.parse(yaml.out));
    expect(YAML.parse(yaml.out)).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      status: "fail",
      error: {
        syntax: expect.stringContaining("agentera state migrate"),
        example: expect.stringContaining("agentera state migrate"),
        recovery: expect.stringContaining("no state was changed"),
      },
    });
    expect(text.rc).toBe(2);
    expect(text.out).toBe("");
    expect(text.err).toContain("Syntax: agentera state migrate");
    expect(text.err).toContain("Example:");
    expect(text.err).toContain("--force");
  });

  it("keeps the bundled authority byte-equivalent to the source authority", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, AUTHORITY_RELATIVE_PATH), "utf8");
    const bundle = fs.readFileSync(path.join(REPO_ROOT, BUNDLE_AUTHORITY_PATH), "utf8");
    expect(YAML.parse(bundle)).toEqual(YAML.parse(source));
  });
});

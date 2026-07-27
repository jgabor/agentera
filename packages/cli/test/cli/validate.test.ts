import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupFixtureProject, useFixtureProject } from "../helpers/useFixtureProject.js";

import {
  cmdValidate,
  cmdValidateCapability,
  cmdValidateCapabilityContract,
  cmdValidateArtifact,
  cmdValidateState,
  isDelegatedValidateFamily,
} from "../../src/cli/commands/validate.js";
import { main } from "../../src/cli/dispatch.js";

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

function runMalformedVocabularyAuthority(mutate: (authority: Record<string, any>) => void): {
  rc: number;
  out: string;
  err: string;
  implementation: Record<string, string>;
} {
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocabulary-authority-"));
  const previousRoot = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  try {
    fs.mkdirSync(path.join(root, "references", "artifacts"), { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "references", "cli"),
      path.join(root, "references", "cli"),
      "dir",
    );
    fs.symlinkSync(
      path.join(repoRoot, "references", "artifacts", "state-storage-authority.yaml"),
      path.join(root, "references", "artifacts", "state-storage-authority.yaml"),
      "file",
    );
    fs.symlinkSync(path.join(repoRoot, "skills"), path.join(root, "skills"), "dir");
    fs.symlinkSync(path.join(repoRoot, "registry.json"), path.join(root, "registry.json"), "file");
    const authorityPath = path.join(
      root,
      "references",
      "artifacts",
      "glossary-entry-contract.yaml",
    );
    const authority = YAML.parse(
      fs.readFileSync(
        path.join(repoRoot, "references", "artifacts", "glossary-entry-contract.yaml"),
        "utf8",
      ),
    );
    mutate(authority);
    fs.writeFileSync(authorityPath, YAML.stringify(authority));
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = root;
    const result = capture((io) =>
      main(
        ["node", "agentera", "check", "validate", "vocabularyAuthority", "--format", "json"],
        io,
      ),
    );
    const persisted = YAML.parse(fs.readFileSync(authorityPath, "utf8"));
    return { ...result, implementation: persisted.consumer_boundary.implementation };
  } finally {
    if (previousRoot === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
    else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("cli validate (delegated families)", () => {
  it("recognizes the delegated families", () => {
    expect(isDelegatedValidateFamily("cross-capability")).toBe(true);
    expect(isDelegatedValidateFamily("lifecycle-adapters")).toBe(false);
    expect(isDelegatedValidateFamily("app-home-contract")).toBe(true);
    expect(isDelegatedValidateFamily("vocabularyAuthority")).toBe(true);
    expect(isDelegatedValidateFamily("selfAudit")).toBe(true);
    expect(isDelegatedValidateFamily("capability")).toBe(false);
  });

  it("validates the cross-capability graph against the repo (text)", () => {
    const { rc, out } = capture((io) => cmdValidate("cross-capability", {}, io));
    expect(rc).toBe(0);
    expect(out.trim()).toBe("cross-capability artifact graph ok");
  });

  it("emits a structured envelope for cross-capability (json)", () => {
    const { rc, out } = capture((io) => cmdValidate("cross-capability", { format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("validate");
    expect(payload.status).toBe("pass");
    expect(payload.target_family).toBe("cross-capability");
    expect(payload.engine.command).toBe("validate_cross_capability.py");
    expect(payload.engine.stdout).toContain("cross-capability artifact graph ok");
  });

  it("validates the app-home contract against the repo", () => {
    const { rc, out } = capture((io) => cmdValidate("app-home-contract", {}, io));
    expect(rc).toBe(0);
    expect(out.trim()).toBe("OK: app-home contract terminology is release-ready");
  });

  it("validates vocabulary authority against the repo", () => {
    const { rc, out } = capture((io) => cmdValidate("vocabularyAuthority", {}, io));
    expect(rc).toBe(0);
    expect(out.trim()).toBe("vocabulary authority ok");
  });

  it("fails the documented vocabularyAuthority command on an overlapping consumer matrix", () => {
    const { rc, out } = runMalformedVocabularyAuthority((authority) => {
      authority.consumer_boundary.outcome_matrix.no_applicable_entry.match.inferred_candidate.push(
        "present",
      );
    });
    const payload = JSON.parse(out);
    expect(rc).toBe(1);
    expect(payload.status).toBe("fail");
    expect(payload.engine.stdout.join("\n")).toContain(
      "consumer_boundary.primary_selection must be exhaustive and non-overlapping",
    );
    expect(payload.engine.stdout.join("\n")).toContain(
      "correct outcome_matrix[*].match and rerun agentera check validate vocabularyAuthority --format json",
    );
  });

  it.each([
    ["judgment", "equivalent_exact_collision", "host_reviewed"],
    ["selected_owner", "no_applicable_entry", "personal"],
    ["selected_meaning", "equivalent_exact_collision", "personal"],
    ["review", "divergent_exact_collision", "required_when_meaning_sensitive"],
    ["tension", "no_applicable_entry", "inferred_equivalence"],
  ])("fails the documented command on contradictory %s semantics", (field, outcomeName, value) => {
    const { rc, out, implementation } = runMalformedVocabularyAuthority((authority) => {
      authority.consumer_boundary.outcome_matrix[outcomeName][field] = value;
    });
    const payload = JSON.parse(out);
    expect(rc).toBe(1);
    expect(payload.status).toBe("fail");
    expect(payload.engine.stdout.join("\n")).toContain(
      `consumer_boundary.outcome_matrix.${outcomeName}.${field}`,
    );
    expect(payload.engine.stdout.join("\n")).toContain(
      "restore the canonical primary-outcome semantics and rerun agentera check validate vocabularyAuthority --format json",
    );
    expect(implementation).toEqual({
      acquisition: "active",
      advice_resolution: "active",
      capability_integrations: { build: "active", discuss: "declared_deferred", plan: "declared_deferred", prime: "declared_deferred" },
    });
  });

  it.each(["judgment", "selected_owner", "selected_meaning", "review", "tension"])(
    "fails the documented command on missing %s semantics without activating integrations",
    (field) => {
      const { rc, out, implementation } = runMalformedVocabularyAuthority((authority) => {
        delete authority.consumer_boundary.outcome_matrix.equivalent_exact_collision[field];
      });
      const payload = JSON.parse(out);
      expect(rc).toBe(1);
      expect(payload.status).toBe("fail");
      expect(payload.engine.stdout.join("\n")).toContain(
        `consumer_boundary.outcome_matrix.equivalent_exact_collision.${field}`,
      );
      expect(payload.engine.stdout.join("\n")).toContain("(found missing)");
      expect(payload.engine.stdout.join("\n")).toContain(
        "restore the canonical primary-outcome semantics and rerun agentera check validate vocabularyAuthority --format json",
      );
      expect(implementation).toEqual({
        acquisition: "active",
        advice_resolution: "active",
        capability_integrations: { build: "active", discuss: "declared_deferred", plan: "declared_deferred", prime: "declared_deferred" },
      });
    },
  );

  it("validates self-audit conventions against the repo", () => {
    const { rc, out } = capture((io) => cmdValidate("selfAudit", {}, io));
    expect(rc).toBe(0);
    expect(out.trim()).toBe("self-audit conventions ok");
  });

  it("throws for an unsupported family", () => {
    expect(() => cmdValidate("bogus", {}, {})).toThrow();
  });
});

describe("cli dispatch: validate routing", () => {
  it("routes check validate cross-capability", () => {
    const { rc } = capture((io) =>
      main(["node", "agentera", "check", "validate", "cross-capability"], io),
    );
    expect(rc).toBe(0);
  });

  it("emits a deprecation alias for top-level validate", () => {
    const { err } = capture((io) => main(["node", "agentera", "validate", "cross-capability"], io));
    expect(err).toContain(
      "Deprecation: agentera validate is deprecated; use agentera check validate",
    );
  });

  it("requires a family", () => {
    const { rc, out } = capture((io) =>
      main(["node", "agentera", "check", "validate", "--format", "json"], io),
    );
    expect(rc).toBe(2);
    const payload = JSON.parse(out);
    expect(payload.error.valid_values).not.toContain("descriptors");
  });
});

describe("cli validate state", () => {
  it("emits a successful whole-state JSON envelope", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-state-"));
    fixtureRoots.push(root);
    const { rc, out } = capture((io) =>
      main(
        ["node", "agentera", "check", "validate", "state", "--cwd", root, "--format", "json"],
        io,
      ),
    );
    expect(rc).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      command: "check validate state",
      target_family: "state",
      status: "pass",
      valid: true,
      issues: [],
    });
  });

  it("exits nonzero with bounded actionable diagnostics", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-state-"));
    fixtureRoots.push(root);
    const target = path.join(root, ".agentera/entities/unknown/decision/aaaaaaaaaa.yaml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "id: aaaaaaaaaa\nartifact: unknown\nrecord: {}\n");
    const { rc, out } = capture((io) => cmdValidateState({ cwd: root, format: "json" }, io));
    const payload = JSON.parse(out);
    expect(rc).toBe(1);
    expect(payload).toMatchObject({
      command: "check validate state",
      status: "fail",
      valid: false,
    });
    expect(payload.issues[0]).toMatchObject({ code: "invalid_artifact", artifact: "unknown" });
    expect(payload.issues[0].recovery).toContain("valid artifact values:");
    expect(payload.issues[0].recovery).toContain("agentera check validate state --cwd");
  });

  it("retains read-only validation of entity markers backed by historical migration evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-legacy-cutover-"));
    fixtureRoots.push(root);
    const id = "0123456789abcdefabcd";
    const fingerprint = "a".repeat(64);
    const digest = "b".repeat(64);
    const marker = Buffer.from(
      `schemaVersion: agentera.stateMode.v1\nmode: entities\nmigration_id: ${id}\nsource_fingerprint: ${fingerprint}\npreview_digest: ${digest}\n`,
    );
    const target = ".agentera/entities/progress/progress_cycle/aaaaaaaaaa.yaml";
    const entity = Buffer.from(
      "id: aaaaaaaaaa\nartifact: progress\nrecord:\n  timestamp: 2026-07-18 12:00\n  type: fix\n  phase: build\n  what: retained evidence\n  context:\n    intent: validate historical cutover\n",
    );
    const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: "agentera.entityMigrationManifest.v1",
        migration_id: id,
        source_fingerprint: fingerprint,
        preview_digest: digest,
        entries: [
          {
            artifact: "progress",
            source_identity: "progress:1",
            proposed_target: { path: target, id: "aaaaaaaaaa" },
            target_sha256: hash(entity),
          },
        ],
        receipts: { ".agentera/state-mode.yaml": { sha256: hash(marker) } },
      }),
    );
    const operation = path.join(root, ".agentera/migrations/entities", id);
    fs.mkdirSync(operation, { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
    fs.writeFileSync(path.join(root, target), entity);
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), marker);
    fs.writeFileSync(path.join(operation, "manifest.yaml"), manifest);
    fs.writeFileSync(
      path.join(operation, "journal.yaml"),
      JSON.stringify({
        schemaVersion: "agentera.entityMigrationJournal.v1",
        migration_id: id,
        source_fingerprint: fingerprint,
        preview_digest: digest,
        phase: "cutover_complete",
        manifest_sha256: hash(manifest),
      }),
    );

    const { rc, out } = capture((io) => cmdValidateState({ cwd: root, format: "json" }, io));

    expect(JSON.parse(out)).toMatchObject({
      status: "pass",
      valid: true,
      issue_count: 0,
      issues: [],
    });
    expect(rc).toBe(0);
  });
});

describe("cli validate capability (structure; exact output covered by parity harness)", () => {
  it("prints the validation header and contract line (text)", () => {
    const { out } = capture((io) => cmdValidateCapability("status", {}, io));
    expect(out).toContain("Validating capability:");
    expect(out).toContain("Using contract: skills/agentera/capability_schema_contract.yaml");
  });

  it("emits a single-capability JSON envelope with the target", () => {
    const { out } = capture((io) => cmdValidateCapability("plan", { format: "json" }, io));
    const payload = JSON.parse(out);
    expect(payload.command).toBe("validate");
    expect(payload.target_family).toBe("capability");
    expect(payload.target).toBe("plan");
  });

  it("rejects an unknown capability name", () => {
    expect(() => cmdValidateCapability("notacapability", {}, {})).toThrow(
      /unsupported capability target/,
    );
  });
});

describe("cli validate capability-contract (structure)", () => {
  it("prints contract, protocol, and TODO readiness headers (text)", () => {
    const { out } = capture((io) => cmdValidateCapabilityContract({}, io));
    expect(out).toContain(
      "Self-validating contract: skills/agentera/capability_schema_contract.yaml",
    );
    expect(out).toContain("Validating protocol: skills/agentera/protocol.yaml");
    expect(out).toContain("Validating TODO readiness: skills/agentera/schemas/artifacts/todo.yaml");
  });

  it("emits a three-check JSON envelope", () => {
    const { out } = capture((io) => cmdValidateCapabilityContract({ format: "json" }, io));
    const payload = JSON.parse(out);
    expect(payload.target_family).toBe("capability-contract");
    expect(payload.checks).toHaveLength(3);
    expect(payload.checks.map((c: { target_family: string }) => c.target_family)).toEqual([
      "capability-contract-self",
      "capability-protocol",
      "todo-readiness",
    ]);
  });
});

describe("retired cli validate descriptors", () => {
  it("rejects the retired family with the bounded current-family correction", () => {
    const { rc, out } = capture((io) =>
      main(["node", "agentera", "check", "validate", "descriptors", "--format", "json"], io),
    );
    expect(rc).toBe(2);
    const payload = JSON.parse(out);
    expect(payload.error).toMatchObject({
      class: "unsupported_target",
      message:
        "unsupported validate family 'descriptors'; valid families are listed in valid_values.",
    });
    expect(payload.error.valid_values).toEqual([
      "cross-capability",
      "app-home-contract",
      "vocabularyAuthority",
      "selfAudit",
      "release-metadata",
      "capability",
      "capability-contract",
      "artifact",
      "state",
    ]);
  });
});

const fixtureRoots: string[] = [];
afterEach(() => {
  while (fixtureRoots.length) cleanupFixtureProject(fixtureRoots.pop()!);
});

describe("cli validate artifact", () => {
  it("validates a canonical artifact against a repo-state fixture (text)", () => {
    const root = useFixtureProject("ok");
    fixtureRoots.push(root);
    const { rc, out } = capture((io) =>
      cmdValidateArtifact({ artifact: "PLAN.md", cwd: root }, io),
    );
    expect(rc).toBe(0);
    expect(out).toContain("status=pass | artifact=PLAN.md");
    expect(out).toContain("path_source=docs_mapped_default");
  });

  it("emits a wrapped JSON envelope", () => {
    const root = useFixtureProject("ok");
    fixtureRoots.push(root);
    const { rc, out } = capture((io) =>
      cmdValidateArtifact({ artifact: "PROGRESS.md", cwd: root, format: "json" }, io),
    );
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("validate");
    expect(payload.target_family).toBe("artifact");
    expect(payload.target).toBe("PROGRESS.md");
    expect(payload.engine).toEqual({ command: "validate-artifact", exit_code: 0 });
  });

  it("fails an invalid artifact file (rc 2)", () => {
    const f = fs.mkdtempSync(path.join(os.tmpdir(), "va-"));
    const bad = path.join(f, "bad.yaml");
    fs.writeFileSync(bad, "x");
    const { rc, out } = capture((io) =>
      cmdValidateArtifact({ artifact: "PLAN.md", file: bad, format: "json" }, io),
    );
    expect(rc).toBe(2);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("fail");
    expect(payload.violations.length).toBeGreaterThan(0);
    fs.rmSync(f, { recursive: true, force: true });
  });

  it("rejects an unsupported artifact label", () => {
    expect(() => cmdValidateArtifact({ artifact: "BOGUS.md" }, {})).toThrow(/unsupported artifact/);
  });
});

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildSchemaPayload, cmdSchema } from "../../src/cli/commands/schema.js";
import { main } from "../../src/cli/dispatch.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliBin = path.join(packageRoot, "dist", "bin", "agentera.js");

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

describe("cli schema", () => {
  it("builds a schema payload against the repo", () => {
    const payload = buildSchemaPayload("schema");
    expect(payload.schemaVersion).toBe("agentera.schema.v1");
    expect(payload.command).toBe("schema");
    expect(["ok", "incomplete"]).toContain(payload.status);
    expect(Array.isArray(payload.commands)).toBe(true);
    expect(payload.routine_state_commands).toContain("plan");
    expect(payload.doctor.signal_kinds).toContain("missing_marker");
    expect(Array.isArray(payload.artifact_schemas)).toBe(true);
    expect(payload.artifact_locations.schemaVersion).toBe("agentera.artifact_locations.v1");
    expect(payload.state_writer).toMatchObject({
      schemaVersion: "agentera.stateWriterDiscovery.v1",
      namespace: "agentera state",
      discovery_command: "agentera schema --format json",
    });
    expect(payload.state_writer.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifact: "decisions",
          mutations: ["append", "update"],
          explain_by_verb: {
            append: "agentera state decisions explain --verb append --format json",
            update: "agentera state decisions explain --verb update --format json",
          },
        }),
      ]),
    );
    expect(payload.runtime_lifecycle.active_runtime_ids).toEqual(["opencode", "codex", "cursor", "copilot"]);
    expect(payload.runtime_lifecycle).toMatchObject({
      snapshot_schema_version: "agentera.runtimeLifecycleSnapshot.v1",
      projection_schema_version: "agentera.runtimeLifecycleProjection.v1",
      summary_schema_version: "agentera.runtimeLifecycleSummary.v1",
      status_vocabulary_version: "agentera.runtimeLifecycleStatus.v1",
      projection: {
        snapshot_identity: "deterministic_sha256",
        applicability: ["required", "conditional", "not_applicable"],
        action_classes: ["repairable_owned", "manual_verification", "unobservable_gap"],
        command_eligibility: ["preview", "apply", "manual", "diagnostic"],
        shared_resource_rule: "selected_and_required_by_at_least_one_selected_runtime",
      },
      support_floor: {
        mandatory_evidence_fields: ["host_present", "installed", "enabled", "trusted"],
        unknown_or_missing_mandatory_blocks: true,
        denied_mandatory_trust_blocks: true,
        known_false_diagnoses_degraded: ["host_present", "installed", "enabled"],
        not_applicable_scope: "unobserved_conditional_surface_only",
      },
    });
    expect(payload.runtime_lifecycle.migration_aliases["cursor-agent"]).toMatchObject({
      runtime_id: "cursor",
      active_runtime: false,
    });
    expect(payload.runtime_lifecycle.retired_runtime_inputs).toEqual([
      expect.objectContaining({
        id: "claude",
        active_runtime: false,
        source_product: "claude-code",
        analytics: expect.objectContaining({
          import_flag: "--import-source claude",
          source_class: "historical_import",
          default_view: "excluded",
        }),
      }),
    ]);
    expect(payload.runtime_lifecycle.upgrade).toMatchObject({
      schema_version: "agentera.lifecycleUpgrade.v1",
      selectors: ["all", "opencode", "codex", "cursor", "copilot"],
      default_without_runtime_selector: "app_upgrade_only",
      preview: "strictly_read_only",
      apply_requires: "--yes",
      journal_states: ["absent", "clean", "recoverable_terminal_tail", "corrupt"],
      journal_publication: "fsynced_unique_temporary_then_atomic_exclusive_final_link_and_directory_fsync",
      native_actions: "reported_action_required_never_executed",
      exits: { success: 0, non_success: 1, usage: 2 },
    });
    const decisions = (
      payload.artifact_schemas as Array<{ name: string; write_interface: unknown }>
    ).find((artifact) => artifact.name === "decisions");
    expect(decisions?.write_interface).toMatchObject({
      artifact: "decisions",
      explain_command: "agentera state decisions explain --format json",
    });
  });

  it("emits JSON by default and returns 0", () => {
    const { rc, out } = capture((io) => cmdSchema({}, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.schemaVersion).toBe("agentera.schema.v1");
  });

  it("drains large JSON output before the child process exits", () => {
    const child = spawnSync(process.execPath, [cliBin, "schema", "--format", "json"], {
      cwd: path.resolve(packageRoot, "..", ".."),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });

    expect(child.status).toBe(0);
    expect(Buffer.byteLength(child.stdout)).toBeGreaterThan(65_536);
    expect(() => JSON.parse(child.stdout)).not.toThrow();
    expect(JSON.parse(child.stdout)).toMatchObject({
      schemaVersion: "agentera.schema.v1",
      status: expect.stringMatching(/^(ok|incomplete)$/),
    });
  });

  it("describes the prime/hej commands with their structured fields", () => {
    const payload = buildSchemaPayload("schema");
    const prime = (payload.commands as Array<{ name: string; structured_fields: string[] }>).find(
      (c) => c.name === "prime",
    );
    expect(prime?.structured_fields).toContain("capability_context");
    const lint = (payload.commands as Array<{ name: string; output_formats: string[] }>).find((c) => c.name === "lint");
    expect(lint?.output_formats).toEqual(["text", "json"]);
  });
});

describe("cli dispatch: schema/describe routing", () => {
  it("routes schema", () => {
    const { rc } = capture((io) => main(["node", "agentera", "schema", "--format", "json"], io));
    expect(rc).toBe(0);
  });

  it("rejects removed top-level describe with the unknown-command envelope", () => {
    const { rc, out, err } = capture((io) => main(["node", "agentera", "describe"], io));
    expect(rc).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("What happened:");
    expect(err).toContain("unknown or not-yet-ported command: describe");
  });

  it("rejects an invalid --format choice", () => {
    const { rc, out, err } = capture((io) => main(["node", "agentera", "schema", "--format", "text"], io));
    expect(rc).toBe(2);
    // runSchema defaults format to "json", so the invalid --format rejection
    // emits the canonical JSON envelope to stdout and the four-question text
    // template would not appear on stderr in this default mode.
    expect(err).toBe("");
    const envelope = JSON.parse(out);
    expect(envelope.status).toBe("fail");
    expect(envelope.error.class).toBe("invalid_choice");
    expect(envelope.error.message).toContain("invalid choice");
  });
});

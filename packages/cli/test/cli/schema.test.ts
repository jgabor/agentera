import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildSchemaPayload, cmdSchema } from "../../src/cli/commands/schema.js";
import { main } from "../../src/cli/dispatch.js";
import { sourceModuleUrl, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const projectRoot = path.resolve(packageRoot, "..", "..");

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
  it("executes every emitted writer discovery command", () => {
    const payload = buildSchemaPayload("schema");
    const artifacts = payload.state_writer.artifacts as Array<{
      artifact: string;
      explain_command: string;
      explain_by_verb: Record<string, string>;
    }>;

    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      for (const command of [artifact.explain_command, ...Object.values(artifact.explain_by_verb)]) {
        const argv = command.split(" ").slice(1);
        const result = capture((io) => main(
          ["node", "agentera", ...argv, "--project", projectRoot],
          io,
        ));
        expect(result, command).toMatchObject({ rc: 0, err: "" });
        expect(JSON.parse(result.out), command).toMatchObject({
          artifact: artifact.artifact,
          requested_verb: expect.any(String),
        });
      }
    }
  });

  it("builds a schema payload against the repo", () => {
    const payload = buildSchemaPayload("schema");
    expect(payload.schemaVersion).toBe("agentera.schema.v1");
    expect(payload.command).toBe("schema");
    expect(["ok", "incomplete"]).toContain(payload.status);
    expect(Array.isArray(payload.commands)).toBe(true);
    expect(payload.routine_state_commands).toContain("plan");
    const prime = (payload.commands as Array<{ name: string; description: string }>).find(
      (command) => command.name === "prime",
    );
    expect(prime?.description).toContain("12000 UTF-8 bytes");
    expect(prime?.description).toContain("status startup at most 25000");
    expect(payload).not.toHaveProperty("state_backfill");
    expect(payload).not.toHaveProperty("state_migration");
    expect((payload.commands as Array<{ name: string }>).some((command) => command.name === "backfill")).toBe(false);
    expect(payload.entity_migration).toMatchObject({
      invocation: expect.objectContaining({ explicit_apply: "full_upgrade_yes_only" }),
    });
    const upgrade = (payload.commands as Array<{
      name: string;
      description: string;
      filters: string[];
      structured_fields: string[];
    }>).find(
      (command) => command.name === "upgrade",
    );
    expect(upgrade?.structured_fields).toEqual(expect.arrayContaining(["phase", "phases"]));
    expect(upgrade?.description).toContain("app and project-state migration");
    expect(upgrade?.description).toContain("retired Claude cleanup");
    expect(upgrade?.description).not.toContain("runtime lifecycle repair");
    expect(upgrade?.filters).toContain("legacy_cleanup");
    expect(upgrade?.filters).toContain("only");
    expect(upgrade?.filters).not.toContain("runtime");
    const doctor = (payload.commands as Array<{
      name: string;
      description: string;
    }>).find((command) => command.name === "doctor");
    expect(doctor?.description).toBe(
      "Check Agentera CLI, app, shared-skill, and project-integration status.",
    );
    expect(payload.doctor.signal_kinds).toContain("missing_marker");
    expect(payload.doctor.self_check_categories).toEqual([
      "Agentera CLI self-check status",
      "installed app and install-root status",
      "canonical shared-skill diagnosis",
      "project integration and project-state migration diagnostics",
      "bounded offline smoke checks when requested",
    ]);
    expect(payload.doctor.self_check_categories).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/runtime adapter/i),
        expect.stringMatching(/hook, package/i),
      ]),
    );
    expect(payload.integration).toMatchObject({
      authority: "references/cli/agent-ready-state-contract.yaml",
      active_contract: "one shared skill plus the Agentera CLI",
      shared_skill: {
        path: "~/.agents/skills/agentera",
        state_field: "shared_skill",
      },
      cli: {
        current_runtime_selectors: [],
        current_native_resource_operations: [],
      },
      supported_routes: {
        v2_migration: "agentera upgrade --channel development --project PROJECT --dry-run|--yes",
        retired_cleanup: "agentera upgrade --legacy-cleanup claude --dry-run|--yes",
      },
    });
    expect(payload.integration.authority).not.toContain("runtime-lifecycle-authority");
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
          mutations: ["append", "update", "amend"],
          explain_by_verb: {
            append: "agentera state decisions explain --verb append --format json",
            update: "agentera state decisions explain --verb update --format json",
            amend: "agentera state decisions explain --verb amend --format json",
          },
        }),
        expect.objectContaining({
          artifact: "experiments",
          mutations: ["publish"],
          explain_by_verb: {
            publish: "agentera state experiments explain --verb publish --format json",
          },
        }),
      ]),
    );
    expect(payload.state_retrieval).toMatchObject({
      authority: "references/artifacts/state-storage-authority.yaml",
      schema_version: "agentera.entityPublicRetrieval.v1",
      status: "final",
      commands: {
        plan_tasks: {
          get: "agentera state plan tasks get --id ID --format json",
        },
        plans: {
          get: "agentera state plan get --id ID --format json",
        },
        experiments: {
          get: "agentera state experiments get --id ID --format json",
        },
      },
    });
    expect(payload).not.toHaveProperty("runtime_lifecycle");
    expect(payload.integration).toMatchObject({
      active_contract: "one shared skill plus the Agentera CLI",
      shared_skill: { path: "~/.agents/skills/agentera", state_field: "shared_skill" },
      cli: { current_runtime_selectors: [], current_native_resource_operations: [] },
      supported_routes: {
        v2_migration: expect.stringContaining("--channel development"),
        retired_cleanup: expect.stringContaining("--legacy-cleanup claude"),
      },
    });
    expect(payload.integration.retired_runtime_inputs).toEqual([
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
    const decisions = (
      payload.artifact_schemas as Array<{ name: string; write_interface: unknown }>
    ).find((artifact) => artifact.name === "decisions");
    expect(decisions?.write_interface).toMatchObject({
      artifact: "decisions",
      explain_command: "agentera state decisions explain --format json",
    });
    const experiments = (
      payload.artifact_schemas as Array<{ name: string; write_interface: unknown }>
    ).find((artifact) => artifact.name === "experiments");
    expect(experiments?.write_interface).toMatchObject({
      artifact: "experiments",
      mutations: ["publish"],
    });
  });

  it("emits JSON by default and returns 0", () => {
    const { rc, out } = capture((io) => cmdSchema({}, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.schemaVersion).toBe("agentera.schema.v1");
  });

  it("drains JSON larger than 64 KiB before the source subprocess exits", () => {
    const cliBin = fileURLToPath(sourceModuleUrl("bin/agentera.js"));
    const child = spawnSync(process.execPath, [cliBin, "schema", "--format", "json"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...sourceSubprocessEnv(),
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: projectRoot,
      },
      maxBuffer: 2 * 1024 * 1024,
    });

    expect(child.status, `source schema boundary failed:\n${child.stderr}`).toBe(0);
    expect(Buffer.byteLength(child.stdout)).toBeGreaterThan(65_536);
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
    const lint = (
      payload.commands as Array<{ name: string; output_formats: string[]; description: string }>
    ).find((c) => c.name === "lint");
    expect(lint?.output_formats).toEqual(["text", "json"]);
    expect(lint?.description).toBe(
      "Deprecated alias for check lint. Optional draft prose preview; typed writers validate published bytes.",
    );
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

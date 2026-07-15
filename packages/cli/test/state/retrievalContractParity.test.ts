import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { main } from "../../src/cli/dispatch.js";
import { printStateHelp } from "../../src/cli/help.js";
import { capabilityContext } from "../../src/cli/capabilityContext/contract.js";
import { loadStateRetrievalAuthority } from "../../src/state/retrievalAuthority.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function capture(argv: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...argv], {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
  });
  return { rc, out, err };
}

describe("bounded retrieval public-contract parity", () => {
  it("projects the canonical commands, ownership, cursor, omission, detail, failure, and output-bound semantics", () => {
    const retrieval = loadStateRetrievalAuthority(REPO_ROOT).retrieval as Record<string, any>;
    const schema = buildSchemaPayload("schema").state_retrieval as Record<string, any>;
    expect(schema).toEqual({
      authority: "references/artifacts/state-storage-authority.yaml",
      ...retrieval,
    });

    expect(retrieval.output_bounds).toEqual({
      maximum_limit: 100,
      max_serialized_utf8_bytes: 32768,
      scalar_truncation: "forbidden",
      omission_unit: "whole_entries",
    });
    expect(retrieval.collections.find((entry: any) => entry.collection_id === "plan.tasks").storage_ownership)
      .toBe("owning_active_plan_file");
    expect(retrieval.collections.find((entry: any) => entry.collection_id === "plan.plans").storage_ownership)
      .toBe("active_plan_file_and_immutable_plan_archive_files");
    expect(retrieval.collections.find((entry: any) => entry.collection_id === "experiments.records").storage_ownership)
      .toBe("objective_scoped_durable_records_and_bounded_10_40_50_projection");
    expect(retrieval.failures.required_fields).toEqual(expect.arrayContaining([
      "class", "message", "syntax", "example", "recovery",
    ]));
  });

  it("keeps experiment artifact introspection objective-scoped and executable after selector substitution", () => {
    const schema = buildSchemaPayload("schema") as Record<string, any>;
    const retrieval = schema.state_retrieval;
    const experiments = schema.artifact_locations.artifacts.find(
      (artifact: Record<string, unknown>) => artifact.artifact_id === "experiments",
    );
    const expectedList = retrieval.commands.experiments.list
      .replace(" [--limit N] [--cursor TOKEN]", " --limit 20");
    expect(experiments).toMatchObject({
      normal_read_command: expectedList,
      normal_read_required_selectors: ["--objective OBJECTIVE_ID"],
      normal_detail_command: retrieval.commands.experiments.get,
    });
    expect(experiments.normal_read_guidance).toContain("Replace OBJECTIVE_ID");
    expect(experiments.normal_read_guidance).not.toContain("agentera experiments");
    expect(experiments.normal_read_command).not.toBe("agentera experiments --format json");

    const routineExperiment = schema.commands.find(
      (command: Record<string, unknown>) => command.name === "experiments" && command.kind === "routine_state",
    );
    expect(routineExperiment.description).not.toContain("Deprecated alias");
  });

  it("executes every selector-free normal read and explicitly validates required placeholders", () => {
    const schema = buildSchemaPayload("schema") as Record<string, any>;
    for (const artifact of schema.artifact_locations.artifacts) {
      const command = artifact.normal_read_command as string | null;
      if (!command) continue;
      const selectors = artifact.normal_read_required_selectors as string[];
      expect(Array.isArray(selectors), artifact.artifact_id).toBe(true);
      const placeholders = command.match(/\b[A-Z][A-Z0-9_]*\b/g) ?? [];
      if (selectors.length > 0) {
        expect(placeholders.length, artifact.artifact_id).toBeGreaterThan(0);
        for (const selector of selectors) expect(command, artifact.artifact_id).toContain(selector);
        expect(artifact.normal_read_guidance, artifact.artifact_id).toContain("Replace");
        continue;
      }
      expect(placeholders, artifact.artifact_id).toEqual([]);
      expect(command.startsWith("agentera state "), artifact.artifact_id).toBe(true);
      const result = capture(command.split(" ").slice(1));
      expect(result.rc, `${artifact.artifact_id}: ${command}\n${result.err}`).toBe(0);
    }
  });

  it("keeps help and capability prose on the authority grammar and semantics", () => {
    const retrieval = loadStateRetrievalAuthority(REPO_ROOT).retrieval as Record<string, any>;
    const planHelp = printStateHelp("plan");
    const experimentHelp = printStateHelp("experiments");
    for (const command of Object.values(retrieval.commands.plan_tasks).filter((value) => typeof value === "string")) {
      expect(planHelp).toContain(command);
    }
    for (const command of Object.values(retrieval.commands.plans).filter((value) => typeof value === "string")) {
      expect(planHelp).toContain(command);
    }
    for (const command of [
      retrieval.commands.experiments.list,
      retrieval.commands.experiments.get,
      retrieval.commands.experiments.publish,
    ]) expect(experimentHelp).toContain(command);
    expect(planHelp).toContain("active plan only");
    expect(planHelp).toContain("1 through 100");
    expect(planHelp).toContain("32,768 UTF-8 bytes");
    expect(experimentHelp).toContain("full, summary-only, or unavailable");
    expect(experimentHelp).toContain("opaque snapshot cursors");

    const optimize = CAPABILITY_INSTRUCTIONS.optimize;
    expect(optimize).toContain(retrieval.commands.experiments.list);
    expect(optimize).toContain(retrieval.commands.experiments.get);
    expect(optimize).toContain(retrieval.commands.experiments.publish);
    expect(optimize).not.toContain("\nagentera state experiments\n");
    expect(optimize).not.toContain("Update **experiments.yaml**: append");
    expect(optimize).not.toContain("apply the schema COMPACTION rules");
  });

  it("projects the affected retrieval authority into agent startup context", () => {
    const optimize = capabilityContext("optimize") as Record<string, any>;
    expect(optimize.cli_fallback).toContain(
      "agentera state experiments list --objective OBJECTIVE_ID --limit 20 --format json",
    );
    expect(optimize.retrieval_contract).toMatchObject({
      authority: "references/artifacts/state-storage-authority.yaml",
      schema_version: "agentera.stateRetrievalAuthority.v1",
      commands: {
        experiments: {
          list: expect.stringContaining("state experiments list --objective OBJECTIVE_ID"),
          get: expect.stringContaining("state experiments get --objective OBJECTIVE_ID --number N"),
          publish: expect.stringContaining("state experiments publish --objective OBJECTIVE_ID"),
        },
      },
      output_bounds: { maximum_limit: 100, max_serialized_utf8_bytes: 32768 },
      detail_availability: true,
    });
  });

  it("keeps capability schemas, operator docs, and packaged data on the same public contract", () => {
    const experimentSchema = read("skills/agentera/schemas/artifacts/experiments.yaml");
    expect(experimentSchema).toContain("RETRIEVAL:");
    expect(experimentSchema).toContain("agentera state experiments list --objective OBJECTIVE_ID");
    expect(experimentSchema).toContain("agentera state experiments get --objective OBJECTIVE_ID --number N");

    for (const doc of ["README.md", "AGENTS.md", "packages/cli/README.md"]) {
      const text = read(doc);
      expect(text, doc).toContain("agentera state plan list");
      expect(text, doc).toContain("agentera state experiments list --objective OBJECTIVE_ID");
      expect(text, doc).toContain("references/artifacts/state-storage-authority.yaml");
    }

    const setup = read("packages/cli/test/globalSetup.ts");
    expect(setup).toContain("scripts\", \"copy-bundle.mjs");
  });

  it.each([
    {
      argv: ["state", "plan", "show", "--format", "json"],
      valid: ["list", "get", "tasks", "archive"],
    },
    {
      argv: ["state", "experiments", "show", "--format", "json"],
      valid: ["publish", "list", "get"],
    },
    {
      argv: ["state", "plan", "list", "--plan", "invalid", "--format", "json"],
      valid: ["list", "--limit 1..100", "--cursor TOKEN"],
    },
    {
      argv: ["state", "experiments", "list", "--format", "json"],
      valid: ["list", "--objective OBJECTIVE_ID", "--limit 1..100"],
    },
  ])("returns bounded structured correction for unsupported form $argv", ({ argv, valid }) => {
    const result = capture(argv);
    expect(result.rc).toBe(2);
    expect(result.err).toBe("");
    const payload = JSON.parse(result.out);
    expect(payload.status).toBe("fail");
    expect(payload.error.valid_values).toEqual(expect.arrayContaining(valid));
    expect(payload.error.example).toMatch(/^agentera state (plan|experiments) /);
    expect(payload.error.recovery).toMatch(/retry|Run/);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("keeps malformed cursors opaque and returns a runnable fresh-snapshot correction", () => {
    const result = capture(["state", "plan", "list", "--cursor", "not-a-cursor", "--format", "json"]);
    expect(result.rc).toBe(2);
    const payload = JSON.parse(result.out);
    expect(payload.error).toMatchObject({
      class: "cursor_invalid",
      valid_values: expect.arrayContaining(["list", "--cursor TOKEN"]),
      example: "agentera state plan list --limit 20 --format json",
    });
    expect(payload.error.recovery).toContain("omit --cursor");
  });
});

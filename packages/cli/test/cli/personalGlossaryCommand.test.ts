import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { requiresCompletedEntityCutover } from "../../src/cli/migrationRequired.js";
import { printReportHelp } from "../../src/cli/help.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; profilePath: string; original: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-glossary-command-"));
  roots.push(root);
  const profilePath = path.join(root, "PROFILE.md");
  const original = "# Decision Profile: CLI\n\n## Process\n\n`━ conf:93 | perm:stable`\n";
  fs.writeFileSync(profilePath, original);
  return { root, profilePath, original };
}

function request(profilePath: string): Record<string, unknown> {
  return {
    schema_version: "agentera.personalGlossaryUpdateRequest.v1",
    profile_path: profilePath,
    as_of: "2026-07-01",
    fresh_entries: [{
      term: "ship shape",
      meaning: "The complete form of a deliverable.",
      confidence: 80,
      permanence: "durable",
      temporal: { observed_at: "2026-07-01", last_confirmed_at: "2026-07-01" },
      provenance: {
        kind: "personal_explicit_definition",
        evidence: [{ source_id: "source", evidence_anchor: "anchor", signal_type: "correction" }],
      },
    }],
    retained_history: [{
      source_id: "source",
      evidence_anchor: "anchor",
      source_kind: "conversation_turn",
      signal_type: "correction",
    }],
  };
}

function run(args: string[], stdin = ""): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], {
    stdin: () => stdin,
    out: (text) => { out += text; },
    err: (text) => { err += text; },
  });
  return { rc, out, err };
}

describe("agentera report profile-glossary", () => {
  it("discovers one authority-backed command contract through report help and schema", () => {
    expect(printReportHelp()).toContain("agentera report profile-glossary --input <file|-> [--dry-run] --format json");
    expect((buildSchemaPayload().integration as any).personal_glossary).toEqual({
      command: "agentera report profile-glossary",
      request_schema_version: "agentera.personalGlossaryUpdateRequest.v1",
      output_statuses: ["changed", "unchanged_replay", "dry_run_candidate"],
      project_checkout: "not_required",
    });
  });
  it("accepts stdin and distinguishes changed from unchanged replay without a project checkout", () => {
    const { root, profilePath } = fixture();
    fs.mkdirSync(path.join(root, ".agentera", "glossary.yaml"), { recursive: true });
    expect(requiresCompletedEntityCutover(["report", "profile-glossary", "--input", "-"])).toBe(false);

    const first = run(["report", "profile-glossary", "--input", "-", "--format", "json"], JSON.stringify(request(profilePath)));
    expect(first).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(first.out)).toMatchObject({
      schemaVersion: "agentera.personalGlossaryUpdate.v1",
      command: "report profile-glossary",
      status: "changed",
      dry_run: false,
    });
    const bytes = fs.readFileSync(profilePath, "utf8");
    expect(bytes).toContain("agentera.personalGlossarySection.v1");
    expect(bytes).toContain("conf:93");

    const replay = run(["report", "profile-glossary", "--input=-", "--format=json"], JSON.stringify(request(profilePath)));
    expect(JSON.parse(replay.out)).toMatchObject({ status: "unchanged_replay", candidate_status: "unchanged" });
    expect(fs.readFileSync(profilePath, "utf8")).toBe(bytes);
  });

  it("accepts file input and dry-runs a changed candidate without writing", () => {
    const { root, profilePath, original } = fixture();
    const inputPath = path.join(root, "request.json");
    fs.writeFileSync(inputPath, JSON.stringify(request(profilePath)));
    const result = run(["report", "profile-glossary", "--input", inputPath, "--dry-run", "--format", "json"]);
    expect(result.rc).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      status: "dry_run_candidate",
      dry_run: true,
      candidate_status: "changed",
    });
    expect(fs.readFileSync(profilePath, "utf8")).toBe(original);
  });

  it.each([
    ["version", (value: any) => { value.schema_version = "agentera.personalGlossaryUpdateRequest.v9"; }, ["agentera.personalGlossaryUpdateRequest.v1"]],
    ["entries", (value: any) => { value.fresh_entries = {}; }, ["fresh_entries: []"]],
    ["date", (value: any) => { value.as_of = "07/01/2026"; }, ["YYYY-MM-DD"]],
    ["path", (value: any) => { value.profile_path = ""; }, ["profile_context.profile.path"]],
  ])("rejects invalid %s before effects with allowed values", (_name, mutate, allowed) => {
    const { profilePath, original } = fixture();
    const value = request(profilePath);
    mutate(value);
    const result = run(["report", "profile-glossary", "--input", "-", "--format", "json"], JSON.stringify(value));
    expect(result.rc).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      status: "fail",
      error: { valid_values: allowed, recovery: expect.stringContaining("no profile bytes were changed") },
    });
    expect(fs.readFileSync(profilePath, "utf8")).toBe(original);
  });

  it("rejects malformed requests and missing targets before effects", () => {
    const malformed = run(["report", "profile-glossary", "--input", "-", "--format", "json"], "[]");
    expect(malformed.rc).toBe(2);
    expect(JSON.parse(malformed.out).error).toMatchObject({ class: "invalid_format" });

    const { root, profilePath } = fixture();
    const missing = path.join(root, "missing", "PROFILE.md");
    const result = run(["report", "profile-glossary", "--input", "-", "--format", "json"], JSON.stringify(request(missing)));
    expect(result.rc).toBe(2);
    expect(JSON.parse(result.out).error).toMatchObject({
      class: "invalid_request",
      valid_values: ["existing PROFILE.md path from profile_context.profile.path"],
      recovery: expect.stringContaining("no profile bytes were changed"),
    });
    expect(fs.existsSync(profilePath)).toBe(true);
  });

  it("rejects non-JSON output and the deprecated stats alias with canonical recovery", () => {
    const badFormat = run(["report", "profile-glossary", "--input", "-", "--format", "yaml"], "{}");
    expect(JSON.parse(badFormat.out).error).toMatchObject({ valid_values: ["json"] });
    const alias = run(["stats", "profile-glossary", "--input", "-", "--format", "json"], "{}");
    expect(alias.rc).toBe(2);
    expect(JSON.parse(alias.out).error).toMatchObject({ valid_values: ["report profile-glossary"] });
  });
});

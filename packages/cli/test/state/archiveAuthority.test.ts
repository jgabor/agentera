import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml");
const BUDGET_MANIFEST_PATH = path.join(REPO_ROOT, "scripts/json_output_surface_manifest.yaml");

function loadYaml(filePath: string): Record<string, any> {
  return YAML.parse(fs.readFileSync(filePath, "utf8")) as Record<string, any>;
}

function authorityErrors(value: Record<string, any>): string[] {
  const errors: string[] = [];
  if (value.schema_version !== "agentera.stateStorageAuthority.v1") errors.push("schema_version");
  if (value.status !== "active_authority") errors.push("status");
  for (const group of ["scope", "storage", "identity", "envelope", "overlays", "projections", "api", "failures", "compatibility", "budgets"]) {
    if (!value[group] || typeof value[group] !== "object") errors.push(group);
  }
  const artifactIds = value.scope?.supported_artifacts?.map((entry: any) => entry.artifact_id) ?? [];
  if (JSON.stringify(artifactIds) !== JSON.stringify(["progress", "decisions", "health"])) errors.push("supported_artifacts");
  if (value.storage?.project_root?.archive_path_template !== ".agentera/archive/<artifact-id>/<entry-number>.yaml") errors.push("archive_path_template");
  if (value.envelope?.schema_version !== "agentera.stateArchiveEntry.v1") errors.push("envelope.schema_version");
  if (value.api?.direct_get?.command !== "agentera state <artifact-id> get --number N --format json") errors.push("direct_get.command");
  if (value.api?.list?.command !== "agentera state <artifact-id> list [--limit N] [--cursor TOKEN] --format json") errors.push("list.command");
  if (value.api?.list?.maximum_limit < value.api?.list?.minimum_limit) errors.push("list.limit_range");
  if (!String(value.api?.cursor?.append_behavior ?? "").includes("excluded")) errors.push("cursor.append_behavior");
  if (value.compatibility?.classifications?.join(",") !== "complete,degraded,blocked,unsupported") errors.push("compatibility.classifications");
  for (const requiredCase of ["new", "legacy_full", "legacy_summary", "non_git", "shallow", "ambiguous", "corrupt", "unsupported"]) {
    if (!value.compatibility?.cases?.[requiredCase]) errors.push(`compatibility.cases.${requiredCase}`);
  }
  if (value.budgets?.measurement?.encoding !== "UTF-8") errors.push("budgets.measurement.encoding");
  return errors;
}

describe("state storage authority", () => {
  it("publishes archive identity, envelopes, paths, overlays, projections, and failures", () => {
    const authority = loadYaml(AUTHORITY_PATH);

    expect(authorityErrors(authority)).toEqual([]);
    expect(authority.storage.project_root.fixed).toBe(true);
    expect(authority.storage.project_root.path_override).toBe("forbidden");
    expect(authority.identity.stable_id.format).toBe("<artifact-id>:<entry-number>");
    expect(authority.envelope.required_fields).toEqual([
      "schemaVersion",
      "artifact_id",
      "entry_number",
      "record",
      "record_sha256",
    ]);
    expect(authority.envelope.forbidden_fields).toEqual(
      expect.arrayContaining(["commit", "commit_hash", "git_commit", "git_ref"]),
    );
    expect(authority.overlays.location).toBe(".agentera/overlays/decisions.yaml");
    expect(authority.overlays.mutable_paths).toEqual([
      "satisfaction.state",
      "satisfaction.evidence",
      "satisfaction.user_confirmation.confirmed_by",
      "satisfaction.user_confirmation.confirmed_at",
    ]);
    expect(authority.overlays.derived_paths).toEqual(
      expect.arrayContaining(["satisfaction.review_needed", "satisfaction.caveats"]),
    );
    expect(authority.projections.archive.role).toContain("complete immutable");
    expect(authority.projections.current.role).toContain("bounded active");
    expect(authority.projections.current.default_capacity).toEqual({
      active_entries: 10,
      summary_entries: 40,
      total_entries: 50,
      semantics: expect.stringContaining("not retention or deletion limits"),
    });
    expect(authority.projections.summary.omission).toContain("never silently");
    expect(authority.projections.current.legacy_summary_overflow).toMatchObject({
      source: "legacy_summary",
      compatibility: "degraded",
      detail_availability: "unavailable",
      archive_verified: false,
    });
    expect(authority.failures.envelope.error_required_fields).toEqual([
      "class",
      "message",
      "syntax",
      "example",
      "recovery",
    ]);
  });

  it("rejects an authority with a wrong archive path or missing envelope", () => {
    const authority = loadYaml(AUTHORITY_PATH);
    authority.storage.project_root.archive_path_template = ".agentera/history/<artifact-id>/<entry-number>.yaml";
    delete authority.envelope;

    expect(authorityErrors(authority)).toEqual(expect.arrayContaining(["archive_path_template", "envelope"]));
  });

  it("publishes exact get/list syntax, ordering, cursor snapshots, and limits", () => {
    const authority = loadYaml(AUTHORITY_PATH);
    const api = authority.api;

    expect(api.namespace).toBe("agentera state");
    expect(api.direct_get.required_selector).toBe("--number N");
    expect(api.list.default_limit).toBe(20);
    expect(api.list.minimum_limit).toBe(1);
    expect(api.list.maximum_limit).toBe(100);
    expect(api.list.ordering).toBe("identity.ordering.list");
    expect(api.cursor.snapshot_identity).toContain("deterministic hash");
    expect(api.cursor.append_behavior).toContain("excluded");
    expect(api.cursor.unavailable).toContain("cursor_snapshot_unavailable");
    expect(api.list.response_fields.required).toEqual(
      expect.arrayContaining(["entries", "counts", "snapshot", "source_contract"]),
    );
    expect(api.durability).toMatchObject({
      command: "agentera check durability [--project PATH] [--artifact ARTIFACT] [--number N] [--limit N] --format json",
      default_limit: 100,
      maximum_limit: 100,
      status_values: ["complete", "degraded", "unavailable"],
      local_values: ["verified", "unavailable", "corrupt"],
      git_values: ["verified", "degraded", "unavailable"],
    });
    expect(api.durability.guarantees).toMatchObject({
      read_only: true,
      remote_contact: "forbidden",
      writes_independent: true,
    });
    expect(api.backfill).toMatchObject({
      command: expect.stringContaining("--preview-token TOKEN"),
      default_limit: 100,
      maximum_limit: 100,
      maximum_commits: 500,
      reachable_refs: ["HEAD", "refs/heads", "refs/tags"],
      excluded_refs: ["refs/remotes", "custom_refs"],
    });
    expect(api.backfill.guarantees).toMatchObject({
      apply_requires_force: true,
      apply_requires_preview_token: true,
      remote_contact: "forbidden",
      projection_writes: "forbidden",
      immutable_conflicts: "refuse_without_overwrite",
    });
  });

  it("rejects an API that loses snapshot stability or has an invalid limit", () => {
    const authority = loadYaml(AUTHORITY_PATH);
    authority.api.list.maximum_limit = 0;
    authority.api.cursor.append_behavior = "include new entries";

    expect(authorityErrors(authority)).toEqual(
      expect.arrayContaining(["list.limit_range", "cursor.append_behavior"]),
    );
  });

  it("classifies every required compatibility condition without reconstruction", () => {
    const authority = loadYaml(AUTHORITY_PATH);
    const cases = authority.compatibility.cases;

    expect(Object.fromEntries(Object.entries(cases).map(([name, value]: [string, any]) => [name, value.classification]))).toEqual({
      new: "complete",
      legacy_full: "degraded",
      legacy_summary: "degraded",
      non_git: "complete",
      shallow: "degraded",
      ambiguous: "blocked",
      corrupt: "blocked",
      unsupported: "unsupported",
    });
    expect(authority.compatibility.no_reconstruction).toContain("does not reconstruct");
    expect(cases.non_git.git_durability).toBe("unavailable");
    expect(cases.shallow.classification).toBe("degraded");
    expect(cases.ambiguous.behavior).toContain("never choose");
    expect(cases.corrupt.behavior).toContain("preserve");
  });

  it("rejects a compatibility matrix that omits an explicit required outcome", () => {
    const authority = loadYaml(AUTHORITY_PATH);
    delete authority.compatibility.cases.corrupt;

    expect(authorityErrors(authority)).toContain("compatibility.cases.corrupt");
  });

  it("keeps projection and startup byte budgets measurable and aligned with the manifest", () => {
    const authority = loadYaml(AUTHORITY_PATH);
    const manifest = loadYaml(BUDGET_MANIFEST_PATH);
    const surfaces = Object.fromEntries(
      manifest.surfaces.map((surface: any) => [surface.id, surface.byte_budget]),
    );

    expect(authority.budgets.measurement.bytes).toContain("serialized byte length");
    expect(authority.budgets.projection.max_utf8_bytes).toBe(32768);
    expect(authority.budgets.startup.surfaces.prime_briefing.max_utf8_bytes).toBe(surfaces["prime-briefing"]);
    expect(authority.budgets.startup.surfaces.prime_dashboard.max_utf8_bytes).toBe(surfaces["prime-dashboard"]);
    expect(authority.budgets.startup.surfaces.prime_sparse.max_utf8_bytes).toBe(surfaces["prime-fields-sparse"]);
    expect(authority.budgets.projection.omission_semantics).toContain("Never split UTF-8");
    expect(authority.budgets.projection.omission_semantics).toContain("measured minimal degraded envelope");
    expect(authority.budgets.startup.omission_semantics).toContain("distinguish omitted detail");
  });

  it("declares bounded list benchmarks and the measured no-index trigger", () => {
    const authority = loadYaml(AUTHORITY_PATH);
    expect(authority.budgets.list).toMatchObject({
      max_utf8_bytes: 32768,
      benchmark: {
        small: { entries: 100, max_latency_ms: 5000, max_heap_delta_bytes: 67108864 },
        large: { entries: 1000, max_latency_ms: 15000, max_heap_delta_bytes: 268435456 },
        response_max_utf8_bytes: 32768,
      },
      index_decision: { decision: "no_index" },
    });
    expect(String(authority.budgets.list.index_decision.trigger)).toContain("persistent index");
    expect(authority.budgets.startup.source_work).toMatchObject({
      schema_version: "agentera.startupSourceWorkBudget.v1",
      small: { max_current_entries: 100, max_archive_files: 100, max_latency_ms: 5000 },
      large: { max_current_entries: 1000, max_archive_files: 1000, max_latency_ms: 15000 },
      serialized_output: { prime_capability_context_max_utf8_bytes: 50000 },
    });
  });

  it("rejects a budget drift or omission contract without silently accepting it", () => {
    const authority = loadYaml(AUTHORITY_PATH);
    authority.budgets.startup.surfaces.prime_briefing.max_utf8_bytes = 1;
    authority.budgets.projection.omission_semantics = "truncate";

    const manifest = loadYaml(BUDGET_MANIFEST_PATH);
    expect(authority.budgets.startup.surfaces.prime_briefing.max_utf8_bytes).not.toBe(
      manifest.surfaces.find((surface: any) => surface.id === "prime-briefing").byte_budget,
    );
    expect(authority.budgets.projection.omission_semantics).not.toContain("Never split UTF-8");
  });
});

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml");

function loadAuthority(): Record<string, any> {
  return YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8")) as Record<string, any>;
}

function keysNamed(value: unknown, names: Set<string>, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysNamed(item, names, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key)) found.push(key);
    keysNamed(child, names, found);
  }
  return found;
}

describe("Decision 94 entity authority", () => {
  it("declares one complete target model without legacy public field keys", () => {
    const authority = loadAuthority();
    const target = authority.entity_target;

    expect(authority.authority.source).toBe("references/artifacts/state-storage-authority.yaml");
    expect(target).toMatchObject({
      status: "progress_decisions_health_plan_objective_experiment_todo_and_docs_implemented_other_families_declared",
      decision: 94,
      public_schema: {
        canonical_identity_field: "id",
        canonical_classification_field: "artifact",
        identity_and_classification_fields: ["id", "artifact"],
        entity_envelope: {
          required_fields: ["id", "artifact", "record"],
          additional_identity_or_classification_fields: "forbidden",
        },
      },
      identity: {
        scope: "project_wide_across_all_entity_artifacts",
        alphabet: "abcdefghijklmnopqrstuvwxyz",
        length: 10,
        accepted_pattern: "^[a-z]{10}$",
      },
      storage_boundary: {
        rule: "one independently mutable entity per writer-owned canonical file",
        aggregate_authority: "forbidden",
        shared_primitives: {
          status: "implemented",
          canonical_root: ".agentera/entities",
           canonical_path_template: ".agentera/entities/<artifact>/<boundary>/<id>.yaml",
           publication: "exclusive_immutable_file",
           publication_context: {
             scope: "shared_by_all_entity_families",
             binding: "validated_project_root_and_exact_cutover_marker_snapshot",
             lifetime: "mode_detection_through_writer_lock_and_final_publication_validation",
             marker_change_after_detection: "conflict_without_legacy_fallback",
             successor_preservation: "never_remove_unmatched_or_unrelated_identity",
           },
           identical_replay: "idempotent",
          divergent_same_id: "reject_without_overwrite",
          state_validation: {
            canonical_command: "agentera check validate state",
            mutates: false,
            failure_exit: "nonzero",
          },
        },
      },
      views: {
        authority: "non_authoritative_cli_rendering",
        mutation: "forbidden",
      },
      implementation_status: {
        progress: "implemented",
        decisions: "implemented",
        health: "implemented",
        plan: "implemented",
        objective: "implemented",
        experiments: "implemented",
        todo: "implemented",
        docs: "implemented",
        remaining_families: "declared_not_implemented",
      },
    });
    expect(target.identity.prohibited_components).toEqual([
      "prefix",
      "sequence",
      "timestamp",
      "branch",
      "writer",
      "git_reference",
    ]);
    expect(target.entities[0]).toMatchObject({
      boundary: "progress_cycle",
      artifact: "progress",
      implementation: "implemented",
      record: {
        forbidden_fields: expect.arrayContaining(["number", "stable_id", "artifact_id", "entry_number"]),
        required_paths: ["context.intent"],
        temporal_fields: ["timestamp"],
      },
      retrieval: {
        exact: "agentera state progress get --id ID --format json",
        ordering: "timestamp_desc_then_id_asc",
        cursor: "opaque_snapshot_cursor",
        scalar_truncation: "forbidden",
      },
    });
    expect(target.entities.find((entity: any) => entity.boundary === "decision")).toMatchObject({
      artifact: "decisions",
      implementation: "implemented",
      publication: "immutable",
      retrieval: { exact: "agentera state decisions get --id ID --format json", cursor: "opaque_snapshot_cursor" },
    });
    expect(target.entities.find((entity: any) => entity.boundary === "todo_item")).toMatchObject({
      artifact: "todo",
      implementation: "implemented",
      publication: "replace_owned_entity",
      retrieval: { exact: "agentera state todo get --id ID --format json", ordering: "severity_then_status_then_id" },
    });
    expect(target.entities.find((entity: any) => entity.boundary === "documentation_inventory_entry")).toMatchObject({
      artifact: "docs",
      implementation: "implemented",
      publication: "replace_owned_entity",
      retrieval: { exact: "agentera state docs get --id ID --format json", ordering: "path_then_id" },
    });
    expect(target.entities.find((entity: any) => entity.boundary === "decision_satisfaction")).toMatchObject({
      publication: "replace_owned_entity",
      ownership: { fields: ["decision"], cardinality: "zero_or_one" },
    });
    expect(target.entities.find((entity: any) => entity.boundary === "decision_revision")).toMatchObject({
      publication: "immutable",
      ownership: { fields: ["decision", "base_sha256"], cardinality: "zero_or_one" },
    });
    expect(target.entities.find((entity: any) => entity.boundary === "health_audit")).toMatchObject({
      artifact: "health",
      implementation: "implemented",
      publication: "immutable",
      record: {
        required_fields: ["date", "dimensions", "findings_summary", "trajectory", "grades"],
        forbidden_fields: expect.arrayContaining(["number", "stable_id", "artifact_id", "entry_number"]),
      },
      retrieval: {
        exact: "agentera state health get --id ID --format json",
        ordering: "date_desc_then_id_asc",
        cursor: "opaque_snapshot_cursor",
        scalar_truncation: "forbidden",
      },
    });
    expect(target.entities.find((entity: any) => entity.boundary === "plan").record).toMatchObject({
      required_fields: expect.arrayContaining(["scope"]),
      field_shapes: {
        scope: {
          type: "mapping",
          required_fields: { included: "string_list", excluded: "string_list" },
          optional_fields: { deferred: "string_list" },
          additional_fields: "forbidden",
        },
      },
    });
    expect(
      keysNamed(
        { entities: target.entities, relationships: target.relationships, views: target.views },
        new Set(target.public_schema.forbidden_canonical_aliases),
      ),
    ).toEqual([]);
  });

  it("enumerates every entity, relationship, and intentional singleton boundary", () => {
    const target = loadAuthority().entity_target;
    const entities = new Map(target.entities.map((entity: any) => [entity.boundary, entity]));

    expect([...entities.keys()]).toEqual([
      "progress_cycle",
      "decision",
      "decision_satisfaction",
      "decision_revision",
      "health_audit",
      "plan",
      "plan_task",
      "objective",
      "experiment",
      "todo_item",
      "documentation_inventory_entry",
    ]);
    expect(new Set([...entities.values()].map((entity: any) => entity.artifact))).toEqual(
      new Set(["progress", "decisions", "health", "plan", "objective", "experiments", "todo", "docs"]),
    );
    expect([...entities.values()].every((entity: any) => entity.independently_mutable)).toBe(true);

    for (const relationship of target.relationships.declarations) {
      expect(entities.has(relationship.source), relationship.source).toBe(true);
      expect(entities.has(relationship.target), relationship.target).toBe(true);
      expect(entities.get(relationship.source).relationships).toContain(
        relationship.field === "depends_on" ? "depends_on_tasks" : relationship.field,
      );
    }
    expect(target.intentional_singletons).toMatchObject({
      exhaustive: true,
      additions_require_authority_amendment: true,
    });
    expect(target.intentional_singletons.boundaries.map((entry: any) => entry.boundary)).toEqual([
      "vision",
      "design",
      "changelog",
      "profile",
      "runtime_local_session_state",
      "docs_mapping",
    ]);
    expect(target.excluded_from_entity_migration).toContain("all intentional_singletons");
  });

  it("exposes duplicate vocabulary and unresolved boundary references as contract failures", () => {
    const target = structuredClone(loadAuthority().entity_target);
    target.entities[0].stable_id = "progress:1";
    target.relationships.declarations[0].target = "missing_decision";
    const boundaries = new Set(target.entities.map((entity: any) => entity.boundary));

    expect(
      keysNamed(
        { entities: target.entities, relationships: target.relationships, views: target.views },
        new Set(target.public_schema.forbidden_canonical_aliases),
      ),
    ).toEqual(["stable_id"]);
    expect(
      target.relationships.declarations
        .filter((relationship: any) => !boundaries.has(relationship.source) || !boundaries.has(relationship.target))
        .map((relationship: any) => relationship.target),
    ).toEqual(["missing_decision"]);
  });

  it("defines non-fabricating one-way cutover and measurable target gates", () => {
    const authority = loadAuthority();
    const migration = authority.entity_migration;
    const measurement = authority.entity_target.measurement_contract;

    expect(migration).toMatchObject({
      status: "one_way_forward_import_implemented",
      decision: 94,
      kind: "single_full_upgrade_cutover",
      invocation: {
        explicit_apply: "full_upgrade_yes_only",
        dry_run: "optional_read_only_preview",
        ordinary_reads_migrate: false,
        ordinary_writes_migrate: false,
        apply_invokes_git: true,
        apply_boundary: expect.stringContaining("writes the authority marker last"),
        git_preflight: {
          required: true,
          source: "HEAD_commit",
          ignored_or_untracked_input: "refuse",
        },
      },
      cutover_marker: {
        path: ".agentera/state-mode.yaml",
        schema_version: "agentera.stateMode.v1",
        entity_mode: { schemaVersion: "agentera.stateMode.v1", mode: "entities" },
        absent_mode: "legacy",
        invalid_behavior: "fail_without_fallback",
        detection: "read_only",
        publication_owner: "development_channel_v2_to_v3_upgrade",
      },
      read_only_preview: {
        implementation: "implemented",
        ordering: "artifact_then_boundary_then_source_identity_then_source_path",
        project_root: expect.stringContaining("symbolic-link"),
        authority_binding: expect.stringContaining("preview digest"),
        output: {
          max_utf8_bytes: 32768,
          scalar_truncation: "forbidden",
          recovery: expect.stringContaining("--after SOURCE_IDENTITY"),
        },
        counts: {
          physical_records: expect.any(String),
          logical_identities: expect.any(String),
          mirrors: expect.any(String),
          duplicates: expect.any(String),
          conflicts: expect.any(String),
        },
      },
      non_fabrication: { partial_cutover_success: "forbidden" },
      forward_state: {
        persisted_recovery_state: "none",
        publication_order: "exact_or_missing_entities_then_graph_validation_then_marker",
        retry_rule: "accept_exact_targets_and_continue_at_first_missing_path",
        forbidden_fields: expect.arrayContaining(["operation_id", "snapshots", "inode_receipts", "rollback_state"]),
      },
    });
    expect(
      Object.fromEntries(
        Object.entries(migration.source_outcomes).map(([key, value]: [string, any]) => [key, value.outcome]),
      ),
    ).toEqual({
      valid_full: "ready",
      canonical_mirror: "ready_with_mirrored_provenance",
      degraded_recoverable: "ready_with_provenance",
      summary_only_or_missing_detail: "blocked",
      ambiguous_or_duplicate_identity: "blocked",
      proposed_target_conflict: "blocked",
      corrupt_or_unresolved_relationship: "blocked",
      unsupported: "blocked",
    });
    expect(migration.lifecycle.map((phase: any) => phase.phase)).toEqual([
      "inventory",
      "preview",
      "git_preflight",
      "publishing_entities",
      "entities_published",
      "marker",
    ]);
    expect(migration).not.toHaveProperty("resume");
    expect(migration).not.toHaveProperty("recovery");
    expect(migration.non_fabrication.forbidden).toEqual(
      expect.arrayContaining(["synthetic entities for missing source detail", "guessed relationship targets"]),
    );

    expect(measurement).toMatchObject({
      status: "target_gate_not_yet_implemented",
      sampling: { repetitions: 5, pass_rule: "every repetition stays within every applicable limit" },
      targets: {
        exact_get: { max_latency_ms: 1000, max_heap_delta_bytes: 67108864, max_utf8_bytes: 1048576 },
        bounded_list_small: { max_latency_ms: 5000, max_utf8_bytes: 32768 },
        bounded_list_large: { max_latency_ms: 15000, max_utf8_bytes: 32768 },
        startup_small: { max_latency_ms: 5000 },
        startup_large: { max_latency_ms: 15000 },
      },
    });
    expect(measurement.fixtures.small).toContain("every declared entity boundary");
    expect(measurement.fixtures.large).toContain("every declared entity boundary");
    expect(measurement.failure_rule).toContain("never truncate bytes");
    expect(measurement.failure_rule).toContain("fabricate detail");
  });
});

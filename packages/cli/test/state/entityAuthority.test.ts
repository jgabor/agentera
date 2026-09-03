import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { entityBoundariesForArtifact } from "../../src/state/entityStorage.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { planEntityMigration } from "../../src/state/entityMigrationPreview.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml");
const TODO_SCHEMA_PATH = path.join(REPO_ROOT, "skills/agentera/schemas/artifacts/todo.yaml");

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
            canonical_command: "npx -y agentera@next check validate state",
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
    expect(target.identity.prohibited_components).toEqual(["prefix", "sequence", "timestamp", "branch", "writer", "git_reference"]);
    expect(target.storage_boundary.shared_primitives.publication_context.filesystem_contract).toEqual({
      primitives: ["node_fs_linkSync", "node_fs_renameSync"],
      replacement_visibility: "complete_old_or_new_bytes_per_file",
      journal_visibility: "pending_journal_blocks_reads",
      global_snapshot: "not_promised",
      late_racer: "outside_contract_after_final_successful_validation",
      unsupported_result: "structured_unsupported_target_before_target_effects",
    });
    expect(target.storage_boundary.shared_primitives.publication_context.pathname_race_contract).toMatch(/project-relative standard Node paths.*link.*complete-file rename.*structured conflict.*not a global multi-file snapshot.*races after the final successful validation is outside this contract/s);
    expect(target.entities[0]).toMatchObject({
      boundary: "progress_cycle",
      artifact: "progress",
      implementation: "implemented",
      record: {
        forbidden_fields: expect.arrayContaining(["number", "stable_id", "artifact_id", "entry_number"]),
        required_paths: ["context.intent"],
        temporal_fields: ["timestamp"],
        publication_order: {
          field: "publication_order",
          type: "positive_safe_integer",
          ownership: "progress_writer_only",
          caller_input: "forbidden",
        },
      },
      retrieval: {
        exact: "npx -y agentera@next state progress get --id ID",
        ordering: "timestamp_desc_then_publication_order_desc_then_id_asc",
        cursor: "opaque_snapshot_cursor_v2",
        scalar_truncation: "forbidden",
      },
    });
    expect(target.entities.find((entity: any) => entity.boundary === "decision")).toMatchObject({
      artifact: "decisions",
      implementation: "implemented",
      publication: "immutable",
      retrieval: {
        exact: "npx -y agentera@next state decisions get --id ID",
        cursor: "opaque_snapshot_cursor",
        ordering: "date_desc_then_id_asc",
      },
    });
    expect(target.entities.find((entity: any) => entity.boundary === "todo_item")).toMatchObject({
      artifact: "todo",
      implementation: "implemented",
      publication: "reconcile_markdown_under_recoverable_journal",
      reconciliation: {
        activation: {
          path: ".agentera/todo-reconciliation-activation.json",
          schema_version: "agentera.todoReconciliationActivation.v1",
          initial_match: "exact_unique_public_fields_only",
        },
        create_recovery_receipt: {
          applicability: "create_transactions_only",
          transaction_identity: "canonical_create_receipt_and_targets",
          retry: expect.stringMatching(/normalized.*digest.*Exact retry.*original ID.*without allocation.*different request.*before target effects/s),
        },
        startup_selection: {
          ordering_authority: "skills/agentera/schemas/artifacts/todo.yaml#READINESS.ordering.modes.projected_startup",
          projected_entity_bound: 256,
        },
        public_replacement: expect.stringMatching(/standard Node filesystem operations.*complete old or new bytes.*not a global multi-file atomic snapshot.*validation boundary.*rolls back every attempted target/s),
        semantics: expect.stringMatching(/Interrupted create retry.*original created ID.*without allocating another entity.*Missing post-activation baselines.*reject before effects/s),
        bounds: {
          managed_items: 256,
          retained_pre_activation_legacy_rows: 256,
          transaction_targets: 258,
          activation_utf8_bytes: 32768,
        },
      },
      retrieval: {
        exact: "npx -y agentera@next state todo get --id ID",
        ordering: "severity_then_status_then_markdown_order_then_id",
      },
    });
    const todoSchema = YAML.parse(fs.readFileSync(TODO_SCHEMA_PATH, "utf8"));
    expect(todoSchema.READINESS.ordering.modes.projected_startup).toEqual({
      entity_annotation: "required_for_every_entity",
      eligibility: "before_order",
      managed_before_absent: true,
      managed_within_severity: "markdown_order_ascending",
      managed_duplicate_rank: "ignored",
      absent_within_severity: "queue_rank_then_id",
      absent_duplicate_rank: "entity_id_ascending",
    });
    expect(target.entities.find((entity: any) => entity.boundary === "decision")).toMatchObject({
      canonical_metadata: {
        migration_provenance: {
          applicability: "inherited_unsupported_confidence_only",
          required_fields: ["kind", "source", "source_path", "source_record_sha256", "confidence"],
          additional_fields: "forbidden",
          kind: "inherited_decision_confidence",
          sources: ["current_projection", "verified_archive"],
        },
      },
    });
    expect(target.entities.find((entity: any) => entity.boundary === "documentation_inventory_entry")).toMatchObject({
      artifact: "docs",
      implementation: "implemented",
      publication: "replace_owned_entity",
      retrieval: { exact: "npx -y agentera@next state docs get --id ID", ordering: "path_then_id" },
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
        cli_owned_append_fields: ["appended_at"],
        legacy_optional_fields: ["appended_at"],
      },
      retrieval: {
        exact: "npx -y agentera@next state health get --id ID",
        ordering: "appended_at_desc_then_id_asc_then_legacy_date_desc_then_id_asc",
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
    expect(keysNamed({ entities: target.entities, relationships: target.relationships, views: target.views }, new Set(target.public_schema.forbidden_canonical_aliases))).toEqual([]);
  });

  it("enumerates every entity, relationship, and intentional singleton boundary", () => {
    const target = loadAuthority().entity_target;
    const entities = new Map(target.entities.map((entity: any) => [entity.boundary, entity]));

    expect([...entities.keys()]).toEqual(["progress_cycle", "progress_summary", "decision", "decision_satisfaction", "decision_summary", "decision_revision", "health_audit", "health_summary", "plan", "plan_task", "objective", "experiment", "todo_item", "documentation_inventory_entry"]);
    expect(new Set([...entities.values()].map((entity: any) => entity.artifact))).toEqual(new Set(["progress", "decisions", "health", "plan", "objective", "experiments", "todo", "docs"]));
    expect([...entities.values()].filter((entity: any) => !entity.boundary.endsWith("_summary")).every((entity: any) => entity.independently_mutable)).toBe(true);
    expect(["progress_summary", "decision_summary", "health_summary"].map((boundary) => entities.get(boundary))).toEqual([
      expect.objectContaining({
        independently_mutable: false,
        publication: "immutable",
        mutation: "forbidden",
      }),
      expect.objectContaining({
        independently_mutable: false,
        publication: "immutable",
        mutation: "forbidden",
      }),
      expect.objectContaining({
        independently_mutable: false,
        publication: "immutable",
        mutation: "forbidden",
      }),
    ]);

    for (const relationship of target.relationships.declarations) {
      expect(entities.has(relationship.source), relationship.source).toBe(true);
      expect(entities.has(relationship.target), relationship.target).toBe(true);
      expect(entities.get(relationship.source).relationships).toContain(relationship.field === "depends_on" ? "depends_on_tasks" : relationship.field);
    }
    expect(target.intentional_singletons).toMatchObject({
      exhaustive: true,
      additions_require_authority_amendment: true,
    });
    expect(target.intentional_singletons.boundaries.map((entry: any) => entry.boundary)).toEqual(["vision", "design", "changelog", "profile", "runtime_local_session_state", "docs_mapping"]);
    expect(target.excluded_from_entity_migration).toContain("all intentional_singletons");
  });

  it("activates immutable compacted-summary boundaries for migration validation", () => {
    const target = loadAuthority().entity_target;
    const declared = target.declared_compacted_summary_contract;
    const activeBoundaries = target.entities.map((entity: any) => entity.boundary);

    expect(declared).toMatchObject({
      status: "implemented",
      runtime_boundary_source: "entity_target.entities",
      diagnostics: { status: "implemented" },
      source_outcomes: { status: "implemented" },
    });
    for (const [boundary, artifact, command, ordering] of [
      ["progress_summary", "progress", "npx -y agentera@next state progress get --id ID", "full_timestamp_desc_then_publication_order_desc_then_id_asc_then_summary_id_asc"],
      ["decision_summary", "decisions", "npx -y agentera@next state decisions get --id ID", "full_date_desc_then_id_asc_then_summary_id_asc"],
      ["health_summary", "health", "npx -y agentera@next state health get --id ID", "full_date_desc_then_id_asc_then_summary_id_asc"],
    ]) {
      const summary = declared.boundaries.find((entry: any) => entry.boundary === boundary);
      expect(summary).toMatchObject({
        artifact,
        independently_mutable: false,
        implementation: "implemented",
        publication: "immutable",
        mutation: "forbidden",
        record: {
          required_fields: ["summary", "migration_provenance"],
          additional_fields: "source_retained_fields_plus_declared_metadata",
          declared_metadata_fields: ["migration_provenance"],
          migration_provenance: {
            path: "record.migration_provenance",
            required_fields: ["source_path", "source_record_sha256"],
            additional_fields: "forbidden",
            source_row_provenance: "entity_target.declared_compacted_summary_contract.source_row_provenance",
          },
        },
        retrieval: {
          exact: command,
          detail_availability: "summary",
          compatibility: "degraded",
          ordering,
          summary_ordering: "canonical_id_asc_without_chronology_claim",
          mutation: "read_only",
        },
      });
      expect(activeBoundaries).toContain(boundary);
      expect(entityBoundariesForArtifact(artifact, REPO_ROOT)).toContain(boundary);
    }
    expect(declared.boundaries.find((entry: any) => entry.boundary === "decision_summary").record).toMatchObject({
      satisfaction: "optional_inline_read_only_source_retained_field",
      satisfaction_rule: expect.stringContaining("never creates or targets a decision_satisfaction entity"),
    });
  });

  it("exposes duplicate vocabulary and unresolved boundary references as contract failures", () => {
    const target = structuredClone(loadAuthority().entity_target);
    target.entities[0].stable_id = "progress:1";
    target.relationships.declarations[0].target = "missing_decision";
    const boundaries = new Set(target.entities.map((entity: any) => entity.boundary));

    expect(keysNamed({ entities: target.entities, relationships: target.relationships, views: target.views }, new Set(target.public_schema.forbidden_canonical_aliases))).toEqual(["stable_id"]);
    expect(target.relationships.declarations.filter((relationship: any) => !boundaries.has(relationship.source) || !boundaries.has(relationship.target)).map((relationship: any) => relationship.target)).toEqual(["missing_decision"]);
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
        upgrade_composition: {
          preflight: expect.stringMatching(/detect, artifact, or entity blocker prevents entity publication.*Runtime or cleanup blockers do not prevent valid entity activation.*resources remain untouched.*action-required work/s),
        },
      },
      cutover_marker: {
        path: ".agentera/state-mode.yaml",
        schema_version: "agentera.stateMode.v1",
        entity_mode: { schemaVersion: "agentera.stateMode.v1", mode: "entities" },
        absent_mode: "classified",
        invalid_behavior: "fail_without_fallback",
        detection: "read_only",
        publication_owner: "recognized_legacy_development_upgrade_or_fresh_plan_create",
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
    expect(Object.fromEntries(Object.entries(migration.source_outcomes).map(([key, value]: [string, any]) => [key, value.outcome]))).toEqual({
      valid_full: "ready",
      canonical_mirror: "ready_with_mirrored_provenance",
      degraded_recoverable: "ready_with_provenance",
      valid_compacted_summary: "ready_with_degraded_provenance",
      missing_detail_not_declared_summary: "blocked",
      ambiguous_or_duplicate_identity: "blocked",
      proposed_target_conflict: "blocked",
      corrupt_or_unresolved_relationship: "blocked",
      unsupported: "blocked",
    });
    expect(migration.lifecycle.map((phase: any) => phase.phase)).toEqual(["inventory", "preview", "git_preflight", "publishing_entities", "entities_published", "marker"]);
    expect(migration).not.toHaveProperty("resume");
    expect(migration).not.toHaveProperty("recovery");
    expect(migration.non_fabrication.forbidden).toEqual(expect.arrayContaining(["synthetic entities for missing source detail", "guessed relationship targets"]));

    expect(measurement).toMatchObject({
      status: "implemented",
      sampling: {
        repetitions: 5,
        pass_rule: "every repetition stays within every applicable limit",
      },
      targets: {
        exact_get: {
          max_latency_ms: 1000,
          max_heap_delta_bytes: 67108864,
          max_utf8_bytes: 1048576,
        },
        bounded_list_small: { max_latency_ms: 5000, max_utf8_bytes: 32768 },
        bounded_list_large: { max_latency_ms: 15000, max_utf8_bytes: 32768 },
        startup_small: { max_latency_ms: 5000 },
        startup_large: { max_latency_ms: 15000 },
      },
    });
    expect(measurement.fixtures.small).toContain("every active entity_target.entities boundary");
    expect(measurement.fixtures.large).toContain("every active entity_target.entities boundary");
    expect(measurement.failure_rule).toContain("never truncate bytes");
    expect(measurement.failure_rule).toContain("fabricate detail");
  });

  it("uses one mapping-or-scalar source-row provenance contract in every summary boundary and preview", () => {
    const target = loadAuthority().entity_target;
    const declared = target.declared_compacted_summary_contract;
    const reference = "entity_target.declared_compacted_summary_contract.source_row_provenance";
    const semantic = declared.source_row_provenance;
    const primary = new Map(target.entities.map((entry: any) => [entry.boundary, entry]));
    const sourceRows = {
      progress: [{ summary: "progress mapping", retained: { z: 1, a: ["second", "first"] } }, "progress scalar"],
      decisions: [{ summary: "decision mapping", satisfaction: { state: "user_confirmed_satisfied" } }, "decision scalar"],
      health: [{ summary: "health mapping", retained: { z: 1, a: ["second", "first"] } }, "health scalar"],
    } as const;
    const collections = { progress: "cycles", decisions: "decisions", health: "audits" } as const;
    const boundaries = {
      progress: "progress_summary",
      decisions: "decision_summary",
      health: "health_summary",
    } as const;

    expect(semantic).toMatchObject({
      semantic_id: "v2_compacted_summary_physical_row.v1",
      status: "implemented",
      accepted_parsed_row_values: ["mapping", "scalar_string"],
      source_record_sha256: { format: "lowercase_sha256_hex" },
    });
    for (const artifact of Object.keys(sourceRows) as Array<keyof typeof sourceRows>) {
      const boundary = boundaries[artifact];
      expect(primary.get(boundary).canonical_metadata.summary_migration_provenance.source_row_provenance).toBe(reference);
      expect(declared.boundaries.find((entry: any) => entry.boundary === boundary).record.migration_provenance.source_row_provenance).toBe(reference);
      expect(entityBoundariesForArtifact(artifact, REPO_ROOT)).toContain(boundary);
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-summary-source-rows-"));
    try {
      for (const artifact of Object.keys(sourceRows) as Array<keyof typeof sourceRows>) {
        const file = path.join(root, ".agentera", `${artifact}.yaml`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, YAML.stringify({ [collections[artifact]]: sourceRows[artifact] }));
      }
      const preview = planEntityMigration(root, REPO_ROOT);
      for (const artifact of Object.keys(sourceRows) as Array<keyof typeof sourceRows>) {
        for (const [index, physical] of sourceRows[artifact].entries()) {
          const entry = preview.entries.find((candidate) => candidate.source_identity === `${artifact}:${collections[artifact]}[${index}]`);
          const sourceDigest = createHash("sha256").update(canonicalRecordJson(physical)).digest("hex");
          expect(entry).toMatchObject({
            boundary: boundaries[artifact],
            classification: "valid_compacted_summary",
            record: {
              summary: typeof physical === "string" ? physical : physical.summary,
              migration_provenance: { source_record_sha256: sourceDigest },
            },
          });
          if (typeof physical === "string") {
            expect(sourceDigest).not.toBe(
              createHash("sha256")
                .update(canonicalRecordJson({ summary: physical }))
                .digest("hex"),
            );
          }
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

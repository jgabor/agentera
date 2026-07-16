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
      status: "declared_not_implemented",
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
    });
    expect(target.identity.prohibited_components).toEqual([
      "prefix",
      "sequence",
      "timestamp",
      "branch",
      "writer",
      "git_reference",
    ]);
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

  it("defines non-fabricating cutover outcomes, recovery, and measurable target gates", () => {
    const authority = loadAuthority();
    const migration = authority.entity_migration;
    const measurement = authority.entity_target.measurement_contract;

    expect(migration).toMatchObject({
      status: "inventory_preview_implemented",
      decision: 94,
      kind: "single_explicit_project_cutover",
      invocation: {
        explicit: "required",
        dry_run: "required_before_apply",
        ordinary_reads_migrate: false,
        ordinary_writes_migrate: false,
        invokes_git: false,
        apply_boundary: expect.stringContaining("Task 10"),
      },
      read_only_preview: {
        implementation: "implemented",
        ordering: "artifact_then_boundary_then_source_identity_then_source_path",
        output: {
          max_utf8_bytes: 32768,
          scalar_truncation: "forbidden",
        },
      },
      non_fabrication: { partial_cutover_success: "forbidden" },
      resume: {
        changed_source: "refuse before further publication",
        replay_after_complete: "report idempotent completion without rewriting entities",
      },
    });
    expect(
      Object.fromEntries(
        Object.entries(migration.source_outcomes).map(([key, value]: [string, any]) => [key, value.outcome]),
      ),
    ).toEqual({
      valid_full: "ready",
      degraded_recoverable: "ready_with_provenance",
      summary_only_or_missing_detail: "blocked",
      ambiguous_or_duplicate_identity: "blocked",
      corrupt_or_unresolved_relationship: "blocked",
      unsupported: "blocked",
    });
    expect(migration.lifecycle.map((phase: any) => phase.phase)).toEqual([
      "inventory",
      "preview",
      "approve",
      "prepare_recovery",
      "publish_entities",
      "validate_graph",
      "cutover",
      "cutover_complete",
    ]);
    expect(migration.durable_evidence.required_before_entity_publication).toEqual(
      expect.arrayContaining(["complete old-to-new ID mapping", "recovery snapshot and cutover journal"]),
    );
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

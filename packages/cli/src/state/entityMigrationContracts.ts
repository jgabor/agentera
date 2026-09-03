import type { JsonObject } from "../core/jsonValue.js";

export type EntityMigrationClassification = "verified_full" | "recoverable_degraded_full_projection" | "valid_compacted_summary" | "duplicate" | "conflict" | "corrupt" | "unsupported" | "historical_projection_residue";

export interface EntityMigrationRelationship {
  field: string;
  target_source_identity: string | null;
  target_id: string | null;
  status: "resolved" | "unresolved";
}

export interface EntityMigrationEntry {
  source_identity: string;
  source_paths: string[];
  artifact: string | null;
  boundary: string | null;
  classification: EntityMigrationClassification;
  detail_availability: "full" | "summary" | "unavailable";
  compatibility: "current" | "degraded";
  provenance: string[];
  content_sha256: string | null;
  content_sha256s: string[];
  physical_record_count: number;
  proposed_target: { id: string; path: string } | null;
  target_sha256: string | null;
  relationships: EntityMigrationRelationship[];
  recovery: string;
  migration_provenance?: JsonObject | JsonObject[];
  canonical_migration_provenance?: JsonObject;
}

export interface DurableEntityMigrationEntry extends EntityMigrationEntry {
  record: JsonObject;
}

export interface DurableEntityMigrationSource {
  path: string;
  presence: "file" | "missing";
  size: number;
  sha256: string | null;
  mode: number | null;
  dev: string | null;
  ino: string | null;
  type: "file" | null;
  bytes_base64: string | null;
}

export interface DurableEntityMigrationPlan {
  project: string;
  source_fingerprint: string;
  preview_digest: string;
  authority_schema_version: string;
  authority_sha256: string;
  preserved_singletons: Array<{ boundary: string; source_path: string; presence: "file" | "missing" | "unsafe"; content_sha256: string | null; preserved_sections?: string[] }>;
  entries: DurableEntityMigrationEntry[];
  preserved_residues: DurableEntityMigrationEntry[];
  sources: DurableEntityMigrationSource[];
  counts: Record<EntityMigrationClassification | "total" | "publishable_entities" | "physical_records" | "logical_identities" | "mirrors" | "duplicates" | "conflicts" | "relationships" | "unresolved_relationships" | "root_blockers" | "dependent_blockers" | "blockers", number>;
  diagnostics: Array<{ classification: EntityMigrationClassification | "dependent_blocker"; path: string; source_identity: string; relationship_field?: string; target_source_identity?: string | null; root_source_identity?: string; message: string; recovery: string }>;
  todo_reconciliation?: { public_path: string; mapping_sha256: string; markdown_before_base64: string; markdown_after: string; activation_after: string };
}

export interface EntityMigrationPreview {
  schemaVersion: "agentera.entityMigrationPreview.v1";
  command: "upgrade";
  status: "ready" | "blocked";
  mode: "preview";
  project: string;
  read_only: true;
  mutation_intent: false;
  mutation_performed: false;
  source_fingerprint: string;
  preview_digest: string;
  preserved_singletons: Array<{ boundary: string; source_path: string; presence: "file" | "missing" | "unsafe"; content_sha256: string | null; preserved_sections?: string[] }>;
  entries: EntityMigrationEntry[];
  preserved_residues: EntityMigrationEntry[];
  counts: Record<EntityMigrationClassification | "total" | "publishable_entities" | "physical_records" | "logical_identities" | "mirrors" | "duplicates" | "conflicts" | "relationships" | "unresolved_relationships" | "root_blockers" | "dependent_blockers" | "blockers", number>;
  diagnostics: Array<{
    classification: EntityMigrationClassification | "dependent_blocker";
    path: string;
    source_identity: string;
    relationship_field?: string;
    target_source_identity?: string | null;
    /** Present on every generated graph dependent; identifies the causal source blocker. */
    root_source_identity?: string;
    message: string;
    recovery: string;
  }>;
  omitted: boolean;
  omitted_count: number;
  diagnostics_omitted_count: number;
  omission_reason: "result_limit" | "output_byte_budget" | null;
  page_after: string | null;
  next_after: string | null;
  retrieval: { command: string };
  source_contract: { authority: string; authority_schema_version: string; authority_sha256: string; zero_write: true; scalar_truncation: "forbidden"; apply_owner: "full development-channel upgrade --yes" };
}

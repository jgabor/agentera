const REFERENCE = "entity_target.declared_compacted_summary_contract.source_row_provenance";
const BOUNDARIES = new Set(["progress_summary", "decision_summary", "health_summary"]);

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}

/** Validate the one source-row digest semantic contract used by every summary boundary. */
export function validateCompactedSummarySourceRowAuthority(target: Record<string, unknown>, authorityPath: string): void {
  const compacted = mapping(target.declared_compacted_summary_contract) ? target.declared_compacted_summary_contract : null;
  const semantic = mapping(compacted?.source_row_provenance) ? compacted.source_row_provenance : null;
  const digest = mapping(semantic?.source_record_sha256) ? semantic.source_record_sha256 : null;
  const accepted = strings(semantic?.accepted_parsed_row_values).sort();
  if (
    semantic?.status !== "implemented" ||
    semantic.semantic_id !== "v2_compacted_summary_physical_row.v1" ||
    accepted.length !== 2 ||
    accepted[0] !== "mapping" ||
    accepted[1] !== "scalar_string" ||
    typeof semantic.normalization !== "string" ||
    digest?.format !== "lowercase_sha256_hex" ||
    typeof digest.input !== "string" ||
    typeof digest.canonicalization !== "string"
  )
    throw new Error(`invalid compacted-summary source-row provenance declaration in '${authorityPath}'`);

  const declared = Array.isArray(compacted?.boundaries) ? compacted.boundaries : [];
  const primary = Array.isArray(target.entities) ? target.entities : [];
  for (const [scope, entries, provenance] of [
    ["primary", primary, (entry: Record<string, unknown>) => (mapping(entry.canonical_metadata) && mapping(entry.canonical_metadata.summary_migration_provenance) ? entry.canonical_metadata.summary_migration_provenance : null)],
    ["declared", declared, (entry: Record<string, unknown>) => (mapping(entry.record) && mapping(entry.record.migration_provenance) ? entry.record.migration_provenance : null)],
  ] as const) {
    for (const entry of entries) {
      if (!mapping(entry) || !BOUNDARIES.has(String(entry.boundary))) continue;
      if (provenance(entry)?.source_row_provenance !== REFERENCE) throw new Error(`${scope} summary boundary '${entry.boundary}' must reference the compacted-summary source-row provenance declaration in '${authorityPath}'`);
    }
  }
}

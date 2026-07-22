import { createHash } from "node:crypto";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { canonicalMigrationRecord } from "./canonicalMigrationRecord.js";
import { legacySummaryRecord } from "./legacySummaryRecord.js";
import { readBoundMigrationSource, type MigrationSourceBindingContext } from "./migrationSourceBinding.js";

export interface SummaryMigrationProvenanceDeclaration {
  sources: Array<{ path: string; collections: string[] }>;
}

function mapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function summaryMigrationProvenanceDeclaration(value: JsonObject, authorityPath: string): SummaryMigrationProvenanceDeclaration {
  if (!Array.isArray(value.sources)) throw new Error(`invalid summary migration provenance sources declaration in '${authorityPath}'`);
  return { sources: value.sources.map((source) => {
    if (!mapping(source) || typeof source.path !== "string" || !Array.isArray(source.collections) || !source.collections.every((collection) => typeof collection === "string")) {
      throw new Error(`invalid summary migration provenance source declaration in '${authorityPath}'`);
    }
    return { path: source.path, collections: source.collections };
  }) };
}

/** Bind a degraded summary to one declared legacy source record, without reopening arbitrary project paths. */
export function summaryMigrationProvenanceViolations(
  boundary: string,
  record: JsonObject,
  declaration: SummaryMigrationProvenanceDeclaration,
  forbiddenAliases: readonly string[],
  binding?: MigrationSourceBindingContext,
): string[] {
  const provenance = record.migration_provenance;
  if (!mapping(provenance)) return ["migration_provenance must be a mapping"];
  if (canonicalRecordJson(Object.keys(provenance).sort()) !== canonicalRecordJson(["source_path", "source_record_sha256"])) {
    return ["migration_provenance must contain exactly source_path and source_record_sha256"];
  }
  if (typeof record.summary !== "string") return ["summary must be a string"];
  const sourcePath = provenance.source_path;
  const sourceDigest = provenance.source_record_sha256;
  const declaredSource = typeof sourcePath === "string" ? declaration.sources.find((source) => source.path === sourcePath) : undefined;
  if (!declaredSource) return ["migration_provenance.source_path must be an authority-declared preserved aggregate path"];
  if (typeof sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(sourceDigest)) return ["migration_provenance.source_record_sha256 must be a lowercase SHA-256 digest"];
  if (binding === undefined) return ["migration_provenance requires a source binding context for a compacted summary"];

  const source = readBoundMigrationSource(binding, declaredSource.path);
  if (source.kind !== "file") return [`migration_provenance source '${declaredSource.path}' is ${source.kind === "missing" ? "missing" : `unsafe (${source.reason})`}`];
  let document: JsonObject;
  try { document = loadYamlMapping(source.bytes) as JsonObject; }
  catch (error) { return [`migration_provenance source '${declaredSource.path}' is invalid YAML: ${(error as Error).message}`]; }
  const retained = structuredClone(record);
  delete retained.migration_provenance;
  const candidates = declaredSource.collections.flatMap((collection) => {
    const rows = document[collection];
    return Array.isArray(rows) ? rows.flatMap((physical) => {
      const candidate = legacySummaryRecord(physical);
      return candidate ? [{ physical, candidate }] : [];
    }) : [];
  }).filter(({ physical, candidate }) => (typeof candidate.summary === "string" || candidate.detail_availability === "summary_only")
    && createHash("sha256").update(canonicalRecordJson(physical)).digest("hex") === sourceDigest
    && canonicalRecordJson(canonicalMigrationRecord(boundary, candidate, forbiddenAliases)) === canonicalRecordJson(retained));
  const canonicalCandidates = new Set(candidates.map(({ candidate }) => canonicalRecordJson(canonicalMigrationRecord(boundary, candidate, forbiddenAliases))));
  if (canonicalCandidates.size !== 1) return [canonicalCandidates.size === 0
    ? "migration_provenance does not bind a retained canonical summary to a declared source record"
    : "migration_provenance ambiguously binds divergent declared source summary records"];
  return [];
}

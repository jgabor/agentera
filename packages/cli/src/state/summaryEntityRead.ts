import type { JsonObject } from "../core/jsonValue.js";
import type { DiscoveredEntity } from "./entityStorage.js";

export function isSummaryEntity(entity: DiscoveredEntity): boolean {
  return entity.boundary === "progress_summary" || entity.boundary === "decision_summary" || entity.boundary === "health_summary";
}

export function summaryCaveat(artifact: string): string {
  return `${artifact} summary is immutable migrated history: incomplete historical evidence is read-only and full record detail is unavailable.`;
}

export function detailMetadata(entity: DiscoveredEntity): JsonObject {
  const summary = isSummaryEntity(entity);
  return {
    boundary: entity.boundary!,
    detail_availability: summary ? "summary" : "full",
    compatibility: summary ? "degraded" : "current",
    ...(summary ? { caveats: [summaryCaveat(entity.artifact!)] } : {}),
  };
}

export function detailProvenance(projectRelativePath: string, entity: DiscoveredEntity): JsonObject {
  const summary = isSummaryEntity(entity);
  return {
    storage: "canonical_entity_file",
    path: projectRelativePath,
    boundary: entity.boundary!,
    detail: summary ? "summary" : "full",
    ...(summary ? { migration_provenance: entity.record!.migration_provenance } : {}),
  };
}

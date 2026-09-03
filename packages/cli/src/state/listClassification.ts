export type StateClassification = "canonical" | "mirrored" | "duplicate" | "conflict" | "ambiguous" | "unaddressable" | "corrupt";

export interface StateClassificationRow {
  source: "current_projection" | "archive";
  origin: "active" | "summary" | "numbered_archive" | "rejected_archive";
  identity: "canonical_number" | "explicit_decision_shorthand" | "unaddressable" | "ambiguous";
  entryNumber: number | null;
  representation: "full" | "summary" | "unavailable";
  projectionHash: string;
  rejection?: { reason: string };
}

/** The one row-group classification used by state list and startup projections. */
export function classifyStateRows(rows: StateClassificationRow[]): StateClassification {
  if (rows.some((row) => row.rejection)) return "corrupt";
  if (rows.some((row) => row.identity === "ambiguous")) return "ambiguous";
  const comparable = rows.filter((row) => row.representation === "full");
  if (new Set(comparable.map((row) => row.projectionHash)).size > 1) return "conflict";
  const currentRows = rows.filter((row) => row.source === "current_projection");
  const archiveRows = rows.filter((row) => row.source === "archive" && row.origin === "numbered_archive");
  if (archiveRows.length > 0 && currentRows.length > 0 && currentRows.length === 1) return "mirrored";
  if (rows.length > 1) return "duplicate";
  return "canonical";
}

import type { JsonObject } from "../core/jsonValue.js";

interface CountRow {
  source: "current_projection" | "archive";
  origin: string;
  identity: "canonical_number" | "explicit_decision_shorthand" | "unaddressable" | "ambiguous";
  entryNumber: number | null;
  representation: "full" | "summary" | "unavailable";
  projectionHash: string;
}

interface CountCandidate {
  stableId: string | null;
  classification: "canonical" | "mirrored" | "duplicate" | "conflict" | "ambiguous" | "unaddressable" | "corrupt";
  rows: CountRow[];
}

export function physicalCounts(candidates: CountCandidate[]): JsonObject {
  let physical = 0;
  let addressable = 0;
  let unaddressable = 0;
  let ambiguous = 0;
  let mirrored = 0;
  let duplicate = 0;
  let conflict = 0;
  for (const candidate of candidates) {
    physical += candidate.rows.length;
    for (const row of candidate.rows) {
      if (row.entryNumber !== null && row.identity !== "ambiguous") addressable += 1;
      else if (row.identity === "ambiguous") ambiguous += 1;
      else unaddressable += 1;
    }
    const currentRows = candidate.rows.filter((row) => row.source === "current_projection");
    const archiveRows = candidate.rows.filter((row) => row.source === "archive" && row.origin === "numbered_archive");
    const comparable = candidate.rows.filter((row) => row.representation === "full");
    const exactMirror = archiveRows.length > 0 && currentRows.length > 0 && new Set(comparable.map((row) => row.projectionHash)).size <= 1;
    if (exactMirror) mirrored += 1;
    if (candidate.classification === "duplicate") duplicate += Math.max(0, candidate.rows.length - 1 - (exactMirror ? 1 : 0));
    if (candidate.classification === "conflict") conflict += Math.max(0, candidate.rows.length - 1);
  }
  return {
    physical,
    addressable,
    addressable_ids: candidates.filter((candidate) => candidate.stableId !== null).length,
    unaddressable,
    ambiguous,
    canonical: Math.max(0, addressable - mirrored - duplicate - conflict),
    mirrored,
    duplicate,
    conflict,
    logical: candidates.length,
  };
}

export function provenanceCounts(entries: JsonObject[]): JsonObject {
  const counts: JsonObject = { archive: 0, legacy_full: 0, legacy_summary: 0, unavailable: 0 };
  for (const entry of entries) {
    const source = String(entry.source ?? "unavailable");
    if (source in counts) counts[source] = Number(counts[source]) + 1;
    else counts.unavailable = Number(counts.unavailable) + 1;
  }
  counts.candidate_count = entries.length;
  return counts;
}

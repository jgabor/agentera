import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";

export const PERSISTED_OBJECTIVE_ID = /^objective:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const LEGACY_OBJECTIVE_ID = /^legacy-objective:[0-9a-f]{64}$/;
export const OBJECTIVE_ID = /^(objective:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|legacy-objective:[0-9a-f]{64})$/;

function mapping(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function list(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((entry): entry is JsonObject => entry !== null && typeof entry === "object" && !Array.isArray(entry)) : [];
}

/** Identity inputs deliberately exclude title, lifecycle, closure, root, and slug. */
export function canonicalObjectiveIdentityDocument(document: JsonObject): JsonObject {
  const objective = mapping(document.objective);
  return {
    baseline: mapping(document.baseline),
    constraints: document.constraints ?? objective.constraints ?? [],
    description: objective.description ?? document.description ?? "",
    gates: mapping(document.gates),
    measurement: objective.measurement ?? document.measurement ?? "",
    metric: mapping(document.metric),
    scope: mapping(document.scope),
  };
}

export interface ObjectiveIdentity {
  stableId: string;
  persisted: boolean;
  canonicalJson: string;
  compatibility: "canonical" | "legacy_derived_identity";
}

export function resolveObjectiveIdentity(document: JsonObject): ObjectiveIdentity {
  const canonicalJson = canonicalRecordJson(canonicalObjectiveIdentityDocument(document));
  const persisted = mapping(document.header).id;
  if (persisted !== undefined) {
    if (typeof persisted !== "string" || !PERSISTED_OBJECTIVE_ID.test(persisted)) {
      throw new Error("objective header.id is not a valid persisted objective identity");
    }
    return { stableId: persisted, persisted: true, canonicalJson, compatibility: "canonical" };
  }
  return {
    stableId: `legacy-objective:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`,
    persisted: false,
    canonicalJson,
    compatibility: "legacy_derived_identity",
  };
}

export interface ObjectiveArtifactCandidate {
  stableId: string;
  persisted: boolean;
  canonicalJson: string;
  compatibility: ObjectiveIdentity["compatibility"];
  paths: string[];
  slugs: string[];
  roots: Array<"optimize" | "optimera">;
  ambiguous: boolean;
}

export interface ObjectiveIdentityDiagnostic extends JsonObject {
  class: "ambiguous" | "corrupt";
  message: string;
  candidate_paths: string[];
}

export interface ObjectiveArtifactDiscovery {
  objectives: ObjectiveArtifactCandidate[];
  diagnostics: ObjectiveIdentityDiagnostic[];
}

interface InspectedObjective extends ObjectiveIdentity {
  path: string;
  slug: string;
  root: "optimize" | "optimera";
}

export function discoverObjectiveArtifacts(projectRoot: string): ObjectiveArtifactDiscovery {
  const inspected: InspectedObjective[] = [];
  const diagnostics: ObjectiveIdentityDiagnostic[] = [];
  for (const root of ["optimize", "optimera"] as const) {
    const directory = path.join(projectRoot, ".agentera", root);
    let slugs: string[] = [];
    try {
      slugs = fs.readdirSync(directory).sort();
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const objectivePath = path.join(directory, slug, "objective.yaml");
      if (!fs.existsSync(objectivePath)) continue;
      try {
        const identity = resolveObjectiveIdentity(loadYamlMapping(fs.readFileSync(objectivePath, "utf8")) as JsonObject);
        inspected.push({ ...identity, path: objectivePath, slug, root });
      } catch (error) {
        diagnostics.push({
          class: "corrupt",
          message: (error as Error).message,
          candidate_paths: [objectivePath],
        });
      }
    }
  }

  const objectives: ObjectiveArtifactCandidate[] = [];
  for (const stableId of [...new Set(inspected.map((candidate) => candidate.stableId))].sort()) {
    const candidates = inspected.filter((candidate) => candidate.stableId === stableId);
    const ambiguous = new Set(candidates.map((candidate) => candidate.canonicalJson)).size > 1;
    if (ambiguous) {
      diagnostics.push({
        class: "ambiguous",
        message: `objective identity ${stableId} resolves to conflicting documents`,
        stable_id: stableId,
        candidate_paths: candidates.map((candidate) => candidate.path).sort(),
      });
    }
    objectives.push({
      stableId,
      persisted: candidates.every((candidate) => candidate.persisted),
      canonicalJson: candidates[0].canonicalJson,
      compatibility: candidates.every((candidate) => candidate.persisted) ? "canonical" : "legacy_derived_identity",
      paths: candidates.map((candidate) => candidate.path).sort(),
      slugs: [...new Set(candidates.map((candidate) => candidate.slug))].sort(),
      roots: [...new Set(candidates.map((candidate) => candidate.root))].sort(),
      ambiguous,
    });
  }

  for (const slug of [...new Set(inspected.map((candidate) => candidate.slug))].sort()) {
    const candidates = inspected.filter((candidate) => candidate.slug === slug);
    const roots = new Set(candidates.map((candidate) => candidate.root));
    const candidateIds = [...new Set(candidates.map((candidate) => candidate.stableId))].sort();
    if (roots.size === 2 && candidateIds.length > 1) {
      const candidatePaths = candidates.map((candidate) => candidate.path).sort();
      diagnostics.push({
        class: "ambiguous",
        message: `canonical and legacy objective roots conflict for slug ${slug}`,
        slug,
        candidate_ids: candidateIds,
        candidate_paths: candidatePaths,
      });
      for (const objective of objectives.filter((candidate) => candidateIds.includes(candidate.stableId))) objective.ambiguous = true;
    }
  }
  return { objectives, diagnostics };
}

export type ExperimentCompatibility = "canonical" | "legacy_missing_identity" | "legacy_duplicate_identity" | "legacy_invalid_identity";

export interface ExperimentIdentityEntry {
  stableId: string | null;
  number: number | null;
  addressable: boolean;
  compatibility: ExperimentCompatibility;
  provenance: { collection: string; index: number };
  data: JsonObject;
  caveats: string[];
}

export interface ExperimentIdentityProjection {
  objectiveId: string;
  entries: ExperimentIdentityEntry[];
  caveats: string[];
}

export function inspectExperimentIdentities(objectiveId: string, document: JsonObject): ExperimentIdentityProjection {
  if (!OBJECTIVE_ID.test(objectiveId)) throw new Error("objective identity is invalid");
  const collections: Array<[string, JsonObject[]]> = [
    ["experiments", list(document.experiments)],
    ["archive", list(document.archive)],
    ["archived_experiments", list(document.archived_experiments)],
  ];
  const counts = new Map<number, number>();
  for (const [, entries] of collections) {
    for (const entry of entries) {
      if (Number.isInteger(entry.number) && Number(entry.number) >= 0) counts.set(Number(entry.number), (counts.get(Number(entry.number)) ?? 0) + 1);
    }
  }
  const caveats: string[] = [];
  const entries = collections.flatMap(([collection, values]) => values.map((data, index): ExperimentIdentityEntry => {
    const number = Number.isInteger(data.number) && Number(data.number) >= 0 ? Number(data.number) : null;
    let compatibility: ExperimentCompatibility = "canonical";
    const entryCaveats: string[] = [];
    if (data.number === undefined || data.number === null) {
      compatibility = "legacy_missing_identity";
      entryCaveats.push(`legacy ${collection}[${index}] is missing experiment number and remains visible but unaddressable`);
    } else if (number === null) {
      compatibility = "legacy_invalid_identity";
      entryCaveats.push(`legacy ${collection}[${index}] has invalid experiment number and remains visible but unaddressable`);
    } else if ((counts.get(number) ?? 0) > 1) {
      compatibility = "legacy_duplicate_identity";
      entryCaveats.push(`duplicate experiment number ${number} remains visible but ambiguous and unaddressable`);
    }
    caveats.push(...entryCaveats);
    return {
      stableId: number === null ? null : `${objectiveId}/experiment:${number}`,
      number,
      addressable: compatibility === "canonical",
      compatibility,
      provenance: { collection, index },
      data,
      caveats: entryCaveats,
    };
  }));
  return { objectiveId, entries, caveats: [...new Set(caveats)] };
}

export class ExperimentIdentityError extends Error {
  constructor(
    public readonly className: "invalid_request" | "not_found" | "ambiguous",
    message: string,
    public readonly details: JsonObject = {},
  ) {
    super(message);
    this.name = "ExperimentIdentityError";
  }
}

/** Pure preflight used by later publication work; this function never changes project state. */
export function validateExperimentPublicationIdentity(
  discovery: ObjectiveArtifactDiscovery,
  projection: ExperimentIdentityProjection,
  objectiveId: string,
  number: number,
): string {
  if (!OBJECTIVE_ID.test(objectiveId) || !Number.isInteger(number) || number < 0) {
    throw new ExperimentIdentityError("invalid_request", "publication requires a valid objective identity and non-negative integer experiment number");
  }
  const objective = discovery.objectives.find((candidate) => candidate.stableId === objectiveId);
  if (!objective) throw new ExperimentIdentityError("not_found", `objective identity ${objectiveId} was not found`);
  if (objective.ambiguous || projection.objectiveId !== objectiveId || projection.entries.some((entry) => !entry.addressable)) {
    throw new ExperimentIdentityError("ambiguous", "experiment publication identity is ambiguous; no effects are allowed", {
      stable_id: `${objectiveId}/experiment:${number}`,
      candidate_paths: objective.paths,
      compatibility_caveats: projection.caveats,
    });
  }
  const stableId = `${objectiveId}/experiment:${number}`;
  if (projection.entries.some((entry) => entry.stableId === stableId)) {
    throw new ExperimentIdentityError("ambiguous", `experiment identity ${stableId} already exists; no effects are allowed`, { stable_id: stableId });
  }
  return stableId;
}

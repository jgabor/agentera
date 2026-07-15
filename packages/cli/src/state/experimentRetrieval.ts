import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import YAML from "yaml";

import type { JsonObject, JsonValue } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureBody } from "./directRetrieval.js";
import {
  OBJECTIVE_ID,
  discoverObjectiveArtifacts,
  inspectExperimentIdentities,
  type ExperimentIdentityEntry,
  type ObjectiveArtifactCandidate,
} from "./experimentIdentity.js";

const CURSOR_VERSION = 1;
const ORDER = "experiment_number_desc";
const MAX_LIST_BYTES = 32_768;
const AUTHORITY = "references/artifacts/state-storage-authority.yaml";

type Format = "text" | "json" | "yaml";

interface ProjectionSource {
  path: string;
  collection: string;
  index: number;
  record: JsonObject;
  addressable: boolean;
  compatibility: string;
  caveats: string[];
}

interface ArchiveSource {
  path: string;
  record: JsonObject;
  recordSha256: string;
  provenance: JsonObject;
}

interface ArchiveDiagnostic extends JsonObject {
  class: "corrupt";
  path: string;
  message: string;
  experiment_number: number | null;
}

interface LogicalExperiment {
  key: string;
  stableId: string | null;
  number: number | null;
  projection: ProjectionSource[];
  archives: ArchiveSource[];
  addressable: boolean;
  compatibility: string;
  detailAvailability: "full" | "summary" | "unavailable";
  source: string;
  fingerprint: string;
}

interface LoadedObjective {
  objective: ObjectiveArtifactCandidate;
  experiments: LogicalExperiment[];
  diagnostics: JsonObject[];
}

interface CursorPayload {
  version: number;
  collection: "experiments.records";
  objective_id: string;
  order: typeof ORDER;
  snapshot_id: string;
  candidate_keys: string[];
  diagnostic_hash: string;
  after: number;
}

export interface ExperimentListResponse {
  schemaVersion: "agentera.stateRetrieval.v1";
  command: "state experiments list";
  status: "ok" | "degraded";
  entries: JsonValue[];
  counts: JsonObject;
  order: typeof ORDER;
  filters: JsonObject;
  snapshot: JsonObject;
  source: JsonObject;
  source_contract: JsonObject;
  retrieval: JsonObject;
  omitted: boolean;
  omitted_count: number;
  omission_reason: string | null;
  next_cursor?: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalRecordJson(value), "utf8").digest("hex");
}

function mapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(
  exitCode: 1 | 2,
  className: StateFailureBody["error"]["class"],
  message: string,
  verb: "list" | "get",
  details: Partial<StateFailureBody["error"]> = {},
): StateRetrievalFailure {
  const list = verb === "list";
  return new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: className,
      message,
      syntax: list
        ? "agentera state experiments list --objective OBJECTIVE_ID [--limit N] [--cursor TOKEN] --format json"
        : "agentera state experiments get --objective OBJECTIVE_ID --number N --format json",
      example: list
        ? "agentera state experiments list --objective objective:123e4567-e89b-42d3-a456-426614174000 --limit 20 --format json"
        : "agentera state experiments get --objective objective:123e4567-e89b-42d3-a456-426614174000 --number 0 --format json",
      recovery: details.recovery ?? "Correct the objective-scoped experiment command and retry; no state was changed.",
      valid_values: list
        ? ["--objective OBJECTIVE_ID", "--limit 1..100", "--cursor TOKEN", "--format text|json|yaml"]
        : ["--objective OBJECTIVE_ID", "--number 0|1|2|...", "--format text|json|yaml"],
      ...details,
    },
  }, exitCode);
}

function selectedObjective(projectRoot: string, objectiveId: string, verb: "list" | "get"): ObjectiveArtifactCandidate {
  if (!OBJECTIVE_ID.test(objectiveId)) {
    throw fail(2, "invalid_request", `invalid objective identity '${objectiveId}'`, verb, {
      valid_values: ["objective:<lowercase-rfc9562-uuid>", "legacy-objective:<64-lowercase-hex-digest>"],
    });
  }
  const discovery = discoverObjectiveArtifacts(projectRoot);
  const objective = discovery.objectives.find((candidate) => candidate.stableId === objectiveId);
  if (!objective) {
    throw fail(1, "not_found", `objective identity '${objectiveId}' was not found`, verb, {
      stable_id: objectiveId,
      recovery: "Use an objective identity returned by Agentera objective state, then retry.",
      details: { compatibility_diagnostics: discovery.diagnostics },
    });
  }
  if (objective.ambiguous) {
    throw fail(1, "ambiguous", `objective identity '${objectiveId}' resolves to incompatible canonical or legacy candidates`, verb, {
      stable_id: objectiveId,
      recovery: "Repair the objective identity/root collision; Agentera will not choose by path or root preference.",
      details: { candidate_paths: objective.paths, compatibility_diagnostics: discovery.diagnostics },
    });
  }
  return objective;
}

function readProjection(objectiveId: string, objectivePath: string): { sources: ProjectionSource[]; diagnostics: JsonObject[] } {
  const projectionPath = path.join(path.dirname(objectivePath), "experiments.yaml");
  if (!fs.existsSync(projectionPath)) return { sources: [], diagnostics: [] };
  try {
    const projection = inspectExperimentIdentities(objectiveId, loadYamlMapping(fs.readFileSync(projectionPath, "utf8")) as JsonObject);
    return {
      sources: projection.entries.map((entry: ExperimentIdentityEntry): ProjectionSource => ({
        path: projectionPath,
        collection: entry.provenance.collection,
        index: entry.provenance.index,
        record: entry.data,
        addressable: entry.addressable,
        compatibility: entry.compatibility,
        caveats: entry.caveats,
      })),
      diagnostics: projection.caveats.map((message) => ({ class: "compatibility", path: projectionPath, message })),
    };
  } catch (error) {
    throw fail(1, "corrupt", `experiment projection '${projectionPath}' cannot be read safely`, "list", {
      recovery: "Repair the selected objective's experiments.yaml, then retry.",
      details: { path: projectionPath, message: (error as Error).message },
    });
  }
}

function archiveNumber(filename: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)\.yaml$/.test(filename)) return undefined;
  const number = Number(filename.slice(0, -5));
  return Number.isSafeInteger(number) ? number : undefined;
}

function readArchives(objectiveId: string, objectivePath: string): { sources: ArchiveSource[]; diagnostics: ArchiveDiagnostic[] } {
  const directory = path.join(path.dirname(objectivePath), "archive", "experiments");
  let names: string[];
  try {
    names = fs.readdirSync(directory).sort();
  } catch {
    return { sources: [], diagnostics: [] };
  }
  const sources: ArchiveSource[] = [];
  const diagnostics: ArchiveDiagnostic[] = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const number = archiveNumber(name);
    try {
      if (number === undefined || fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()) throw new Error("archive filename or file type is invalid");
      const envelope = loadYamlMapping(fs.readFileSync(file, "utf8")) as JsonObject;
      const stableId = `${objectiveId}/experiment:${number}`;
      if (envelope.schemaVersion !== "agentera.experimentArchive.v1") throw new Error("unsupported experiment archive schemaVersion");
      if (envelope.objective_id !== objectiveId || envelope.experiment_number !== number || envelope.stable_id !== stableId) throw new Error("archive identity does not match its objective-scoped path");
      if (!mapping(envelope.record) || envelope.record.number !== number) throw new Error("archive record number does not match its envelope");
      const digest = hash(envelope.record);
      if (envelope.record_sha256 !== digest) throw new Error("archive record_sha256 does not match its record");
      if (!mapping(envelope.provenance) || envelope.provenance.authority !== AUTHORITY || envelope.provenance.objective_id !== objectiveId || envelope.provenance.experiment_id !== stableId) {
        throw new Error("archive provenance does not match its authority and identity");
      }
      sources.push({ path: file, record: envelope.record, recordSha256: digest, provenance: envelope.provenance });
    } catch (error) {
      diagnostics.push({ class: "corrupt", path: file, message: (error as Error).message, experiment_number: number ?? null });
    }
  }
  return { sources, diagnostics };
}

function logicalExperiment(objectiveId: string, number: number, projection: ProjectionSource[], archives: ArchiveSource[]): LogicalExperiment {
  const stableId = `${objectiveId}/experiment:${number}`;
  const projectionPaths = new Map<string, ProjectionSource[]>();
  for (const source of projection) projectionPaths.set(source.path, [...(projectionPaths.get(source.path) ?? []), source]);
  const duplicateProjection = [...projectionPaths.values()].some((sources) => sources.length > 1);
  const projectionHashes = new Set(projection.map((source) => hash(source.record)));
  const archiveHashes = new Set(archives.map((source) => source.recordSha256));
  const fullProjection = projection.filter((source) => source.collection === "experiments");
  const summaryProjection = projection.filter((source) => source.collection !== "experiments");
  const summaryDetail = summaryProjection.some((source) => Object.keys(source.record).some((field) => field !== "number"));
  const immutableConflict = archiveHashes.size > 1 || (archives.length > 0 && fullProjection.some((source) => !archiveHashes.has(hash(source.record))));
  const duplicate = duplicateProjection || projectionHashes.size > 1 && projection.length > 1;
  const detailAvailability = archives.length > 0 || fullProjection.length > 0 ? "full" : summaryDetail ? "summary" : "unavailable";
  const compatibility = immutableConflict
    ? "immutable_conflict"
    : duplicate
      ? "legacy_duplicate_identity"
      : archives.length > 0
        ? "canonical_archive"
        : fullProjection.length > 0
          ? "legacy_full_without_archive"
          : summaryDetail ? "legacy_summary_only" : "legacy_detail_unavailable";
  const source = archives.length > 0
    ? projection.length > 0 ? "archive_and_projection" : "immutable_archive"
    : fullProjection.length > 0 ? "retained_projection" : "legacy_summary_projection";
  const fingerprint = hash({
    stable_id: stableId,
    projection: projection.map((item) => ({ path: item.path, collection: item.collection, index: item.index, hash: hash(item.record) })),
    archives: archives.map((item) => ({ path: item.path, hash: item.recordSha256 })),
    compatibility,
  });
  return { key: stableId, stableId, number, projection, archives, addressable: !immutableConflict && !duplicate, compatibility, detailAvailability, source, fingerprint };
}

function loadObjective(projectRoot: string, objectiveId: string, verb: "list" | "get"): LoadedObjective {
  const objective = selectedObjective(projectRoot, objectiveId, verb);
  const projections: ProjectionSource[] = [];
  const archives: ArchiveSource[] = [];
  const diagnostics: JsonObject[] = [];
  for (const objectivePath of objective.paths) {
    const projection = readProjection(objectiveId, objectivePath);
    projections.push(...projection.sources);
    diagnostics.push(...projection.diagnostics);
    const archive = readArchives(objectiveId, objectivePath);
    archives.push(...archive.sources);
    diagnostics.push(...archive.diagnostics);
  }
  const numbers = [...new Set([
    ...projections.map((source) => Number(source.record.number)).filter((number) => Number.isSafeInteger(number) && number >= 0),
    ...archives.map((source) => Number(source.record.number)),
  ])].sort((left, right) => right - left);
  const experiments = numbers.map((number) => logicalExperiment(
    objectiveId,
    number,
    projections.filter((source) => source.record.number === number),
    archives.filter((source) => source.record.number === number),
  ));
  for (const source of projections.filter((item) => !Number.isSafeInteger(item.record.number) || Number(item.record.number) < 0)) {
    const fingerprint = hash({ path: source.path, collection: source.collection, index: source.index, record: source.record });
    experiments.push({
      key: `unaddressable:${fingerprint}`,
      stableId: null,
      number: null,
      projection: [source],
      archives: [],
      addressable: false,
      compatibility: source.compatibility,
      detailAvailability: source.collection === "experiments" ? "full" : "summary",
      source: "legacy_unaddressable_projection",
      fingerprint,
    });
  }
  return { objective, experiments, diagnostics };
}

function provenance(experiment: LogicalExperiment, objective: ObjectiveArtifactCandidate): JsonObject {
  return {
    objective: {
      stable_id: objective.stableId,
      compatibility: objective.compatibility,
      paths: objective.paths,
      roots: objective.roots,
      slugs: objective.slugs,
    },
    projection: experiment.projection.map((source) => ({ path: source.path, collection: source.collection, index: source.index })),
    archive: experiment.archives.map((source) => ({ path: source.path, record_sha256: source.recordSha256, provenance: source.provenance })),
  };
}

function summaryRecord(experiment: LogicalExperiment): JsonObject | undefined {
  const source = experiment.projection[0]?.record ?? experiment.archives[0]?.record;
  if (!source) return undefined;
  const summary: JsonObject = {};
  for (const field of ["date", "label", "status", "summary", "conclusion"]) if (source[field] !== undefined) summary[field] = source[field]!;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function listEntry(experiment: LogicalExperiment, objective: ObjectiveArtifactCandidate): JsonObject {
  return {
    stable_id: experiment.stableId,
    artifact_id: "experiments",
    experiment_number: experiment.number,
    addressable: experiment.addressable,
    detail_availability: experiment.detailAvailability,
    compatibility: experiment.compatibility,
    source: experiment.source,
    provenance: provenance(experiment, objective),
    retrieval: experiment.addressable
      ? { get: `agentera state experiments get --objective ${objective.stableId} --number ${experiment.number} --format json` }
      : { get: null, recovery: "Repair the legacy identity or immutable conflict before exact retrieval." },
    ...(summaryRecord(experiment) ? { summary: summaryRecord(experiment)! } : {}),
  };
}

function snapshotId(experiments: LogicalExperiment[]): string {
  return hash({ collection: "experiments.records", order: ORDER, candidates: experiments.map(({ key, fingerprint }) => ({ key, fingerprint })) });
}

function cursorKey(projectRoot: string): Buffer {
  return createHash("sha256").update(`agentera-experiment-cursor\0${path.resolve(projectRoot)}`, "utf8").digest();
}

function sign(payload: CursorPayload, projectRoot: string): string {
  return createHmac("sha256", cursorKey(projectRoot)).update(canonicalRecordJson(payload), "utf8").digest("hex");
}

function encodeCursor(payload: CursorPayload, projectRoot: string): string {
  return deflateRawSync(Buffer.from(JSON.stringify({ ...payload, signature: sign(payload, projectRoot) }), "utf8")).toString("base64url");
}

function parseCursor(token: string, projectRoot: string, objectiveId: string): CursorPayload {
  const invalid = (message: string): never => {
    throw fail(2, "cursor_invalid", message, "list", {
      recovery: "Copy response.next_cursor exactly for the same objective, or omit --cursor to establish a new snapshot.",
      details: { cursor: "opaque; do not parse or construct cursor tokens" },
    });
  };
  if (!token || token.length > 100_000 || !/^[A-Za-z0-9_-]+$/.test(token)) invalid("cursor is not a valid opaque token");
  let decoded: unknown;
  try {
    const compressed = Buffer.from(token, "base64url");
    if (compressed.toString("base64url") !== token) invalid("cursor is not a canonical opaque token");
    decoded = JSON.parse(inflateRawSync(compressed, { maxOutputLength: 1_000_000 }).toString("utf8"));
  } catch {
    invalid("cursor is not a valid opaque token");
  }
  if (!mapping(decoded)) invalid("cursor payload is invalid");
  const { signature, ...unsigned } = decoded as Record<string, unknown>;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) invalid("cursor signature is invalid");
  const expected = sign(unsigned as unknown as CursorPayload, projectRoot);
  if (!timingSafeEqual(Buffer.from(signature as string), Buffer.from(expected))) invalid("cursor signature is invalid");
  if (unsigned.version !== CURSOR_VERSION || unsigned.collection !== "experiments.records" || unsigned.order !== ORDER || unsigned.objective_id !== objectiveId) invalid("cursor is bound to a different collection, objective, or order");
  if (!Number.isSafeInteger(unsigned.after) || Number(unsigned.after) < 1 || !Array.isArray(unsigned.candidate_keys) || (unsigned.candidate_keys as unknown[]).some((key) => typeof key !== "string")) invalid("cursor payload is invalid");
  if (typeof unsigned.snapshot_id !== "string" || !/^[0-9a-f]{64}$/.test(unsigned.snapshot_id) || typeof unsigned.diagnostic_hash !== "string" || !/^[0-9a-f]{64}$/.test(unsigned.diagnostic_hash)) invalid("cursor snapshot is invalid");
  return unsigned as unknown as CursorPayload;
}

function snapshotExperiments(current: LoadedObjective, cursor: CursorPayload): LogicalExperiment[] {
  const byKey = new Map(current.experiments.map((experiment) => [experiment.key, experiment]));
  const experiments = cursor.candidate_keys.map((key) => byKey.get(key));
  if (experiments.some((experiment) => !experiment) || snapshotId(experiments as LogicalExperiment[]) !== cursor.snapshot_id || hash(current.diagnostics) !== cursor.diagnostic_hash) {
    throw fail(1, "cursor_snapshot_unavailable", "the objective experiment snapshot changed and cannot be resumed exactly", "list", {
      recovery: "Start a new experiment listing without --cursor to establish a current objective snapshot.",
      details: { snapshot_id: cursor.snapshot_id },
    });
  }
  return experiments as LogicalExperiment[];
}

function withPage(loaded: LoadedObjective, experiments: LogicalExperiment[], start: number, retained: number, projectRoot: string, reason: string): ExperimentListResponse {
  const selected = experiments.slice(start, start + retained);
  const remaining = experiments.length - start - selected.length;
  const omitted = remaining > 0;
  const snapshot = snapshotId(experiments);
  const response: ExperimentListResponse = {
    schemaVersion: "agentera.stateRetrieval.v1",
    command: "state experiments list",
    status: loaded.diagnostics.length > 0 || loaded.objective.compatibility !== "canonical" || experiments.some((entry) => !entry.addressable || entry.detailAvailability !== "full") ? "degraded" : "ok",
    entries: selected.map((entry) => listEntry(entry, loaded.objective)),
    counts: { total: experiments.length, returned: selected.length, remaining, omitted: remaining, diagnostics: loaded.diagnostics.length },
    order: ORDER,
    filters: { objective: loaded.objective.stableId },
    snapshot: { id: snapshot, candidate_count: experiments.length, has_more: omitted },
    source: {
      artifact: "experiments",
      storage: "objective_projection_and_immutable_objective_archive",
      objective_paths: loaded.objective.paths,
      compatibility_diagnostics: loaded.diagnostics,
    },
    source_contract: {
      authority: AUTHORITY,
      complete_for_experiment_list_retrieval: true,
      storage_ownership: "objective_scoped_durable_records_and_bounded_10_40_50_projection",
    },
    retrieval: { get: `agentera state experiments get --objective ${loaded.objective.stableId} --number N --format json` },
    omitted,
    omitted_count: remaining,
    omission_reason: omitted ? reason : null,
  };
  if (omitted) {
    response.next_cursor = encodeCursor({
      version: CURSOR_VERSION,
      collection: "experiments.records",
      objective_id: loaded.objective.stableId,
      order: ORDER,
      snapshot_id: snapshot,
      candidate_keys: experiments.map((entry) => entry.key),
      diagnostic_hash: hash(loaded.diagnostics),
      after: start + selected.length,
    }, projectRoot);
    response.retrieval.continue = `agentera state experiments list --objective ${loaded.objective.stableId} --limit 20 --cursor ${response.next_cursor} --format json`;
  }
  return response;
}

function serializedBytes(response: ExperimentListResponse, format: Format): number {
  const bytes = format === "yaml" ? YAML.stringify(response) : JSON.stringify(response, null, 2) + "\n";
  return Buffer.byteLength(bytes, "utf8");
}

export function listExperiments(projectRoot: string, objectiveId: string, options: { limit: number; cursor?: string; format: Format }): ExperimentListResponse {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw fail(2, "invalid_request", "experiment list limit must be an integer from 1 through 100", "list", { valid_values: ["1..100"] });
  const loaded = loadObjective(projectRoot, objectiveId, "list");
  const parsed = options.cursor ? parseCursor(options.cursor, projectRoot, objectiveId) : undefined;
  const experiments = parsed ? snapshotExperiments(loaded, parsed) : loaded.experiments;
  const start = parsed?.after ?? 0;
  if (start > experiments.length) throw fail(2, "cursor_invalid", "cursor position is outside its experiment snapshot", "list");
  const requested = Math.min(options.limit, experiments.length - start);
  let response = withPage(loaded, experiments, start, requested, projectRoot, "page_limit");
  if (options.format !== "text") {
    for (let retained = requested; retained > 0 && serializedBytes(response, options.format) > MAX_LIST_BYTES; retained -= 1) response = withPage(loaded, experiments, start, retained - 1, projectRoot, "serialized_output_byte_budget");
    if (serializedBytes(response, options.format) > MAX_LIST_BYTES || (experiments.length > start && response.entries.length === 0)) {
      throw fail(1, "unsupported_state", `one experiment identity cannot fit within the ${MAX_LIST_BYTES}-byte ${options.format.toUpperCase()} list budget`, "list", {
        recovery: `Fetch one known identity with agentera state experiments get --objective ${objectiveId} --number N --format json.`,
      });
    }
  }
  return response;
}

export function getExperiment(projectRoot: string, objectiveId: string, number: number): JsonObject {
  if (!Number.isSafeInteger(number) || number < 0) throw fail(2, "invalid_request", "--number must be a non-negative integer without leading zeros", "get", { valid_values: ["0", "1", "2", "..."] });
  const loaded = loadObjective(projectRoot, objectiveId, "get");
  const corruptArchive = loaded.diagnostics.find((diagnostic) => diagnostic.class === "corrupt" && diagnostic.experiment_number === number);
  if (corruptArchive) throw fail(1, "corrupt", `experiment archive for '${objectiveId}/experiment:${number}' cannot be verified`, "get", {
    stable_id: `${objectiveId}/experiment:${number}`,
    entry_number: number,
    recovery: "Preserve and repair the immutable archive envelope before retrying exact retrieval.",
    details: { diagnostic: corruptArchive },
  });
  const experiment = loaded.experiments.find((candidate) => candidate.number === number);
  if (!experiment) throw fail(1, "not_found", `experiment '${objectiveId}/experiment:${number}' was not found`, "get", {
    stable_id: `${objectiveId}/experiment:${number}`,
    entry_number: number,
    recovery: `List known identities with agentera state experiments list --objective ${objectiveId} --format json, then retry.`,
  });
  if (experiment.compatibility === "immutable_conflict") throw fail(1, "immutable_conflict", `experiment '${experiment.stableId}' differs between immutable archive and retained projection`, "get", {
    stable_id: experiment.stableId!,
    entry_number: number,
    recovery: "Preserve the immutable archive and reconcile the conflicting projection before retrying.",
    details: { provenance: provenance(experiment, loaded.objective) },
  });
  if (!experiment.addressable) throw fail(1, "ambiguous", `experiment '${experiment.stableId}' has duplicate retained identities`, "get", {
    stable_id: experiment.stableId!,
    entry_number: number,
    recovery: "Repair duplicate projection identities; Agentera will not choose by array order.",
    details: { provenance: provenance(experiment, loaded.objective) },
  });
  const archive = experiment.archives[0];
  const retainedFull = experiment.projection.find((source) => source.collection === "experiments");
  const summary = experiment.projection.find((source) => source.collection !== "experiments");
  const record = archive?.record ?? retainedFull?.record ?? summary?.record;
  if (!record || experiment.detailAvailability === "unavailable") throw fail(1, "incomplete", `experiment '${experiment.stableId}' exists but detail is unavailable`, "get", {
    stable_id: experiment.stableId!, entry_number: number,
    recovery: "Restore a retained or immutable experiment record; Agentera will not reconstruct dropped legacy detail.",
  });
  return {
    schemaVersion: "agentera.stateRetrieval.v1",
    command: "state experiments get",
    status: experiment.detailAvailability === "full" ? "ok" : "degraded",
    entry: listEntry(experiment, loaded.objective),
    record,
    source: {
      artifact: "experiments",
      objective_id: objectiveId,
      experiment_number: number,
      selected: archive ? "immutable_archive" : retainedFull ? "retained_projection" : "legacy_summary_projection",
      archive_verified: Boolean(archive),
      projection_verified_against_archive: Boolean(archive && retainedFull),
      provenance: provenance(experiment, loaded.objective),
    },
    source_contract: {
      authority: AUTHORITY,
      complete_for_experiment_retrieval: true,
      detail_availability: experiment.detailAvailability,
      compatibility_truth: experiment.detailAvailability === "summary" ? "summary_only_legacy_detail_is_not_reconstructed" : "full_detail_available",
      storage_ownership: archive ? "immutable_objective_archive" : "bounded_objective_projection",
    },
  };
}

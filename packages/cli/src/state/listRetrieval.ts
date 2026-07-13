import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject, JsonValue } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { assertRealpathBoundary } from "../registries/artifactRegistry.js";
import {
  canonicalRecordJson,
  decisionOverlayContract,
  discoverNumberedArchives,
  numberedArchiveContract,
  stateCurrentProjectionPath,
  validateStateRecord,
  type NumberedArchiveContract,
  type NumberedArchiveEntry,
  type ArchiveRejection,
} from "./archiveDiscovery.js";
import { decisionOverlayPath, loadDecisionOverlay } from "./decisionOverlay.js";
import { loadProjectionPolicy, serializedProjectionBytes } from "./projectionPolicy.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";

const CURSOR_VERSION = 1;
const LIST_ORDER = "entry_number_desc";
const LIST_AUTHORITY = "references/artifacts/state-storage-authority.yaml";

export interface StateListFilters {
  topic?: string | null;
  status?: string | null;
  dimension?: string | null;
}

export interface StateListOptions {
  sourceRoot?: string;
}

interface CurrentIdentity {
  path: string;
  representation: "full" | "summary";
  record?: JsonObject;
  summary?: JsonValue;
  projectionHash: string;
}

interface ListCandidate {
  stableId: string;
  artifactId: string;
  entryNumber: number;
  archive?: NumberedArchiveEntry;
  corruptArchive?: ArchiveRejection;
  current?: CurrentIdentity;
}

interface OverlayState {
  path: string;
  revision: string;
  document: Record<string, JsonObject>;
  mutablePaths: string[];
}

interface CursorPayload {
  version: number;
  artifact_id: string;
  filters: JsonObject;
  order: string;
  snapshot_id: string;
  candidate_count: number;
  candidate_max: number;
  after: number;
}

interface ParsedCursor {
  payload: CursorPayload;
}

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const values: JsonValue[] = [];
    for (const item of value) {
      const converted = jsonValue(item);
      if (converted === undefined) return undefined;
      values.push(converted);
    }
    return values;
  }
  if (isMapping(value)) {
    const object: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const converted = jsonValue(child);
      if (converted === undefined) return undefined;
      object[key] = converted;
    }
    return object;
  }
  return undefined;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function summaryNumber(value: unknown): number | null {
  if (isMapping(value)) return positiveNumber(value.number);
  if (typeof value !== "string") return null;
  const match = /^(?:Cycle|Decision|Audit)\s+([1-9][0-9]*)\b/.exec(value.trim());
  return match ? positiveNumber(match[1]) : null;
}

function compactSummary(value: unknown): JsonValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (!isMapping(value)) return undefined;
  const selected: JsonObject = {};
  for (const key of [
    "number",
    "date",
    "timestamp",
    "summary",
    "what",
    "choice",
    "question",
    "trajectory",
    "type",
    "phase",
  ]) {
    const converted = jsonValue(value[key]);
    if (converted !== undefined && (typeof converted !== "object" || converted === null)) selected[key] = converted;
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function hashValue(value: JsonValue): string {
  return createHash("sha256").update(canonicalRecordJson(value), "utf8").digest("hex");
}

function listSyntax(artifactId = "<artifact-id>"): string {
  return `agentera state ${artifactId} list [--limit N] [--cursor TOKEN] --format json`;
}

function listExample(artifactId: string, cursor = false): string {
  return cursor
    ? `agentera state ${artifactId} list --limit 20 --cursor TOKEN --format json`
    : `agentera state ${artifactId} list --limit 20 --format json`;
}

function listFailure(
  exitCode: 1 | 2,
  className: StateFailureClass,
  message: string,
  artifactId: string,
  recovery: string,
  details?: JsonObject,
  validValues?: string[],
): StateRetrievalFailure {
  return new StateRetrievalFailure(
    {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: className,
        message,
        syntax: listSyntax(artifactId),
        example: listExample(artifactId, className === "cursor_invalid" || className === "cursor_snapshot_unavailable"),
        recovery,
        artifact_id: artifactId,
        ...(details ? { details } : {}),
        ...(validValues ? { valid_values: validValues } : {}),
      },
    },
    exitCode,
  );
}

function cursorKey(projectRoot: string, sourceRoot: string): Buffer {
  return createHash("sha256")
    .update(`agentera-state-list-cursor\0${path.resolve(projectRoot)}\0${path.resolve(sourceRoot)}`, "utf8")
    .digest();
}

function cursorSignature(payload: CursorPayload, projectRoot: string, sourceRoot: string): string {
  return createHmac("sha256", cursorKey(projectRoot, sourceRoot))
    .update(canonicalRecordJson(payload), "utf8")
    .digest("hex");
}

function encodeCursor(payload: CursorPayload, projectRoot: string, sourceRoot: string): string {
  const signed = { ...payload, signature: cursorSignature(payload, projectRoot, sourceRoot) };
  return Buffer.from(JSON.stringify(signed), "utf8").toString("base64url");
}

function invalidCursor(
  artifactId: string,
  message: string,
  projectRoot: string,
  sourceRoot: string,
): StateRetrievalFailure {
  return listFailure(
    2,
    "cursor_invalid",
    message,
    artifactId,
    "Copy response.next_cursor exactly, or omit --cursor to establish a new snapshot.",
    { cursor: "opaque; do not parse or construct cursor tokens", project_root: path.resolve(projectRoot), source_root: path.resolve(sourceRoot) },
  );
}

function parseCursor(
  artifactId: string,
  token: string,
  filters: JsonObject,
  projectRoot: string,
  sourceRoot: string,
): ParsedCursor {
  if (token.length === 0 || token.length > 100_000 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw invalidCursor(artifactId, "cursor is not a valid opaque token", projectRoot, sourceRoot);
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length === 0 || Buffer.from(bytes).toString("base64url") !== token) throw new Error("non-canonical encoding");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalidCursor(artifactId, "cursor is not a valid opaque token", projectRoot, sourceRoot);
  }
  if (!isMapping(decoded)) throw invalidCursor(artifactId, "cursor payload is not a valid opaque token", projectRoot, sourceRoot);
  const signature = decoded.signature;
  const unsigned: Record<string, unknown> = { ...decoded };
  delete unsigned.signature;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) {
    throw invalidCursor(artifactId, "cursor signature is missing or malformed", projectRoot, sourceRoot);
  }
  const expected = cursorSignature(unsigned as unknown as CursorPayload, projectRoot, sourceRoot);
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
    throw invalidCursor(artifactId, "cursor signature is invalid; the token may be tampered or copied from another project", projectRoot, sourceRoot);
  }
  const payload = unsigned as unknown as CursorPayload;
  if (
    payload.version !== CURSOR_VERSION ||
    payload.artifact_id !== artifactId ||
    payload.order !== LIST_ORDER ||
    !isMapping(payload.filters) ||
    canonicalRecordJson(payload.filters) !== canonicalRecordJson(filters) ||
    typeof payload.snapshot_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.snapshot_id) ||
    !Number.isSafeInteger(payload.candidate_count) ||
    payload.candidate_count < 1 ||
    !Number.isSafeInteger(payload.candidate_max) ||
    payload.candidate_max < 1 ||
    !Number.isSafeInteger(payload.after) ||
    payload.after < 1 ||
    payload.after > payload.candidate_max + 1
  ) {
    throw invalidCursor(artifactId, "cursor payload is invalid or bound to a different list", projectRoot, sourceRoot);
  }
  return { payload };
}

function projectionHash(current: CurrentIdentity): string {
  return hashValue(current.record ?? current.summary ?? null);
}

function readCurrentProjection(
  projectRoot: string,
  artifactId: string,
  contract: NumberedArchiveContract,
  sourceRoot: string,
): { path: string; exists: boolean; entries: Map<number, CurrentIdentity> } {
  const projectionPath = stateCurrentProjectionPath(projectRoot, artifactId, sourceRoot);
  try {
    assertRealpathBoundary(projectRoot, projectionPath, `${artifactId} projection`);
  } catch (error) {
    throw listFailure(1, "corrupt", `current ${artifactId} projection path is unsafe`, artifactId, "Repair the declared current projection path, then retry the list command.", {
      path: projectionPath,
      reason: (error as Error).message,
    });
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(projectionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: projectionPath, exists: false, entries: new Map() };
    throw listFailure(1, "corrupt", `cannot read current ${artifactId} projection`, artifactId, "Repair the current projection file and retry the list command.", { path: projectionPath });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw listFailure(1, "corrupt", `current ${artifactId} projection is not a regular file`, artifactId, "Restore the declared projection as a regular project-local file, then retry the list command.", { path: projectionPath });
  }

  let document: Record<string, unknown>;
  try {
    document = loadYamlMapping(fs.readFileSync(projectionPath, "utf8"));
  } catch (error) {
    throw listFailure(1, "corrupt", `cannot parse current ${artifactId} projection: ${(error as Error).message}`, artifactId, "Repair the current projection YAML and retry the list command.", { path: projectionPath });
  }
  const collection = document[contract.entryCollection];
  if (!Array.isArray(collection)) {
    throw listFailure(1, "corrupt", `current ${artifactId} projection is missing its '${contract.entryCollection}' collection`, artifactId, "Restore the declared current entry collection and retry the list command.", { path: projectionPath });
  }

  const entries = new Map<number, CurrentIdentity>();
  for (const candidate of collection) {
    if (!isMapping(candidate)) continue;
    const number = positiveNumber(candidate[contract.entryNumberField]);
    if (number === null) continue;
    if (entries.has(number)) {
      throw listFailure(1, "ambiguous", `current ${artifactId} projection contains duplicate identity ${artifactId}:${number}`, artifactId, "Remove the duplicate current identity according to the artifact schema, then retry the list command.", { path: projectionPath });
    }
    let representation: CurrentIdentity["representation"] = "summary";
    try {
      representation = validateStateRecord(sourceRoot, artifactId, candidate).length === 0 ? "full" : "summary";
    } catch (error) {
      throw listFailure(1, "unsupported_state", `current ${artifactId} projection could not be validated: ${(error as Error).message}`, artifactId, "Use a state schema supported by the storage authority, repair the current projection, then retry the list command.", { path: projectionPath });
    }
    const current: CurrentIdentity = {
      path: projectionPath,
      representation,
      ...(representation === "full" ? { record: candidate } : { summary: compactSummary(candidate) }),
      projectionHash: "",
    };
    current.projectionHash = projectionHash(current);
    entries.set(number, current);
  }

  const archive = document.archive;
  if (Array.isArray(archive)) {
    for (const candidate of archive) {
      const number = summaryNumber(candidate);
      if (number === null) continue;
      if (entries.has(number)) {
        throw listFailure(1, "ambiguous", `current ${artifactId} projection contains duplicate identity ${artifactId}:${number}`, artifactId, "Remove the duplicate current identity according to the artifact schema, then retry the list command.", { path: projectionPath });
      }
      const current: CurrentIdentity = {
        path: projectionPath,
        representation: "summary",
        summary: compactSummary(candidate),
        projectionHash: "",
      };
      current.projectionHash = projectionHash(current);
      entries.set(number, current);
    }
  }
  return { path: projectionPath, exists: true, entries };
}

function overlayState(projectRoot: string, artifactId: string, sourceRoot: string): OverlayState | null {
  if (artifactId !== "decisions") return null;
  const contract = decisionOverlayContract(sourceRoot);
  const overlayPath = decisionOverlayPath(projectRoot, sourceRoot);
  let document: Record<string, JsonObject>;
  try {
    document = loadDecisionOverlay(projectRoot, sourceRoot);
  } catch (error) {
    throw listFailure(1, "corrupt", `cannot read decision overlay: ${(error as Error).message}`, artifactId, "Repair the authority-declared decision overlay, then retry the list command.", { path: overlayPath });
  }
  return {
    path: overlayPath,
    revision: hashValue(document as unknown as JsonObject),
    document,
    mutablePaths: contract.mutablePaths,
  };
}

function rejectionNumber(rejected: ArchiveRejection, artifactId: string): number | null {
  const expected = path.join(`${path.sep}${artifactId}`, "");
  if (!rejected.path.includes(expected)) return null;
  const match = /(?:^|[\\/])([1-9][0-9]*)\.yaml$/.exec(rejected.path);
  return match ? positiveNumber(match[1]) : null;
}

function buildCandidates(
  projectRoot: string,
  artifactId: string,
  contract: NumberedArchiveContract,
  sourceRoot: string,
): { candidates: ListCandidate[]; projection: { path: string; exists: boolean }; rejected: ArchiveRejection[] } {
  const current = readCurrentProjection(projectRoot, artifactId, contract, sourceRoot);
  const discovery = discoverNumberedArchives(projectRoot, { sourceRoot, artifactId });
  const archive = new Map<number, NumberedArchiveEntry>();
  for (const entry of discovery.entries) {
    if (entry.artifactId === artifactId) archive.set(entry.entryNumber, entry);
  }
  const rejectedByNumber = new Map<number, ArchiveRejection>();
  for (const rejected of discovery.rejected) {
    const number = rejectionNumber(rejected, artifactId);
    if (number !== null) rejectedByNumber.set(number, rejected);
  }

  const numbers = new Set<number>([...archive.keys(), ...current.entries.keys(), ...rejectedByNumber.keys()]);
  const candidates: ListCandidate[] = [];
  for (const entryNumber of numbers) {
    candidates.push({
      stableId: `${artifactId}:${entryNumber}`,
      artifactId,
      entryNumber,
      archive: archive.get(entryNumber),
      corruptArchive: rejectedByNumber.get(entryNumber),
      current: current.entries.get(entryNumber),
    });
  }
  candidates.sort((left, right) => right.entryNumber - left.entryNumber || left.stableId.localeCompare(right.stableId));
  for (const candidate of candidates) {
    if (candidate.archive && candidate.current?.representation === "full") {
      const currentRecord = candidate.current.record;
      if (currentRecord && canonicalRecordJson(currentRecord) !== canonicalRecordJson(candidate.archive.record)) {
        throw listFailure(1, "immutable_conflict", `state ${artifactId}:${candidate.entryNumber} differs between archive and current projection`, artifactId, "Preserve the immutable archive and reconcile the conflicting current record, then retry the list command.", {
          stable_id: candidate.stableId,
          archive_path: candidate.archive.path,
          current_projection_path: candidate.current.path,
        });
      }
    }
  }
  return { candidates, projection: { path: current.path, exists: current.exists }, rejected: discovery.rejected };
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (isMapping(value)) return Object.entries(value).flatMap(([key, child]) => [key, ...stringValues(child)]);
  return [];
}

function matchesFilter(candidate: ListCandidate, filters: StateListFilters): boolean {
  const value = candidate.archive?.record ?? candidate.current?.record ?? candidate.current?.summary;
  if (filters.topic && !stringValues(value).some((item) => item.toLowerCase().includes(filters.topic!.toLowerCase()))) return false;
  if (filters.status) {
    const record = isMapping(value) ? value : {};
    const status = candidate.artifactId === "progress" ? record.type : record.status;
    if (String(status ?? "").toLowerCase() !== filters.status.toLowerCase()) return false;
  }
  if (filters.dimension) {
    const record = isMapping(value) ? value : {};
    const needle = filters.dimension.toLowerCase();
    const grades = record.grades;
    const details = record.dimensions_detail;
    const gradeMatch = isMapping(grades) && Object.keys(grades).some((key) => key.toLowerCase().includes(needle));
    const detailMatch = Array.isArray(details) && details.some((detail) => isMapping(detail) && String(detail.name ?? "").toLowerCase().includes(needle));
    if (!gradeMatch && !detailMatch) return false;
  }
  return true;
}

function filtersObject(artifactId: string, filters: StateListFilters): JsonObject {
  if (artifactId === "progress") return { topic: filters.topic ?? null, status: filters.status ?? null };
  if (artifactId === "decisions") return { topic: filters.topic ?? null };
  if (artifactId === "health") return { dimension: filters.dimension ?? null };
  return {};
}

function validateListFilters(artifactId: string, filters: StateListFilters): void {
  const allowed = artifactId === "progress" ? ["topic", "status"] : artifactId === "decisions" ? ["topic"] : ["dimension"];
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    if (!allowed.includes(key) || typeof value !== "string" || value.length === 0) {
      throw listFailure(2, "invalid_request", `unsupported or empty list filter '${key}' for ${artifactId}; valid filters: ${allowed.join(", ")}`, artifactId, `Use ${listSyntax(artifactId)} with an allowed filter value.`);
    }
  }
}

function snapshotId(candidates: ListCandidate[], artifactId: string, filters: JsonObject, overlayRevision: string): string {
  const identity = {
    artifact_id: artifactId,
    order: LIST_ORDER,
    filters,
    overlay_revision: overlayRevision,
    candidates: candidates.map((candidate) => ({
      stable_id: candidate.stableId,
      archive_hash: candidate.archive?.recordSha256 ?? null,
      legacy_projection_hash: candidate.archive ? null : candidate.current?.projectionHash ?? null,
    })),
  };
  return hashValue(identity as unknown as JsonObject);
}

function overlayFields(overlay: OverlayState | null, stableId: string): string[] {
  if (!overlay?.document[stableId]) return [];
  const selected = overlay.document[stableId];
  return overlay.mutablePaths.filter((field) => {
    let value: unknown = selected;
    for (const part of field.split(".")) {
      if (!isMapping(value)) return false;
      value = value[part];
    }
    return value !== undefined;
  });
}

function recordStatus(candidate: ListCandidate, overlay: OverlayState | null): string {
  if (overlay) {
    const selected = overlay.document[candidate.stableId];
    const state = isMapping(selected?.satisfaction) ? selected.satisfaction.state : undefined;
    if (typeof state === "string") return state;
  }
  const record = candidate.archive?.record ?? candidate.current?.record;
  if (!record) return "unknown";
  if (typeof record.status === "string") return record.status;
  if (typeof record.type === "string") return record.type;
  if (typeof record.trajectory === "string") return record.trajectory;
  const satisfaction = record.satisfaction;
  if (isMapping(satisfaction) && typeof satisfaction.state === "string") return satisfaction.state;
  return "unknown";
}

function listEntry(candidate: ListCandidate, overlay: OverlayState | null, projectRoot: string, contract: NumberedArchiveContract): JsonObject {
  const archivePath = path.join(path.resolve(projectRoot), contract.archiveRoot, candidate.artifactId, `${candidate.entryNumber}${contract.archiveExtension}`);
  const hasArchive = candidate.archive !== undefined;
  const currentStatus = candidate.current ? (candidate.current.representation === "full" ? "active" : "summary") : "archive_only";
  const source = hasArchive ? "archive" : candidate.corruptArchive ? "archive" : candidate.current?.representation === "full" ? "legacy_full" : "legacy_summary";
  const detailAvailability = hasArchive ? "full" : candidate.current?.representation === "full" ? "full" : candidate.current ? "summary" : "unavailable";
  const fields = overlayFields(overlay, candidate.stableId);
  const entry: JsonObject = {
    stable_id: candidate.stableId,
    artifact_id: candidate.artifactId,
    entry_number: candidate.entryNumber,
    current_status: currentStatus,
    detail_availability: detailAvailability,
    source,
    compatibility: hasArchive && !candidate.corruptArchive ? "complete" : "degraded",
    record_status: recordStatus(candidate, overlay),
    provenance: {
      archive: {
        path: archivePath,
        available: hasArchive || candidate.corruptArchive !== undefined,
        verified: hasArchive,
        ...(candidate.archive ? { record_sha256: candidate.archive.recordSha256 } : {}),
        ...(candidate.corruptArchive ? { rejection: candidate.corruptArchive.reason } : {}),
      },
      current_projection: {
        path: candidate.current?.path ?? path.join(path.resolve(projectRoot), `.agentera/${candidate.artifactId}.yaml`),
        present: candidate.current !== undefined,
        representation: candidate.current?.representation ?? "missing",
      },
    },
    retrieval: { command: `agentera state ${candidate.artifactId} get --number ${candidate.entryNumber} --format json` },
  };
  if (overlay) {
    entry.overlay_applied = fields.length > 0;
    entry.provenance = {
      ...(entry.provenance as JsonObject),
      overlay: { path: overlay.path, applied: fields.length > 0, fields, revision: overlay.revision },
    };
  }
  const sourceValue = candidate.current?.summary ?? candidate.archive?.record ?? candidate.current?.record;
  const summary = compactSummary(sourceValue);
  if (summary !== undefined) entry.summary = summary;
  return entry;
}

function provenanceCounts(candidates: ListCandidate[], entries: JsonObject[]): JsonObject {
  const counts: JsonObject = { archive: 0, legacy_full: 0, legacy_summary: 0, unavailable: 0 };
  for (const entry of entries) {
    const source = String(entry.source ?? "unavailable");
    if (source in counts) counts[source] = Number(counts[source]) + 1;
    else counts.unavailable = Number(counts.unavailable) + 1;
  }
  counts.candidate_count = candidates.length;
  return counts;
}

function textList(value: JsonObject): string {
  const lines = [
    `command: ${value.command}`,
    `status: ${value.status}`,
    `snapshot: ${String((value.snapshot as JsonObject).id)}${(value.snapshot as JsonObject).has_more ? " (more)" : ""}`,
    `counts: ${JSON.stringify(value.counts)}`,
    `filters: ${JSON.stringify(value.filters)}`,
    "entries:",
  ];
  for (const raw of (value.entries as JsonValue[]) ?? []) {
    const entry = raw as JsonObject;
    lines.push(`- ${entry.stable_id} current=${entry.current_status} detail=${entry.detail_availability} source=${entry.source} compatibility=${entry.compatibility} status=${entry.record_status}`);
    lines.push(`  provenance: ${JSON.stringify(entry.provenance)}`);
    if (entry.summary !== undefined) lines.push(`  summary: ${JSON.stringify(entry.summary)}`);
  }
  if (value.next_cursor) lines.push(`next_cursor: ${value.next_cursor}`);
  if (value.omitted) lines.push(`omitted: ${value.omitted_count} (${value.omission_reason})`);
  return lines.join("\n") + "\n";
}

function responseBytes(value: StateListResponse, format: "json" | "text"): number {
  return format === "text"
    ? Buffer.byteLength(textList(value as unknown as JsonObject), "utf8")
    : serializedProjectionBytes(value, "json");
}

function copyEntryWithoutOptionalDetails(entry: JsonObject): JsonObject {
  const copy = { ...entry };
  delete copy.summary;
  delete copy.record_status;
  return copy;
}

function omissionMetadata(
  command: string,
  count: number,
  entries: JsonObject[],
): JsonObject {
  return {
    omitted: count > 0,
    omitted_count: count,
    omission_reason: "list_output_byte_budget",
    retrieval: { available: true, command: `agentera ${command} [--cursor TOKEN] --format json` },
    omission_provenance: provenanceCounts([], entries),
  };
}

export interface StateListResponse {
  command: string;
  status: "ok" | "degraded";
  entries: JsonValue[];
  counts: JsonObject;
  source: JsonObject;
  filters: JsonObject;
  snapshot: JsonObject;
  source_contract: JsonObject;
  next_cursor?: string;
}

export function listStateEntries(
  projectRoot: string,
  artifactId: string,
  limit: number,
  filters: StateListFilters = {},
  cursor: string | undefined,
  options: StateListOptions = {},
): StateListResponse {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  let contract: NumberedArchiveContract;
  try {
    contract = numberedArchiveContract(artifactId, sourceRoot);
  } catch (error) {
    throw listFailure(2, "unsupported_artifact", `unsupported state artifact '${artifactId}'`, artifactId, "Use one of the numbered archive artifacts and retry the list command.", { reason: (error as Error).message }, ["progress", "decisions", "health"]);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw listFailure(2, "invalid_request", "list limit must be an integer from 1 through 100", artifactId, "Use --limit with a value from 1 through 100, or omit it for the default of 20.");
  }
  validateListFilters(artifactId, filters);
  const normalizedFilters = filtersObject(artifactId, filters);
  const parsed = cursor !== undefined ? parseCursor(artifactId, cursor, normalizedFilters, projectRoot, sourceRoot) : null;
  const built = buildCandidates(projectRoot, artifactId, contract, sourceRoot);
  const overlay = overlayState(projectRoot, artifactId, sourceRoot);
  const allCandidates = built.candidates.filter((candidate) => matchesFilter(candidate, filters));
  const overlayRevision = overlay?.revision ?? "not_applicable";
  const currentSnapshotId = snapshotId(allCandidates, artifactId, normalizedFilters, overlayRevision);
  let snapshotCandidates = allCandidates;
  let after = 0;
  let firstPage = parsed === null;
  if (parsed) {
    const oldCandidates = allCandidates.filter((candidate) => candidate.entryNumber <= parsed.payload.candidate_max);
    const oldSnapshotId = snapshotId(oldCandidates, artifactId, normalizedFilters, overlayRevision);
    if (
      oldSnapshotId !== parsed.payload.snapshot_id ||
      oldCandidates.length !== parsed.payload.candidate_count ||
      (oldCandidates.length > 0 && oldCandidates[0].entryNumber !== parsed.payload.candidate_max)
    ) {
      throw listFailure(1, "cursor_snapshot_unavailable", `cursor snapshot for state ${artifactId} is no longer available; an existing candidate changed or disappeared`, artifactId, "Start a new listing without --cursor to establish a current snapshot.", {
        snapshot_id: parsed.payload.snapshot_id,
        current_snapshot_id: currentSnapshotId,
      });
    }
    snapshotCandidates = oldCandidates;
    after = parsed.payload.after;
    firstPage = false;
  }
  const snapshot = snapshotId(snapshotCandidates, artifactId, normalizedFilters, overlayRevision);
  if (!parsed && snapshotCandidates.length === 0) {
    after = 0;
  }
  const pageCandidates = parsed ? snapshotCandidates.filter((candidate) => candidate.entryNumber < after) : snapshotCandidates;
  const selected = pageCandidates.slice(0, limit);
  const rows = selected.map((candidate) => listEntry(candidate, overlay, projectRoot, contract));
  const remaining = pageCandidates.length - selected.length;
  const nextAfter = selected.length > 0 ? selected[selected.length - 1].entryNumber : parsed?.payload.after ?? (snapshotCandidates[0]?.entryNumber ?? 1) + 1;
  const nextCursor = remaining > 0
    ? encodeCursor(
        {
          version: CURSOR_VERSION,
          artifact_id: artifactId,
          filters: normalizedFilters,
          order: LIST_ORDER,
          snapshot_id: snapshot,
          candidate_count: snapshotCandidates.length,
          candidate_max: snapshotCandidates[0]?.entryNumber ?? 1,
          after: nextAfter,
        },
        projectRoot,
        sourceRoot,
      )
    : undefined;
  const rowCounts = { active: 0, summary: 0, archive_only: 0 };
  for (const candidate of snapshotCandidates) {
    const state = candidate.current ? (candidate.current.representation === "full" ? "active" : "summary") : "archive_only";
    rowCounts[state] += 1;
  }
  return {
    command: `state ${artifactId} list`,
    status: built.rejected.length > 0 ? "degraded" : "ok",
    entries: rows,
    counts: {
      total: snapshotCandidates.length,
      returned: rows.length,
      remaining,
      active: rowCounts.active,
      summary: rowCounts.summary,
      archive_only: rowCounts.archive_only,
    },
    source: {
      artifact: artifactId,
      current_projection: { path: built.projection.path, exists: built.projection.exists },
      archive: { root: path.join(path.resolve(projectRoot), contract.archiveRoot, artifactId), validated_entries: snapshotCandidates.filter((candidate) => candidate.archive).length, rejected_count: built.rejected.length },
    },
    filters: normalizedFilters,
    snapshot: {
      id: snapshot,
      first_page: firstPage,
      order: LIST_ORDER,
      has_more: remaining > 0,
      candidate_count: snapshotCandidates.length,
      candidate_max: snapshotCandidates[0]?.entryNumber ?? 0,
      append_behavior: "entries appended after this snapshot are excluded",
    },
    source_contract: {
      authority: LIST_AUTHORITY,
      compatibility: built.candidates.some((candidate) => !candidate.archive) ? "degraded" : "complete",
      detail: "Rows identify active, summary, and archive-only representations without reconstructing missing fields.",
      retrieval: `agentera state ${artifactId} get --number N --format json`,
      cursor: "opaque; bound to artifact, filters, order, candidate identity, archive hashes, and overlay revision",
    },
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}

export function boundStateList(
  response: StateListResponse,
  format: "json" | "yaml" | "text",
  sourceRoot: string = resolveSourceRoot(),
  projectRoot: string = process.cwd(),
): StateListResponse {
  const policy = loadProjectionPolicy(sourceRoot);
  const measurementFormat = format === "text" ? "text" : "json";
  if (responseBytes(response, measurementFormat) <= policy.maxUtf8Bytes) return response;

  const originalEntries = response.entries.map((entry) => entry as JsonObject);
  let entries = originalEntries.map((entry) => copyEntryWithoutOptionalDetails(entry));
  let bounded = { ...response, entries } as StateListResponse;
  const optionalDetailOmitted = originalEntries.filter((entry, index) => Object.keys(entry).length !== Object.keys(entries[index]).length).length;
  if (responseBytes(bounded, measurementFormat) <= policy.maxUtf8Bytes) {
    if (optionalDetailOmitted === 0) return bounded;
    const withMetadata = {
      ...bounded,
      status: "degraded",
      ...omissionMetadata(response.command, optionalDetailOmitted, entries),
    } as StateListResponse;
    if (responseBytes(withMetadata, measurementFormat) <= policy.maxUtf8Bytes) return withMetadata;
    bounded = withMetadata;
  }

  const originalCount = entries.length;
  while (entries.length > 0 && responseBytes(bounded, measurementFormat) > policy.maxUtf8Bytes) {
    entries = entries.slice(0, -1);
    bounded = { ...response, entries } as StateListResponse;
  }
  const omittedCount = originalCount - entries.length;
  const metadata = omissionMetadata(response.command, omittedCount + optionalDetailOmitted, entries as JsonObject[]);
  const snapshot = response.snapshot;
  const artifactId = String(response.source.artifact ?? "state");
  const candidateMax = Number(snapshot.candidate_max ?? 0);
  const candidateCount = Number(snapshot.candidate_count ?? response.counts.total ?? 0);
  const lastNumber = entries.length > 0 ? positiveNumber(String((entries.at(-1) as JsonObject).entry_number)) : null;
  const remaining = Number(response.counts.remaining ?? 0) + omittedCount;
  const continuation = remaining > 0 || omittedCount > 0
    ? encodeCursor(
        {
          version: CURSOR_VERSION,
          artifact_id: artifactId,
          filters: response.filters,
          order: LIST_ORDER,
          snapshot_id: String(snapshot.id),
          candidate_count: candidateCount,
          candidate_max: candidateMax,
          after: lastNumber ?? candidateMax + 1,
        },
        projectRoot,
        sourceRoot,
      )
    : undefined;
  bounded = {
    ...bounded,
    status: "degraded",
    counts: { ...response.counts, returned: entries.length, remaining },
    snapshot: { ...snapshot, has_more: continuation !== undefined },
    ...(continuation ? { next_cursor: continuation } : {}),
    ...metadata,
  } as StateListResponse;
  if (responseBytes(bounded, measurementFormat) <= policy.maxUtf8Bytes) return bounded;

  const minimal = {
    command: response.command,
    status: "degraded",
    entries: [],
    counts: { ...(response.counts as JsonObject), returned: 0, remaining: Number((response.counts as JsonObject).total ?? 0) },
    source: response.source,
    filters: response.filters,
    snapshot: response.snapshot,
    source_contract: response.source_contract,
    ...omissionMetadata(response.command, Number((response.counts as JsonObject).returned ?? 0), []),
  } as StateListResponse;
  if (response.next_cursor) minimal.next_cursor = response.next_cursor;
  if (responseBytes(minimal, measurementFormat) > policy.maxUtf8Bytes) {
    throw listFailure(1, "unsupported_state", `list output required fields exceed the ${policy.maxUtf8Bytes}-byte authority budget`, String(response.source.artifact ?? "state"), "Reduce the requested output to a supported state artifact or repair the authority budget before retrying.");
  }
  return minimal;
}

export function renderStateListText(response: StateListResponse): string {
  return textList(response as unknown as JsonObject);
}

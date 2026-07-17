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
import {
  decisionRevisionPath,
  loadDecisionRevisionSnapshot,
  decisionRevisionFields,
  composedRevisionRecord,
  type DecisionRevisionSnapshot,
} from "./decisionRevision.js";
import { loadProjectionPolicy, serializedProjectionBytes } from "./projectionPolicy.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";
import { physicalCounts, provenanceCounts } from "./listAccounting.js";
import { legacyIdentity, type LegacyIdentityKind } from "./legacyIdentity.js";
import { classifyStateRows, type StateClassification } from "./listClassification.js";

const CURSOR_VERSION = 1;
const LIST_ORDER = "entry_number_desc";
const LIST_AUTHORITY = "references/artifacts/state-storage-authority.yaml";

export interface StateListFilters {
  topic?: string | null;
  status?: string | null;
  dimension?: string | null;
  severity?: string | null;
}

export interface StateListOptions {
  sourceRoot?: string;
}

interface CurrentIdentity {
  path: string;
  rowKey: string;
  origin: "active" | "summary";
  identity: LegacyIdentityKind;
  entryNumber: number | null;
  representation: "full" | "summary";
  record?: JsonObject;
  summary?: JsonValue;
  projectionHash: string;
}

interface PhysicalRow {
  rowKey: string;
  source: "current_projection" | "archive";
  origin: "active" | "summary" | "numbered_archive" | "rejected_archive";
  path: string;
  identity: LegacyIdentityKind;
  entryNumber: number | null;
  representation: "full" | "summary" | "unavailable";
  projectionHash: string;
  record?: JsonObject;
  summary?: JsonValue;
  rejection?: ArchiveRejection;
}

interface ListCandidate {
  stableId: string | null;
  artifactId: string;
  entryNumber: number | null;
  identity: PhysicalRow["identity"];
  classification: StateClassification;
  rows: PhysicalRow[];
  sortKey: string;
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

interface RevisionState {
  path: string;
  revision: string;
  snapshot: DecisionRevisionSnapshot;
}

interface CursorPayload {
  version: number;
  artifact_id: string;
  filters: JsonObject;
  order: string;
  snapshot_id: string;
  candidate_count: number;
  candidate_max: number;
  candidate_start_key: string;
  candidate_end_key: string;
  after_key: string;
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
    typeof payload.candidate_start_key !== "string" ||
    typeof payload.candidate_end_key !== "string" ||
    typeof payload.after_key !== "string" ||
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
): { path: string; exists: boolean; entries: CurrentIdentity[] } {
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: projectionPath, exists: false, entries: [] };
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

  const entries: CurrentIdentity[] = [];
  for (const [index, candidate] of collection.entries()) {
    const identity = legacyIdentity(candidate, artifactId, contract.entryNumberField);
    let representation: CurrentIdentity["representation"] = "summary";
    if (isMapping(candidate)) {
      try {
        const violations = validateStateRecord(sourceRoot, artifactId, candidate);
        representation = violations.every((violation) => /number|entry/i.test(violation)) ? "full" : violations.length === 0 ? "full" : "summary";
      } catch (error) {
        throw listFailure(1, "unsupported_state", `current ${artifactId} projection could not be validated: ${(error as Error).message}`, artifactId, "Use a state schema supported by the storage authority, repair the current projection, then retry the list command.", { path: projectionPath });
      }
    }
    const current: CurrentIdentity = {
      path: projectionPath,
      rowKey: `${projectionPath}#${contract.entryCollection}:${index}`,
      origin: "active",
      identity: identity.kind,
      entryNumber: identity.number,
      representation,
      ...(representation === "full" && isMapping(candidate) ? { record: candidate } : { summary: compactSummary(candidate) }),
      projectionHash: "",
    };
    current.projectionHash = projectionHash(current);
    entries.push(current);
  }

  const archive = document.archive;
  if (Array.isArray(archive)) {
    for (const [index, candidate] of archive.entries()) {
      const identity = legacyIdentity(candidate, artifactId, contract.entryNumberField);
      const current: CurrentIdentity = {
        path: projectionPath,
        rowKey: `${projectionPath}#archive:${index}`,
        origin: "summary",
        identity: identity.kind,
        entryNumber: identity.number,
        representation: "summary",
        summary: compactSummary(candidate),
        projectionHash: "",
      };
      current.projectionHash = projectionHash(current);
      entries.push(current);
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

function revisionState(projectRoot: string, artifactId: string, sourceRoot: string): RevisionState | null {
  if (artifactId !== "decisions") return null;
  let snapshot: DecisionRevisionSnapshot | null;
  try {
    snapshot = loadDecisionRevisionSnapshot(projectRoot, sourceRoot);
  } catch (error) {
    throw listFailure(1, "corrupt", (error as Error).message, artifactId, "Repair the decision revision document, then retry the list command.", { path: decisionRevisionPath(projectRoot, sourceRoot) });
  }
  return snapshot ? { path: snapshot.path, revision: hashValue(snapshot.document as unknown as JsonObject), snapshot } : null;
}

function rejectionNumber(rejected: ArchiveRejection, artifactId: string): number | null {
  const expected = path.join(`${path.sep}${artifactId}`, "");
  if (!rejected.path.includes(expected)) return null;
  const match = /(?:^|[\\/])([1-9][0-9]*)\.yaml$/.exec(rejected.path);
  return match ? positiveNumber(match[1]) : null;
}

function rejectionBelongsToArtifact(rejected: ArchiveRejection, artifactId: string): boolean {
  return rejected.path.includes(path.join(`${path.sep}${artifactId}`, ""));
}

function physicalRowFromCurrent(current: CurrentIdentity): PhysicalRow {
  return {
    rowKey: current.rowKey,
    source: "current_projection",
    origin: current.origin,
    path: current.path,
    identity: current.identity,
    entryNumber: current.entryNumber,
    representation: current.representation,
    projectionHash: current.projectionHash,
    ...(current.record ? { record: current.record } : {}),
    ...(current.summary !== undefined ? { summary: current.summary } : {}),
  };
}

function physicalRowFromArchive(entry: NumberedArchiveEntry): PhysicalRow {
  return {
    rowKey: entry.path,
    source: "archive",
    origin: "numbered_archive",
    path: entry.path,
    identity: "canonical_number",
    entryNumber: entry.entryNumber,
    representation: "full",
    projectionHash: entry.recordSha256,
    record: entry.record,
  };
}

function physicalRowFromRejection(rejected: ArchiveRejection, entryNumber: number | null): PhysicalRow {
  return {
    rowKey: rejected.path,
    source: "archive",
    origin: "rejected_archive",
    path: rejected.path,
    identity: entryNumber === null ? "unaddressable" : "canonical_number",
    entryNumber,
    representation: "unavailable",
    projectionHash: hashValue({ path: rejected.path, reason: rejected.reason, message: rejected.message }),
    rejection: rejected,
  };
}

function sortKey(artifactId: string, entryNumber: number | null, rowKey: string): string {
  if (entryNumber !== null) {
    const descending = String(Number.MAX_SAFE_INTEGER - entryNumber).padStart(16, "0");
    return `0:${descending}:${artifactId}:${entryNumber}`;
  }
  return `1:${rowKey}`;
}

function buildCandidates(
  projectRoot: string,
  artifactId: string,
  contract: NumberedArchiveContract,
  sourceRoot: string,
): { candidates: ListCandidate[]; projection: { path: string; exists: boolean }; rejected: ArchiveRejection[] } {
  const current = readCurrentProjection(projectRoot, artifactId, contract, sourceRoot);
  const discovery = discoverNumberedArchives(projectRoot, { sourceRoot, artifactId });
  const grouped = new Map<number, { rows: PhysicalRow[]; archive?: NumberedArchiveEntry; corruptArchive?: ArchiveRejection }>();
  const unaddressable: PhysicalRow[] = [];
  const addRow = (row: PhysicalRow, archive?: NumberedArchiveEntry, corruptArchive?: ArchiveRejection): void => {
    if (row.entryNumber === null || row.identity === "ambiguous") {
      unaddressable.push(row);
      return;
    }
    const group = grouped.get(row.entryNumber) ?? { rows: [] };
    group.rows.push(row);
    if (archive) group.archive = archive;
    if (corruptArchive) group.corruptArchive = corruptArchive;
    grouped.set(row.entryNumber, group);
  };

  for (const entry of discovery.entries) addRow(physicalRowFromArchive(entry), entry);
  for (const rejected of discovery.rejected) {
    if (!rejectionBelongsToArtifact(rejected, artifactId)) continue;
    const number = rejectionNumber(rejected, artifactId);
    addRow(physicalRowFromRejection(rejected, number), undefined, number === null ? undefined : rejected);
  }
  for (const entry of current.entries) addRow(physicalRowFromCurrent(entry));

  const candidates: ListCandidate[] = [];
  for (const [entryNumber, group] of grouped) {
    const rows = group.rows;
    const currentRow = rows.find((row) => row.source === "current_projection");
    const identity = rows.find((row) => row.identity === "explicit_decision_shorthand")?.identity ?? "canonical_number";
    candidates.push({
      stableId: `${artifactId}:${entryNumber}`,
      artifactId,
      entryNumber,
      identity,
      classification: classifyStateRows(rows),
      rows,
      sortKey: sortKey(artifactId, entryNumber, rows[0]?.rowKey ?? ""),
      ...(group.archive ? { archive: group.archive } : {}),
      ...(group.corruptArchive ? { corruptArchive: group.corruptArchive } : {}),
      ...(currentRow ? { current: current.entries.find((entry) => entry.rowKey === currentRow.rowKey) } : {}),
    });
  }
  for (const row of unaddressable) {
    candidates.push({
      stableId: null,
      artifactId,
      entryNumber: null,
      identity: row.identity,
      classification: row.rejection ? "corrupt" : row.identity === "ambiguous" ? "ambiguous" : "unaddressable",
      rows: [row],
      sortKey: sortKey(artifactId, null, row.rowKey),
    });
  }
  candidates.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
  return { candidates, projection: { path: current.path, exists: current.exists }, rejected: discovery.rejected };
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (isMapping(value)) return Object.entries(value).flatMap(([key, child]) => [key, ...stringValues(child)]);
  return [];
}

function matchesFilter(candidate: ListCandidate, filters: StateListFilters): boolean {
  const value = candidate.archive?.record ?? candidate.current?.record ?? candidate.current?.summary ?? candidate.rows[0]?.summary;
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

function snapshotId(candidates: ListCandidate[], artifactId: string, filters: JsonObject, overlayRevision: string, revisionRevision: string): string {
  const identity = {
    artifact_id: artifactId,
    order: LIST_ORDER,
    filters,
    overlay_revision: overlayRevision,
    revision_revision: revisionRevision,
    candidates: candidates.map((candidate) => ({
      stable_id: candidate.stableId,
      sort_key: candidate.sortKey,
      physical_rows: candidate.rows.map((row) => ({
        row_key: row.rowKey,
        source: row.source,
        identity: row.identity,
        entry_number: row.entryNumber,
        hash: row.projectionHash,
        rejection: row.rejection?.reason ?? null,
      })),
    })),
  };
  return hashValue(identity as unknown as JsonObject);
}

function overlayFields(overlay: OverlayState | null, stableId: string): string[] {
  if (!overlay || !overlay.document[stableId]) return [];
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
  if (overlay && candidate.stableId !== null) {
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

function listEntry(candidate: ListCandidate, overlay: OverlayState | null, revision: RevisionState | null, projectRoot: string, contract: NumberedArchiveContract): JsonObject {
  const archivePath = candidate.archive?.path ?? candidate.corruptArchive?.path ?? path.join(path.resolve(projectRoot), contract.archiveRoot, candidate.artifactId, `${candidate.entryNumber ?? "unaddressable"}${contract.archiveExtension}`);
  const hasArchive = candidate.archive !== undefined;
  const currentStatus = candidate.current ? (candidate.current.representation === "full" ? "active" : "summary") : "archive_only";
  const source = hasArchive ? "archive" : candidate.corruptArchive ? "archive" : candidate.current?.representation === "full" ? "legacy_full" : "legacy_summary";
  const detailAvailability = hasArchive ? "full" : candidate.current?.representation === "full" ? "full" : candidate.current ? "summary" : candidate.rows[0]?.representation ?? "unavailable";
  const overlayFieldsForEntry = overlayFields(overlay, candidate.stableId ?? "");
  const revisionForEntry = decisionRevisionFields(revision?.snapshot ?? null, candidate.stableId ?? "");
  const addressable = candidate.stableId !== null;
  const physicalRows = candidate.rows.map((row) => ({
    row_id: row.rowKey,
    source: row.source,
    origin: row.origin,
    path: row.path,
    identity: row.identity,
    entry_number: row.entryNumber,
    representation: row.representation,
    ...(row.rejection ? { rejection: row.rejection.reason } : {}),
  }));
  const entry: JsonObject = {
    stable_id: candidate.stableId,
    artifact_id: candidate.artifactId,
    entry_number: candidate.entryNumber,
    addressable,
    identity: candidate.identity,
    classification: candidate.classification,
    physical_count: candidate.rows.length,
    cursor_key: candidate.sortKey,
    current_status: currentStatus,
    detail_availability: detailAvailability,
    source,
    compatibility: candidate.classification === "conflict" || candidate.classification === "ambiguous" || candidate.classification === "corrupt"
      ? "blocked"
      : hasArchive && !candidate.corruptArchive ? "complete" : "degraded",
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
      physical_rows: physicalRows,
    },
    ...(addressable
      ? { retrieval: { command: `agentera state ${candidate.artifactId} get --number ${candidate.entryNumber} --format json`, available: candidate.classification !== "conflict" && candidate.classification !== "ambiguous" && candidate.classification !== "corrupt" } }
      : { retrieval: { available: false, reason: "unaddressable", message: "No stable ID was inferred from this physical row; list output is the only supported view." } }),
  };
  if (overlay && addressable) {
    entry.overlay_applied = overlayFieldsForEntry.length > 0;
    entry.provenance = {
      ...(entry.provenance as JsonObject),
      overlay: { path: overlay.path, applied: overlayFieldsForEntry.length > 0, fields: overlayFieldsForEntry, revision: overlay.revision },
    };
  }
  if (revision && addressable) {
    entry.revision_applied = revisionForEntry.applied;
    entry.provenance = {
      ...(entry.provenance as JsonObject),
      revision: {
        path: revision.path,
        applied: revisionForEntry.applied,
        fields: revisionForEntry.fields,
        revisions: revisionForEntry.count,
        base_provenance: hasArchive && !candidate.corruptArchive ? "historical_archive" : "degraded_projection",
      },
    };
  }
  const baseSourceValue = candidate.current?.summary ?? candidate.archive?.record ?? candidate.current?.record;
  const effectiveSourceValue = revisionForEntry.applied && baseSourceValue && candidate.stableId ? composedRevisionRecord(revision?.snapshot ?? null, candidate.stableId, baseSourceValue as JsonObject) : baseSourceValue;
  const summary = compactSummary(effectiveSourceValue);
  if (summary !== undefined) entry.summary = summary;
  return entry;
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

function responseBytes(value: StateListResponse, format: "json" | "yaml" | "text"): number {
  return format === "text"
    ? Buffer.byteLength(textList(value as unknown as JsonObject), "utf8")
    : serializedProjectionBytes(value, format);
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
    omission_provenance: provenanceCounts(entries),
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
  const revision = revisionState(projectRoot, artifactId, sourceRoot);
  const allCandidates = built.candidates.filter((candidate) => matchesFilter(candidate, filters));
  const overlayRevision = overlay?.revision ?? "not_applicable";
  const revisionRevision = revision?.revision ?? "not_applicable";
  const currentSnapshotId = snapshotId(allCandidates, artifactId, normalizedFilters, overlayRevision, revisionRevision);
  let snapshotCandidates = allCandidates;
  let firstPage = parsed === null;
  if (parsed) {
    const oldCandidates = allCandidates.filter(
      (candidate) => candidate.sortKey >= parsed.payload.candidate_start_key && candidate.sortKey <= parsed.payload.candidate_end_key,
    );
    const oldSnapshotId = snapshotId(oldCandidates, artifactId, normalizedFilters, overlayRevision, revisionRevision);
    if (
      oldSnapshotId !== parsed.payload.snapshot_id ||
      oldCandidates.length !== parsed.payload.candidate_count ||
      (oldCandidates.length > 0 && oldCandidates[0].sortKey !== parsed.payload.candidate_start_key)
    ) {
      throw listFailure(1, "cursor_snapshot_unavailable", `cursor snapshot for state ${artifactId} is no longer available; an existing candidate changed or disappeared`, artifactId, "Start a new listing without --cursor to establish a current snapshot.", {
        snapshot_id: parsed.payload.snapshot_id,
        current_snapshot_id: currentSnapshotId,
      });
    }
    snapshotCandidates = oldCandidates;
    firstPage = false;
  }
  const snapshot = snapshotId(snapshotCandidates, artifactId, normalizedFilters, overlayRevision, revisionRevision);
  const pageCandidates = parsed ? snapshotCandidates.filter((candidate) => candidate.sortKey > parsed.payload.after_key) : snapshotCandidates;
  const selected = pageCandidates.slice(0, limit);
  const rows = selected.map((candidate) => listEntry(candidate, overlay, revision, projectRoot, contract));
  const remaining = pageCandidates.length - selected.length;
  const nextAfterCandidate = selected.at(-1);
  const nextAfterKey = nextAfterCandidate?.sortKey ?? parsed?.payload.after_key ?? "";
  const nextAfter = nextAfterCandidate?.entryNumber ?? parsed?.payload.after ?? 1;
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
          candidate_start_key: snapshotCandidates[0]?.sortKey ?? "",
          candidate_end_key: snapshotCandidates.at(-1)?.sortKey ?? "",
          after_key: nextAfterKey,
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
  const allPhysicalCounts = physicalCounts(snapshotCandidates);
  const selectedPhysical = selected.reduce((total, candidate) => total + candidate.rows.length, 0);
  const blocked = snapshotCandidates.some((candidate) => ["conflict", "ambiguous", "corrupt"].includes(candidate.classification));
  const degraded = snapshotCandidates.some((candidate) => candidate.classification !== "canonical" || !candidate.archive);
  return {
    command: `state ${artifactId} list`,
    status: built.rejected.length > 0 || degraded ? "degraded" : "ok",
    entries: rows,
    counts: {
      total: snapshotCandidates.length,
      returned: rows.length,
      remaining,
      ...allPhysicalCounts,
      returned_physical: selectedPhysical,
      omitted: Math.max(0, Number(allPhysicalCounts.physical ?? 0) - selectedPhysical),
      active: rowCounts.active,
      summary: rowCounts.summary,
      archive_only: rowCounts.archive_only,
    },
    source: {
      artifact: artifactId,
      current_projection: { path: built.projection.path, exists: built.projection.exists },
       archive: { root: path.join(path.resolve(projectRoot), contract.archiveRoot, artifactId), validated_entries: snapshotCandidates.reduce((count, candidate) => count + candidate.rows.filter((row) => row.origin === "numbered_archive").length, 0), rejected_count: built.rejected.length },
    },
    filters: normalizedFilters,
    snapshot: {
      id: snapshot,
      first_page: firstPage,
      order: LIST_ORDER,
      has_more: remaining > 0,
      candidate_count: snapshotCandidates.length,
      candidate_max: snapshotCandidates[0]?.entryNumber ?? 0,
      candidate_start_key: snapshotCandidates[0]?.sortKey ?? "",
      candidate_end_key: snapshotCandidates.at(-1)?.sortKey ?? "",
      page_start: parsed?.payload.after ?? (snapshotCandidates[0]?.entryNumber ?? 0) + 1,
      append_behavior: "entries appended after this snapshot are excluded",
    },
    source_contract: {
      authority: LIST_AUTHORITY,
      compatibility: blocked ? "blocked" : degraded ? "degraded" : "complete",
      detail: "Rows preserve explicit canonical numbers and decision Dnn shorthand. Unaddressable rows remain list-only; mirrors, duplicates, conflicts, and ambiguity are classified without inferred identity.",
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
  if (responseBytes(response, format) <= policy.maxUtf8Bytes) return response;

  const originalEntries = response.entries.map((entry) => entry as JsonObject);
  const entriesWithoutOptionalDetails = originalEntries.map((entry) => copyEntryWithoutOptionalDetails(entry));
  const optionalDetailOmitted = originalEntries.filter(
    (entry, index) => Object.keys(entry).length !== Object.keys(entriesWithoutOptionalDetails[index]).length,
  ).length;

  const boundedPage = (entries: JsonObject[], omittedRows: number): StateListResponse => {
    const snapshot = response.snapshot;
    const artifactId = String(response.source.artifact ?? "state");
    const candidateMax = Number(snapshot.candidate_max ?? 0);
    const candidateCount = Number(snapshot.candidate_count ?? response.counts.total ?? 0);
    const lastEntry = entries.at(-1);
    const lastNumber = lastEntry ? positiveNumber(String(lastEntry.entry_number)) : null;
    const lastKey = typeof lastEntry?.cursor_key === "string" ? lastEntry.cursor_key : null;
    const continuation = omittedRows > 0 && lastKey !== null
      ? encodeCursor(
          {
            version: CURSOR_VERSION,
            artifact_id: artifactId,
            filters: response.filters,
            order: LIST_ORDER,
            snapshot_id: String(snapshot.id),
            candidate_count: candidateCount,
            candidate_max: candidateMax,
            candidate_start_key: String(snapshot.candidate_start_key ?? ""),
            candidate_end_key: String(snapshot.candidate_end_key ?? ""),
            after_key: lastKey,
            after: lastNumber ?? 1,
          },
          projectRoot,
          sourceRoot,
        )
      : omittedRows === 0
        ? response.next_cursor
        : undefined;
    const bounded = {
      ...response,
      status: optionalDetailOmitted + omittedRows > 0 ? "degraded" : response.status,
      entries,
      counts: {
        ...response.counts,
        returned: entries.length,
        remaining: Number(response.counts.remaining ?? 0) + omittedRows,
        returned_physical: entries.reduce((total, entry) => total + Number(entry.physical_count ?? 1), 0),
        omitted: Math.max(0, Number(response.counts.physical ?? response.counts.total ?? 0) - entries.reduce((total, entry) => total + Number(entry.physical_count ?? 1), 0)),
      },
      snapshot: { ...snapshot, has_more: continuation !== undefined },
      ...(optionalDetailOmitted + omittedRows > 0
        ? omissionMetadata(response.command, optionalDetailOmitted + omittedRows, entries)
        : {}),
    } as StateListResponse;
    delete bounded.next_cursor;
    if (continuation) bounded.next_cursor = continuation;
    return bounded;
  };

  for (let retainedCount = entriesWithoutOptionalDetails.length; retainedCount > 0; retainedCount -= 1) {
    const entries = entriesWithoutOptionalDetails.slice(0, retainedCount);
    const omittedRows = entriesWithoutOptionalDetails.length - retainedCount;
    const bounded = boundedPage(entries, omittedRows);
    if (responseBytes(bounded, format) <= policy.maxUtf8Bytes) return bounded;
  }

  throw listFailure(
    1,
    "unsupported_state",
    `list output cannot emit an advancing row page within the ${policy.maxUtf8Bytes}-byte ${format} authority budget`,
    String(response.source.artifact ?? "state"),
    "Reduce the requested output to a supported state artifact or repair the authority budget before retrying; no continuation cursor was issued.",
    { format, candidate_count: Number(response.snapshot.candidate_count ?? response.counts.total ?? 0) },
  );
}

export function renderStateListText(response: StateListResponse): string {
  return textList(response as unknown as JsonObject);
}

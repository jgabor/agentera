import { createHash } from "node:crypto";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

import YAML from "yaml";

import type { JsonObject, JsonValue } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  canonicalRecordJson,
  discoverNumberedArchives,
  numberedArchiveContract,
  stateCurrentProjectionPath,
  type ArchiveRejection,
  type NumberedArchiveEntry,
} from "./archiveDiscovery.js";
import { legacyIdentity, type LegacyIdentity } from "./legacyIdentity.js";
import { classifyStateRows, type StateClassification, type StateClassificationRow } from "./listClassification.js";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_CAPTURED_VALUE_CHARS = 512;
const MAX_LINE_BUFFER_BYTES = 16 * 1024;
const ROOT_ITEM = /^  -(?:\s+(.*))?$/;
const ROOT_FIELD = /^    ([A-Za-z0-9_-]+):(?:\s*(.*))?$/;
const NESTED_FIELD = /^\s{6,}([A-Za-z0-9_-]+):(?:\s*(.*))?$/;
const CAPTURED_FIELDS = new Set([
  "number",
  "date",
  "timestamp",
  "status",
  "type",
  "phase",
  "summary",
  "what",
  "question",
  "choice",
  "trajectory",
  "name",
  "title",
  "review_needed",
  "state",
  "source",
  "review_date",
  "review_by",
  "review_due",
]);
const BLOCK_SECTIONS = new Set(["grades", "satisfaction"]);

export interface StartupSourceEntry {
  index: number;
  path: string;
  fields: JsonObject;
  identity: LegacyIdentity;
  origin: "active" | "summary";
  projectionHash: string;
}

export interface StartupSourceScan {
  path: string;
  exists: boolean;
  collection_found: boolean;
  bytes_scanned: number;
  entries: StartupSourceEntry[];
}

export interface StartupArtifactScans {
  contract: ReturnType<typeof numberedArchiveContract>;
  active: StartupSourceScan;
  archive: StartupSourceScan;
}

export interface StartupHistoryCounts extends JsonObject {
  physical: number;
  addressable: number;
  addressable_ids: number;
  unaddressable: number;
  ambiguous: number;
  mirrored: number;
  duplicate: number;
  conflict: number;
  omitted: number;
}

export interface StartupHistorySummary extends JsonObject {
  artifact: string;
  status: "available" | "absent" | "degraded";
  counts: StartupHistoryCounts;
  entries: JsonValue[];
  source: JsonObject;
  retrieval: JsonObject;
  omission: JsonObject;
}

const PRESERVED_STARTUP_KEYS = new Set([
  "number",
  "entry_number",
  "stable_id",
  "artifact_id",
  "status",
  "mode",
  "capability",
  "command",
  "get",
  "list",
  "fallback_command",
  "next_cursor",
  "field",
]);

function boundedText(value: string, maxChars: number): string {
  const characters = Array.from(value);
  return characters.length <= maxChars ? value : `${characters.slice(0, maxChars - 1).join("")}\u2026`;
}

/** Bound optional capability startup detail without touching identity or routes. */
export function boundStartupValue(value: JsonValue, key = "", depth = 0): JsonValue {
  if (typeof value === "string") return PRESERVED_STARTUP_KEYS.has(key) ? value : boundedText(value, 200);
  if (Array.isArray(value)) {
    const bounded = value.slice(0, 20).map((item) => boundStartupValue(item, key, depth + 1));
    return bounded;
  }
  if (!isMapping(value) || depth > 8) return value;
  const result: JsonObject = {};
  for (const [childKey, child] of Object.entries(value)) {
    result[childKey] = boundStartupValue(child, childKey, depth + 1);
  }
  return result;
}

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capturedString(value: string): string {
  return boundedText(value, MAX_CAPTURED_VALUE_CHARS);
}

function hashValue(value: JsonValue): string {
  return createHash("sha256").update(canonicalRecordJson(value), "utf8").digest("hex");
}

function scalar(value: string | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text || text === "|" || text === ">" || text === "|-" || text === ">-") return undefined;
  const bounded = capturedString(text);
  try {
    const parsed = YAML.parse(bounded);
    if (parsed === null || typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
      return parsed as JsonValue;
    }
  } catch {
    // A bounded prefix can be an incomplete quoted scalar; identity metadata is
    // still useful as a plain string in that case.
  }
  return bounded.replace(/^['"]|['"]$/g, "");
}

function setCaptured(fields: JsonObject, key: string, value: string | undefined): void {
  if (key === "review_needed") {
    const parsed = scalar(value);
    if (parsed !== undefined) fields.review_needed = parsed;
    return;
  }
  if (!CAPTURED_FIELDS.has(key)) return;
  const parsed = scalar(value);
  if (parsed !== undefined) fields[key] = parsed;
}

function setNested(fields: JsonObject, section: string, key: string, value: string | undefined): void {
  if (section === "grades") {
    const parsed = scalar(value);
    if (parsed === undefined) return;
    const grades = isMapping(fields.grades) ? fields.grades : {};
    grades[key] = parsed;
    fields.grades = grades;
    return;
  }
  if (section !== "satisfaction" || !["review_needed", "state", "source", "review_date", "review_by", "review_due"].includes(key)) return;
  const parsed = scalar(value);
  if (parsed === undefined) return;
  const satisfaction = isMapping(fields.satisfaction) ? fields.satisfaction : {};
  satisfaction[key] = parsed;
  fields.satisfaction = satisfaction;
}

function finalizeEntry(
  entries: StartupSourceEntry[],
  fields: JsonObject,
  artifactId: string,
  entryNumberField: string,
  filePath: string,
  origin: StartupSourceEntry["origin"],
): void {
  entries.push({
    index: entries.length,
    path: filePath,
    fields,
    identity: legacyIdentity(fields, artifactId, entryNumberField),
    origin,
    projectionHash: hashValue(fields),
  });
}

/**
 * Read only the bounded metadata needed by startup consumers. The scanner
 * never constructs a full YAML record, so a large verification or transcript
 * field cannot become a retained prime payload or heap-sized object graph.
 */
export function scanYamlCollection(
  filePath: string,
  collection: string,
  artifactId: string,
  entryNumberField: string,
  origin: StartupSourceEntry["origin"] = collection === "archive" ? "summary" : "active",
): StartupSourceScan {
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false, collection_found: false, bytes_scanned: 0, entries: [] };
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { path: filePath, exists: true, collection_found: false, bytes_scanned: 0, entries: [] };
    }
  } catch {
    return { path: filePath, exists: true, collection_found: false, bytes_scanned: 0, entries: [] };
  }
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return { path: filePath, exists: true, collection_found: false, bytes_scanned: 0, entries: [] };
  }

  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const entries: StartupSourceEntry[] = [];
  let bytesScanned = 0;
  let line = "";
  let lineBytes = 0;
  let droppingLongLine = false;
  let inCollection = false;
  let collectionFound = false;
  let fields: JsonObject | null = null;
  let section: string | null = null;
  let blockField: string | null = null;

  const finish = (): void => {
    if (fields !== null) finalizeEntry(entries, fields, artifactId, entryNumberField, filePath, origin);
    fields = null;
    section = null;
    blockField = null;
  };

  const processLine = (rawLine: string): void => {
    const text = rawLine.replace(/\r$/, "");
    if (!inCollection) {
      if (text === `${collection}:`) {
        inCollection = true;
        collectionFound = true;
      }
      return;
    }
    if (text && !/^\s/.test(text)) {
      finish();
      inCollection = text === `${collection}:`;
      if (inCollection) collectionFound = true;
      return;
    }
    const item = ROOT_ITEM.exec(text);
    if (item) {
      finish();
      fields = {};
      const inline = item[1] ?? "";
      const pair = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(inline);
      if (pair) {
        setCaptured(fields, pair[1], pair[2]);
        section = BLOCK_SECTIONS.has(pair[1]) && !pair[2] ? pair[1] : null;
        blockField = pair[1] === "summary" && !pair[2] ? "summary" : null;
      } else if (inline) {
        fields.summary = scalar(inline) ?? capturedString(inline);
      }
      return;
    }
    if (fields === null) return;
    const root = ROOT_FIELD.exec(text);
    if (root) {
      section = BLOCK_SECTIONS.has(root[1]) && !root[2] ? root[1] : null;
      blockField = root[1] === "summary" && !root[2] ? "summary" : null;
      if (root[1] === "verified" && !root[2]) fields.verified_present = true;
      setCaptured(fields, root[1], root[2]);
      return;
    }
    const nested = NESTED_FIELD.exec(text);
    if (nested) {
      if (section) setNested(fields, section, nested[1], nested[2]);
      if (blockField && fields[blockField] === undefined && nested[2]) {
        fields[blockField] = capturedString(nested[2].trim());
      }
      return;
    }
    if (blockField && text.trim() && fields[blockField] === undefined) {
      fields[blockField] = capturedString(text.trim());
    }
  };

  try {
    let bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      bytesScanned += bytesRead;
      const chunk = decoder.write(buffer.subarray(0, bytesRead));
      for (const char of chunk) {
        if (char === "\n") {
          processLine(line);
          line = "";
          lineBytes = 0;
          droppingLongLine = false;
        } else if (!droppingLongLine) {
          line += char;
          lineBytes += Buffer.byteLength(char, "utf8");
          if (lineBytes > MAX_LINE_BUFFER_BYTES) {
            processLine(line);
            line = "";
            lineBytes = 0;
            droppingLongLine = true;
          }
        }
      }
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    }
    const remainder = decoder.end();
    for (const char of remainder) {
      if (char === "\n") {
        processLine(line);
        line = "";
        lineBytes = 0;
        droppingLongLine = false;
      } else if (!droppingLongLine) {
        line += char;
        lineBytes += Buffer.byteLength(char, "utf8");
      }
    }
    if (line) processLine(line);
    finish();
  } finally {
    fs.closeSync(fd);
  }
  return { path: filePath, exists: true, collection_found: collectionFound, bytes_scanned: bytesScanned, entries };
}

export function scanStartupArtifact(
  projectRoot: string,
  artifactId: "progress" | "decisions" | "health",
  sourceRoot: string = resolveSourceRoot(),
): StartupArtifactScans {
  const contract = numberedArchiveContract(artifactId, sourceRoot);
  const currentPath = stateCurrentProjectionPath(projectRoot, artifactId, sourceRoot);
  return {
    contract,
    active: scanYamlCollection(currentPath, contract.entryCollection, artifactId, contract.entryNumberField, "active"),
    archive: scanYamlCollection(currentPath, "archive", artifactId, contract.entryNumberField, "summary"),
  };
}

function archiveNumber(rejection: ArchiveRejection, artifactId: string): number | null {
  if (!rejection.path.includes(path.join(`${path.sep}${artifactId}`, ""))) return null;
  const match = /(?:^|[\\/])([1-9][0-9]*)\.yaml$/.exec(rejection.path);
  return match ? Number(match[1]) : null;
}

function classificationRow(
  entry: StartupSourceEntry | NumberedArchiveEntry | ArchiveRejection,
  artifactId: string,
): StateClassificationRow {
  if ("path" in entry && "reason" in entry) {
    const number = archiveNumber(entry, artifactId);
    return {
      source: "archive",
      origin: "rejected_archive",
      identity: number === null ? "unaddressable" : "canonical_number",
      entryNumber: number,
      representation: "unavailable",
      projectionHash: hashValue({ path: entry.path, reason: entry.reason, message: entry.message }),
      rejection: { reason: entry.reason },
    };
  }
  if ("entryNumber" in entry) {
    return {
      source: "archive",
      origin: "numbered_archive",
      identity: "canonical_number",
      entryNumber: entry.entryNumber,
      representation: "summary",
      projectionHash: entry.recordSha256,
    };
  }
  return {
    source: "current_projection",
    origin: entry.origin,
    identity: entry.identity.kind,
    entryNumber: entry.identity.number,
    // The bounded scanner retains a startup summary, not the full record. Keep
    // it comparable for duplicate/conflict detection without retaining YAML.
    representation: "full",
    projectionHash: entry.projectionHash,
  };
}

function classifyNumber(
  artifactId: string,
  number: number,
  current: StartupSourceEntry[],
  archives: NumberedArchiveEntry[],
  rejected: ArchiveRejection[],
): StateClassification {
  const rows = [
    ...current.filter((entry) => entry.identity.number === number).map((entry) => classificationRow(entry, artifactId)),
    ...archives.filter((entry) => entry.entryNumber === number).map((entry) => classificationRow(entry, artifactId)),
    ...rejected.filter((entry) => archiveNumber(entry, artifactId) === number).map((entry) => classificationRow(entry, artifactId)),
  ];
  return classifyStateRows(rows);
}

function classifyUnaddressable(entry: StartupSourceEntry | ArchiveRejection, artifactId: string): StateClassification {
  return classifyStateRows([classificationRow(entry, artifactId)]);
}

function entrySummary(artifactId: string, entry: StartupSourceEntry | NumberedArchiveEntry, classification: StateClassification): JsonObject {
  const number = "entryNumber" in entry ? entry.entryNumber : entry.identity.number;
  const fields = "fields" in entry ? entry.fields : {};
  const summary: JsonObject = {};
  for (const key of ["summary", "status", "date", "timestamp", "trajectory", "type", "phase", "review_needed"]) {
    if (key in fields) {
      const value = fields[key];
      summary[key] = typeof value === "string" ? boundedText(value, 160) : value;
    }
  }
  return {
    stable_id: number === null ? null : `${artifactId}:${number}`,
    artifact_id: artifactId,
    entry_number: number,
    addressable: number !== null,
    classification,
    detail_availability: "entryNumber" in entry ? "full" : "summary",
    source: "entryNumber" in entry ? "archive" : "current_projection",
    provenance: {
      source: "entryNumber" in entry ? "archive" : "current_projection",
      origin: "entryNumber" in entry ? "numbered_archive" : entry.origin,
      path: "entryNumber" in entry ? entry.path : entry.path,
    },
    ...(Object.keys(summary).length > 0 ? { summary } : {}),
  };
}

function countsFor(
  artifactId: string,
  current: StartupSourceEntry[],
  archives: NumberedArchiveEntry[],
  rejected: ArchiveRejection[],
  returned: number,
): StartupHistoryCounts {
  const currentByNumber = new Map<number, number>();
  const archiveByNumber = new Map<number, number>();
  let unaddressable = 0;
  let ambiguous = 0;
  for (const entry of current) {
    if (entry.identity.kind === "ambiguous") ambiguous += 1;
    else if (entry.identity.number === null) unaddressable += 1;
    else currentByNumber.set(entry.identity.number, (currentByNumber.get(entry.identity.number) ?? 0) + 1);
  }
  for (const entry of archives) archiveByNumber.set(entry.entryNumber, (archiveByNumber.get(entry.entryNumber) ?? 0) + 1);
  for (const item of rejected) {
    if (!item.path.includes(path.join(`${path.sep}${artifactId}`, ""))) continue;
    const number = archiveNumber(item, artifactId);
    if (number === null) unaddressable += 1;
    else archiveByNumber.set(number, (archiveByNumber.get(number) ?? 0) + 1);
  }
  const ids = new Set([...currentByNumber.keys(), ...archiveByNumber.keys()]);
  let mirrored = 0;
  let duplicate = 0;
  let conflict = 0;
  for (const number of ids) {
    const classification = classifyNumber(artifactId, number, current, archives, rejected);
    if (classification === "mirrored") mirrored += 1;
    if (classification === "duplicate") duplicate += 1;
    if (classification === "conflict") conflict += 1;
  }
  const physical = current.length + archives.length + rejected.filter((item) => item.path.includes(path.join(`${path.sep}${artifactId}`, ""))).length;
  return {
    physical,
    addressable: physical - unaddressable - ambiguous,
    addressable_ids: ids.size,
    unaddressable,
    ambiguous,
    mirrored,
    duplicate,
    conflict,
    omitted: Math.max(0, physical - returned),
  };
}

function sourceRows(current: StartupSourceEntry[], archives: NumberedArchiveEntry[], rejected: ArchiveRejection[], artifactId: string): JsonValue[] {
  const rows: JsonObject[] = [];
  for (const entry of current) {
    const number = entry.identity.number;
    const classification = number === null
      ? classifyUnaddressable(entry, artifactId)
      : classifyNumber(artifactId, number, current, archives, rejected);
    rows.push(entrySummary(artifactId, entry, classification));
  }
  for (const entry of archives) {
    rows.push(entrySummary(artifactId, entry, classifyNumber(artifactId, entry.entryNumber, current, archives, rejected)));
  }
  for (const item of rejected.filter((candidate) => candidate.path.includes(path.join(`${path.sep}${artifactId}`, "")))) {
    const number = archiveNumber(item, artifactId);
    const classification = number === null
      ? classifyUnaddressable(item, artifactId)
      : classifyNumber(artifactId, number, current, archives, rejected);
    rows.push({
      stable_id: number === null ? null : `${artifactId}:${number}`,
      artifact_id: artifactId,
      entry_number: number,
      addressable: number !== null,
      classification,
      detail_availability: "unavailable",
      source: "archive",
      provenance: { source: "archive", origin: "rejected_archive", path: item.path },
      compatibility: "blocked",
      rejection: item.reason,
    });
  }
  return rows.sort((left, right) => Number(right.entry_number ?? 0) - Number(left.entry_number ?? 0)).slice(0, 2);
}

export function startupHistorySummary(
  projectRoot: string,
  artifactId: "progress" | "decisions" | "health",
  sourceRoot: string = resolveSourceRoot(),
): StartupHistorySummary {
  const scans = scanStartupArtifact(projectRoot, artifactId, sourceRoot);
  const currentPath = scans.active.path;
  const scan = {
    ...scans.active,
    bytes_scanned: scans.active.bytes_scanned + scans.archive.bytes_scanned,
    entries: [...scans.active.entries, ...scans.archive.entries],
  };
  const discovery = discoverNumberedArchives(projectRoot, { sourceRoot, artifactId, retainRecords: false });
  const rejected = discovery.rejected;
  const entries = sourceRows(scan.entries, discovery.entries, rejected, artifactId);
  const counts = countsFor(artifactId, scan.entries, discovery.entries, rejected, entries.length);
  const retrieval: JsonObject = {
    list: `agentera state ${artifactId} list --limit 20 --format json`,
    get: `agentera state ${artifactId} get --number N --format json`,
  };
  const status = !scan.exists && discovery.entries.length === 0 && rejected.length === 0
    ? "absent"
    : rejected.length > 0 || (scan.exists && !scans.active.collection_found)
      ? "degraded"
      : "available";
  return {
    artifact: artifactId,
    status,
    counts,
    entries,
    source: {
      current_projection: { path: currentPath, present: scan.exists, entries: scan.entries.length },
      archive: { root: discovery.archiveRoot, validated_entries: discovery.entries.length, rejected_count: rejected.length },
      input_scan: {
        current_entries: scan.entries.length,
        current_bytes: scan.bytes_scanned,
        archive_files: discovery.entries.length + rejected.length,
      },
    },
    retrieval,
    omission: {
      omitted: counts.omitted > 0,
      omitted_count: counts.omitted,
      omission_reason: counts.omitted > 0 ? "startup_detail_capacity" : "none",
      retrieval,
    },
  };
}

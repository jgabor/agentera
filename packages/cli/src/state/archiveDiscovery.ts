import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { ArtifactSchemaValidator } from "../hooks/validateArtifact/index.js";
import { assertRealpathBoundary } from "../registries/artifactRegistry.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";

const AUTHORITY_RELATIVE_PATH = "references/artifacts/state-storage-authority.yaml";
const EXPECTED_AUTHORITY_SCHEMA = "agentera.stateStorageAuthority.v1";

type AuthorityMapping = Record<string, unknown>;

export type ArchiveRejectionClass = "corrupt" | "unsupported_artifact" | "project_boundary";

export type ArchiveRejectionReason =
  | "malformed_name"
  | "invalid_envelope"
  | "record_schema"
  | "hash_mismatch"
  | "duplicate_identity"
  | "unsafe_path"
  | "symlink"
  | "unsupported_artifact"
  | "read_failure";

export interface ArchiveRejection {
  path: string;
  class: ArchiveRejectionClass;
  reason: ArchiveRejectionReason;
  message: string;
}

export interface NumberedArchiveEntry {
  path: string;
  stableId: string;
  artifactId: string;
  entryNumber: number;
  envelope?: JsonObject;
  record?: JsonObject;
  recordSha256: string;
}

export interface NumberedArchiveDiscovery {
  archiveRoot: string;
  entries: NumberedArchiveEntry[];
  rejected: ArchiveRejection[];
  ignored: string[];
}

export interface ArchiveDiscoveryOptions {
  sourceRoot?: string;
  artifactId?: string;
  /** Validate archive records without retaining their full bodies for metadata scans. */
  retainRecords?: boolean;
}

interface SupportedArtifact {
  artifactId: string;
  entryCollection: string;
  entryNumberField: string;
}

export interface NumberedArchiveContract {
  artifactId: string;
  entryCollection: string;
  entryNumberField: string;
  archiveRoot: string;
  archiveExtension: string;
  entrySchemaVersion: string;
}

export interface NumberedArchiveLookup {
  path: string;
  entry?: NumberedArchiveEntry;
  rejection?: ArchiveRejection;
}

export interface StateProjectionPolicy {
  activeEntries: number;
  summaryEntries: number;
  totalEntries: number;
  maxUtf8Bytes: number;
}

export interface StateDurabilityContract {
  command: string;
  defaultLimit: number;
  maximumLimit: number;
  statusValues: string[];
  localValues: string[];
  gitValues: string[];
}

export interface DecisionOverlayContract {
  location: string;
  schemaVersion: string;
  identityKey: string;
  identityPrefix: string;
  mutablePaths: string[];
  derivedPaths: string[];
  immutablePaths: string[];
  stateValues: string[];
  allowedNext: Record<string, string[]>;
}

interface ArchiveAuthority {
  archiveRoot: string;
  archiveExtension: string;
  entryNamePattern: RegExp;
  requiredEnvelopeFields: Set<string>;
  forbiddenEnvelopeFields: Set<string>;
  entrySchemaVersion: string;
  supportedArtifacts: Map<string, SupportedArtifact>;
  currentProjectionPaths: Map<string, string>;
  ignoredRootNames: Set<string>;
  decisionOverlay: DecisionOverlayContract;
  projection: StateProjectionPolicy;
  durability: StateDurabilityContract;
}

function isMapping(value: unknown): value is AuthorityMapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapping(value: unknown): AuthorityMapping {
  return isMapping(value) ? value : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`state storage authority field '${field}' must be a non-empty string`);
  }
  return value;
}

function requiredStringList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`state storage authority field '${field}' must be a list of non-empty strings`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`state storage authority field '${field}' must be a positive integer`);
  }
  return value;
}

function loadAuthority(sourceRoot: string): ArchiveAuthority {
  const authorityPath = path.join(sourceRoot, AUTHORITY_RELATIVE_PATH);
  const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  if (authority.schema_version !== EXPECTED_AUTHORITY_SCHEMA) {
    throw new Error(`state storage authority schema_version must be ${EXPECTED_AUTHORITY_SCHEMA}`);
  }
  if (authority.status !== "active_authority") {
    throw new Error("state storage authority must be active_authority");
  }

  const projectRoot = mapping(mapping(authority.storage).project_root);
  if (projectRoot.fixed !== true || projectRoot.path_override !== "forbidden") {
    throw new Error("state storage authority must fix the project-local archive root");
  }
  const archiveRoot = requiredString(projectRoot.archive_root, "storage.project_root.archive_root");
  if (path.isAbsolute(archiveRoot) || archiveRoot.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error("state storage authority archive_root must be a safe project-relative path");
  }

  const archive = mapping(mapping(authority.storage).archive);
  const filename = mapping(archive.filename);
  const extension = requiredString(filename.extension, "storage.archive.filename.extension");
  const acceptedPattern = requiredString(
    filename.accepted_pattern,
    "storage.archive.filename.accepted_pattern",
  );
  if (extension !== ".yaml")
    throw new Error("state storage authority archive extension must be .yaml");
  if (acceptedPattern !== "^[1-9][0-9]*$") {
    throw new Error("state storage authority archive filename pattern is unsupported");
  }
  const archivePathTemplate = requiredString(
    projectRoot.archive_path_template,
    "storage.project_root.archive_path_template",
  );
  if (archivePathTemplate !== `${archiveRoot}/<artifact-id>/<entry-number>${extension}`) {
    throw new Error(
      "state storage authority archive_path_template does not match the fixed archive root",
    );
  }

  const envelope = mapping(authority.envelope);
  const requiredEnvelopeFields = new Set(
    requiredStringList(envelope.required_fields, "envelope.required_fields"),
  );
  for (const field of ["schemaVersion", "artifact_id", "entry_number", "record", "record_sha256"]) {
    if (!requiredEnvelopeFields.has(field))
      throw new Error(`state storage authority envelope requires ${field}`);
  }
  const entrySchemaVersion = requiredString(envelope.schema_version, "envelope.schema_version");
  const forbiddenEnvelopeFields = new Set(
    requiredStringList(envelope.forbidden_fields, "envelope.forbidden_fields"),
  );

  const supportedArtifacts = new Map<string, SupportedArtifact>();
  const supported = mapping(authority.scope).supported_artifacts;
  if (!Array.isArray(supported) || supported.length === 0) {
    throw new Error("state storage authority must declare supported artifacts");
  }
  for (const [index, rawArtifact] of supported.entries()) {
    const artifact = mapping(rawArtifact);
    const artifactId = requiredString(
      artifact.artifact_id,
      `scope.supported_artifacts[${index}].artifact_id`,
    );
    if (supportedArtifacts.has(artifactId))
      throw new Error(`duplicate supported artifact ${artifactId}`);
    supportedArtifacts.set(artifactId, {
      artifactId,
      entryCollection: requiredString(
        artifact.entry_collection,
        `scope.supported_artifacts[${index}].entry_collection`,
      ),
      entryNumberField: requiredString(
        artifact.entry_number_field,
        `scope.supported_artifacts[${index}].entry_number_field`,
      ),
    });
  }

  const unchanged = mapping(authority.scope).unchanged_archive_conventions;
  const ignoredRootNames = new Set<string>();
  if (isMapping(unchanged)) {
    for (const [name, rawConvention] of Object.entries(unchanged)) {
      if (mapping(rawConvention).numbered_entry_discovery === "forbidden")
        ignoredRootNames.add(name);
    }
  }

  const overlays = mapping(authority.overlays);
  const overlayLocation = requiredString(overlays.location, "overlays.location");
  if (
    path.isAbsolute(overlayLocation) ||
    overlayLocation.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new Error("state storage authority decision overlay location must be project-relative");
  }
  const identityKey = requiredString(overlays.identity_key, "overlays.identity_key");
  const identityPrefix = identityKey.split(":")[0];
  if (!identityPrefix || identityKey !== `${identityPrefix}:<decision-number>`) {
    throw new Error("state storage authority decision overlay identity_key is unsupported");
  }
  const transitionRules = mapping(overlays.transition_rules);
  const stateValues = requiredStringList(overlays.state_values, "overlays.state_values");
  const allowedNext: Record<string, string[]> = {};
  for (const state of stateValues) {
    const rule = mapping(transitionRules[state]);
    const next = requiredStringList(
      rule.allowed_next,
      `overlays.transition_rules.${state}.allowed_next`,
    );
    if (next.some((value) => !stateValues.includes(value))) {
      throw new Error(`state storage authority transition rule for ${state} contains an unknown state`);
    }
    allowedNext[state] = next;
  }
  const decisionOverlay: DecisionOverlayContract = {
    location: overlayLocation,
    schemaVersion: requiredString(overlays.schema_version, "overlays.schema_version"),
    identityKey,
    identityPrefix,
    mutablePaths: requiredStringList(overlays.mutable_paths, "overlays.mutable_paths"),
    derivedPaths: requiredStringList(overlays.derived_paths, "overlays.derived_paths"),
    immutablePaths: requiredStringList(overlays.immutable_paths, "overlays.immutable_paths"),
    stateValues,
    allowedNext,
  };

  const currentProjection = mapping(mapping(authority.projections).current);
  const currentProjectionPaths = new Map<string, string>();
  const declaredProjectionPaths = mapping(currentProjection.paths);
  for (const artifact of supportedArtifacts.values()) {
    const projectionPath = requiredString(
      declaredProjectionPaths[artifact.artifactId],
      `projections.current.paths.${artifact.artifactId}`,
    );
    if (
      path.isAbsolute(projectionPath) ||
      projectionPath.split(/[\\/]/).some((part) => part === "..")
    ) {
      throw new Error(
        `state storage authority current projection path for ${artifact.artifactId} must be project-relative`,
      );
    }
    currentProjectionPaths.set(artifact.artifactId, projectionPath);
  }
  const capacity = mapping(currentProjection.default_capacity);
  const activeEntries = requiredPositiveInteger(
    capacity.active_entries,
    "projections.current.default_capacity.active_entries",
  );
  const summaryEntries = requiredPositiveInteger(
    capacity.summary_entries,
    "projections.current.default_capacity.summary_entries",
  );
  const totalEntries = requiredPositiveInteger(
    capacity.total_entries,
    "projections.current.default_capacity.total_entries",
  );
  if (activeEntries + summaryEntries !== totalEntries) {
    throw new Error("state storage authority projection capacity must equal active plus summary entries");
  }
  const projectionBudget = mapping(mapping(authority.budgets).projection);
  const maxUtf8Bytes = requiredPositiveInteger(
    projectionBudget.max_utf8_bytes,
    "budgets.projection.max_utf8_bytes",
  );

  const durability = mapping(mapping(authority.api).durability);
  const durabilityCommand = requiredString(durability.command, "api.durability.command");
  const durabilityFormats = requiredStringList(durability.formats, "api.durability.formats");
  if (durabilityFormats.join(",") !== "text,json,yaml") {
    throw new Error("state storage authority durability formats must be text, json, yaml");
  }
  const durabilityDefaultLimit = requiredPositiveInteger(
    durability.default_limit,
    "api.durability.default_limit",
  );
  const durabilityMaximumLimit = requiredPositiveInteger(
    durability.maximum_limit,
    "api.durability.maximum_limit",
  );
  if (durabilityDefaultLimit > durabilityMaximumLimit) {
    throw new Error("state storage authority durability default limit exceeds maximum limit");
  }
  const durabilityStatuses = requiredStringList(durability.status_values, "api.durability.status_values");
  const localStatuses = requiredStringList(durability.local_values, "api.durability.local_values");
  const gitStatuses = requiredStringList(durability.git_values, "api.durability.git_values");

  return {
    archiveRoot,
    archiveExtension: extension,
    entryNamePattern: new RegExp(acceptedPattern),
    requiredEnvelopeFields,
    forbiddenEnvelopeFields,
    entrySchemaVersion,
    supportedArtifacts,
    currentProjectionPaths,
    ignoredRootNames,
    decisionOverlay,
    projection: { activeEntries, summaryEntries, totalEntries, maxUtf8Bytes },
    durability: {
      command: durabilityCommand,
      defaultLimit: durabilityDefaultLimit,
      maximumLimit: durabilityMaximumLimit,
      statusValues: durabilityStatuses,
      localValues: localStatuses,
      gitValues: gitStatuses,
    },
  };
}

function rejection(
  filePath: string,
  reason: ArchiveRejectionReason,
  message: string,
  rejectionClass: ArchiveRejectionClass = "corrupt",
): ArchiveRejection {
  return { path: filePath, class: rejectionClass, reason, message };
}

function escapedPath(projectRoot: string, candidate: string): boolean {
  const relative = path.relative(projectRoot, candidate);
  return relative !== "" && (relative.startsWith(".." + path.sep) || path.isAbsolute(relative));
}

function pathIssue(
  projectRoot: string,
  candidate: string,
  expected: "directory" | "file",
): { reason: "unsafe_path" | "symlink"; message: string } | null {
  if (escapedPath(projectRoot, candidate)) {
    return { reason: "unsafe_path", message: "archive path escapes the selected project root" };
  }
  const relative = path.relative(projectRoot, candidate);
  let cursor = projectRoot;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) {
      return { reason: "symlink", message: "archive path contains a symbolic link" };
    }
    if (cursor !== candidate && !stat.isDirectory()) {
      return { reason: "unsafe_path", message: "archive path contains a non-directory parent" };
    }
  }

  try {
    assertRealpathBoundary(projectRoot, candidate, "numbered archive");
  } catch (error) {
    return { reason: "unsafe_path", message: (error as Error).message };
  }

  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink())
      return { reason: "symlink", message: "archive record is a symbolic link" };
    if (expected === "directory" && !stat.isDirectory()) {
      return { reason: "unsafe_path", message: "archive artifact path is not a directory" };
    }
    if (expected === "file" && !stat.isFile()) {
      return { reason: "unsafe_path", message: "archive record path is not a regular file" };
    }
  } catch {
    return null;
  }
  return null;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("record contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("record contains a cyclic value");
    ancestors.add(value);
    const serialized = `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return serialized;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (ancestors.has(object)) throw new Error("record contains a cyclic value");
    ancestors.add(object);
    const serialized = `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`)
      .join(",")}}`;
    ancestors.delete(object);
    return serialized;
  }
  throw new Error("record contains a value that cannot be represented as canonical JSON");
}

export function canonicalRecordJson(value: unknown): string {
  return canonicalJson(value);
}

export function numberedArchiveContract(
  artifactId: string,
  sourceRoot: string = resolveSourceRoot(),
): NumberedArchiveContract {
  const authority = loadAuthority(sourceRoot);
  const artifact = authority.supportedArtifacts.get(artifactId);
  if (!artifact) throw new Error(`unsupported numbered archive artifact '${artifactId}'`);
  return {
    artifactId: artifact.artifactId,
    entryCollection: artifact.entryCollection,
    entryNumberField: artifact.entryNumberField,
    archiveRoot: authority.archiveRoot,
    archiveExtension: authority.archiveExtension,
    entrySchemaVersion: authority.entrySchemaVersion,
  };
}

export function numberedArchiveArtifacts(sourceRoot: string = resolveSourceRoot()): string[] {
  return [...loadAuthority(sourceRoot).supportedArtifacts.keys()];
}

export function stateProjectionPolicy(
  sourceRoot: string = resolveSourceRoot(),
): StateProjectionPolicy {
  return loadAuthority(sourceRoot).projection;
}

export function stateDurabilityContract(
  sourceRoot: string = resolveSourceRoot(),
): StateDurabilityContract {
  return loadAuthority(sourceRoot).durability;
}


export function stateCurrentProjectionPath(
  projectRoot: string,
  artifactId: string,
  sourceRoot: string = resolveSourceRoot(),
): string {
  const authority = loadAuthority(sourceRoot);
  if (!authority.supportedArtifacts.has(artifactId)) {
    throw new Error(`unsupported numbered archive artifact '${artifactId}'`);
  }
  const relative = authority.currentProjectionPaths.get(artifactId);
  if (!relative) throw new Error(`current projection path is undeclared for '${artifactId}'`);
  return path.resolve(projectRoot, relative);
}

export function decisionOverlayContract(
  sourceRoot: string = resolveSourceRoot(),
): DecisionOverlayContract {
  return loadAuthority(sourceRoot).decisionOverlay;
}

export function validateStateRecord(
  sourceRoot: string,
  artifactId: string,
  record: JsonObject,
): string[] {
  const authority = loadAuthority(sourceRoot);
  const artifact = authority.supportedArtifacts.get(artifactId);
  if (!artifact) throw new Error(`unsupported numbered archive artifact '${artifactId}'`);
  return validateRecordSchema(sourceRoot, artifact, record);
}

function positiveEntryNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function logicalNumber(name: string, extension: string): number | null {
  if (!name.endsWith(extension)) return null;
  const stem = name.slice(0, -extension.length);
  if (!/^[+0-9]+$/.test(stem) || !/[1-9]/.test(stem)) return null;
  const value = Number(stem.replace(/^\+/, ""));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validateRecordSchema(
  sourceRoot: string,
  artifact: SupportedArtifact,
  record: JsonObject,
): string[] {
  const validator = new ArtifactSchemaValidator(
    path.join(sourceRoot, "skills", "agentera", "schemas", "artifacts"),
  );
  const schema = validator.loadSchema(artifact.artifactId);
  if (schema === null) return [`${artifact.artifactId}: schema is unavailable`];
  return validator.validateYaml(
    dumpYamlMapping({ [artifact.entryCollection]: [record] }),
    schema,
    artifact.artifactId,
  );
}

function validateCandidate(
  filePath: string,
  artifact: SupportedArtifact,
  entryNumber: number,
  bytes: string,
  authority: ArchiveAuthority,
  sourceRoot: string,
  seenIds: Set<string>,
  retainRecords = true,
  recordValidator?: (record: JsonObject) => string[],
): NumberedArchiveEntry | ArchiveRejection {
  let envelope: AuthorityMapping;
  try {
    envelope = loadYamlMapping(bytes);
  } catch (error) {
    return rejection(
      filePath,
      "invalid_envelope",
      `cannot parse archive envelope: ${(error as Error).message}`,
    );
  }

  const missing = [...authority.requiredEnvelopeFields].filter((field) => !(field in envelope));
  if (missing.length > 0) {
    return rejection(
      filePath,
      "invalid_envelope",
      `archive envelope is missing required fields: ${missing.join(", ")}`,
    );
  }
  const forbidden = [...authority.forbiddenEnvelopeFields].filter((field) => field in envelope);
  if (forbidden.length > 0) {
    return rejection(
      filePath,
      "invalid_envelope",
      `archive envelope contains forbidden fields: ${forbidden.join(", ")}`,
    );
  }
  if (envelope.schemaVersion !== authority.entrySchemaVersion) {
    return rejection(
      filePath,
      "invalid_envelope",
      `schemaVersion must be ${authority.entrySchemaVersion}`,
    );
  }
  if (envelope.artifact_id !== artifact.artifactId) {
    return rejection(
      filePath,
      "invalid_envelope",
      "envelope artifact_id does not match its archive directory",
    );
  }
  if (positiveEntryNumber(envelope.entry_number) !== entryNumber) {
    return rejection(
      filePath,
      "invalid_envelope",
      "envelope entry_number does not match its filename",
    );
  }
  if (!isMapping(envelope.record)) {
    return rejection(filePath, "invalid_envelope", "envelope record must be a mapping");
  }
  const record = envelope.record as JsonObject;
  if (positiveEntryNumber(record[artifact.entryNumberField]) !== entryNumber) {
    return rejection(
      filePath,
      "invalid_envelope",
      "record entry number does not match its filename",
    );
  }
  if (
    typeof envelope.record_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(envelope.record_sha256)
  ) {
    return rejection(
      filePath,
      "invalid_envelope",
      "record_sha256 must be a lowercase 64-character SHA-256 digest",
    );
  }

  let canonicalRecord: string;
  try {
    canonicalRecord = canonicalJson(record);
  } catch (error) {
    return rejection(filePath, "invalid_envelope", (error as Error).message);
  }
  const actualHash = createHash("sha256").update(canonicalRecord, "utf8").digest("hex");
  if (actualHash !== envelope.record_sha256) {
    return rejection(
      filePath,
      "hash_mismatch",
      "record_sha256 does not match the canonical record",
    );
  }

  const stableId = `${artifact.artifactId}:${entryNumber}`;
  if (seenIds.has(stableId)) {
    return rejection(filePath, "duplicate_identity", `duplicate archive identity ${stableId}`);
  }

  const schemaViolations = recordValidator ? recordValidator(record) : validateRecordSchema(sourceRoot, artifact, record);
  if (schemaViolations.length > 0) {
    return rejection(filePath, "record_schema", schemaViolations.join("; "));
  }

  seenIds.add(stableId);
  return {
    path: filePath,
    stableId,
    artifactId: artifact.artifactId,
    entryNumber,
    ...(retainRecords ? { envelope: envelope as JsonObject, record } : {}),
    recordSha256: envelope.record_sha256,
  };
}

/**
 * Read one canonical archive path. Direct retrieval intentionally does not
 * enumerate the archive directory or inspect unrelated historical records.
 */
export function readNumberedArchiveEntry(
  projectRoot: string,
  artifactId: string,
  entryNumber: number,
  options: { sourceRoot?: string; recordValidator?: (record: JsonObject) => string[] } = {},
): NumberedArchiveLookup {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const authority = loadAuthority(sourceRoot);
  const artifact = authority.supportedArtifacts.get(artifactId);
  if (!artifact) throw new Error(`unsupported numbered archive artifact '${artifactId}'`);
  const resolvedProjectRoot = path.resolve(projectRoot);
  const relativeTarget = path.posix.join(
    authority.archiveRoot,
    artifactId,
    `${entryNumber}${authority.archiveExtension}`,
  );
  const target = path.join(resolvedProjectRoot, ...relativeTarget.split("/"));
  const snapshot = readProjectFileSnapshot(validateRealProjectRoot(resolvedProjectRoot), relativeTarget);
  if (snapshot.kind === "missing") return { path: target };
  if (snapshot.kind === "unsafe") return { path: target, rejection: rejection(target, snapshot.reason === "symlink" ? "symlink" : "unsafe_path", `archive record path is unsafe (${snapshot.reason})`) };
  const bytes = snapshot.bytes.toString("utf8");
  const result = validateCandidate(
    target,
    artifact,
    entryNumber,
    bytes,
    authority,
    sourceRoot,
    new Set<string>(),
    true,
    options.recordValidator,
  );
  return "stableId" in result ? { path: target, entry: result } : { path: target, rejection: result };
}

/** Validate one pinned archive blob without consulting the working tree. */
export function validateNumberedArchiveBytes(
  artifactId: string,
  entryNumber: number,
  bytes: string,
  options: { sourceRoot?: string; sourcePath?: string; recordValidator?: (record: JsonObject) => string[] } = {},
): NumberedArchiveLookup {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const authority = loadAuthority(sourceRoot);
  const artifact = authority.supportedArtifacts.get(artifactId);
  if (!artifact) throw new Error(`unsupported numbered archive artifact '${artifactId}'`);
  const sourcePath = options.sourcePath ?? path.posix.join(authority.archiveRoot, artifactId, `${entryNumber}${authority.archiveExtension}`);
  const result = validateCandidate(sourcePath, artifact, entryNumber, bytes, authority, sourceRoot, new Set<string>(), true, options.recordValidator);
  return "stableId" in result ? { path: sourcePath, entry: result } : { path: sourcePath, rejection: result };
}

function scanArtifactDirectory(
  projectRoot: string,
  sourceRoot: string,
  directory: string,
  artifact: SupportedArtifact,
  authority: ArchiveAuthority,
  entries: NumberedArchiveEntry[],
  rejected: ArchiveRejection[],
  seenIds: Set<string>,
  retainRecords: boolean,
): void {
  const directoryIssue = pathIssue(projectRoot, directory, "directory");
  if (directoryIssue) {
    rejected.push(rejection(directory, directoryIssue.reason, directoryIssue.message));
    return;
  }

  let names: string[];
  try {
    names = fs.readdirSync(directory).sort();
  } catch (error) {
    rejected.push(
      rejection(
        directory,
        "read_failure",
        `cannot read archive artifact directory: ${(error as Error).message}`,
      ),
    );
    return;
  }

  const logicalNumbers = new Map<number, string>();
  for (const name of names) {
    const number = logicalNumber(name, authority.archiveExtension);
    if (number === null) continue;
    const existing = logicalNumbers.get(number);
    const canonicalName = `${number}${authority.archiveExtension}`;
    if (existing === undefined || name === canonicalName) logicalNumbers.set(number, name);
  }
  for (const name of names) {
    const number = logicalNumber(name, authority.archiveExtension);
    const canonicalName = number === null ? null : `${number}${authority.archiveExtension}`;
    if (number !== null && logicalNumbers.get(number) !== name && logicalNumbers.has(number)) {
      rejected.push(
        rejection(
          path.join(directory, name),
          "duplicate_identity",
          `multiple filenames identify ${artifact.artifactId}:${number}; only the canonical filename is eligible`,
        ),
      );
      continue;
    }
    const stem = name.endsWith(authority.archiveExtension)
      ? name.slice(0, -authority.archiveExtension.length)
      : "";
    if (!authority.entryNamePattern.test(stem)) {
      rejected.push(
        rejection(
          path.join(directory, name),
          "malformed_name",
          `archive filename must be a positive decimal followed by ${authority.archiveExtension}`,
        ),
      );
      continue;
    }
    const entryNumber = Number(stem);
    const filePath = path.join(directory, name);
    if (!Number.isSafeInteger(entryNumber) || entryNumber <= 0 || canonicalName !== name) {
      rejected.push(
        rejection(
          filePath,
          "malformed_name",
          `archive filename must use the canonical decimal form followed by ${authority.archiveExtension}`,
        ),
      );
      continue;
    }
    const fileIssue = pathIssue(projectRoot, filePath, "file");
    if (fileIssue) {
      rejected.push(rejection(filePath, fileIssue.reason, fileIssue.message));
      continue;
    }
    let bytes: string;
    try {
      bytes = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      rejected.push(
        rejection(
          filePath,
          "read_failure",
          `cannot read archive record: ${(error as Error).message}`,
        ),
      );
      continue;
    }
    const result = validateCandidate(
      filePath,
      artifact,
      entryNumber,
      bytes,
      authority,
      sourceRoot,
      seenIds,
      retainRecords,
    );
    if ("path" in result && "stableId" in result) entries.push(result);
    else rejected.push(result);
  }
}

/**
 * Discover immutable numbered state records without creating or modifying any
 * project files. The fixed archive root and all validation rules come from the
 * state-storage authority and the existing artifact schemas.
 */
export function discoverNumberedArchives(
  projectRoot: string,
  options: ArchiveDiscoveryOptions = {},
): NumberedArchiveDiscovery {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const authority = loadAuthority(sourceRoot);
  const resolvedProjectRoot = path.resolve(projectRoot);
  const archiveRoot = path.join(resolvedProjectRoot, authority.archiveRoot);
  const result: NumberedArchiveDiscovery = { archiveRoot, entries: [], rejected: [], ignored: [] };

  const archiveRootIssue = pathIssue(resolvedProjectRoot, archiveRoot, "directory");
  if (archiveRootIssue) {
    result.rejected.push(rejection(archiveRoot, archiveRootIssue.reason, archiveRootIssue.message));
    return result;
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(archiveRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    result.rejected.push(
      rejection(
        archiveRoot,
        "read_failure",
        `cannot inspect archive root: ${(error as Error).message}`,
      ),
    );
    return result;
  }
  if (rootStat.isSymbolicLink()) {
    result.rejected.push(rejection(archiveRoot, "symlink", "archive root is a symbolic link"));
    return result;
  }
  if (!rootStat.isDirectory()) {
    result.rejected.push(rejection(archiveRoot, "unsafe_path", "archive root is not a directory"));
    return result;
  }

  let rootEntries: fs.Dirent[];
  try {
    rootEntries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch (error) {
    result.rejected.push(
      rejection(
        archiveRoot,
        "read_failure",
        `cannot read archive root: ${(error as Error).message}`,
      ),
    );
    return result;
  }

  const seenIds = new Set<string>();
  for (const rootEntry of rootEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rootPath = path.join(archiveRoot, rootEntry.name);
    if (authority.ignoredRootNames.has(rootEntry.name)) {
      result.ignored.push(rootPath);
      continue;
    }
    if (options.artifactId && rootEntry.name !== options.artifactId) {
      result.ignored.push(rootPath);
      continue;
    }
    const artifact = authority.supportedArtifacts.get(rootEntry.name);
    if (!rootEntry.isDirectory()) {
      if (artifact) {
        const reason = rootEntry.isSymbolicLink() ? "symlink" : "unsafe_path";
        result.rejected.push(
          rejection(
            rootPath,
            reason,
            rootEntry.isSymbolicLink()
              ? "archive artifact directory is a symbolic link"
              : "archive artifact path is not a directory",
          ),
        );
      } else {
        result.ignored.push(rootPath);
      }
      continue;
    }
    if (!artifact) {
      result.rejected.push(
        rejection(
          rootPath,
          "unsupported_artifact",
          `unsupported numbered archive directory '${rootEntry.name}'`,
          "unsupported_artifact",
        ),
      );
      continue;
    }
    scanArtifactDirectory(
      resolvedProjectRoot,
      sourceRoot,
      rootPath,
      artifact,
      authority,
      result.entries,
      result.rejected,
      seenIds,
      options.retainRecords !== false,
    );
  }

  result.entries.sort(
    (a, b) => b.entryNumber - a.entryNumber || a.stableId.localeCompare(b.stableId),
  );
  return result;
}

export function stateStorageAuthorityPath(sourceRoot: string = resolveSourceRoot()): string {
  return path.join(sourceRoot, AUTHORITY_RELATIVE_PATH);
}

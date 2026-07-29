import { createHash } from "node:crypto";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson, numberedArchiveContract, stateCurrentProjectionPath, validateNumberedArchiveBytes, validateStateRecord } from "./archiveDiscovery.js";
import { canonicalMigrationRecord } from "./canonicalMigrationRecord.js";
import { classifyCompleteDecisionConfidence } from "./decisionLegacyValidation.js";
import { decisionRevisionContract, decisionRevisionViolations, legacyLabelCoexistence } from "./decisionRevision.js";
import { readBoundMigrationSource, type MigrationSourceBindingContext } from "./migrationSourceBinding.js";
import { entityMigrationId } from "./entityMigrationIdentity.js";

export interface MigrationProvenanceDeclaration {
  requiredFields: string[];
  kind: string;
  sources: string[];
  additionalFields: "forbidden";
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate the sole authority-declared canonical migration metadata shape. */
export function decisionMigrationProvenanceViolations(
  record: JsonObject,
  provenance: unknown,
  declared: MigrationProvenanceDeclaration,
  forbiddenAliases: readonly string[],
  sourceRoot?: string,
  binding?: MigrationSourceBindingContext,
): string[] {
  if (declared.additionalFields !== "forbidden" || !declared.kind || declared.requiredFields.length === 0 || declared.sources.length === 0) {
    throw new Error("invalid migration provenance authority for 'decision'");
  }
  const coexistence = legacyLabelCoexistence(sourceRoot ?? resolveSourceRoot());
  const confidence = record.confidence;
  if (typeof confidence !== "string") return ["confidence must be a string from the authority-declared vocabulary"];
  if (coexistence.currentVocabulary.includes(confidence)) {
    return provenance === null || provenance === undefined ? [] : ["migration_provenance is allowed only for an inherited unsupported confidence"];
  }
  if (!coexistence.knownLegacyExamples.includes(confidence)) return [`unsupported decision confidence '${confidence}'`];
  if (!mapping(provenance)) return ["an inherited unsupported confidence requires mapping migration_provenance"];
  const violations: string[] = [];
  const declaredKeys = new Set(declared.requiredFields);
  for (const field of declared.requiredFields) if (!(field in provenance)) violations.push(`migration_provenance.${field} is required`);
  for (const field of Object.keys(provenance)) if (!declaredKeys.has(field)) violations.push(`migration_provenance.${field} is not allowed`);
  if (provenance.kind !== declared.kind) violations.push(`migration_provenance.kind must be '${declared.kind}'`);
  if (typeof provenance.source !== "string" || !declared.sources.includes(provenance.source)) violations.push(`migration_provenance.source must be one of: ${declared.sources.join(", ")}`);
  if (typeof provenance.source_path !== "string" || provenance.source_path.length === 0 || path.isAbsolute(provenance.source_path) || provenance.source_path.split(/[\\/]/).includes("..")) violations.push("migration_provenance.source_path must be a safe project-relative path");
  if (typeof provenance.source_record_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(provenance.source_record_sha256)) violations.push("migration_provenance.source_record_sha256 must be a lowercase SHA-256 digest");
  if (provenance.confidence !== confidence) violations.push("migration_provenance.confidence must match record.confidence");
  if (violations.length) return violations;
  if (binding === undefined) return ["an inherited unsupported confidence requires a source binding context"];
  violations.push(...sourceBindingViolations(record, provenance as JsonObject, binding, sourceRoot ?? resolveSourceRoot(), forbiddenAliases));
  return violations;
}

export function decisionRevisionMigrationProvenanceViolations(
  record: JsonObject,
  provenance: unknown,
  declared: MigrationProvenanceDeclaration,
  sourceRoot: string = resolveSourceRoot(),
  binding?: MigrationSourceBindingContext,
): string[] {
  const changes = mapping(record.changes) ? record.changes as JsonObject : {};
  const confidence = changes.confidence;
  const coexistence = legacyLabelCoexistence(sourceRoot);
  if (confidence === undefined || coexistence.currentVocabulary.includes(String(confidence))) {
    return provenance === null || provenance === undefined ? [] : ["migration_provenance is allowed only for an inherited unsupported revision confidence"];
  }
  if (typeof confidence !== "string" || !coexistence.knownLegacyExamples.includes(confidence)) return [`unsupported decision revision confidence '${String(confidence)}'`];
  if (!mapping(provenance)) return ["an inherited unsupported revision confidence requires mapping migration_provenance"];
  const violations: string[] = [];
  const declaredKeys = new Set(declared.requiredFields);
  for (const field of declared.requiredFields) if (!(field in provenance)) violations.push(`migration_provenance.${field} is required`);
  for (const field of Object.keys(provenance)) if (!declaredKeys.has(field)) violations.push(`migration_provenance.${field} is not allowed`);
  if (provenance.kind !== declared.kind) violations.push(`migration_provenance.kind must be '${declared.kind}'`);
  if (typeof provenance.source !== "string" || !declared.sources.includes(provenance.source)) violations.push(`migration_provenance.source must be one of: ${declared.sources.join(", ")}`);
  const contract = decisionRevisionContract(sourceRoot);
  if (provenance.source_path !== contract.location) violations.push(`migration_provenance.source_path must be '${contract.location}'`);
  if (typeof provenance.source_identity !== "string" || !/^decision_revision:decisions:[1-9][0-9]*:[0-9]+$/.test(provenance.source_identity)) violations.push("migration_provenance.source_identity must identify one ordered legacy decision revision");
  if (typeof provenance.source_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(provenance.source_fingerprint)) violations.push("migration_provenance.source_fingerprint must be a lowercase SHA-256 digest");
  if (typeof provenance.source_record_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(provenance.source_record_sha256)) violations.push("migration_provenance.source_record_sha256 must be a lowercase SHA-256 digest");
  if (provenance.confidence !== confidence) violations.push("migration_provenance.confidence must match record.changes.confidence");
  if (violations.length) return violations;
  if (binding === undefined) return ["an inherited unsupported revision confidence requires a source binding context"];
  const match = /^decision_revision:(decisions:[1-9][0-9]*):([0-9]+)$/.exec(String(provenance.source_identity));
  if (!match || entityMigrationId(String(provenance.source_fingerprint), match[1]) !== record.decision) return ["migration_provenance source identity does not bind the canonical decision ID"];
  if (binding.kind !== "migration_preview") {
    const markerFile = readBoundMigrationSource(binding, ".agentera/state-mode.yaml");
    if (markerFile.kind !== "file") return ["migration_provenance requires the durable entity cutover marker"];
    let marker: Record<string, unknown>;
    try { marker = loadYamlMapping(markerFile.bytes); }
    catch (error) { return [`entity cutover marker is invalid YAML: ${(error as Error).message}`]; }
    if (marker.schemaVersion !== "agentera.stateMode.v1" || marker.mode !== "entities" || marker.source_fingerprint !== provenance.source_fingerprint) return ["migration_provenance source_fingerprint does not match the durable entity cutover marker"];
  }
  const sourceFile = readBoundMigrationSource(binding, contract.location);
  if (sourceFile.kind !== "file") return [`migration_provenance source '${contract.location}' is ${sourceFile.kind === "missing" ? "missing" : `unsafe (${sourceFile.reason})`}`];
  let document: Record<string, unknown>;
  try { document = loadYamlMapping(sourceFile.bytes); }
  catch (error) { return [`migration_provenance source '${contract.location}' is invalid YAML: ${(error as Error).message}`]; }
  const candidate = match && Array.isArray(document[match[1]]) ? mapping((document[match[1]] as unknown[])[Number(match[2])]) ? (document[match[1]] as JsonObject[])[Number(match[2])] : null : null;
  if (!match || !candidate) return ["migration_provenance source_identity does not resolve to one legacy decision revision"];
  if (sourceHash(candidate) !== provenance.source_record_sha256) return ["migration_provenance source_record_sha256 does not match the legacy decision revision"];
  const sourceViolations = decisionRevisionViolations({ [match[1]]: [candidate] }, contract);
  if (sourceViolations.length) return [`migration_provenance source revision is invalid: ${sourceViolations.join("; ")}`];
  const candidateChanges = Object.fromEntries(Object.entries(candidate).filter(([field]) => !["date", "provenance", "base_sha256"].includes(field)));
  if (canonicalRecordJson(candidateChanges) !== canonicalRecordJson(changes)) return ["migration_provenance source revision changes do not match the canonical revision"];
  if ((candidate.date ?? undefined) !== (record.date ?? undefined)) return ["migration_provenance source revision date does not match the canonical revision"];
  if ((candidate.provenance ?? "historical_revision") !== record.provenance) return ["migration_provenance source revision provenance does not match the canonical revision"];
  return [];
}

function sourceAssessment(record: JsonObject, sourceRoot: string, source: "active" | "archive") {
  return classifyCompleteDecisionConfidence(
    record,
    legacyLabelCoexistence(sourceRoot),
    (candidate) => validateStateRecord(sourceRoot, "decisions", candidate as JsonObject),
    source,
  );
}

function sourceMatchesCanonical(source: JsonObject, canonical: JsonObject, forbiddenAliases: readonly string[]): boolean {
  return canonicalRecordJson(canonicalMigrationRecord("decision", source, forbiddenAliases)) === canonicalRecordJson(canonical);
}

function sourceHash(record: JsonObject): string {
  return createHash("sha256").update(canonicalRecordJson(record)).digest("hex");
}

function sourceBindingViolations(record: JsonObject, provenance: JsonObject, binding: MigrationSourceBindingContext, sourceRoot: string, forbiddenAliases: readonly string[]): string[] {
  const sourcePath = String(provenance.source_path);
  const digest = String(provenance.source_record_sha256);
  const confidence = String(provenance.confidence);
  if (provenance.source === "current_projection") {
    const declaredPath = path.relative("/", stateCurrentProjectionPath("/", "decisions", sourceRoot)).split(path.sep).join("/");
    if (sourcePath !== declaredPath) return [`migration_provenance.source_path must be the authority-declared current projection '${declaredPath}'`];
    const sourceFile = readBoundMigrationSource(binding, declaredPath);
    if (sourceFile.kind !== "file") return [`migration_provenance source '${declaredPath}' is ${sourceFile.kind === "missing" ? "missing" : `unsafe (${sourceFile.reason})`}`];
    let document: Record<string, unknown>;
    try { document = loadYamlMapping(sourceFile.bytes); }
    catch (error) { return [`migration_provenance source '${declaredPath}' is invalid YAML: ${(error as Error).message}`]; }
    const candidates = [document.decisions, document.archive].flatMap((value) => Array.isArray(value) ? value.filter(mapping) as JsonObject[] : []);
    const candidate = candidates.find((source) => sourceHash(source) === digest && source.confidence === confidence && sourceMatchesCanonical(source, record, forbiddenAliases));
    if (!candidate) return ["migration_provenance does not match any complete decision in the preserved current projection"];
    const assessment = sourceAssessment(candidate, sourceRoot, "active");
    return assessment.status === "inherited" ? [] : ["migration_provenance current-projection source is not a complete inherited-confidence decision"];
  }

  const contract = numberedArchiveContract("decisions", sourceRoot);
  const archivePrefix = path.posix.join(contract.archiveRoot, "decisions");
  const escapedExtension = contract.archiveExtension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${archivePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([1-9][0-9]*)${escapedExtension}$`).exec(sourcePath);
  if (!match) return [`migration_provenance.source_path must be an authority-valid numbered decision archive path under '${archivePrefix}'`];
  const entryNumber = Number(match[1]);
  const sourceFile = readBoundMigrationSource(binding, sourcePath);
  if (sourceFile.kind !== "file") return [`migration_provenance archive source is ${sourceFile.kind === "missing" ? "missing" : `unsafe (${sourceFile.reason})`}: ${sourcePath}`];
  const lookup = validateNumberedArchiveBytes("decisions", entryNumber, sourceFile.bytes, {
    sourceRoot,
    sourcePath,
    recordValidator: (source) => {
      const assessment = sourceAssessment(source, sourceRoot, "archive");
      return assessment.status === "inherited" ? [] : assessment.violations.length ? assessment.violations : ["archive decision is not inherited legacy confidence"];
    },
  });
  if (!lookup.entry?.record) return [`migration_provenance archive source is missing or invalid: ${lookup.rejection?.message ?? sourcePath}`];
  const source = lookup.entry.record;
  if (lookup.entry.recordSha256 !== digest || sourceHash(source) !== digest) return ["migration_provenance source_record_sha256 does not match the authority-valid archive record"];
  if (source.confidence !== confidence) return ["migration_provenance confidence does not match the archive record"];
  if (!sourceMatchesCanonical(source, record, forbiddenAliases)) return ["migration_provenance archive record does not correspond to the canonical decision content"];
  return [];
}

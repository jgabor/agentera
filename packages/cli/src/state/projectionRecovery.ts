import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { JsonObject } from "../core/jsonValue.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { yamlArchiveEntry } from "../hooks/compaction/retention.js";
import { canonicalRecordJson, numberedArchiveContract, validateStateRecord } from "./archiveDiscovery.js";
import { publishNumberedArchive, serializeNumberedArchive } from "./archivePublication.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { acquireWriterLock } from "./write/lock.js";

const CONVERTER_VERSION = "agentera.legacyHealthMarkdown.v1";
const ARTIFACTS = {
  decisions: { path: ".agentera/decisions.yaml", collection: "decisions" },
  health: { path: ".agentera/health.yaml", collection: "audits" },
} as const;
const MAX_RESULTS = 100;
export const PROJECTION_CORRELATION_MANIFEST = ".agentera/archive/recovery/projection-correlation.yaml";

type Artifact = keyof typeof ARTIFACTS;
type RefusalClass = "candidate_missing" | "candidate_ambiguous" | "merge_transition" | "source_changed" | "schema_invalid" | "immutable_conflict" | "manifest_mismatch";

export interface ProjectionRecoveryCandidate {
  artifact: Artifact;
  number: number;
  target: string;
  status: "ready" | "approval_required" | "replay" | "refused";
  record_sha256: string | null;
  current_projection_sha256: string;
  recovery_provenance: JsonObject | null;
  correlation: JsonObject | null;
  refusal?: { class: RefusalClass; message: string };
  record?: JsonObject;
}

export interface ProjectionRecoveryResult {
  schemaVersion: "agentera.projectionRecovery.v1";
  command: "state backfill --recover-projections";
  mode: "preview" | "apply";
  status: "ready" | "complete" | "blocked";
  project: string;
  head: string;
  read_only: boolean;
  mutation_performed: boolean;
  source_fingerprint: string;
  recovery_set_digest: string;
  correlation_manifest: { path: string; present: boolean };
  counts: { selected: number; ready: number; approval_required: number; replayed: number; applied: number; refused: number; decisions: number; health: number };
  omitted: boolean;
  omitted_count: number;
  entries: ProjectionRecoveryCandidate[];
  diagnostics: string[];
}

interface GitRecord { commit: string; parent: string; childBlob: string; parentBlob: string; child: JsonObject; parentRecord: JsonObject }
interface CurrentRecord { artifact: Artifact; number: number; record: JsonObject; index: number; collection: string; documentHash: string }

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function mapping(value: unknown): JsonObject | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }
function git(project: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", args, { cwd: project, encoding: "utf8", shell: false, timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || (!allowFailure && result.status !== 0)) throw new Error(`local Git ${args[0]} failed: ${result.error?.message ?? String(result.stderr).trim()}`);
  return result.status === 0 ? String(result.stdout) : "";
}
function show(project: string, revision: string, relativePath: string): string | null {
  const value = git(project, ["show", `${revision}:${relativePath}`], true);
  return value || null;
}
function blob(project: string, revision: string, relativePath: string): string { return git(project, ["rev-parse", `${revision}:${relativePath}`], true).trim(); }
function rows(bytes: string, collection: string): Array<{ record: JsonObject; index: number; collection: string }> {
  const document = loadYamlMapping(bytes); const result: Array<{ record: JsonObject; index: number; collection: string }> = [];
  for (const name of [collection, "archive"]) {
    const values = document[name]; if (!Array.isArray(values)) continue;
    values.forEach((value, index) => { const record = mapping(value); if (record) result.push({ record, index, collection: name }); });
  }
  return result;
}
function historicalRows(bytes: string, collection: string): Array<{ record: JsonObject; index: number; collection: string }> {
  try { return rows(bytes, collection); } catch {
    const lines = bytes.split(/\r?\n/); const result: Array<{ record: JsonObject; index: number; collection: string }> = [];
    for (const name of [collection, "archive"]) {
      const start = lines.findIndex((line) => line === `${name}:`); if (start < 0) continue;
      const end = lines.findIndex((line, index) => index > start && /^[A-Za-z_][A-Za-z0-9_]*:\s*/.test(line)); const section = lines.slice(start + 1, end < 0 ? lines.length : end);
      const starts = section.flatMap((line, index) => /^  - (?:number|summary):/.test(line) ? [index] : []);
      starts.forEach((entryStart, index) => {
        const segment = section.slice(entryStart, starts[index + 1] ?? section.length).join("\n");
        try { const parsed = loadYamlMapping(`items:\n${segment}\n`); const record = mapping(Array.isArray(parsed.items) ? parsed.items[0] : null); if (record) result.push({ record, index, collection: name }); } catch { /* One malformed historical row cannot hide its valid siblings. */ }
      });
    }
    return result;
  }
}
function numberOf(record: JsonObject): number | null {
  if (typeof record.number === "number" && Number.isSafeInteger(record.number) && record.number > 0) return record.number;
  const match = typeof record.summary === "string" ? /^(?:(?:Decision|Audit)\s+|D)([1-9][0-9]*)\b/.exec(record.summary) : null;
  return match ? Number(match[1]) : null;
}
function isSummary(record: JsonObject): boolean { return typeof record.summary === "string" || record.detail_availability === "summary_only"; }
function exactProjection(artifact: Artifact, full: JsonObject, compact: JsonObject): boolean {
  return canonicalRecordJson(yamlArchiveEntry(artifact, full)) === canonicalRecordJson(compact);
}
function overlay(parent: JsonObject, current: JsonObject): { record: JsonObject; fields: string[] } {
  const explicit = Object.entries(current).filter(([field]) => field !== "summary" && field !== "detail_availability");
  return { record: { ...structuredClone(parent), ...Object.fromEntries(explicit.map(([field, value]) => [field, structuredClone(value)])) }, fields: explicit.map(([field]) => field).sort() };
}
function currentRecords(project: string): { records: CurrentRecord[]; hashes: Record<string, string> } {
  const records: CurrentRecord[] = []; const hashes: Record<string, string> = {};
  for (const [artifact, declaration] of Object.entries(ARTIFACTS) as Array<[Artifact, typeof ARTIFACTS[Artifact]]>) {
    const bytes = fs.readFileSync(path.join(project, declaration.path)); const documentHash = hash(bytes); hashes[declaration.path] = documentHash;
    for (const row of rows(bytes.toString("utf8"), declaration.collection)) { const number = numberOf(row.record); if (number && isSummary(row.record)) records.push({ artifact, number, ...row, documentHash }); }
  }
  return { records, hashes };
}
function archiveTarget(project: string, artifact: Artifact, number: number, sourceRoot: string): string {
  const contract = numberedArchiveContract(artifact, sourceRoot); return path.join(project, contract.archiveRoot, artifact, `${number}${contract.archiveExtension}`);
}
function causalCandidates(project: string, current: CurrentRecord, sourceRoot: string): { candidates: GitRecord[]; mergeSeen: boolean } {
  const declaration = ARTIFACTS[current.artifact]; const result: GitRecord[] = []; let mergeSeen = false;
  const lines = git(project, ["log", "--format=%H%x09%P", "HEAD", "--", declaration.path]).trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const [commit, parentText = ""] = line.split("\t"); const parents = parentText.trim().split(/\s+/).filter(Boolean);
    if (parents.length !== 1) { if (parents.length > 1) mergeSeen = true; continue; }
    const childBytes = show(project, commit, declaration.path); const parentBytes = show(project, parents[0], declaration.path); if (!childBytes || !parentBytes) continue;
    let child: JsonObject | undefined; let parentRecord: JsonObject | undefined;
    try { child = historicalRows(childBytes, declaration.collection).find(({ record }) => numberOf(record) === current.number)?.record; parentRecord = historicalRows(parentBytes, declaration.collection).find(({ record }) => numberOf(record) === current.number)?.record; } catch { continue; }
    if (!child || !parentRecord || !isSummary(child) || numberOf(child) !== current.number || validateStateRecord(sourceRoot, current.artifact, parentRecord).length) continue;
    result.push({ commit, parent: parents[0], childBlob: blob(project, commit, declaration.path), parentBlob: blob(project, parents[0], declaration.path), child, parentRecord });
  }
  return { candidates: result, mergeSeen };
}

export interface LegacyHealthSection { number: number; date: string; raw: string; start: number; end: number; record: JsonObject }
export function parseLegacyHealthMarkdown(bytes: string): LegacyHealthSection[] {
  const headings = [...bytes.matchAll(/^## Audit ([1-9][0-9]*) · (\d{4}-\d{2}-\d{2})\s*$/gm)];
  return headings.map((heading, index) => {
    const start = heading.index!; const end = headings[index + 1]?.index ?? bytes.length; const raw = bytes.slice(start, end);
    const field = (name: string): string | null => new RegExp(`^\\*\\*${name}\\*\\*: (.+)$`, "m").exec(raw)?.[1] ?? null;
    const dimensionsText = field("Dimensions assessed"); const findings = field("Findings"); const trajectory = field("Overall trajectory"); const gradesText = field("Grades");
    if (!dimensionsText || !findings || !gradesText) throw new Error(`Audit ${heading[1]} lacks a directly modeled historical field`);
    const counts = /^(\d+) critical, (\d+) warnings?, (\d+) info \((\d+) (?:filtered|downgraded) by (?:confidence|Decision 4 cross-reference)\)/.exec(findings);
    if (!counts) throw new Error(`Audit ${heading[1]} findings do not match the deterministic converter`);
    const grades: JsonObject = {}; for (const part of gradesText.split("|").map((value) => value.trim())) { const match = /^(.+?) \[([A-F])\]$/.exec(part); if (!match) throw new Error(`Audit ${heading[1]} grade does not match the deterministic converter`); grades[match[1]] = match[2]; }
    const record: JsonObject = { number: Number(heading[1]), date: heading[2], dimensions: dimensionsText.split(",").map((value) => value.trim()), findings_summary: { critical: Number(counts[1]), warning: Number(counts[2]), info: Number(counts[3]), filtered_by_confidence: Number(counts[4]) }, ...(trajectory ? { trajectory } : { historical_baseline: true }), grades };
    return { number: Number(heading[1]), date: heading[2], raw, start: Buffer.byteLength(bytes.slice(0, start)), end: Buffer.byteLength(bytes.slice(0, end)), record };
  });
}
function legacyHealthCandidate(project: string, number: number, sourceRoot: string): { record: JsonObject; provenance: JsonObject } | null {
  const pathName = ".agentera/HEALTH.md";
  for (const commit of git(project, ["log", "--format=%H", "HEAD", "--", pathName]).trim().split("\n").filter(Boolean)) {
    const bytes = show(project, commit, pathName); if (!bytes) continue;
    let section: LegacyHealthSection | undefined; try { section = parseLegacyHealthMarkdown(bytes).find((candidate) => candidate.number === number); } catch { continue; } if (!section || validateStateRecord(sourceRoot, "health", section.record).length) continue;
    return { record: section.record, provenance: { kind: "legacy_health_markdown", source: { commit, blob: blob(project, commit, pathName), path: pathName, section_sha256: hash(section.raw), byte_range: { start: section.start, end: section.end }, raw_section: section.raw }, converter: { version: CONVERTER_VERSION, modeled_fields: ["number", "date", "dimensions", "findings_summary", "trajectory", "grades"], unmodeled_text_preserved: true } } };
  }
  return null;
}
function legacyHealthCandidates(project: string, sourceRoot: string): Map<number, { record: JsonObject; provenance: JsonObject }> {
  const result = new Map<number, { record: JsonObject; provenance: JsonObject }>(); const pathName = ".agentera/HEALTH.md";
  for (const commit of git(project, ["log", "--format=%H", "HEAD", "--", pathName]).trim().split("\n").filter(Boolean)) {
    const bytes = show(project, commit, pathName); if (!bytes) continue; let sections: LegacyHealthSection[]; try { sections = parseLegacyHealthMarkdown(bytes); } catch { continue; }
    for (const section of sections) {
      if (result.has(section.number) || validateStateRecord(sourceRoot, "health", section.record).length) continue;
      result.set(section.number, { record: section.record, provenance: { kind: "legacy_health_markdown", source: { commit, blob: blob(project, commit, pathName), path: pathName, section_sha256: hash(section.raw), byte_range: { start: section.start, end: section.end }, raw_section: section.raw }, converter: { version: CONVERTER_VERSION, modeled_fields: ["number", "date", "dimensions", "findings_summary", "trajectory", "grades"], unmodeled_text_preserved: true } } });
    }
  }
  return result;
}

function directCorrelation(current: CurrentRecord, candidate: GitRecord, composed: { record: JsonObject; fields: string[] }, archiveSha256: string, deterministic: boolean): JsonObject {
  const currentBytes = canonicalRecordJson(current.record);
  return {
    artifact: current.artifact,
    identity: `${current.artifact}:${current.number}`,
    parent: { commit: candidate.parent, blob: candidate.parentBlob, record_sha256: hash(canonicalRecordJson(candidate.parentRecord)) },
    child: { commit: candidate.commit, blob: candidate.childBlob, record_sha256: hash(canonicalRecordJson(candidate.child)) },
    current_projection: { path: ARTIFACTS[current.artifact].path, document_sha256: current.documentHash, record_sha256: hash(currentBytes), canonical_bytes_base64: Buffer.from(currentBytes).toString("base64") },
    overlay: { fields: composed.fields, final_record_sha256: hash(canonicalRecordJson(composed.record)) },
    converter_source_proof: { kind: deterministic ? "deterministic_projection" : "direct_editorial_replacement", converter: deterministic ? "yamlArchiveEntry" : null },
    archive_sha256: archiveSha256,
  };
}

function legacyCorrelation(number: number, provenance: JsonObject, record: JsonObject, archiveSha256: string, current?: CurrentRecord): JsonObject {
  const currentBytes = current ? canonicalRecordJson(current.record) : "absent";
  return {
    artifact: "health",
    identity: `health:${number}`,
    parent: null,
    child: null,
    current_projection: current ? { path: ARTIFACTS.health.path, document_sha256: current.documentHash, record_sha256: hash(currentBytes), canonical_bytes_base64: Buffer.from(currentBytes).toString("base64") } : { path: ARTIFACTS.health.path, record_sha256: hash("absent"), canonical_bytes_base64: Buffer.from("absent").toString("base64") },
    overlay: { fields: [], final_record_sha256: hash(canonicalRecordJson(record)) },
    converter_source_proof: { kind: "legacy_health_markdown", source: provenance.source ?? null, converter: provenance.converter ?? null },
    archive_sha256: archiveSha256,
  };
}

function recoverySetDigest(candidates: ProjectionRecoveryCandidate[]): string {
  const entries = candidates.flatMap((candidate) => candidate.correlation ? [candidate.correlation] : []).sort((a, b) => String(a.identity).localeCompare(String(b.identity)));
  return hash(canonicalRecordJson({ schemaVersion: "agentera.projectionCorrelationSet.v1", entries }));
}

function manifestBytes(candidates: ProjectionRecoveryCandidate[]): string {
  const entries = candidates.flatMap((candidate) => candidate.correlation ? [candidate.correlation] : []).sort((a, b) => String(a.identity).localeCompare(String(b.identity)));
  return dumpYamlMapping({ schemaVersion: "agentera.projectionCorrelationManifest.v1", recovery_set_digest: recoverySetDigest(candidates), entries });
}

function validateManifest(project: string, candidates: ProjectionRecoveryCandidate[]): ProjectionRecoveryCandidate[] {
  const target = path.join(project, PROJECTION_CORRELATION_MANIFEST);
  if (!fs.existsSync(target)) return candidates;
  const listed = new Set(candidates.flatMap((candidate) => candidate.correlation ? [String(candidate.correlation.identity)] : []));
  const extras: ProjectionRecoveryCandidate[] = [];
  for (const artifact of Object.keys(ARTIFACTS) as Artifact[]) {
    const directory = path.join(project, ".agentera/archive", artifact);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).sort()) {
      const match = /^([1-9][0-9]*)\.yaml$/.exec(name); if (!match) continue;
      const number = Number(match[1]); const identity = `${artifact}:${number}`; if (listed.has(identity)) continue;
      try {
        const envelope = loadYamlMapping(fs.readFileSync(path.join(directory, name), "utf8")); if (!mapping(envelope.recovery_provenance)) continue;
        extras.push({ artifact, number, target: path.relative(project, path.join(directory, name)).replaceAll(path.sep, "/"), status: "refused", record_sha256: typeof envelope.record_sha256 === "string" ? envelope.record_sha256 : null, current_projection_sha256: hash("unlisted"), recovery_provenance: mapping(envelope.recovery_provenance), correlation: null, refusal: { class: "manifest_mismatch", message: "recovered archive is not listed in the immutable projection correlation manifest" } });
      } catch { /* malformed recovered archives are handled by migration inventory */ }
    }
  }
  if (extras.length) return [...candidates, ...extras].sort((a, b) => a.artifact.localeCompare(b.artifact) || a.number - b.number);
  let valid = false;
  try {
    const manifest = loadYamlMapping(fs.readFileSync(target, "utf8"));
    valid = manifest.schemaVersion === "agentera.projectionCorrelationManifest.v1"
      && manifest.recovery_set_digest === recoverySetDigest(candidates)
      && fs.readFileSync(target, "utf8") === manifestBytes(candidates);
  } catch { valid = false; }
  if (valid) return candidates;
  return candidates.map((candidate) => ({ ...candidate, status: "refused", record: undefined, refusal: { class: "manifest_mismatch", message: "immutable projection correlation manifest does not match the exact current recovery set" } }));
}

function publishManifest(project: string, candidates: ProjectionRecoveryCandidate[]): boolean {
  const target = path.join(project, PROJECTION_CORRELATION_MANIFEST); const bytes = manifestBytes(candidates);
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, "utf8") !== bytes) throw new Error("immutable projection correlation manifest changed before recovery publication");
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(target), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0)); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return true;
}

function inspect(projectRoot: string, sourceRoot: string): { head: string; hashes: Record<string, string>; candidates: ProjectionRecoveryCandidate[] } {
  const project = validateRealProjectRoot(projectRoot).path; const head = git(project, ["rev-parse", "HEAD"]).trim(); if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("HEAD is not a reachable local commit");
  const { records, hashes } = currentRecords(project); const candidates: ProjectionRecoveryCandidate[] = [];
  for (const current of records) {
    const target = archiveTarget(project, current.artifact, current.number, sourceRoot);
    let existingRecovery = false;
    if (fs.existsSync(target)) {
      try { existingRecovery = Boolean(mapping(loadYamlMapping(fs.readFileSync(target, "utf8")).recovery_provenance)); } catch { existingRecovery = true; }
      if (!existingRecovery) continue;
    }
    const currentHash = hash(canonicalRecordJson(current.record)); const causal = causalCandidates(project, current, sourceRoot);
    let record: JsonObject | null = null; let provenance: JsonObject | null = null; let correlation: JsonObject | null = null; let approvalRequired = false; let refusal: ProjectionRecoveryCandidate["refusal"];
    const deterministicCandidates = causal.candidates.filter((candidate) => exactProjection(current.artifact, overlay(candidate.parentRecord, current.record).record, current.record));
    const selectedCandidates = deterministicCandidates.length ? deterministicCandidates : causal.candidates;
    const selectedDistinct = new Map(selectedCandidates.map((candidate) => [hash(canonicalRecordJson(candidate.parentRecord)), candidate]));
    if (selectedDistinct.size === 1) {
      const candidate = [...selectedDistinct.values()][0]; const composed = overlay(candidate.parentRecord, current.record); record = composed.record;
      approvalRequired = deterministicCandidates.length === 0;
      provenance = { kind: "direct_projection_replacement", source: { commit: candidate.parent, blob: candidate.parentBlob, path: ARTIFACTS[current.artifact].path, record_sha256: hash(canonicalRecordJson(candidate.parentRecord)) }, projection_transition: { commit: candidate.commit, parent: candidate.parent, parent_count: 1, blob: candidate.childBlob, record_sha256: hash(canonicalRecordJson(candidate.child)) }, current_projection: { path: ARTIFACTS[current.artifact].path, collection: current.collection, index: current.index, document_sha256: current.documentHash, record_sha256: currentHash }, overlay: { fields: composed.fields, rule: "parent_full_then_current_explicit_non_summary_fields" } };
    } else if (selectedDistinct.size > 1) refusal = { class: "candidate_ambiguous", message: `${selectedDistinct.size} distinct direct full-detail parents satisfy the projection transition` };
    else if (current.artifact === "health") {
      const legacy = legacyHealthCandidate(project, current.number, sourceRoot); if (legacy) { record = legacy.record; provenance = { ...legacy.provenance, current_projection: { path: ARTIFACTS.health.path, collection: current.collection, index: current.index, document_sha256: current.documentHash, record_sha256: currentHash } }; }
      else refusal = { class: causal.mergeSeen ? "merge_transition" : "candidate_missing", message: "no strict single-parent full-to-summary transition or deterministic legacy health section was found" };
    } else refusal = { class: causal.mergeSeen ? "merge_transition" : "candidate_missing", message: "no strict single-parent full-to-summary transition was found" };
    if (record) { const violations = validateStateRecord(sourceRoot, current.artifact, record); if (violations.length) { refusal = { class: "schema_invalid", message: violations.join("; ") }; record = null; provenance = null; } }
    const serialized = record && provenance ? serializeNumberedArchive(current.artifact, current.number, record, sourceRoot, { recoveryProvenance: provenance }) : null;
    let status: ProjectionRecoveryCandidate["status"] = refusal ? "refused" : approvalRequired ? "approval_required" : "ready";
    if (serialized && record && provenance) {
      if (provenance.kind === "legacy_health_markdown") correlation = legacyCorrelation(current.number, provenance, record, hash(serialized.bytes), current);
      else {
        const selected = [...selectedDistinct.values()][0];
        if (selected) correlation = directCorrelation(current, selected, overlay(selected.parentRecord, current.record), hash(serialized.bytes), !approvalRequired);
      }
    }
    if (existingRecovery) {
      if (serialized && fs.readFileSync(target, "utf8") === serialized.bytes) status = "replay";
      else { status = "refused"; refusal = { class: "immutable_conflict", message: "immutable recovery target exists with divergent bytes" }; record = null; }
    }
    candidates.push({ artifact: current.artifact, number: current.number, target: path.relative(project, target).replaceAll(path.sep, "/"), status, record_sha256: serialized?.recordSha256 ?? null, current_projection_sha256: currentHash, recovery_provenance: provenance, correlation, ...(refusal ? { refusal } : {}), ...(record ? { record } : {}) });
  }
  const selected = new Set(candidates.filter((entry) => entry.artifact === "health").map((entry) => entry.number));
  for (const [number, legacy] of legacyHealthCandidates(project, sourceRoot)) {
    if (selected.has(number)) continue; const target = archiveTarget(project, "health", number, sourceRoot);
    const serialized = serializeNumberedArchive("health", number, legacy.record, sourceRoot, { recoveryProvenance: legacy.provenance });
    let status: ProjectionRecoveryCandidate["status"] = "ready"; let refusal: ProjectionRecoveryCandidate["refusal"];
    if (fs.existsSync(target)) { if (fs.readFileSync(target, "utf8") === serialized.bytes) status = "replay"; else { status = "refused"; refusal = { class: "immutable_conflict", message: "immutable legacy health recovery target exists with divergent bytes" }; } }
    candidates.push({ artifact: "health", number, target: path.relative(project, target).replaceAll(path.sep, "/"), status, record_sha256: serialized.recordSha256, current_projection_sha256: hash("absent"), recovery_provenance: legacy.provenance, correlation: legacyCorrelation(number, legacy.provenance, legacy.record, hash(serialized.bytes)), ...(refusal ? { refusal } : {}), ...(status === "refused" ? {} : { record: legacy.record }) });
  }
  return { head, hashes, candidates: validateManifest(project, candidates.sort((a, b) => a.artifact.localeCompare(b.artifact) || a.number - b.number)) };
}
function boundedCorrelation(correlation: JsonObject | null): JsonObject | null {
  if (!correlation) return null;
  const copy = structuredClone(correlation); const current = mapping(copy.current_projection); if (current) delete current.canonical_bytes_base64;
  return copy;
}
function response(project: string, mode: "preview" | "apply", inspected: ReturnType<typeof inspect>, applied: number, mutation: boolean): ProjectionRecoveryResult {
  const refused = inspected.candidates.filter((entry) => entry.status === "refused").length; const approvalRequired = inspected.candidates.filter((entry) => entry.status === "approval_required").length; const ready = inspected.candidates.filter((entry) => entry.status === "ready").length; const replayed = inspected.candidates.filter((entry) => entry.status === "replay").length; const entries = inspected.candidates.slice(0, MAX_RESULTS);
  return { schemaVersion: "agentera.projectionRecovery.v1", command: "state backfill --recover-projections", mode, status: refused || approvalRequired ? "blocked" : mode === "apply" ? "complete" : "ready", project, head: inspected.head, read_only: mode === "preview", mutation_performed: mutation, source_fingerprint: hash(canonicalRecordJson({ head: inspected.head, projections: inspected.hashes })), recovery_set_digest: recoverySetDigest(inspected.candidates), correlation_manifest: { path: PROJECTION_CORRELATION_MANIFEST, present: fs.existsSync(path.join(project, PROJECTION_CORRELATION_MANIFEST)) }, counts: { selected: inspected.candidates.length, ready, approval_required: approvalRequired, replayed, applied, refused, decisions: inspected.candidates.filter((entry) => entry.artifact === "decisions").length, health: inspected.candidates.filter((entry) => entry.artifact === "health").length }, omitted: entries.length < inspected.candidates.length, omitted_count: inspected.candidates.length - entries.length, entries: entries.map(({ record: _record, correlation, ...entry }) => ({ ...entry, correlation: boundedCorrelation(correlation) })), diagnostics: inspected.candidates.flatMap((entry) => entry.refusal ? [`${entry.artifact}:${entry.number} ${entry.refusal.class}: ${entry.refusal.message}`] : entry.status === "approval_required" ? [`${entry.artifact}:${entry.number} approval_required: direct non-deterministic projection replacement requires the exact recovery-set digest`] : []) };
}
export function previewProjectionRecovery(projectRoot: string, sourceRoot: string): ProjectionRecoveryResult { const project = validateRealProjectRoot(projectRoot).path; return response(project, "preview", inspect(project, sourceRoot), 0, false); }
export function applyProjectionRecovery(projectRoot: string, sourceRoot: string, recoveryDigest?: string): ProjectionRecoveryResult {
  const project = validateRealProjectRoot(projectRoot).path; const before = inspect(project, sourceRoot); if (before.candidates.some((entry) => entry.status === "refused")) return response(project, "apply", before, 0, false);
  if (before.candidates.some((entry) => entry.status === "approval_required") && recoveryDigest !== recoverySetDigest(before.candidates)) {
    const refused = before.candidates.map((entry) => entry.status === "approval_required" ? { ...entry, status: "refused" as const, record: undefined, refusal: { class: "source_changed" as const, message: "approval-required recovery set needs the exact --recovery-digest from the reviewed dry-run" } } : entry);
    return response(project, "apply", { ...before, candidates: refused }, 0, false);
  }
  const lock = acquireWriterLock(project, 2_000); let applied = 0;
  try {
    const current = inspect(project, sourceRoot); if (current.head !== before.head || canonicalRecordJson(current.hashes) !== canonicalRecordJson(before.hashes)) throw new Error("HEAD or current projection changed before recovery publication");
    if (current.candidates.some((entry) => entry.status === "refused") || (current.candidates.some((entry) => entry.status === "approval_required") && recoveryDigest !== recoverySetDigest(current.candidates))) throw new Error("projection recovery set changed before recovery publication");
    const manifestPublished = publishManifest(project, current.candidates);
    for (const candidate of current.candidates) { if (candidate.status === "replay") continue; if (!candidate.record || !candidate.recovery_provenance) throw new Error(`recovery candidate ${candidate.artifact}:${candidate.number} lost its validated record`); const result = publishNumberedArchive(project, candidate.artifact, candidate.number, candidate.record, { sourceRoot, recoveryProvenance: candidate.recovery_provenance }); if (!result.replay) applied += 1; }
    return response(project, "apply", inspect(project, sourceRoot), applied, manifestPublished || applied > 0);
  } finally { lock.release(); }
}

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { EntityPublicationContext, type PublishedTargetIdentity } from "./entityPublicationContext.js";
import { canonicalEntityRecordViolations, discoverEntities, publishEntityUnderLock, validateEntityState } from "./entityStorage.js";
import { planEntityMigration, type DurableEntityMigrationEntry, type DurableEntityMigrationPlan } from "./entityMigrationPreview.js";
import { assertValidatedProjectRoot, validateRealProjectRoot, type ValidatedProjectRoot } from "./projectRoot.js";
import { acquireWriterLock } from "./write/lock.js";

const ROOT = ".agentera/migrations/entities";
const MARKER = ".agentera/state-mode.yaml";
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
const FORWARD_PHASES = ["prepare_recovery", "publish_entities", "validate_graph", "cutover", "cutover_complete"] as const;
const PHASES = [...FORWARD_PHASES, "rollback_prepared", "rollback_cutover", "rolled_back"] as const;
type Phase = typeof PHASES[number];

interface StoredIdentity { dev: string; ino: string; type: string; size: string; sha256: string }
interface Journal {
  schemaVersion: "agentera.entityMigrationJournal.v1";
  migration_id: string;
  project: string;
  source_fingerprint: string;
  preview_digest: string;
  phase: Phase;
  phases: readonly string[];
  manifest_sha256: string;
  snapshot_sha256: string;
  entities: Record<string, StoredIdentity>;
  marker: StoredIdentity | null;
}

export interface EntityMigrationResult {
  schemaVersion: "agentera.entityMigration.v1";
  command: "state migrate entities";
  status: "complete" | "rolled_back";
  operation: "apply" | "resume" | "rollback";
  migration_id: string;
  phase: Phase;
  idempotent: boolean;
  mutation_performed: boolean;
  entity_count: number;
  evidence: { journal: string; manifest: string; snapshot: string };
}

export class EntityMigrationOperationError extends Error {
  constructor(readonly classification: string, message: string, readonly recovery: string) { super(message); this.name = "EntityMigrationOperationError"; }
}

function hash(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function relative(root: string, target: string): string { return path.relative(path.resolve(root), target).split(path.sep).join("/"); }
function operationId(plan: DurableEntityMigrationPlan): string { return hash(`agentera.entity-migration.v1\0${plan.project}\0${plan.source_fingerprint}\0${plan.preview_digest}`).slice(0, 20); }
function operationRoot(project: string, id: string): string { return path.join(project, ROOT, id); }
function evidence(project: string, id: string): EntityMigrationResult["evidence"] { return { journal: `${ROOT}/${id}/journal.yaml`, manifest: `${ROOT}/${id}/manifest.yaml`, snapshot: `${ROOT}/${id}/snapshot.yaml` }; }
function identity(value: PublishedTargetIdentity): StoredIdentity { return { dev: String(value.dev), ino: String(value.ino), type: String(value.type), size: String(value.size), sha256: value.sha256 }; }
function publishedIdentity(file: string): PublishedTargetIdentity {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`migration-owned path '${file}' is not a regular file`);
  return { dev: stat.dev, ino: stat.ino, type: stat.mode & BigInt(fs.constants.S_IFMT), size: stat.size, sha256: hash(fs.readFileSync(file)) };
}
function storedIdentity(value: StoredIdentity): PublishedTargetIdentity { return { dev: BigInt(value.dev), ino: BigInt(value.ino), type: BigInt(value.type), size: BigInt(value.size), sha256: value.sha256 }; }

function syncDirectory(directory: string): void { const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0)); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function fdPath(fd: number, name?: string): string { return name ? `/proc/self/fd/${fd}/${name}` : `/proc/self/fd/${fd}`; }
function sameDirectory(left: fs.BigIntStats, right: fs.BigIntStats): boolean { return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino; }
function pinnedMigrationParent(root: ValidatedProjectRoot): { fd: number; close: () => void; assertValid: () => void } {
  assertValidatedProjectRoot(root);
  const descriptors: Array<{ parent: number; name: string; fd: number }> = [];
  const rootFd = fs.openSync(root.path, DIRECTORY_FLAGS);
  let parent = rootFd;
  try {
    const expectedRoot = root.identities.at(-1)!; const openedRoot = fs.fstatSync(rootFd, { bigint: true });
    if (openedRoot.dev !== expectedRoot.dev || openedRoot.ino !== expectedRoot.ino) throw new Error(`project root '${root.path}' changed during migration preparation`);
    for (const name of ROOT.split("/")) {
      try { fs.mkdirSync(fdPath(parent, name), { mode: 0o700 }); fs.fsyncSync(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      let fd: number;
      try { fd = fs.openSync(fdPath(parent, name), DIRECTORY_FLAGS); }
      catch { throw new Error(`migration evidence path '${ROOT}' must be a real project directory`); }
      descriptors.push({ parent, name, fd }); parent = fd;
    }
    const assertValid = (): void => {
      assertValidatedProjectRoot(root);
      const currentRoot = fs.fstatSync(rootFd, { bigint: true });
      if (currentRoot.dev !== expectedRoot.dev || currentRoot.ino !== expectedRoot.ino) throw new Error(`project root '${root.path}' changed during migration preparation`);
      for (const entry of descriptors) {
        let current: number | undefined;
        try { current = fs.openSync(fdPath(entry.parent, entry.name), DIRECTORY_FLAGS); if (!sameDirectory(fs.fstatSync(entry.fd, { bigint: true }), fs.fstatSync(current, { bigint: true }))) throw new Error(); }
        catch { throw new Error(`migration evidence path '${ROOT}' changed during preparation`); }
        finally { if (current !== undefined) fs.closeSync(current); }
      }
    };
    assertValid();
    return { fd: parent, assertValid, close: () => { for (const entry of descriptors.reverse()) fs.closeSync(entry.fd); fs.closeSync(rootFd); } };
  } catch (error) {
    for (const entry of descriptors.reverse()) fs.closeSync(entry.fd); fs.closeSync(rootFd); throw error;
  }
}
function durableCreate(file: string, bytes: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function readRegular(file: string, label: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} '${file}' is not a regular file`);
  return fs.readFileSync(file);
}
function manifestBytes(plan: DurableEntityMigrationPlan, id: string): string {
  return dumpYamlMapping({ schemaVersion: "agentera.entityMigrationManifest.v1", migration_id: id, project: plan.project, source_fingerprint: plan.source_fingerprint, preview_digest: plan.preview_digest, authority_schema_version: plan.authority_schema_version, authority_sha256: plan.authority_sha256, entries: plan.entries, preserved_singletons: plan.preserved_singletons, counts: plan.counts });
}
function snapshotBytes(plan: DurableEntityMigrationPlan, id: string): string {
  return dumpYamlMapping({ schemaVersion: "agentera.entityMigrationSnapshot.v1", migration_id: id, project: plan.project, sources: plan.sources });
}
function journalBytes(journal: Journal): string { return dumpYamlMapping(journal as unknown as Record<string, unknown>); }
function loadJournal(project: string, id: string): { journal: Journal; bytes: Buffer } {
  if (!/^[a-f0-9]{20}$/.test(id)) throw new EntityMigrationOperationError("invalid_migration_id", `migration ID '${id}' must be 20 lowercase hexadecimal characters`, "Copy the migration ID from the interrupted apply response or durable journal path.");
  const file = path.join(operationRoot(project, id), "journal.yaml");
  let bytes: Buffer;
  try { bytes = readRegular(file, "migration journal"); } catch { throw new EntityMigrationOperationError("migration_not_found", `durable migration '${id}' was not found`, `Run agentera state migrate entities --project '${project}' --dry-run --format json, or use the exact migration ID from recovery evidence.`); }
  const journal = loadYamlMapping(bytes.toString("utf8")) as unknown as Journal;
  if (journal.schemaVersion !== "agentera.entityMigrationJournal.v1" || journal.migration_id !== id || journal.project !== project || !PHASES.includes(journal.phase)) throw new EntityMigrationOperationError("journal_invalid", `migration journal '${id}' is invalid or belongs to another project`, "Retain the journal and snapshot, repair the exact durable evidence, and retry with the same migration ID.");
  return { journal, bytes };
}
function writeJournal(project: string, journal: Journal): Buffer {
  const relativeJournal = `${ROOT}/${journal.migration_id}/journal.yaml`; const current = readRegular(path.join(project, relativeJournal), "migration journal"); const bytes = journalBytes(journal);
  withMigrationContext(project, journal.migration_id, (context) => context.replaceExisting(relativeJournal, current.toString("utf8"), bytes));
  return Buffer.from(bytes);
}
function fault(phase: Phase): void { if (process.env.NODE_ENV === "test" && process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE === phase) process.exit(86); }

function assertPlanReady(plan: DurableEntityMigrationPlan, sourceRoot?: string): void {
  if (plan.counts.blockers > 0) throw new EntityMigrationOperationError("inventory_blocked", `entity migration inventory has ${plan.counts.blockers} blocker(s)`, `Repair every preview diagnostic, then rerun agentera state migrate entities --project '${plan.project}' --dry-run --format json; no migration journal was created.`);
  const invalid = plan.entries.find((entry) => canonicalEntityRecordViolations(entry.boundary!, entry.record, sourceRoot).length > 0);
  if (invalid) throw new EntityMigrationOperationError("target_invalid", `mapped record '${invalid.source_identity}' does not satisfy canonical ${invalid.boundary} entity validation: ${canonicalEntityRecordViolations(invalid.boundary!, invalid.record, sourceRoot).join("; ")}`, `Repair the legacy record, rerun the dry-run preview, and approve the new digest; no migration journal was created.`);
}
function assertBinding(plan: DurableEntityMigrationPlan, fingerprint: string, digest: string): void {
  if (plan.source_fingerprint !== fingerprint || plan.preview_digest !== digest) throw new EntityMigrationOperationError("source_changed", "entity migration source or authority changed after approval", `Rerun agentera state migrate entities --project '${plan.project}' --dry-run --format json and approve the new fingerprint and digest.`);
}
function assertNoCanonicalState(project: string, sourceRoot: string): void {
  const marker = path.join(project, MARKER);
  if (fs.existsSync(marker)) throw new EntityMigrationOperationError("cutover_exists", "a durable entity-mode marker already exists without this completed migration identity", "Use --resume MIGRATION_ID for the owning journal; never overwrite or infer marker ownership.");
  const discovered = discoverEntities(project, sourceRoot);
  if (discovered.entities.length || discovered.issues.length) throw new EntityMigrationOperationError("entity_collision", "canonical entity paths are not empty before migration apply", "Run agentera check validate state, preserve the existing entities, and resolve ownership before retrying; no journal was created.");
}
function prepare(plan: DurableEntityMigrationPlan): Journal {
  const id = operationId(plan); const root = operationRoot(plan.project, id); const pinned = pinnedMigrationParent(validateRealProjectRoot(plan.project));
  const stageName = `.${id}.prepare-${randomUUID()}`; const stage = fdPath(pinned.fd, stageName); let stageFd: number | undefined; let renamed = false; let published = false;
  try { fs.lstatSync(fdPath(pinned.fd, id)); throw new EntityMigrationOperationError("migration_exists", `migration '${id}' already has durable evidence`, `Resume it explicitly with agentera state migrate entities --project '${plan.project}' --resume ${id} --force --format json.`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { pinned.close(); throw error; } }
  const manifest = manifestBytes(plan, id); const snapshot = snapshotBytes(plan, id);
  const journal: Journal = { schemaVersion: "agentera.entityMigrationJournal.v1", migration_id: id, project: plan.project, source_fingerprint: plan.source_fingerprint, preview_digest: plan.preview_digest, phase: "prepare_recovery", phases: PHASES, manifest_sha256: hash(manifest), snapshot_sha256: hash(snapshot), entities: {}, marker: null };
  try {
    fs.mkdirSync(stage, { mode: 0o700 }); fs.fsyncSync(pinned.fd); stageFd = fs.openSync(stage, DIRECTORY_FLAGS); pinned.assertValid();
    durableCreate(fdPath(stageFd, "manifest.yaml"), manifest); durableCreate(fdPath(stageFd, "snapshot.yaml"), snapshot);
    durableCreate(fdPath(stageFd, "journal.yaml"), journalBytes(journal)); fs.fsyncSync(stageFd); pinned.assertValid();
    fs.renameSync(fdPath(pinned.fd, stageName), fdPath(pinned.fd, id)); renamed = true; fs.fsyncSync(pinned.fd); pinned.assertValid(); published = true;
  } catch (error) {
    throw error;
  } finally {
    if (stageFd !== undefined) fs.closeSync(stageFd);
    if (!published) { try { fs.rmSync(fdPath(pinned.fd, renamed ? id : stageName), { recursive: true }); fs.fsyncSync(pinned.fd); } catch { /* Preserve the original preparation failure. */ } }
    pinned.close();
  }
  if (!fs.existsSync(root)) throw new Error(`migration '${id}' preparation did not publish its durable evidence directory`);
  fault("prepare_recovery"); return journal;
}

function loadEvidence(project: string, journal: Journal): DurableEntityMigrationEntry[] {
  const root = operationRoot(project, journal.migration_id);
  const manifest = readRegular(path.join(root, "manifest.yaml"), "migration manifest");
  const snapshot = readRegular(path.join(root, "snapshot.yaml"), "migration snapshot");
  if (hash(manifest) !== journal.manifest_sha256 || hash(snapshot) !== journal.snapshot_sha256) throw new EntityMigrationOperationError("evidence_changed", `durable evidence for migration '${journal.migration_id}' changed`, "Retain all evidence and restore the immutable manifest and snapshot before retrying.");
  const document = loadYamlMapping(manifest.toString("utf8"));
  if (document.migration_id !== journal.migration_id || document.project !== project || document.source_fingerprint !== journal.source_fingerprint || document.preview_digest !== journal.preview_digest || !Array.isArray(document.entries)) throw new EntityMigrationOperationError("evidence_invalid", `durable manifest for migration '${journal.migration_id}' is invalid`, "Retain the evidence and repair it from the approved preview before retrying.");
  return document.entries as unknown as DurableEntityMigrationEntry[];
}
function assertCurrentSource(project: string, sourceRoot: string, journal: Journal): void {
  const current = planEntityMigration(project, sourceRoot);
  if (current.source_fingerprint !== journal.source_fingerprint || current.preview_digest !== journal.preview_digest) throw new EntityMigrationOperationError("source_changed", `legacy source changed after migration '${journal.migration_id}' was prepared`, `Restore the recovery snapshot or roll back safely with agentera state migrate entities --project '${project}' --rollback ${journal.migration_id} --force --format json.`);
}
function withMigrationContext<T>(project: string, id: string, run: (context: EntityPublicationContext) => T): T {
  const relativeManifest = `${ROOT}/${id}/manifest.yaml`; const bytes = readRegular(path.join(project, relativeManifest), "migration manifest");
  const context = EntityPublicationContext.open(validateRealProjectRoot(project), relativeManifest, bytes);
  try { return run(context); } finally { context.close(); }
}
function verifyManifestGraph(project: string, sourceRoot: string, entries: DurableEntityMigrationEntry[]): void {
  const validation = validateEntityState(project, sourceRoot);
  if (!validation.valid || validation.entityCount !== entries.length) throw new EntityMigrationOperationError("graph_invalid", `published migration graph failed validation or cardinality (${validation.entityCount}/${entries.length}): ${validation.issues.map(({ message }) => message).join("; ")}`, "Retain durable evidence and entities, repair no files manually, then resume the same migration ID.");
  const discovered = discoverEntities(project, sourceRoot).entities.filter(({ classification }) => classification === "valid");
  const actual = new Map(discovered.map((entity) => [entity.relativePath, canonicalRecordJson(entity.record!)]));
  for (const entry of entries) if (actual.get(entry.proposed_target!.path) !== canonicalRecordJson(entry.record)) throw new EntityMigrationOperationError("graph_diverged", `canonical entity '${entry.proposed_target!.path}' diverges from the immutable migration manifest`, "Retain all evidence and resolve the collision without overwriting either value.");
}
function advance(project: string, sourceRoot: string, journal: Journal, operation: "apply" | "resume"): EntityMigrationResult {
  const entries = loadEvidence(project, journal); assertCurrentSource(project, sourceRoot, journal);
  if (["rollback_prepared", "rollback_cutover", "rolled_back"].includes(journal.phase)) throw new EntityMigrationOperationError("migration_rolled_back", `migration '${journal.migration_id}' entered rollback at '${journal.phase}'`, `Continue rollback explicitly with agentera state migrate entities --project '${project}' --rollback ${journal.migration_id} --force --format json.`);
  if (journal.phase === "prepare_recovery") {
    withMigrationContext(project, journal.migration_id, (context) => {
      for (const entry of entries) {
        const target = entry.proposed_target;
        if (!target) throw new Error(`manifest entry '${entry.source_identity}' has no canonical target`);
        const result = publishEntityUnderLock({ projectRoot: project, sourceRoot, publicationContext: context, artifact: entry.artifact!, boundary: entry.boundary!, id: target.id, record: entry.record });
        const value = result.publishedIdentity ?? publishedIdentity(result.path); journal.entities[target.path] = identity(value);
      }
    });
    journal.phase = "publish_entities"; writeJournal(project, journal); fault("publish_entities");
  }
  if (journal.phase === "publish_entities") { verifyManifestGraph(project, sourceRoot, entries); journal.phase = "validate_graph"; writeJournal(project, journal); fault("validate_graph"); }
  if (journal.phase === "validate_graph") {
    const markerBytes = dumpYamlMapping({ schemaVersion: "agentera.stateMode.v1", mode: "entities", migration_id: journal.migration_id, source_fingerprint: journal.source_fingerprint, preview_digest: journal.preview_digest });
    withMigrationContext(project, journal.migration_id, (context) => { const value = context.publishImmutable(MARKER, markerBytes) ?? publishedIdentity(path.join(project, MARKER)); journal.marker = identity(value); });
    journal.phase = "cutover"; writeJournal(project, journal); fault("cutover");
  }
  if (journal.phase === "cutover") { verifyManifestGraph(project, sourceRoot, entries); journal.phase = "cutover_complete"; writeJournal(project, journal); fault("cutover_complete"); }
  verifyManifestGraph(project, sourceRoot, entries);
  return { schemaVersion: "agentera.entityMigration.v1", command: "state migrate entities", status: "complete", operation, migration_id: journal.migration_id, phase: journal.phase, idempotent: operation === "resume" && journal.phase === "cutover_complete", mutation_performed: true, entity_count: entries.length, evidence: evidence(project, journal.migration_id) };
}

export function applyEntityMigration(projectRoot: string, sourceRoot: string, fingerprint: string, digest: string): EntityMigrationResult {
  const project = validateRealProjectRoot(projectRoot).path; const first = planEntityMigration(project, sourceRoot); assertPlanReady(first, sourceRoot); assertBinding(first, fingerprint, digest);
  const id = operationId(first); const existing = path.join(operationRoot(project, id), "journal.yaml");
  if (fs.existsSync(existing)) {
    const loaded = loadJournal(project, id).journal;
    if (loaded.phase === "cutover_complete") return resumeEntityMigration(project, sourceRoot, id, "apply");
    throw new EntityMigrationOperationError("migration_exists", `migration '${id}' was interrupted at '${loaded.phase}'`, `Resume it explicitly with agentera state migrate entities --project '${project}' --resume ${id} --force --format json.`);
  }
  const lock = acquireWriterLock(project, 2000);
  try { const current = planEntityMigration(project, sourceRoot); assertPlanReady(current, sourceRoot); assertBinding(current, fingerprint, digest); assertNoCanonicalState(project, sourceRoot); return advance(project, sourceRoot, prepare(current), "apply"); }
  finally { lock.release(); }
}

export function resumeEntityMigration(projectRoot: string, sourceRoot: string, id: string, operation: "apply" | "resume" = "resume"): EntityMigrationResult {
  const project = validateRealProjectRoot(projectRoot).path; const lock = acquireWriterLock(project, 2000);
  try {
    const journal = loadJournal(project, id).journal;
    if (journal.phase === "cutover_complete") {
      const entries = loadEvidence(project, journal); assertCurrentSource(project, sourceRoot, journal); verifyManifestGraph(project, sourceRoot, entries);
      const marker = publishedIdentity(path.join(project, MARKER)); if (!journal.marker || canonicalRecordJson(identity(marker)) !== canonicalRecordJson(journal.marker)) throw new EntityMigrationOperationError("marker_diverged", "completed migration marker changed after cutover", "Retain all recovery evidence and repair no authority files manually.");
      return { schemaVersion: "agentera.entityMigration.v1", command: "state migrate entities", status: "complete", operation, migration_id: id, phase: journal.phase, idempotent: true, mutation_performed: false, entity_count: entries.length, evidence: evidence(project, id) };
    }
    return advance(project, sourceRoot, journal, operation);
  } finally { lock.release(); }
}

function assertSnapshotUnchanged(project: string, journal: Journal): void {
  const snapshot = loadYamlMapping(readRegular(path.join(operationRoot(project, journal.migration_id), "snapshot.yaml"), "migration snapshot").toString("utf8"));
  if (!Array.isArray(snapshot.sources)) throw new Error("migration snapshot has no source inventory");
  for (const source of snapshot.sources as Array<Record<string, unknown>>) {
    const file = path.join(project, String(source.path)); const present = fs.existsSync(file);
    if (source.presence === "missing") { if (present) throw new EntityMigrationOperationError("post_cutover_write", `legacy path '${source.path}' was created after cutover`, "Retain the journal, snapshot, marker, and entities; rollback refused before mutation."); continue; }
    if (!present) throw new EntityMigrationOperationError("post_cutover_write", `legacy path '${source.path}' disappeared after cutover`, "Retain all recovery evidence; rollback refused before mutation.");
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(file)) !== source.sha256 || (stat.mode & 0o7777) !== source.mode) throw new EntityMigrationOperationError("post_cutover_write", `legacy path '${source.path}' changed after cutover`, "Retain the journal, snapshot, marker, and entities; rollback refused before mutation.");
  }
}
function assertRollbackOwnership(project: string, sourceRoot: string, journal: Journal, entries: DurableEntityMigrationEntry[]): void {
  assertSnapshotUnchanged(project, journal);
  const discovered = discoverEntities(project, sourceRoot);
  if (discovered.issues.length || discovered.entities.length !== entries.length) throw new EntityMigrationOperationError("post_cutover_write", "canonical entity inventory changed after cutover", "Retain all recovery evidence and canonical state; rollback refused before mutation.");
  for (const entry of entries) {
    const target = entry.proposed_target!.path; const expected = journal.entities[target]; if (!expected) throw new EntityMigrationOperationError("evidence_invalid", `journal does not own entity '${target}'`, "Retain all evidence and do not remove the entity manually.");
    if (canonicalRecordJson(identity(publishedIdentity(path.join(project, target)))) !== canonicalRecordJson(expected)) throw new EntityMigrationOperationError("post_cutover_write", `canonical entity '${target}' changed after cutover`, "Retain all recovery evidence and canonical state; rollback refused before mutation.");
  }
  if (journal.marker) {
    if (canonicalRecordJson(identity(publishedIdentity(path.join(project, MARKER)))) !== canonicalRecordJson(journal.marker)) throw new EntityMigrationOperationError("post_cutover_write", "state mode marker changed after cutover", "Retain all recovery evidence and canonical state; rollback refused before mutation.");
  } else if (fs.existsSync(path.join(project, MARKER))) throw new EntityMigrationOperationError("unknown_marker", "an unowned state mode marker exists", "Retain all evidence and identify the marker owner before retrying rollback.");
}
export function rollbackEntityMigration(projectRoot: string, sourceRoot: string, id: string): EntityMigrationResult {
  const project = validateRealProjectRoot(projectRoot).path; const lock = acquireWriterLock(project, 2000);
  try {
    const journal = loadJournal(project, id).journal; const entries = loadEvidence(project, journal);
    if (journal.phase === "rolled_back") {
      assertSnapshotUnchanged(project, journal);
      const successor = [MARKER, ...entries.map((entry) => entry.proposed_target!.path)].find((relativePath) => fs.existsSync(path.join(project, relativePath)));
      if (successor) throw new EntityMigrationOperationError("post_rollback_successor", `rollback successor '${successor}' exists after migration '${id}' completed`, "Retain the successor and recovery evidence; do not retry destructive rollback against a new file identity.");
      return { schemaVersion: "agentera.entityMigration.v1", command: "state migrate entities", status: "rolled_back", operation: "rollback", migration_id: id, phase: "rolled_back", idempotent: true, mutation_performed: false, entity_count: entries.length, evidence: evidence(project, id) };
    }
    if (!journal.phase.startsWith("rollback_")) {
      assertRollbackOwnership(project, sourceRoot, journal, entries);
      journal.phase = "rollback_prepared"; writeJournal(project, journal); fault("rollback_prepared");
    }
    if (journal.phase === "rollback_prepared") {
      assertSnapshotUnchanged(project, journal);
      for (const entry of entries) {
        const target = entry.proposed_target!.path; const expected = journal.entities[target];
        if (!expected || !fs.existsSync(path.join(project, target)) || canonicalRecordJson(identity(publishedIdentity(path.join(project, target)))) !== canonicalRecordJson(expected)) throw new EntityMigrationOperationError("post_cutover_write", `canonical entity '${target}' changed before rollback cutover`, "Retain all recovery evidence and canonical state; rollback refused before authority changed.");
      }
      if (journal.marker && fs.existsSync(path.join(project, MARKER))) withMigrationContext(project, id, (context) => context.removeExact(MARKER, storedIdentity(journal.marker!)));
      assertSnapshotUnchanged(project, journal); journal.phase = "rollback_cutover"; writeJournal(project, journal); fault("rollback_cutover");
    }
    if (journal.phase === "rollback_cutover") {
      withMigrationContext(project, id, (context) => {
        for (const entry of [...entries].reverse()) {
          const target = entry.proposed_target!.path; const absolute = path.join(project, target); const expected = journal.entities[target];
          if (!fs.existsSync(absolute)) continue;
          if (!expected || canonicalRecordJson(identity(publishedIdentity(absolute))) !== canonicalRecordJson(expected)) throw new EntityMigrationOperationError("post_rollback_successor", `rollback successor '${target}' replaced an operation-owned entity`, "Retain the successor and recovery evidence; rollback will never delete the new inode.");
          context.removeExact(target, storedIdentity(expected));
        }
      });
      journal.phase = "rolled_back"; writeJournal(project, journal); fault("rolled_back");
    }
    return { schemaVersion: "agentera.entityMigration.v1", command: "state migrate entities", status: "rolled_back", operation: "rollback", migration_id: id, phase: "rolled_back", idempotent: false, mutation_performed: true, entity_count: entries.length, evidence: evidence(project, id) };
  } finally { lock.release(); }
}

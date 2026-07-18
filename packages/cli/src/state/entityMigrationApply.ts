import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { EntityPublicationContext, type PublishedTargetIdentity } from "./entityPublicationContext.js";
import { canonicalEntityEnvelope, canonicalEntityEnvelopeBytes, discoverEntities, entityBoundariesForArtifact, validateEntityState } from "./entityStorage.js";
import { planEntityMigration, validateEntityMigrationTargets, type DurableEntityMigrationEntry, type DurableEntityMigrationPlan } from "./entityMigrationPreview.js";
import { assertValidatedProjectRoot, validateRealProjectRoot, type ValidatedProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";
import { acquireWriterLock } from "./write/lock.js";
import { assertEntityMigrationApproval, projectIsGitCheckout } from "./entityMigrationApproval.js";

const ROOT = ".agentera/migrations/entities";
const MARKER = ".agentera/state-mode.yaml";
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
const FORWARD_PHASES = ["prepare_recovery", "publish_entities", "validate_graph", "cutover", "cutover_complete"] as const;
const PHASES = [...FORWARD_PHASES, "rollback_prepared", "rollback_cutover", "rolled_back"] as const;
type Phase = typeof PHASES[number];

interface StoredIdentity { dev: string; ino: string; type: string; size: string; sha256: string }
interface Receipt extends StoredIdentity { path: string; target: string; kind: "entity" | "marker" }
interface LoadedEvidence { entries: DurableEntityMigrationEntry[]; preservedResidues: DurableEntityMigrationEntry[]; receipts: Record<string, Receipt> }
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
  preserved_residues: { count: number; sha256: string; provenance: string[] };
  evidence: { journal: string; manifest: string; snapshot: string };
  preparation?: { action: "created" | "resumed" | "replaced"; path: string };
}

export class EntityMigrationOperationError extends Error {
  constructor(readonly classification: string, message: string, readonly recovery: string, readonly mutationPerformed = false) { super(message); this.name = "EntityMigrationOperationError"; }
}

function hash(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function relative(root: string, target: string): string { return path.relative(path.resolve(root), target).split(path.sep).join("/"); }
function operationId(plan: DurableEntityMigrationPlan): string { return hash(`agentera.entity-migration.v1\0${plan.project}\0${plan.source_fingerprint}\0${plan.preview_digest}`).slice(0, 20); }
function operationRoot(project: string, id: string): string { return path.join(project, ROOT, id); }
function evidence(project: string, id: string): EntityMigrationResult["evidence"] { return { journal: `${ROOT}/${id}/journal.yaml`, manifest: `${ROOT}/${id}/manifest.yaml`, snapshot: `${ROOT}/${id}/snapshot.yaml` }; }
function identity(value: PublishedTargetIdentity): StoredIdentity { return { dev: String(value.dev), ino: String(value.ino), type: String(value.type), size: String(value.size), sha256: value.sha256 }; }
function descriptorIdentity(file: string): PublishedTargetIdentity {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true }); const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || BigInt(bytes.length) !== after.size) throw new Error(`migration-owned path '${file}' changed while read`);
    return { dev: after.dev, ino: after.ino, type: after.mode & BigInt(fs.constants.S_IFMT), size: after.size, sha256: hash(bytes) };
  } finally { fs.closeSync(fd); }
}
function projectFileIdentity(project: string, relativePath: string): PublishedTargetIdentity {
  const observed = readProjectFileSnapshot(validateRealProjectRoot(project), relativePath);
  if (observed.kind !== "file") throw new Error(`migration-owned path '${relativePath}' is not a stable regular file`);
  return { dev: observed.dev, ino: observed.ino, type: BigInt(fs.constants.S_IFREG), size: BigInt(observed.bytes.length), sha256: hash(observed.bytes) };
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
function readRegular(project: string, relativePath: string, label: string): Buffer {
  const observed = readProjectFileSnapshot(validateRealProjectRoot(project), relativePath);
  if (observed.kind !== "file") throw new Error(`${label} '${path.join(project, relativePath)}' is not a stable regular file`);
  return observed.bytes;
}
function markerBytes(id: string, plan: Pick<DurableEntityMigrationPlan, "source_fingerprint" | "preview_digest">): string {
  return dumpYamlMapping({ schemaVersion: "agentera.stateMode.v1", mode: "entities", migration_id: id, source_fingerprint: plan.source_fingerprint, preview_digest: plan.preview_digest });
}
function inventoryBinding(entries: DurableEntityMigrationEntry[], preservedResidues: DurableEntityMigrationEntry[]): Record<string, unknown> {
  return {
    entry_count: entries.length,
    entries_sha256: hash(canonicalRecordJson(entries)),
    preserved_residue_count: preservedResidues.length,
    preserved_residues_sha256: hash(canonicalRecordJson(preservedResidues)),
  };
}
function residueSummary(preservedResidues: DurableEntityMigrationEntry[]): EntityMigrationResult["preserved_residues"] {
  return {
    count: preservedResidues.length,
    sha256: hash(canonicalRecordJson(preservedResidues)),
    provenance: [...new Set(preservedResidues.flatMap((entry) => entry.provenance))].sort(),
  };
}
function manifestBytes(plan: DurableEntityMigrationPlan, id: string, receipts: Record<string, Receipt>): string {
  return dumpYamlMapping({ schemaVersion: "agentera.entityMigrationManifest.v1", migration_id: id, project: plan.project, source_fingerprint: plan.source_fingerprint, preview_digest: plan.preview_digest, authority_schema_version: plan.authority_schema_version, authority_sha256: plan.authority_sha256, sources: plan.sources, entries: plan.entries, preserved_residues: plan.preserved_residues, inventory: inventoryBinding(plan.entries, plan.preserved_residues), receipts, preserved_singletons: plan.preserved_singletons, counts: plan.counts });
}
function snapshotBytes(plan: DurableEntityMigrationPlan, id: string): string {
  const inventory = [...plan.entries, ...plan.preserved_residues];
  return dumpYamlMapping({ schemaVersion: "agentera.entityMigrationSnapshot.v1", migration_id: id, project: plan.project, sources: plan.sources, preserved_residues: plan.preserved_residues, migration_provenance: inventory.flatMap((entry) => entry.migration_provenance ? [{ source_identity: entry.source_identity, provenance: entry.migration_provenance }] : []) });
}
function journalBytes(journal: Journal): string { return dumpYamlMapping(journal as unknown as Record<string, unknown>); }
function loadJournal(project: string, id: string): { journal: Journal; bytes: Buffer } {
  if (!/^[a-f0-9]{20}$/.test(id)) throw new EntityMigrationOperationError("invalid_migration_id", `migration ID '${id}' must be 20 lowercase hexadecimal characters`, "Copy the migration ID from the interrupted apply response or durable journal path.");
  const file = path.join(operationRoot(project, id), "journal.yaml");
  let bytes: Buffer;
  try { bytes = readRegular(project, `${ROOT}/${id}/journal.yaml`, "migration journal"); } catch { throw new EntityMigrationOperationError("migration_not_found", `durable migration '${id}' was not found`, `Run agentera state migrate entities --project '${project}' --dry-run --format json, or use the exact migration ID from recovery evidence.`); }
  const journal = loadYamlMapping(bytes.toString("utf8")) as unknown as Journal;
  if (journal.schemaVersion !== "agentera.entityMigrationJournal.v1" || journal.migration_id !== id || journal.project !== project || !PHASES.includes(journal.phase)) throw new EntityMigrationOperationError("journal_invalid", `migration journal '${id}' is invalid or belongs to another project`, "Retain the journal and snapshot, repair the exact durable evidence, and retry with the same migration ID.");
  return { journal, bytes };
}
function writeJournal(project: string, journal: Journal): Buffer {
  const relativeJournal = `${ROOT}/${journal.migration_id}/journal.yaml`; const current = readRegular(project, relativeJournal, "migration journal"); const bytes = journalBytes(journal);
  withMigrationContext(project, journal.migration_id, (context) => context.replaceExisting(relativeJournal, current.toString("utf8"), bytes));
  return Buffer.from(bytes);
}
function fault(point: string): void { if (process.env.NODE_ENV === "test" && process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE === point) process.exit(86); }
function receiptFault(timing: "before" | "after", index: number): void {
  if (process.env.NODE_ENV === "test" && process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE === `prepare_receipt_${timing}` && process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_RECEIPT_INDEX === String(index)) process.exit(86);
}

function assertPlanReady(plan: DurableEntityMigrationPlan, sourceRoot: string): void {
  if (plan.counts.blockers > 0) throw new EntityMigrationOperationError("inventory_blocked", `entity migration inventory has ${plan.counts.blockers} blocker(s)`, `Repair every preview diagnostic, then rerun agentera state migrate entities --project '${plan.project}' --dry-run --format json; no migration journal was created.`);
  const invalid = validateEntityMigrationTargets(plan.project, plan.entries, sourceRoot)[0];
  if (invalid) throw new EntityMigrationOperationError("target_invalid", `mapped record '${invalid.sourceIdentity}' does not satisfy canonical target validation: ${invalid.message}`, `Repair the legacy record, rerun the dry-run preview, and approve the new digest; no migration journal was created.`);
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
interface Preparation { name: string; id: string; relative: string; targets: string[] }

function preparationError(message: string): never {
  throw new EntityMigrationOperationError("preparation_invalid", message, "Preserve the preparation and canonical state; remove nothing manually, then repair or quarantine only with a tested migration maintenance path.");
}

function openPreparation(project: string, pinned: ReturnType<typeof pinnedMigrationParent>, name: string, plan?: DurableEntityMigrationPlan): Preparation {
  const match = /^\.([a-f0-9]{20})\.prepare-([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(name);
  if (!match) return preparationError(`migration preparation '${name}' has an invalid operation-scoped name`);
  let stageFd: number | undefined; let receiptsFd: number | undefined;
  try {
    stageFd = fs.openSync(fdPath(pinned.fd, name), DIRECTORY_FLAGS);
    if (fs.readdirSync(fdPath(stageFd)).join("\0") !== "receipts") return preparationError(`migration preparation '${name}' may contain only its receipts directory`);
    receiptsFd = fs.openSync(fdPath(stageFd, "receipts"), DIRECTORY_FLAGS);
    const names = fs.readdirSync(fdPath(receiptsFd)).sort(); const entityNames = names.filter((entry) => entry !== "marker.yaml");
    if (entityNames.some((entry, index) => entry !== `${String(index).padStart(4, "0")}.yaml`) || (names.includes("marker.yaml") && entityNames.length === 0)) return preparationError(`migration preparation '${name}' has an invalid receipt inventory`);
    const targets: string[] = [];
    for (const [index, receiptName] of entityNames.entries()) {
      const file = fdPath(receiptsFd, receiptName); const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return preparationError(`migration preparation '${name}' receipt '${receiptName}' is not an unlinked regular file`);
      const bytes = fs.readFileSync(file, "utf8");
      if (plan) {
        const entry = plan.entries[index];
        if (!entry || bytes !== canonicalEntityEnvelopeBytes({ id: entry.proposed_target!.id, artifact: entry.artifact!, record: entry.record })) return preparationError(`migration preparation '${name}' receipt '${receiptName}' does not match the approved operation`);
        targets.push(entry.proposed_target!.path);
      } else {
        const document = loadYamlMapping(bytes); const id = String(document.id ?? ""); const artifact = String(document.artifact ?? "");
        const boundaries = entityBoundariesForArtifact(artifact).filter((boundary) => { try { canonicalEntityEnvelope(bytes, { artifact, boundary, id }); return true; } catch { return false; } });
        if (boundaries.length !== 1 || bytes !== canonicalEntityEnvelopeBytes({ id, artifact, record: document.record as never })) return preparationError(`migration preparation '${name}' receipt '${receiptName}' is not one canonical entity envelope`);
        targets.push(`.agentera/entities/${artifact}/${boundaries[0]}/${id}.yaml`);
      }
    }
    if (plan && entityNames.length > plan.entries.length) return preparationError(`migration preparation '${name}' has receipts beyond the approved operation`);
    if (names.includes("marker.yaml")) {
      const file = fdPath(receiptsFd, "marker.yaml"); const stat = fs.lstatSync(file, { bigint: true }); const bytes = fs.readFileSync(file, "utf8");
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return preparationError(`migration preparation '${name}' marker receipt is not an unlinked regular file`);
      if (plan ? entityNames.length !== plan.entries.length || bytes !== markerBytes(match[1], plan) : (() => { const marker = loadYamlMapping(bytes); return marker.schemaVersion !== "agentera.stateMode.v1" || marker.mode !== "entities" || marker.migration_id !== match[1] || operationId({ project, source_fingerprint: String(marker.source_fingerprint), preview_digest: String(marker.preview_digest) } as DurableEntityMigrationPlan) !== match[1]; })()) return preparationError(`migration preparation '${name}' marker receipt is invalid`);
      targets.push(MARKER);
    }
    pinned.assertValid();
    return { name, id: match[1], relative: `${ROOT}/${name}`, targets };
  } catch (error) {
    if (error instanceof EntityMigrationOperationError) throw error;
    return preparationError(`migration preparation '${name}' is unsafe or changed while inspected`);
  } finally { if (receiptsFd !== undefined) fs.closeSync(receiptsFd); if (stageFd !== undefined) fs.closeSync(stageFd); }
}

function inspectPreparations(project: string, current?: DurableEntityMigrationPlan): Preparation[] {
  const parent = path.join(project, ROOT); if (!fs.existsSync(parent)) return [];
  const pinned = pinnedMigrationParent(validateRealProjectRoot(project));
  try {
    const names = fs.readdirSync(fdPath(pinned.fd)).filter((name) => name.includes(".prepare-"));
    if (names.length > 1) preparationError("multiple migration preparations are ambiguous and cannot be resumed or cleaned automatically");
    return names.map((name) => openPreparation(project, pinned, name, current && name.startsWith(`.${operationId(current)}.prepare-`) ? current : undefined));
  } finally { pinned.close(); }
}

function removeStalePreparation(project: string, preparation: Preparation, pinned: ReturnType<typeof pinnedMigrationParent>): void {
  if (fs.existsSync(fdPath(pinned.fd, preparation.id))) preparationError(`stale preparation '${preparation.name}' has final operation evidence`);
  for (const target of preparation.targets) if (fs.existsSync(path.join(project, target))) preparationError(`stale preparation '${preparation.name}' has canonical publication '${target}'`);
  const quarantine = `.${preparation.id}.discard-${randomUUID()}`; let held: number | undefined; let renamed = false;
  try {
    held = fs.openSync(fdPath(pinned.fd, preparation.name), DIRECTORY_FLAGS); pinned.assertValid();
    fs.renameSync(fdPath(pinned.fd, preparation.name), fdPath(pinned.fd, quarantine)); renamed = true; fs.fsyncSync(pinned.fd);
    try { fs.lstatSync(fdPath(pinned.fd, preparation.name)); preparationError(`stale preparation '${preparation.name}' gained a successor during quarantine`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const observed = fs.openSync(fdPath(pinned.fd, quarantine), DIRECTORY_FLAGS);
    try { if (!sameDirectory(fs.fstatSync(held, { bigint: true }), fs.fstatSync(observed, { bigint: true }))) preparationError(`stale preparation '${preparation.name}' was replaced during quarantine`); } finally { fs.closeSync(observed); }
    fs.rmSync(fdPath(pinned.fd, quarantine), { recursive: true }); fs.fsyncSync(pinned.fd); pinned.assertValid();
    try { fs.lstatSync(fdPath(pinned.fd, preparation.name)); preparationError(`stale preparation '${preparation.name}' gained a successor during cleanup`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch (error) {
    if (renamed && error instanceof EntityMigrationOperationError && !error.mutationPerformed) throw new EntityMigrationOperationError(error.classification, error.message, error.recovery, true);
    if (renamed && !(error instanceof EntityMigrationOperationError)) throw new EntityMigrationOperationError("preparation_cleanup_failed", (error as Error).message, "The stale preparation was quarantined but cleanup did not complete; preserve every successor and inspect the operation paths before retrying.", true);
    throw error;
  } finally { if (held !== undefined) fs.closeSync(held); }
}

function prepare(plan: DurableEntityMigrationPlan, preparation?: Preparation, action: "created" | "resumed" | "replaced" = "created"): { journal: Journal; preparation: NonNullable<EntityMigrationResult["preparation"]> } {
  const id = operationId(plan); const root = operationRoot(plan.project, id); const pinned = pinnedMigrationParent(validateRealProjectRoot(plan.project));
  const stageName = preparation?.name ?? `.${id}.prepare-${randomUUID()}`; const stage = fdPath(pinned.fd, stageName); let stageFd: number | undefined; let renamed = false; let published = false;
  try { fs.lstatSync(fdPath(pinned.fd, id)); throw new EntityMigrationOperationError("migration_exists", `migration '${id}' already has durable evidence`, `Resume it explicitly with agentera state migrate entities --project '${plan.project}' --resume ${id} --force --format json.`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { pinned.close(); throw error; } }
  const snapshot = snapshotBytes(plan, id);
  try {
    if (!preparation) { fs.mkdirSync(stage, { mode: 0o700 }); fs.fsyncSync(pinned.fd); }
    stageFd = fs.openSync(stage, DIRECTORY_FLAGS); pinned.assertValid();
    if (!preparation) { fs.mkdirSync(fdPath(stageFd, "receipts"), { mode: 0o700 }); fs.fsyncSync(stageFd); }
    const receiptsFd = fs.openSync(fdPath(stageFd, "receipts"), DIRECTORY_FLAGS); const receipts: Record<string, Receipt> = {};
    try {
      for (const [index, entry] of plan.entries.entries()) {
        const target = entry.proposed_target!.path; const name = `${String(index).padStart(4, "0")}.yaml`; const bytes = canonicalEntityEnvelopeBytes({ id: entry.proposed_target!.id, artifact: entry.artifact!, record: entry.record });
        receiptFault("before", index);
        if (!fs.existsSync(fdPath(receiptsFd, name))) durableCreate(fdPath(receiptsFd, name), bytes);
        const observed = descriptorIdentity(fdPath(receiptsFd, name)); const stat = fs.lstatSync(fdPath(receiptsFd, name), { bigint: true });
        if (observed.sha256 !== hash(bytes) || observed.size !== BigInt(Buffer.byteLength(bytes)) || stat.nlink !== 1n) preparationError(`migration preparation '${stageName}' receipt '${name}' changed before finalization`);
        receipts[target] = { ...identity(observed), path: `${ROOT}/${id}/receipts/${name}`, target, kind: "entity" }; receiptFault("after", index);
      }
      const marker = markerBytes(id, plan); receiptFault("before", plan.entries.length); if (!fs.existsSync(fdPath(receiptsFd, "marker.yaml"))) durableCreate(fdPath(receiptsFd, "marker.yaml"), marker); const observedMarker = descriptorIdentity(fdPath(receiptsFd, "marker.yaml")); const markerStat = fs.lstatSync(fdPath(receiptsFd, "marker.yaml"), { bigint: true }); if (observedMarker.sha256 !== hash(marker) || observedMarker.size !== BigInt(Buffer.byteLength(marker)) || markerStat.nlink !== 1n) preparationError(`migration preparation '${stageName}' marker receipt changed before finalization`); receipts[MARKER] = { ...identity(observedMarker), path: `${ROOT}/${id}/receipts/marker.yaml`, target: MARKER, kind: "marker" }; receiptFault("after", plan.entries.length);
      fs.fsyncSync(receiptsFd);
    } finally { fs.closeSync(receiptsFd); }
    fault("prepare_rename_before"); const manifest = manifestBytes(plan, id, receipts);
    const journal: Journal = { schemaVersion: "agentera.entityMigrationJournal.v1", migration_id: id, project: plan.project, source_fingerprint: plan.source_fingerprint, preview_digest: plan.preview_digest, phase: "prepare_recovery", phases: PHASES, manifest_sha256: hash(manifest), snapshot_sha256: hash(snapshot) };
    durableCreate(fdPath(stageFd, "manifest.yaml"), manifest); durableCreate(fdPath(stageFd, "snapshot.yaml"), snapshot);
    durableCreate(fdPath(stageFd, "journal.yaml"), journalBytes(journal)); fs.fsyncSync(stageFd); pinned.assertValid();
    fs.renameSync(fdPath(pinned.fd, stageName), fdPath(pinned.fd, id)); renamed = true; fs.fsyncSync(pinned.fd); pinned.assertValid(); published = true; fault("prepare_rename_after");
  } catch (error) {
    throw error;
  } finally {
    if (stageFd !== undefined) fs.closeSync(stageFd);
    if (!published) { try { fs.rmSync(fdPath(pinned.fd, renamed ? id : stageName), { recursive: true }); fs.fsyncSync(pinned.fd); } catch { /* Preserve the original preparation failure. */ } }
    pinned.close();
  }
  if (!fs.existsSync(root)) throw new Error(`migration '${id}' preparation did not publish its durable evidence directory`);
  fault("prepare_recovery"); return { journal: loadJournal(plan.project, id).journal, preparation: { action, path: `${ROOT}/${stageName}` } };
}

function loadEvidence(project: string, journal: Journal): LoadedEvidence {
  const manifest = readRegular(project, `${ROOT}/${journal.migration_id}/manifest.yaml`, "migration manifest");
  const snapshot = readRegular(project, `${ROOT}/${journal.migration_id}/snapshot.yaml`, "migration snapshot");
  if (hash(manifest) !== journal.manifest_sha256 || hash(snapshot) !== journal.snapshot_sha256) throw new EntityMigrationOperationError("evidence_changed", `durable evidence for migration '${journal.migration_id}' changed`, "Retain all evidence and restore the immutable manifest and snapshot before retrying.");
  const document = loadYamlMapping(manifest.toString("utf8"));
  const snapshotDocument = loadYamlMapping(snapshot.toString("utf8"));
  if (document.migration_id !== journal.migration_id || document.project !== project || document.source_fingerprint !== journal.source_fingerprint || document.preview_digest !== journal.preview_digest || !Array.isArray(document.entries) || !Array.isArray(document.preserved_residues) || !Array.isArray(document.sources) || !document.receipts || typeof document.receipts !== "object") throw new EntityMigrationOperationError("evidence_invalid", `durable manifest for migration '${journal.migration_id}' is invalid`, "Retain the evidence and repair it from the approved preview before retrying.");
  if (snapshotDocument.migration_id !== journal.migration_id || snapshotDocument.project !== project || !Array.isArray(snapshotDocument.sources) || !Array.isArray(snapshotDocument.preserved_residues) || canonicalRecordJson(snapshotDocument.sources) !== canonicalRecordJson(document.sources) || canonicalRecordJson(snapshotDocument.preserved_residues) !== canonicalRecordJson(document.preserved_residues)) throw new EntityMigrationOperationError("evidence_invalid", `durable snapshot for migration '${journal.migration_id}' is invalid`, "Retain the evidence and restore the immutable manifest and snapshot before retrying.");
  const entries = document.entries as unknown as DurableEntityMigrationEntry[];
  const preservedResidues = document.preserved_residues as unknown as DurableEntityMigrationEntry[];
  if (canonicalRecordJson(document.inventory) !== canonicalRecordJson(inventoryBinding(entries, preservedResidues)) || entries.some((entry) => entry.classification === "historical_projection_residue" || !entry.proposed_target) || preservedResidues.some((entry) => entry.classification !== "historical_projection_residue" || entry.boundary !== "historical_projection_residue" || entry.proposed_target !== null || entry.relationships.length !== 0)) throw new EntityMigrationOperationError("evidence_invalid", `durable manifest inventory for migration '${journal.migration_id}' is invalid`, "Retain all evidence; publishable entities and preserved nonentity residues must reconcile separately.");
  const receipts = document.receipts as Record<string, Receipt>;
  const targets = [...entries.map((entry) => entry.proposed_target!.path), MARKER];
  if (Object.keys(receipts).sort().join("\0") !== [...targets].sort().join("\0")) throw new EntityMigrationOperationError("evidence_invalid", `durable receipt inventory for migration '${journal.migration_id}' is invalid`, "Retain all evidence; the immutable manifest must own every entity and marker receipt exactly once.");
  for (const target of targets) {
    const receipt = receipts[target];
    const receiptSegments = receipt?.path?.split("/") ?? [];
    if (!receipt || receipt.target !== target || path.posix.dirname(receipt.path) !== `${ROOT}/${journal.migration_id}/receipts` || receiptSegments.includes("..") || receiptSegments.includes(".") || receipt.kind !== (target === MARKER ? "marker" : "entity")) throw new EntityMigrationOperationError("evidence_invalid", `durable receipt for '${target}' is invalid`, "Retain all recovery evidence and restore the immutable manifest.");
    let current: StoredIdentity;
    try { current = identity(projectFileIdentity(project, receipt.path)); } catch { throw new EntityMigrationOperationError("receipt_changed", `migration ownership receipt for '${target}' is missing or unsafe`, "Retain canonical targets and recovery evidence; never infer ownership from target content."); }
    if (canonicalRecordJson(current) !== canonicalRecordJson({ dev: receipt.dev, ino: receipt.ino, type: receipt.type, size: receipt.size, sha256: receipt.sha256 })) throw new EntityMigrationOperationError("receipt_changed", `migration ownership receipt for '${target}' changed`, "Retain canonical targets and recovery evidence; restore the exact pre-publication receipt inode before retrying.");
  }
  return { entries, preservedResidues, receipts };
}

/** Safely loads immutable evidence for maintenance validation without checking target inode ownership. */
export function loadCompletedEntityMigrationManifest(project: string, id: string): DurableEntityMigrationEntry[] {
  const { journal } = loadJournal(project, id);
  if (journal.phase !== "cutover_complete") throw new EntityMigrationOperationError("migration_incomplete", `migration '${id}' is in phase '${journal.phase}', not cutover_complete`, "Resume or roll back the owning migration before validating entity-mode state.");
  return loadEvidence(project, journal).entries;
}

/** Bind a current marker's exact bytes and logical fields to completed immutable evidence. */
export function loadCompletedEntityMigrationForMarker(project: string, markerBytes: Buffer): DurableEntityMigrationEntry[] {
  const marker = loadYamlMapping(markerBytes.toString("utf8"));
  if (marker.schemaVersion !== "agentera.stateMode.v1" || marker.mode !== "entities" || typeof marker.migration_id !== "string") throw new EntityMigrationOperationError("marker_invalid", "entity-mode marker has no completed migration binding", "Restore the exact marker owned by completed migration evidence.");
  const { journal } = loadJournal(project, marker.migration_id);
  if (journal.phase !== "cutover_complete") throw new EntityMigrationOperationError("migration_incomplete", `migration '${journal.migration_id}' is in phase '${journal.phase}', not cutover_complete`, "Resume or roll back the owning migration before validating entity-mode state.");
  const evidence = loadEvidence(project, journal);
  const receipt = evidence.receipts[MARKER];
  if (marker.source_fingerprint !== journal.source_fingerprint || marker.preview_digest !== journal.preview_digest || hash(markerBytes) !== receipt.sha256) throw new EntityMigrationOperationError("marker_diverged", `completed migration marker does not match immutable evidence for '${journal.migration_id}'`, "Restore the exact canonical marker bytes from the validated migration receipt.");
  return evidence.entries;
}
function assertCurrentSource(project: string, sourceRoot: string, journal: Journal): void {
  const current = planEntityMigration(project, sourceRoot);
  const snapshot = loadYamlMapping(readRegular(project, `${ROOT}/${journal.migration_id}/snapshot.yaml`, "migration snapshot").toString("utf8"));
  if (snapshot.migration_id !== journal.migration_id || snapshot.project !== project || !Array.isArray(snapshot.sources)) throw new EntityMigrationOperationError("evidence_invalid", `durable snapshot for migration '${journal.migration_id}' is invalid`, "Retain the evidence and restore the immutable snapshot before retrying.");
  if (current.source_fingerprint !== journal.source_fingerprint || current.preview_digest !== journal.preview_digest || canonicalRecordJson(current.sources) !== canonicalRecordJson(snapshot.sources)) throw new EntityMigrationOperationError("source_changed", `legacy source changed after migration '${journal.migration_id}' was prepared`, `Restore the recovery snapshot or roll back safely with agentera state migrate entities --project '${project}' --rollback ${journal.migration_id} --force --format json.`);
}
function withMigrationContext<T>(project: string, id: string, run: (context: EntityPublicationContext) => T): T {
  const relativeManifest = `${ROOT}/${id}/manifest.yaml`; const bytes = readRegular(project, relativeManifest, "migration manifest");
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
function matchesReceipt(project: string, target: string, receipt: Receipt): boolean {
  try { return canonicalRecordJson(identity(projectFileIdentity(project, target))) === canonicalRecordJson({ dev: receipt.dev, ino: receipt.ino, type: receipt.type, size: receipt.size, sha256: receipt.sha256 }); }
  catch { return false; }
}
function advance(project: string, sourceRoot: string, journal: Journal, operation: "apply" | "resume", preparation?: EntityMigrationResult["preparation"]): EntityMigrationResult {
  const { entries, preservedResidues, receipts } = loadEvidence(project, journal); assertCurrentSource(project, sourceRoot, journal);
  const invalid = validateEntityMigrationTargets(project, entries, sourceRoot)[0];
  if (invalid) throw new EntityMigrationOperationError("target_invalid", `durable mapped record '${invalid.sourceIdentity}' does not satisfy canonical target validation: ${invalid.message}`, "Retain all recovery evidence and do not publish or modify targets; restore the exact validated manifest before resuming.");
  if (["rollback_prepared", "rollback_cutover", "rolled_back"].includes(journal.phase)) throw new EntityMigrationOperationError("migration_rolled_back", `migration '${journal.migration_id}' entered rollback at '${journal.phase}'`, `Continue rollback explicitly with agentera state migrate entities --project '${project}' --rollback ${journal.migration_id} --force --format json.`);
  if (journal.phase === "prepare_recovery") {
    withMigrationContext(project, journal.migration_id, (context) => {
      for (const entry of entries) {
        const target = entry.proposed_target;
        if (!target) throw new Error(`manifest entry '${entry.source_identity}' has no canonical target`);
        const receipt = receipts[target.path];
        context.publishPreowned(target.path, receipt.path, storedIdentity(receipt));
        fault("publish_entity");
      }
    });
    journal.phase = "publish_entities"; writeJournal(project, journal); fault("publish_entities");
  }
  if (journal.phase === "publish_entities") { verifyManifestGraph(project, sourceRoot, entries); journal.phase = "validate_graph"; writeJournal(project, journal); fault("validate_graph"); }
  if (journal.phase === "validate_graph") {
    const receipt = receipts[MARKER];
    withMigrationContext(project, journal.migration_id, (context) => { context.publishPreowned(MARKER, receipt.path, storedIdentity(receipt)); fault("publish_marker"); });
    journal.phase = "cutover"; writeJournal(project, journal); fault("cutover");
  }
  if (journal.phase === "cutover") { verifyManifestGraph(project, sourceRoot, entries); journal.phase = "cutover_complete"; writeJournal(project, journal); fault("cutover_complete"); }
  verifyManifestGraph(project, sourceRoot, entries);
  return { schemaVersion: "agentera.entityMigration.v1", command: "state migrate entities", status: "complete", operation, migration_id: journal.migration_id, phase: journal.phase, idempotent: operation === "resume" && journal.phase === "cutover_complete", mutation_performed: true, entity_count: entries.length, preserved_residues: residueSummary(preservedResidues), evidence: evidence(project, journal.migration_id), ...(preparation ? { preparation } : {}) };
}

export function applyEntityMigration(projectRoot: string, sourceRoot: string, fingerprint: string, digest: string, approvalFile?: string): EntityMigrationResult {
  const project = validateRealProjectRoot(projectRoot).path;
  const first = planEntityMigration(project, sourceRoot); assertPlanReady(first, sourceRoot); assertBinding(first, fingerprint, digest);
  inspectPreparations(project, first);
  if (projectIsGitCheckout(project)) {
    if (!approvalFile) throw new EntityMigrationOperationError("approval_required", "entity migration apply in a Git checkout requires an external approval file", "Generate a clean approval envelope, then retry with --approval-file FILE and matching source/digest values.");
  }
  const id = operationId(first); const existing = path.join(operationRoot(project, id), "journal.yaml");
  if (fs.existsSync(existing)) {
    if (approvalFile) assertEntityMigrationApproval(project, approvalFile, fingerprint, digest);
    const loaded = loadJournal(project, id).journal;
    if (loaded.phase === "cutover_complete") return resumeEntityMigration(project, sourceRoot, id, "apply");
    throw new EntityMigrationOperationError("migration_exists", `migration '${id}' was interrupted at '${loaded.phase}'`, `Resume it explicitly with agentera state migrate entities --project '${project}' --resume ${id} --force --format json.`);
  }
  const lock = acquireWriterLock(project, 2000);
  let staleRemoved = false;
  try {
    const current = planEntityMigration(project, sourceRoot); assertPlanReady(current, sourceRoot); assertBinding(current, fingerprint, digest); assertNoCanonicalState(project, sourceRoot);
    const preparations = inspectPreparations(project, current);
    if (approvalFile) assertEntityMigrationApproval(project, approvalFile, fingerprint, digest, true, preparations.map(({ relative }) => relative));
    let selected: Preparation | undefined = preparations[0]; let action: "created" | "resumed" | "replaced" = selected?.id === id ? "resumed" : "created";
    if (selected && selected.id !== id) {
      const pinned = pinnedMigrationParent(validateRealProjectRoot(project));
      try { removeStalePreparation(project, selected, pinned); staleRemoved = true; } finally { pinned.close(); }
      selected = undefined; action = "replaced";
    }
    const prepared = prepare(current, selected, action);
    return advance(project, sourceRoot, prepared.journal, "apply", prepared.preparation);
  } catch (error) {
    if (staleRemoved && error instanceof EntityMigrationOperationError && !error.mutationPerformed) throw new EntityMigrationOperationError(error.classification, error.message, error.recovery, true);
    if (staleRemoved && !(error instanceof EntityMigrationOperationError)) throw new EntityMigrationOperationError("migration_failed", (error as Error).message, "The stale preparation was explicitly removed, but the successor did not complete; retry the exact approved apply after inspecting current state.", true);
    throw error;
  }
  finally { lock.release(); }
}

export function resumeEntityMigration(projectRoot: string, sourceRoot: string, id: string, operation: "apply" | "resume" = "resume"): EntityMigrationResult {
  const project = validateRealProjectRoot(projectRoot).path; const lock = acquireWriterLock(project, 2000);
  try {
    const journal = loadJournal(project, id).journal;
    if (journal.phase === "cutover_complete") {
      const { entries, preservedResidues, receipts } = loadEvidence(project, journal); assertCurrentSource(project, sourceRoot, journal); verifyManifestGraph(project, sourceRoot, entries);
      if (!matchesReceipt(project, MARKER, receipts[MARKER])) throw new EntityMigrationOperationError("marker_diverged", "completed migration marker changed after cutover", "Retain all recovery evidence and repair no authority files manually.");
      return { schemaVersion: "agentera.entityMigration.v1", command: "state migrate entities", status: "complete", operation, migration_id: id, phase: journal.phase, idempotent: true, mutation_performed: false, entity_count: entries.length, preserved_residues: residueSummary(preservedResidues), evidence: evidence(project, id) };
    }
    return advance(project, sourceRoot, journal, operation);
  } finally { lock.release(); }
}

function assertSnapshotUnchanged(project: string, journal: Journal): void {
  const snapshot = loadYamlMapping(readRegular(project, `${ROOT}/${journal.migration_id}/snapshot.yaml`, "migration snapshot").toString("utf8"));
  if (!Array.isArray(snapshot.sources)) throw new Error("migration snapshot has no source inventory");
  for (const source of snapshot.sources as Array<Record<string, unknown>>) {
    const observed = readProjectFileSnapshot(validateRealProjectRoot(project), String(source.path));
    if (source.presence === "missing") { if (observed.kind !== "missing") throw new EntityMigrationOperationError("post_cutover_write", `legacy path '${source.path}' was created after cutover`, "Retain the journal, snapshot, marker, and entities; rollback refused before mutation."); continue; }
    if (observed.kind !== "file" || hash(observed.bytes) !== source.sha256 || observed.mode !== source.mode || String(observed.dev) !== source.dev || String(observed.ino) !== source.ino || observed.type !== source.type) throw new EntityMigrationOperationError("post_cutover_write", `legacy path '${source.path}' changed after cutover`, "Retain the journal, snapshot, marker, and entities; rollback refused before mutation.");
  }
}
function assertRollbackOwnership(project: string, sourceRoot: string, journal: Journal, entries: DurableEntityMigrationEntry[], receipts: Record<string, Receipt>): void {
  assertSnapshotUnchanged(project, journal);
  const discovered = discoverEntities(project, sourceRoot);
  if (discovered.issues.length || discovered.entities.length !== entries.length) throw new EntityMigrationOperationError("post_cutover_write", "canonical entity inventory changed after cutover", "Retain all recovery evidence and canonical state; rollback refused before mutation.");
  for (const entry of entries) {
    const target = entry.proposed_target!.path;
    if (!matchesReceipt(project, target, receipts[target])) throw new EntityMigrationOperationError("post_cutover_write", `canonical entity '${target}' changed after cutover`, "Retain all recovery evidence and canonical state; rollback refused before mutation.");
  }
  if (fs.existsSync(path.join(project, MARKER)) && !matchesReceipt(project, MARKER, receipts[MARKER])) throw new EntityMigrationOperationError("post_cutover_write", "state mode marker changed after cutover", "Retain all recovery evidence and canonical state; rollback refused before mutation.");
}
export function rollbackEntityMigration(projectRoot: string, sourceRoot: string, id: string): EntityMigrationResult {
  const project = validateRealProjectRoot(projectRoot).path; const lock = acquireWriterLock(project, 2000);
  try {
    const journal = loadJournal(project, id).journal; const { entries, preservedResidues, receipts } = loadEvidence(project, journal);
    if (journal.phase === "rolled_back") {
      assertSnapshotUnchanged(project, journal);
      const successor = [MARKER, ...entries.map((entry) => entry.proposed_target!.path)].find((relativePath) => fs.existsSync(path.join(project, relativePath)));
      if (successor) throw new EntityMigrationOperationError("post_rollback_successor", `rollback successor '${successor}' exists after migration '${id}' completed`, "Retain the successor and recovery evidence; do not retry destructive rollback against a new file identity.");
      return { schemaVersion: "agentera.entityMigration.v1", command: "state migrate entities", status: "rolled_back", operation: "rollback", migration_id: id, phase: "rolled_back", idempotent: true, mutation_performed: false, entity_count: entries.length, preserved_residues: residueSummary(preservedResidues), evidence: evidence(project, id) };
    }
    if (!journal.phase.startsWith("rollback_")) {
      assertRollbackOwnership(project, sourceRoot, journal, entries, receipts);
      journal.phase = "rollback_prepared"; writeJournal(project, journal); fault("rollback_prepared");
    }
    if (journal.phase === "rollback_prepared") {
      assertSnapshotUnchanged(project, journal);
      const markerPresent = fs.existsSync(path.join(project, MARKER));
      for (const entry of entries) {
        const target = entry.proposed_target!.path;
        if (!fs.existsSync(path.join(project, target)) || !matchesReceipt(project, target, receipts[target])) throw new EntityMigrationOperationError(markerPresent ? "post_cutover_write" : "post_rollback_successor", `canonical entity '${target}' changed before rollback cleanup`, markerPresent ? "Retain all recovery evidence and canonical state; rollback refused before authority changed." : "Legacy authority is active; retain the successor and recovery evidence because rollback will never delete the new identity.");
      }
      if (markerPresent) withMigrationContext(project, id, (context) => {
        const result = context.removeExact(MARKER, storedIdentity(receipts[MARKER]));
        if (result === "identity_mismatch") throw new EntityMigrationOperationError("post_cutover_write", "state mode marker changed during rollback cutover", "Retain the successor marker, entities, and recovery evidence; rollback refused before authority changed.");
        fault("rollback_remove_marker");
      });
      if (fs.existsSync(path.join(project, MARKER))) throw new EntityMigrationOperationError("post_cutover_write", "state mode marker remains after rollback cutover", "Retain the marker, entities, and recovery evidence; rollback did not change authority.");
      assertSnapshotUnchanged(project, journal); journal.phase = "rollback_cutover"; writeJournal(project, journal); fault("rollback_cutover");
    }
    if (journal.phase === "rollback_cutover") {
      assertSnapshotUnchanged(project, journal);
      withMigrationContext(project, id, (context) => {
        for (const entry of [...entries].reverse()) {
          const target = entry.proposed_target!.path; const absolute = path.join(project, target); const expected = receipts[target];
          if (!fs.existsSync(absolute)) continue;
          if (!matchesReceipt(project, target, expected)) throw new EntityMigrationOperationError("post_rollback_successor", `rollback successor '${target}' replaced an operation-owned entity`, "Legacy authority is active; retain the successor and recovery evidence because rollback will never delete the new inode.");
          const result = context.removeExact(target, storedIdentity(expected));
          if (result === "identity_mismatch") throw new EntityMigrationOperationError("post_rollback_successor", `rollback successor '${target}' replaced an operation-owned entity during removal`, "Legacy authority is active; retain the successor and recovery evidence because rollback will never delete the new inode.");
          fault("rollback_remove_entity");
        }
      });
      if (fs.existsSync(path.join(project, MARKER))) throw new EntityMigrationOperationError("post_rollback_successor", "a state mode marker appeared during rollback cleanup", "Retain the marker and recovery evidence; rollback cannot report completion while its authority is unknown.");
      const residue = entries.find((entry) => fs.existsSync(path.join(project, entry.proposed_target!.path)));
      if (residue) throw new EntityMigrationOperationError("post_rollback_successor", `rollback successor '${residue.proposed_target!.path}' remains after cleanup`, "Legacy authority is active; retain the successor and recovery evidence because rollback cannot report completion.");
      assertSnapshotUnchanged(project, journal);
      journal.phase = "rolled_back"; writeJournal(project, journal); fault("rolled_back");
    }
    return { schemaVersion: "agentera.entityMigration.v1", command: "state migrate entities", status: "rolled_back", operation: "rollback", migration_id: id, phase: "rolled_back", idempotent: false, mutation_performed: true, entity_count: entries.length, preserved_residues: residueSummary(preservedResidues), evidence: evidence(project, id) };
  } finally { lock.release(); }
}

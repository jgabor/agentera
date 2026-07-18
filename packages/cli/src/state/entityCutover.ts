import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { writeFileAtomic } from "../upgrade/atomicWriter.js";
import { upgradeLockPath } from "../upgrade/upgradeLock.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { verifyEntityCutoverGitSource } from "./entityCutoverGit.js";
import { canonicalEntityEnvelopeBytes, validateEntityState } from "./entityStorage.js";
import { planEntityMigration, validateEntityMigrationTargets, type DurableEntityMigrationPlan } from "./entityMigrationPreview.js";
import { loadLegacyEntityCutoverTargets, type EntityCutoverTargetBinding } from "./legacyEntityCutoverEvidence.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";
import { acquireWriterLock } from "./write/lock.js";

export const MIGRATION_ROOT = ".agentera/migrations/entities";
export const MIGRATION_STAGING = `${MIGRATION_ROOT}/staging`;
export const FORWARD_MANIFEST = `${MIGRATION_ROOT}/forward.yaml`;
export const ENTITY_MODE_MARKER = ".agentera/state-mode.yaml";

const STAGING_PROJECT = `${MIGRATION_STAGING}/project`;
const MANIFEST_SCHEMA = "agentera.entityCutoverManifest.v1";
const MARKER_BYTES = dumpYamlMapping({ schemaVersion: "agentera.stateMode.v1", mode: "entities", cutover: "one_way_git" });
const SHA256 = /^[a-f0-9]{64}$/;

type ForwardPhase = "publishing_entities" | "entities_published";

interface ForwardManifest {
  schemaVersion: typeof MANIFEST_SCHEMA;
  phase: ForwardPhase;
  source: { head: string; source_fingerprint: string; preview_digest: string };
  targets: EntityCutoverTargetBinding[];
  marker: { path: typeof ENTITY_MODE_MARKER; sha256: string };
}

export interface PreparedEntityCutover {
  project: string;
  sourceRoot: string;
  head: string;
  sourceFingerprint: string;
  previewDigest: string;
}

export interface EntityCutoverInspection {
  phase: "ready" | ForwardPhase | "active";
  entityCount: number;
}

export interface EntityCutoverResult {
  status: "complete";
  phase: "active";
  idempotent: boolean;
  mutation_performed: boolean;
  entity_count: number;
}

export class EntityCutoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityCutoverError";
  }
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return canonicalRecordJson(Object.keys(value).sort()) === canonicalRecordJson([...expected].sort());
}

function safeTarget(value: string): boolean {
  return value.startsWith(".agentera/entities/")
    && !path.isAbsolute(value)
    && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function markerSnapshot(project: string): ReturnType<typeof readProjectFileSnapshot> {
  return readProjectFileSnapshot(validateRealProjectRoot(project), ENTITY_MODE_MARKER);
}

function manifestBytes(manifest: ForwardManifest): string {
  return dumpYamlMapping(manifest as unknown as Record<string, unknown>);
}

function parseForwardManifest(bytes: Buffer): ForwardManifest {
  const value = loadYamlMapping(bytes.toString("utf8"));
  if (!exactKeys(value, ["schemaVersion", "phase", "source", "targets", "marker"])
    || value.schemaVersion !== MANIFEST_SCHEMA
    || !["publishing_entities", "entities_published"].includes(String(value.phase))
    || !mapping(value.source)
    || !exactKeys(value.source, ["head", "source_fingerprint", "preview_digest"])
    || typeof value.source.head !== "string"
    || !/^[a-f0-9]{40,64}$/.test(value.source.head)
    || typeof value.source.source_fingerprint !== "string"
    || !SHA256.test(value.source.source_fingerprint)
    || typeof value.source.preview_digest !== "string"
    || !SHA256.test(value.source.preview_digest)
    || !mapping(value.marker)
    || !exactKeys(value.marker, ["path", "sha256"])
    || value.marker.path !== ENTITY_MODE_MARKER
    || value.marker.sha256 !== hash(MARKER_BYTES)
    || !Array.isArray(value.targets)) {
    throw new EntityCutoverError(`forward cutover manifest '${FORWARD_MANIFEST}' is invalid`);
  }
  const targets = value.targets.map((raw): EntityCutoverTargetBinding => {
    if (!mapping(raw) || !exactKeys(raw, ["path", "sha256"]) || typeof raw.path !== "string" || !safeTarget(raw.path) || typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256)) {
      throw new EntityCutoverError(`forward cutover manifest '${FORWARD_MANIFEST}' has an invalid target`);
    }
    return { path: raw.path, sha256: raw.sha256 };
  });
  if (new Set(targets.map(({ path: target }) => target)).size !== targets.length
    || canonicalRecordJson([...targets].sort((a, b) => a.path.localeCompare(b.path))) !== canonicalRecordJson(targets)) {
    throw new EntityCutoverError(`forward cutover manifest '${FORWARD_MANIFEST}' targets must be unique and sorted`);
  }
  return {
    schemaVersion: MANIFEST_SCHEMA,
    phase: value.phase as ForwardPhase,
    source: value.source as ForwardManifest["source"],
    targets,
    marker: value.marker as ForwardManifest["marker"],
  };
}

function loadForwardManifest(project: string): ForwardManifest | null {
  const observed = readProjectFileSnapshot(validateRealProjectRoot(project), FORWARD_MANIFEST);
  if (observed.kind === "missing") return null;
  if (observed.kind !== "file") throw new EntityCutoverError(`forward cutover manifest '${FORWARD_MANIFEST}' is unsafe`);
  return parseForwardManifest(observed.bytes);
}

function targetsForPlan(plan: DurableEntityMigrationPlan): EntityCutoverTargetBinding[] {
  const targets = plan.entries.map((entry): EntityCutoverTargetBinding => {
    const target = entry.proposed_target;
    if (!target || typeof target.id !== "string" || typeof entry.artifact !== "string" || !safeTarget(target.path)) throw new EntityCutoverError(`migration source '${entry.source_identity}' has no safe canonical target`);
    const id = target.id;
    const artifact = entry.artifact;
    const bytes = canonicalEntityEnvelopeBytes({ id, artifact, record: entry.record });
    const sha256 = hash(bytes);
    if (entry.target_sha256 !== sha256) throw new EntityCutoverError(`migration source '${entry.source_identity}' target digest is not deterministic`);
    return { path: target.path, sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(targets.map(({ path: target }) => target)).size !== targets.length) throw new EntityCutoverError("entity cutover target paths are not unique");
  return targets;
}

function assertPlanReady(plan: DurableEntityMigrationPlan, sourceRoot: string): void {
  if (plan.counts.blockers > 0) throw new EntityCutoverError(`entity migration inventory has ${plan.counts.blockers} blocker(s); repair the read-only preview before upgrade`);
  const invalid = validateEntityMigrationTargets(plan.project, plan.entries, sourceRoot)[0];
  if (invalid) throw new EntityCutoverError(`mapped record '${invalid.sourceIdentity}' is invalid: ${invalid.message}`);
}

function listFiles(project: string, relativeRoot: string): string[] {
  const absoluteRoot = path.join(project, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(absoluteRoot) !== absoluteRoot) throw new EntityCutoverError(`cutover path '${relativeRoot}' must be a real project directory`);
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(project, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new EntityCutoverError(`cutover path '${relative}' must not be a symbolic link`);
      if (entry.isDirectory()) {
        if (fs.realpathSync(absolute) !== absolute) throw new EntityCutoverError(`cutover directory '${relative}' is unsafe`);
        visit(absolute);
      } else if (entry.isFile()) found.push(relative);
      else throw new EntityCutoverError(`cutover path '${relative}' must be a regular file or directory`);
    }
  };
  visit(absoluteRoot);
  return found.sort();
}

function validateExistingCanonicalTargets(project: string, targets: EntityCutoverTargetBinding[], requireAll: boolean): void {
  const expected = new Map(targets.map((target) => [target.path, target]));
  for (const relative of listFiles(project, ".agentera/entities")) {
    const target = expected.get(relative);
    if (!target) throw new EntityCutoverError(`canonical entity '${relative}' is outside the bounded forward manifest`);
  }
  for (const target of targets) {
    const observed = readProjectFileSnapshot(validateRealProjectRoot(project), target.path);
    if (observed.kind === "missing") {
      if (requireAll) throw new EntityCutoverError(`canonical entity '${target.path}' is missing after entity publication`);
      continue;
    }
    if (observed.kind !== "file" || hash(observed.bytes) !== target.sha256) throw new EntityCutoverError(`canonical entity '${target.path}' diverges from the bounded forward manifest`);
  }
}

function assertManifestMatchesPlan(manifest: ForwardManifest, plan: DurableEntityMigrationPlan, head: string | null, targets: EntityCutoverTargetBinding[]): void {
  if ((head !== null && manifest.source.head !== head)
    || manifest.source.source_fingerprint !== plan.source_fingerprint
    || manifest.source.preview_digest !== plan.preview_digest
    || canonicalRecordJson(manifest.targets) !== canonicalRecordJson(targets)) {
    throw new EntityCutoverError("forward cutover manifest does not match the current Git-pinned migration source");
  }
}

function validateActiveEntityCutover(project: string, markerBytes: Buffer, sourceRoot: string): number {
  const targets = loadEntityCutoverTargetsForMarker(project, markerBytes);
  const result = validateEntityState(project, sourceRoot);
  if (!result.valid) throw new EntityCutoverError(`active entity state is invalid: ${result.issues.map(({ message }) => message).join("; ")}`);
  const byPath = new Map(result.entities.map((entity) => [entity.relativePath, entity]));
  for (const target of targets) {
    const entity = byPath.get(target.path);
    if (!entity || entity.classification !== "valid" || (target.id && entity.id !== target.id) || (target.artifact && entity.artifact !== target.artifact)) {
      throw new EntityCutoverError(`active entity target '${target.path}' is missing or invalid`);
    }
  }
  return result.entityCount;
}

export function loadEntityCutoverTargetsForMarker(projectRoot: string, bytes: Buffer): EntityCutoverTargetBinding[] {
  const project = validateRealProjectRoot(projectRoot).path;
  const marker = loadYamlMapping(bytes.toString("utf8"));
  if (marker.schemaVersion !== "agentera.stateMode.v1" || marker.mode !== "entities") throw new EntityCutoverError("state marker is not valid entity authority");
  if (marker.cutover === "one_way_git") {
    const manifest = loadForwardManifest(project);
    if (!manifest || manifest.phase !== "entities_published" || manifest.marker.sha256 !== hash(bytes)) throw new EntityCutoverError("one-way entity marker has no matching completed forward manifest");
    return manifest.targets;
  }
  if (typeof marker.migration_id === "string") return loadLegacyEntityCutoverTargets(project, bytes);
  throw new EntityCutoverError("entity marker has no supported one-way or historical cutover binding");
}

function inspect(projectRoot: string, sourceRoot: string, requireGit: boolean, writerLockHeld = false): { inspection: EntityCutoverInspection; plan?: DurableEntityMigrationPlan; head?: string } {
  const project = validateRealProjectRoot(projectRoot).path;
  const marker = markerSnapshot(project);
  if (marker.kind === "file") return { inspection: { phase: "active", entityCount: validateActiveEntityCutover(project, marker.bytes, sourceRoot) } };
  if (marker.kind !== "missing") throw new EntityCutoverError(`state marker '${ENTITY_MODE_MARKER}' is unsafe`);

  const plan = planEntityMigration(project, sourceRoot);
  assertPlanReady(plan, sourceRoot);
  const targets = targetsForPlan(plan);
  const manifest = loadForwardManifest(project);
  if (manifest) assertManifestMatchesPlan(manifest, plan, null, targets);
  validateExistingCanonicalTargets(project, targets, manifest?.phase === "entities_published");
  if (!manifest && listFiles(project, ".agentera/entities").length > 0) throw new EntityCutoverError("canonical entity state exists without the bounded forward manifest");

  let head: string | undefined;
  if (requireGit) {
    const projectUpgradeLock = path.relative(project, upgradeLockPath(project, "project")).split(path.sep).join("/");
    const allowedPaths = new Set<string>([FORWARD_MANIFEST, ENTITY_MODE_MARKER, projectUpgradeLock]);
    if (manifest) for (const target of targets) allowedPaths.add(target.path);
    const binding = verifyEntityCutoverGitSource(project, plan, { paths: allowedPaths, prefixes: [MIGRATION_STAGING, ...(writerLockHeld ? [".agentera/.writer.lock"] : [])] });
    head = binding.head;
    if (manifest) assertManifestMatchesPlan(manifest, plan, head, targets);
  }
  return { inspection: { phase: manifest?.phase ?? "ready", entityCount: targets.length }, plan, ...(head ? { head } : {}) };
}

export function inspectEntityCutoverForUpgrade(projectRoot: string, sourceRoot: string, requireGit = false): EntityCutoverInspection {
  return inspect(projectRoot, sourceRoot, requireGit).inspection;
}

export function prepareEntityCutoverForUpgrade(projectRoot: string, sourceRoot: string): PreparedEntityCutover {
  const current = inspect(projectRoot, sourceRoot, true);
  if (current.inspection.phase === "active" || !current.plan || !current.head) throw new EntityCutoverError("entity authority is already active; no cutover preparation is available");
  return { project: current.plan.project, sourceRoot, head: current.head, sourceFingerprint: current.plan.source_fingerprint, previewDigest: current.plan.preview_digest };
}

function ensureDirectory(project: string, relativeDirectory: string): void {
  let current = project;
  for (const segment of relativeDirectory.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) throw new EntityCutoverError(`cutover directory '${path.relative(project, current)}' is unsafe`);
  }
}

function removeStaging(project: string): void {
  const staging = path.join(project, MIGRATION_STAGING);
  if (!fs.existsSync(staging)) return;
  const stat = fs.lstatSync(staging);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(staging) !== staging) throw new EntityCutoverError(`known cutover staging '${MIGRATION_STAGING}' is unsafe and was not removed`);
  fs.rmSync(staging, { recursive: true });
}

function writeDurable(file: string, bytes: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function buildStaging(project: string, sourceRoot: string, plan: DurableEntityMigrationPlan, manifest: ForwardManifest): void {
  removeStaging(project);
  ensureDirectory(project, STAGING_PROJECT);
  for (const entry of plan.entries) {
    const target = entry.proposed_target!;
    if (typeof target.id !== "string" || typeof entry.artifact !== "string") throw new EntityCutoverError(`migration source '${entry.source_identity}' has no canonical identity`);
    const id = target.id;
    const artifact = entry.artifact;
    const staged = path.join(project, STAGING_PROJECT, target.path);
    ensureDirectory(project, path.relative(project, path.dirname(staged)).split(path.sep).join("/"));
    writeDurable(staged, canonicalEntityEnvelopeBytes({ id, artifact, record: entry.record }));
  }
  const validation = validateEntityState(path.join(project, STAGING_PROJECT), sourceRoot);
  if (!validation.valid || validation.entityCount !== manifest.targets.length) throw new EntityCutoverError(`staged entity graph is invalid (${validation.entityCount}/${manifest.targets.length})`);
  writeDurable(path.join(project, MIGRATION_STAGING, "forward.yaml"), manifestBytes(manifest));
  fault("staging_built");
}

function publishForwardManifest(project: string): void {
  ensureDirectory(project, MIGRATION_ROOT);
  const target = path.join(project, FORWARD_MANIFEST);
  if (fs.existsSync(target)) throw new EntityCutoverError(`forward cutover manifest '${FORWARD_MANIFEST}' already exists`);
  fs.renameSync(path.join(project, MIGRATION_STAGING, "forward.yaml"), target);
  fault("manifest_published");
}

function publishCanonicalTargets(project: string, manifest: ForwardManifest): void {
  for (const target of manifest.targets) {
    const canonical = path.join(project, target.path);
    const observed = readProjectFileSnapshot(validateRealProjectRoot(project), target.path);
    if (observed.kind === "file") {
      if (hash(observed.bytes) !== target.sha256) throw new EntityCutoverError(`canonical entity '${target.path}' diverges from the bounded forward manifest`);
      continue;
    }
    if (observed.kind !== "missing") throw new EntityCutoverError(`canonical entity '${target.path}' is unsafe`);
    ensureDirectory(project, path.relative(project, path.dirname(canonical)).split(path.sep).join("/"));
    fs.renameSync(path.join(project, STAGING_PROJECT, target.path), canonical);
    fault("entity_published");
  }
}

function validatePublishedGraph(project: string, sourceRoot: string, manifest: ForwardManifest): void {
  validateExistingCanonicalTargets(project, manifest.targets, true);
  const validation = validateEntityState(project, sourceRoot);
  if (!validation.valid || validation.entityCount !== manifest.targets.length) throw new EntityCutoverError(`published entity graph is invalid (${validation.entityCount}/${manifest.targets.length})`);
}

function publishMarker(project: string): void {
  const existing = markerSnapshot(project);
  if (existing.kind === "file") {
    if (!existing.bytes.equals(Buffer.from(MARKER_BYTES))) throw new EntityCutoverError(`state marker '${ENTITY_MODE_MARKER}' has unexpected bytes`);
    return;
  }
  if (existing.kind !== "missing") throw new EntityCutoverError(`state marker '${ENTITY_MODE_MARKER}' is unsafe`);
  ensureDirectory(project, ".agentera");
  const temporary = path.join(project, `.agentera/.state-mode-${randomUUID()}.tmp`);
  try {
    writeDurable(temporary, MARKER_BYTES);
    if (fs.existsSync(path.join(project, ENTITY_MODE_MARKER))) throw new EntityCutoverError(`state marker '${ENTITY_MODE_MARKER}' appeared during publication`);
    fs.renameSync(temporary, path.join(project, ENTITY_MODE_MARKER));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function fault(phase: string): void {
  if (process.env.NODE_ENV === "test" && process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE === phase) throw new EntityCutoverError(`simulated entity cutover interruption after ${phase}`);
}

export function applyPreparedEntityCutover(prepared: PreparedEntityCutover): EntityCutoverResult {
  const before = inspect(prepared.project, prepared.sourceRoot, true);
  if (before.inspection.phase === "active") return { status: "complete", phase: "active", idempotent: true, mutation_performed: false, entity_count: before.inspection.entityCount };
  if (!before.plan || before.head !== prepared.head || before.plan.source_fingerprint !== prepared.sourceFingerprint || before.plan.preview_digest !== prepared.previewDigest) throw new EntityCutoverError("Git-pinned entity cutover preparation changed before apply");

  const lock = acquireWriterLock(prepared.project, 2000);
  try {
    const current = inspect(prepared.project, prepared.sourceRoot, true, true);
    if (current.inspection.phase === "active") return { status: "complete", phase: "active", idempotent: true, mutation_performed: false, entity_count: current.inspection.entityCount };
    const plan = current.plan!;
    if (current.head !== prepared.head || plan.source_fingerprint !== prepared.sourceFingerprint || plan.preview_digest !== prepared.previewDigest) throw new EntityCutoverError("Git-pinned entity cutover source changed before its first publication effect");
    const targets = targetsForPlan(plan);
    let manifest = loadForwardManifest(prepared.project);
    if (!manifest) {
      manifest = { schemaVersion: MANIFEST_SCHEMA, phase: "publishing_entities", source: { head: current.head!, source_fingerprint: plan.source_fingerprint, preview_digest: plan.preview_digest }, targets, marker: { path: ENTITY_MODE_MARKER, sha256: hash(MARKER_BYTES) } };
      buildStaging(prepared.project, prepared.sourceRoot, plan, manifest);
      publishForwardManifest(prepared.project);
    } else if (manifest.phase === "publishing_entities") {
      buildStaging(prepared.project, prepared.sourceRoot, plan, manifest);
    }

    if (manifest.phase === "publishing_entities") {
      publishCanonicalTargets(prepared.project, manifest);
      validatePublishedGraph(prepared.project, prepared.sourceRoot, manifest);
      manifest = { ...manifest, phase: "entities_published" };
      writeFileAtomic(path.join(prepared.project, FORWARD_MANIFEST), manifestBytes(manifest));
    } else {
      validatePublishedGraph(prepared.project, prepared.sourceRoot, manifest);
    }
    removeStaging(prepared.project);
    fault("entities_published");
    publishMarker(prepared.project);
    const marker = markerSnapshot(prepared.project);
    if (marker.kind !== "file") throw new EntityCutoverError("entity authority marker was not published");
    const entityCount = validateActiveEntityCutover(prepared.project, marker.bytes, prepared.sourceRoot);
    return { status: "complete", phase: "active", idempotent: false, mutation_performed: true, entity_count: entityCount };
  } finally {
    lock.release();
  }
}

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { verifyEntityCutoverGitSource } from "./entityCutoverGit.js";
import { canonicalEntityEnvelopeBytes, validateEntityState } from "./entityStorage.js";
import { planEntityMigration, validateEntityMigrationTargets, type DurableEntityMigrationPlan } from "./entityMigrationPreview.js";
import { loadLegacyEntityCutoverTargets, type EntityCutoverTargetBinding } from "./legacyEntityCutoverEvidence.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";
import { acquireWriterLock } from "./write/lock.js";

export const MIGRATION_ROOT = ".agentera/migrations/entities";
export const FORWARD_MANIFEST = `${MIGRATION_ROOT}/forward.yaml`;
export const ENTITY_MODE_MARKER = ".agentera/state-mode.yaml";

const MANIFEST_SCHEMA = "agentera.entityCutoverManifest.v1";
const SHA256 = /^[a-f0-9]{64}$/;

interface HistoricalForwardManifest {
  schemaVersion: typeof MANIFEST_SCHEMA;
  phase: "entities_published";
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
  phase: "ready" | "active";
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

function parseHistoricalForwardManifest(bytes: Buffer): HistoricalForwardManifest {
  const value = loadYamlMapping(bytes.toString("utf8"));
  if (!exactKeys(value, ["schemaVersion", "phase", "source", "targets", "marker"])
    || value.schemaVersion !== MANIFEST_SCHEMA
    || value.phase !== "entities_published"
    || !mapping(value.marker)
    || value.marker.path !== ENTITY_MODE_MARKER
    || typeof value.marker.sha256 !== "string"
    || !SHA256.test(value.marker.sha256)
    || !Array.isArray(value.targets)) {
    throw new EntityCutoverError(`historical cutover manifest '${FORWARD_MANIFEST}' is invalid`);
  }
  const targets = value.targets.map((raw): EntityCutoverTargetBinding => {
    if (!mapping(raw) || !exactKeys(raw, ["path", "sha256"]) || typeof raw.path !== "string" || !safeTarget(raw.path) || typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256)) {
      throw new EntityCutoverError(`historical cutover manifest '${FORWARD_MANIFEST}' has an invalid target`);
    }
    return { path: raw.path, sha256: raw.sha256 };
  });
  return { schemaVersion: MANIFEST_SCHEMA, phase: "entities_published", targets, marker: value.marker as HistoricalForwardManifest["marker"] };
}

function loadHistoricalForwardManifest(project: string): HistoricalForwardManifest | null {
  const observed = readProjectFileSnapshot(validateRealProjectRoot(project), FORWARD_MANIFEST);
  if (observed.kind === "missing") return null;
  if (observed.kind !== "file") throw new EntityCutoverError(`historical cutover manifest '${FORWARD_MANIFEST}' is unsafe`);
  return parseHistoricalForwardManifest(observed.bytes);
}

function targetsForPlan(plan: DurableEntityMigrationPlan): EntityCutoverTargetBinding[] {
  const targets = plan.entries.map((entry): EntityCutoverTargetBinding => {
    const target = entry.proposed_target;
    if (!target || typeof target.id !== "string" || typeof entry.artifact !== "string" || !safeTarget(target.path)) throw new EntityCutoverError(`first unresolved path '${entry.source_paths[0] ?? ".agentera"}': source has no safe canonical target`);
    const bytes = canonicalEntityEnvelopeBytes({ id: target.id, artifact: entry.artifact, record: entry.record, migrationProvenance: entry.canonical_migration_provenance });
    if (entry.target_sha256 !== hash(bytes)) throw new EntityCutoverError(`first unresolved path '${target.path}': converted entity bytes are not deterministic`);
    return { path: target.path, sha256: hash(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(targets.map(({ path: target }) => target)).size !== targets.length) throw new EntityCutoverError("first unresolved path '.agentera/entities': converted target paths are not unique");
  return targets;
}

function assertPlanReady(plan: DurableEntityMigrationPlan, sourceRoot: string): void {
  const blocker = plan.diagnostics[0];
  if (plan.counts.blockers > 0) throw new EntityCutoverError(`first unresolved path '${blocker?.path ?? ".agentera"}': ${blocker?.message ?? `${plan.counts.blockers} migration blocker(s)`}`);
  const invalid = validateEntityMigrationTargets(plan.project, plan.entries, sourceRoot)[0];
  if (invalid) throw new EntityCutoverError(`first unresolved path '${invalid.path}': ${invalid.message}`);
}

function listFiles(project: string, relativeRoot: string): string[] {
  const absoluteRoot = path.join(project, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new EntityCutoverError(`first unresolved path '${path.relative(project, directory)}': expected a real project directory`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(project, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new EntityCutoverError(`first unresolved path '${relative}': symbolic links are not import targets`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) found.push(relative);
      else throw new EntityCutoverError(`first unresolved path '${relative}': expected a regular file`);
    }
  };
  visit(absoluteRoot);
  return found.sort();
}

function validateExistingTargets(project: string, targets: EntityCutoverTargetBinding[]): void {
  const expected = new Map(targets.map((target) => [target.path, target]));
  for (const relative of listFiles(project, ".agentera/entities")) {
    if (!expected.has(relative)) throw new EntityCutoverError(`first unresolved path '${relative}': entity is not part of the converted v2 input`);
  }
  for (const target of targets) {
    const observed = readProjectFileSnapshot(validateRealProjectRoot(project), target.path);
    if (observed.kind === "missing") continue;
    if (observed.kind !== "file" || hash(observed.bytes) !== target.sha256) throw new EntityCutoverError(`first unresolved path '${target.path}': existing target is not an exact converted match`);
  }
}

function validateActiveEntityCutover(project: string, markerBytes: Buffer, sourceRoot: string): number {
  const result = validateEntityState(project, sourceRoot);
  if (!result.valid || result.entityCount === 0) throw new EntityCutoverError(`active entity state is invalid: ${result.entityCount === 0 ? "no canonical entities were published" : result.issues.map(({ message }) => message).join("; ")}`);
  const targets = loadEntityCutoverTargetsForMarker(project, markerBytes);
  const byPath = new Map(result.entities.map((entity) => [entity.relativePath, entity]));
  for (const target of targets) {
    const entity = byPath.get(target.path);
    if (!entity || entity.classification !== "valid" || (target.id && entity.id !== target.id) || (target.artifact && entity.artifact !== target.artifact)) throw new EntityCutoverError(`active entity target '${target.path}' is missing or invalid`);
  }
  return result.entityCount;
}

export function loadEntityCutoverTargetsForMarker(projectRoot: string, bytes: Buffer): EntityCutoverTargetBinding[] {
  const project = validateRealProjectRoot(projectRoot).path;
  const marker = loadYamlMapping(bytes.toString("utf8"));
  if (marker.schemaVersion !== "agentera.stateMode.v1" || marker.mode !== "entities") throw new EntityCutoverError("state marker is not valid entity authority");
  if (marker.cutover === undefined && marker.migration_id === undefined) return [];
  if (marker.cutover === "one_way_git") {
    const manifest = loadHistoricalForwardManifest(project);
    if (!manifest || manifest.marker.sha256 !== hash(bytes)) throw new EntityCutoverError("historical one-way entity marker has no matching completed manifest");
    return manifest.targets;
  }
  if (typeof marker.migration_id === "string") return loadLegacyEntityCutoverTargets(project, bytes);
  throw new EntityCutoverError("entity marker has no supported cutover binding");
}

function inspect(
  projectRoot: string,
  sourceRoot: string,
  requireGit: boolean,
  writerLockHeld = false,
  activeUpgradeLockPaths: readonly string[] = [],
): { inspection: EntityCutoverInspection; plan?: DurableEntityMigrationPlan; head?: string } {
  const project = validateRealProjectRoot(projectRoot).path;
  const marker = markerSnapshot(project);
  if (marker.kind === "file") return { inspection: { phase: "active", entityCount: validateActiveEntityCutover(project, marker.bytes, sourceRoot) } };
  if (marker.kind !== "missing") throw new EntityCutoverError(`first unresolved path '${ENTITY_MODE_MARKER}': marker path is unsafe`);

  const plan = planEntityMigration(project, sourceRoot);
  assertPlanReady(plan, sourceRoot);
  const targets = targetsForPlan(plan);
  validateExistingTargets(project, targets);

  let head: string | undefined;
  if (requireGit) {
    const allowedPaths = new Set<string>([FORWARD_MANIFEST, ENTITY_MODE_MARKER, ...targets.map(({ path: target }) => target)]);
    for (const activeLockPath of activeUpgradeLockPaths) {
      const relative = path.relative(project, path.resolve(activeLockPath));
      if (relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) allowedPaths.add(relative.split(path.sep).join("/"));
    }
    const binding = verifyEntityCutoverGitSource(project, plan, { paths: allowedPaths, prefixes: writerLockHeld ? [".agentera/.writer.lock"] : [] });
    head = binding.head;
  }
  return { inspection: { phase: "ready", entityCount: targets.length }, plan, ...(head ? { head } : {}) };
}

export function inspectEntityCutoverForUpgrade(projectRoot: string, sourceRoot: string, requireGit = false, activeUpgradeLockPaths: readonly string[] = []): EntityCutoverInspection {
  return inspect(projectRoot, sourceRoot, requireGit, false, activeUpgradeLockPaths).inspection;
}

export function prepareEntityCutoverForUpgrade(projectRoot: string, sourceRoot: string, activeUpgradeLockPaths: readonly string[] = []): PreparedEntityCutover {
  const current = inspect(projectRoot, sourceRoot, true, false, activeUpgradeLockPaths);
  if (current.inspection.phase === "active" || !current.plan || !current.head) throw new EntityCutoverError("entity authority is already active; no cutover preparation is available");
  return { project: current.plan.project, sourceRoot, head: current.head, sourceFingerprint: current.plan.source_fingerprint, previewDigest: current.plan.preview_digest };
}

function ensureDirectory(project: string, relativeDirectory: string): void {
  let current = project;
  for (const segment of relativeDirectory.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) throw new EntityCutoverError(`first unresolved path '${path.relative(project, current)}': target directory is unsafe`);
  }
}

function writeDurable(file: string, bytes: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fault(phase: string): void {
  if (process.env.NODE_ENV === "test" && process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE === phase) throw new EntityCutoverError(`simulated entity import interruption after ${phase}`);
}

function publishTargets(project: string, plan: DurableEntityMigrationPlan): void {
  for (const entry of plan.entries.slice().sort((a, b) => a.proposed_target!.path.localeCompare(b.proposed_target!.path))) {
    const target = entry.proposed_target!;
    const bytes = canonicalEntityEnvelopeBytes({ id: target.id!, artifact: entry.artifact!, record: entry.record, migrationProvenance: entry.canonical_migration_provenance });
    const observed = readProjectFileSnapshot(validateRealProjectRoot(project), target.path);
    if (observed.kind === "file") {
      if (hash(observed.bytes) !== hash(bytes)) throw new EntityCutoverError(`first unresolved path '${target.path}': existing target is not an exact converted match`);
      continue;
    }
    if (observed.kind !== "missing") throw new EntityCutoverError(`first unresolved path '${target.path}': target is unsafe`);
    ensureDirectory(project, path.relative(project, path.dirname(path.join(project, target.path))).split(path.sep).join("/"));
    try {
      writeDurable(path.join(project, target.path), bytes);
    } catch (error) {
      throw new EntityCutoverError(`first unresolved path '${target.path}': ${(error as Error).message}`);
    }
    fault("entity_published");
  }
}

function publishMarker(project: string, plan: DurableEntityMigrationPlan): void {
  const markerBytes = dumpYamlMapping({ schemaVersion: "agentera.stateMode.v1", mode: "entities", source_fingerprint: plan.source_fingerprint, preview_digest: plan.preview_digest });
  const existing = markerSnapshot(project);
  if (existing.kind === "file") {
    if (!existing.bytes.equals(Buffer.from(markerBytes))) throw new EntityCutoverError(`first unresolved path '${ENTITY_MODE_MARKER}': marker has unexpected bytes`);
    return;
  }
  if (existing.kind !== "missing") throw new EntityCutoverError(`first unresolved path '${ENTITY_MODE_MARKER}': marker path is unsafe`);
  ensureDirectory(project, ".agentera");
  const temporary = path.join(project, `.agentera/.state-mode-${randomUUID()}.tmp`);
  try {
    writeDurable(temporary, markerBytes);
    fault("before_marker");
    if (fs.existsSync(path.join(project, ENTITY_MODE_MARKER))) throw new EntityCutoverError(`first unresolved path '${ENTITY_MODE_MARKER}': marker appeared during publication`);
    fs.renameSync(temporary, path.join(project, ENTITY_MODE_MARKER));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function applyPreparedEntityCutover(prepared: PreparedEntityCutover, activeUpgradeLockPaths: readonly string[] = []): EntityCutoverResult {
  const before = inspect(prepared.project, prepared.sourceRoot, true, false, activeUpgradeLockPaths);
  if (before.inspection.phase === "active") return { status: "complete", phase: "active", idempotent: true, mutation_performed: false, entity_count: before.inspection.entityCount };
  if (!before.plan || before.head !== prepared.head || before.plan.source_fingerprint !== prepared.sourceFingerprint || before.plan.preview_digest !== prepared.previewDigest) throw new EntityCutoverError("first unresolved path '.agentera': converted input changed before apply");

  const lock = acquireWriterLock(prepared.project, 2000);
  try {
    const current = inspect(prepared.project, prepared.sourceRoot, true, true, activeUpgradeLockPaths);
    if (current.inspection.phase === "active") return { status: "complete", phase: "active", idempotent: true, mutation_performed: false, entity_count: current.inspection.entityCount };
    const plan = current.plan!;
    if (current.head !== prepared.head || plan.source_fingerprint !== prepared.sourceFingerprint || plan.preview_digest !== prepared.previewDigest) throw new EntityCutoverError("first unresolved path '.agentera': converted input changed before its first effect");
    publishTargets(prepared.project, plan);
    const validation = validateEntityState(prepared.project, prepared.sourceRoot, { kind: "migration_preview", projectRoot: prepared.project });
    if (!validation.valid || validation.entityCount !== plan.entries.length) {
      const issue = validation.issues[0];
      throw new EntityCutoverError(`first unresolved path '${issue?.path ?? ".agentera/entities"}': converted entity graph is invalid (${validation.entityCount}/${plan.entries.length})${issue ? `: ${issue.message}` : ""}`);
    }
    publishMarker(prepared.project, plan);
    const marker = markerSnapshot(prepared.project);
    if (marker.kind !== "file") throw new EntityCutoverError(`first unresolved path '${ENTITY_MODE_MARKER}': marker was not published`);
    return { status: "complete", phase: "active", idempotent: false, mutation_performed: true, entity_count: validateActiveEntityCutover(prepared.project, marker.bytes, prepared.sourceRoot) };
  } finally {
    lock.release();
  }
}

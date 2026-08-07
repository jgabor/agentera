import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { verifyEntityCutoverGitSource } from "./entityCutoverGit.js";
import { canonicalEntityEnvelope, canonicalEntityEnvelopeBytes, validateEntityState } from "./entityStorage.js";
import { planEntityMigration, validateEntityMigrationTargets, type DurableEntityMigrationPlan } from "./entityMigrationPreview.js";
import { loadLegacyEntityCutoverTargets, type EntityCutoverTargetBinding } from "./legacyEntityCutoverEvidence.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";
import { acquireWriterLock } from "./write/lock.js";
import { EntityPublicationContext } from "./entityPublicationContext.js";
import { todoReconciliationBinding } from "./todoDocsEntities.js";
import { todoCutoverPublicProjectionViolations } from "./todoReconciliationInspection.js";
import { TODO_RECONCILIATION_ACTIVATION_PATH, todoReconciliationActivationBytes } from "./todoReconciliationActivation.js";
import { inspectTodoReconciliation, publishTodoReconciliation, recoverTodoReconciliation, type TodoReconciliationTarget, type ValidatedTodoReconciliationTarget } from "./todoReconciliationTransaction.js";

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
  recovery?: boolean;
}

export interface EntityCutoverInspection {
  phase: "ready" | "active";
  entityCount: number;
  todoReconciliation: boolean;
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

function validateExistingTargets(project: string, targets: EntityCutoverTargetBinding[], mutableTodoTargets: ReadonlySet<string> = new Set()): void {
  const expected = new Map(targets.map((target) => [target.path, target]));
  for (const relative of listFiles(project, ".agentera/entities")) {
    if (!expected.has(relative)) throw new EntityCutoverError(`first unresolved path '${relative}': entity is not part of the converted v2 input`);
  }
  for (const target of targets) {
    const observed = readProjectFileSnapshot(validateRealProjectRoot(project), target.path);
    if (observed.kind === "missing") continue;
    if (observed.kind !== "file" || hash(observed.bytes) !== target.sha256) {
      if (observed.kind === "file" && mutableTodoTargets.has(target.path)) continue;
      throw new EntityCutoverError(`first unresolved path '${target.path}': existing target is not an exact converted match`);
    }
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
  if (marker.kind === "file") return { inspection: { phase: "active", entityCount: validateActiveEntityCutover(project, marker.bytes, sourceRoot), todoReconciliation: false } };
  if (marker.kind !== "missing") throw new EntityCutoverError(`first unresolved path '${ENTITY_MODE_MARKER}': marker path is unsafe`);

  const binding = todoReconciliationBinding(project, sourceRoot);
  if (inspectTodoReconciliation(project, binding).length > 0) {
    return { inspection: { phase: "ready", entityCount: 1, todoReconciliation: true } };
  }

  const plan = planEntityMigration(project, sourceRoot);
  assertPlanReady(plan, sourceRoot);
  const targets = targetsForPlan(plan);
  const mutableTodoTargets = new Set(plan.todo_reconciliation ? plan.entries.filter(({ boundary }) => boundary === "todo_item").map((entry) => entry.proposed_target!.path) : []);
  validateExistingTargets(project, targets, mutableTodoTargets);

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
  return { inspection: { phase: "ready", entityCount: targets.length, todoReconciliation: Boolean(plan.todo_reconciliation) }, plan, ...(head ? { head } : {}) };
}

export function inspectEntityCutoverForUpgrade(projectRoot: string, sourceRoot: string, requireGit = false, activeUpgradeLockPaths: readonly string[] = []): EntityCutoverInspection {
  return inspect(projectRoot, sourceRoot, requireGit, false, activeUpgradeLockPaths).inspection;
}

export function prepareEntityCutoverForUpgrade(projectRoot: string, sourceRoot: string, activeUpgradeLockPaths: readonly string[] = []): PreparedEntityCutover {
  const current = inspect(projectRoot, sourceRoot, true, false, activeUpgradeLockPaths);
  if (current.inspection.phase === "ready" && !current.plan) return { project: validateRealProjectRoot(projectRoot).path, sourceRoot, head: "", sourceFingerprint: "", previewDigest: "", recovery: true };
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
      if (hash(observed.bytes) !== hash(bytes)) {
        if (plan.todo_reconciliation && entry.boundary === "todo_item") continue;
        throw new EntityCutoverError(`first unresolved path '${target.path}': existing target is not an exact converted match`);
      }
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

function upgradePublicationContext(project: string, activeUpgradeLockPaths: readonly string[]): EntityPublicationContext {
  const lockPath = activeUpgradeLockPaths.find((candidate) => path.dirname(candidate) === path.join(project, ".agentera"));
  if (!lockPath || !fs.existsSync(lockPath)) throw new EntityCutoverError("active project upgrade lock is unavailable for recoverable TODO cutover");
  const relative = path.relative(project, lockPath).split(path.sep).join("/");
  return EntityPublicationContext.open(validateRealProjectRoot(project), relative, fs.readFileSync(lockPath));
}

function validatePendingEntityCutoverTargets(
  project: string,
  sourceRoot: string,
  binding: ReturnType<typeof todoReconciliationBinding>,
  targets: readonly ValidatedTodoReconciliationTarget[],
): void {
  const entityTargets = new Map<string, { artifact: string; boundary: string; id: string; target: ValidatedTodoReconciliationTarget }>();
  let activation: ValidatedTodoReconciliationTarget | undefined;
  let publicTarget: ValidatedTodoReconciliationTarget | undefined;
  let marker: ValidatedTodoReconciliationTarget | undefined;
  for (const target of targets) {
    const match = /^\.agentera\/entities\/([a-z][a-z0-9_]*)\/([a-z][a-z0-9_]*)\/([a-z]{10})\.yaml$/.exec(target.path);
    if (match) {
      entityTargets.set(target.path, { artifact: match[1]!, boundary: match[2]!, id: match[3]!, target });
      continue;
    }
    if (target.path === TODO_RECONCILIATION_ACTIVATION_PATH && !activation) activation = target;
    else if (target.path === binding.publicPath && !publicTarget) publicTarget = target;
    else if (target.path === ENTITY_MODE_MARKER && !marker) marker = target;
    else throw new EntityCutoverError(`first unresolved path '${target.path}': pending TODO cutover journal has an unexpected target`);
  }
  if (!activation || !publicTarget || !marker || targets.length !== entityTargets.size + 3) {
    throw new EntityCutoverError("first unresolved path '.agentera/.todo-reconciliation': pending TODO cutover journal target set is incomplete");
  }
  if (activation.before !== null || !activation.after.equals(Buffer.from(todoReconciliationActivationBytes([])))) {
    throw new EntityCutoverError(`first unresolved path '${TODO_RECONCILIATION_ACTIVATION_PATH}': pending TODO cutover activation target is invalid`);
  }
  if (publicTarget.before === null || marker.before !== null) {
    throw new EntityCutoverError("first unresolved path '.agentera/.todo-reconciliation': pending TODO cutover baselines are invalid");
  }

  const currentEntityPaths = listFiles(project, ".agentera/entities");
  const expectedEntityPaths = [...entityTargets.keys()].sort();
  if (canonicalRecordJson(currentEntityPaths) !== canonicalRecordJson(expectedEntityPaths)) {
    const unexpected = currentEntityPaths.find((target) => !entityTargets.has(target));
    const missing = expectedEntityPaths.find((target) => !currentEntityPaths.includes(target));
    const unresolved = unexpected ?? missing ?? ".agentera/entities";
    throw new EntityCutoverError(`first unresolved path '${unresolved}': canonical entity is not part of the pending journal's complete validated target set`);
  }

  for (const target of targets) {
    const observed = readProjectFileSnapshot(validateRealProjectRoot(project), target.path);
    if (observed.kind === "missing" && target.before === null) continue;
    if (observed.kind === "file" && (observed.bytes.equals(target.after) || target.before?.equals(observed.bytes))) continue;
    throw new EntityCutoverError(`first unresolved path '${target.path}': pending TODO cutover target changed outside its journal baseline`);
  }

  const finalEntities = [...entityTargets.values()].sort((left, right) => left.target.path.localeCompare(right.target.path)).map(({ artifact, boundary, id, target }) => {
    let envelope: ReturnType<typeof canonicalEntityEnvelope>;
    try {
      envelope = canonicalEntityEnvelope(target.after.toString("utf8"), { id, artifact, boundary }, sourceRoot, { kind: "migration_preview", projectRoot: project });
    } catch (error) {
      throw new EntityCutoverError(`first unresolved path '${target.path}': pending cutover final entity is invalid: ${(error as Error).message}`);
    }
    return { artifact, boundary, id, record: envelope.record };
  });
  const projectionIssue = todoCutoverPublicProjectionViolations(publicTarget.after.toString("utf8"), finalEntities.filter(({ artifact, boundary }) => artifact === "todo" && boundary === "todo_item"))[0];
  if (projectionIssue) throw new EntityCutoverError(`first unresolved path '${binding.publicPath}': ${projectionIssue}`);

  const markerValue = loadYamlMapping(marker.after.toString("utf8"));
  if (!exactKeys(markerValue, ["schemaVersion", "mode", "source_fingerprint", "preview_digest"])
    || markerValue.schemaVersion !== "agentera.stateMode.v1"
    || markerValue.mode !== "entities"
    || typeof markerValue.source_fingerprint !== "string"
    || typeof markerValue.preview_digest !== "string"
    || !SHA256.test(markerValue.source_fingerprint)
    || !SHA256.test(markerValue.preview_digest)) {
    throw new EntityCutoverError(`first unresolved path '${ENTITY_MODE_MARKER}': pending TODO cutover authority target is invalid`);
  }

  const validation = validateEntityState(project, sourceRoot, { kind: "migration_preview", projectRoot: project });
  if (!validation.valid || validation.entityCount !== entityTargets.size) {
    const issue = validation.issues[0];
    throw new EntityCutoverError(`first unresolved path '${issue?.path ?? ".agentera/entities"}': TODO cutover entity graph is invalid (${validation.entityCount}/${entityTargets.size})${issue ? `: ${issue.message}` : ""}`);
  }
}

function recoverPendingTodoCutover(project: string, sourceRoot: string, activeUpgradeLockPaths: readonly string[]): EntityCutoverResult | null {
  const binding = todoReconciliationBinding(project, sourceRoot);
  if (!inspectTodoReconciliation(project, binding).length) return null;
  const context = upgradePublicationContext(project, activeUpgradeLockPaths);
  let journalTargets: readonly ValidatedTodoReconciliationTarget[] | undefined;
  try {
    recoverTodoReconciliation(context, sourceRoot, binding, {
      beforeRecovery: (targets) => {
        validatePendingEntityCutoverTargets(project, sourceRoot, binding, targets);
        journalTargets = targets;
      },
      beforeActivation: () => {
        if (!journalTargets) throw new EntityCutoverError("pending TODO cutover targets were not validated before recovery");
        validatePendingEntityCutoverTargets(project, sourceRoot, binding, journalTargets);
      },
    });
  } finally {
    context.close();
  }
  const marker = markerSnapshot(project);
  if (marker.kind !== "file") throw new EntityCutoverError(`first unresolved path '${ENTITY_MODE_MARKER}': recovered cutover did not publish its authority marker`);
  return { status: "complete", phase: "active", idempotent: false, mutation_performed: true, entity_count: validateActiveEntityCutover(project, marker.bytes, sourceRoot) };
}

function publishTodoCutover(project: string, sourceRoot: string, plan: DurableEntityMigrationPlan, activeUpgradeLockPaths: readonly string[]): void {
  const reconciliation = plan.todo_reconciliation;
  if (!reconciliation) {
    publishMarker(project, plan);
    return;
  }
  const markerBytes = dumpYamlMapping({ schemaVersion: "agentera.stateMode.v1", mode: "entities", source_fingerprint: plan.source_fingerprint, preview_digest: plan.preview_digest });
  const targets: TodoReconciliationTarget[] = plan.entries.map((entry) => {
    const target = entry.proposed_target!;
    const before = readProjectFileSnapshot(validateRealProjectRoot(project), target.path);
    if (before.kind !== "file") throw new EntityCutoverError(`first unresolved path '${target.path}': cutover target was not published before reconciliation`);
    return { path: target.path, before: before.bytes, after: canonicalEntityEnvelopeBytes({ id: target.id, artifact: entry.artifact!, record: entry.record, migrationProvenance: entry.canonical_migration_provenance }) };
  });
  targets.push(
    { path: TODO_RECONCILIATION_ACTIVATION_PATH, before: null, after: reconciliation.activation_after },
    { path: reconciliation.public_path, before: Buffer.from(reconciliation.markdown_before_base64, "base64"), after: reconciliation.markdown_after },
    { path: ENTITY_MODE_MARKER, before: null, after: markerBytes },
  );
  const validatedTargets: ValidatedTodoReconciliationTarget[] = targets.map((target) => ({ path: target.path, before: target.before, after: Buffer.from(target.after) }));
  const context = upgradePublicationContext(project, activeUpgradeLockPaths);
  try {
    publishTodoReconciliation(context, sourceRoot, { publicPath: reconciliation.public_path, mappingSha256: reconciliation.mapping_sha256 }, targets, {
      retainUnchangedTargets: true,
      interruptAfterTarget: process.env.NODE_ENV === "test" && process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET ? Number(process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET) : undefined,
      beforeActivation: () => validatePendingEntityCutoverTargets(project, sourceRoot, { publicPath: reconciliation.public_path, mappingSha256: reconciliation.mapping_sha256 }, validatedTargets),
    });
  } finally {
    context.close();
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
  if (prepared.recovery) {
    const lock = acquireWriterLock(prepared.project, 2000);
    try {
      const recovered = recoverPendingTodoCutover(prepared.project, prepared.sourceRoot, activeUpgradeLockPaths);
      if (!recovered) throw new EntityCutoverError("prepared TODO cutover recovery journal is missing");
      return recovered;
    } finally { lock.release(); }
  }
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
    publishTodoCutover(prepared.project, prepared.sourceRoot, plan, activeUpgradeLockPaths);
    const marker = markerSnapshot(prepared.project);
    if (marker.kind !== "file") throw new EntityCutoverError(`first unresolved path '${ENTITY_MODE_MARKER}': marker was not published`);
    return { status: "complete", phase: "active", idempotent: false, mutation_performed: true, entity_count: validateActiveEntityCutover(prepared.project, marker.bytes, prepared.sourceRoot) };
  } finally {
    lock.release();
  }
}

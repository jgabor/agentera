import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import type { EntityPublicationContext, PublishedTargetIdentity } from "./entityPublicationContext.js";
import type { MigrationSourceBindingContext } from "./migrationSourceBinding.js";
import { detectStateModeBinding } from "./stateMode.js";
import { authority, canonicalEntityEnvelopeAgainstModel, discoverFile, type EntityAuthority, type RelationshipDefinition } from "./entityValidation.js";
export { canonicalEntityEnvelope, canonicalEntityPath, canonicalEntityRecordViolations, entityArtifactValues, entityBoundariesForArtifact, entityExactGetMaxBytes, entityForbiddenCanonicalAliases, entityPreservedAggregateCollections } from "./entityValidation.js";
import { planLineageIssues } from "./planLineageValidation.js";
import { applyGlossaryCaveatLifecycleValidation } from "./progressGlossaryCaveat.js";
import { withEntityWriterLock } from "./entityWriterLock.js";
export { withEntityWriterLock };
const MAX_DIAGNOSTICS = 100;
export type EntityClassification = "valid" | "duplicate" | "malformed" | "unsafe";
export interface EntityDiagnostic {
  code: "duplicate_id" | "malformed_entity" | "unsafe_path" | "invalid_artifact" | "conflicting_ownership" | "unresolved_relation";
  path: string;
  message: string;
  recovery: string;
  id?: string;
  artifact?: string;
  boundary?: string;
  relation?: string;
  targetId?: string;
}
export interface DiscoveredEntity {
  id: string | null;
  artifact: string | null;
  boundary: string | null;
  record: JsonObject | null;
  migrationProvenance: JsonObject | null;
  discoveredBytes: Buffer | null;
  path: string;
  relativePath: string;
  classification: EntityClassification;
}
export function exactDiscoveredEntityBytes(entity: DiscoveredEntity): Buffer {
  if (entity.discoveredBytes === null) throw new Error(`entity '${entity.relativePath}' has no exact discovery-byte baseline`);
  return entity.discoveredBytes;
}
export interface EntityDiscoveryResult {
  origin: { projectRoot: string; sourceRoot: string };
  entities: DiscoveredEntity[];
  issues: EntityDiagnostic[];
  validArtifactValues: string[];
}
export interface EntityValidationResult extends EntityDiscoveryResult {
  valid: boolean;
  entityCount: number;
  omittedIssueCount: number;
}

export interface CanonicalEntityTarget {
  sourceIdentity: string;
  path: string;
  id: string;
  artifact: string;
  boundary: string;
  record: JsonObject;
  migrationProvenance?: JsonObject;
}

export interface CanonicalEntityTargetDiagnostic {
  sourceIdentity: string;
  path: string;
  message: string;
}

export function canonicalEntityEnvelopeBytes(target: Pick<CanonicalEntityTarget, "id" | "artifact" | "record" | "migrationProvenance">): string {
  return dumpYamlMapping({ id: target.id, artifact: target.artifact, ...(target.migrationProvenance ? { migration_provenance: target.migrationProvenance } : {}), record: target.record });
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function relative(projectRoot: string, candidate: string): string {
  return path.relative(path.resolve(projectRoot), candidate).split(path.sep).join("/") || ".";
}

function recovery(projectRoot: string, action: string): string {
  return `${action}; rerun agentera check validate state --cwd ${JSON.stringify(path.resolve(projectRoot))}`;
}

function diagnosticSort(left: EntityDiagnostic, right: EntityDiagnostic): number {
  return left.path.localeCompare(right.path) || left.code.localeCompare(right.code) || (left.relation ?? "").localeCompare(right.relation ?? "");
}

function noSymlinkPrefix(projectRoot: string, candidate: string): string | null {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(candidate);
  const rel = path.relative(root, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return candidate;
  let cursor = root;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

function unsafeIssue(projectRoot: string, candidate: string): EntityDiagnostic {
  const entityPath = relative(projectRoot, candidate);
  return { code: "unsafe_path", path: entityPath, message: `entity path '${entityPath}' is a symbolic link and was not traversed`, recovery: recovery(projectRoot, `remove the symbolic link '${entityPath}' and restore a project-local directory or file`) };
}

function unsafeEntity(projectRoot: string, candidate: string): DiscoveredEntity {
  return { id: null, artifact: null, boundary: null, record: null, migrationProvenance: null, discoveredBytes: null, path: candidate, relativePath: relative(projectRoot, candidate), classification: "unsafe" };
}

function listDirectories(directory: string): fs.Dirent[] {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
}

export function discoverEntities(projectRoot: string, sourceRoot?: string, sourceBinding: MigrationSourceBindingContext = { kind: "project", projectRoot }): EntityDiscoveryResult {
  const root = path.resolve(projectRoot);
  const resolvedSourceRoot = path.resolve(sourceRoot ?? resolveSourceRoot());
  const origin = { projectRoot: root, sourceRoot: resolvedSourceRoot };
  const model = authority(resolvedSourceRoot);
  const storageRoot = path.join(root, model.entityRoot);
  const entities: DiscoveredEntity[] = [];
  const issues: EntityDiagnostic[] = [];
  const unsafePrefix = noSymlinkPrefix(root, storageRoot);
  if (unsafePrefix) return { origin, entities: [unsafeEntity(root, unsafePrefix)], issues: [unsafeIssue(root, unsafePrefix)], validArtifactValues: model.artifacts };
  if (!fs.existsSync(storageRoot)) return { origin, entities, issues, validArtifactValues: model.artifacts };
  if (!fs.statSync(storageRoot).isDirectory()) {
    issues.push({ code: "malformed_entity", path: relative(root, storageRoot), message: `entity root '${relative(root, storageRoot)}' is not a directory`, recovery: recovery(root, `replace '${relative(root, storageRoot)}' with a directory`) });
    return { origin, entities, issues, validArtifactValues: model.artifacts };
  }

  for (const artifactEntry of listDirectories(storageRoot)) {
    const artifactPath = path.join(storageRoot, artifactEntry.name);
    if (artifactEntry.isSymbolicLink()) {
      entities.push(unsafeEntity(root, artifactPath));
      issues.push(unsafeIssue(root, artifactPath));
      continue;
    }
    if (!artifactEntry.isDirectory()) {
      issues.push({ code: "malformed_entity", path: relative(root, artifactPath), message: `unexpected file '${relative(root, artifactPath)}' in entity root`, recovery: recovery(root, `remove '${relative(root, artifactPath)}' or place it under an artifact/boundary directory`) });
      continue;
    }
    for (const boundaryEntry of listDirectories(artifactPath)) {
      const boundaryPath = path.join(artifactPath, boundaryEntry.name);
      if (boundaryEntry.isSymbolicLink()) {
        entities.push(unsafeEntity(root, boundaryPath));
        issues.push(unsafeIssue(root, boundaryPath));
        continue;
      }
      if (!boundaryEntry.isDirectory()) {
        issues.push({ code: "malformed_entity", path: relative(root, boundaryPath), message: `unexpected file '${relative(root, boundaryPath)}' in artifact entity root`, recovery: recovery(root, `remove '${relative(root, boundaryPath)}' or place it under a declared boundary directory`) });
        continue;
      }
      for (const fileEntry of listDirectories(boundaryPath)) {
        const file = path.join(boundaryPath, fileEntry.name);
        if (fileEntry.isSymbolicLink()) {
          entities.push(unsafeEntity(root, file));
          issues.push(unsafeIssue(root, file));
          continue;
        }
        if (!fileEntry.isFile() || path.extname(fileEntry.name) !== ".yaml") {
          issues.push({ code: "malformed_entity", path: relative(root, file), message: `entity path '${relative(root, file)}' is not a canonical YAML file`, recovery: recovery(root, `remove '${relative(root, file)}' or replace it with <ten-lowercase-letter-id>.yaml`) });
          continue;
        }
        entities.push(discoverFile(root, file, artifactEntry.name, boundaryEntry.name, model, issues, resolvedSourceRoot, sourceBinding));
      }
    }
  }

  const byId = new Map<string, DiscoveredEntity[]>();
  for (const entity of entities) {
    if (entity.id && model.pattern.test(entity.id)) byId.set(entity.id, [...(byId.get(entity.id) ?? []), entity]);
  }
  for (const [id, matches] of byId) {
    if (matches.length < 2) continue;
    for (const entity of matches) {
      entity.classification = "duplicate";
      issues.push({
        code: "duplicate_id",
        path: entity.relativePath,
        id,
        artifact: entity.artifact ?? undefined,
        boundary: entity.boundary ?? undefined,
        message: `entity ID '${id}' appears ${matches.length} times across project state`,
        recovery: recovery(root, `assign a new generated ID to all but one '${id}' entity and rewrite every declared relationship to those entities`),
      });
    }
  }
  applyGlossaryCaveatLifecycleValidation(root, entities, issues, model.glossaryCaveat);
  const rank: Record<EntityClassification, number> = { duplicate: 0, malformed: 1, unsafe: 2, valid: 3 };
  entities.sort((left, right) => rank[left.classification] - rank[right.classification] || left.relativePath.localeCompare(right.relativePath));
  issues.sort(diagnosticSort);
  return { origin, entities, issues, validArtifactValues: model.artifacts };
}

export function assertEntityDiscoveryOrigin(projectRoot: string, sourceRoot: string | undefined, discovery: EntityDiscoveryResult): void {
  const expected = { projectRoot: path.resolve(projectRoot), sourceRoot: path.resolve(sourceRoot ?? resolveSourceRoot()) };
  const actualProjectRoot = discovery.origin?.projectRoot ?? "<missing>";
  const actualSourceRoot = discovery.origin?.sourceRoot ?? "<missing>";
  if (actualProjectRoot === expected.projectRoot && actualSourceRoot === expected.sourceRoot) return;
  throw new Error(
    `supplied entity discovery origin does not match this request (expected project '${expected.projectRoot}' and source authority '${expected.sourceRoot}', received project '${actualProjectRoot}' and source authority '${actualSourceRoot}'); call discoverEntities with this request's project and source roots, then retry`,
  );
}
function relationTargets(entity: DiscoveredEntity, relation: RelationshipDefinition): string[] | null {
  const value = entity.record?.[relation.field];
  if (relation.cardinality === "exactly_one" || relation.cardinality === "zero_or_one") return typeof value === "string" ? [value] : relation.cardinality === "zero_or_one" && (value === undefined || value === null) ? [] : null;
  if (value === undefined || value === null) return [];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}
export function validateEntityDiscovery(projectRoot: string, sourceRoot: string | undefined, discovery: EntityDiscoveryResult, boundIssues = true): EntityValidationResult {
  assertEntityDiscoveryOrigin(projectRoot, sourceRoot, discovery);
  const model = authority(sourceRoot);
  const issues = [...discovery.issues];
  const byId = new Map<string, DiscoveredEntity[]>();
  for (const entity of discovery.entities) {
    if (entity.id) byId.set(entity.id, [...(byId.get(entity.id) ?? []), entity]);
  }
  for (const entity of discovery.entities) {
    if (!entity.boundary || !entity.record) continue;
    for (const relation of model.relationships.filter(({ source }) => source === entity.boundary)) {
      const targets = relationTargets(entity, relation);
      const invalidTargets =
        targets === null
          ? [String(entity.record[relation.field] ?? "<missing>")]
          : targets.filter((targetId) => {
              const matches = byId.get(targetId) ?? [];
              if (matches.length !== 1 || matches[0].boundary !== relation.target) return true;
              if (relation.cardinality === "zero_or_many_same_plan") return matches[0].record?.plan !== entity.record?.plan;
              return false;
            });
      for (const targetId of invalidTargets) {
        issues.push({
          code: "unresolved_relation",
          path: entity.relativePath,
          id: entity.id ?? undefined,
          artifact: entity.artifact ?? undefined,
          boundary: entity.boundary,
          relation: relation.field,
          targetId,
          message: `entity '${entity.id}' relation '${relation.field}' target '${targetId}' does not resolve to exactly one '${relation.target}' entity${relation.cardinality === "zero_or_many_same_plan" ? " in the same plan" : ""}`,
          recovery: recovery(projectRoot, `set record.${relation.field} in '${entity.relativePath}' to ${relation.cardinality === "exactly_one" ? "one existing" : "only existing same-plan"} '${relation.target}' ID`),
        });
      }
    }
  }
  const planTasks = discovery.entities.filter((entity) => entity.boundary === "plan_task" && entity.classification === "valid" && entity.id && entity.record);
  const tasksByPlan = new Map<string, DiscoveredEntity[]>();
  for (const task of planTasks) {
    const planId = typeof task.record?.plan === "string" ? task.record.plan : "";
    tasksByPlan.set(planId, [...(tasksByPlan.get(planId) ?? []), task]);
  }
  for (const [planId, tasks] of tasksByPlan) {
    const byTaskId = new Map(tasks.map((task) => [task.id!, task]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (task: DiscoveredEntity): boolean => {
      if (visiting.has(task.id!)) return true;
      if (visited.has(task.id!)) return false;
      visiting.add(task.id!);
      const cyclic = (Array.isArray(task.record?.depends_on) ? task.record.depends_on : []).some((id) => typeof id === "string" && byTaskId.has(id) && visit(byTaskId.get(id)!));
      visiting.delete(task.id!);
      visited.add(task.id!);
      return cyclic;
    };
    for (const task of tasks)
      if (visit(task))
        issues.push({
          code: "unresolved_relation",
          path: task.relativePath,
          id: task.id!,
          artifact: task.artifact ?? undefined,
          boundary: task.boundary ?? undefined,
          relation: "depends_on",
          message: `plan '${planId}' task dependency graph contains a cycle involving '${task.id}'`,
          recovery: recovery(projectRoot, `remove one record.depends_on edge in plan '${planId}' so the task graph is acyclic`),
        });
    for (const task of tasks.filter((candidate) => candidate.record?.status === "superseded")) {
      for (const replacementId of task.record!.superseded_by as string[]) {
        const replacement = byTaskId.get(replacementId);
        if (replacementId === task.id || replacement?.record?.status !== "complete")
          issues.push({
            code: "unresolved_relation",
            path: task.relativePath,
            id: task.id!,
            artifact: task.artifact ?? undefined,
            boundary: task.boundary ?? undefined,
            relation: "superseded_by",
            targetId: replacementId,
            message: replacementId === task.id ? `superseded task '${task.id}' cannot name itself as a replacement` : `superseded task '${task.id}' replacement '${replacementId}' must be complete in plan '${planId}'`,
            recovery: recovery(projectRoot, `set record.superseded_by in '${task.relativePath}' to completed task IDs from plan '${planId}'`),
          });
      }
    }
  }
  for (const plan of discovery.entities.filter((entity) => entity.boundary === "plan" && entity.classification === "valid" && entity.id && entity.record)) {
    const header = mapping(plan.record!.header) ? (plan.record!.header as JsonObject) : {};
    if (header.status === "complete") {
      const incomplete = (tasksByPlan.get(plan.id!) ?? []).filter((task) => !["complete", "superseded"].includes(String(task.record?.status)));
      if (incomplete.length)
        issues.push({
          code: "conflicting_ownership",
          path: plan.relativePath,
          id: plan.id!,
          artifact: plan.artifact ?? undefined,
          boundary: plan.boundary ?? undefined,
          message: `complete plan '${plan.id}' owns ${incomplete.length} incomplete task entities`,
          recovery: recovery(projectRoot, `complete every task related to plan '${plan.id}' or restore the plan lifecycle to open`),
        });
    }
  }
  const canonicalPlans = discovery.entities.filter((entity) => entity.boundary === "plan" && entity.classification === "valid" && entity.id && entity.record);
  issues.push(...planLineageIssues(canonicalPlans, (action) => recovery(projectRoot, action)));
  for (const definition of model.entities) {
    if (!definition.ownership || definition.ownership.cardinality !== "zero_or_one") continue;
    const claims = new Map<string, DiscoveredEntity[]>();
    for (const entity of discovery.entities.filter(({ boundary, classification }) => boundary === definition.boundary && classification === "valid")) {
      const values = definition.ownership.fields.map((field) => entity.record?.[field]);
      if (values.some((value) => value === undefined)) continue;
      const key = canonicalRecordJson(values);
      claims.set(key, [...(claims.get(key) ?? []), entity]);
    }
    for (const claimants of claims.values()) {
      if (claimants.length < 2) continue;
      for (const entity of claimants)
        issues.push({
          code: "conflicting_ownership",
          path: entity.relativePath,
          id: entity.id ?? undefined,
          artifact: entity.artifact ?? undefined,
          boundary: entity.boundary ?? undefined,
          message: `entity '${entity.relativePath}' shares the authority-owned ${definition.ownership.fields.join("+")} claim with ${claimants.length - 1} other '${definition.boundary}' entity`,
          recovery: recovery(projectRoot, `preserve every claimant and resolve the divergent '${definition.boundary}' ownership explicitly`),
        });
    }
  }
  for (const definition of model.entities) {
    if (!definition.baseline || definition.baseline.cardinality !== "exactly_one_when_experiments_exist") continue;
    const byOwner = new Map<string, DiscoveredEntity[]>();
    for (const entity of discovery.entities.filter(({ boundary, classification, record }) => boundary === definition.boundary && classification === "valid" && record)) {
      const owner = String(entity.record!.objective ?? "");
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), entity]);
    }
    for (const [owner, entities] of byOwner) {
      const baselines = entities.filter((entity) => entity.record?.[definition.baseline!.field] === definition.baseline!.value);
      if (baselines.length === 1) continue;
      for (const entity of entities)
        issues.push({
          code: "conflicting_ownership",
          path: entity.relativePath,
          id: entity.id ?? undefined,
          artifact: entity.artifact ?? undefined,
          boundary: entity.boundary ?? undefined,
          message: `objective '${owner}' owns ${baselines.length} '${definition.baseline.value}' experiments; exactly one is required`,
          recovery: recovery(projectRoot, baselines.length ? `preserve one immutable baseline for objective '${owner}' and resolve competing ownership` : `restore the missing immutable baseline for objective '${owner}'`),
        });
    }
  }
  issues.sort(diagnosticSort);
  const omittedIssueCount = Math.max(0, issues.length - MAX_DIAGNOSTICS);
  const boundedIssues = boundIssues ? issues.slice(0, MAX_DIAGNOSTICS) : issues;
  return { ...discovery, issues: boundedIssues, valid: issues.length === 0, entityCount: discovery.entities.length, omittedIssueCount };
}

export function validateEntityState(projectRoot: string, sourceRoot?: string, sourceBinding?: MigrationSourceBindingContext): EntityValidationResult {
  return validateEntityDiscovery(projectRoot, sourceRoot, discoverEntities(projectRoot, sourceRoot, sourceBinding));
}

/** Validate the exact canonical envelopes and graph proposed by a migration without publishing them. */
export function validateCanonicalEntityTargets(projectRoot: string, targets: CanonicalEntityTarget[], sourceRoot?: string): CanonicalEntityTargetDiagnostic[] {
  const model = authority(sourceRoot);
  const entities: DiscoveredEntity[] = [];
  const issues: EntityDiagnostic[] = [];
  const sourceByPath = new Map(targets.map((target) => [target.path, target.sourceIdentity]));
  const targetsById = new Map<string, CanonicalEntityTarget[]>();
  for (const target of targets) targetsById.set(target.id, [...(targetsById.get(target.id) ?? []), target]);
  for (const target of targets) {
    const expectedPath = path.posix.join(model.entityRoot, target.artifact, target.boundary, `${target.id}.yaml`);
    let record: JsonObject | null = null;
    let discoveredBytes: Buffer | null = null;
    let message: string | null = target.path === expectedPath ? null : `canonical target path '${target.path}' must be '${expectedPath}'`;
    if (!message) {
      try {
        const bytes = canonicalEntityEnvelopeBytes(target);
        discoveredBytes = Buffer.from(bytes);
        record = canonicalEntityEnvelopeAgainstModel(bytes, target, model, sourceRoot, { kind: "migration_preview", projectRoot }).record;
      } catch (error) {
        message = (error as Error).message;
      }
    }
    if (message) issues.push({ code: "malformed_entity", path: target.path, id: target.id, artifact: target.artifact, boundary: target.boundary, message, recovery: recovery(projectRoot, `repair legacy source '${target.sourceIdentity}' so its canonical target satisfies the authority-backed boundary validator`) });
    entities.push({ id: target.id, artifact: target.artifact, boundary: target.boundary, record, migrationProvenance: target.migrationProvenance ?? null, discoveredBytes, path: path.join(projectRoot, target.path), relativePath: target.path, classification: message ? "malformed" : "valid" });
  }
  for (const duplicates of targetsById.values()) {
    if (duplicates.length < 2) continue;
    for (const target of duplicates)
      issues.push({
        code: "duplicate_id",
        path: target.path,
        id: target.id,
        artifact: target.artifact,
        boundary: target.boundary,
        message: `entity ID '${target.id}' appears ${duplicates.length} times across proposed canonical targets`,
        recovery: recovery(projectRoot, `repair migration identity allocation for '${target.sourceIdentity}'`),
      });
  }
  const validation = validateEntityDiscovery(projectRoot, sourceRoot, { origin: { projectRoot: path.resolve(projectRoot), sourceRoot: path.resolve(sourceRoot ?? resolveSourceRoot()) }, entities, issues, validArtifactValues: model.artifacts }, false);
  return validation.issues.map((issue) => ({ sourceIdentity: sourceByPath.get(issue.path) ?? issue.id ?? issue.path, path: issue.path, message: issue.message }));
}

function generatedId(model: EntityAuthority): string {
  let id = "";
  for (let index = 0; index < model.length; index += 1) id += model.alphabet[randomInt(model.alphabet.length)];
  return id;
}

export function allocateEntityId(projectRoot: string, candidate?: () => string, sourceRoot?: string): string {
  const model = authority(sourceRoot);
  const existing = new Set(
    discoverEntities(projectRoot, sourceRoot)
      .entities.map(({ id }) => id)
      .filter((id): id is string => id !== null),
  );
  for (let attempt = 0; attempt < 1024; attempt += 1) {
    const id = candidate ? candidate() : generatedId(model);
    if (!model.pattern.test(id)) throw new Error(`entity ID candidate '${id}' must match ${model.pattern.source}`);
    if (!existing.has(id)) return id;
  }
  throw new Error("could not allocate a unique entity ID after 1024 attempts; run agentera check validate state and retry");
}

export interface PublishEntityRequest {
  projectRoot: string;
  artifact: string;
  boundary: string;
  id: string;
  record: JsonObject;
  sourceRoot?: string;
  publicationContext?: EntityPublicationContext;
}

export interface PublishEntityResult {
  id: string;
  artifact: string;
  boundary: string;
  path: string;
  replay: boolean;
  publishedIdentity?: PublishedTargetIdentity;
  previousBytes?: string;
}

export interface ReplaceEntityRequest extends PublishEntityRequest {
  expectedRecord: JsonObject;
  expectedBytes: Buffer;
  migrationProvenance?: JsonObject | null;
}

function publishEntityLocked(request: PublishEntityRequest, model: EntityAuthority, context: EntityPublicationContext): PublishEntityResult {
  context.assertValid();
  if (!model.pattern.test(request.id)) throw new Error(`entity ID '${request.id}' must match ${model.pattern.source}`);
  const owner = model.byBoundary.get(request.boundary);
  if (!owner) throw new Error(`unknown entity boundary '${request.boundary}'`);
  if (owner.artifact !== request.artifact) throw new Error(`boundary '${request.boundary}' is owned by artifact '${owner.artifact}', not '${request.artifact}'`);
  if (!owner.independentlyMutable) throw new Error(`boundary '${request.boundary}' is immutable migration-only state and cannot be published by an ordinary entity writer`);
  if (!mapping(request.record)) throw new Error("entity record must be a mapping");
  const root = context.pinnedPath();
  const relativeTarget = path.join(model.entityRoot, request.artifact, request.boundary, `${request.id}.yaml`);
  const target = path.join(root, relativeTarget);
  const publicTarget = path.join(path.resolve(request.projectRoot), relativeTarget);
  const symlink = noSymlinkPrefix(root, target);
  if (symlink) throw new Error(`entity path contains symbolic link '${relative(root, symlink)}'; remove the symbolic link and retry`);
  const envelope = { id: request.id, artifact: request.artifact, record: request.record };
  const logicalContent = canonicalRecordJson(envelope);
  const bytes = dumpYamlMapping(envelope);
  const matches = discoverEntities(root, request.sourceRoot).entities.filter(({ id }) => id === request.id);
  const exact = matches.find(({ path: existing }) => existing === target);
  if (exact && matches.length === 1) {
    if (exact.record !== null && canonicalRecordJson({ id: exact.id, artifact: exact.artifact, record: exact.record }) === logicalContent) {
      context.assertValid();
      return { id: request.id, artifact: request.artifact, boundary: request.boundary, path: publicTarget, replay: true };
    }
    throw new Error(`divergent content for existing entity ID '${request.id}' at '${exact.relativePath}'; keep the existing ID unchanged or allocate a new ID`);
  }
  if (matches.length > 0) throw new Error(`entity ID '${request.id}' already exists at '${matches[0].relativePath}' owned by boundary '${matches[0].boundary}'; allocate a new project-wide ID`);
  const publishedIdentity = context.publishImmutable(relativeTarget, bytes);
  if (!publishedIdentity) {
    const existing = loadYamlMapping(fs.readFileSync(target, "utf8"));
    context.assertValid();
    if (canonicalRecordJson(existing) === logicalContent) {
      return { id: request.id, artifact: request.artifact, boundary: request.boundary, path: publicTarget, replay: true };
    }
    throw new Error(`divergent content for existing entity ID '${request.id}' at '${relative(root, target)}'; keep the existing ID unchanged or allocate a new ID`);
  }
  return { id: request.id, artifact: request.artifact, boundary: request.boundary, path: publicTarget, replay: false, publishedIdentity };
}

export function publishEntityUnderLock(request: PublishEntityRequest): PublishEntityResult {
  if (!request.publicationContext) throw new Error("locked entity publication requires a publication context");
  return publishEntityLocked(request, authority(request.sourceRoot), request.publicationContext);
}

export function replaceEntityUnderLock(request: ReplaceEntityRequest): PublishEntityResult {
  const context = request.publicationContext;
  if (!context) throw new Error("locked entity replacement requires a publication context");
  const model = authority(request.sourceRoot);
  context.assertValid();
  const owner = model.byBoundary.get(request.boundary);
  if (!owner || owner.artifact !== request.artifact) throw new Error(`unknown '${request.artifact}' entity boundary '${request.boundary}'`);
  if (!owner.independentlyMutable) throw new Error(`boundary '${request.boundary}' is immutable migration-only state and cannot be replaced by an ordinary entity writer`);
  const relativeTarget = path.join(model.entityRoot, request.artifact, request.boundary, `${request.id}.yaml`);
  if (canonicalRecordJson(request.expectedRecord) === canonicalRecordJson(request.record)) return { id: request.id, artifact: request.artifact, boundary: request.boundary, path: path.join(path.resolve(request.projectRoot), relativeTarget), replay: true };
  const replacement = context.replaceExisting(relativeTarget, request.expectedBytes, canonicalEntityEnvelopeBytes({ id: request.id, artifact: request.artifact, record: request.record, migrationProvenance: request.migrationProvenance ?? undefined }), model.maxEntityBytes);
  return { id: request.id, artifact: request.artifact, boundary: request.boundary, path: path.join(path.resolve(request.projectRoot), relativeTarget), replay: false, publishedIdentity: replacement.publishedIdentity, previousBytes: replacement.previousBytes };
}

function withPublicationContext<T>(request: Pick<PublishEntityRequest, "projectRoot" | "sourceRoot" | "publicationContext">, run: (context: EntityPublicationContext) => T): T {
  if (request.publicationContext) {
    if (request.publicationContext.projectRoot !== path.resolve(request.projectRoot)) {
      throw new Error("entity publication context belongs to a different project root");
    }
    return run(request.publicationContext);
  }
  const binding = detectStateModeBinding(request.projectRoot, request.sourceRoot);
  if (binding.mode !== "entities") {
    throw new Error("entity publication requires the durable entity-mode marker; legacy mode remains authoritative");
  }
  try {
    return run(binding.publicationContext);
  } finally {
    binding.publicationContext.close();
  }
}

function publishWithContext(request: PublishEntityRequest, model: EntityAuthority, context: EntityPublicationContext): PublishEntityResult {
  try {
    return withEntityWriterLock(context, () => publishEntityLocked(request, model, context));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("writer lock timeout at ")) {
      const duplicate = discoverEntities(context.pinnedPath(), request.sourceRoot).entities.find(({ id, artifact, boundary }) => id === request.id && (artifact !== request.artifact || boundary !== request.boundary));
      if (duplicate) {
        throw new Error(`entity ID '${request.id}' already exists at '${duplicate.relativePath}' owned by boundary '${duplicate.boundary}'; allocate a new project-wide ID`);
      }
    }
    throw error;
  }
}

export function publishEntity(request: PublishEntityRequest): PublishEntityResult {
  const model = authority(request.sourceRoot);
  return withPublicationContext(request, (context) => publishWithContext(request, model, context));
}

export function replaceEntity(request: ReplaceEntityRequest): PublishEntityResult {
  return withPublicationContext(request, (context) => {
    return withEntityWriterLock(context, () => replaceEntityUnderLock({ ...request, publicationContext: context }));
  });
}

export function allocateAndPublishEntity(request: Omit<PublishEntityRequest, "id">, candidate?: () => string): PublishEntityResult {
  const model = authority(request.sourceRoot);
  return withPublicationContext(request, (context) => {
    return withEntityWriterLock(context, () => {
      context.assertValid();
      const existing = new Set(
        discoverEntities(context.pinnedPath(), request.sourceRoot)
          .entities.map(({ id }) => id)
          .filter((id): id is string => id !== null),
      );
      for (let attempt = 0; attempt < 1024; attempt += 1) {
        const id = candidate ? candidate() : generatedId(model);
        if (!model.pattern.test(id)) throw new Error(`entity ID candidate '${id}' must match ${model.pattern.source}`);
        if (existing.has(id)) continue;
        return publishEntityLocked({ ...request, id }, model, context);
      }
      throw new Error("could not allocate a unique entity ID after 1024 attempts; run agentera check validate state and retry");
    });
  });
}

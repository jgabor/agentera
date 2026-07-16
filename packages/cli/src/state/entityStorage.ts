import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { publishImmutableFile } from "./archivePublication.js";

const MAX_DIAGNOSTICS = 100;

interface EntityDefinition {
  boundary: string;
  artifact: string;
}

interface RelationshipDefinition {
  source: string;
  field: string;
  target: string;
  cardinality: string;
}

interface EntityAuthority {
  entityRoot: string;
  alphabet: string;
  length: number;
  pattern: RegExp;
  entities: EntityDefinition[];
  relationships: RelationshipDefinition[];
  artifacts: string[];
  byBoundary: Map<string, EntityDefinition>;
}

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
  path: string;
  relativePath: string;
  classification: EntityClassification;
}

export interface EntityDiscoveryResult {
  entities: DiscoveredEntity[];
  issues: EntityDiagnostic[];
  validArtifactValues: string[];
}

export interface EntityValidationResult extends EntityDiscoveryResult {
  valid: boolean;
  entityCount: number;
  omittedIssueCount: number;
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authority(sourceRoot = resolveSourceRoot()): EntityAuthority {
  const authorityPath = path.join(sourceRoot, "references", "artifacts", "state-storage-authority.yaml");
  const document = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  const target = document.entity_target;
  if (!mapping(target) || !mapping(target.identity) || !mapping(target.storage_boundary) || !Array.isArray(target.entities) || !mapping(target.relationships)) {
    throw new Error(`invalid entity authority '${authorityPath}'`);
  }
  const entities = target.entities.map((value): EntityDefinition => {
    if (!mapping(value) || typeof value.boundary !== "string" || typeof value.artifact !== "string") {
      throw new Error(`invalid entity declaration in '${authorityPath}'`);
    }
    return { boundary: value.boundary, artifact: value.artifact };
  });
  const declarations = target.relationships.declarations;
  if (!Array.isArray(declarations)) throw new Error(`invalid relationship declarations in '${authorityPath}'`);
  const relationships = declarations.map((value): RelationshipDefinition => {
    if (!mapping(value) || typeof value.source !== "string" || typeof value.field !== "string" || typeof value.target !== "string" || typeof value.cardinality !== "string") {
      throw new Error(`invalid relationship declaration in '${authorityPath}'`);
    }
    return { source: value.source, field: value.field, target: value.target, cardinality: value.cardinality };
  });
  const alphabet = String(target.identity.alphabet);
  const length = Number(target.identity.length);
  const acceptedPattern = String(target.identity.accepted_pattern);
  const sharedPrimitives = target.storage_boundary.shared_primitives;
  if (!mapping(sharedPrimitives) || typeof sharedPrimitives.canonical_root !== "string") {
    throw new Error(`invalid shared entity storage declaration in '${authorityPath}'`);
  }
  const entityRoot = sharedPrimitives.canonical_root;
  if (path.isAbsolute(entityRoot) || entityRoot.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new Error(`unsafe shared entity storage root '${entityRoot}' in '${authorityPath}'`);
  }
  return {
    entityRoot,
    alphabet,
    length,
    pattern: new RegExp(acceptedPattern),
    entities,
    relationships,
    artifacts: [...new Set(entities.map(({ artifact }) => artifact))].sort(),
    byBoundary: new Map(entities.map((entity) => [entity.boundary, entity])),
  };
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
  return {
    code: "unsafe_path",
    path: entityPath,
    message: `entity path '${entityPath}' is a symbolic link and was not traversed`,
    recovery: recovery(projectRoot, `remove the symbolic link '${entityPath}' and restore a project-local directory or file`),
  };
}

function unsafeEntity(projectRoot: string, candidate: string): DiscoveredEntity {
  return {
    id: null,
    artifact: null,
    boundary: null,
    record: null,
    path: candidate,
    relativePath: relative(projectRoot, candidate),
    classification: "unsafe",
  };
}

function listDirectories(directory: string): fs.Dirent[] {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
}

function discoverFile(
  projectRoot: string,
  file: string,
  pathArtifact: string,
  boundary: string,
  model: EntityAuthority,
  issues: EntityDiagnostic[],
): DiscoveredEntity {
  const relativePath = relative(projectRoot, file);
  const filenameId = path.basename(file, path.extname(file));
  let document: Record<string, unknown> | null = null;
  try {
    document = loadYamlMapping(fs.readFileSync(file, "utf8"));
  } catch (error) {
    issues.push({
      code: "malformed_entity",
      path: relativePath,
      message: `entity '${relativePath}' is not a YAML mapping: ${(error as Error).message}`,
      recovery: recovery(projectRoot, `replace '${relativePath}' with a valid id/artifact/record entity envelope or remove it`),
    });
  }
  const id = typeof document?.id === "string" ? document.id : filenameId;
  const artifact = typeof document?.artifact === "string" ? document.artifact : pathArtifact;
  const record = mapping(document?.record) ? document.record as JsonObject : null;
  let malformed = document === null;
  if (
    !model.pattern.test(filenameId)
    || id !== filenameId
    || typeof document?.id !== "string"
    || typeof document?.artifact !== "string"
    || record === null
    || document === null
    || Object.keys(document).some((key) => !["id", "artifact", "record"].includes(key))
  ) {
    malformed = true;
    if (document !== null) {
      issues.push({
        code: "malformed_entity",
        path: relativePath,
        id,
        artifact,
        boundary,
        message: `entity '${relativePath}' must contain only id, artifact, and record; id and filename must match ${model.pattern.source}`,
        recovery: recovery(projectRoot, `rename and rewrite '${relativePath}' as <ten-lowercase-letter-id>.yaml with matching id, artifact, and mapping record fields`),
      });
    }
  }
  if (!model.artifacts.includes(pathArtifact) || !model.artifacts.includes(artifact)) {
    malformed = true;
    issues.push({
      code: "invalid_artifact",
      path: relativePath,
      id,
      artifact,
      boundary,
      message: `entity '${relativePath}' declares unsupported artifact '${artifact}' under '${pathArtifact}'`,
      recovery: recovery(projectRoot, `move or rewrite '${relativePath}'; valid artifact values: ${model.artifacts.join(", ")}`),
    });
  } else {
    const owner = model.byBoundary.get(boundary);
    if (!owner || owner.artifact !== pathArtifact || artifact !== pathArtifact) {
      malformed = true;
      issues.push({
        code: "conflicting_ownership",
        path: relativePath,
        id,
        artifact,
        boundary,
        message: `entity '${relativePath}' has conflicting ownership: path artifact '${pathArtifact}', boundary '${boundary}', envelope artifact '${artifact}'`,
        recovery: recovery(projectRoot, owner
          ? `move '${relativePath}' under .agentera/entities/${owner.artifact}/${boundary}/ and set artifact to '${owner.artifact}'`
          : `move or rewrite '${relativePath}' using a boundary declared by the state storage authority`),
      });
    }
  }
  return { id, artifact, boundary, record, path: file, relativePath, classification: malformed ? "malformed" : "valid" };
}

export function discoverEntities(projectRoot: string, sourceRoot?: string): EntityDiscoveryResult {
  const root = path.resolve(projectRoot);
  const model = authority(sourceRoot);
  const storageRoot = path.join(root, model.entityRoot);
  const entities: DiscoveredEntity[] = [];
  const issues: EntityDiagnostic[] = [];
  const unsafePrefix = noSymlinkPrefix(root, storageRoot);
  if (unsafePrefix) return { entities: [unsafeEntity(root, unsafePrefix)], issues: [unsafeIssue(root, unsafePrefix)], validArtifactValues: model.artifacts };
  if (!fs.existsSync(storageRoot)) return { entities, issues, validArtifactValues: model.artifacts };
  if (!fs.statSync(storageRoot).isDirectory()) {
    issues.push({ code: "malformed_entity", path: relative(root, storageRoot), message: `entity root '${relative(root, storageRoot)}' is not a directory`, recovery: recovery(root, `replace '${relative(root, storageRoot)}' with a directory`) });
    return { entities, issues, validArtifactValues: model.artifacts };
  }

  for (const artifactEntry of listDirectories(storageRoot)) {
    const artifactPath = path.join(storageRoot, artifactEntry.name);
    if (artifactEntry.isSymbolicLink()) { entities.push(unsafeEntity(root, artifactPath)); issues.push(unsafeIssue(root, artifactPath)); continue; }
    if (!artifactEntry.isDirectory()) {
      issues.push({ code: "malformed_entity", path: relative(root, artifactPath), message: `unexpected file '${relative(root, artifactPath)}' in entity root`, recovery: recovery(root, `remove '${relative(root, artifactPath)}' or place it under an artifact/boundary directory`) });
      continue;
    }
    for (const boundaryEntry of listDirectories(artifactPath)) {
      const boundaryPath = path.join(artifactPath, boundaryEntry.name);
      if (boundaryEntry.isSymbolicLink()) { entities.push(unsafeEntity(root, boundaryPath)); issues.push(unsafeIssue(root, boundaryPath)); continue; }
      if (!boundaryEntry.isDirectory()) {
        issues.push({ code: "malformed_entity", path: relative(root, boundaryPath), message: `unexpected file '${relative(root, boundaryPath)}' in artifact entity root`, recovery: recovery(root, `remove '${relative(root, boundaryPath)}' or place it under a declared boundary directory`) });
        continue;
      }
      for (const fileEntry of listDirectories(boundaryPath)) {
        const file = path.join(boundaryPath, fileEntry.name);
        if (fileEntry.isSymbolicLink()) { entities.push(unsafeEntity(root, file)); issues.push(unsafeIssue(root, file)); continue; }
        if (!fileEntry.isFile() || path.extname(fileEntry.name) !== ".yaml") {
          issues.push({ code: "malformed_entity", path: relative(root, file), message: `entity path '${relative(root, file)}' is not a canonical YAML file`, recovery: recovery(root, `remove '${relative(root, file)}' or replace it with <ten-lowercase-letter-id>.yaml`) });
          continue;
        }
        entities.push(discoverFile(root, file, artifactEntry.name, boundaryEntry.name, model, issues));
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
  const rank: Record<EntityClassification, number> = { duplicate: 0, malformed: 1, unsafe: 2, valid: 3 };
  entities.sort((left, right) => rank[left.classification] - rank[right.classification] || left.relativePath.localeCompare(right.relativePath));
  issues.sort(diagnosticSort);
  return { entities, issues, validArtifactValues: model.artifacts };
}

function relationTargets(entity: DiscoveredEntity, relation: RelationshipDefinition): string[] | null {
  const value = entity.record?.[relation.field];
  if (relation.cardinality === "exactly_one") return typeof value === "string" ? [value] : null;
  if (value === undefined || value === null) return [];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

export function validateEntityState(projectRoot: string, sourceRoot?: string): EntityValidationResult {
  const model = authority(sourceRoot);
  const discovery = discoverEntities(projectRoot, sourceRoot);
  const issues = [...discovery.issues];
  const byId = new Map<string, DiscoveredEntity[]>();
  for (const entity of discovery.entities) {
    if (entity.id) byId.set(entity.id, [...(byId.get(entity.id) ?? []), entity]);
  }
  for (const entity of discovery.entities) {
    if (!entity.boundary || !entity.record) continue;
    for (const relation of model.relationships.filter(({ source }) => source === entity.boundary)) {
      const targets = relationTargets(entity, relation);
      const invalidTargets = targets === null ? [String(entity.record[relation.field] ?? "<missing>")] : targets.filter((targetId) => {
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
  issues.sort(diagnosticSort);
  const omittedIssueCount = Math.max(0, issues.length - MAX_DIAGNOSTICS);
  const boundedIssues = issues.slice(0, MAX_DIAGNOSTICS);
  return { ...discovery, issues: boundedIssues, valid: issues.length === 0, entityCount: discovery.entities.length, omittedIssueCount };
}

function generatedId(model: EntityAuthority): string {
  let id = "";
  for (let index = 0; index < model.length; index += 1) id += model.alphabet[randomInt(model.alphabet.length)];
  return id;
}

export function allocateEntityId(projectRoot: string, candidate?: () => string, sourceRoot?: string): string {
  const model = authority(sourceRoot);
  const existing = new Set(discoverEntities(projectRoot, sourceRoot).entities.map(({ id }) => id).filter((id): id is string => id !== null));
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
}

export interface PublishEntityResult {
  id: string;
  artifact: string;
  boundary: string;
  path: string;
  replay: boolean;
}

export function publishEntity(request: PublishEntityRequest): PublishEntityResult {
  const model = authority(request.sourceRoot);
  if (!model.pattern.test(request.id)) throw new Error(`entity ID '${request.id}' must match ${model.pattern.source}`);
  const owner = model.byBoundary.get(request.boundary);
  if (!owner) throw new Error(`unknown entity boundary '${request.boundary}'`);
  if (owner.artifact !== request.artifact) throw new Error(`boundary '${request.boundary}' is owned by artifact '${owner.artifact}', not '${request.artifact}'`);
  if (!mapping(request.record)) throw new Error("entity record must be a mapping");
  const root = path.resolve(request.projectRoot);
  const target = path.join(root, model.entityRoot, request.artifact, request.boundary, `${request.id}.yaml`);
  const symlink = noSymlinkPrefix(root, target);
  if (symlink) throw new Error(`entity path contains symbolic link '${relative(root, symlink)}'; remove the symbolic link and retry`);
  const bytes = dumpYamlMapping({ id: request.id, artifact: request.artifact, record: request.record });
  const matches = discoverEntities(root, request.sourceRoot).entities.filter(({ id }) => id === request.id);
  const exact = matches.find(({ path: existing }) => existing === target);
  if (exact) {
    if (fs.readFileSync(target, "utf8") === bytes) return { id: request.id, artifact: request.artifact, boundary: request.boundary, path: target, replay: true };
    throw new Error(`divergent content for existing entity ID '${request.id}' at '${exact.relativePath}'; keep the existing ID unchanged or allocate a new ID`);
  }
  if (matches.length > 0) throw new Error(`entity ID '${request.id}' already exists at '${matches[0].relativePath}' owned by boundary '${matches[0].boundary}'; allocate a new project-wide ID`);
  const created = publishImmutableFile(target, bytes, { directoryDurabilityRoot: root });
  if (!created) {
    if (fs.readFileSync(target, "utf8") === bytes) return { id: request.id, artifact: request.artifact, boundary: request.boundary, path: target, replay: true };
    throw new Error(`divergent content for existing entity ID '${request.id}' at '${relative(root, target)}'; keep the existing ID unchanged or allocate a new ID`);
  }
  return { id: request.id, artifact: request.artifact, boundary: request.boundary, path: target, replay: false };
}

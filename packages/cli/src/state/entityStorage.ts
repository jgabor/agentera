import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { decisionRevisionContract, decisionRevisionEntityViolations } from "./decisionRevision.js";
import type { EntityPublicationContext, PublishedTargetIdentity } from "./entityPublicationContext.js";
import { healthEntityViolations } from "./healthEntityValidation.js";
import { detectStateModeBinding } from "./stateMode.js";
import { acquireWriterLock } from "./write/lock.js";
import { planTaskRecordViolations } from "./write/planEvaluation.js";
import { todoDocsRecordViolations } from "./todoDocsEntityValidation.js";

const MAX_DIAGNOSTICS = 100;

interface EntityDefinition {
  boundary: string;
  artifact: string;
  record?: {
    requiredFields: string[];
    requiredPaths: string[];
    forbiddenFields: string[];
    timestampFormat?: string;
    fieldShapes: Record<string, FieldShape>;
  };
  ownership?: { fields: string[]; cardinality: string };
  baseline?: { field: string; value: string; cardinality: string };
}

interface FieldShape {
  type: "mapping";
  requiredFields: Record<string, "string_list">;
  optionalFields: Record<string, "string_list">;
  additionalFields: "allowed" | "forbidden";
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
  forbiddenAliases: string[];
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
  origin: {
    projectRoot: string;
    sourceRoot: string;
  };
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
}

export interface CanonicalEntityTargetDiagnostic {
  sourceIdentity: string;
  path: string;
  message: string;
}

export function entityArtifactValues(sourceRoot?: string): string[] {
  return [...authority(sourceRoot).artifacts];
}

export function entityBoundariesForArtifact(artifact: string, sourceRoot?: string): string[] {
  return authority(sourceRoot).entities
    .filter((definition) => definition.artifact === artifact)
    .map((definition) => definition.boundary)
    .sort();
}

/** Validate bytes independently of a working-tree path, for committed recovery evidence. */
export function canonicalEntityEnvelope(
  bytes: string,
  expected: { artifact: string; boundary: string; id: string },
  sourceRoot?: string,
): { id: string; artifact: string; record: JsonObject } {
  const model = authority(sourceRoot);
  return canonicalEntityEnvelopeAgainstModel(bytes, expected, model, sourceRoot);
}

function canonicalEntityEnvelopeAgainstModel(
  bytes: string,
  expected: { artifact: string; boundary: string; id: string },
  model: EntityAuthority,
  sourceRoot?: string,
): { id: string; artifact: string; record: JsonObject } {
  const owner = model.byBoundary.get(expected.boundary);
  if (!owner || owner.artifact !== expected.artifact || !model.pattern.test(expected.id)) {
    throw new Error("the requested artifact, boundary, or ID is not authority-declared");
  }
  const document = loadYamlMapping(bytes);
  if (Object.keys(document).some((key) => !["id", "artifact", "record"].includes(key))) {
    throw new Error("entity envelope may contain only id, artifact, and record");
  }
  if (document.id !== expected.id || document.artifact !== expected.artifact || !mapping(document.record)) {
    throw new Error("entity envelope does not match the requested artifact and ID");
  }
  const record = document.record as JsonObject;
  const violations = canonicalEntityRecordViolationsAgainstModel(expected.boundary, record, model);
  if (owner.record?.timestampFormat === "YYYY-MM-DD HH:MM" && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(record.timestamp ?? ""))) violations.push("timestamp must use YYYY-MM-DD HH:MM");
  if (expected.boundary === "decision_revision") violations.push(...decisionRevisionEntityViolations(record, decisionRevisionContract(sourceRoot)));
  if (expected.boundary === "health_audit") violations.push(...healthEntityViolations(record));
  if (expected.boundary === "plan") {
    const header = mapping(record.header) ? record.header : {};
    if (!mapping(record.header) || typeof header.title !== "string" || typeof header.created !== "string" || !["open", "complete", "archived"].includes(String(header.status))) violations.push("invalid plan lifecycle fields");
  }
  if (expected.boundary === "plan_task") violations.push(...planTaskRecordViolations(record));
  if (expected.boundary === "experiment" && (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(record.date ?? "")) || !["baseline", "kept", "discarded"].includes(String(record.status)))) violations.push("invalid experiment date or status");
  if (expected.boundary === "todo_item" || expected.boundary === "documentation_inventory_entry") violations.push(...todoDocsRecordViolations(expected.boundary, record));
  if (violations.length) throw new Error(`entity record violates the '${expected.boundary}' boundary contract: ${violations.join("; ")}`);
  return { id: expected.id, artifact: expected.artifact, record };
}

export function canonicalEntityEnvelopeBytes(target: Pick<CanonicalEntityTarget, "id" | "artifact" | "record">): string {
  return dumpYamlMapping({ id: target.id, artifact: target.artifact, record: target.record });
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function fieldShapes(value: unknown, authorityPath: string): Record<string, FieldShape> {
  if (value === undefined) return {};
  if (!mapping(value)) throw new Error(`invalid entity field_shapes declaration in '${authorityPath}'`);
  return Object.fromEntries(Object.entries(value).map(([field, raw]) => {
    if (!mapping(raw) || raw.type !== "mapping" || !mapping(raw.required_fields) || !["allowed", "forbidden"].includes(String(raw.additional_fields))) {
      throw new Error(`invalid entity field_shapes.${field} declaration in '${authorityPath}'`);
    }
    const declaredFields = (group: "required_fields" | "optional_fields"): Record<string, "string_list"> => {
      const declaration = raw[group];
      if (declaration === undefined && group === "optional_fields") return {};
      if (!mapping(declaration)) throw new Error(`invalid entity field_shapes.${field}.${group} declaration in '${authorityPath}'`);
      return Object.fromEntries(Object.entries(declaration).map(([name, type]) => {
        if (type !== "string_list") throw new Error(`invalid entity field_shapes.${field}.${group}.${name} declaration in '${authorityPath}'`);
        return [name, type];
      })) as Record<string, "string_list">;
    };
    return [field, {
      type: "mapping",
      requiredFields: declaredFields("required_fields"),
      optionalFields: declaredFields("optional_fields"),
      additionalFields: raw.additional_fields as "allowed" | "forbidden",
    }];
  }));
}

function authority(sourceRoot = resolveSourceRoot()): EntityAuthority {
  const authorityPath = path.join(sourceRoot, "references", "artifacts", "state-storage-authority.yaml");
  const document = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  const target = document.entity_target;
  if (!mapping(target) || !mapping(target.identity) || !mapping(target.storage_boundary) || !mapping(target.public_schema) || !Array.isArray(target.entities) || !mapping(target.relationships)) {
    throw new Error(`invalid entity authority '${authorityPath}'`);
  }
  const entities = target.entities.map((value): EntityDefinition => {
    if (!mapping(value) || typeof value.boundary !== "string" || typeof value.artifact !== "string") {
      throw new Error(`invalid entity declaration in '${authorityPath}'`);
    }
    const record = mapping(value.record) ? value.record : null;
    const ownership = mapping(value.ownership) ? value.ownership : null;
    const baseline = mapping(value.baseline) ? value.baseline : null;
    return {
      boundary: value.boundary,
      artifact: value.artifact,
      ...(record ? { record: {
        requiredFields: strings(record.required_fields),
        requiredPaths: strings(record.required_paths),
        forbiddenFields: strings(record.forbidden_fields),
        fieldShapes: fieldShapes(record.field_shapes, authorityPath),
        ...(typeof record.timestamp_format === "string" ? { timestampFormat: record.timestamp_format } : {}),
      } } : {}),
      ...(ownership ? { ownership: {
        fields: strings(ownership.fields),
        cardinality: String(ownership.cardinality ?? ""),
      } } : {}),
      ...(baseline && typeof baseline.field === "string" && typeof baseline.value === "string" ? { baseline: {
        field: baseline.field,
        value: baseline.value,
        cardinality: String(baseline.cardinality ?? ""),
      } } : {}),
    };
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
    forbiddenAliases: strings(target.public_schema.forbidden_canonical_aliases),
  };
}

export function canonicalEntityRecordViolations(
  boundary: string,
  record: JsonObject,
  sourceRoot?: string,
): string[] {
  const model = authority(sourceRoot);
  return canonicalEntityRecordViolationsAgainstModel(boundary, record, model);
}

function canonicalEntityRecordViolationsAgainstModel(boundary: string, record: JsonObject, model: EntityAuthority): string[] {
  const definition = model.byBoundary.get(boundary);
  if (!definition?.record) throw new Error(`unknown entity record boundary '${boundary}'`);
  const missing = definition.record.requiredFields.filter((field) => record[field] === undefined);
  const missingPaths = definition.record.requiredPaths.filter((field) => {
    let current: unknown = record;
    for (const part of field.split(".")) current = mapping(current) ? current[part] : undefined;
    return typeof current !== "string" || current.length === 0;
  });
  const forbidden = [...new Set([...definition.record.forbiddenFields, ...model.forbiddenAliases])]
    .filter((field) => record[field] !== undefined);
  const shapeViolations = Object.entries(definition.record.fieldShapes).flatMap(([field, shape]) => {
    const value = record[field];
    if (!mapping(value)) return [`${field} must be a mapping`];
    const required = Object.entries(shape.requiredFields).flatMap(([name, type]) => {
      if (!(name in value)) return [`${field}.${name} is required`];
      if (type === "string_list" && (!Array.isArray(value[name]) || !value[name].every((item) => typeof item === "string"))) return [`${field}.${name} must be a list of strings`];
      return [];
    });
    const optional = Object.entries(shape.optionalFields).flatMap(([name, type]) => {
      if (!(name in value)) return [];
      if (type === "string_list" && (!Array.isArray(value[name]) || !value[name].every((item) => typeof item === "string"))) return [`${field}.${name} must be a list of strings`];
      return [];
    });
    if (shape.additionalFields === "allowed") return [...required, ...optional];
    const declared = new Set([...Object.keys(shape.requiredFields), ...Object.keys(shape.optionalFields)]);
    const extras = Object.keys(value).filter((name) => !declared.has(name));
    return [...required, ...optional, ...extras.map((name) => `${field}.${name} is not allowed`)];
  });
  return [
    ...missing.map((field) => `${field} is required by the canonical ${boundary} record contract`),
    ...missingPaths.map((field) => `${field} is required by the canonical ${boundary} record contract`),
    ...forbidden.map((field) => `${field} is forbidden by the canonical entity authority`),
    ...shapeViolations,
  ];
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
  sourceRoot?: string,
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
  const owner = model.byBoundary.get(boundary);
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
  if (!malformed && owner?.record && record) {
    const violations = canonicalEntityRecordViolationsAgainstModel(boundary, record, model);
    const timestampInvalid = owner.record.timestampFormat === "YYYY-MM-DD HH:MM" && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(record.timestamp ?? ""));
    if (violations.length || timestampInvalid) {
      malformed = true;
      issues.push({
        code: "malformed_entity",
        path: relativePath,
        id,
        artifact,
        boundary,
        message: `entity '${relativePath}' violates the authority-declared '${boundary}' record contract: ${[...violations, ...(timestampInvalid ? ["timestamp must use YYYY-MM-DD HH:MM"] : [])].join("; ")}`,
        recovery: recovery(projectRoot, `repair record fields in '${relativePath}' to match the state storage authority`),
      });
    }
  }
  if (!malformed && boundary === "decision_revision" && record) {
    const violations = decisionRevisionEntityViolations(record, decisionRevisionContract(sourceRoot));
    if (violations.length) {
      malformed = true;
      issues.push({
        code: "malformed_entity",
        path: relativePath,
        id,
        artifact,
        boundary,
        message: `entity '${relativePath}' has an invalid decision revision: ${violations.join("; ")}`,
        recovery: recovery(projectRoot, `repair '${relativePath}' using the authority-declared decision revision contract`),
      });
    }
  }
  if (!malformed && boundary === "health_audit" && record) {
    const violations = healthEntityViolations(record);
    if (violations.length) {
      malformed = true;
      issues.push({
        code: "malformed_entity",
        path: relativePath,
        id,
        artifact,
        boundary,
        message: `entity '${relativePath}' has an invalid canonical health audit`,
        recovery: recovery(projectRoot, `preserve the declared audit evidence and repair '${relativePath}' using the health schema`),
      });
    }
  }
  if (!malformed && boundary === "plan" && record) {
    const header = mapping(record.header) ? record.header : {};
    if (!mapping(record.header) || typeof header.title !== "string" || typeof header.created !== "string" || !["open", "complete", "archived"].includes(String(header.status))) {
      malformed = true;
      issues.push({ code: "malformed_entity", path: relativePath, id, artifact, boundary, message: `entity '${relativePath}' has invalid plan lifecycle fields`, recovery: recovery(projectRoot, `repair '${relativePath}' using the current plan header schema and open|complete|archived lifecycle`) });
    }
  }
  if (!malformed && boundary === "plan_task" && record) {
    if (planTaskRecordViolations(record).length) {
      malformed = true;
      issues.push({ code: "malformed_entity", path: relativePath, id, artifact, boundary, message: `entity '${relativePath}' has invalid plan task or evaluation fields`, recovery: recovery(projectRoot, `repair '${relativePath}' using the current plan task and evaluation schema`) });
    }
  }
  if (!malformed && boundary === "experiment" && record) {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(record.date ?? "")) || !["baseline", "kept", "discarded"].includes(String(record.status))) {
      malformed = true;
      issues.push({ code: "malformed_entity", path: relativePath, id, artifact, boundary, message: `entity '${relativePath}' has invalid experiment date or status`, recovery: recovery(projectRoot, `repair '${relativePath}' using YYYY-MM-DD HH:MM and baseline|kept|discarded`) });
    }
  }
  if (!malformed && (boundary === "todo_item" || boundary === "documentation_inventory_entry") && record) {
    const violations = todoDocsRecordViolations(boundary, record);
    if (violations.length) {
      malformed = true;
      issues.push({ code: "malformed_entity", path: relativePath, id, artifact, boundary, message: `entity '${relativePath}' has an invalid ${boundary} record: ${violations.join("; ")}`, recovery: recovery(projectRoot, `repair '${relativePath}' using the authority-declared ${boundary} fields`) });
    }
  }
  return { id, artifact, boundary, record, path: file, relativePath, classification: malformed ? "malformed" : "valid" };
}

export function discoverEntities(projectRoot: string, sourceRoot?: string): EntityDiscoveryResult {
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
        entities.push(discoverFile(root, file, artifactEntry.name, boundaryEntry.name, model, issues, resolvedSourceRoot));
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
  return { origin, entities, issues, validArtifactValues: model.artifacts };
}

export function assertEntityDiscoveryOrigin(projectRoot: string, sourceRoot: string | undefined, discovery: EntityDiscoveryResult): void {
  const expected = {
    projectRoot: path.resolve(projectRoot),
    sourceRoot: path.resolve(sourceRoot ?? resolveSourceRoot()),
  };
  const actualProjectRoot = discovery.origin?.projectRoot ?? "<missing>";
  const actualSourceRoot = discovery.origin?.sourceRoot ?? "<missing>";
  if (actualProjectRoot === expected.projectRoot && actualSourceRoot === expected.sourceRoot) return;
  throw new Error(
    `supplied entity discovery origin does not match this request (expected project '${expected.projectRoot}' and source authority '${expected.sourceRoot}', received project '${actualProjectRoot}' and source authority '${actualSourceRoot}'); call discoverEntities with this request's project and source roots, then retry`,
  );
}

function relationTargets(entity: DiscoveredEntity, relation: RelationshipDefinition): string[] | null {
  const value = entity.record?.[relation.field];
  if (relation.cardinality === "exactly_one") return typeof value === "string" ? [value] : null;
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
      const cyclic = (Array.isArray(task.record?.depends_on) ? task.record.depends_on : [])
        .some((id) => typeof id === "string" && byTaskId.has(id) && visit(byTaskId.get(id)!));
      visiting.delete(task.id!); visited.add(task.id!); return cyclic;
    };
    for (const task of tasks) if (visit(task)) issues.push({
      code: "unresolved_relation", path: task.relativePath, id: task.id!, artifact: task.artifact ?? undefined, boundary: task.boundary ?? undefined,
      relation: "depends_on", message: `plan '${planId}' task dependency graph contains a cycle involving '${task.id}'`,
      recovery: recovery(projectRoot, `remove one record.depends_on edge in plan '${planId}' so the task graph is acyclic`),
    });
  }
  for (const plan of discovery.entities.filter((entity) => entity.boundary === "plan" && entity.classification === "valid" && entity.id && entity.record)) {
    const header = mapping(plan.record!.header) ? plan.record!.header as JsonObject : {};
    if (header.status === "complete") {
      const incomplete = (tasksByPlan.get(plan.id!) ?? []).filter((task) => task.record?.status !== "complete");
      if (incomplete.length) issues.push({
        code: "conflicting_ownership", path: plan.relativePath, id: plan.id!, artifact: plan.artifact ?? undefined, boundary: plan.boundary ?? undefined,
        message: `complete plan '${plan.id}' owns ${incomplete.length} incomplete task entities`,
        recovery: recovery(projectRoot, `complete every task related to plan '${plan.id}' or restore the plan lifecycle to open`),
      });
    }
  }
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
      for (const entity of claimants) issues.push({
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
      for (const entity of entities) issues.push({
        code: "conflicting_ownership", path: entity.relativePath, id: entity.id ?? undefined, artifact: entity.artifact ?? undefined, boundary: entity.boundary ?? undefined,
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

export function validateEntityState(projectRoot: string, sourceRoot?: string): EntityValidationResult {
  return validateEntityDiscovery(projectRoot, sourceRoot, discoverEntities(projectRoot, sourceRoot));
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
    let message: string | null = target.path === expectedPath ? null : `canonical target path '${target.path}' must be '${expectedPath}'`;
    if (!message) {
      try { record = canonicalEntityEnvelopeAgainstModel(canonicalEntityEnvelopeBytes(target), target, model, sourceRoot).record; }
      catch (error) { message = (error as Error).message; }
    }
    if (message) issues.push({ code: "malformed_entity", path: target.path, id: target.id, artifact: target.artifact, boundary: target.boundary, message, recovery: recovery(projectRoot, `repair legacy source '${target.sourceIdentity}' so its canonical target satisfies the authority-backed boundary validator`) });
    entities.push({ id: target.id, artifact: target.artifact, boundary: target.boundary, record, path: path.join(projectRoot, target.path), relativePath: target.path, classification: message ? "malformed" : "valid" });
  }
  for (const duplicates of targetsById.values()) {
    if (duplicates.length < 2) continue;
    for (const target of duplicates) issues.push({ code: "duplicate_id", path: target.path, id: target.id, artifact: target.artifact, boundary: target.boundary, message: `entity ID '${target.id}' appears ${duplicates.length} times across proposed canonical targets`, recovery: recovery(projectRoot, `repair migration identity allocation for '${target.sourceIdentity}'`) });
  }
  const validation = validateEntityDiscovery(projectRoot, sourceRoot, {
    origin: { projectRoot: path.resolve(projectRoot), sourceRoot: path.resolve(sourceRoot ?? resolveSourceRoot()) },
    entities,
    issues,
    validArtifactValues: model.artifacts,
  }, false);
  return validation.issues.map((issue) => ({ sourceIdentity: sourceByPath.get(issue.path) ?? issue.id ?? issue.path, path: issue.path, message: issue.message }));
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
  publicationContext?: EntityPublicationContext;
}

export interface PublishEntityResult {
  id: string;
  artifact: string;
  boundary: string;
  path: string;
  replay: boolean;
  publishedIdentity?: PublishedTargetIdentity;
}

export interface ReplaceEntityRequest extends PublishEntityRequest {
  expectedRecord: JsonObject;
}

function publishEntityLocked(
  request: PublishEntityRequest,
  model: EntityAuthority,
  context: EntityPublicationContext,
): PublishEntityResult {
  context.assertValid();
  if (!model.pattern.test(request.id)) throw new Error(`entity ID '${request.id}' must match ${model.pattern.source}`);
  const owner = model.byBoundary.get(request.boundary);
  if (!owner) throw new Error(`unknown entity boundary '${request.boundary}'`);
  if (owner.artifact !== request.artifact) throw new Error(`boundary '${request.boundary}' is owned by artifact '${owner.artifact}', not '${request.artifact}'`);
  if (!mapping(request.record)) throw new Error("entity record must be a mapping");
  const root = context.pinnedPath();
  const relativeTarget = path.join(
    model.entityRoot,
    request.artifact,
    request.boundary,
    `${request.id}.yaml`,
  );
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

export function withEntityWriterLock<T>(context: EntityPublicationContext, run: () => T): T {
  context.assertValid();
  const lock = acquireWriterLock(context.pinnedPath(), 2000);
  try {
    context.assertValid();
    return run();
  } finally {
    lock.release();
  }
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
  const relativeTarget = path.join(model.entityRoot, request.artifact, request.boundary, `${request.id}.yaml`);
  if (canonicalRecordJson(request.expectedRecord) === canonicalRecordJson(request.record))
    return { id: request.id, artifact: request.artifact, boundary: request.boundary, path: path.join(path.resolve(request.projectRoot), relativeTarget), replay: true };
  context.replaceExisting(
    relativeTarget,
    dumpYamlMapping({ id: request.id, artifact: request.artifact, record: request.expectedRecord }),
    dumpYamlMapping({ id: request.id, artifact: request.artifact, record: request.record }),
  );
  return { id: request.id, artifact: request.artifact, boundary: request.boundary, path: path.join(path.resolve(request.projectRoot), relativeTarget), replay: false };
}

function withPublicationContext<T>(
  request: Pick<PublishEntityRequest, "projectRoot" | "sourceRoot" | "publicationContext">,
  run: (context: EntityPublicationContext) => T,
): T {
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

function publishWithContext(
  request: PublishEntityRequest,
  model: EntityAuthority,
  context: EntityPublicationContext,
): PublishEntityResult {
  return withEntityWriterLock(context, () => publishEntityLocked(request, model, context));
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

export function allocateAndPublishEntity(
  request: Omit<PublishEntityRequest, "id">,
  candidate?: () => string,
): PublishEntityResult {
  const model = authority(request.sourceRoot);
  return withPublicationContext(request, (context) => {
    context.assertValid();
    const lock = acquireWriterLock(context.pinnedPath(), 2000);
    try {
      context.assertValid();
      const existing = new Set(discoverEntities(context.pinnedPath(), request.sourceRoot).entities.map(({ id }) => id).filter((id): id is string => id !== null));
      for (let attempt = 0; attempt < 1024; attempt += 1) {
        const id = candidate ? candidate() : generatedId(model);
        if (!model.pattern.test(id)) throw new Error(`entity ID candidate '${id}' must match ${model.pattern.source}`);
        if (existing.has(id)) continue;
        return publishEntityLocked({ ...request, id }, model, context);
      }
      throw new Error("could not allocate a unique entity ID after 1024 attempts; run agentera check validate state and retry");
    } finally {
      lock.release();
    }
  });
}

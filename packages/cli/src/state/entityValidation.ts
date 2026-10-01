import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import type { GlossaryCaveatContract } from "../registries/glossaryCaveatContract.js";
import { decisionMigrationProvenanceViolations, decisionRevisionMigrationProvenanceViolations, type MigrationProvenanceDeclaration } from "./decisionMigrationProvenance.js";
import { decisionRevisionContract, decisionRevisionEntityViolations } from "./decisionRevision.js";
import { loadEntityGlossaryAuthority } from "./entityGlossaryAuthority.js";
import type { DiscoveredEntity, EntityDiagnostic } from "./entityStorage.js";
import { healthEntityViolations } from "./healthEntityValidation.js";
import type { MigrationSourceBindingContext } from "./migrationSourceBinding.js";
import { validateProgressGlossaryCaveat } from "./progressGlossaryCaveat.js";
import { progressPublicationOrderViolations } from "./progressPublicationOrder.js";
import { loadStateStorageAuthority } from "./stateStorageAuthority.js";
import { summaryMigrationProvenanceDeclaration, summaryMigrationProvenanceViolations, type SummaryMigrationProvenanceDeclaration } from "./summaryMigrationProvenance.js";
import { validateCompactedSummarySourceRowAuthority } from "./summarySourceRowAuthority.js";
import { todoDocsRecordViolations } from "./todoDocsEntityValidation.js";
import { planTaskRecordViolations } from "./write/planEvaluation.js";

interface EntityDefinition {
  boundary: string;
  artifact: string;
  independentlyMutable: boolean;
  record?: {
    requiredFields: string[];
    requiredPaths: string[];
    forbiddenFields: string[];
    timestampFormat?: string;
    fieldShapes: Record<string, FieldShape>;
  };
  ownership?: { fields: string[]; cardinality: string };
  baseline?: { field: string; value: string; cardinality: string };
  migrationProvenance?: MigrationProvenanceDeclaration;
  summaryMigrationProvenance?: SummaryMigrationProvenanceDeclaration;
}
interface FieldShape {
  type: "mapping";
  requiredFields: Record<string, "string_list">;
  optionalFields: Record<string, "string_list">;
  additionalFields: "allowed" | "forbidden";
}
export interface RelationshipDefinition {
  source: string;
  field: string;
  target: string;
  cardinality: string;
}
export interface EntityAuthority {
  entityRoot: string;
  maxEntityBytes: number;
  alphabet: string;
  length: number;
  pattern: RegExp;
  entities: EntityDefinition[];
  relationships: RelationshipDefinition[];
  artifacts: string[];
  byBoundary: Map<string, EntityDefinition>;
  forbiddenAliases: string[];
  glossaryCaveat: GlossaryCaveatContract;
}

export function entityArtifactValues(sourceRoot?: string): string[] {
  return [...authority(sourceRoot).artifacts];
}

/** Classify a project-relative path, not its contents or publication authority. */
export function canonicalEntityPath(relativePath: string, sourceRoot?: string): { id: string; artifact: string; boundary: string } | null {
  const model = authority(sourceRoot);
  const prefix = `${model.entityRoot}/`;
  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized.startsWith(prefix)) return null;
  const parts = normalized.slice(prefix.length).split("/");
  if (parts.length !== 3 || !parts[2].endsWith(".yaml")) return null;
  const [artifact, boundary, filename] = parts;
  const id = filename.slice(0, -5);
  if (!model.pattern.test(id) || model.byBoundary.get(boundary)?.artifact !== artifact) return null;
  return { id, artifact, boundary };
}

export function entityBoundariesForArtifact(artifact: string, sourceRoot?: string): string[] {
  return authority(sourceRoot)
    .entities.filter((definition) => definition.artifact === artifact)
    .map((definition) => definition.boundary)
    .sort();
}

export function entityForbiddenCanonicalAliases(sourceRoot?: string): string[] {
  return [...authority(sourceRoot).forbiddenAliases];
}
export function entityPreservedAggregateCollections(sourceRoot?: string): Record<string, string[]> {
  const sources = authority(sourceRoot).entities.flatMap((definition) => definition.summaryMigrationProvenance?.sources ?? []);
  return Object.fromEntries(sources.map((source) => [source.path, [...source.collections].sort()]));
}
/** Validate bytes independently of a working-tree path, for committed recovery evidence. */
export function canonicalEntityEnvelope(bytes: string, expected: { artifact: string; boundary: string; id: string }, sourceRoot?: string, sourceBinding?: MigrationSourceBindingContext): { id: string; artifact: string; record: JsonObject; migrationProvenance: JsonObject | null } {
  const model = authority(sourceRoot);
  return canonicalEntityEnvelopeAgainstModel(bytes, expected, model, sourceRoot, sourceBinding);
}

export function canonicalEntityEnvelopeAgainstModel(bytes: string, expected: { artifact: string; boundary: string; id: string }, model: EntityAuthority, sourceRoot?: string, sourceBinding?: MigrationSourceBindingContext): { id: string; artifact: string; record: JsonObject; migrationProvenance: JsonObject | null } {
  const owner = model.byBoundary.get(expected.boundary);
  if (!owner || owner.artifact !== expected.artifact || !model.pattern.test(expected.id)) {
    throw new Error("the requested artifact, boundary, or ID is not authority-declared");
  }
  const document = loadYamlMapping(bytes);
  if (Object.keys(document).some((key) => !["id", "artifact", "record", "migration_provenance"].includes(key))) {
    throw new Error("entity envelope contains an authority-undeclared field");
  }
  if (document.id !== expected.id || document.artifact !== expected.artifact || !mapping(document.record)) {
    throw new Error("entity envelope does not match the requested artifact and ID");
  }
  const record = document.record as JsonObject;
  const migrationProvenanceValue = document.migration_provenance;
  const migrationProvenance = mapping(migrationProvenanceValue) ? (migrationProvenanceValue as JsonObject) : null;
  const violations = canonicalEntityRecordViolationsAgainstModel(expected.boundary, record, model, sourceBinding);
  violations.push(...migrationProvenanceViolations(expected.boundary, record, migrationProvenanceValue, model, sourceRoot, sourceBinding));
  if (owner.record?.timestampFormat === "YYYY-MM-DD HH:MM" && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(record.timestamp ?? ""))) violations.push("timestamp must use YYYY-MM-DD HH:MM");
  if (expected.boundary === "decision_revision") violations.push(...decisionRevisionEntityViolations(record, decisionRevisionContract(sourceRoot), migrationProvenance?.kind === "inherited_decision_revision_confidence"));
  if (expected.boundary === "health_audit") violations.push(...healthEntityViolations(record));
  if (expected.boundary === "plan") {
    const header = mapping(record.header) ? record.header : {};
    if (!mapping(record.header) || typeof header.title !== "string" || typeof header.created !== "string" || !["open", "complete", "archived"].includes(String(header.status)) || (record.replacement_input_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(record.replacement_input_sha256))))
      violations.push("invalid plan lifecycle or replacement identity fields");
  }
  if (expected.boundary === "plan_task") violations.push(...planTaskRecordViolations(record));
  if (expected.boundary === "experiment" && (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(record.date ?? "")) || !["baseline", "kept", "discarded"].includes(String(record.status)))) violations.push("invalid experiment date or status");
  if (expected.boundary === "todo_item" || expected.boundary === "documentation_inventory_entry") violations.push(...todoDocsRecordViolations(expected.boundary, record, sourceRoot));
  if (violations.length) throw new Error(`entity record violates the '${expected.boundary}' boundary contract: ${violations.join("; ")}`);
  return { id: expected.id, artifact: expected.artifact, record, migrationProvenance };
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
let entityAuthorityCache: { revision: symbol; model: Omit<EntityAuthority, "glossaryCaveat"> } | undefined;
function fieldShapes(value: unknown, authorityPath: string): Record<string, FieldShape> {
  if (value === undefined) return {};
  if (!mapping(value)) throw new Error(`invalid entity field_shapes declaration in '${authorityPath}'`);
  return Object.fromEntries(
    Object.entries(value).map(([field, raw]) => {
      if (!mapping(raw) || raw.type !== "mapping" || !mapping(raw.required_fields) || !["allowed", "forbidden"].includes(String(raw.additional_fields))) {
        throw new Error(`invalid entity field_shapes.${field} declaration in '${authorityPath}'`);
      }
      const declaredFields = (group: "required_fields" | "optional_fields"): Record<string, "string_list"> => {
        const declaration = raw[group];
        if (declaration === undefined && group === "optional_fields") return {};
        if (!mapping(declaration)) throw new Error(`invalid entity field_shapes.${field}.${group} declaration in '${authorityPath}'`);
        return Object.fromEntries(
          Object.entries(declaration).map(([name, type]) => {
            if (type !== "string_list") throw new Error(`invalid entity field_shapes.${field}.${group}.${name} declaration in '${authorityPath}'`);
            return [name, type];
          }),
        ) as Record<string, "string_list">;
      };
      return [
        field,
        {
          type: "mapping",
          requiredFields: declaredFields("required_fields"),
          optionalFields: declaredFields("optional_fields"),
          additionalFields: raw.additional_fields as "allowed" | "forbidden",
        },
      ];
    }),
  );
}

export function authority(sourceRoot = resolveSourceRoot()): EntityAuthority {
  const { authorityPath, document, revision } = loadStateStorageAuthority(sourceRoot);
  if (entityAuthorityCache?.revision === revision)
    return {
      ...entityAuthorityCache.model,
      glossaryCaveat: loadEntityGlossaryAuthority(path.join(sourceRoot, "references", "artifacts", "glossary-entry-contract.yaml")),
    };
  const target = document.entity_target;
  if (!mapping(target) || !mapping(target.identity) || !mapping(target.storage_boundary) || !mapping(target.public_schema) || !Array.isArray(target.entities) || !mapping(target.relationships)) {
    throw new Error(`invalid entity authority '${authorityPath}'`);
  }
  validateCompactedSummarySourceRowAuthority(target, authorityPath);
  const entities = target.entities.map((value): EntityDefinition => {
    if (!mapping(value) || typeof value.boundary !== "string" || typeof value.artifact !== "string") {
      throw new Error(`invalid entity declaration in '${authorityPath}'`);
    }
    const record = mapping(value.record) ? value.record : null;
    const ownership = mapping(value.ownership) ? value.ownership : null;
    const baseline = mapping(value.baseline) ? value.baseline : null;
    const canonicalMetadata = mapping(value.canonical_metadata) ? value.canonical_metadata : null;
    const migrationProvenance = canonicalMetadata && mapping(canonicalMetadata.migration_provenance) ? canonicalMetadata.migration_provenance : null;
    const summaryMigrationProvenance = mapping(canonicalMetadata?.summary_migration_provenance) ? (canonicalMetadata.summary_migration_provenance as JsonObject) : null;
    return {
      boundary: value.boundary,
      artifact: value.artifact,
      independentlyMutable: value.independently_mutable !== false,
      ...(record
        ? {
            record: {
              requiredFields: strings(record.required_fields),
              requiredPaths: strings(record.required_paths),
              forbiddenFields: strings(record.forbidden_fields),
              fieldShapes: fieldShapes(record.field_shapes, authorityPath),
              ...(typeof record.timestamp_format === "string" ? { timestampFormat: record.timestamp_format } : {}),
            },
          }
        : {}),
      ...(ownership
        ? {
            ownership: {
              fields: strings(ownership.fields),
              cardinality: String(ownership.cardinality ?? ""),
            },
          }
        : {}),
      ...(baseline && typeof baseline.field === "string" && typeof baseline.value === "string"
        ? {
            baseline: {
              field: baseline.field,
              value: baseline.value,
              cardinality: String(baseline.cardinality ?? ""),
            },
          }
        : {}),
      ...(migrationProvenance
        ? {
            migrationProvenance: {
              requiredFields: strings(migrationProvenance.required_fields),
              kind: String(migrationProvenance.kind ?? ""),
              sources: strings(migrationProvenance.sources),
              additionalFields: migrationProvenance.additional_fields as "forbidden",
            },
          }
        : {}),
      ...(summaryMigrationProvenance
        ? {
            summaryMigrationProvenance: summaryMigrationProvenanceDeclaration(summaryMigrationProvenance, authorityPath),
          }
        : {}),
    };
  });
  const declarations = target.relationships.declarations;
  if (!Array.isArray(declarations)) throw new Error(`invalid relationship declarations in '${authorityPath}'`);
  const relationships = declarations.map((value): RelationshipDefinition => {
    if (!mapping(value) || typeof value.source !== "string" || typeof value.field !== "string" || typeof value.target !== "string" || typeof value.cardinality !== "string") {
      throw new Error(`invalid relationship declaration in '${authorityPath}'`);
    }
    return {
      source: value.source,
      field: value.field,
      target: value.target,
      cardinality: value.cardinality,
    };
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
  const exactGet = mapping(target.measurement_contract) && mapping(target.measurement_contract.targets) && mapping(target.measurement_contract.targets.exact_get) ? target.measurement_contract.targets.exact_get : null;
  const maxEntityBytes = Number(exactGet?.max_utf8_bytes);
  if (!Number.isSafeInteger(maxEntityBytes) || maxEntityBytes < 1) throw new Error(`invalid exact entity byte limit in '${authorityPath}'`);
  const model = {
    entityRoot,
    maxEntityBytes,
    alphabet,
    length,
    pattern: new RegExp(acceptedPattern),
    entities,
    relationships,
    artifacts: [...new Set(entities.map(({ artifact }) => artifact))].sort(),
    byBoundary: new Map(entities.map((entity) => [entity.boundary, entity])),
    forbiddenAliases: strings(target.public_schema.forbidden_canonical_aliases),
  };
  entityAuthorityCache = { revision, model };
  return {
    ...model,
    glossaryCaveat: loadEntityGlossaryAuthority(path.join(sourceRoot, "references", "artifacts", "glossary-entry-contract.yaml")),
  };
}

export function entityExactGetMaxBytes(sourceRoot?: string): number {
  return authority(sourceRoot).maxEntityBytes;
}

export function canonicalEntityRecordViolations(boundary: string, record: JsonObject, sourceRoot?: string, sourceBinding?: MigrationSourceBindingContext): string[] {
  return canonicalEntityRecordViolationsAgainstModel(boundary, record, authority(sourceRoot), sourceBinding);
}

function canonicalEntityRecordViolationsAgainstModel(boundary: string, record: JsonObject, model: EntityAuthority, sourceBinding?: MigrationSourceBindingContext): string[] {
  const definition = model.byBoundary.get(boundary);
  if (!definition?.record) throw new Error(`unknown entity record boundary '${boundary}'`);
  const missing = definition.record.requiredFields.filter((field) => record[field] === undefined);
  const missingPaths = definition.record.requiredPaths.filter((field) => {
    let current: unknown = record;
    for (const part of field.split(".")) current = mapping(current) ? current[part] : undefined;
    return typeof current !== "string" || current.length === 0;
  });
  const forbidden = [...new Set([...definition.record.forbiddenFields, ...model.forbiddenAliases])].filter((field) => record[field] !== undefined);
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
    ...(boundary === "progress_cycle" ? [...progressPublicationOrderViolations(record), ...validateProgressGlossaryCaveat(record, model.glossaryCaveat).violations] : []),
    ...(definition.summaryMigrationProvenance ? summaryMigrationProvenanceViolations(boundary, record, definition.summaryMigrationProvenance, model.forbiddenAliases, sourceBinding) : []),
  ];
}

function migrationProvenanceViolations(boundary: string, record: JsonObject, provenance: unknown, model: EntityAuthority, sourceRoot?: string, sourceBinding?: MigrationSourceBindingContext): string[] {
  const definition = model.byBoundary.get(boundary);
  const declared = definition?.migrationProvenance;
  if (!declared) return provenance === null || provenance === undefined ? [] : ["migration_provenance is not allowed on this entity boundary"];
  if (boundary === "decision") return decisionMigrationProvenanceViolations(record, provenance, declared, model.forbiddenAliases, sourceRoot, sourceBinding);
  if (boundary === "decision_revision") return decisionRevisionMigrationProvenanceViolations(record, provenance, declared, sourceRoot, sourceBinding);
  return ["migration_provenance is declared only for canonical decisions and decision revisions"];
}

function relative(projectRoot: string, candidate: string): string {
  return path.relative(path.resolve(projectRoot), candidate).split(path.sep).join("/") || ".";
}

function recovery(projectRoot: string, action: string): string {
  return `${action}; rerun agentera check validate state --cwd ${JSON.stringify(path.resolve(projectRoot))}`;
}

export function discoverFile(projectRoot: string, file: string, pathArtifact: string, boundary: string, model: EntityAuthority, issues: EntityDiagnostic[], sourceRoot?: string, sourceBinding?: MigrationSourceBindingContext): DiscoveredEntity {
  const relativePath = relative(projectRoot, file);
  const filenameId = path.basename(file, path.extname(file));
  let document: Record<string, unknown> | null = null;
  let discoveredBytes: Buffer | null = null;
  try {
    discoveredBytes = fs.readFileSync(file);
    if (!isUtf8(discoveredBytes)) throw new Error("entity file is not valid UTF-8");
    document = loadYamlMapping(discoveredBytes.toString("utf8"));
  } catch (error) {
    issues.push({
      code: "malformed_entity",
      path: relativePath,
      message: `entity '${relativePath}' is not a YAML mapping: ${(error as Error).message}`,
      recovery: recovery(projectRoot, `replace '${relativePath}' with a valid UTF-8 YAML id/artifact/record entity envelope or remove it`),
    });
  }
  const id = typeof document?.id === "string" ? document.id : filenameId;
  const artifact = typeof document?.artifact === "string" ? document.artifact : pathArtifact;
  const record = mapping(document?.record) ? (document.record as JsonObject) : null;
  const migrationProvenanceValue = document?.migration_provenance;
  const migrationProvenance = mapping(migrationProvenanceValue) ? (migrationProvenanceValue as JsonObject) : null;
  let malformed = document === null;
  if (!model.pattern.test(filenameId) || id !== filenameId || typeof document?.id !== "string" || typeof document?.artifact !== "string" || record === null || document === null || Object.keys(document).some((key) => !["id", "artifact", "record", "migration_provenance"].includes(key))) {
    malformed = true;
    if (document !== null) {
      issues.push({
        code: "malformed_entity",
        path: relativePath,
        id,
        artifact,
        boundary,
        message: `entity '${relativePath}' has an invalid canonical envelope; id and filename must match ${model.pattern.source}`,
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
        recovery: recovery(projectRoot, owner ? `move '${relativePath}' under .agentera/entities/${owner.artifact}/${boundary}/ and set artifact to '${owner.artifact}'` : `move or rewrite '${relativePath}' using a boundary declared by the state storage authority`),
      });
    }
  }
  if (!malformed && owner?.record && record) {
    const violations = [...canonicalEntityRecordViolationsAgainstModel(boundary, record, model, sourceBinding), ...migrationProvenanceViolations(boundary, record, migrationProvenanceValue, model, sourceRoot, sourceBinding)];
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
    const violations = decisionRevisionEntityViolations(record, decisionRevisionContract(sourceRoot), migrationProvenance?.kind === "inherited_decision_revision_confidence");
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
    if (!mapping(record.header) || typeof header.title !== "string" || typeof header.created !== "string" || !["open", "complete", "archived"].includes(String(header.status)) || (record.replacement_input_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(record.replacement_input_sha256)))) {
      malformed = true;
      issues.push({
        code: "malformed_entity",
        path: relativePath,
        id,
        artifact,
        boundary,
        message: `entity '${relativePath}' has invalid plan lifecycle or replacement identity fields`,
        recovery: recovery(projectRoot, `repair '${relativePath}' using the current plan header schema, open|complete|archived lifecycle, and lowercase SHA-256 replacement identity`),
      });
    }
  }
  if (!malformed && boundary === "plan_task" && record) {
    if (planTaskRecordViolations(record).length) {
      malformed = true;
      issues.push({
        code: "malformed_entity",
        path: relativePath,
        id,
        artifact,
        boundary,
        message: `entity '${relativePath}' has invalid plan task or evaluation fields`,
        recovery: recovery(projectRoot, `repair '${relativePath}' using the current plan task and evaluation schema`),
      });
    }
  }
  if (!malformed && boundary === "experiment" && record) {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(record.date ?? "")) || !["baseline", "kept", "discarded"].includes(String(record.status))) {
      malformed = true;
      issues.push({
        code: "malformed_entity",
        path: relativePath,
        id,
        artifact,
        boundary,
        message: `entity '${relativePath}' has invalid experiment date or status`,
        recovery: recovery(projectRoot, `repair '${relativePath}' using YYYY-MM-DD HH:MM and baseline|kept|discarded`),
      });
    }
  }
  if (!malformed && (boundary === "todo_item" || boundary === "documentation_inventory_entry") && record) {
    const violations = todoDocsRecordViolations(boundary, record, sourceRoot);
    if (violations.length) {
      malformed = true;
      issues.push({
        code: "malformed_entity",
        path: relativePath,
        id,
        artifact,
        boundary,
        message: `entity '${relativePath}' has an invalid ${boundary} record: ${violations.join("; ")}`,
        recovery: recovery(projectRoot, `repair '${relativePath}' using the authority-declared ${boundary} fields`),
      });
    }
  }
  return {
    id,
    artifact,
    boundary,
    record,
    migrationProvenance,
    discoveredBytes,
    path: file,
    relativePath,
    classification: malformed ? "malformed" : "valid",
  };
}

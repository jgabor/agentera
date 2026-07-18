import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import { discoverPlanArtifacts, planDocumentParts } from "../cli/planArtifacts.js";
import { parseTodoMarkdownListItem } from "../cli/todoMarkdown.js";
import { assertRealpathBoundary, docsPathOverridesFromBytes, loadArtifactRecord, resolveArtifactPath } from "../registries/artifactRegistry.js";
import { canonicalRecordJson, validateStateRecord } from "./archiveDiscovery.js";
import { canonicalEntityEnvelopeBytes, validateCanonicalEntityTargets } from "./entityStorage.js";
import { discoverObjectiveArtifacts, inspectExperimentIdentities } from "./experimentIdentity.js";
import { decisionRevisionContract, decisionRevisionViolations } from "./decisionRevision.js";
import { assertValidatedProjectRoot, validateRealProjectRoot, type ValidatedProjectRoot } from "./projectRoot.js";
import { todoDocsRecordViolations } from "./todoDocsEntityValidation.js";
import { yamlArchiveEntry } from "../hooks/compaction/retention.js";
import { truncateWords } from "../hooks/compaction/dryRun.js";
import { legacyIdentity } from "./legacyIdentity.js";
import {
  projectPathIsStable as migrationPathIsStable,
  readProjectFileSnapshot,
  resolveProjectDescriptorPath,
  snapshotProjectPath as snapshotMigrationPath,
  type ProjectDescriptorPathResolver as DescriptorPathResolver,
} from "./safeProjectFile.js";

export type EntityMigrationClassification =
  | "verified_full"
  | "recoverable_degraded_full_projection"
  | "irrecoverable_summary_only"
  | "duplicate"
  | "conflict"
  | "corrupt"
  | "unsupported"
  | "historical_projection_residue";

export interface EntityMigrationRelationship {
  field: string;
  target_source_identity: string | null;
  target_id: string | null;
  status: "resolved" | "unresolved";
}

export interface EntityMigrationEntry {
  source_identity: string;
  source_paths: string[];
  artifact: string | null;
  boundary: string | null;
  classification: EntityMigrationClassification;
  detail_availability: "full" | "summary_only" | "unavailable";
  provenance: string[];
  content_sha256: string | null;
  content_sha256s: string[];
  physical_record_count: number;
  proposed_target: { id: string; path: string } | null;
  target_sha256: string | null;
  relationships: EntityMigrationRelationship[];
  recovery: string;
  migration_provenance?: JsonObject | JsonObject[];
}

export interface DurableEntityMigrationEntry extends EntityMigrationEntry {
  record: JsonObject;
}

export interface DurableEntityMigrationSource {
  path: string;
  presence: "file" | "missing";
  size: number;
  sha256: string | null;
  mode: number | null;
  dev: string | null;
  ino: string | null;
  type: "file" | null;
  bytes_base64: string | null;
}

export interface DurableEntityMigrationPlan {
  project: string;
  source_fingerprint: string;
  preview_digest: string;
  authority_schema_version: string;
  authority_sha256: string;
  preserved_singletons: EntityMigrationPreview["preserved_singletons"];
  entries: DurableEntityMigrationEntry[];
  preserved_residues: DurableEntityMigrationEntry[];
  sources: DurableEntityMigrationSource[];
  counts: EntityMigrationPreview["counts"];
  diagnostics: EntityMigrationPreview["diagnostics"];
}

export interface EntityMigrationPreview {
  schemaVersion: "agentera.entityMigrationPreview.v1";
  command: "state migrate entities";
  status: "ready" | "blocked";
  mode: "preview";
  project: string;
  read_only: true;
  mutation_intent: false;
  mutation_performed: false;
  source_fingerprint: string;
  preview_digest: string;
  preserved_singletons: Array<{ boundary: string; source_path: string; presence: "file" | "missing" | "unsafe"; content_sha256: string | null; preserved_sections?: string[] }>;
  entries: EntityMigrationEntry[];
  preserved_residues: EntityMigrationEntry[];
  counts: Record<EntityMigrationClassification | "total" | "publishable_entities" | "physical_records" | "logical_identities" | "mirrors" | "duplicates" | "conflicts" | "relationships" | "unresolved_relationships" | "blockers", number>;
  diagnostics: Array<{
    classification: EntityMigrationClassification | "unresolved_relationship";
    path: string;
    source_identity: string;
    relationship_field?: string;
    target_source_identity?: string | null;
    message: string;
    recovery: string;
  }>;
  omitted: boolean;
  omitted_count: number;
  diagnostics_omitted_count: number;
  omission_reason: "result_limit" | "output_byte_budget" | null;
  page_after: string | null;
  next_after: string | null;
  retrieval: { command: string };
  source_contract: { authority: string; authority_schema_version: string; authority_sha256: string; zero_write: true; scalar_truncation: "forbidden"; apply_owner: "full development-channel upgrade --yes" };
}

interface Observation {
  key: string;
  artifact: string;
  boundary: string;
  path: string;
  provenance: string;
  record: JsonObject | null;
  detail: "full" | "summary" | "corrupt";
  relationships: Array<{ field: string; target: string | null }>;
  message?: string;
  migrationProvenance?: JsonObject;
}

type SourceFile =
  | { relative: string; bytes: Buffer; kind: "file"; dev: bigint; ino: bigint; type: "file"; mode: number }
  | { relative: string; bytes: null; kind: "missing" | "unsafe" };

const MAX_OUTPUT_BYTES = 32_768;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const NUMBERED = {
  progress: { file: ".agentera/progress.yaml", collection: "cycles", boundary: "progress_cycle" },
  decisions: { file: ".agentera/decisions.yaml", collection: "decisions", boundary: "decision" },
  health: { file: ".agentera/health.yaml", collection: "audits", boundary: "health_audit" },
} as const;
const BLOCKING = new Set<EntityMigrationClassification>(["irrecoverable_summary_only", "duplicate", "conflict", "corrupt", "unsupported"]);
const INVENTORY_ORDER = "artifact_then_boundary_then_source_identity_then_source_path";
const INVENTORY_FILTER = "complete_declared_inventory";
const AUTHORITY_PATH = "references/artifacts/state-storage-authority.yaml";
const PLAN_ARCHIVE_SOURCE = /^\.agentera\/archive\/PLAN-[^/]+\.ya?ml$/i;

function mapping(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function relative(root: string, target: string): string {
  return path.relative(root, target).replaceAll(path.sep, "/");
}

/** Migration-only source seam: pin one project file to a verified descriptor. */
function readMigrationSource(root: string | ValidatedProjectRoot, relativePath: string, descriptorPathResolver: DescriptorPathResolver): SourceFile {
  return { relative: relativePath, ...readProjectFileSnapshot(root, relativePath, descriptorPathResolver) };
}

function directoryFiles(root: string, validatedRoot: ValidatedProjectRoot, relativeRoot: string, accept: (relativePath: string) => boolean, descriptorPathResolver: DescriptorPathResolver): SourceFile[] {
  const absoluteRoot = path.join(root, relativeRoot);
  type Enumeration = { files: SourceFile[]; changed: string | null };
  const inventoryPath = (directory: string): string => `${relative(root, directory).replace(/\/$/, "")}/`;
  const visit = (directory: string, isRoot = false): Enumeration => {
    assertValidatedProjectRoot(validatedRoot);
    const directorySnapshot = snapshotMigrationPath(root, relative(root, directory), "directory");
    if (directorySnapshot.kind !== "stable") {
      if (directorySnapshot.kind === "missing") return isRoot ? { files: [], changed: null } : { files: [], changed: inventoryPath(directory) };
      if (path.resolve(directorySnapshot.absolute) !== path.resolve(directory)) return { files: [], changed: inventoryPath(directory) };
      if (directorySnapshot.reason === "symlink") throw new Error(`inventory root '${directory}' is a symbolic link; replace it with a real directory inside project '${root}' and retry`);
      if (directorySnapshot.reason === "type") throw new Error(`inventory root '${directory}' is not a directory; replace it with a real directory inside project '${root}' and retry`);
      throw new Error(`inventory root '${directory}' cannot be inspected inside project '${root}'; replace it with a readable real directory and retry`);
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      throw new Error(`inventory root '${directory}' cannot be read inside project '${root}'; replace it with a readable real directory and retry`);
    }
    if (!migrationPathIsStable(directorySnapshot)) return { files: [], changed: inventoryPath(directory) };
    const files: SourceFile[] = [];
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const candidate = relative(root, absolute);
      if (accept(candidate)) {
        files.push(readMigrationSource(validatedRoot, candidate, descriptorPathResolver));
      } else if (entry.isSymbolicLink()) {
        throw new Error(`inventory root '${absolute}' is a symbolic link; replace it with a real directory or file inside project '${root}' and retry`);
      } else if (entry.isDirectory()) {
        const nested = visit(absolute);
        if (nested.changed) return nested;
        files.push(...nested.files);
      }
    }
    assertValidatedProjectRoot(validatedRoot);
    if (!migrationPathIsStable(directorySnapshot)) return { files: [], changed: inventoryPath(directory) };
    return { files, changed: null };
  };
  const enumeration = visit(absoluteRoot, true);
  return enumeration.changed ? [{ relative: enumeration.changed, bytes: null, kind: "unsafe" }] : enumeration.files;
}

function collectSources(root: string, validatedRoot: ValidatedProjectRoot, todoPath: string, docsSnapshot: SourceFile, descriptorPathResolver: DescriptorPathResolver): SourceFile[] {
  const exact = [
    todoPath, "CHANGELOG.md", "DESIGN.md", ".agentera/vision.yaml", ".agentera/docs.yaml", ".agentera/progress.yaml", ".agentera/decisions.yaml", ".agentera/health.yaml", ".agentera/plan.yaml",
    ".agentera/overlays/decisions.yaml", ".agentera/revisions/decisions.yaml", ".agentera/archive/recovery/projection-correlation.yaml",
  ].map((candidate) => candidate === docsSnapshot.relative ? docsSnapshot : readMigrationSource(validatedRoot, candidate, descriptorPathResolver));
  const archives = directoryFiles(root, validatedRoot, ".agentera/archive", (candidate) =>
    /^\.agentera\/archive\/(progress|decisions|health)\/.+/.test(candidate)
      || PLAN_ARCHIVE_SOURCE.test(candidate),
    descriptorPathResolver,
  );
  const objectives = [".agentera/optimize", ".agentera/optimera"].flatMap((directory) =>
    directoryFiles(root, validatedRoot, directory, (candidate) => /\/(objective|experiments)\.yaml$/.test(candidate), descriptorPathResolver),
  );
  const collected = [...exact, ...archives, ...objectives];
  const missingRoots = [".agentera/archive/", ".agentera/optimize/", ".agentera/optimera/"]
    .filter((directory) => {
      if (collected.some((source) => source.kind === "unsafe" && source.relative === directory)) return false;
      try { return !fs.lstatSync(path.join(root, directory)).isDirectory(); } catch { return true; }
    })
    .map((directory): SourceFile => ({ relative: directory, bytes: null, kind: "missing" }));
  const byPath = new Map([...collected, ...missingRoots].map((source) => [source.relative, source]));
  return [...byPath.values()].sort((a, b) => a.relative.localeCompare(b.relative));
}

function authorityBinding(sourceRoot: string): { authority_schema_version: string; authority_sha256: string } {
  const authorityPath = path.join(sourceRoot, AUTHORITY_PATH);
  const bytes = fs.readFileSync(authorityPath);
  const authority = loadYamlMapping(bytes.toString("utf8"));
  if (typeof authority.schema_version !== "string" || !mapping(authority.entity_migration)) {
    throw new Error("active entity migration authority is missing its schema version or entity_migration contract");
  }
  return { authority_schema_version: authority.schema_version, authority_sha256: hash(bytes) };
}

export function entityMigrationAuthorityProjection(sourceRoot = resolveSourceRoot()): JsonObject {
  const authorityPath = path.join(sourceRoot, AUTHORITY_PATH);
  const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  if (!mapping(authority.entity_migration)) throw new Error(`state storage authority '${authorityPath}' has no entity migration contract`);
  return { authority: AUTHORITY_PATH, ...(authority.entity_migration as JsonObject) } as JsonObject;
}

function sourceFingerprint(files: SourceFile[]): string {
  return hash(canonicalRecordJson(files.map((file) => ({
    path: file.relative,
    presence: file.kind,
    size: file.bytes?.byteLength ?? 0,
    sha256: file.bytes ? hash(file.bytes) : null,
    mode: file.kind === "file" ? file.mode : null,
    dev: file.kind === "file" ? String(file.dev) : null,
    ino: file.kind === "file" ? String(file.ino) : null,
    type: file.kind === "file" ? file.type : null,
  }))));
}

function parseYaml(source: SourceFile): JsonObject {
  if (source.kind !== "file" || !source.bytes) throw new Error(source.kind === "unsafe" ? "source path is a symbolic link or non-file" : "source is missing");
  return loadYamlMapping(source.bytes.toString("utf8")) as JsonObject;
}

function recovery(project: string, pathName: string): string {
  return `Repair '${pathName}', then run agentera state migrate entities --project '${project.replaceAll("'", "'\\''")}' --dry-run --format json.`;
}

function unsafeSourceMessage(pathName: string): string {
  return `source path '${pathName}' is a symbolic link, non-file, or unreadable; replace it with a readable regular file inside the project`;
}

function inventoryFailureObservations(files: SourceFile[], observations: Observation[]): void {
  for (const source of files.filter((candidate) => candidate.kind === "unsafe" && candidate.relative.endsWith("/"))) {
    observations.push({
      key: `migration_inventory:${source.relative}`,
      artifact: "state",
      boundary: "migration_inventory",
      path: source.relative,
      provenance: "source_inventory",
      record: null,
      detail: "corrupt",
      relationships: [],
      message: `inventory directory '${source.relative}' changed while it was enumerated; no candidate names were accepted`,
    });
  }
}

function numberedObservations(root: string, sourceRoot: string, files: SourceFile[], observations: Observation[]): void {
  const correlationSource = files.find((source) => source.relative === ".agentera/archive/recovery/projection-correlation.yaml");
  let correlationManifest: Map<string, JsonObject> | null = null;
  if (correlationSource?.kind === "file") {
    try {
      const manifest = parseYaml(correlationSource); const entries = Array.isArray(manifest.entries) ? manifest.entries.map(mapping) : [];
      const validEntries = entries.filter((entry): entry is JsonObject => Boolean(entry));
      const digest = hash(canonicalRecordJson({ schemaVersion: "agentera.projectionCorrelationSet.v1", entries: validEntries }));
      if (manifest.schemaVersion !== "agentera.projectionCorrelationManifest.v1" || manifest.recovery_set_digest !== digest || validEntries.length !== entries.length) throw new Error("projection correlation manifest schema or digest is invalid");
      correlationManifest = new Map(validEntries.map((entry) => [String(entry.identity), entry]));
    } catch (error) {
      observations.push({ key: "projection_correlation:manifest", artifact: "state", boundary: "migration_inventory", path: correlationSource.relative, provenance: "source_inventory", record: null, detail: "corrupt", relationships: [], message: (error as Error).message });
    }
  } else if (correlationSource?.kind === "unsafe") {
    observations.push({ key: "projection_correlation:manifest", artifact: "state", boundary: "migration_inventory", path: correlationSource.relative, provenance: "source_inventory", record: null, detail: "corrupt", relationships: [], message: unsafeSourceMessage(correlationSource.relative) });
  }
  for (const [artifact, declaration] of Object.entries(NUMBERED)) {
    const current = files.find((source) => source.relative === declaration.file);
    if (current?.kind === "file") {
      try {
        const document = parseYaml(current);
        const currentValues = document[declaration.collection];
        if (!Array.isArray(currentValues)) throw new Error(`field '${declaration.collection}' must be a list`);
        const collections: Array<[string, unknown[]]> = [[declaration.collection, currentValues]];
        if (Array.isArray(document.archive)) collections.push(["archive", document.archive]);
        collections.flatMap(([collection, values]) => values.map((value, index) => ({ collection, value, index }))).forEach(({ collection, value, index }) => {
          const record = mapping(value) ?? (typeof value === "string" ? { summary: value } : null);
          const identity = legacyIdentity(record, artifact, "number");
          const number = identity.number;
          const key = number ? `${artifact}:${number}` : `${artifact}:${collection}[${index}]`;
          const valid = record && typeof record.number === "number" ? validateStateRecord(sourceRoot, artifact, record).length === 0 : false;
          const summary = Boolean(record && (typeof record.summary === "string" || record.detail_availability === "summary_only"));
          const text = typeof record?.summary === "string" ? record.summary : "";
          const decisionRefs = artifact === "decisions" ? [...text.matchAll(/\bD([1-9][0-9]*)\b/g)] : [];
          const residue = artifact === "decisions" && decisionRefs.length > 1 && !number;
          observations.push({ key: residue ? `historical_projection_residue:${declaration.file}:${collection}[${index}]` : key, artifact, boundary: residue ? "historical_projection_residue" : declaration.boundary, path: declaration.file, provenance: residue ? "historical_projection_residue" : "current_projection", record, detail: valid ? "full" : summary ? "summary" : "corrupt", relationships: [], message: valid || summary ? undefined : "projection record does not satisfy the declared full-detail schema", ...(residue ? { migrationProvenance: { classification: "historical_projection_residue", path: declaration.file, collection, index, content_sha256: hash(canonicalRecordJson(record)), text, inbound_structured_references: 0 } } : {}) });
          if (artifact === "decisions" && mapping(record?.satisfaction)) {
            observations.push({ key: `decision_satisfaction:${key}`, artifact: "decisions", boundary: "decision_satisfaction", path: declaration.file, provenance: "current_projection", record: mapping(record?.satisfaction), detail: "full", relationships: [{ field: "decision", target: key }] });
          }
        });
      } catch (error) {
        observations.push({ key: `${artifact}:projection`, artifact, boundary: declaration.boundary, path: declaration.file, provenance: "current_projection", record: null, detail: "corrupt", relationships: [], message: (error as Error).message });
      }
    } else if (current?.kind === "unsafe") {
      observations.push({ key: `${artifact}:projection`, artifact, boundary: declaration.boundary, path: declaration.file, provenance: "current_projection", record: null, detail: "corrupt", relationships: [], message: unsafeSourceMessage(declaration.file) });
    }

    for (const source of files.filter((candidate) => candidate.relative.startsWith(`.agentera/archive/${artifact}/`))) {
      const match = new RegExp(`^\\.agentera/archive/${artifact}/([1-9][0-9]*)\\.yaml$`).exec(source.relative);
      if (!match) {
        observations.push({ key: `unsupported:${source.relative}`, artifact, boundary: declaration.boundary, path: source.relative, provenance: "archive", record: null, detail: "corrupt", relationships: [], message: "unsupported archive candidate name" });
        continue;
      }
      const key = `${artifact}:${match[1]}`;
      try {
        const envelope = parseYaml(source);
        const record = mapping(envelope.record);
        if (!record || envelope.artifact_id !== artifact || envelope.entry_number !== Number(match[1])) throw new Error("archive envelope identity does not match its path");
        const expected = hash(canonicalRecordJson(record));
        if (envelope.record_sha256 !== expected) throw new Error("archive record_sha256 does not match record bytes");
        if (mapping(envelope.recovery_provenance)) {
          const correlation = correlationManifest?.get(key);
          if (!correlation) throw new Error("recovered archive is absent from the immutable projection correlation manifest");
          if (correlation.artifact !== artifact || correlation.identity !== key || correlation.archive_sha256 !== hash(source.bytes!)
            || mapping(correlation.overlay)?.final_record_sha256 !== expected) throw new Error("recovered archive does not match its immutable projection correlation manifest entry");
        }
        const violations = validateStateRecord(sourceRoot, artifact, record);
        if (violations.length > 0) throw new Error(`archive record is invalid: ${violations.join("; ")}`);
        observations.push({ key, artifact, boundary: declaration.boundary, path: source.relative, provenance: "verified_archive", record, detail: "full", relationships: [], ...(mapping(envelope.recovery_provenance) ? { migrationProvenance: mapping(envelope.recovery_provenance)! } : {}) });
        if (artifact === "decisions" && mapping(record.satisfaction)) {
          observations.push({
            key: `decision_satisfaction:${key}`,
            artifact: "decisions",
            boundary: "decision_satisfaction",
            path: source.relative,
            provenance: "verified_archive",
            record: mapping(record.satisfaction),
            detail: "full",
            relationships: [{ field: "decision", target: key }],
            ...(mapping(envelope.recovery_provenance) ? { migrationProvenance: { kind: "nested_verified_archive_evidence", source: mapping(envelope.recovery_provenance)! } } : {}),
          });
        }
      } catch (error) {
        observations.push({ key, artifact, boundary: declaration.boundary, path: source.relative, provenance: "archive", record: null, detail: "corrupt", relationships: [], message: (error as Error).message });
      }
    }
  }
}

function decisionEvidence(sourceRoot: string, files: SourceFile[], observations: Observation[]): void {
  const overlay = files.find((source) => source.relative === ".agentera/overlays/decisions.yaml");
  if (overlay?.kind === "file") {
    try {
      const document = parseYaml(overlay);
      for (const [identity, value] of Object.entries(document).sort(([a], [b]) => a.localeCompare(b))) {
        const record = mapping(value);
        const match = /^decisions:([1-9][0-9]*)$/.exec(identity);
        const satisfaction = mapping(record?.satisfaction);
        observations.push({ key: `decision_satisfaction:${identity}`, artifact: "decisions", boundary: "decision_satisfaction", path: overlay.relative, provenance: "overlay", record: satisfaction, detail: match && satisfaction ? "full" : "corrupt", relationships: [{ field: "decision", target: match ? `decisions:${match[1]}` : null }], message: match && satisfaction ? undefined : "decision satisfaction overlay has an unsupported identity or shape" });
      }
    } catch (error) {
      observations.push({ key: "decision_satisfaction:overlay", artifact: "decisions", boundary: "decision_satisfaction", path: overlay.relative, provenance: "overlay", record: null, detail: "corrupt", relationships: [{ field: "decision", target: null }], message: (error as Error).message });
    }
  } else if (overlay?.kind === "unsafe") {
    observations.push({ key: "decision_satisfaction:overlay", artifact: "decisions", boundary: "decision_satisfaction", path: overlay.relative, provenance: "overlay", record: null, detail: "corrupt", relationships: [], message: unsafeSourceMessage(overlay.relative) });
  }
  const revisions = files.find((source) => source.relative === ".agentera/revisions/decisions.yaml");
  if (revisions?.kind === "file") {
    try {
      const document = parseYaml(revisions);
      const contract = decisionRevisionContract(sourceRoot);
      for (const [identity, value] of Object.entries(document).sort(([left], [right]) => left.localeCompare(right))) {
        const target = new RegExp(`^${contract.identityPrefix}:[1-9][0-9]*$`).test(identity) ? identity : null;
        if (!Array.isArray(value)) {
          observations.push({ key: `decision_revision:${identity}`, artifact: "decisions", boundary: "decision_revision", path: revisions.relative, provenance: "revision", record: null, detail: "corrupt", relationships: [{ field: "decision", target }], message: `${identity} must be an ordered list of revision records` });
          continue;
        }
        value.forEach((candidate, index) => {
          const record = mapping(candidate);
          const violations = decisionRevisionViolations({ [identity]: [candidate] }, contract);
          observations.push({ key: `decision_revision:${identity}:${index}`, artifact: "decisions", boundary: "decision_revision", path: revisions.relative, provenance: "revision", record, detail: record && violations.length === 0 ? "full" : "corrupt", relationships: [{ field: "decision", target }], message: violations.length === 0 ? undefined : violations.join("; ") });
        });
      }
    } catch (error) {
      observations.push({ key: "decision_revision:document", artifact: "decisions", boundary: "decision_revision", path: revisions.relative, provenance: "revision", record: null, detail: "corrupt", relationships: [{ field: "decision", target: null }], message: (error as Error).message });
    }
  } else if (revisions?.kind === "unsafe") {
    observations.push({ key: "decision_revision:document", artifact: "decisions", boundary: "decision_revision", path: revisions.relative, provenance: "revision", record: null, detail: "corrupt", relationships: [], message: unsafeSourceMessage(revisions.relative) });
  }
}

function planObservations(root: string, files: SourceFile[], observations: Observation[]): void {
  const active = path.join(root, ".agentera", "plan.yaml");
  const activeSource = files.find((source) => source.relative === ".agentera/plan.yaml");
  const archiveBytes = new Map(files.flatMap((source): Array<[string, Buffer]> =>
    source.kind === "file" && PLAN_ARCHIVE_SOURCE.test(source.relative)
      ? [[path.join(root, source.relative), source.bytes]]
      : [],
  ));
  const discovery = discoverPlanArtifacts(active, {
    activeBytes: activeSource?.kind === "file" ? activeSource.bytes : null,
    archiveBytes,
  });
  const seen = new Set<string>();
  if (activeSource?.kind === "unsafe") {
    observations.push({ key: "plan:document", artifact: "plan", boundary: "plan", path: activeSource.relative, provenance: "current_canonical", record: null, detail: "corrupt", relationships: [], message: unsafeSourceMessage(activeSource.relative) });
  }
  for (const identity of discovery.identities) {
    const marker = `${identity.stableId}\0${identity.artifact.path}`;
    if (seen.has(marker)) continue;
    seen.add(marker);
    const sourcePath = relative(root, identity.artifact.path);
    const archived = identity.artifact.path !== active;
    const source = files.find((candidate) => candidate.relative === sourcePath);
    let sourceStatus = String((mapping(identity.artifact.data.header) ?? {}).status ?? "");
    if (source?.kind === "file") {
      const sourceDocument = parseYaml(source);
      sourceStatus = String((mapping(sourceDocument.header) ?? {}).status ?? "");
    }
    const planRecord = structuredClone(identity.artifact.data);
    const migratedHeader = mapping(planRecord.header);
    if (archived && migratedHeader) migratedHeader.status = "archived";
    const migrationProvenance = archived ? {
      ...identity.artifact.migrationProvenance,
      source_path: sourcePath,
      source_lifecycle: "verified_plan_archive",
      source_status: sourceStatus,
      target_status: "archived",
    } : identity.artifact.migrationProvenance ? { ...identity.artifact.migrationProvenance, source_path: sourcePath } : undefined;
    const classificationDetail = identity.ambiguous ? "corrupt" : "full";
    observations.push({ key: identity.stableId, artifact: "plan", boundary: "plan", path: sourcePath, provenance: archived ? "verified_plan_archive" : "current_canonical", record: planRecord, detail: classificationDetail, relationships: [], message: identity.ambiguous ? "plan identity resolves to conflicting documents" : undefined, ...(migrationProvenance ? { migrationProvenance } : {}) });
    const parts = planDocumentParts(identity.artifact.data);
    parts.tasks.forEach((task, index) => {
      const number = task.number;
      const taskKey = typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? `${identity.stableId}/task:${number}` : `${identity.stableId}/task:index:${index}`;
      const depends = Array.isArray(task.depends_on) ? task.depends_on : [];
      observations.push({
        key: taskKey,
        artifact: "plan",
        boundary: "plan_task",
        path: sourcePath,
        provenance: identity.artifact.path === active ? "current_canonical" : "verified_plan_archive",
        record: task,
        detail: typeof number === "number" ? classificationDetail : "corrupt",
        relationships: [
          { field: "plan", target: identity.stableId },
          ...depends.map((dependency) => { const normalized = /^Task ([1-9][0-9]*)$/.exec(String(dependency))?.[1] ?? String(dependency); return { field: "depends_on", target: /^[1-9][0-9]*$/.test(normalized) ? `${identity.stableId}/task:${normalized}` : null }; }),
        ],
        message: typeof number === "number" ? undefined : "plan task has no positive structured number",
        ...(identity.artifact.migrationProvenance ? { migrationProvenance: { ...identity.artifact.migrationProvenance, source_path: sourcePath, source_task_index: index } } : {}),
      });
    });
  }
  for (const diagnostic of discovery.diagnostics.filter((item) => !seen.has(`${item.path}\0diagnostic`))) {
    if (discovery.identities.some((identity) => identity.artifact.path === diagnostic.path)) continue;
    const sourcePath = relative(root, diagnostic.path);
    observations.push({ key: `plan:corrupt:${sourcePath}`, artifact: "plan", boundary: "plan", path: sourcePath, provenance: "plan_candidate", record: null, detail: "corrupt", relationships: [], message: diagnostic.message });
  }
  for (const source of files.filter((candidate) => PLAN_ARCHIVE_SOURCE.test(candidate.relative))) {
    if (!discovery.identities.some((identity) => relative(root, identity.artifact.path) === source.relative) && !observations.some((entry) => entry.path === source.relative)) {
      observations.push({ key: `plan:corrupt:${source.relative}`, artifact: "plan", boundary: "plan", path: source.relative, provenance: "plan_candidate", record: null, detail: "corrupt", relationships: [], message: source.kind === "unsafe" ? unsafeSourceMessage(source.relative) : "plan archive could not be validated" });
    }
  }
}

function objectiveObservations(root: string, files: SourceFile[], observations: Observation[]): void {
  const sourceBytes = new Map(files.flatMap((source): Array<[string, Buffer]> =>
    source.kind === "file" && /^\.agentera\/(optimize|optimera)\/.+\/(objective|experiments)\.yaml$/.test(source.relative)
      ? [[path.join(root, source.relative), source.bytes]]
      : [],
  ));
  const discovery = discoverObjectiveArtifacts(root, sourceBytes);
  for (const objective of discovery.objectives) {
    for (const objectivePath of objective.paths) {
      const sourcePath = relative(root, objectivePath);
      const source = files.find((candidate) => candidate.relative === sourcePath);
      let document: JsonObject | null = null;
      try { if (source?.kind === "file") document = parseYaml(source); } catch { /* discovery diagnostic accounts for it */ }
      observations.push({ key: objective.stableId, artifact: "objective", boundary: "objective", path: sourcePath, provenance: sourcePath.startsWith(".agentera/optimize/") ? "current_canonical" : "legacy_objective_root", record: document, detail: objective.ambiguous || !document ? "corrupt" : "full", relationships: [], message: objective.ambiguous ? "objective identity is ambiguous" : undefined });
    }
    if (objective.ambiguous) continue;
    const objectivePath = objective.paths[0];
    const experimentsRelative = relative(root, path.join(path.dirname(objectivePath), "experiments.yaml"));
    const experiments = files.find((source) => source.relative === experimentsRelative);
    if (experiments?.kind === "file") {
      try {
        const document = parseYaml(experiments);
        for (const experiment of inspectExperimentIdentities(objective.stableId, document).entries) {
          const key = experiment.stableId ?? `${objective.stableId}/experiment:${experiment.provenance.collection}[${experiment.provenance.index}]`;
          observations.push({ key, artifact: "experiments", boundary: "experiment", path: experiments.relative, provenance: "experiment_projection", record: experiment.data, detail: experiment.addressable ? "full" : experiment.compatibility === "legacy_missing_identity" ? "summary" : "corrupt", relationships: [{ field: "objective", target: objective.stableId }], message: experiment.caveats.join("; ") || undefined });
        }
      } catch (error) {
        observations.push({ key: `${objective.stableId}/experiments`, artifact: "experiments", boundary: "experiment", path: experiments.relative, provenance: "experiment_projection", record: null, detail: "corrupt", relationships: [{ field: "objective", target: objective.stableId }], message: (error as Error).message });
      }
    } else if (experiments?.kind === "unsafe") {
      observations.push({ key: `${objective.stableId}/experiments`, artifact: "experiments", boundary: "experiment", path: experiments.relative, provenance: "experiment_projection", record: null, detail: "corrupt", relationships: [{ field: "objective", target: objective.stableId }], message: unsafeSourceMessage(experiments.relative) });
    }
  }
  for (const diagnostic of discovery.diagnostics) {
    for (const candidate of diagnostic.candidate_paths) {
      if (observations.some((entry) => entry.path === relative(root, candidate))) continue;
      observations.push({ key: `objective:corrupt:${relative(root, candidate)}`, artifact: "objective", boundary: "objective", path: relative(root, candidate), provenance: "objective_candidate", record: null, detail: "corrupt", relationships: [], message: diagnostic.message });
    }
  }
  for (const source of files.filter((candidate) => candidate.kind === "unsafe" && /\/(objective|experiments)\.yaml$/.test(candidate.relative))) {
    if (observations.some((entry) => entry.path === source.relative)) continue;
    const artifact = source.relative.endsWith("/objective.yaml") ? "objective" : "experiments";
    observations.push({ key: `${artifact}:corrupt:${source.relative}`, artifact, boundary: artifact === "objective" ? "objective" : "experiment", path: source.relative, provenance: artifact === "objective" ? "objective_candidate" : "experiment_projection", record: null, detail: "corrupt", relationships: [], message: unsafeSourceMessage(source.relative) });
  }
}

function todoAndDocs(root: string, todoPath: string, files: SourceFile[], observations: Observation[]): void {
  const todo = files.find((source) => source.relative === todoPath);
  if (todo?.kind === "file" && todo.bytes) {
    let section = "normal";
    todo.bytes.toString("utf8").split(/\r?\n/).forEach((line, index) => {
      const heading = line.trim().match(/^##\s+(.+)$/)?.[1]?.toLowerCase();
      if (heading) section = heading.includes("critical") ? "critical" : heading.includes("degraded") ? "degraded" : heading.includes("annoying") ? "annoying" : heading.includes("resolved") ? "resolved" : heading.includes("normal") ? "normal" : section;
      const item = parseTodoMarkdownListItem(line.trim());
      if (!item) return;
      const severity = section === "resolved" ? "normal" : section;
      const record = { severity, status: item.status, description: item.description };
      const violations = todoDocsRecordViolations("todo_item", record);
      observations.push({ key: `${todoPath}:line:${index + 1}`, artifact: "todo", boundary: "todo_item", path: todoPath, provenance: "current_canonical", record, detail: violations.length ? "corrupt" : "full", relationships: [], message: violations.length ? violations.join("; ") : undefined });
    });
  } else if (todo?.kind === "unsafe") {
    observations.push({ key: "todo:document", artifact: "todo", boundary: "todo_item", path: todoPath, provenance: "current_canonical", record: null, detail: "corrupt", relationships: [], message: unsafeSourceMessage(todoPath) });
  }
  const docs = files.find((source) => source.relative === ".agentera/docs.yaml");
  if (docs?.kind === "file") {
    try {
      const document = parseYaml(docs);
      if (document.index !== undefined && !Array.isArray(document.index)) throw new Error("docs index must be a list");
      (Array.isArray(document.index) ? document.index : []).forEach((value, index) => {
        const sourceRecord = mapping(value);
        const originalStatus = sourceRecord?.status;
        const normalizedStatus = originalStatus === "draft" ? "intent" : originalStatus === "archived" ? "stale" : originalStatus;
        const record: JsonObject | null = sourceRecord ? { ...structuredClone(sourceRecord), ...(normalizedStatus !== originalStatus ? { status: normalizedStatus } : {}) } as JsonObject : null;
        const identity = typeof record?.path === "string" ? `docs:path:${record.path}` : `docs:index:${index}`;
        const violations = record ? todoDocsRecordViolations("documentation_inventory_entry", record) : ["documentation inventory entry must be a mapping"];
        observations.push({ key: identity, artifact: "docs", boundary: "documentation_inventory_entry", path: docs.relative, provenance: "current_canonical", record, detail: violations.length ? "corrupt" : "full", relationships: [], message: violations.length ? violations.join("; ") : undefined, ...(normalizedStatus !== originalStatus ? { migrationProvenance: { kind: "legacy_docs_status_normalization", source_path: docs.relative, index, ...(sourceRecord?.path !== undefined ? { original_path: sourceRecord.path } : {}), ...(originalStatus !== undefined ? { original_status: originalStatus } : {}), ...(normalizedStatus !== undefined ? { normalized_status: normalizedStatus } : {}) } } : {}) });
      });
    } catch (error) {
      observations.push({ key: "docs:document", artifact: "docs", boundary: "documentation_inventory_entry", path: docs.relative, provenance: "current_canonical", record: null, detail: "corrupt", relationships: [], message: (error as Error).message });
    }
  } else if (docs?.kind === "unsafe") {
    observations.push({ key: "docs:document", artifact: "docs", boundary: "documentation_inventory_entry", path: docs.relative, provenance: "current_canonical", record: null, detail: "corrupt", relationships: [], message: unsafeSourceMessage(docs.relative) });
  }
}

function preservedSingletons(files: SourceFile[]): EntityMigrationPreview["preserved_singletons"] {
  const declarations = [
    { boundary: "vision", source_path: ".agentera/vision.yaml" },
    { boundary: "design", source_path: "DESIGN.md" },
    { boundary: "changelog", source_path: "CHANGELOG.md" },
    { boundary: "docs_mapping", source_path: ".agentera/docs.yaml", preserved_sections: ["last_audit", "conventions", "mapping", "coverage", "audit_log"] },
    { boundary: "profile", source_path: "$AGENTERA_PROFILE_DIR/PROFILE.md" },
    { boundary: "runtime_local_session_state", source_path: "runtime-local" },
  ];
  return declarations.map((declaration) => {
    const source = files.find((candidate) => candidate.relative === declaration.source_path);
    return { ...declaration, presence: source?.kind ?? "missing", content_sha256: source?.bytes ? hash(source.bytes) : null };
  });
}

function previewId(fingerprint: string, key: string): string {
  const bytes = createHash("sha256").update(`agentera.entity-preview.v1\0${fingerprint}\0${key}`, "utf8").digest();
  return Array.from(bytes.subarray(0, 10), (byte) => String.fromCharCode(97 + byte % 26)).join("");
}

function classify(group: Observation[]): EntityMigrationClassification {
  if (group.some((item) => item.provenance === "historical_projection_residue")) return "historical_projection_residue";
  if (group.some((item) => item.key.startsWith("unsupported:"))) return "unsupported";
  if (group.some((item) => item.detail === "corrupt")) return "corrupt";
  if (group.every((item) => item.detail === "summary")) return "irrecoverable_summary_only";
  const full = group.filter((item) => item.detail === "full" && item.record);
  const bodies = new Set(full.map((item) => canonicalRecordJson(item.record)));
  if (bodies.size > 1) return "duplicate";
  const projections = full.filter((item) => item.provenance === "current_projection");
  const archive = group.find((item) => item.provenance === "verified_archive" && item.record);
  const summaries = group.filter((item) => item.detail === "summary" && item.record);
  if (archive && summaries.length) {
    const recovery = archive.migrationProvenance;
    const recorded = mapping(recovery?.current_projection)?.record_sha256;
    const proven = summaries.every((item) => exactProjectionMirror(item.artifact, archive.record!, item.record!, recorded));
    return proven ? "verified_full" : "conflict";
  }
  if (archive || group.some((item) => item.provenance === "verified_plan_archive")) return "verified_full";
  if (group.every((item) => item.provenance === "current_projection" || item.provenance === "experiment_projection")) return "recoverable_degraded_full_projection";
  return "verified_full";
}

function exactProjectionMirror(artifact: string, full: JsonObject, summary: JsonObject, recorded: unknown): boolean {
  if (recorded === hash(canonicalRecordJson(summary))) return true;
  if (artifact === "health" && typeof summary.summary === "string" && typeof full.number === "number" && typeof full.date === "string" && typeof full.trajectory === "string") {
    return summary.summary === `Audit ${full.number} · ${full.date} (${truncateWords(full.trajectory, 10)})`;
  }
  if (artifact !== "progress" && artifact !== "decisions" && artifact !== "health") return false;
  return canonicalRecordJson(yamlArchiveEntry(artifact, full)) === canonicalRecordJson(summary);
}

function canonicalMigrationRecord(boundary: string, source: JsonObject, relationships: EntityMigrationRelationship[]): JsonObject {
  const record = structuredClone(source);
  for (const field of ["id", "artifact", "number", "stable_id", "artifact_id", "entry_number", "task_number", "plan_id", "objective_id", "experiment_number"]) delete record[field];
  if (boundary === "decision") delete record.satisfaction;
  if (boundary === "plan" || boundary === "objective") {
    const header = record.header;
    if (mapping(header)) delete (header as JsonObject).id;
  }
  if (boundary === "plan") {
    delete record.tasks;
    delete record.previous_plan_archived;
    const header = record.header;
    if (mapping(header)) {
      const planHeader = header as JsonObject;
      if (planHeader.status === "active") planHeader.status = "open";
      if (planHeader.status === "completed") planHeader.status = "complete";
    }
  }
  for (const relationship of relationships) {
    if (relationship.field === "depends_on") {
      record.depends_on = relationships.filter(({ field }) => field === "depends_on").map(({ target_id }) => target_id as string);
    } else {
      record[relationship.field] = relationship.target_id as string;
    }
  }
  return record;
}

function buildEntries(project: string, fingerprint: string, observations: Observation[]): DurableEntityMigrationEntry[] {
  const groups = new Map<string, Observation[]>();
  for (const observation of observations) groups.set(observation.key, [...(groups.get(observation.key) ?? []), observation]);
  const ids = new Map<string, string>();
  for (const key of [...groups.keys()].sort()) ids.set(key, previewId(fingerprint, key));
  const collisions = new Set<string>();
  const idOwners = new Map<string, string>();
  for (const [key, id] of ids) {
    const owner = idOwners.get(id);
    if (owner) { collisions.add(owner); collisions.add(key); } else idOwners.set(id, key);
  }
  const entries = [...groups.entries()].map(([key, group]): DurableEntityMigrationEntry => {
    let classification = classify(group);
    if (collisions.has(key)) classification = "conflict";
    const primary = group[0];
    const content = group.find((item) => item.provenance === "verified_archive" && item.record)?.record ?? group.find((item) => item.record)?.record ?? null;
    const contentSha256s = [...new Set(group.flatMap((item) => item.record ? [hash(canonicalRecordJson(item.record))] : []))].sort();
    const mirrored = contentSha256s.length === 1 && group.filter((item) => item.record).length > 1;
    const id = ids.get(key) as string;
    const relationshipSources = new Map(group.flatMap((item) => item.relationships).map((relationship) => [`${relationship.field}\0${relationship.target ?? ""}`, relationship])).values();
    const relationships = [...relationshipSources].map((relationship): EntityMigrationRelationship => ({
      field: relationship.field,
      target_source_identity: relationship.target,
      target_id: relationship.target ? ids.get(relationship.target) ?? null : null,
      status: relationship.target && groups.has(relationship.target) ? "resolved" : "unresolved",
    }));
    const record = content ? canonicalMigrationRecord(primary.boundary, content, relationships) : {};
    const residue = classification === "historical_projection_residue";
    const blocked = BLOCKING.has(classification) || relationships.some((relationship) => relationship.status === "unresolved");
    return {
      source_identity: key,
      source_paths: [...new Set(group.map((item) => item.path))].sort(),
      artifact: primary.artifact,
      boundary: primary.boundary,
      classification,
      detail_availability: classification === "irrecoverable_summary_only" ? "summary_only" : content ? "full" : "unavailable",
      provenance: [...new Set([...group.map((item) => item.provenance), ...(mirrored ? ["mirrored"] : [])])].sort(),
      content_sha256: contentSha256s.length === 1 ? contentSha256s[0] : null,
      content_sha256s: contentSha256s,
      physical_record_count: group.length,
      proposed_target: blocked || residue ? null : { id, path: `.agentera/entities/${primary.artifact}/${primary.boundary}/${id}.yaml` },
      target_sha256: null,
      relationships,
      record,
      recovery: blocked ? recovery(project, primary.path) : "none",
      ...(group.some((item) => item.migrationProvenance) ? { migration_provenance: group.flatMap((item) => item.migrationProvenance ? [item.migrationProvenance] : []) } : {}),
    };
  }).sort((a, b) => `${a.artifact}\0${a.boundary}\0${a.source_identity}\0${a.source_paths[0]}`.localeCompare(`${b.artifact}\0${b.boundary}\0${b.source_identity}\0${b.source_paths[0]}`));
  const decisions = new Map(entries.filter(({ boundary, proposed_target }) => boundary === "decision" && proposed_target).map((entry) => [entry.proposed_target!.id, entry.record]));
  const groupedRevisions = new Map<string, DurableEntityMigrationEntry[]>();
  for (const entry of entries.filter(({ boundary }) => boundary === "decision_revision")) {
    const decision = entry.relationships.find(({ field }) => field === "decision")?.target_id ?? "";
    groupedRevisions.set(decision, [...(groupedRevisions.get(decision) ?? []), entry]);
  }
  for (const [decision, revisions] of groupedRevisions) {
    let effective = structuredClone(decisions.get(decision) ?? {});
    for (const entry of revisions.sort((left, right) => left.source_identity.localeCompare(right.source_identity, undefined, { numeric: true }))) {
      const source = entry.record;
      const changes = mapping(source.changes) ? structuredClone(source.changes) as JsonObject : Object.fromEntries(Object.entries(source).filter(([field]) => !["decision", "date", "provenance", "base_sha256"].includes(field))) as JsonObject;
      entry.record = { decision, date: source.date, provenance: source.provenance, base_sha256: hash(canonicalRecordJson(effective)), changes };
      effective = { ...effective, ...structuredClone(changes) };
    }
  }
  return entries;
}

export function validateEntityMigrationTargets(project: string, entries: DurableEntityMigrationEntry[], sourceRoot: string): Array<{ sourceIdentity: string; path: string; message: string }> {
  const targets = entries.flatMap((entry) => entry.proposed_target && entry.artifact && entry.boundary ? [{ sourceIdentity: entry.source_identity, path: entry.proposed_target.path, id: entry.proposed_target.id, artifact: entry.artifact, boundary: entry.boundary, record: entry.record }] : []);
  const diagnostics = validateCanonicalEntityTargets(project, targets, sourceRoot);
  for (const entry of entries) {
    if (!entry.proposed_target || !entry.artifact) continue;
    const actual = hash(canonicalEntityEnvelopeBytes({ id: entry.proposed_target.id, artifact: entry.artifact, record: entry.record }));
    if (entry.target_sha256 !== actual) diagnostics.push({ sourceIdentity: entry.source_identity, path: entry.proposed_target.path, message: `canonical target bytes have SHA-256 '${actual}', not manifest binding '${entry.target_sha256 ?? "missing"}'` });
  }
  return diagnostics;
}

function migrationInventory(projectRoot: string, sourceRoot: string, resolveDescriptorPath: DescriptorPathResolver): DurableEntityMigrationPlan {
  const project = path.resolve(projectRoot);
  const validatedProject = validateRealProjectRoot(project);
  const authority = authorityBinding(sourceRoot);
  const todoRecord = loadArtifactRecord("todo");
  if (!todoRecord) throw new Error("artifact registry is missing the canonical 'todo' record");
  const docsSnapshot = { relative: ".agentera/docs.yaml", ...readProjectFileSnapshot(validatedProject, ".agentera/docs.yaml", resolveDescriptorPath) } as SourceFile;
  const overrides = docsSnapshot.kind === "file" ? docsPathOverridesFromBytes(docsSnapshot.bytes) : {};
  const todoAbsolute = todoRecord.displayName in overrides ? resolveArtifactPath(todoRecord, project, { docsPathOverrides: overrides }) : path.join(project, todoRecord.defaultPath);
  const todoPath = relative(project, todoAbsolute);
  if (todoPath !== todoRecord.defaultPath) assertRealpathBoundary(project, todoAbsolute, todoRecord.artifactId);
  const files = collectSources(project, validatedProject, todoPath, docsSnapshot, resolveDescriptorPath);
  const fingerprint = sourceFingerprint(files);
  const observations: Observation[] = [];
  inventoryFailureObservations(files, observations);
  numberedObservations(project, sourceRoot, files, observations);
  decisionEvidence(sourceRoot, files, observations);
  planObservations(project, files, observations);
  objectiveObservations(project, files, observations);
  todoAndDocs(project, todoPath, files, observations);
  const preserved = preservedSingletons(files);
  const completeInventory = buildEntries(project, fingerprint, observations);
  const preservedResidues = completeInventory.filter((entry) => entry.classification === "historical_projection_residue");
  const completeEntries = completeInventory.filter((entry) => entry.classification !== "historical_projection_residue");
  for (const entry of completeEntries) {
    if (entry.proposed_target && entry.artifact) entry.target_sha256 = hash(canonicalEntityEnvelopeBytes({ id: entry.proposed_target.id, artifact: entry.artifact, record: entry.record }));
  }
  const targetDiagnostics = validateEntityMigrationTargets(project, completeEntries, sourceRoot);
  for (const diagnostic of targetDiagnostics) {
    const entry = completeEntries.find((candidate) => candidate.source_identity === diagnostic.sourceIdentity);
    if (!entry) continue;
    entry.classification = "corrupt";
    entry.proposed_target = null;
    entry.target_sha256 = null;
    entry.recovery = recovery(project, entry.source_paths[0]);
  }
  const classes: EntityMigrationClassification[] = ["verified_full", "recoverable_degraded_full_projection", "irrecoverable_summary_only", "duplicate", "conflict", "corrupt", "unsupported", "historical_projection_residue"];
  const counts = Object.fromEntries(classes.map((classification) => [classification, completeInventory.filter((entry) => entry.classification === classification).length])) as EntityMigrationPreview["counts"];
  counts.total = completeInventory.length;
  counts.publishable_entities = completeEntries.filter(({ proposed_target }) => proposed_target !== null).length;
  counts.logical_identities = completeInventory.length;
  counts.physical_records = observations.length;
  counts.mirrors = completeInventory.reduce((total, entry) => total + (entry.provenance.includes("mirrored") ? entry.physical_record_count - 1 : 0), 0);
  counts.duplicates = completeInventory.reduce((total, entry) => total + (entry.classification === "duplicate" ? entry.physical_record_count - 1 : 0), 0);
  counts.conflicts = counts.duplicate + counts.conflict;
  counts.relationships = completeEntries.reduce((total, entry) => total + entry.relationships.length, 0);
  counts.unresolved_relationships = completeEntries.reduce((total, entry) => total + entry.relationships.filter((relationship) => relationship.status === "unresolved").length, 0);
  counts.blockers = completeEntries.filter((entry) => BLOCKING.has(entry.classification) || entry.relationships.some((relationship) => relationship.status === "unresolved")).length;
  const diagnostics: EntityMigrationPreview["diagnostics"] = completeEntries.flatMap((entry) => [
    ...(BLOCKING.has(entry.classification) ? [{ classification: entry.classification, path: entry.source_paths[0], source_identity: entry.source_identity, message: observations.find((item) => item.key === entry.source_identity)?.message ?? `${entry.classification} source requires explicit recovery`, recovery: entry.recovery }] : []),
    ...entry.relationships.filter((relationship) => relationship.status === "unresolved").map((relationship) => {
      const target = relationship.target_source_identity ?? "missing structured reference";
      return { classification: "unresolved_relationship" as const, path: entry.source_paths[0], source_identity: entry.source_identity, relationship_field: relationship.field, target_source_identity: relationship.target_source_identity, message: `source '${entry.source_identity}' relationship '${relationship.field}' references unresolved target '${target}'`, recovery: `Repair relationship '${relationship.field}' on '${entry.source_identity}' to reference an inventoried source identity instead of '${target}', then run agentera state migrate entities --project '${project.replaceAll("'", "'\\''")}' --dry-run --format json.` };
    }),
    ...targetDiagnostics.filter(({ sourceIdentity }) => sourceIdentity === entry.source_identity).map((diagnostic) => ({ classification: "corrupt" as const, path: entry.source_paths[0], source_identity: entry.source_identity, message: `target_invalid: ${diagnostic.message}`, recovery: entry.recovery })),
  ]);
  const digestEntries = completeEntries.map(({ record: _record, ...entry }) => entry);
  const digestResidues = preservedResidues.map(({ record: _record, ...entry }) => entry);
  const digestBody = { source_fingerprint: fingerprint, authority, selectors: { project, filter: INVENTORY_FILTER, order: INVENTORY_ORDER }, entries: digestEntries, preserved_residues: digestResidues, preserved_singletons: preserved, counts, diagnostics };
  const previewDigest = hash(canonicalRecordJson(digestBody));
  const sources = files.map((file): DurableEntityMigrationSource => {
    return { path: file.relative, presence: file.kind === "file" ? "file" : "missing", size: file.bytes?.byteLength ?? 0, sha256: file.bytes ? hash(file.bytes) : null, mode: file.kind === "file" ? file.mode : null, dev: file.kind === "file" ? String(file.dev) : null, ino: file.kind === "file" ? String(file.ino) : null, type: file.kind === "file" ? file.type : null, bytes_base64: file.bytes?.toString("base64") ?? null };
  });
  return { project, source_fingerprint: fingerprint, preview_digest: previewDigest, ...authority, preserved_singletons: preserved, entries: completeEntries, preserved_residues: preservedResidues, sources, counts, diagnostics };
}

export function planEntityMigration(projectRoot: string, sourceRoot: string, options: { resolveDescriptorPath?: DescriptorPathResolver } = {}): DurableEntityMigrationPlan {
  return migrationInventory(projectRoot, sourceRoot, options.resolveDescriptorPath ?? resolveProjectDescriptorPath);
}

export function previewEntityMigration(projectRoot: string, sourceRoot: string, options: {
  limit?: number;
  after?: string;
  sourceFingerprint?: string;
  previewDigest?: string;
  /** Test seam and optional platform strengthening; null means descriptor paths are unavailable. */
  resolveDescriptorPath?: DescriptorPathResolver;
} = {}): EntityMigrationPreview {
  const inventory = migrationInventory(projectRoot, sourceRoot, options.resolveDescriptorPath ?? resolveProjectDescriptorPath);
  const { project, source_fingerprint: fingerprint, preview_digest: previewDigest, preserved_singletons: preserved, counts, diagnostics } = inventory;
  const authority = { authority_schema_version: inventory.authority_schema_version, authority_sha256: inventory.authority_sha256 };
  const completeEntries: EntityMigrationEntry[] = inventory.entries.map(({ record: _record, ...entry }) => entry);
  const preservedResidues: EntityMigrationEntry[] = inventory.preserved_residues.map(({ record: _record, ...entry }) => entry);
  const requestedLimit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const restartCommand = `agentera state migrate entities --project '${project.replaceAll("'", "'\\''")}' --limit ${requestedLimit} --dry-run --format json`;
  if (options.after !== undefined && (options.sourceFingerprint !== fingerprint || options.previewDigest !== previewDigest)) {
    throw new EntityMigrationContinuationError(restartCommand);
  }
  const start = options.after === undefined ? 0 : completeEntries.findIndex((entry) => entry.source_identity === options.after) + 1;
  if (options.after !== undefined && start === 0) throw new Error(`pagination cursor '${options.after}' is not a source identity in the bound inventory; restart without --after`);
  let entries = completeEntries.slice(start, start + requestedLimit);
  const diagnosticsForEntries = (): EntityMigrationPreview["diagnostics"] => {
    const identities = new Set(entries.map((entry) => entry.source_identity));
    return diagnostics.filter((diagnostic) => identities.has(diagnostic.source_identity));
  };
  let omissionReason: EntityMigrationPreview["omission_reason"] = start > 0 || start + entries.length < completeEntries.length ? "result_limit" : null;
  const quotedProject = project.replaceAll("'", "'\\''");
  const base = { schemaVersion: "agentera.entityMigrationPreview.v1", command: "state migrate entities", status: counts.blockers > 0 ? "blocked" : "ready", mode: "preview", project, read_only: true, mutation_intent: false, mutation_performed: false, source_fingerprint: fingerprint, preview_digest: previewDigest, preserved_singletons: preserved, preserved_residues: preservedResidues, counts, source_contract: { authority: AUTHORITY_PATH, ...authority, zero_write: true, scalar_truncation: "forbidden", apply_owner: "full development-channel upgrade --yes" } } as const;
  const serializedBytes = (): number => {
    const pageDiagnostics = diagnosticsForEntries();
    const nextAfter = start + entries.length < completeEntries.length ? entries.at(-1)?.source_identity ?? null : null;
    const command = nextAfter ? `agentera state migrate entities --project '${quotedProject}' --after '${nextAfter.replaceAll("'", "'\\''")}' --source-fingerprint ${fingerprint} --preview-digest ${previewDigest} --limit ${requestedLimit} --dry-run --format json` : restartCommand;
    const body = { ...base, entries, diagnostics: pageDiagnostics, omitted: start > 0 || entries.length < completeEntries.length, omitted_count: completeEntries.length - entries.length, diagnostics_omitted_count: diagnostics.length - pageDiagnostics.length, omission_reason: omissionReason, page_after: options.after ?? null, next_after: nextAfter, retrieval: { command } };
    return Math.max(Buffer.byteLength(JSON.stringify(body, null, 2), "utf8"), Buffer.byteLength(YAML.stringify(body), "utf8"));
  };
  while (entries.length > 0 && serializedBytes() > MAX_OUTPUT_BYTES) {
    entries = entries.slice(0, -1);
    omissionReason = "output_byte_budget";
  }
  if (entries.length === 0 && start < completeEntries.length) throw new Error("the next whole migration entry exceeds the 32768-byte output budget; repair that source before retrying");
  const outputDiagnostics = diagnosticsForEntries();
  const nextAfter = start + entries.length < completeEntries.length ? entries.at(-1)?.source_identity ?? null : null;
  const retrieval = { command: nextAfter ? `agentera state migrate entities --project '${quotedProject}' --after '${nextAfter.replaceAll("'", "'\\''")}' --source-fingerprint ${fingerprint} --preview-digest ${previewDigest} --limit ${requestedLimit} --dry-run --format json` : restartCommand };
  return { ...base, status: base.status as "ready" | "blocked", mode: "preview", entries, diagnostics: outputDiagnostics, omitted: start > 0 || entries.length < completeEntries.length, omitted_count: completeEntries.length - entries.length, diagnostics_omitted_count: diagnostics.length - outputDiagnostics.length, omission_reason: omissionReason, page_after: options.after ?? null, next_after: nextAfter, retrieval };
}

export class EntityMigrationContinuationError extends Error {
  readonly classification = "continuation_changed";
  constructor(readonly restartCommand: string) {
    super(`entity migration continuation no longer matches its source, migration authority, selectors, or order; restart with ${restartCommand}`);
    this.name = "EntityMigrationContinuationError";
  }
}

export class EntityMigrationBindingError extends Error {
  readonly classification = "source_changed";
  readonly restartCommand: string;
  constructor(readonly current: EntityMigrationPreview) {
    const restartCommand = `agentera state migrate entities --project '${current.project.replaceAll("'", "'\\''")}' --dry-run --format json`;
    super(`entity migration source or migration authority changed after preview; rerun ${restartCommand}`);
    this.restartCommand = restartCommand;
    this.name = "EntityMigrationBindingError";
  }
}

export function assertEntityMigrationBinding<T>(expectedSourceFingerprint: string, expectedPreviewDigest: string, current: EntityMigrationPreview, effect: () => T): T {
  if (current.source_fingerprint !== expectedSourceFingerprint || current.preview_digest !== expectedPreviewDigest) throw new EntityMigrationBindingError(current);
  return effect();
}

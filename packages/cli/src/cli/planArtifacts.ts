import fs from "node:fs";
import path from "node:path";

import YAML, { isMap, isScalar, isSeq } from "yaml";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { resolvePlanIdentity } from "../state/planIdentity.js";
import { asList, firstPresent } from "./stateQuery.js";

/** The immutable filenames produced by the typed plan archive writer. */
const PLAN_ARCHIVE_FILE = /^PLAN-.+\.ya?ml$/i;

export interface PlanArtifact {
  path: string;
  data: JsonObject;
  archived: boolean;
  migrationProvenance?: JsonObject;
}

export type PlanDiagnosticCategory = "parse" | "schema" | "lifecycle" | "identity" | "legacy";

export interface PlanArtifactDiagnostic extends JsonObject {
  path: string;
  category: PlanDiagnosticCategory;
  message: string;
}

export interface PlanArtifactDiscovery {
  activePath: string;
  archiveDirectory: string;
  active: PlanArtifact | null;
  archived: PlanArtifact[];
  invalidArchivePaths: string[];
  diagnostics: PlanArtifactDiagnostic[];
  identities: PlanArtifactIdentity[];
}

export interface PlanArtifactIdentity {
  artifact: PlanArtifact;
  stableId: string;
  persisted: boolean;
  canonicalJson: string;
  ambiguous: boolean;
  provenancePaths: string[];
}

export interface PlanDocumentParts {
  header: JsonObject;
  tasks: JsonObject[];
  status: string;
  title: string;
  created: string;
  legacyEntries: boolean;
}

const COMPLETE_TASK_STATUSES = new Set(["complete", "completed", "closed", "done", "resolved", "retired"]);

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLegacyStatus(status: string): string {
  if (status === "active") return "open";
  if (status === "completed") return "complete";
  return status;
}

function planStatus(data: JsonObject): string {
  const header = isMapping(data.header) ? data.header : {};
  return String(firstPresent(header, ["status"], "") || "");
}

function hasYamlMetadata(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const node = value as { anchor?: unknown; tag?: unknown };
  return node.anchor !== undefined || node.tag !== undefined;
}

function hasSafeRange(value: unknown, textLength: number): value is { range: number[] } {
  if (value === null || typeof value !== "object") return false;
  const range = (value as { range?: unknown }).range;
  if (!Array.isArray(range) || range.length < 2 || range.some((offset) => !Number.isInteger(offset))) return false;
  return range[0] >= 0 && range[0] <= range[1] && range[1] <= textLength && (range[2] === undefined || (range[1] <= range[2] && range[2] <= textLength));
}

function hasPlainSequenceItemPrefix(text: string, itemStart: number): boolean {
  const lineStart = text.lastIndexOf("\n", itemStart - 1) + 1;
  return /^[ \t]*-[ \t]+$/.test(text.slice(lineStart, itemStart));
}

function blockScopeItemSources(text: string): Map<string, JsonObject> {
  const sources = new Map<string, JsonObject>();
  const document = YAML.parseDocument(text);
  if (!isMap(document.contents)) return sources;
  const scope = document.contents.get("scope", true);
  if (!isMap(scope)) return sources;
  for (const field of ["included", "excluded", "deferred"]) {
    const sequence = scope.get(field, true);
    if (!isSeq(sequence)) continue;
    sequence.items.forEach((item, index) => {
      if (!isMap(item) || item.flow === true || item.items.length !== 1) return;
      const [pair] = item.items;
      const { key, value } = pair;
      if (!isScalar(key) || !isScalar(value) || typeof key.value !== "string" || typeof value.value !== "string") return;
      if ([item, pair, key, value].some(hasYamlMetadata)) return;
      if (!hasSafeRange(item, text.length) || !hasSafeRange(key, text.length) || !hasSafeRange(value, text.length)) return;
      if (key.range[0] < item.range[0] || key.range[1] > item.range[1] || value.range[0] < item.range[0] || value.range[1] > item.range[1]) return;
      if (!hasPlainSequenceItemPrefix(text, item.range[0])) return;
      const sourceText = text.slice(item.range[0], item.range[1]).trimEnd();
      if (sourceText.includes("\n") || sourceText.includes("\r")) return;
      sources.set(`${field}:${index}`, {
        source_form: "block_single_pair_mapping",
        source_context: `scope.${field}_sequence_item`,
        source_text: sourceText,
        normalized: `${key.value}: ${value.value}`,
      });
    });
  }
  return sources;
}

function normalizePlanDocument(data: JsonObject, archived: boolean, blockScopeItems: Map<string, JsonObject>): { data: JsonObject; provenance?: JsonObject } {
  const header = isMapping(data.header) ? data.header : {};
  const status = planStatus(data);
  const sourceTasks = (Array.isArray(data.entries) ? data.entries : data.tasks) as JsonObject[];
  const incomplete = sourceTasks.some((task) => !taskIsComplete(task));
  const normalizedStatus = normalizeLegacyStatus(status) === "complete" && incomplete ? "open" : normalizeLegacyStatus(status);
  const taskNormalizations: JsonObject[] = [];
  const tasks = sourceTasks.map((source, index) => {
    const task = structuredClone(source);
    const legacy = typeof task.id === "string" ? /^T([1-9][0-9]*)$/.exec(task.id) : null;
    const taskNormalization: JsonObject = { index };
    if (legacy && task.number === undefined) {
      task.number = Number(legacy[1]);
      delete task.id;
      if (task.name === undefined && typeof task.title === "string") {
        task.name = task.title;
        delete task.title;
      }
      Object.assign(taskNormalization, {
        source_id: source.id,
        source_title: source.title,
        normalized_number: task.number,
        normalized_name: task.name,
      });
    }
    const normalizedLists = ["depends_on", "acceptance"].filter((field) => source[field] === undefined || source[field] === null || typeof source[field] === "string");
    if (normalizedLists.length) {
      for (const field of normalizedLists) task[field] = typeof source[field] === "string" && source[field] !== "" ? [source[field]] : [];
      taskNormalization.normalized_list_fields = normalizedLists;
      taskNormalization.source_list_forms = Object.fromEntries(normalizedLists.map((field) => [field, source[field] === undefined ? "absent" : source[field] === null ? "null" : source[field] === "" ? "empty_scalar" : "scalar"]));
    }
    if (Array.isArray(task.acceptance)) {
      const acceptanceItems: JsonObject[] = [];
      task.acceptance = task.acceptance.map((item, acceptanceIndex) => {
        if (!isMapping(item)) return item;
        const pairs = Object.entries(item);
        if (pairs.length !== 1 || typeof pairs[0][1] !== "string") return item;
        const normalized = `${pairs[0][0]}: ${pairs[0][1]}`;
        acceptanceItems.push({ index: acceptanceIndex, source_mapping: item, normalized });
        return normalized;
      });
      if (acceptanceItems.length) taskNormalization.acceptance_mapping_items = acceptanceItems;
    }
    if (task.status === "completed") {
      task.status = "complete";
      taskNormalization.status = { original: "completed", normalized: "complete" };
    }
    if (Object.keys(taskNormalization).length > 1) taskNormalizations.push(taskNormalization);
    if (Array.isArray(task.depends_on))
      task.depends_on = task.depends_on.map((dependency) => {
        const match = /^Task ([1-9][0-9]*)$/.exec(String(dependency));
        return match ? match[1] : dependency;
      });
    return task;
  });
  const normalizedData: JsonObject = {
    ...data,
    header: { ...header, status: normalizedStatus },
    ...(Array.isArray(data.entries) ? { entries: tasks } : { tasks }),
  };
  const changes: JsonObject = {};
  if (status !== normalizedStatus)
    changes.lifecycle = {
      original_status: status,
      normalized_status: normalizedStatus,
      rule: incomplete ? "completed_with_incomplete_tasks_to_open" : "legacy_status",
    };
  if (data.scope === undefined || data.scope === null || data.scope === "") {
    normalizedData.scope = { included: [], excluded: [] };
    changes.scope = {
      source_form: data.scope === undefined ? "absent" : data.scope === null ? "null" : "empty_scalar",
      normalized: "explicit_empty_lists",
    };
  } else if (isMapping(data.scope)) {
    const scope = structuredClone(data.scope);
    const itemNormalizations: JsonObject[] = [];
    for (const field of ["included", "excluded", "deferred"]) {
      if (!Array.isArray(scope[field])) continue;
      scope[field] = scope[field].map((item, index) => {
        if (Array.isArray(item) && item.length === 1 && typeof item[0] === "string") {
          itemNormalizations.push({
            field,
            index,
            source_form: "singleton_sequence",
            source: item,
            normalized: item[0],
          });
          return item[0];
        }
        if (isMapping(item)) {
          const pairs = Object.entries(item);
          const source = blockScopeItems.get(`${field}:${index}`);
          if (pairs.length === 1 && typeof pairs[0][1] === "string" && source?.normalized === `${pairs[0][0]}: ${pairs[0][1]}`) {
            const normalized = source.normalized;
            itemNormalizations.push({ field, index, ...source, source: item });
            return normalized;
          }
        }
        return item;
      });
    }
    normalizedData.scope = scope;
    if (itemNormalizations.length) changes.scope_list_items = itemNormalizations;
  }
  if (taskNormalizations.length) changes.tasks = taskNormalizations;
  return {
    data: normalizedData,
    ...(Object.keys(changes).length ? { provenance: { kind: "legacy_plan_normalization", archived, ...changes } } : {}),
  };
}

/**
 * A plan archive is valid only when it retains the task list (including an
 * intentionally empty list). This keeps unrelated YAML and malformed plan
 * names from replacing a valid archive during discovery.
 */
function isPlanDocument(value: unknown): value is JsonObject {
  if (!isMapping(value) || !isMapping(value.header)) return false;
  const entries = Array.isArray(value.entries) ? value.entries : value.tasks;
  return Array.isArray(entries) && entries.every(isMapping);
}

function taskIsComplete(task: JsonObject): boolean {
  return COMPLETE_TASK_STATUSES.has(String(task.status ?? "").toLowerCase());
}

function inspectionDiagnostic(path: string, category: PlanDiagnosticCategory, message: string): PlanArtifactDiagnostic {
  return { path, category, message };
}

function inspectPlanArtifact(artifactPath: string, archived: boolean, bytes?: Buffer): { artifact: PlanArtifact | null; diagnostics: PlanArtifactDiagnostic[] } {
  let data: unknown;
  let sourceText: string;
  try {
    sourceText = bytes !== undefined ? bytes.toString("utf8") : fs.readFileSync(artifactPath, "utf8");
    data = loadYamlMapping(sourceText);
  } catch (error) {
    const message = (error as Error).message;
    const category = message === "YAML root must be a mapping" ? "schema" : "parse";
    return { artifact: null, diagnostics: [inspectionDiagnostic(artifactPath, category, message)] };
  }
  if (!isPlanDocument(data)) {
    return {
      artifact: null,
      diagnostics: [inspectionDiagnostic(artifactPath, "schema", "plan requires a header mapping and a tasks or entries array of task mappings")],
    };
  }

  const status = planStatus(data);
  if (!["open", "complete", "active", "completed"].includes(status)) {
    return {
      artifact: null,
      diagnostics: [inspectionDiagnostic(artifactPath, "lifecycle", `plan header.status must be open or complete; received ${status || "missing"}`)],
    };
  }

  const diagnostics: PlanArtifactDiagnostic[] = [];
  if (status === "active" || status === "completed") {
    diagnostics.push(inspectionDiagnostic(artifactPath, "legacy", `legacy plan status ${status} normalized to ${normalizeLegacyStatus(status)}`));
  }
  const sourceTasks = (Array.isArray(data.entries) ? data.entries : data.tasks) as JsonObject[];
  if (normalizeLegacyStatus(status) === "complete" && sourceTasks.some((task) => !taskIsComplete(task))) {
    diagnostics.push(inspectionDiagnostic(artifactPath, "legacy", "completed plan with incomplete tasks normalized to open"));
  }
  if (Array.isArray(data.entries)) {
    diagnostics.push(inspectionDiagnostic(artifactPath, "legacy", "legacy entries task shape is read compatibly"));
  }
  const normalized = normalizePlanDocument(data, archived, blockScopeItemSources(sourceText));
  return {
    artifact: {
      path: artifactPath,
      data: normalized.data,
      archived,
      ...(normalized.provenance ? { migrationProvenance: normalized.provenance } : {}),
    },
    diagnostics,
  };
}

export function planDocumentParts(data: JsonObject): PlanDocumentParts {
  const legacyEntries = Array.isArray(data.entries);
  const header = isMapping(data.header) ? data.header : {};
  const rawTasks = legacyEntries ? asList(data.entries) : asList(data.tasks);
  const tasks = rawTasks.filter((task): task is JsonObject => isMapping(task));
  return {
    header,
    tasks,
    status: normalizeLegacyStatus(String(firstPresent(header, ["status"], "") || "")),
    title: String(firstPresent(header, ["title"], data.title ?? "") || ""),
    created: String(firstPresent(header, ["created"], data.created ?? "") || ""),
    legacyEntries,
  };
}

/**
 * Discover the active plan and typed-writer archives. The active path is
 * schema-resolved; its sibling `archive/` directory is the writer-owned
 * history location. Callers with inspected sources can pin active and archive
 * bytes, or pass null to exclude an unsafe active path without following it.
 */
export function discoverPlanArtifacts(activePath: string, options?: { activeBytes: Buffer | null; archiveBytes?: ReadonlyMap<string, Buffer> }): PlanArtifactDiscovery {
  const archiveDirectory = path.join(path.dirname(activePath), "archive");
  const activeInspection = options ? (options.activeBytes === null ? { artifact: null, diagnostics: [] } : inspectPlanArtifact(activePath, false, options.activeBytes)) : fs.existsSync(activePath) ? inspectPlanArtifact(activePath, false) : { artifact: null, diagnostics: [] };
  const active = activeInspection.artifact;
  const archived: PlanArtifact[] = [];
  const invalidArchivePaths: string[] = [];
  const diagnostics = [...activeInspection.diagnostics];

  let archiveSources: Array<[string, Buffer | undefined]> = [];
  if (options?.archiveBytes) {
    archiveSources = [...options.archiveBytes.entries()].filter(([archivePath]) => path.dirname(archivePath) === archiveDirectory && PLAN_ARCHIVE_FILE.test(path.basename(archivePath))).sort(([left], [right]) => left.localeCompare(right));
  } else {
    let names: string[] = [];
    try {
      names = fs.readdirSync(archiveDirectory);
    } catch {
      // A missing archive directory is the normal state before the first archive.
    }
    archiveSources = names
      .filter((candidate) => PLAN_ARCHIVE_FILE.test(candidate))
      .sort()
      .flatMap((name): Array<[string, undefined]> => {
        const archivePath = path.join(archiveDirectory, name);
        try {
          return fs.statSync(archivePath).isFile() ? [[archivePath, undefined]] : [];
        } catch {
          return [];
        }
      });
  }

  for (const [archivePath, bytes] of archiveSources) {
    const inspection = inspectPlanArtifact(archivePath, true, bytes);
    diagnostics.push(...inspection.diagnostics);
    if (inspection.artifact) archived.push(inspection.artifact);
    else invalidArchivePaths.push(archivePath);
  }

  // Lifecycle migration updates bytes and therefore mtimes. Persisted creation
  // dates, followed by the immutable path, keep historical order stable.
  archived.sort((a, b) => {
    const createdDelta = planDocumentParts(b.data).created.localeCompare(planDocumentParts(a.data).created);
    return createdDelta === 0 ? b.path.localeCompare(a.path) : createdDelta;
  });
  const artifacts = [...(active ? [active] : []), ...archived];
  const resolved = artifacts.flatMap((artifact) => {
    try {
      return [{ artifact, ...resolvePlanIdentity(artifact.data) }];
    } catch (error) {
      diagnostics.push(inspectionDiagnostic(artifact.path, "identity", (error as Error).message));
      return [];
    }
  });
  const identities = resolved.map((identity): PlanArtifactIdentity => {
    const matching = resolved.filter((candidate) => candidate.stableId === identity.stableId);
    const provenancePaths = matching.map((candidate) => candidate.artifact.path).sort();
    const ambiguous = new Set(matching.map((candidate) => candidate.canonicalJson)).size > 1;
    if (ambiguous) {
      diagnostics.push(inspectionDiagnostic(identity.artifact.path, "identity", `plan identity ${identity.stableId} is ambiguous across ${provenancePaths.join(", ")}`));
    }
    return { ...identity, ambiguous, provenancePaths };
  });
  return {
    activePath,
    archiveDirectory,
    active,
    archived,
    invalidArchivePaths,
    diagnostics,
    identities,
  };
}

export function planCatalogEntry(artifact: PlanArtifact, activePath: string, identity?: PlanArtifactIdentity): JsonObject {
  const parts = planDocumentParts(artifact.data);
  const active = artifact.path === activePath;
  return {
    path: artifact.path,
    ...(identity ? { stable_id: identity.stableId } : {}),
    addressable: identity ? !identity.ambiguous : false,
    active,
    archived: !active,
    title: parts.title,
    status: parts.status,
    created: parts.created,
    task_count: parts.tasks.length,
    compatibility: identity?.ambiguous ? "degraded" : identity?.persisted ? "complete" : "degraded",
    provenance: {
      storage: active ? "active_plan_file" : "immutable_plan_archive",
      path: artifact.path,
      lifecycle_position: active ? "active" : "archived",
      ...(identity && identity.provenancePaths.length > 1 ? { mirrored_paths: identity.provenancePaths } : {}),
    },
  };
}

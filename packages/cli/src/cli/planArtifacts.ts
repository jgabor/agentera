import fs from "node:fs";
import path from "node:path";

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

function normalizePlanDocument(data: JsonObject): JsonObject {
  const header = isMapping(data.header) ? data.header : {};
  const status = planStatus(data);
  const normalized = normalizeLegacyStatus(status);
  if (status === normalized) return data;
  return { ...data, header: { ...header, status: normalized } };
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

function lifecycleContradiction(data: JsonObject, status: string): string | null {
  const tasks = (Array.isArray(data.entries) ? data.entries : data.tasks) as unknown[];
  const taskEntries = tasks.filter(isMapping);
  const allComplete = taskEntries.length > 0 && taskEntries.every(taskIsComplete);
  if (status === "complete" && !allComplete)
    return "plan header.status complete requires every task to be complete";
  return null;
}

function inspectionDiagnostic(path: string, category: PlanDiagnosticCategory, message: string): PlanArtifactDiagnostic {
  return { path, category, message };
}

function inspectPlanArtifact(
  artifactPath: string,
  archived: boolean,
  bytes?: Buffer,
): { artifact: PlanArtifact | null; diagnostics: PlanArtifactDiagnostic[] } {
  let data: unknown;
  try {
    data = loadYamlMapping(bytes !== undefined ? bytes.toString("utf8") : fs.readFileSync(artifactPath, "utf8"));
  } catch (error) {
    const message = (error as Error).message;
    const category = message === "YAML root must be a mapping" ? "schema" : "parse";
    return { artifact: null, diagnostics: [inspectionDiagnostic(artifactPath, category, message)] };
  }
  if (!isPlanDocument(data)) {
    return {
      artifact: null,
      diagnostics: [
        inspectionDiagnostic(
          artifactPath,
          "schema",
          "plan requires a header mapping and a tasks or entries array of task mappings",
        ),
      ],
    };
  }

  const status = planStatus(data);
  if (!["open", "complete", "active", "completed"].includes(status)) {
    return {
      artifact: null,
      diagnostics: [
        inspectionDiagnostic(
          artifactPath,
          "lifecycle",
          `plan header.status must be open or complete; received ${status || "missing"}`,
        ),
      ],
    };
  }

  const contradiction = lifecycleContradiction(data, normalizeLegacyStatus(status));
  if (contradiction) {
    return {
      artifact: null,
      diagnostics: [inspectionDiagnostic(artifactPath, "lifecycle", contradiction)],
    };
  }

  const diagnostics: PlanArtifactDiagnostic[] = [];
  if (status === "active" || status === "completed") {
    diagnostics.push(
      inspectionDiagnostic(artifactPath, "legacy", `legacy plan status ${status} normalized to ${normalizeLegacyStatus(status)}`),
    );
  }
  if (Array.isArray(data.entries)) {
    diagnostics.push(inspectionDiagnostic(artifactPath, "legacy", "legacy entries task shape is read compatibly"));
  }
  return { artifact: { path: artifactPath, data: normalizePlanDocument(data), archived }, diagnostics };
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
export function discoverPlanArtifacts(
  activePath: string,
  options?: { activeBytes: Buffer | null; archiveBytes?: ReadonlyMap<string, Buffer> },
): PlanArtifactDiscovery {
  const archiveDirectory = path.join(path.dirname(activePath), "archive");
  const activeInspection = options
    ? options.activeBytes === null
      ? { artifact: null, diagnostics: [] }
      : inspectPlanArtifact(activePath, false, options.activeBytes)
    : fs.existsSync(activePath)
      ? inspectPlanArtifact(activePath, false)
      : { artifact: null, diagnostics: [] };
  const active = activeInspection.artifact;
  const archived: PlanArtifact[] = [];
  const invalidArchivePaths: string[] = [];
  const diagnostics = [...activeInspection.diagnostics];

  let archiveSources: Array<[string, Buffer | undefined]> = [];
  if (options?.archiveBytes) {
    archiveSources = [...options.archiveBytes.entries()]
      .filter(([archivePath]) => path.dirname(archivePath) === archiveDirectory && PLAN_ARCHIVE_FILE.test(path.basename(archivePath)))
      .sort(([left], [right]) => left.localeCompare(right));
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
      diagnostics.push(inspectionDiagnostic(
        identity.artifact.path,
        "identity",
        `plan identity ${identity.stableId} is ambiguous across ${provenancePaths.join(", ")}`,
      ));
    }
    return { ...identity, ambiguous, provenancePaths };
  });
  return { activePath, archiveDirectory, active, archived, invalidArchivePaths, diagnostics, identities };
}

export function planCatalogEntry(
  artifact: PlanArtifact,
  activePath: string,
  identity?: PlanArtifactIdentity,
): JsonObject {
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

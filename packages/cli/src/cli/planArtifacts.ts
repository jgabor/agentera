import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { asList, firstPresent } from "./stateQuery.js";

/** The immutable filenames produced by the typed plan archive writer. */
const PLAN_ARCHIVE_FILE = /^PLAN-.+\.ya?ml$/i;

export interface PlanArtifact {
  path: string;
  data: JsonObject;
  archived: boolean;
}

export type PlanDiagnosticCategory = "parse" | "schema" | "lifecycle" | "legacy";

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
): { artifact: PlanArtifact | null; diagnostics: PlanArtifactDiagnostic[] } {
  let data: unknown;
  try {
    data = loadYamlMapping(fs.readFileSync(artifactPath, "utf8"));
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
 * history location. Discovery is deterministic and resilient to bad files.
 */
export function discoverPlanArtifacts(activePath: string): PlanArtifactDiscovery {
  const archiveDirectory = path.join(path.dirname(activePath), "archive");
  const activeInspection = fs.existsSync(activePath)
    ? inspectPlanArtifact(activePath, false)
    : { artifact: null, diagnostics: [] };
  const active = activeInspection.artifact;
  const archived: PlanArtifact[] = [];
  const invalidArchivePaths: string[] = [];
  const diagnostics = [...activeInspection.diagnostics];

  let names: string[] = [];
  try {
    names = fs.readdirSync(archiveDirectory);
  } catch {
    // A missing archive directory is the normal state before the first archive.
  }

  for (const name of names.filter((candidate) => PLAN_ARCHIVE_FILE.test(candidate)).sort()) {
    const archivePath = path.join(archiveDirectory, name);
    let isFile = false;
    try {
      isFile = fs.statSync(archivePath).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    const inspection = inspectPlanArtifact(archivePath, true);
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
  return { activePath, archiveDirectory, active, archived, invalidArchivePaths, diagnostics };
}

export function planCatalogEntry(artifact: PlanArtifact, activePath: string): JsonObject {
  const parts = planDocumentParts(artifact.data);
  const active = artifact.path === activePath;
  return {
    path: artifact.path,
    active,
    archived: !active,
    title: parts.title,
    status: parts.status,
    created: parts.created,
    task_count: parts.tasks.length,
  };
}

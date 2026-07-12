import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { asList, firstPresent, loadArtifact } from "./stateQuery.js";

/** The immutable filenames produced by the typed plan archive writer. */
const PLAN_ARCHIVE_FILE = /^PLAN-.+\.ya?ml$/i;

export interface PlanArtifact {
  path: string;
  data: JsonObject;
  archived: boolean;
}

export interface PlanArtifactDiscovery {
  activePath: string;
  archiveDirectory: string;
  active: PlanArtifact | null;
  archived: PlanArtifact[];
  invalidArchivePaths: string[];
}

export interface PlanDocumentParts {
  header: JsonObject;
  tasks: JsonObject[];
  status: string;
  title: string;
  created: string;
  legacyEntries: boolean;
}

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A plan archive is valid only when it retains the task list (including an
 * intentionally empty list). This keeps unrelated YAML and malformed plan
 * names from replacing a valid archive during discovery.
 */
function isPlanDocument(value: unknown): value is JsonObject {
  return isMapping(value) && (Array.isArray(value.tasks) || Array.isArray(value.entries));
}

export function planDocumentParts(data: JsonObject): PlanDocumentParts {
  const legacyEntries = asList(data.entries);
  const header = isMapping(data.header) ? data.header : {};
  const rawTasks = legacyEntries.length > 0 ? legacyEntries : asList(data.tasks);
  const tasks = rawTasks.filter((task): task is JsonObject => isMapping(task));
  return {
    header,
    tasks,
    status: String(firstPresent(header, ["status"], data.status ?? "") || ""),
    title: String(firstPresent(header, ["title"], data.title ?? "") || ""),
    created: String(firstPresent(header, ["created"], data.created ?? "") || ""),
    legacyEntries: legacyEntries.length > 0,
  };
}

/**
 * Discover the active plan and typed-writer archives. The active path is
 * schema-resolved; its sibling `archive/` directory is the writer-owned
 * history location. Discovery is deterministic and resilient to bad files.
 */
export function discoverPlanArtifacts(activePath: string): PlanArtifactDiscovery {
  const archiveDirectory = path.join(path.dirname(activePath), "archive");
  const activeData = loadArtifact(activePath);
  const active = isPlanDocument(activeData) ? { path: activePath, data: activeData, archived: false } : null;
  const archived: PlanArtifact[] = [];
  const invalidArchivePaths: string[] = [];

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
    const data = loadArtifact(archivePath);
    if (isPlanDocument(data)) archived.push({ path: archivePath, data, archived: true });
    else invalidArchivePaths.push(archivePath);
  }

  // Archive names carry a calendar date but can collide on the same day. The
  // writer's filesystem publication time is the authoritative recency signal;
  // use the path only as a stable tie-breaker for copied fixtures.
  archived.sort((a, b) => {
    const mtime = (candidate: PlanArtifact): number => {
      try {
        return fs.statSync(candidate.path).mtimeMs;
      } catch {
        return 0;
      }
    };
    const delta = mtime(b) - mtime(a);
    return delta === 0 ? b.path.localeCompare(a.path) : delta;
  });
  return { activePath, archiveDirectory, active, archived, invalidArchivePaths };
}

export function planCatalogEntry(artifact: PlanArtifact): JsonObject {
  const parts = planDocumentParts(artifact.data);
  return {
    path: artifact.path,
    active: !artifact.archived,
    archived: artifact.archived,
    title: parts.title,
    status: parts.status,
    created: parts.created,
    task_count: parts.tasks.length,
  };
}

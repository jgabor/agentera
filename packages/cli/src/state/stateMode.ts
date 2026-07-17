import fs from "node:fs";
import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";

export type StateMode = "legacy" | "entities";

interface StateModeContract {
  markerPath: string;
  schemaVersion: string;
  mode: string;
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contract(sourceRoot = resolveSourceRoot()): StateModeContract {
  const authorityPath = path.join(
    sourceRoot,
    "references",
    "artifacts",
    "state-storage-authority.yaml",
  );
  const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  const migration = authority.entity_migration;
  const marker = mapping(migration) ? migration.cutover_marker : null;
  const entityMode = mapping(marker) ? marker.entity_mode : null;
  if (
    !mapping(marker) ||
    typeof marker.path !== "string" ||
    typeof marker.schema_version !== "string" ||
    !mapping(entityMode) ||
    typeof entityMode.mode !== "string"
  ) {
    throw new Error(
      `state storage authority '${authorityPath}' has no executable cutover marker contract`,
    );
  }
  if (path.isAbsolute(marker.path) || marker.path.split(/[\\/]/).includes("..")) {
    throw new Error(`state storage authority declares unsafe cutover marker path '${marker.path}'`);
  }
  return { markerPath: marker.path, schemaVersion: marker.schema_version, mode: entityMode.mode };
}

function symbolicLinkPrefix(projectRoot: string, candidate: string): string | null {
  const root = path.resolve(projectRoot);
  let cursor = root;
  for (const segment of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

/** Read the authority-owned cutover marker without creating or repairing state. */
export function detectStateMode(projectRoot: string, sourceRoot = resolveSourceRoot()): StateMode {
  const root = path.resolve(projectRoot);
  const declared = contract(sourceRoot);
  const markerPath = path.join(root, declared.markerPath);
  const symlink = symbolicLinkPrefix(root, markerPath);
  if (symlink) {
    throw new Error(
      `state mode marker path contains symbolic link '${path.relative(root, symlink)}'; restore a project-local marker path before retrying`,
    );
  }
  if (!fs.existsSync(markerPath)) return "legacy";
  if (!fs.statSync(markerPath).isFile()) {
    throw new Error(
      `state mode marker '${declared.markerPath}' is not a file; restore the durable migration marker before retrying`,
    );
  }
  let document: Record<string, unknown>;
  try {
    document = loadYamlMapping(fs.readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw new Error(
      `state mode marker '${declared.markerPath}' is corrupt: ${(error as Error).message}; restore the durable migration marker before retrying`,
    );
  }
  if (document.schemaVersion !== declared.schemaVersion || document.mode !== declared.mode) {
    throw new Error(
      `state mode marker '${declared.markerPath}' must declare schemaVersion '${declared.schemaVersion}' and mode '${declared.mode}'; restore the durable migration marker before retrying`,
    );
  }
  return "entities";
}

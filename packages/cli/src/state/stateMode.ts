import fs from "node:fs";
import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";

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

function readStableMarker(root: string, markerPath: string): Buffer | null {
  const snapshot = readProjectFileSnapshot(root, markerPath);
  if (snapshot.kind === "missing") {
    if (path.resolve(snapshot.absolute) === root) {
      throw new Error(
        `project root '${root}' changed while the state mode marker was inspected; restore the real directory and retry`,
      );
    }
    return null;
  }
  if (snapshot.kind === "unsafe") {
    const detail = snapshot.reason === "type"
      ? "is not a regular file"
      : snapshot.reason === "symlink"
        ? "has an unsafe path"
        : "changed or became unsafe while being read";
    throw new Error(
      `state mode marker '${markerPath}' ${detail}; restore a stable project-local marker and retry`,
    );
  }
  return snapshot.bytes;
}

/** Read the authority-owned cutover marker without creating or repairing state. */
export function detectStateMode(projectRoot: string, sourceRoot = resolveSourceRoot()): StateMode {
  const root = validateRealProjectRoot(projectRoot);
  const declared = contract(sourceRoot);
  const bytes = readStableMarker(root, declared.markerPath);
  if (bytes === null) return "legacy";
  let document: Record<string, unknown>;
  try {
    document = loadYamlMapping(bytes.toString("utf8"));
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

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { EntityPublicationContext } from "./entityPublicationContext.js";
import { validateRealProjectRoot, type ValidatedProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";

export type StateMode = "legacy" | "entities";

export type ProjectState =
  | "entities"
  | "fresh_uninitialized"
  | "legacy"
  | "partial"
  | "corrupt"
  | "unknown";

export interface ProjectStateClassification {
  state: ProjectState;
  root: ValidatedProjectRoot;
  markerPath: string;
  markerBytes?: Buffer;
  reason?: string;
}

export interface FreshPlanInitialization {
  root: ValidatedProjectRoot;
  markerPath: string;
  marker: { schemaVersion: string; mode: string };
  markerBytes: string;
}

export type StateModeBinding =
  | { mode: "legacy"; root: ValidatedProjectRoot }
  | {
      mode: "entities";
      root: ValidatedProjectRoot;
      publicationContext: EntityPublicationContext;
    };

interface StateModeContract {
  markerPath: string;
  schemaVersion: string;
  mode: string;
}

type DetectedStateMode =
  | { mode: "legacy"; root: ValidatedProjectRoot }
  | { mode: "entities"; root: ValidatedProjectRoot; markerPath: string; markerBytes: Buffer };

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

function readStableMarker(root: ValidatedProjectRoot, markerPath: string): Buffer | null {
  const snapshot = readProjectFileSnapshot(root, markerPath);
  if (snapshot.kind === "missing") {
    if (path.resolve(snapshot.absolute) === root.path) {
      throw new Error(
        `project root '${root.path}' changed while the state mode marker was inspected; restore the real directory and retry`,
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

function pathKind(root: ValidatedProjectRoot, relativePath: string): "missing" | "file" | "directory" | "unsafe" {
  const absolute = path.join(root.path, ...relativePath.split("/"));
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return "unsafe";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "unsafe";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "unsafe";
  }
}

function isGitWorktreeRoot(root: ValidatedProjectRoot): boolean {
  const env = { ...process.env };
  for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root.path,
    env,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return false;
  try {
    return fs.realpathSync(String(result.stdout).trim()) === root.path;
  } catch {
    return false;
  }
}

function classifyMarkerAbsentProject(
  root: ValidatedProjectRoot,
  markerPath: string,
): ProjectStateClassification {
  const stateRoot = pathKind(root, ".agentera");
  if (stateRoot === "missing") {
    return {
      state: isGitWorktreeRoot(root) ? "fresh_uninitialized" : "unknown",
      root,
      markerPath,
    };
  }
  if (stateRoot !== "directory") {
    return {
      state: "corrupt",
      root,
      markerPath,
      reason: "Agentera state root '.agentera' is not a safe directory",
    };
  }

  const entities = pathKind(root, ".agentera/entities");
  if (entities !== "missing" && entities !== "directory") {
    return {
      state: "corrupt",
      root,
      markerPath,
      reason: "Agentera entity root '.agentera/entities' is not a safe directory",
    };
  }
  if (entities === "directory") return { state: "partial", root, markerPath };

  const aggregates = ["plan.yaml", "progress.yaml", "decisions.yaml", "health.yaml"]
    .map((name) => pathKind(root, `.agentera/${name}`));
  if (aggregates.includes("unsafe")) {
    return {
      state: "corrupt",
      root,
      markerPath,
      reason: "a recognized Agentera aggregate is not a safe regular file",
    };
  }
  const aggregateCount = aggregates.filter((kind) => kind === "file").length;
  if (aggregateCount >= 2) return { state: "legacy", root, markerPath };
  if (aggregateCount === 1) return { state: "partial", root, markerPath };
  return { state: "unknown", root, markerPath };
}

/** Classify local state without creating, repairing, or adopting project files. */
export function classifyProjectState(
  projectRoot: string,
  sourceRoot = resolveSourceRoot(),
): ProjectStateClassification {
  const root = validateRealProjectRoot(projectRoot);
  const declared = contract(sourceRoot);
  let bytes: Buffer | null;
  try {
    bytes = readStableMarker(root, declared.markerPath);
  } catch (error) {
    return {
      state: "corrupt",
      root,
      markerPath: declared.markerPath,
      reason: (error as Error).message,
    };
  }
  if (bytes === null) return classifyMarkerAbsentProject(root, declared.markerPath);
  try {
    const document = loadYamlMapping(bytes.toString("utf8"));
    if (document.schemaVersion !== declared.schemaVersion || document.mode !== declared.mode) {
      return {
        state: "corrupt",
        root,
        markerPath: declared.markerPath,
        reason: `state mode marker '${declared.markerPath}' must declare schemaVersion '${declared.schemaVersion}' and mode '${declared.mode}'; restore the durable migration marker before retrying`,
      };
    }
  } catch (error) {
    return {
      state: "corrupt",
      root,
      markerPath: declared.markerPath,
      reason: `state mode marker '${declared.markerPath}' is corrupt: ${(error as Error).message}; restore the durable migration marker before retrying`,
    };
  }
  return { state: "entities", root, markerPath: declared.markerPath, markerBytes: bytes };
}

export function freshEntityStateMarker(sourceRoot = resolveSourceRoot()): { schemaVersion: string; mode: string } {
  const declared = contract(sourceRoot);
  return { schemaVersion: declared.schemaVersion, mode: declared.mode };
}

export function freshPlanInitialization(
  projectRoot: string,
  sourceRoot = resolveSourceRoot(),
): FreshPlanInitialization | null {
  const classified = classifyProjectState(projectRoot, sourceRoot);
  if (classified.state !== "fresh_uninitialized") return null;
  const marker = freshEntityStateMarker(sourceRoot);
  return {
    root: classified.root,
    markerPath: classified.markerPath,
    marker,
    markerBytes: dumpYamlMapping(marker),
  };
}

function detectValidatedStateMode(
  projectRoot: string,
  sourceRoot: string,
): DetectedStateMode {
  const root = validateRealProjectRoot(projectRoot);
  const declared = contract(sourceRoot);
  const bytes = readStableMarker(root, declared.markerPath);
  if (bytes === null) return { mode: "legacy", root };
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
  return { mode: "entities", root, markerPath: declared.markerPath, markerBytes: bytes };
}

/** Read the authority-owned cutover marker without creating or repairing state. */
export function detectStateModeBinding(
  projectRoot: string,
  sourceRoot = resolveSourceRoot(),
): StateModeBinding {
  const detected = detectValidatedStateMode(projectRoot, sourceRoot);
  if (detected.mode === "legacy") return detected;
  return {
    mode: "entities",
    root: detected.root,
    publicationContext: EntityPublicationContext.open(
      detected.root,
      detected.markerPath,
      detected.markerBytes,
    ),
  };
}

export function detectStateMode(projectRoot: string, sourceRoot = resolveSourceRoot()): StateMode {
  return detectValidatedStateMode(projectRoot, sourceRoot).mode;
}

export function requireEntityStateBinding(
  projectRoot: string,
  sourceRoot = resolveSourceRoot(),
): Extract<StateModeBinding, { mode: "entities" }> {
  const binding = detectStateModeBinding(projectRoot, sourceRoot);
  if (binding.mode === "legacy") {
    throw new Error("state writes require the durable entity-state marker; legacy aggregates are read-only migration input");
  }
  return binding;
}

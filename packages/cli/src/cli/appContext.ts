import fs from "node:fs";
import path from "node:path";

import { parseYaml } from "../core/yaml.js";
import {
  ArtifactRecord,
  loadArtifactRegistry,
  registryModelPath,
  resolveArtifactPath,
} from "../registries/artifactRegistry.js";
import { resolveActiveAppModel, ActiveAppModel } from "../upgrade/appModel.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import os from "node:os";

/**
 * App-model + artifact-schema discovery layer used by the CLI state/query/lint/
 * validate commands. Faithful port of the `_active_app_model`, `_discover_*`,
 * `_load_schemas`, `_artifact_path` helpers in scripts/agentera.
 */

export interface SchemaInfo {
  path: string;
  record: ArtifactRecord | undefined;
  schema: Record<string, any>;
  fields: Record<string, any>;
}

function isLocalAgenteraCheckout(root: string): boolean {
  return ["scripts/agentera", "skills/agentera/SKILL.md", "registry.json"].every((rel) =>
    fs.existsSync(path.join(root, rel)),
  );
}

function isInstalledManagedApp(root: string): boolean {
  return (
    path.basename(root) === "app" &&
    isFileSafe(path.join(root, ".agentera-bundle.json")) &&
    isLocalAgenteraCheckout(root)
  );
}

/** Faithful port of scripts/agentera `_active_app_model` (CLI-level wrapper). */
export function activeAppModel(env: Record<string, string | undefined> = process.env): ActiveAppModel {
  const sourceRoot = resolveSourceRoot(env);
  if (isInstalledManagedApp(sourceRoot)) {
    if (env.AGENTERA_HOME || env.AGENTERA_DEFAULT_INSTALL_ROOT) {
      const selected = resolveActiveAppModel(null, { home: os.homedir(), env });
      if (selected.appHome !== path.dirname(sourceRoot)) return selected;
      selected.runtimeRoot = sourceRoot;
      return selected;
    }
    return {
      appHome: path.dirname(sourceRoot),
      appHomeSource: "installed app",
      managedAppRoot: sourceRoot,
      activeBundleRoot: sourceRoot,
      authoritativeRoot: sourceRoot,
      skillRoot: path.join(sourceRoot, "skills", "agentera"),
      runtimeRoot: sourceRoot,
    };
  }
  if (!env.AGENTERA_HOME && !env.AGENTERA_DEFAULT_INSTALL_ROOT && isLocalAgenteraCheckout(sourceRoot)) {
    return {
      appHome: sourceRoot,
      appHomeSource: "local checkout",
      managedAppRoot: sourceRoot,
      activeBundleRoot: sourceRoot,
      authoritativeRoot: sourceRoot,
      skillRoot: path.join(sourceRoot, "skills", "agentera"),
      runtimeRoot: sourceRoot,
    };
  }
  return resolveActiveAppModel(null, { home: os.homedir(), env });
}

export function modelPath(model: ActiveAppModel, key: keyof ActiveAppModel): string {
  return String(model[key]);
}

export function discoverSchemasDir(model: ActiveAppModel = activeAppModel()): string {
  return path.join(modelPath(model, "skillRoot"), "schemas", "artifacts");
}

const FIELD_SKIP = new Set([
  "meta",
  "GROUP_PREFIXES",
  "BUDGET",
  "COMPACTION",
  "VALIDATION",
  "ARCHIVE",
  "CONVENTION",
  "CONVENTIONS",
]);

export function discoverFields(schema: Record<string, any>): Record<string, any> {
  const fields: Record<string, any> = {};
  for (const [groupKey, groupVal] of Object.entries(schema)) {
    if (FIELD_SKIP.has(groupKey) || !groupVal || typeof groupVal !== "object" || Array.isArray(groupVal)) {
      continue;
    }
    for (const entry of Object.values(groupVal as Record<string, any>)) {
      if (entry && typeof entry === "object" && !Array.isArray(entry) && "field" in entry) {
        fields[(entry as Record<string, any>).field] = entry;
      }
    }
  }
  return fields;
}

export function loadRegistryForSchemas(schemasDir: string): Map<string, ArtifactRecord> {
  const root = path.resolve(schemasDir, "..", "..", "..", "..");
  let modelPathArg = path.join(root, "references", "artifacts", "artifact-registry-interface-model.yaml");
  if (!isFileSafe(modelPathArg)) {
    modelPathArg = registryModelPath();
  }
  try {
    return loadArtifactRegistry(schemasDir, modelPathArg);
  } catch (exc) {
    process.stderr.write(`warning: failed to load artifact registry for schemas: ${(exc as Error).message}\n`);
    return new Map();
  }
}

function isFileSafe(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function loadSchemas(schemasDir: string): Record<string, SchemaInfo> {
  if (!isDirSafe(schemasDir)) return {};
  const registry = loadRegistryForSchemas(schemasDir);
  const schemas: Record<string, SchemaInfo> = {};
  const files = fs
    .readdirSync(schemasDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  for (const file of files) {
    let schema: unknown;
    try {
      schema = parseYaml(fs.readFileSync(path.join(schemasDir, file), "utf8"));
    } catch (exc) {
      process.stderr.write(`warning: failed to load schema ${file}: ${(exc as Error).message}\n`);
      continue;
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) continue;
    const s = schema as Record<string, any>;
    const meta = (s.meta ?? {}) as Record<string, any>;
    const name = meta.name ?? "";
    const artifactPathStr = meta.path ?? "";
    if (!name) continue;
    schemas[name] = {
      path: artifactPathStr,
      record: registry.get(name),
      schema: s,
      fields: discoverFields(s),
    };
  }
  return schemas;
}

export function activeObjectiveName(projectRoot: string = process.cwd()): string | null {
  const root = path.join(projectRoot, ".agentera", "optimera");
  if (!isDirSafe(root)) return null;
  const candidates = fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((p) => isDirSafe(p));
  if (candidates.length === 0) return null;
  const active: string[] = [];
  for (const candidate of candidates) {
    const objective = path.join(candidate, "objective.yaml");
    if (!fs.existsSync(objective)) continue;
    let data: unknown;
    try {
      data = parseYaml(fs.readFileSync(objective, "utf8"));
    } catch (exc) {
      process.stderr.write(`warning: failed to load active objective ${objective}: ${(exc as Error).message}\n`);
      continue;
    }
    let status = "";
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, any>;
      const header = d.header;
      if (header && typeof header === "object" && !Array.isArray(header)) status = String(header.status ?? "");
      if (!status) status = String(d.status ?? "");
    }
    if (status.toLowerCase() === "active") active.push(candidate);
  }
  const pool = active.length > 0 ? active : candidates;
  pool.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return path.basename(pool[0]);
}

export function resolveArtifactPathLocal(
  artifactRelPath: string,
  _schemaName: string | null = null,
  record: ArtifactRecord | null = null,
): string {
  if (record !== null) {
    return resolveArtifactPath(record, process.cwd(), activeObjectiveName());
  }
  let rel = artifactRelPath;
  if (rel.includes("<name>")) {
    const objectiveName = activeObjectiveName();
    if (objectiveName) rel = rel.replace(/<name>/g, objectiveName);
  }
  if (path.isAbsolute(rel)) return rel;
  return path.join(process.cwd(), rel);
}

export function artifactPath(info: SchemaInfo, schemaName: string): string {
  const record = info.record;
  return resolveArtifactPathLocal(info.path, schemaName, record ?? null);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { resolveCandidate } from "../state/installRoot.js";

/**
 * Registry-backed artifact identity projection. Faithful TS port of
 * `scripts/artifact_registry.py`.
 */

export interface ArtifactRecord {
  artifactId: string;
  displayName: string;
  defaultPath: string;
  producers: Set<string>;
  consumers: Set<string>;
  artifactType: string;
  scope: string;
  pathTemplate: Record<string, unknown> | null;
  docsYamlCanOverridePath: boolean;
}

function sourceRoot(): string {
  return resolveSourceRoot();
}

export function artifactSchemasDir(root: string = sourceRoot()): string {
  return path.join(root, "skills", "agentera", "schemas", "artifacts");
}

export function registryModelPath(root: string = sourceRoot()): string {
  return path.join(root, "references", "artifacts", "artifact-registry-interface-model.yaml");
}

function loadYaml(p: string): Record<string, unknown> {
  return loadYamlMapping(fs.readFileSync(p, "utf8"));
}

export function asSet(value: unknown): Set<string> {
  if (value === null || value === undefined) {
    return new Set();
  }
  if (typeof value === "string") {
    return new Set([value]);
  }
  if (Array.isArray(value)) {
    return new Set(value.map((v) => String(v)));
  }
  return new Set([String(value)]);
}

export function normalizePath(p: string): string {
  let s = String(p).trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, "");
  s = s.replace(/\s+or\s+mapped\s+path\s+per\s+(?:docs\.yaml|DOCS\.md)$/, "");
  s = s.replace(/<objective-name>/g, "<name>");
  return s.trim();
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const ENCODED_TRAVERSAL_RE = /%(?:2e|2f|5c)/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

function rejectUnsafeArtifactPath(p: string, artifactId: string): void {
  if (CONTROL_CHAR_RE.test(p)) {
    throw new Error(`artifact '${artifactId}' path contains control characters`);
  }
  if (ENCODED_TRAVERSAL_RE.test(p)) {
    throw new Error(`artifact '${artifactId}' path contains encoded traversal or separators`);
  }
  if (URI_SCHEME_RE.test(p) && !WINDOWS_DRIVE_RE.test(p)) {
    throw new Error(`artifact '${artifactId}' path uses unsupported URI syntax`);
  }
  const parts = p.split(/[\\/]/);
  if (parts.some((part) => part === "..")) {
    throw new Error(`artifact '${artifactId}' path contains traversal segments`);
  }
}

function projectPath(projectRoot: string, artifactPath: string, artifactId: string): string {
  rejectUnsafeArtifactPath(artifactPath, artifactId);
  const resolvedProject = resolvePath(projectRoot);
  const resolved = path.isAbsolute(artifactPath)
    ? resolvePath(artifactPath)
    : resolvePath(path.join(resolvedProject, artifactPath));
  const rel = path.relative(resolvedProject, resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`artifact '${artifactId}' path escapes the project boundary`);
  }
  return resolved;
}

function schemaMetas(dir: string): Map<string, Record<string, unknown>> {
  const metas = new Map<string, Record<string, unknown>>();
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return metas;
  }
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  for (const name of files) {
    const meta = loadYaml(path.join(dir, name)).meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      continue;
    }
    const m = meta as Record<string, unknown>;
    const artifactId = String(m.name ?? "").trim();
    if (artifactId) {
      metas.set(artifactId, m);
    }
  }
  return metas;
}

export function loadArtifactRegistry(
  artifactSchemasDirPath: string = artifactSchemasDir(),
  registryModelPathArg: string = registryModelPath(),
): Map<string, ArtifactRecord> {
  const model = loadYaml(registryModelPathArg);
  const metas = schemaMetas(artifactSchemasDirPath);
  const records = new Map<string, ArtifactRecord>();

  const identities = (model.required_artifact_identities ?? {}) as Record<string, unknown>;
  for (const [scope, identityList] of Object.entries(identities)) {
    if (!Array.isArray(identityList)) {
      continue;
    }
    for (const identity of identityList) {
      if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
        continue;
      }
      const id = identity as Record<string, unknown>;
      const artifactId = String(id.artifact_id ?? "").trim();
      const meta = metas.get(artifactId);
      if (!artifactId || !meta) {
        continue;
      }
      const template = id.path_template;
      records.set(artifactId, {
        artifactId,
        displayName: String(id.display_name ?? "").trim(),
        defaultPath: normalizePath(String(id.default_path ?? meta.path ?? "")),
        producers: asSet(meta.producer),
        consumers: asSet(meta.consumers),
        artifactType: String(meta.artifact_type ?? "").trim(),
        scope: String(scope),
        pathTemplate:
          template && typeof template === "object" && !Array.isArray(template)
            ? (template as Record<string, unknown>)
            : null,
        docsYamlCanOverridePath: true,
      });
    }
  }

  const specialCases = (model.explicit_special_cases ?? []) as unknown[];
  for (const special of specialCases) {
    if (!special || typeof special !== "object" || Array.isArray(special)) {
      continue;
    }
    const sp = special as Record<string, unknown>;
    const artifactId = String(sp.artifact_id ?? "").trim();
    if (!artifactId) {
      continue;
    }
    const template = sp.path_template;
    records.set(artifactId, {
      artifactId,
      displayName: String(sp.display_name ?? "").trim(),
      defaultPath: normalizePath(String(sp.default_path ?? "")),
      producers: asSet(sp.producers),
      consumers: asSet(sp.consumers),
      artifactType: String(sp.artifact_type ?? "").trim(),
      scope: String(sp.scope ?? "").trim(),
      pathTemplate:
        template && typeof template === "object" && !Array.isArray(template)
          ? (template as Record<string, unknown>)
          : null,
      docsYamlCanOverridePath: Boolean(sp.docs_yaml_can_override_path),
    });
  }

  return records;
}

export function loadDocsPathOverrides(projectRoot: string): Record<string, string> {
  const docsPath = path.join(projectRoot, ".agentera", "docs.yaml");
  if (!fs.existsSync(docsPath)) {
    return {};
  }
  let data: Record<string, unknown>;
  try {
    data = loadYamlMapping(fs.readFileSync(docsPath, "utf8"));
  } catch (exc) {
    process.stderr.write(`warning: failed to load docs path overrides: ${(exc as Error).message}\n`);
    return {};
  }
  const mapping = data.mapping;
  if (!Array.isArray(mapping)) {
    return {};
  }
  const overrides: Record<string, string> = {};
  for (const entry of mapping) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const artifact = e.artifact;
    const p = e.path;
    if (typeof artifact === "string" && typeof p === "string") {
      overrides[artifact] = p;
    }
  }
  return overrides;
}

export function resolveArtifactPath(
  record: ArtifactRecord,
  projectRoot: string,
  activeObjectiveName: string | null = null,
  env: Record<string, string | undefined> = process.env,
): string {
  let artifactPath = record.defaultPath;
  const overrides = loadDocsPathOverrides(projectRoot);
  if (record.docsYamlCanOverridePath && record.displayName in overrides) {
    artifactPath = overrides[record.displayName];
  }
  if (artifactPath.includes("<name>") && activeObjectiveName) {
    artifactPath = artifactPath.replace(/<name>/g, activeObjectiveName);
  }
  const profilePrefix = "$AGENTERA_PROFILE_DIR/";
  if (artifactPath.startsWith(profilePrefix)) {
    const explicit = env.AGENTERA_PROFILE_DIR;
    const suffix = artifactPath.slice(profilePrefix.length);
    if (explicit) {
      return path.join(explicit, suffix);
    }
    const [base] = resolveCandidate(null, { env, home: os.homedir() });
    return path.join(base, suffix);
  }
  return projectPath(projectRoot, artifactPath, record.artifactId);
}

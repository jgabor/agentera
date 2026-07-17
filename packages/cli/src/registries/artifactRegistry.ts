import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveProfileDirOverride } from "../core/envPaths.js";
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

const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const ENCODED_TRAVERSAL_RE = /%(?:2e|2f|5c)/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

function rejectUnsafeArtifactPath(p: string, artifactId: string): void {
  if ([...p].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)) {
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

export const EXPECTED_ARTIFACT_SCHEMA_VERSION = "1.0.0";

function readSchemaMeta(file: string): Record<string, unknown> | null {
  const meta = loadYaml(file).meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return null;
  }
  return meta as Record<string, unknown>;
}

function warnMalformedSchemaMeta(name: string): void {
  process.stderr.write(
    `warning: artifact schema ${name} is missing meta; expected v3 schema version ${EXPECTED_ARTIFACT_SCHEMA_VERSION}\n`,
  );
}

function warnSchemaVersionMismatch(meta: Record<string, unknown>, name: string): void {
  const version = String(meta.version ?? "").trim();
  if (!version || version !== EXPECTED_ARTIFACT_SCHEMA_VERSION) {
    const reported = version || "(missing)";
    process.stderr.write(
      `warning: artifact schema ${name} version ${reported} does not match expected v3 schema version ${EXPECTED_ARTIFACT_SCHEMA_VERSION}\n`,
    );
  }
}

function listSchemaFiles(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
}

/**
 * Full schema-meta index over an artifact schemas directory. Emits malformed-meta
 * and version-mismatch warnings for every schema file; the full loader relies on
 * this strict coverage to surface drift across the whole identity set.
 */
function schemaMetas(dir: string): Map<string, Record<string, unknown>> {
  const metas = new Map<string, Record<string, unknown>>();
  for (const name of listSchemaFiles(dir)) {
    const meta = readSchemaMeta(path.join(dir, name));
    if (!meta) {
      warnMalformedSchemaMeta(name);
      continue;
    }
    warnSchemaVersionMismatch(meta, name);
    const artifactId = String(meta.name ?? "").trim();
    if (artifactId) {
      metas.set(artifactId, meta);
    }
  }
  return metas;
}

/**
 * Targeted schema-meta lookup for a single artifact identity. Walks the schemas
 * directory only to find the file whose `meta.name` matches `artifactId`, and
 * emits warnings only for that schema. Unrelated malformed or version-mismatched
 * schemas in the same directory stay silent so callers resolving a single
 * identity (e.g. `profile`) don't fan out noise across the required-identity set.
 */
function loadSchemaMetaForArtifact(
  dir: string,
  artifactId: string,
): Record<string, unknown> | null {
  for (const name of listSchemaFiles(dir)) {
    let meta: Record<string, unknown> | null;
    try {
      meta = readSchemaMeta(path.join(dir, name));
    } catch {
      continue;
    }
    if (!meta) continue;
    if (String(meta.name ?? "").trim() !== artifactId) continue;
    warnSchemaVersionMismatch(meta, name);
    return meta;
  }
  return null;
}

function findRequiredIdentity(
  model: Record<string, unknown>,
  artifactId: string,
): { scope: string; identity: Record<string, unknown> } | null {
  const identities = (model.required_artifact_identities ?? {}) as Record<string, unknown>;
  for (const [scope, identityList] of Object.entries(identities)) {
    if (!Array.isArray(identityList)) continue;
    for (const identity of identityList) {
      if (!identity || typeof identity !== "object" || Array.isArray(identity)) continue;
      const id = identity as Record<string, unknown>;
      if (String(id.artifact_id ?? "").trim() === artifactId) {
        return { scope, identity: id };
      }
    }
  }
  return null;
}

function findSpecialCase(
  model: Record<string, unknown>,
  artifactId: string,
): Record<string, unknown> | null {
  const specialCases = (model.explicit_special_cases ?? []) as unknown[];
  for (const special of specialCases) {
    if (!special || typeof special !== "object" || Array.isArray(special)) continue;
    const sp = special as Record<string, unknown>;
    if (String(sp.artifact_id ?? "").trim() === artifactId) {
      return sp;
    }
  }
  return null;
}

function buildRequiredRecord(
  scope: string,
  identity: Record<string, unknown>,
  meta: Record<string, unknown>,
): ArtifactRecord {
  const template = identity.path_template;
  return {
    artifactId: String(identity.artifact_id ?? "").trim(),
    displayName: String(identity.display_name ?? "").trim(),
    defaultPath: normalizePath(String(identity.default_path ?? meta.path ?? "")),
    producers: asSet(meta.producer),
    consumers: asSet(meta.consumers),
    artifactType: String(meta.artifact_type ?? "").trim(),
    scope: String(scope),
    pathTemplate:
      template && typeof template === "object" && !Array.isArray(template)
        ? (template as Record<string, unknown>)
        : null,
    docsYamlCanOverridePath: true,
  };
}

function buildSpecialCaseRecord(sp: Record<string, unknown>): ArtifactRecord {
  const template = sp.path_template;
  return {
    artifactId: String(sp.artifact_id ?? "").trim(),
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
  };
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
      if (!artifactId) {
        continue;
      }
      const meta = metas.get(artifactId);
      if (!meta) {
        process.stderr.write(
          `warning: required artifact identity '${artifactId}' has no matching schema file in ${artifactSchemasDirPath}\n`,
        );
        continue;
      }
      records.set(artifactId, buildRequiredRecord(scope, id, meta));
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
    records.set(artifactId, buildSpecialCaseRecord(sp));
  }

  return records;
}

/**
 * Targeted lookup of a single artifact record. Resolves against the same
 * model/schema authority as `loadArtifactRegistry` but inspects only the
 * requested identity, so a special case such as `profile` loads without
 * walking or warning about unrelated required schemas. A requested required
 * identity still warns and returns `undefined` when its matching schema file is
 * missing from the schemas directory.
 */
export function loadArtifactRecord(
  artifactId: string,
  artifactSchemasDirPath: string = artifactSchemasDir(),
  registryModelPathArg: string = registryModelPath(),
): ArtifactRecord | undefined {
  const model = loadYaml(registryModelPathArg);
  const specialCase = findSpecialCase(model, artifactId);
  if (specialCase) {
    return buildSpecialCaseRecord(specialCase);
  }
  const required = findRequiredIdentity(model, artifactId);
  if (!required) {
    return undefined;
  }
  const meta = loadSchemaMetaForArtifact(artifactSchemasDirPath, artifactId);
  if (!meta) {
    process.stderr.write(
      `warning: required artifact identity '${artifactId}' has no matching schema file in ${artifactSchemasDirPath}\n`,
    );
    return undefined;
  }
  return buildRequiredRecord(required.scope, required.identity, meta);
}

export function docsPathOverridesFromBytes(bytes: string | Buffer, strict = false): Record<string, string> {
  let data: Record<string, unknown>;
  try {
    data = loadYamlMapping(bytes.toString());
  } catch (exc) {
    if (strict) throw new Error(`failed to load docs path overrides: ${(exc as Error).message}`);
    process.stderr.write(`warning: failed to load docs path overrides: ${(exc as Error).message}\n`);
    return {};
  }
  const mapping = data.mapping;
  if (!Array.isArray(mapping)) {
    if (strict && mapping !== undefined) throw new Error("failed to load docs path overrides: mapping must be a list");
    return {};
  }
  const overrides: Record<string, string> = {};
  for (const entry of mapping) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      if (strict) throw new Error("failed to load docs path overrides: every mapping entry must be a mapping");
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.artifact === "string" && typeof e.path === "string") overrides[e.artifact] = e.path;
    else if (strict) throw new Error("failed to load docs path overrides: every mapping entry requires string artifact and path fields");
  }
  return overrides;
}

export function loadDocsPathOverrides(projectRoot: string, strict = false): Record<string, string> {
  const docsPath = path.join(projectRoot, ".agentera", "docs.yaml");
  if (!fs.existsSync(docsPath)) {
    return {};
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(docsPath);
  } catch (exc) {
    if (strict) throw new Error(`failed to load docs path overrides: ${(exc as Error).message}`);
    process.stderr.write(
      `warning: failed to load docs path overrides: ${(exc as Error).message}\n`,
    );
    return {};
  }
  return docsPathOverridesFromBytes(bytes, strict);
}

export interface ResolveArtifactPathOptions {
  activeObjectiveName?: string | null;
  strictWrite?: boolean;
  docsPathOverrides?: Readonly<Record<string, string>>;
}

function nearestExistingAncestor(p: string): string {
  let current = p;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.realpathSync.native(current);
}

export function assertRealpathBoundary(
  projectRoot: string,
  artifactPath: string,
  artifactId: string,
): void {
  const projectReal = nearestExistingAncestor(resolvePath(projectRoot));
  const ancestorReal = nearestExistingAncestor(artifactPath);
  const rel = path.relative(projectReal, ancestorReal);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`artifact '${artifactId}' path escapes the project boundary`);
  }
}

export function resolveArtifactPath(
  record: ArtifactRecord,
  projectRoot: string,
  activeObjectiveNameOrOptions: string | null | ResolveArtifactPathOptions = null,
  env: Record<string, string | undefined> = process.env,
): string {
  const options =
    typeof activeObjectiveNameOrOptions === "object" && activeObjectiveNameOrOptions !== null
      ? activeObjectiveNameOrOptions
      : { activeObjectiveName: activeObjectiveNameOrOptions };
  const activeObjectiveName = options.activeObjectiveName ?? null;
  let artifactPath = record.defaultPath;
  const overrides = options.docsPathOverrides ?? loadDocsPathOverrides(projectRoot, options.strictWrite === true);
  if (record.docsYamlCanOverridePath && record.displayName in overrides) {
    artifactPath = overrides[record.displayName];
  }
  if (artifactPath.includes("<name>") && activeObjectiveName) {
    artifactPath = artifactPath.replace(/<name>/g, activeObjectiveName);
  }
  const profileDirPrefixes = ["$AGENTERA_PROFILE_DIR/", "$PROFILERA_PROFILE_DIR/"] as const;
  for (const prefix of profileDirPrefixes) {
    if (artifactPath.startsWith(prefix)) {
      const suffix = artifactPath.slice(prefix.length);
      const explicit = resolveProfileDirOverride(env);
      if (explicit) {
        return path.join(explicit, suffix);
      }
      const [base] = resolveCandidate(null, { env, home: os.homedir() });
      return path.join(base, suffix);
    }
  }
  const resolved = projectPath(projectRoot, artifactPath, record.artifactId);
  if (options.strictWrite) assertRealpathBoundary(projectRoot, resolved, record.artifactId);
  return resolved;
}

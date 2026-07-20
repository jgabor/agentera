import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

/** PackageManifest registry loader and contract validator. Port of scripts/package_registry.py. */

export const EXPECTED_PACKAGE_ORDER = ["agentera"] as const;

export const REQUIRED_GROUPS = [
  "identity",
  "version_authority",
  "version_surfaces",
  "bundle_surfaces",
  "docs_targets",
  "release_policy",
] as const;

const REQUIRED_FIELDS: Record<string, string[]> = {
  identity: ["id", "name", "skill_path", "expected_capabilities"],
  version_authority: [
    "persisted_authority",
    "selector",
    "access_interface",
    "future_authority_change_requires",
  ],
  version_surfaces: ["surfaces"],
  bundle_surfaces: ["directories", "files", "generated_files", "skip_parts", "skip_suffixes"],
  docs_targets: ["version_files_source", "version_files", "index_targets"],
  release_policy: [
    "semver_policy_source",
    "version_bump_required_for_interface_only_change",
    "release_publication_in_scope",
  ],
};

const CONSUMER_GROUPS: Record<string, readonly string[]> = {
  validator: ["identity", "version_authority", "version_surfaces"],
  upgrade: ["identity", "version_authority", "bundle_surfaces"],
  docs: ["identity", "version_authority", "docs_targets", "release_policy"],
  tests: REQUIRED_GROUPS,
};

const FORBIDDEN_INSTALL_ROOT_FIELDS = new Set([
  "install_root",
  "install_root_classification",
  "AGENTERA_HOME_precedence",
  "default_durable_root",
  "managed_classification",
  "root_diagnostics",
]);
const FORBIDDEN_RUNTIME_ADAPTER_FIELDS = new Set([
  "runtime_discovery",
  "host_detection",
  "lifecycle_events",
  "artifact_validation",
  "config_targets",
  "diagnostics",
  "documentation_claims",
]);

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function defaultRoot(): string {
  return resolveSourceRoot();
}

export function defaultRegistryPath(root: string = defaultRoot()): string {
  return path.join(root, "references/adapters/package-registry.yaml");
}

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

interface PackageRegistrySurface extends JsonObject {
  id: string;
  path: string;
  selector: string;
}

interface PackageRegistryRecord extends JsonObject {
  identity: { id: string; name: string; skill_path: string; expected_capabilities: number } & JsonObject;
  version_authority: {
    persisted_authority: string;
    selector: string;
    access_interface: string;
    future_authority_change_requires: string;
  } & JsonObject;
  version_surfaces: {
    surfaces: PackageRegistrySurface[];
  } & JsonObject;
}

function selectorParts(selector: string): Array<string | number> {
  const parts: Array<string | number> = [];
  for (const match of selector.matchAll(/([^[.\]]+)|\[(\d+)\]/g)) {
    parts.push(match[2] === undefined ? match[1] : Number(match[2]));
  }
  return parts;
}

function selectedVersion(root: string, surface: PackageRegistrySurface): string | null {
  const source = fs.readFileSync(path.join(root, surface.path), "utf8");
  if (surface.selector === "frontmatter.version") {
    return /^version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(source)?.[1] ?? null;
  }
  let value: unknown = JSON.parse(source);
  for (const part of selectorParts(surface.selector)) {
    if (typeof part === "number") {
      value = Array.isArray(value) ? value[part] : undefined;
    } else {
      value = isMapping(value) ? value[part] : undefined;
    }
  }
  return typeof value === "string" ? value : null;
}

export class PackageRegistry {
  records: PackageRegistryRecord[];
  root: string;

  constructor(records: PackageRegistryRecord[], root: string = defaultRoot()) {
    this.records = records;
    this.root = root;
  }

  get packageIds(): string[] {
    return this.records.map((record) => record.identity.id);
  }

  get(packageId = "agentera"): PackageRegistryRecord {
    for (const record of this.records) {
      if (record.identity.id === packageId) {
        return record;
      }
    }
    throw new RegistryError(`unknown package id: ${packageId}`);
  }

  suiteVersion(packageId = "agentera"): string {
    const record = this.get(packageId);
    const authority = record.version_authority;
    if (
      authority.persisted_authority !== "registry.json" ||
      authority.selector !== "skills[0].version"
    ) {
      throw new RegistryError("unsupported suite version authority selector");
    }
    let data: any; // cast: JSON.parse IO boundary
    try {
      data = JSON.parse(fs.readFileSync(path.join(this.root, authority.persisted_authority), "utf8"));
    } catch {
      throw new RegistryError(`registry.json missing skills[0].version`);
    }
    const version = data?.skills?.[0]?.version;
    if (version === undefined) {
      throw new RegistryError("registry.json missing skills[0].version");
    }
    if (typeof version !== "string" || !version) {
      throw new RegistryError("registry.json skills[0].version must be a non-empty string");
    }
    return version;
  }

  consumerView(consumer: string, packageId = "agentera"): JsonObject {
    const groups = CONSUMER_GROUPS[consumer];
    if (groups === undefined) {
      throw new RegistryError(`unknown registry consumer: ${consumer}`);
    }
    const record = this.get(packageId);
    const view: JsonObject = {};
    for (const group of groups) {
      view[group] = record[group];
    }
    view.suite_version = this.suiteVersion(packageId);
    return view;
  }

  versionSurfaceIds(packageId = "agentera"): string[] {
    return this.get(packageId).version_surfaces.surfaces.map((s) => s.id);
  }

  versionSurfaceValues(packageId = "agentera"): Record<string, string | null> {
    const values: Record<string, string | null> = {};
    for (const surface of this.get(packageId).version_surfaces.surfaces) {
      values[surface.id] = selectedVersion(this.root, surface);
    }
    return values;
  }

}

export function loadRegistry(
  registryPath: string = defaultRegistryPath(),
  root: string = defaultRoot(),
): PackageRegistry {
  const data = loadYamlMapping(fs.readFileSync(registryPath, "utf8"));
  const errors = validateRegistryData(data, root);
  if (errors.length > 0) {
    throw new RegistryError("PackageManifest registry validation failed: " + errors.join("; "));
  }
  return new PackageRegistry(data.records as PackageRegistryRecord[], root); // cast: parsed registry IO boundary
}

export function validateRegistryFile(
  registryPath: string = defaultRegistryPath(),
  root: string = defaultRoot(),
): string[] {
  return validateRegistryData(loadYamlMapping(fs.readFileSync(registryPath, "utf8")), root);
}

export function validateRegistryData(data: unknown, root: string = defaultRoot()): string[] {
  const errors: string[] = [];
  if (!isMapping(data)) {
    return ["registry must be a YAML object"];
  }
  if (data.schema_version !== "agentera.packageRegistry.v1") {
    errors.push("registry.schema_version must be agentera.packageRegistry.v1");
  }
  if (JSON.stringify(data.package_order) !== JSON.stringify([...EXPECTED_PACKAGE_ORDER])) {
    errors.push("registry.package_order must be agentera");
  }

  const records = data.records;
  if (!Array.isArray(records)) {
    return [...errors, "registry.records must be a list"];
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  records.forEach((record, index) => {
    const prefix = `records[${index}]`;
    if (!isMapping(record)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    errors.push(...validateForbiddenFields(prefix, record));
    for (const group of REQUIRED_GROUPS) {
      if (!(group in record)) {
        errors.push(`${prefix}: missing required group ${group}`);
      }
    }
    for (const group of Object.keys(record)) {
      if (!(REQUIRED_GROUPS as readonly string[]).includes(group)) {
        errors.push(`${prefix}: unknown group ${group}`);
      }
    }
    for (const group of REQUIRED_GROUPS) {
      const groupValue = record[group];
      if (isMapping(groupValue)) {
        errors.push(...validateGroup(`${prefix}.${group}`, group, groupValue, root));
      } else if (group in record) {
        errors.push(`${prefix}.${group} must be an object`);
      }
    }

    const identity = record.identity;
    const packageId = isMapping(identity) ? identity.id : null;
    if (typeof packageId !== "string") {
      return;
    }
    ids.push(packageId);
    if (!(EXPECTED_PACKAGE_ORDER as readonly string[]).includes(packageId)) {
      errors.push(`${prefix}.identity.id unknown package id: ${packageId}`);
    }
    if (seen.has(packageId)) {
      errors.push(`duplicate package id: ${packageId}`);
    }
    seen.add(packageId);
  });

  if (JSON.stringify(ids) !== JSON.stringify([...EXPECTED_PACKAGE_ORDER])) {
    errors.push("registry.records must be ordered as agentera");
  }
  return errors;
}

function validateGroup(prefix: string, group: string, value: JsonObject, root: string): string[] {
  const errors: string[] = [];
  errors.push(...validateForbiddenFields(prefix, value));
  for (const field of REQUIRED_FIELDS[group]) {
    if (!(field in value)) {
      errors.push(`${prefix}: missing required field ${field}`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!REQUIRED_FIELDS[group].includes(field)) {
      errors.push(`${prefix}: unknown field ${field}`);
    }
  }

  switch (group) {
    case "identity":
      errors.push(...validateIdentity(prefix, value, root));
      break;
    case "version_authority":
      errors.push(...validateVersionAuthority(prefix, value, root));
      break;
    case "version_surfaces":
      errors.push(...validateVersionSurfaces(prefix, value, root));
      break;
    case "bundle_surfaces":
      errors.push(...validateBundleSurfaces(prefix, value));
      break;
    case "docs_targets":
      errors.push(...validateDocsTargets(prefix, value, root));
      break;
    case "release_policy":
      errors.push(...validateReleasePolicy(prefix, value));
      break;
  }
  return errors;
}

function validateIdentity(prefix: string, value: JsonObject, root: string): string[] {
  const errors: string[] = [];
  for (const field of ["id", "name"]) {
    if (typeof value[field] !== "string" || !value[field]) {
      errors.push(`${prefix}.${field} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(value.expected_capabilities)) {
    errors.push(`${prefix}.expected_capabilities must be an integer`);
  }
  errors.push(...validateRepoPath(`${prefix}.skill_path`, value.skill_path, root));
  return errors;
}

function validateVersionAuthority(prefix: string, value: JsonObject, root: string): string[] {
  const errors: string[] = [];
  errors.push(...validateRepoPath(`${prefix}.persisted_authority`, value.persisted_authority, root));
  for (const field of ["selector", "access_interface", "future_authority_change_requires"]) {
    if (typeof value[field] !== "string" || !value[field]) {
      errors.push(`${prefix}.${field} must be a non-empty string`);
    }
  }
  if (value.access_interface !== "PackageManifest") {
    errors.push(`${prefix}.access_interface must be PackageManifest`);
  }
  return errors;
}

function validateVersionSurfaces(prefix: string, value: JsonObject, root: string): string[] {
  const errors: string[] = [];
  const surfaces = value.surfaces;
  if (!Array.isArray(surfaces)) {
    errors.push(`${prefix}.surfaces must be a list`);
  } else {
    errors.push(...validateIdList(`${prefix}.surfaces`, surfaces));
    surfaces.forEach((surface, index) => {
      const surfacePrefix = `${prefix}.surfaces[${index}]`;
      if (!isMapping(surface)) {
        errors.push(`${surfacePrefix} must be an object`);
        return;
      }
      errors.push(...validateRequiredObjectFields(surfacePrefix, surface, ["id", "path", "selector"]));
      errors.push(...validateRepoPath(`${surfacePrefix}.path`, surface.path, root));
    });
  }
  return errors;
}

function validateBundleSurfaces(prefix: string, value: JsonObject): string[] {
  const errors: string[] = [];
  const ids = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const field of ["directories", "files"]) {
    const entries = value[field];
    if (!Array.isArray(entries)) {
      errors.push(`${prefix}.${field} must be a list`);
      continue;
    }
    entries.forEach((entry, index) => {
      const entryPrefix = `${prefix}.${field}[${index}]`;
      if (!isMapping(entry)) {
        errors.push(`${entryPrefix} must be an object`);
        return;
      }
      errors.push(...validateRequiredObjectFields(entryPrefix, entry, ["id", "path"]));
      const entryId = entry.id;
      if (typeof entryId === "string" && entryId.length > 0) {
        const previous = ids.get(entryId);
        if (previous !== undefined) {
          errors.push(
            `${entryPrefix}.id ${JSON.stringify(entryId)} duplicates ${previous}.id; ` +
              "correction: use a unique id across bundle directories and files",
          );
        } else {
          ids.set(entryId, entryPrefix);
        }
      }
      const entryPath = entry.path;
      errors.push(...validateBundlePath(entryPrefix, entryId, entryPath));
      if (typeof entryPath === "string" && entryPath.length > 0) {
        const previous = paths.get(entryPath);
        if (previous !== undefined) {
          errors.push(
            `${entryPrefix}.path ${JSON.stringify(entryPath)} for id ${JSON.stringify(entryId)} ` +
              `duplicates ${previous}.path; correction: use a unique path across bundle directories and files`,
          );
        } else {
          paths.set(entryPath, entryPrefix);
        }
      }
    });
  }
  for (const field of ["skip_parts", "skip_suffixes"]) {
    if (!isStringList(value[field])) {
      errors.push(`${prefix}.${field} must be a list of strings`);
    }
  }
  return errors;
}

function validateBundlePath(prefix: string, id: unknown, value: unknown): string[] {
  const segments = typeof value === "string" ? value.split("/") : [];
  const invalid =
    typeof value !== "string" ||
    value.length === 0 ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.startsWith("./") ||
    value.endsWith("/") ||
    segments.includes(".") ||
    segments.includes("..") ||
    path.posix.normalize(value) !== value;
  if (!invalid) return [];
  return [
    `${prefix}.path ${JSON.stringify(value)} for id ${JSON.stringify(id)} is invalid; ` +
      "correction: use a non-empty normalized relative POSIX path without absolute roots, " +
      "drive prefixes, backslashes, leading './', trailing separators, or '.'/'..' segments",
  ];
}

function validateDocsTargets(prefix: string, value: JsonObject, root: string): string[] {
  const errors: string[] = [];
  if (typeof value.version_files_source !== "string" || !value.version_files_source) {
    errors.push(`${prefix}.version_files_source must be a non-empty string`);
  }
  for (const field of ["version_files", "index_targets"]) {
    errors.push(...validatePathList(`${prefix}.${field}`, value[field], root));
  }
  return errors;
}

function validateReleasePolicy(prefix: string, value: JsonObject): string[] {
  const errors: string[] = [];
  if (typeof value.semver_policy_source !== "string" || !value.semver_policy_source) {
    errors.push(`${prefix}.semver_policy_source must be a non-empty string`);
  }
  for (const field of [
    "version_bump_required_for_interface_only_change",
    "release_publication_in_scope",
  ]) {
    if (typeof value[field] !== "boolean") {
      errors.push(`${prefix}.${field} must be a boolean`);
    }
  }
  return errors;
}

function validateRequiredObjectFields(prefix: string, value: JsonObject, expected: string[]): string[] {
  const errors: string[] = [];
  for (const field of expected) {
    if (!(field in value)) {
      errors.push(`${prefix}: missing required field ${field}`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!expected.includes(field)) {
      errors.push(`${prefix}: unknown field ${field}`);
    }
  }
  for (const field of ["id", "selector"]) {
    if (field in value && (typeof value[field] !== "string" || !value[field])) {
      errors.push(`${prefix}.${field} must be a non-empty string`);
    }
  }
  return errors;
}

function validateIdList(prefix: string, entries: any[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (!isMapping(entry)) {
      return;
    }
    const entryId = entry.id;
    if (typeof entryId !== "string" || !entryId) {
      errors.push(`${prefix}[${index}].id must be a non-empty string`);
      return;
    }
    if (seen.has(entryId)) {
      errors.push(`${prefix}: duplicate id ${entryId}`);
    }
    seen.add(entryId);
  });
  return errors;
}

function validatePathList(prefix: string, value: unknown, root: string): string[] {
  if (!isStringList(value)) {
    return [`${prefix} must be a list of repo-relative paths`];
  }
  const errors: string[] = [];
  (value as string[]).forEach((p, index) => {
    errors.push(...validateRepoPath(`${prefix}[${index}]`, p, root));
  });
  return errors;
}

function validateRepoPath(prefix: string, value: unknown, root: string): string[] {
  if (typeof value !== "string" || !value) {
    return [`${prefix} must be a repo-relative path`];
  }
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    return [`${prefix} must stay inside repo root`];
  }
  const resolvedRoot = resolvePath(root);
  const resolved = resolvePath(path.join(resolvedRoot, value));
  const rel = path.relative(resolvedRoot, resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    return [`${prefix} must stay inside repo root`];
  }
  // Existence is advisory for a package distribution spec: version files and
  // build outputs may be generated at build/release time and need not be
  // present in every checkout. Structural and traversal safety above still
  // apply.
  return [];
}

function validateForbiddenFields(prefix: string, value: JsonObject): string[] {
  const errors: string[] = [];
  for (const field of Object.keys(value).sort()) {
    if (FORBIDDEN_INSTALL_ROOT_FIELDS.has(field)) {
      errors.push(`${prefix}: forbidden install-root field ${field}`);
    }
    if (FORBIDDEN_RUNTIME_ADAPTER_FIELDS.has(field)) {
      errors.push(`${prefix}: forbidden RuntimeAdapter field ${field}`);
    }
    const nested = value[field];
    if (isMapping(nested)) {
      errors.push(...validateForbiddenFields(`${prefix}.${field}`, nested));
    } else if (Array.isArray(nested)) {
      nested.forEach((item, index) => {
        if (isMapping(item)) {
          errors.push(...validateForbiddenFields(`${prefix}.${field}[${index}]`, item));
        }
      });
    }
  }
  return errors;
}

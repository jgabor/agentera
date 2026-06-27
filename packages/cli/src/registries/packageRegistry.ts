import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { pathExists, resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

/** PackageManifest registry loader and contract validator. Port of scripts/package_registry.py. */

export const EXPECTED_PACKAGE_ORDER = ["agentera"] as const;

export const REQUIRED_GROUPS = [
  "identity",
  "version_authority",
  "version_surfaces",
  "runtime_package_manifests",
  "bundle_surfaces",
  "package_commands",
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
  version_surfaces: ["surfaces", "excluded_runtime_manifests"],
  runtime_package_manifests: ["manifests", "shared_paths", "shared_paths_policy"],
  bundle_surfaces: ["directories", "files", "skip_parts", "skip_suffixes"],
  package_commands: ["commands", "safety"],
  docs_targets: ["version_files_source", "version_files", "index_targets", "excluded_version_files"],
  release_policy: [
    "semver_policy_source",
    "version_bump_required_for_interface_only_change",
    "release_publication_in_scope",
  ],
};

const CONSUMER_GROUPS: Record<string, readonly string[]> = {
  validator: ["identity", "version_authority", "version_surfaces", "runtime_package_manifests"],
  upgrade: ["identity", "version_authority", "bundle_surfaces", "package_commands"],
  docs: ["identity", "version_authority", "docs_targets", "release_policy"],
  tests: REQUIRED_GROUPS,
};

const APPROVED_EXECUTABLES = new Set(["npx"]);
const APPROVED_ACTIONS = new Set(["remove-legacy-skills", "install-agentera-skill"]);
const APPROVED_RUNTIMES = new Set(["all", "claude", "opencode"]);
const APPROVED_RUNTIME_AGENTS = new Set(["claude-code", "opencode"]);
const CLEANUP_ACTIONS = new Set(["remove-legacy-skills"]);
const RUNTIME_INSTALL_ACTIONS = new Set(["install-agentera-skill"]);
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

export class PackageRegistry {
  records: JsonObject[];
  root: string;

  constructor(records: JsonObject[], root: string = defaultRoot()) {
    this.records = records;
    this.root = root;
  }

  get packageIds(): string[] {
    return this.records.map((record) => (record.identity as JsonObject).id as string); // cast: parsed registry IO data
  }

  get(packageId = "agentera"): JsonObject {
    for (const record of this.records) {
      if (((record.identity as JsonObject).id as string) === packageId) { // cast: parsed registry IO data
        return record;
      }
    }
    throw new RegistryError(`unknown package id: ${packageId}`);
  }

  suiteVersion(packageId = "agentera"): string {
    const record = this.get(packageId);
    const authority = record.version_authority as JsonObject; // cast: parsed registry IO data
    if (
      authority.persisted_authority !== "registry.json" ||
      authority.selector !== "skills[0].version"
    ) {
      throw new RegistryError("unsupported suite version authority selector");
    }
    let data: any; // cast: JSON.parse IO boundary
    try {
      data = JSON.parse(fs.readFileSync(path.join(this.root, authority.persisted_authority as string), "utf8"));
    } catch (exc) {
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
    return ((this.get(packageId).version_surfaces as JsonObject).surfaces as JsonObject[]).map(
      (s) => s.id as string,
    ); // cast: parsed registry IO data
  }

  runtimeManifestIds(packageId = "agentera"): string[] {
    return ((this.get(packageId).runtime_package_manifests as JsonObject).manifests as JsonObject[]).map(
      (m) => m.id as string,
    ); // cast: parsed registry IO data
  }

  runtimeManifestPaths(packageId = "agentera"): Record<string, string> {
    const paths: Record<string, string> = {};
    for (const manifest of (this.get(packageId).runtime_package_manifests as JsonObject).manifests as JsonObject[]) { // cast: parsed registry IO data
      if (!((manifest.runtime as string) in paths)) {
        paths[manifest.runtime as string] = manifest.path as string;
      }
    }
    return paths;
  }

  runtimePackageShapes(packageId = "agentera"): Record<string, string> {
    const shapes: Record<string, string> = {};
    for (const manifest of (this.get(packageId).runtime_package_manifests as JsonObject).manifests as JsonObject[]) { // cast: parsed registry IO data
      shapes[manifest.runtime as string] = manifest.package_shape as string;
    }
    return shapes;
  }

  sharedPathRequirements(packageId = "agentera"): Record<string, string> {
    const requirements: Record<string, string> = {};
    for (const entry of (this.get(packageId).runtime_package_manifests as JsonObject).shared_paths as JsonObject[]) { // cast: parsed registry IO data
      requirements[entry.path as string] = entry.kind as string;
    }
    return requirements;
  }

  nonVersionBearingRuntimeManifests(packageId = "agentera"): JsonObject[] {
    return ((this.get(packageId).runtime_package_manifests as JsonObject).manifests as JsonObject[]).filter(
      (m) => m.version_bearing === false,
    ); // cast: parsed registry IO data
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
  return new PackageRegistry((data as JsonObject).records as JsonObject[], root); // cast: YAML parse IO boundary
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
    case "runtime_package_manifests":
      errors.push(...validateRuntimeManifests(prefix, value, root));
      break;
    case "bundle_surfaces":
      errors.push(...validateBundleSurfaces(prefix, value, root));
      break;
    case "package_commands":
      errors.push(...validatePackageCommands(prefix, value));
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
  errors.push(
    ...validatePathList(`${prefix}.excluded_runtime_manifests`, value.excluded_runtime_manifests, root),
  );
  return errors;
}

function validateRuntimeManifests(prefix: string, value: JsonObject, root: string): string[] {
  const errors: string[] = [];
  const manifests = value.manifests;
  if (!Array.isArray(manifests)) {
    errors.push(`${prefix}.manifests must be a list`);
  } else {
    errors.push(...validateIdList(`${prefix}.manifests`, manifests));
    let nonVersionBearing = 0;
    manifests.forEach((manifest, index) => {
      const manifestPrefix = `${prefix}.manifests[${index}]`;
      if (!isMapping(manifest)) {
        errors.push(`${manifestPrefix} must be an object`);
        return;
      }
      errors.push(
        ...validateRequiredObjectFields(manifestPrefix, manifest, [
          "id",
          "runtime",
          "path",
          "version_bearing",
          "package_shape",
        ]),
      );
      errors.push(...validateRepoPath(`${manifestPrefix}.path`, manifest.path, root));
      if (typeof manifest.version_bearing !== "boolean") {
        errors.push(`${manifestPrefix}.version_bearing must be a boolean`);
      } else if (manifest.version_bearing === false) {
        nonVersionBearing += 1;
      }
    });
    if (nonVersionBearing === 0) {
      errors.push(
        `${prefix}.manifests must include non-version-bearing runtime package manifests separately`,
      );
    }
  }
  const sharedPaths = value.shared_paths;
  if (!Array.isArray(sharedPaths)) {
    errors.push(`${prefix}.shared_paths must be a list`);
  } else {
    errors.push(...validateIdList(`${prefix}.shared_paths`, sharedPaths));
    sharedPaths.forEach((entry, index) => {
      const entryPrefix = `${prefix}.shared_paths[${index}]`;
      if (!isMapping(entry)) {
        errors.push(`${entryPrefix} must be an object`);
        return;
      }
      errors.push(...validateRequiredObjectFields(entryPrefix, entry, ["id", "path", "kind"]));
      errors.push(...validateRepoPath(`${entryPrefix}.path`, entry.path, root));
      if (entry.kind !== "dir" && entry.kind !== "file") {
        errors.push(`${entryPrefix}.kind must be dir or file`);
      }
    });
  }
  if (typeof value.shared_paths_policy !== "string" || !value.shared_paths_policy) {
    errors.push(`${prefix}.shared_paths_policy must be a non-empty string`);
  }
  return errors;
}

function validateBundleSurfaces(prefix: string, value: JsonObject, root: string): string[] {
  const errors: string[] = [];
  for (const field of ["directories", "files"]) {
    const entries = value[field];
    if (!Array.isArray(entries)) {
      errors.push(`${prefix}.${field} must be a list`);
      continue;
    }
    errors.push(...validateIdList(`${prefix}.${field}`, entries));
    entries.forEach((entry, index) => {
      const entryPrefix = `${prefix}.${field}[${index}]`;
      if (!isMapping(entry)) {
        errors.push(`${entryPrefix} must be an object`);
        return;
      }
      errors.push(...validateRequiredObjectFields(entryPrefix, entry, ["id", "path"]));
      errors.push(...validateRepoPath(`${entryPrefix}.path`, entry.path, root));
    });
  }
  for (const field of ["skip_parts", "skip_suffixes"]) {
    if (!isStringList(value[field])) {
      errors.push(`${prefix}.${field} must be a list of strings`);
    }
  }
  return errors;
}

function validatePackageCommands(prefix: string, value: JsonObject): string[] {
  const errors: string[] = [];
  const commands = value.commands;
  if (!Array.isArray(commands)) {
    errors.push(`${prefix}.commands must be a list`);
  } else {
    errors.push(...validateIdList(`${prefix}.commands`, commands));
    commands.forEach((command, index) => {
      const commandPrefix = `${prefix}.commands[${index}]`;
      if (!isMapping(command)) {
        errors.push(`${commandPrefix} must be an object`);
        return;
      }
      errors.push(
        ...validateRequiredObjectFields(commandPrefix, command, [
          "id",
          "runtime",
          "action",
          "phase",
          "argv",
          "skipped_without_update_packages_message",
        ]),
      );
      errors.push(...validateCommandSpec(commandPrefix, command));
    });
  }
  const safety = value.safety;
  const expectedSafety: JsonObject = {
    argv_only: true,
    update_packages_required_to_plan: true,
    yes_required_to_execute: true,
    preserve_existing_write_gates: true,
    cleanup_phase: "cleanup",
    runtime_install_phase: "runtime-install",
  };
  if (!isMapping(safety)) {
    errors.push(`${prefix}.safety must be an object`);
  } else if (!shallowEqual(safety, expectedSafety)) {
    errors.push(`${prefix}.safety must preserve approved write gates and phase names`);
  }
  return errors;
}

function validateDocsTargets(prefix: string, value: JsonObject, root: string): string[] {
  const errors: string[] = [];
  if (typeof value.version_files_source !== "string" || !value.version_files_source) {
    errors.push(`${prefix}.version_files_source must be a non-empty string`);
  }
  for (const field of ["version_files", "index_targets", "excluded_version_files"]) {
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

function validateCommandSpec(prefix: string, command: JsonObject): string[] {
  const errors: string[] = [];
  const runtime = command.runtime as string; // cast: parsed registry IO data
  const action = command.action as string;
  const phase = command.phase as string;
  const argv = command.argv as string[];
  if (!APPROVED_RUNTIMES.has(runtime)) {
    errors.push(`${prefix}.runtime ${pyRepr(runtime)} is not approved`);
  }
  if (!APPROVED_ACTIONS.has(action)) {
    errors.push(`${prefix}.action ${pyRepr(action)} is not approved`);
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) {
    errors.push(`${prefix}.argv must be a list of strings`);
    return errors;
  }
  if (!APPROVED_EXECUTABLES.has(argv[0])) {
    errors.push(`${prefix}.argv uses unapproved executable ${pyRepr(argv[0])}`);
  }
  if (argv.length < 3 || argv[1] !== "skills" || !["remove", "add"].includes(argv[2])) {
    errors.push(`${prefix}.argv must use approved skills action`);
  }
  if (CLEANUP_ACTIONS.has(action) && (runtime !== "all" || phase !== "cleanup" || argv[2] !== "remove")) {
    errors.push(`${prefix}: cleanup commands must stay separate from runtime installs`);
  }
  if (RUNTIME_INSTALL_ACTIONS.has(action)) {
    if (runtime === "all" || phase !== "runtime-install" || argv[2] !== "add") {
      errors.push(`${prefix}: runtime install commands must stay out of cleanup`);
    }
    if (!argv.includes("-a")) {
      errors.push(`${prefix}: runtime install commands must declare runtime agent`);
    } else {
      const agentIndex = argv.indexOf("-a") + 1;
      const agent = agentIndex < argv.length ? argv[agentIndex] : null;
      if (agent === null || !APPROVED_RUNTIME_AGENTS.has(agent)) {
        errors.push(`${prefix}: runtime install agent ${pyRepr(agent)} is not approved`);
      }
    }
  }
  if (typeof command.skipped_without_update_packages_message !== "string") {
    errors.push(`${prefix}.skipped_without_update_packages_message must be a string`);
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
  for (const field of ["id", "runtime", "action", "phase", "selector", "package_shape"]) {
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
  // Existence is advisory for a package DISTRIBUTION spec: surfaces such as
  // version files, plugin manifests, and build outputs may be generated at
  // build/release time or be runtime-specific, and need not be present in every
  // checkout (e.g. a node-only tree without the Python build files). Structural
  // and traversal safety above still apply.
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

function shallowEqual(a: JsonObject, b: JsonObject): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) {
    return false;
  }
  for (const k of ak) {
    if (a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}

/** Mirror Python repr() for the scalar values used in validator messages. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    return `'${value}'`;
  }
  return String(value);
}

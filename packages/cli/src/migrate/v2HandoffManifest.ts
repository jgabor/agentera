import fs from "node:fs";
import path from "node:path";

import {
  AGENTERA_PROFILE_DIR_ENV,
  PROFILERA_PROFILE_DIR_ENV,
  resolveProfileDirOverride,
} from "../core/envPaths.js";
import { expanduser, isFile, pathExists, resolvePath } from "../core/paths.js";
import { opencodeConfigDir } from "../setup/opencode.js";
import { doctorRoots, loadSuiteVersion } from "../upgrade/appModel.js";
import {
  AGENTERA_USER_STATE_NAMES,
  ROOT_USER_STATE_DIR_NAMES,
  ROOT_USER_STATE_FILE_NAMES,
} from "../upgrade/doctor.js";

/** Contract authority: references/cli/v3-handoff-manifest.schema.yaml */
export const V2_HANDOFF_MANIFEST_SCHEMA_REL = "references/cli/v3-handoff-manifest.schema.yaml";
export const V2_HANDOFF_MANIFEST_FILENAME = "v3-handoff.json";
export const V2_HANDOFF_SCHEMA_VERSION = "agentera.v3_handoff_manifest.v1";
export const READER_PREFLIGHT_BUDGET_MS = 100;

export const USER_DATA_CATALOG_DIRS = [
  "benchmarks",
  "intermediate",
  "sessions",
  "history",
  "corpus",
] as const;

export const PROFILE_FILE_MEMBERS = ["PROFILE.md", "USAGE.md"] as const;

export type UserDataCatalogId =
  | (typeof USER_DATA_CATALOG_DIRS)[number]
  | "profile_files";

export interface UserDataDirectoryEntry {
  id: (typeof USER_DATA_CATALOG_DIRS)[number];
  relative_path: string;
  kind: "directory";
  exists: boolean;
}

export interface UserDataFileMember {
  relative_path: string;
  kind: "file";
  exists: boolean;
}

export interface UserDataProfileFilesEntry {
  id: "profile_files";
  kind: "profile_files";
  members: UserDataFileMember[];
}

export type UserDataInventoryEntry = UserDataDirectoryEntry | UserDataProfileFilesEntry;

export interface V2HandoffManifest {
  schema_version: typeof V2_HANDOFF_SCHEMA_VERSION;
  written_at: string;
  installed_v2_version: string;
  app_home_path: string;
  user_data_inventory: UserDataInventoryEntry[];
  runtime_adapters: string[];
}

export type MigrationPreflightSource = "manifest" | "scan";

export type HandoffCatalogSurface = "custom_profile_dir" | "opencode_runtime_config_dir";

export interface HandoffCatalogEntry {
  surface: HandoffCatalogSurface;
  root: string;
  envVar: string;
  entries: string[];
}

export interface MigrationUserStatePreflightOpts {
  home?: string;
  env?: Record<string, string | undefined>;
}

export interface MigrationUserStatePreflight {
  source: MigrationPreflightSource;
  elapsedMs: number;
  manifest: V2HandoffManifest | null;
  preservedTopLevel: string[];
  preservedAbsolutePaths: string[];
  handoffCatalog: HandoffCatalogEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseDirectoryEntry(raw: Record<string, unknown>): UserDataDirectoryEntry {
  const id = asNonEmptyString(raw.id, "user_data_inventory.id");
  if (!USER_DATA_CATALOG_DIRS.includes(id as (typeof USER_DATA_CATALOG_DIRS)[number])) {
    throw new Error(`user_data_inventory id ${id} is not in the catalog`);
  }
  if (raw.kind !== "directory") {
    throw new Error(`user_data_inventory entry ${id} must have kind=directory`);
  }
  if (typeof raw.exists !== "boolean") {
    throw new Error(`user_data_inventory entry ${id} must have boolean exists`);
  }
  return {
    id: id as (typeof USER_DATA_CATALOG_DIRS)[number],
    relative_path: asNonEmptyString(raw.relative_path, `user_data_inventory.${id}.relative_path`),
    kind: "directory",
    exists: raw.exists,
  };
}

function parseProfileFilesEntry(raw: Record<string, unknown>): UserDataProfileFilesEntry {
  if (raw.id !== "profile_files") {
    throw new Error("profile_files entry must have id=profile_files");
  }
  if (raw.kind !== "profile_files") {
    throw new Error("profile_files entry must have kind=profile_files");
  }
  if (!Array.isArray(raw.members)) {
    throw new Error("profile_files entry must have members array");
  }
  const members: UserDataFileMember[] = raw.members.map((member, index) => {
    if (!isRecord(member)) {
      throw new Error(`profile_files.members[${index}] must be an object`);
    }
    if (member.kind !== "file") {
      throw new Error(`profile_files.members[${index}] must have kind=file`);
    }
    if (typeof member.exists !== "boolean") {
      throw new Error(`profile_files.members[${index}] must have boolean exists`);
    }
    return {
      relative_path: asNonEmptyString(
        member.relative_path,
        `profile_files.members[${index}].relative_path`,
      ),
      kind: "file",
      exists: member.exists,
    };
  });
  return { id: "profile_files", kind: "profile_files", members };
}

function parseUserDataInventory(raw: unknown): UserDataInventoryEntry[] {
  if (!Array.isArray(raw) || raw.length < 6) {
    throw new Error("user_data_inventory must be an array with at least six entries");
  }
  const entries = raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`user_data_inventory[${index}] must be an object`);
    }
    if (item.kind === "profile_files") {
      return parseProfileFilesEntry(item);
    }
    return parseDirectoryEntry(item);
  });
  const ids = new Set(entries.map((entry) => entry.id));
  for (const id of [...USER_DATA_CATALOG_DIRS, "profile_files"] as const) {
    if (!ids.has(id)) {
      throw new Error(`user_data_inventory missing catalog id ${id}`);
    }
  }
  return entries;
}

export function parseV2HandoffManifest(raw: unknown): V2HandoffManifest {
  if (!isRecord(raw)) {
    throw new Error("manifest must be a JSON object");
  }
  const schemaVersion = asNonEmptyString(raw.schema_version, "schema_version");
  if (schemaVersion !== V2_HANDOFF_SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${V2_HANDOFF_SCHEMA_VERSION}`);
  }
  const writtenAt = asNonEmptyString(raw.written_at, "written_at");
  if (Number.isNaN(Date.parse(writtenAt))) {
    throw new Error("written_at must be an ISO-8601 UTC timestamp");
  }
  if (!Array.isArray(raw.runtime_adapters)) {
    throw new Error("runtime_adapters must be an array");
  }
  const runtimeAdapters = raw.runtime_adapters.map((adapter, index) =>
    asNonEmptyString(adapter, `runtime_adapters[${index}]`),
  );
  return {
    schema_version: V2_HANDOFF_SCHEMA_VERSION,
    written_at: writtenAt,
    installed_v2_version: asNonEmptyString(raw.installed_v2_version, "installed_v2_version"),
    app_home_path: asNonEmptyString(raw.app_home_path, "app_home_path"),
    user_data_inventory: parseUserDataInventory(raw.user_data_inventory),
    runtime_adapters: runtimeAdapters,
  };
}

export function v2HandoffManifestPath(appHome: string): string {
  return path.join(resolvePath(appHome), V2_HANDOFF_MANIFEST_FILENAME);
}

export function readV2HandoffManifestFile(
  appHome: string,
): { manifest: V2HandoffManifest; elapsedMs: number } | null {
  const manifestPath = v2HandoffManifestPath(appHome);
  if (!isFile(manifestPath)) {
    return null;
  }
  const started = performance.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (exc) {
    throw new Error(`failed to read ${V2_HANDOFF_MANIFEST_FILENAME}: ${(exc as Error).message}`);
  }
  const manifest = parseV2HandoffManifest(parsed);
  const elapsedMs = performance.now() - started;
  return { manifest, elapsedMs };
}

function agenteraUserStateDirIsRecognized(dir: string): boolean {
  if (!pathExists(dir) || !fs.statSync(dir).isDirectory()) {
    return false;
  }
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = fs.statSync(full);
    if (AGENTERA_USER_STATE_NAMES.has(entry) && st.isFile()) {
      continue;
    }
    if ((entry === "optimize" || entry === "optimera") && st.isDirectory()) {
      // "optimera" is the v2 stable legacy objective dir name; keep it
      // recognized so v2->v3 migration preserves legacy objective state.
      continue;
    }
    return false;
  }
  return true;
}

function isPreservedUserStateEntry(appHome: string, entry: string): boolean {
  const full = path.join(appHome, entry);
  if (!pathExists(full)) {
    return false;
  }
  const st = fs.statSync(full);
  if (ROOT_USER_STATE_FILE_NAMES.has(entry) && st.isFile()) {
    return true;
  }
  if (ROOT_USER_STATE_DIR_NAMES.has(entry) && st.isDirectory()) {
    return true;
  }
  if (entry === ".agentera" && agenteraUserStateDirIsRecognized(full)) {
    return true;
  }
  if (
    (USER_DATA_CATALOG_DIRS as readonly string[]).includes(entry) &&
    st.isDirectory()
  ) {
    return true;
  }
  return false;
}

function listPreservedTopLevelFromScan(appHome: string): string[] {
  if (!pathExists(appHome)) {
    return [];
  }
  const preserved: string[] = [];
  for (const entry of fs.readdirSync(appHome)) {
    if (entry === "app" || entry === V2_HANDOFF_MANIFEST_FILENAME) {
      continue;
    }
    if (isPreservedUserStateEntry(appHome, entry)) {
      preserved.push(entry);
    }
  }
  return preserved.sort();
}

function listPreservedAbsolutePathsFromScan(appHome: string): string[] {
  const preserved: string[] = [];
  for (const entry of listPreservedTopLevelFromScan(appHome)) {
    const full = path.join(appHome, entry);
    preserved.push(full);
    if (entry === ".agentera" && pathExists(full) && fs.statSync(full).isDirectory()) {
      for (const name of AGENTERA_USER_STATE_NAMES) {
        const nested = path.join(full, name);
        if (isFile(nested)) {
          preserved.push(nested);
        }
      }
    }
  }
  return preserved.sort();
}

function listPreservedTopLevelFromManifest(manifest: V2HandoffManifest): string[] {
  const preserved = new Set<string>();
  for (const entry of manifest.user_data_inventory) {
    if (entry.kind === "directory" && entry.exists) {
      preserved.add(entry.relative_path);
    }
    if (entry.kind === "profile_files") {
      for (const member of entry.members) {
        if (member.exists) {
          preserved.add(member.relative_path);
        }
      }
    }
  }
  return [...preserved].sort();
}

function listPreservedAbsolutePathsFromManifest(
  manifest: V2HandoffManifest,
  appHome: string,
): string[] {
  const root = resolvePath(appHome);
  const preserved: string[] = [];
  for (const rel of listPreservedTopLevelFromManifest(manifest)) {
    preserved.push(path.join(root, rel));
  }
  const agenteraDir = path.join(root, ".agentera");
  if (pathExists(agenteraDir) && fs.statSync(agenteraDir).isDirectory()) {
    preserved.push(agenteraDir);
    for (const name of AGENTERA_USER_STATE_NAMES) {
      const nested = path.join(agenteraDir, name);
      if (isFile(nested)) {
        preserved.push(nested);
      }
    }
  }
  return preserved.sort();
}

export function isManifestCatalogEntryPreserved(
  manifest: V2HandoffManifest,
  entry: string,
): boolean {
  for (const item of manifest.user_data_inventory) {
    if (item.kind === "directory" && item.relative_path === entry) {
      return item.exists;
    }
    if (item.kind === "profile_files") {
      for (const member of item.members) {
        if (member.relative_path === entry) {
          return member.exists;
        }
      }
    }
  }
  if (entry === ".agentera") {
    const agenteraDir = path.join(resolvePath(manifest.app_home_path), ".agentera");
    return agenteraUserStateDirIsRecognized(agenteraDir);
  }
  return false;
}

function profileDirEnvVar(env: Record<string, string | undefined>): string | null {
  if (env[AGENTERA_PROFILE_DIR_ENV]) {
    return AGENTERA_PROFILE_DIR_ENV;
  }
  if (env[PROFILERA_PROFILE_DIR_ENV]) {
    return PROFILERA_PROFILE_DIR_ENV;
  }
  return null;
}

function opencodeConfigDirEnvVar(env: Record<string, string | undefined>): string | null {
  if (env.OPENCODE_CONFIG_DIR) {
    return "OPENCODE_CONFIG_DIR";
  }
  if (env.XDG_CONFIG_HOME) {
    return "XDG_CONFIG_HOME";
  }
  return null;
}

function listUserDataPathsAtRoot(root: string): string[] {
  const preserved = new Set<string>([root]);
  for (const dir of USER_DATA_CATALOG_DIRS) {
    const full = path.join(root, dir);
    if (pathExists(full) && fs.statSync(full).isDirectory()) {
      preserved.add(full);
    }
  }
  for (const file of PROFILE_FILE_MEMBERS) {
    const full = path.join(root, file);
    if (isFile(full)) {
      preserved.add(full);
    }
  }
  return [...preserved].sort();
}

function opencodeConfigDirHasArtifacts(configDir: string): boolean {
  if (isFile(path.join(configDir, "plugins", "agentera.js"))) {
    return true;
  }
  const agentsDir = path.join(configDir, "agents");
  if (pathExists(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
    if (fs.readdirSync(agentsDir).some((name) => isFile(path.join(agentsDir, name)))) {
      return true;
    }
  }
  return pathExists(path.join(configDir, "skills", "agentera"));
}

function listOpencodeConfigCatalog(configDir: string): string[] {
  const preserved = new Set<string>([configDir]);
  for (const rel of ["plugins/agentera.js", "agents", "commands", "skills"] as const) {
    const full = path.join(configDir, rel);
    if (pathExists(full)) {
      preserved.add(full);
    }
  }
  return [...preserved].sort();
}

export function buildExternalHandoffCatalog(
  appHome: string,
  opts?: MigrationUserStatePreflightOpts,
): HandoffCatalogEntry[] {
  if (!opts?.env) {
    return [];
  }
  const env = opts.env;
  const home = resolvePath(opts.home ?? appHome);
  const resolvedAppHome = resolvePath(appHome);
  const catalog: HandoffCatalogEntry[] = [];

  const profileEnvVar = profileDirEnvVar(env);
  const profileOverride = resolveProfileDirOverride(env);
  if (profileEnvVar && profileOverride) {
    const profileDir = resolvePath(expanduser(profileOverride));
    if (profileDir !== resolvedAppHome) {
      catalog.push({
        surface: "custom_profile_dir",
        root: profileDir,
        envVar: profileEnvVar,
        entries: listUserDataPathsAtRoot(profileDir),
      });
    }
  }

  const opencodeEnvVar = opencodeConfigDirEnvVar(env);
  if (opencodeEnvVar) {
    const configDir = opencodeConfigDir(home, env);
    const defaultDir = resolvePath(path.join(home, ".config", "opencode"));
    if (configDir !== defaultDir && opencodeConfigDirHasArtifacts(configDir)) {
      catalog.push({
        surface: "opencode_runtime_config_dir",
        root: configDir,
        envVar: opencodeEnvVar,
        entries: listOpencodeConfigCatalog(configDir),
      });
    }
  }

  return catalog;
}

function mergePreservedAbsolutePaths(
  base: string[],
  handoffCatalog: HandoffCatalogEntry[],
): string[] {
  const merged = new Set(base);
  for (const entry of handoffCatalog) {
    for (const absolutePath of entry.entries) {
      merged.add(absolutePath);
    }
  }
  return [...merged].sort();
}

export function handoffCatalogMessage(entry: HandoffCatalogEntry): string {
  if (entry.surface === "custom_profile_dir") {
    return `custom profile dir (${entry.envVar}=${entry.root}) cataloged for v2→v3 handoff`;
  }
  return `opencode runtime config dir (${entry.envVar} → ${entry.root}) cataloged for v2→v3 handoff`;
}

export function resolveMigrationUserStatePreflight(
  appHome: string,
  opts?: MigrationUserStatePreflightOpts,
): MigrationUserStatePreflight {
  const resolvedHome = resolvePath(appHome);
  const handoffCatalog = buildExternalHandoffCatalog(resolvedHome, opts);
  const manifestRead = readV2HandoffManifestFile(resolvedHome);
  if (manifestRead) {
    return {
      source: "manifest",
      elapsedMs: manifestRead.elapsedMs,
      manifest: manifestRead.manifest,
      preservedTopLevel: listPreservedTopLevelFromManifest(manifestRead.manifest),
      preservedAbsolutePaths: mergePreservedAbsolutePaths(
        listPreservedAbsolutePathsFromManifest(manifestRead.manifest, resolvedHome),
        handoffCatalog,
      ),
      handoffCatalog,
    };
  }
  const started = performance.now();
  const preservedTopLevel = listPreservedTopLevelFromScan(resolvedHome);
  const preservedAbsolutePaths = mergePreservedAbsolutePaths(
    listPreservedAbsolutePathsFromScan(resolvedHome),
    handoffCatalog,
  );
  return {
    source: "scan",
    elapsedMs: performance.now() - started,
    manifest: null,
    preservedTopLevel,
    preservedAbsolutePaths,
    handoffCatalog,
  };
}

export function appHomeHasUnrecognizedEntriesWithPreflight(
  appHome: string,
  preflight: MigrationUserStatePreflight,
): string[] {
  if (!pathExists(appHome)) {
    return [];
  }
  const unknown: string[] = [];
  for (const entry of fs.readdirSync(appHome)) {
    if (entry === "app" || entry === V2_HANDOFF_MANIFEST_FILENAME) {
      continue;
    }
    if (preflight.source === "manifest" && preflight.manifest) {
      if (isManifestCatalogEntryPreserved(preflight.manifest, entry)) {
        continue;
      }
    } else if (isPreservedUserStateEntry(appHome, entry)) {
      continue;
    }
    unknown.push(entry);
  }
  return unknown;
}

export interface ManifestFreshnessContext {
  appHome: string;
  installedVersion: string;
  bundleMarkerMtimeMs: number;
}

export function isV2HandoffManifestStale(
  manifest: V2HandoffManifest,
  ctx: ManifestFreshnessContext,
): boolean {
  if (resolvePath(manifest.app_home_path) !== resolvePath(ctx.appHome)) {
    return true;
  }
  if (manifest.installed_v2_version !== ctx.installedVersion) {
    return true;
  }
  const writtenAtMs = Date.parse(manifest.written_at);
  const markerMs = ctx.bundleMarkerMtimeMs;
  if (Number.isNaN(writtenAtMs) || Math.floor(writtenAtMs / 1000) < Math.floor(markerMs / 1000)) {
    return true;
  }
  return false;
}

export function bundleMarkerFreshnessContext(
  appHome: string,
  sourceRoot: string,
): ManifestFreshnessContext | null {
  const roots = doctorRoots(appHome);
  const markerPath = path.join(roots.activeBundleRoot, ".agentera-bundle.json");
  if (!isFile(markerPath)) {
    return null;
  }
  const installedVersion =
    loadSuiteVersion(roots.activeBundleRoot) ?? loadSuiteVersion(sourceRoot) ?? "unknown";
  return {
    appHome: resolvePath(appHome),
    installedVersion,
    bundleMarkerMtimeMs: fs.statSync(markerPath).mtimeMs,
  };
}

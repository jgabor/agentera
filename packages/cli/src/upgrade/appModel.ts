import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../core/paths.js";
import { resolveProfileDirOverride } from "../core/envPaths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { Classification, SOURCE_LABELS, classifyResolvedRoot, isForeignPlatformDefaultAppHome, resolveCandidate } from "../state/installRoot.js";
import { loadRegistry, type PackageRegistry } from "../registries/packageRegistry.js";
import { hasBundleRootEvidence } from "./bundleEvidence.js";
import type { JsonObject } from "../core/jsonValue.js";

/**
 * App-home / app-model resolution used by doctor and upgrade. Faithful TS port
 * of the resolution layer in scripts/agentera_upgrade.py.
 */

export const BOOTSTRAP_SOURCE_ROOT_ENV = "AGENTERA_BOOTSTRAP_SOURCE_ROOT";
export const DEFAULT_INSTALL_ROOT_ENV = "AGENTERA_DEFAULT_INSTALL_ROOT";
export const BUNDLE_MARKER = ".agentera-bundle.json";

type Env = Record<string, string | undefined>;

export interface DoctorRoots {
  appHome: string;
  managedAppRoot: string;
  activeBundleRoot: string;
  skillRoot: string;
  runtimeRoot: string;
}

export interface ActiveAppModel {
  appHome: string;
  appHomeSource: string;
  managedAppRoot: string;
  activeBundleRoot: string;
  authoritativeRoot: string;
  skillRoot: string;
  runtimeRoot: string;
}

function runtimeRoot(): string {
  return resolveSourceRoot();
}

const SETUP_EVIDENCE = ["skills", "skills/agentera/SKILL.md", "registry.json"] as const;

function sourceRootMissing(root: string): string[] {
  // Self-contained npx bundle: the published package ships app data without the
  // Python source surface (scripts/hooks). The sentinel + skills + registry are
  // sufficient evidence of a complete app root. (Sentinel never exists in a repo
  // checkout or installed app, so checkout/app-home behavior is unchanged.)
  if (pathExists(path.join(root, ".agentera-npx-bundle.json"))) {
    return ["skills/agentera/SKILL.md", "registry.json"].filter((entry) => !pathExists(path.join(root, entry)));
  }
  return SETUP_EVIDENCE.filter((entry) => !pathExists(path.join(root, entry)));
}

/** Stable reasons the suite version authority cannot yield a version. */
export type SuiteVersionFailureReason = "missing" | "unreadable" | "malformed" | "empty_skills" | "invalid_version" | "selector_mismatch" | "contract_unreadable";

export type SuiteVersionResult = { kind: "ok"; version: string; path: string } | { kind: "failure"; reason: SuiteVersionFailureReason; path: string | null; message: string };

export const SUPPORTED_SUITE_VERSION_SELECTOR = "skills[0].version";

/**
 * Corrupt authority is present but unusable. A missing authority file is a
 * valid layout without a v3 version signal, so callers keep their fallback.
 */
export function isCorruptSuiteVersion(result: SuiteVersionResult): result is Extract<SuiteVersionResult, { kind: "failure" }> {
  return result.kind === "failure" && result.reason !== "missing";
}

export function readSuiteVersion(sourceRoot: string, loadContract: () => Pick<PackageRegistry, "get"> = () => loadRegistry()): SuiteVersionResult {
  let authority: JsonObject;
  try {
    authority = loadContract().get("agentera").version_authority as JsonObject; // cast: parsed registry IO boundary
  } catch (exc) {
    return { kind: "failure", reason: "contract_unreadable", path: null, message: `package contract cannot be read: ${(exc as Error).message}` };
  }
  if (typeof authority.persisted_authority !== "string" || !authority.persisted_authority) {
    return { kind: "failure", reason: "contract_unreadable", path: null, message: "package contract has no persisted version authority path" };
  }
  const authorityPath = path.join(sourceRoot, authority.persisted_authority);
  if (authority.selector !== SUPPORTED_SUITE_VERSION_SELECTOR) {
    return { kind: "failure", reason: "selector_mismatch", path: authorityPath, message: `unsupported version selector ${JSON.stringify(authority.selector)}; expected ${SUPPORTED_SUITE_VERSION_SELECTOR}` };
  }
  if (!pathExists(authorityPath)) {
    return { kind: "failure", reason: "missing", path: authorityPath, message: `version authority is missing: ${authorityPath}` };
  }
  if (!isFile(authorityPath)) {
    return { kind: "failure", reason: "unreadable", path: authorityPath, message: `version authority is not a regular file: ${authorityPath}` };
  }
  let text: string;
  try {
    text = fs.readFileSync(authorityPath, "utf8");
  } catch (exc) {
    return { kind: "failure", reason: "unreadable", path: authorityPath, message: `version authority cannot be read: ${(exc as Error).message}` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: "failure", reason: "malformed", path: authorityPath, message: `version authority is not valid JSON: ${authorityPath}` };
  }
  const skills = data !== null && typeof data === "object" ? (data as { skills?: unknown }).skills : undefined;
  if (!Array.isArray(skills) || skills.length === 0) {
    return { kind: "failure", reason: "empty_skills", path: authorityPath, message: `version authority has no skills entries: ${authorityPath}` };
  }
  const first: unknown = skills[0];
  const version = first !== null && typeof first === "object" ? (first as { version?: unknown }).version : undefined;
  if (typeof version !== "string" || !version) {
    return { kind: "failure", reason: "invalid_version", path: authorityPath, message: `version authority ${SUPPORTED_SUITE_VERSION_SELECTOR} is not a non-empty string: ${authorityPath}` };
  }
  return { kind: "ok", version, path: authorityPath };
}

export function loadSuiteVersion(sourceRoot: string): string | null {
  const result = readSuiteVersion(sourceRoot);
  return result.kind === "ok" ? result.version : null;
}

export function doctorRoots(appHome: string): DoctorRoots {
  const managedAppRoot = path.join(appHome, "app");
  let activeBundleRoot: string;
  if (hasBundleRootEvidence(managedAppRoot)) {
    activeBundleRoot = managedAppRoot;
  } else if (pathExists(managedAppRoot)) {
    activeBundleRoot = managedAppRoot;
  } else if (hasBundleRootEvidence(appHome)) {
    activeBundleRoot = appHome;
  } else {
    activeBundleRoot = appHome;
  }
  return {
    appHome,
    managedAppRoot,
    activeBundleRoot,
    skillRoot: path.join(activeBundleRoot, "skills", "agentera"),
    runtimeRoot: runtimeRoot(),
  };
}

function activeBundleRoot(appHome: string): string {
  return doctorRoots(appHome).activeBundleRoot;
}

function legacyDefaultAppHome(home: string): string {
  return resolvePath(path.join(expanduser(home), ".agents", "agentera"));
}

function platformDefaultAppHome(home: string, env: Env): string {
  const defaultEnv: Env = { ...env };
  delete defaultEnv.AGENTERA_HOME;
  delete defaultEnv[DEFAULT_INSTALL_ROOT_ENV];
  const [root] = resolveCandidate(null, { env: defaultEnv, home });
  return resolvePath(root);
}

function classifyRoot(root: string, source = "explicit", expectedVersion: string | null = null): Classification {
  return classifyResolvedRoot(root, { source, expectedVersion });
}

function shouldRecoverStaleDefaultEnv(candidate: string, sourceRoot: string, home: string): boolean {
  if (candidate !== legacyDefaultAppHome(home)) {
    return false;
  }
  const activeRoot = activeBundleRoot(candidate);
  const expected = loadSuiteVersion(sourceRoot);
  const classification = classifyRoot(activeRoot, "environment", expected);
  if (["missing_explicit_or_environment", "unmanaged_directory", "invalid_bundle"].includes(classification.kind)) {
    return true;
  }
  return classification.kind === "managed_stale";
}

function shouldRecoverForeignPlatformDefaultAppHome(candidate: string, home: string, env: Env): boolean {
  return isForeignPlatformDefaultAppHome(candidate, { env, home });
}

export function resolveSourceRootStrict(env: Env = process.env): string {
  const configured = env[BOOTSTRAP_SOURCE_ROOT_ENV];
  const root = resolvePath(configured ? expanduser(configured) : runtimeRoot());
  const missing = sourceRootMissing(root);
  if (missing.length > 0) {
    throw new Error(`bootstrap source root ${root} is missing: ${missing.join(", ")}`);
  }
  return root;
}

export function resolveInstallRoot(value: string | null, sourceRoot: string, home: string, env: Env = process.env): string {
  const platformDefault = platformDefaultAppHome(home, env);
  if (value !== null && value !== undefined) {
    return resolvePath(value);
  }
  const configured = env.AGENTERA_HOME;
  if (configured) {
    const candidate = resolvePath(configured);
    if (shouldRecoverStaleDefaultEnv(candidate, sourceRoot, home)) {
      return platformDefault;
    }
    if (shouldRecoverForeignPlatformDefaultAppHome(candidate, home, env)) {
      return platformDefault;
    }
    return candidate;
  }
  const profileDir = resolveProfileDirOverride(env);
  if (profileDir) {
    return resolvePath(profileDir);
  }
  const def = env[DEFAULT_INSTALL_ROOT_ENV];
  if (def) {
    const candidate = resolvePath(def);
    if (shouldRecoverStaleDefaultEnv(candidate, sourceRoot, home)) {
      return platformDefault;
    }
    if (shouldRecoverForeignPlatformDefaultAppHome(candidate, home, env)) {
      return platformDefault;
    }
    return candidate;
  }
  return platformDefault;
}

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function resolvePlatformAppHome(home: string, env: Env = process.env): string {
  return platformDefaultAppHome(home, env);
}

export function resolveDoctorInstallRoot(value: string | null, opts: { home: string; env?: Env; sourceRoot?: string | null }): [string, string] {
  const env = opts.env ?? process.env;
  const home = opts.home;
  if (opts.sourceRoot !== undefined && opts.sourceRoot !== null) {
    const root = resolveInstallRoot(value, opts.sourceRoot, home, env);
    const [rawRoot, rawSource] = resolveCandidate(value, { env, home });
    if (root !== rawRoot) {
      return [root, SOURCE_LABELS.default];
    }
    return [root, sourceLabel(rawSource)];
  }
  const [root, source] = resolveCandidate(value, { env, home });
  return [root, sourceLabel(source)];
}

export function resolveActiveAppModel(value: string | null = null, opts: { home?: string; env?: Env } = {}): ActiveAppModel {
  const resolvedHome = opts.home ?? os.homedir();
  const [appHome, appHomeSource] = resolveDoctorInstallRoot(value, {
    home: resolvedHome,
    env: opts.env,
    sourceRoot: runtimeRoot(),
  });
  const roots = doctorRoots(appHome);
  return {
    appHome: roots.appHome,
    appHomeSource,
    managedAppRoot: roots.managedAppRoot,
    activeBundleRoot: roots.activeBundleRoot,
    authoritativeRoot: roots.managedAppRoot,
    skillRoot: roots.skillRoot,
    runtimeRoot: roots.runtimeRoot,
  };
}

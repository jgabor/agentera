import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  Classification,
  SOURCE_LABELS,
  classifyResolvedRoot,
  defaultAppHome,
  isForeignPlatformDefaultAppHome,
  resolveCandidate,
} from "../state/installRoot.js";
import { loadRegistry } from "../registries/packageRegistry.js";

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

const SETUP_EVIDENCE = [
  "scripts/validate_capability.py",
  "hooks",
  "skills",
  "skills/agentera/SKILL.md",
] as const;

function sourceRootMissing(root: string): string[] {
  // Self-contained npx bundle: the published package ships app data without the
  // Python source surface (scripts/hooks). The sentinel + skills + registry are
  // sufficient evidence of a complete app root. (Sentinel never exists in a repo
  // checkout or installed app, so checkout/app-home behavior is unchanged.)
  if (pathExists(path.join(root, ".agentera-npx-bundle.json"))) {
    return ["skills/agentera/SKILL.md", "registry.json"].filter(
      (entry) => !pathExists(path.join(root, entry)),
    );
  }
  return SETUP_EVIDENCE.filter((entry) => !pathExists(path.join(root, entry)));
}

export function loadSuiteVersion(sourceRoot: string): string | null {
  const record = loadRegistry().get("agentera");
  const authority = record.version_authority;
  const authorityPath = path.join(sourceRoot, authority.persisted_authority);
  if (!isFile(authorityPath)) {
    return null;
  }
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
  } catch {
    return null;
  }
  if (authority.selector !== "skills[0].version") {
    return null;
  }
  const skills = data?.skills;
  if (!Array.isArray(skills) || skills.length === 0) {
    return null;
  }
  const first = skills[0];
  const version = first && typeof first === "object" ? first.version : null;
  return typeof version === "string" && version ? version : null;
}

function hasBundleRootEvidence(root: string): boolean {
  return (
    isFile(path.join(root, "scripts", "agentera")) &&
    isFile(path.join(root, "skills", "agentera", "SKILL.md"))
  );
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

function classifyRoot(
  root: string,
  source = "explicit",
  expectedVersion: string | null = null,
): Classification {
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

export function resolveInstallRoot(
  value: string | null,
  sourceRoot: string,
  home: string,
  env: Env = process.env,
): string {
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

export function resolveDoctorInstallRoot(
  value: string | null,
  opts: { home: string; env?: Env; sourceRoot?: string | null },
): [string, string] {
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

export function resolveActiveAppModel(
  value: string | null = null,
  opts: { home?: string; env?: Env } = {},
): ActiveAppModel {
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

import fs from "node:fs";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../core/paths.js";
import { SOURCE_LABELS, classifyResolvedRoot } from "../state/installRoot.js";
import { doctorRoots, loadSuiteVersion } from "./appModel.js";
import { isNpxBundleRoot } from "../core/sourceRoot.js";
import { resolveUpdateChannel } from "./channels.js";
import { classifyInstall, crossMajorBoundaryApplies } from "./compatibility.js";
import { isStableSuccessorAnnounced } from "./nextMajorDoctor.js";
import { buildUpgradeCommands, commandText } from "./upgradeCommands.js";
import { parseSemverMajor } from "./versionResolution.js";
import type { BundleStatus, DoctorSignal, PublicBundleStatus } from "../cli/contracts/bundleStatus.js";
import { type ProbeResult, type ProbeRunner } from "./cliProbe.js";
import { classifyInstallRootStatus } from "./doctorClassifier.js";

export type { ProbeResult, ProbeRunner } from "./cliProbe.js";

export type { BundleStatus, DoctorSignal, PublicBundleStatus } from "../cli/contracts/bundleStatus.js";

/**
 * Doctor status build. Faithful TS port of build_doctor_status /
 * public_doctor_status from scripts/agentera_upgrade.py.
 *
 * The classification -> root_status/signals/status logic matches Python exactly.
 * The emitted command strings use the TS-CLI invocation form (npx/node) rather
 * than the Python uvx/uv form; the final wording is settled in Phase 8 packaging.
 */

export const APP_UP_TO_DATE = "up_to_date";
export const APP_OUTDATED = "outdated";
export const APP_REPAIR_NEEDED = "repair_needed";
export const APP_MIGRATION_NEEDED = "migration_needed";
export const APP_MANUAL_REVIEW_NEEDED = "manual_review_needed";
export const EXPECTED_STATE_COMMANDS = ["prime"] as const;

/** Operation noun for doctor/prime copy derived from aggregate lifecycle status. */
export function appLifecycleActionNoun(status: string): string {
  if (status === APP_OUTDATED) {
    return "update";
  }
  if (status === APP_MIGRATION_NEEDED) {
    return "migration";
  }
  return "repair";
}

export function appLifecycleApprovalPhrase(status: string, installRoot: string): string {
  if (status === APP_UP_TO_DATE) {
    return "no action needed: Agentera app files are up to date";
  }
  return `approve app files ${appLifecycleActionNoun(status)} for ${installRoot}`;
}
export const BUNDLE_MARKER = ".agentera-bundle.json";

/** Agentera user state preserved during v2→v3 managed app-home cleanup. */
export const AGENTERA_USER_STATE_NAMES = new Set([
  "progress.yaml",
  "decisions.yaml",
  "health.yaml",
  "plan.yaml",
  "docs.yaml",
]);
export const ROOT_USER_STATE_FILE_NAMES = new Set([
  "PROFILE.md",
  "USAGE.md",
  "corpus.json",
  "TODO.md",
  "CHANGELOG.md",
  "DESIGN.md",
]);
export const ROOT_USER_STATE_DIR_NAMES = new Set([
  "history",
  "corpus",
  "benchmarks",
  "intermediate",
  "sessions",
]);

function hasBundleRootEvidence(root: string): boolean {
  return (
    isFile(path.join(root, "scripts", "agentera")) &&
    isFile(path.join(root, "skills", "agentera", "SKILL.md"))
  );
}

function legacyDefaultAppHome(home: string): string {
  return resolvePath(path.join(expanduser(home), ".agents", "agentera"));
}

function isRecoverableStaleDefaultAppHome(appHome: string, rootSource: string, home: string): boolean {
  return rootSource === "AGENTERA_HOME" && appHome === legacyDefaultAppHome(home);
}

function legacyAppHomeHasBundle(appHome: string): boolean {
  return hasBundleRootEvidence(appHome) && !pathExists(path.join(appHome, ".git"));
}

function agenteraUserStateDirIsRecognized(p: string): boolean {
  if (!pathExists(p) || !fs.statSync(p).isDirectory()) {
    return false;
  }
  for (const entry of fs.readdirSync(p)) {
    const full = path.join(p, entry);
    const st = fs.statSync(full);
    if (AGENTERA_USER_STATE_NAMES.has(entry) && st.isFile()) {
      continue;
    }
    if (entry === "optimera" && st.isDirectory()) {
      continue;
    }
    return false;
  }
  return true;
}

function appHomeIsUserDataOnly(appHome: string): boolean {
  if (!pathExists(appHome)) {
    return true;
  }
  if (!fs.statSync(appHome).isDirectory()) {
    return false;
  }
  let hasUserState = false;
  for (const entry of fs.readdirSync(appHome)) {
    const full = path.join(appHome, entry);
    const st = fs.statSync(full);
    if (ROOT_USER_STATE_FILE_NAMES.has(entry) && st.isFile()) {
      hasUserState = true;
      continue;
    }
    if (ROOT_USER_STATE_DIR_NAMES.has(entry) && st.isDirectory()) {
      hasUserState = true;
      continue;
    }
    if (entry === ".agentera" && agenteraUserStateDirIsRecognized(full)) {
      hasUserState = true;
      continue;
    }
    return false;
  }
  return hasUserState;
}

function sourceKey(rootSource: string): string {
  for (const [key, label] of Object.entries(SOURCE_LABELS)) {
    if (rootSource === label) {
      return key;
    }
  }
  if (rootSource === "AGENTERA_HOME") {
    return "environment";
  }
  return "explicit";
}

export interface BuildDoctorStatusOptions {
  rootSource: string;
  sourceRoot: string;
  home: string;
  project: string;
  expectedVersion?: string | null;
  expectedCommands?: readonly string[];
  probeCli?: boolean;
  probeRunner?: ProbeRunner;
  /** Override update channel (tests); default stable via resolveUpdateChannel. */
  channel?: string | null;
  env?: Record<string, string | undefined>;
  /** Evaluate installRoot even when sourceRoot is a self-contained npx bundle. */
  skipNpxBundleShortCircuit?: boolean;
}

export function buildDoctorStatus(installRoot: string, opts: BuildDoctorStatusOptions): BundleStatus {
  const rootSource = opts.rootSource;
  const sourceRoot = opts.sourceRoot;
  const home = opts.home;
  const project = opts.project;
  const expectedCommands = opts.expectedCommands ?? EXPECTED_STATE_COMMANDS;
  const probeCli = opts.probeCli ?? true;

  // Fully self-contained npx bundle: the bundle IS the app and is always current
  // (its version is the package version), so there is no install/upgrade step.
  // Report it as the authoritative, up-to-date app home. (Sentinel-gated; never
  // triggers for a repo checkout or an installed managed app.)
  if (isNpxBundleRoot(sourceRoot) && !opts.skipNpxBundleShortCircuit) {
    const bundleExpected = opts.expectedVersion || loadSuiteVersion(sourceRoot) || "unknown";
    return {
      schemaVersion: "agentera.bundleStatus.v1",
      status: APP_UP_TO_DATE,
      expectedVersion: bundleExpected,
      appHome: sourceRoot,
      appHomeSource: "bundled app",
      managedAppRoot: sourceRoot,
      userDataRoot: sourceRoot,
      activeBundleRoot: sourceRoot,
      authoritativeRoot: sourceRoot,
      skillRoot: path.join(sourceRoot, "skills", "agentera"),
      runtimeRoot: sourceRoot,
      sourceRoot,
      installRoot: sourceRoot,
      installRootSource: "bundled app",
      home,
      project,
      rootStatus: "bundled",
      markerVersion: bundleExpected,
      signals: [],
      dryRunCommand: null,
      applyCommand: null,
      retryCommand: commandText(["npx", "-y", "agentera", expectedCommands[0] ?? "prime"]),
      approval: "no action needed: self-contained app bundle is current",
    };
  }

  const expected = opts.expectedVersion || loadSuiteVersion(sourceRoot) || "unknown";
  const roots = doctorRoots(installRoot);
  const activeBundleRoot = roots.activeBundleRoot;
  const classification = classifyResolvedRoot(activeBundleRoot, {
    source: sourceKey(rootSource),
    expectedVersion: expected,
  });
  const markerVersion = classification.current_version;
  const recoverableStaleDefault = isRecoverableStaleDefaultAppHome(installRoot, rootSource, home);
  const legacyBundleRoot =
    activeBundleRoot === installRoot &&
    hasBundleRootEvidence(installRoot) &&
    !pathExists(path.join(installRoot, ".git"));
  const userDataOnly =
    classification.kind === "unmanaged_directory" && appHomeIsUserDataOnly(installRoot);

  const classified = classifyInstallRootStatus({
    installRoot,
    rootSource,
    roots,
    classification,
    expected,
    markerVersion,
    recoverableStaleDefault,
    legacyBundleRoot,
    userDataOnly,
    probeCli,
    probeRunner: opts.probeRunner,
    project,
    expectedCommands,
  });
  const rootStatus = classified.rootStatus;
  const signals = classified.signals;
  const blocked = classified.blocked;

  const env = { ...(opts.env ?? process.env), HOME: home };
  const channel = resolveUpdateChannel({
    channel: opts.channel ?? null,
    env,
    home,
    sourceRoot,
  });
  const install = classifyInstall({ appHome: installRoot, sourceRoot });
  const crossMajorDetected = crossMajorBoundaryApplies(install, sourceRoot);
  const successorAnnounced = isStableSuccessorAnnounced(sourceRoot, channel.channel);
  const crossMajorBoundary = crossMajorDetected && successorAnnounced;
  if (crossMajorDetected && !successorAnnounced) {
    for (let i = signals.length - 1; i >= 0; i--) {
      const signal = signals[i];
      if (signal.kind !== "version_mismatch") {
        continue;
      }
      const actualMajor = parseSemverMajor(String(signal.actual ?? markerVersion ?? "")) ?? 0;
      const expectedMajor = parseSemverMajor(String(signal.expected ?? expected)) ?? 0;
      if (actualMajor > 0 && actualMajor < 3 && expectedMajor >= 3) {
        signals.splice(i, 1);
      }
    }
  }
  const upgradeCommands = buildUpgradeCommands({
    project,
    installRoot,
    channel,
    cwdDefault: true,
  });

  const status = blocked
    ? APP_MANUAL_REVIEW_NEEDED
    : signals.some((s) => s.kind === APP_MIGRATION_NEEDED)
      ? APP_MIGRATION_NEEDED
      : signals.some((s) => s.status === APP_REPAIR_NEEDED)
        ? APP_REPAIR_NEEDED
        : signals.some((s) => s.status === APP_OUTDATED)
          ? APP_OUTDATED
          : APP_UP_TO_DATE;

  return {
    schemaVersion: "agentera.bundleStatus.v1",
    status,
    expectedVersion: expected,
    appHome: installRoot,
    appHomeSource: rootSource,
    managedAppRoot: roots.managedAppRoot,
    userDataRoot: installRoot,
    activeBundleRoot,
    authoritativeRoot: roots.managedAppRoot,
    skillRoot: roots.skillRoot,
    runtimeRoot: roots.runtimeRoot,
    sourceRoot,
    installRoot,
    installRootSource: rootSource,
    home,
    project,
    rootStatus,
    markerVersion,
    signals,
    dryRunCommand:
      blocked || status === APP_UP_TO_DATE ? null : upgradeCommands.dryRunCommand,
    applyCommand:
      blocked || status === APP_UP_TO_DATE ? null : upgradeCommands.applyCommand,
    updateChannel: channel.channel,
    crossMajorBoundary,
    retryCommand: commandText([
      "node",
      path.join(activeBundleRoot, "scripts", "agentera"),
      expectedCommands[0] ?? "prime",
    ]),
    approval: appLifecycleApprovalPhrase(status, installRoot),
  };
}

export function publicDoctorStatus(status: BundleStatus): PublicBundleStatus {
  const { installRoot: _installRoot, installRootSource: _installRootSource, ...pub } = status;
  return pub;
}

/** Oracle-pinned keys for `agentera doctor --format json` (parity-remaining-families.json). */
export const DOCTOR_PARITY_JSON_KEYS = [
  "status",
  "expectedVersion",
  "appHome",
  "managedAppRoot",
  "userDataRoot",
  "signals",
  "dryRunCommand",
  "applyCommand",
  "retryCommand",
] as const;

/** Public doctor JSON envelope: command label plus oracle structural keys only. */
export function doctorParityJsonEnvelope(status: BundleStatus): Record<string, unknown> {
  const pub = publicDoctorStatus(status);
  const out: Record<string, unknown> = { command: "doctor" };
  for (const key of DOCTOR_PARITY_JSON_KEYS) {
    if (key in pub) out[key] = pub[key];
  }
  return out;
}

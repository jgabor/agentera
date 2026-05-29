import fs from "node:fs";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../core/paths.js";
import { SOURCE_LABELS, classifyResolvedRoot } from "../state/installRoot.js";
import { doctorRoots, loadSuiteVersion } from "./appModel.js";

/**
 * Doctor status build. Faithful TS port of build_doctor_status /
 * public_doctor_status from scripts/agentera_upgrade.py.
 *
 * The classification -> root_status/signals/status logic matches Python exactly.
 * The emitted command strings use the TS-CLI invocation form (npx/node) rather
 * than the Python uvx/uv form; the final wording is settled in Phase 8 packaging.
 */

type Dict = Record<string, any>;

export const APP_UP_TO_DATE = "up_to_date";
export const APP_OUTDATED = "outdated";
export const APP_REPAIR_NEEDED = "repair_needed";
export const APP_MIGRATION_NEEDED = "migration_needed";
export const APP_MANUAL_REVIEW_NEEDED = "manual_review_needed";
export const EXPECTED_STATE_COMMANDS = ["prime"] as const;
export const BUNDLE_MARKER = ".agentera-bundle.json";

const AGENTERA_USER_STATE_NAMES = new Set([
  "progress.yaml",
  "decisions.yaml",
  "health.yaml",
  "plan.yaml",
  "docs.yaml",
]);
const ROOT_USER_STATE_FILE_NAMES = new Set([
  "PROFILE.md",
  "USAGE.md",
  "corpus.json",
  "TODO.md",
  "CHANGELOG.md",
  "DESIGN.md",
]);
const ROOT_USER_STATE_DIR_NAMES = new Set(["history", "corpus"]);

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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function commandText(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
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

function recoverableStaleDefaultSignal(appHome: string, roots: Dict): Dict {
  return {
    status: APP_REPAIR_NEEDED,
    kind: "recoverable_stale_default",
    message:
      "Agentera found an old app directory and can repair it without asking you to edit shell settings",
    deprecatedDefaultAppHome: appHome,
    managedAppRoot: roots.managedAppRoot,
  };
}

function userDataOnlySignal(appHome: string, roots: Dict): Dict {
  return {
    status: APP_REPAIR_NEEDED,
    kind: "user_data_only_app_home",
    message:
      "This Agentera directory only has your Agentera data, so Agentera can safely add fresh app files under app/",
    appHome,
    managedAppRoot: roots.managedAppRoot,
  };
}

function blockedRootRecoveryMessage(_rootSource: string): string {
  return "choose a different Agentera directory, or use --force only if you checked this directory and want Agentera to replace files there";
}

export interface ProbeResult {
  ok: boolean;
  command?: string[] | null;
  returnCode?: number | null;
  stdoutTail?: string[];
  stderrTail?: string[];
  missingCommands?: string[];
  message?: string;
}

export type ProbeRunner = (args: {
  bundleRoot: string;
  appHome: string;
  project: string;
  expectedCommands: readonly string[];
}) => ProbeResult;

export interface BuildDoctorStatusOptions {
  rootSource: string;
  sourceRoot: string;
  home: string;
  project: string;
  expectedVersion?: string | null;
  expectedCommands?: readonly string[];
  probeCli?: boolean;
  probeRunner?: ProbeRunner;
}

export function buildDoctorStatus(installRoot: string, opts: BuildDoctorStatusOptions): Dict {
  const rootSource = opts.rootSource;
  const sourceRoot = opts.sourceRoot;
  const home = opts.home;
  const project = opts.project;
  const expectedCommands = opts.expectedCommands ?? EXPECTED_STATE_COMMANDS;
  const probeCli = opts.probeCli ?? true;

  const expected = opts.expectedVersion || loadSuiteVersion(sourceRoot) || "unknown";
  const roots = doctorRoots(installRoot);
  const activeBundleRoot = roots.activeBundleRoot;
  const classification = classifyResolvedRoot(activeBundleRoot, {
    source: sourceKey(rootSource),
    expectedVersion: expected,
  });
  const markerVersion = classification.current_version;
  const signals: Dict[] = [];
  let blocked = false;
  const recoverableStaleDefault = isRecoverableStaleDefaultAppHome(installRoot, rootSource, home);
  const legacyBundleRoot =
    activeBundleRoot === installRoot &&
    hasBundleRootEvidence(installRoot) &&
    !pathExists(path.join(installRoot, ".git"));

  let rootStatus: string;

  if (classification.kind === "missing_default") {
    rootStatus = "missing";
    signals.push({
      status: APP_REPAIR_NEEDED,
      kind: "missing_bundle",
      message: "Agentera is not installed in the normal directory yet",
    });
  } else if (classification.kind === "missing_explicit_or_environment" && recoverableStaleDefault) {
    rootStatus = "missing";
    signals.push(recoverableStaleDefaultSignal(installRoot, roots));
  } else if (classification.kind === "missing_explicit_or_environment") {
    rootStatus = "missing";
    blocked = true;
    signals.push({
      status: APP_MANUAL_REVIEW_NEEDED,
      kind: "invalid_install_root",
      message:
        "Agentera was told to use a directory that does not exist. " +
        "Choose an existing Agentera directory, or install into the normal Agentera directory.",
    });
  } else if (classification.kind === "file_valued_root") {
    rootStatus = "invalid";
    blocked = true;
    signals.push({
      status: APP_MANUAL_REVIEW_NEEDED,
      kind: "invalid_install_root",
      message: `Agentera was told to use a file instead of a directory; ${blockedRootRecoveryMessage(rootSource)}`,
    });
  } else if (
    (classification.kind === "invalid_bundle" || classification.kind === "unmanaged_directory") &&
    recoverableStaleDefault
  ) {
    rootStatus = "stale_default";
    signals.push(recoverableStaleDefaultSignal(installRoot, roots));
  } else if (classification.kind === "unmanaged_directory" && appHomeIsUserDataOnly(installRoot)) {
    rootStatus = "user_data_only";
    signals.push(userDataOnlySignal(installRoot, roots));
  } else if (classification.kind === "unmanaged_directory") {
    rootStatus = "unmanaged";
    blocked = true;
    signals.push({
      status: APP_MANUAL_REVIEW_NEEDED,
      kind: "unmanaged_install_root",
      message: `This directory already has files Agentera does not recognize, so Agentera will not change it automatically; ${blockedRootRecoveryMessage(rootSource)}`,
    });
  } else if (classification.kind === "invalid_bundle") {
    rootStatus = "invalid";
    blocked = true;
    signals.push({
      status: APP_MANUAL_REVIEW_NEEDED,
      kind: "invalid_bundle",
      message: `This directory looks like a broken Agentera install; ${blockedRootRecoveryMessage(rootSource)}`,
    });
  } else {
    rootStatus = "managed";
    if (legacyBundleRoot) {
      signals.push({
        status: APP_MIGRATION_NEEDED,
        kind: APP_MIGRATION_NEEDED,
        message: "Agentera app files are in the old place and can be moved into app/",
        legacyBundleRoot: installRoot,
        managedAppRoot: roots.managedAppRoot,
      });
    }
    const reason = classification.diagnostic.evidence.reason;
    if (classification.kind === "managed_stale" && reason === "missing_marker") {
      if (recoverableStaleDefault) {
        signals.push(recoverableStaleDefaultSignal(installRoot, roots));
      }
      signals.push({
        status: APP_REPAIR_NEEDED,
        kind: "missing_marker",
        message: "Agentera cannot prove these app files are current, so it should repair them",
      });
    } else if (classification.kind === "managed_stale" && reason === "version_mismatch") {
      if (recoverableStaleDefault) {
        signals.push(recoverableStaleDefaultSignal(installRoot, roots));
      }
      signals.push({
        status: APP_OUTDATED,
        kind: "version_mismatch",
        expected,
        actual: markerVersion,
        message: "Agentera app files are valid but need an update to the expected version",
      });
    }
    const probe: ProbeResult = probeCli
      ? (opts.probeRunner ?? defaultProbe)({
          bundleRoot: activeBundleRoot,
          appHome: installRoot,
          project,
          expectedCommands,
        })
      : { ok: true };
    if (!probe.ok) {
      let kind = "cli_probe_unavailable";
      if (probe.returnCode !== null && probe.returnCode !== undefined && probe.returnCode !== 0) {
        kind = "cli_probe_failed";
      } else if (probe.missingCommands && probe.missingCommands.length > 0) {
        kind = "missing_command";
      }
      signals.push({
        status: APP_REPAIR_NEEDED,
        kind,
        message: probe.message,
        returnCode: probe.returnCode ?? null,
        missingCommands: probe.missingCommands ?? [],
        stdoutTail: probe.stdoutTail ?? [],
        stderrTail: probe.stderrTail ?? [],
      });
    }
  }

  // TS-CLI invocation form (Phase 8 packaging settles final wording).
  const previewParts = ["npx", "-y", "agentera", "upgrade", "--install-root", installRoot, "--dry-run"];
  const applyParts = ["npx", "-y", "agentera", "upgrade", "--install-root", installRoot, "--yes"];

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
    dryRunCommand: blocked || status === APP_UP_TO_DATE ? null : commandText(previewParts),
    applyCommand: blocked || status === APP_UP_TO_DATE ? null : commandText(applyParts),
    retryCommand: commandText([
      "node",
      path.join(activeBundleRoot, "scripts", "agentera"),
      expectedCommands[0] ?? "prime",
    ]),
    approval: `approve app files repair for ${installRoot}`,
  };
}

/** Default CLI probe placeholder (wired to the bundled TS CLI in Phase 8). */
const defaultProbe: ProbeRunner = ({ expectedCommands }) => ({
  ok: false,
  command: null,
  returnCode: null,
  stdoutTail: [],
  stderrTail: [],
  missingCommands: [...expectedCommands],
  message: "CLI probe not yet wired to the bundled TS CLI",
});

export function publicDoctorStatus(status: Dict): Dict {
  const pub = JSON.parse(JSON.stringify(status));
  delete pub.installRoot;
  delete pub.installRootSource;
  return pub;
}

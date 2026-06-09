import fs from "node:fs";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../core/paths.js";

/**
 * Read-only Agentera install-root classification. Faithful TypeScript port of
 * `scripts/install_root.py`. Owns install-root identity and diagnostics without
 * mutating durable bundle state.
 */

export const BUNDLE_MARKER = ".agentera-bundle.json";

export const SETUP_EVIDENCE = [
  "skills",
  "skills/agentera/SKILL.md",
  "registry.json",
] as const;

export const BUNDLE_EVIDENCE = [
  "skills/agentera/SKILL.md",
  "registry.json",
  BUNDLE_MARKER,
] as const;

// Python: tuple(dict.fromkeys((*SETUP_EVIDENCE, *BUNDLE_EVIDENCE))) — order-preserving dedupe.
export const MANAGED_EVIDENCE: readonly string[] = ((): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...SETUP_EVIDENCE, ...BUNDLE_EVIDENCE]) {
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
})();

export const SOURCE_LABELS: Record<string, string> = {
  explicit: "explicit --install-root",
  environment: "AGENTERA_HOME",
  default: "default app home",
};

export interface Diagnostic {
  code: string;
  severity: string;
  message: string;
  evidence: Record<string, unknown>;
}

export interface Classification {
  source: string;
  source_label: string;
  path: string;
  kind: string;
  safe_action: string;
  diagnostic: Diagnostic;
  managed_status: string;
  stale_status: string;
  missing_evidence: string[];
  expected_version: string | null;
  current_version: string | null;
}

/** Mirror of `Classification.to_dict()` (asdict): plain object, already shaped. */
export function toDict(c: Classification): Record<string, unknown> {
  return {
    source: c.source,
    source_label: c.source_label,
    path: c.path,
    kind: c.kind,
    safe_action: c.safe_action,
    diagnostic: {
      code: c.diagnostic.code,
      severity: c.diagnostic.severity,
      message: c.diagnostic.message,
      evidence: c.diagnostic.evidence,
    },
    managed_status: c.managed_status,
    stale_status: c.stale_status,
    missing_evidence: c.missing_evidence,
    expected_version: c.expected_version,
    current_version: c.current_version,
  };
}

export interface PlatformEnv {
  /** node-style platform string; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function resolveCandidate(
  explicitRoot: string | null,
  opts: { env: Record<string, string | undefined>; home: string } & PlatformEnv,
): [string, string] {
  const { env, home } = opts;
  if (explicitRoot !== null && explicitRoot !== undefined) {
    return [resolvePath(explicitRoot), "explicit"];
  }
  const configured = env.AGENTERA_HOME;
  if (configured) {
    return [resolvePath(configured), "environment"];
  }
  const def = env.AGENTERA_DEFAULT_INSTALL_ROOT;
  if (def) {
    return [resolvePath(def), "default"];
  }
  return [resolvePath(defaultAppHome(env, home, opts.platform)), "default"];
}

export function defaultAppHome(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") {
    return macosDefaultAppHome(home);
  }
  if (platform === "win32") {
    return windowsDefaultAppHome(env, home);
  }
  return linuxDefaultAppHome(env, home);
}

function linuxDefaultAppHome(env: Record<string, string | undefined>, home: string): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg ? expanduser(xdg) : path.join(expanduser(home), ".local", "share");
  return path.join(base, "agentera");
}

function macosDefaultAppHome(home: string): string {
  return path.join(expanduser(home), "Library", "Application Support", "agentera");
}

function windowsDefaultAppHome(env: Record<string, string | undefined>, home: string): string {
  const appdata = env.APPDATA;
  const base = appdata
    ? expanduser(appdata)
    : path.join(expanduser(home), "AppData", "Roaming");
  return path.join(base, "agentera");
}

export function knownPlatformDefaultAppHomes(
  env: Record<string, string | undefined>,
  home: string,
): Set<string> {
  return new Set<string>([
    resolvePath(linuxDefaultAppHome(env, home)),
    resolvePath(macosDefaultAppHome(home)),
    resolvePath(windowsDefaultAppHome(env, home)),
  ]);
}

export function isForeignPlatformDefaultAppHome(
  candidate: string,
  opts: { env: Record<string, string | undefined>; home: string } & PlatformEnv,
): boolean {
  const resolved = resolvePath(candidate);
  const platformDefault = resolvePath(defaultAppHome(opts.env, opts.home, opts.platform));
  if (resolved === platformDefault) {
    return false;
  }
  return knownPlatformDefaultAppHomes(opts.env, opts.home).has(resolved);
}

function classification(
  root: string,
  source: string,
  kind: string,
  safeAction: string,
  managedStatus: string,
  staleStatus: string,
  missingEvidence: string[],
  diagnostic: Diagnostic,
  opts: { expectedVersion?: string | null; currentVersion?: string | null } = {},
): Classification {
  return {
    source,
    source_label: sourceLabel(source),
    path: root,
    kind,
    safe_action: safeAction,
    diagnostic,
    managed_status: managedStatus,
    stale_status: staleStatus,
    missing_evidence: missingEvidence,
    expected_version: opts.expectedVersion ?? null,
    current_version: opts.currentVersion ?? null,
  };
}

function managedFresh(
  root: string,
  source: string,
  setupMissing: string[],
  bundleMissing: string[],
  expected: string | null,
  current: string | null,
): Classification {
  return classification(
    root,
    source,
    "managed_fresh",
    "use_root",
    "managed",
    "fresh",
    [],
    {
      code: "install_root.managed_fresh",
      severity: "info",
      message: "Agentera app files are ready",
      evidence: {
        path: root,
        source: sourceLabel(source),
        expectedVersion: expected,
        currentVersion: current,
        missingSetupEvidence: setupMissing,
        missingBundleEvidence: bundleMissing,
      },
    },
    { expectedVersion: expected, currentVersion: current },
  );
}

function managedStaleDiagnosticMessage(reason: string): string {
  if (reason === "version_mismatch") {
    return "Agentera app files are valid but need an update to the expected version";
  }
  return "Agentera app files need repair";
}

function managedStale(
  root: string,
  source: string,
  expected: string | null,
  current: string | null,
  missingEvidence: string[],
  reason: string,
  evidence: Record<string, unknown>,
): Classification {
  return classification(
    root,
    source,
    "managed_stale",
    "preview_refresh",
    "managed",
    "stale",
    missingEvidence,
    {
      code: "install_root.managed_stale",
      severity: "warning",
      message: managedStaleDiagnosticMessage(reason),
      evidence: { path: root, source: sourceLabel(source), reason, ...evidence },
    },
    { expectedVersion: expected, currentVersion: current },
  );
}

function missingEntries(root: string, entries: readonly string[]): string[] {
  return entries.filter((entry) => !pathExists(path.join(root, entry)));
}

function readBundleMarker(root: string): Record<string, unknown> | null {
  const marker = path.join(root, BUNDLE_MARKER);
  if (!isFile(marker)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(marker, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function missingScriptCommands(script: string, commands: readonly string[]): string[] {
  if (!isFile(script)) {
    return [...commands];
  }
  let text: string;
  try {
    text = fs.readFileSync(script, "utf8");
  } catch {
    return [...commands];
  }
  return commands.filter((command) => !text.includes(command));
}

export function classifyResolvedRoot(
  rootInput: string,
  opts: { source: string; expectedVersion?: string | null },
): Classification {
  const root = resolvePath(rootInput);
  const source = opts.source;
  const label = sourceLabel(source);
  const expected = opts.expectedVersion ?? null;

  if (!pathExists(root)) {
    if (source === "default") {
      return classification(
        root,
        source,
        "missing_default",
        "preview_refresh",
        "missing",
        "stale",
        ["directory", "managed bundle evidence"],
        {
          code: "install_root.missing_default_root",
          severity: "warning",
          message:
            "Agentera is not installed in the normal directory yet; a preview can show the repair before anything changes",
          evidence: { path: root, source: label },
        },
        { expectedVersion: expected },
      );
    }
    return classification(
      root,
      source,
      "missing_explicit_or_environment",
      "require_existing_managed_root",
      "missing",
      "not_applicable",
      ["directory", "managed bundle evidence"],
      {
        code: "install_root.missing_selected_root",
        severity: "error",
        message: "Agentera was told to use a directory that does not exist",
        evidence: { path: root, source: label },
      },
      { expectedVersion: expected },
    );
  }

  if (isFile(root)) {
    return classification(
      root,
      source,
      "file_valued_root",
      "reject_file_path",
      "invalid",
      "not_applicable",
      ["directory"],
      {
        code: "install_root.file_path",
        severity: "error",
        message: "Agentera was told to use a file instead of a directory",
        evidence: { path: root, source: label },
      },
      { expectedVersion: expected },
    );
  }

  const setupMissing = missingEntries(root, SETUP_EVIDENCE);
  const bundleMissing = missingEntries(root, BUNDLE_EVIDENCE);
  const hasSetupEvidence = setupMissing.length === 0;
  const hasBundleEvidence = bundleMissing.length === 0;
  const presentEvidence = MANAGED_EVIDENCE.filter((entry) => pathExists(path.join(root, entry)));
  const marker = readBundleMarker(root);
  const current = (marker?.version as string | undefined) ?? null;

  if (hasSetupEvidence && !pathExists(path.join(root, BUNDLE_MARKER))) {
    return managedFresh(root, source, setupMissing, bundleMissing, expected, current);
  }

  if (hasBundleEvidence) {
    if (expected !== null && current !== expected) {
      return managedStale(
        root,
        source,
        expected,
        current,
        ["current bundle marker/version or required CLI command evidence"],
        "version_mismatch",
        {
          expectedVersion: expected,
          currentVersion: current,
          markerPath: path.join(root, BUNDLE_MARKER),
        },
      );
    }
    // Node self-contained model: a marked bundle with current data is fresh; the
    // Python CLI command-probe (scripts/agentera) no longer applies.
    return managedFresh(root, source, setupMissing, bundleMissing, expected, current);
  }

  const managedWithoutMarker =
    pathExists(path.join(root, "scripts", "agentera")) &&
    pathExists(path.join(root, "skills", "agentera", "SKILL.md")) &&
    pathExists(path.join(root, "registry.json"));
  if (managedWithoutMarker) {
    return managedStale(
      root,
      source,
      expected,
      current,
      ["current bundle marker/version or required CLI command evidence"],
      "missing_marker",
      {
        expectedVersion: expected,
        currentVersion: current,
        markerPath: path.join(root, BUNDLE_MARKER),
      },
    );
  }

  if (presentEvidence.length > 0) {
    return classification(
      root,
      source,
      "invalid_bundle",
      "reject_invalid_bundle",
      "invalid",
      "unknown",
      ["valid bundle marker and complete managed bundle evidence"],
      {
        code: "install_root.invalid_bundle",
        severity: "error",
        message: "This directory looks like a broken Agentera install",
        evidence: {
          path: root,
          source: label,
          presentEvidence,
          missingSetupEvidence: setupMissing,
          missingBundleEvidence: bundleMissing,
        },
      },
      { expectedVersion: expected, currentVersion: current },
    );
  }

  return classification(
    root,
    source,
    "unmanaged_directory",
    "reject_unmanaged_directory",
    "unmanaged",
    "not_applicable",
    ["managed bundle evidence"],
    {
      code: "install_root.unmanaged_directory",
      severity: "error",
      message: "This directory already has files Agentera does not recognize",
      evidence: { path: root, source: label },
    },
    { expectedVersion: expected },
  );
}

export function classifyInstallRoot(
  explicitRoot: string | null,
  opts: {
    env: Record<string, string | undefined>;
    home: string;
    expectedVersion?: string | null;
  } & PlatformEnv,
): Classification {
  const [root, source] = resolveCandidate(explicitRoot, opts);
  return classifyResolvedRoot(root, { source, expectedVersion: opts.expectedVersion ?? null });
}

export function formatDiagnostic(c: Classification): string {
  return `${c.diagnostic.severity}: ${c.diagnostic.message} (${c.path})`;
}

/** Resolved app-home path for agent/bootstrap callers (port of install_root.py). */
export function formatResolvedAppHome(
  explicitRoot: string | null | undefined,
  opts: {
    env?: Record<string, string | undefined>;
    home?: string;
    format?: "text" | "json";
    platform?: NodeJS.Platform;
  } = {},
): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? expanduser("~");
  const platform = opts.platform ?? process.platform;
  const [resolvedPath, source] = resolveCandidate(explicitRoot ?? null, { env, home, platform });
  if ((opts.format ?? "text") === "json") {
    return JSON.stringify({
      path: resolvedPath,
      source,
      sourceLabel: sourceLabel(source),
      platform,
    });
  }
  return resolvedPath;
}


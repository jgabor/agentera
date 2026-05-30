import { fileURLToPath } from "node:url";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../core/paths.js";
import {
  SETUP_EVIDENCE,
  classifyResolvedRoot,
} from "../state/installRoot.js";
import { loadRegistry } from "../registries/runtimeAdapterRegistry.js";

/**
 * Setup diagnosis and confirmed installation for an Agentera suite bundle.
 *
 * Faithful TS port of scripts/setup_doctor.py (slice 1: registry-derived
 * constants, install-root classification, and the generic check/aggregate
 * helpers). Per-runtime diagnostics, smoke checks, installer, and CLI land in
 * subsequent slices.
 */

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

export const SCHEMA_VERSION = "agentera.setupDoctor.v1";
export const STATUSES = ["pass", "warn", "fail", "skip"] as const;

const REGISTRY = loadRegistry();
export const DOCTOR_RUNTIME_VIEWS: Record<string, Dict> = Object.fromEntries(
  REGISTRY.runtimeIds.map((runtime) => [runtime, REGISTRY.consumerView("doctor", runtime)]),
);
export const RUNTIMES: string[] = REGISTRY.runtimeIds;
export const WRITABLE_RUNTIMES = ["copilot", "codex"] as const;
export const RUNTIME_BINARIES: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((runtime) => [runtime, DOCTOR_RUNTIME_VIEWS[runtime].host_detection.binary_names[0]]),
);

export const OPENCODE_SKILL_INSTALL_COMMAND =
  "npx skills add jgabor/agentera -g -a opencode --skill agentera -y";
export const OPENCODE_SKILL_NAMES = ["agentera"] as const;
export const OPENCODE_COMMAND_DESCRIPTIONS: Record<string, string> = {
  agentera: "Compound agent orchestration suite: 12 capabilities in one bundled skill",
};

export const CANONICAL_ENTRIES = SETUP_EVIDENCE;
export const HELPER_ENTRIES = ["scripts/validate_capability.py", "hooks/validate_artifact.py"] as const;
export const SMOKE_TIMEOUT_SECONDS = 30;
export const ENV_FALLBACKS = ["AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT"] as const;
export const COPILOT_MARKER = "# agentera: AGENTERA_HOME (managed)";
export const INSTALLER_SCHEMA_VERSION = "agentera.setupInstaller.v1";
export const SUPPORT_PATH_RE = /(?<![\w/.$-])(?<path>references\/[A-Za-z0-9][A-Za-z0-9_./-]*)/;

// ── registry-view accessors (mirror the Python helpers) ─────────────

export function diagnosticCheckNames(runtime: string): string[] {
  return DOCTOR_RUNTIME_VIEWS[runtime].diagnostics.check_names as string[];
}
export function diagnosticMessages(runtime: string): string[] {
  return DOCTOR_RUNTIME_VIEWS[runtime].diagnostics.primary_messages as string[];
}
export function diagnosticStatusLabels(runtime: string): string[] {
  return DOCTOR_RUNTIME_VIEWS[runtime].diagnostics.status_labels as string[];
}
export function diagnosticGapLabels(runtime: string): string[] {
  return DOCTOR_RUNTIME_VIEWS[runtime].diagnostics.gap_labels as string[];
}
export function availabilityProbeLabel(runtime: string): string {
  return String(DOCTOR_RUNTIME_VIEWS[runtime].host_detection.availability_probe_label);
}

export const AVAILABILITY_CHECKS: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, availabilityProbeLabel(rt)]),
);
export const PASS_STATUSES: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticStatusLabels(rt)[0]]),
);
export const WARN_STATUSES: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticStatusLabels(rt)[1]]),
);
export const FAIL_STATUSES: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticStatusLabels(rt)[2]]),
);
export const SKIP_STATUSES: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticStatusLabels(rt)[3]]),
);
export const USER_ENVIRONMENT_GAPS: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticGapLabels(rt)[1]]),
);
export const RUNTIME_CONFIG_GAPS: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticGapLabels(rt)[0]]),
);
export const INSTALLER_FIXABLE_GAPS: Record<string, [string, string]> = {
  copilot: [RUNTIME_CONFIG_GAPS.copilot, USER_ENVIRONMENT_GAPS.copilot],
  codex: [RUNTIME_CONFIG_GAPS.codex, USER_ENVIRONMENT_GAPS.codex],
};

// ── install-root classification ─────────────────────────────────────

export function verifyInstallRoot(root: string): string[] {
  const classification = classifyResolvedRoot(root, { source: "explicit" });
  if (classification.kind === "managed_fresh") return [];
  return SETUP_EVIDENCE.filter((entry) => !pathExists(path.join(root, entry)));
}

export function verifyHelperAccess(root: string): string[] {
  return HELPER_ENTRIES.filter((entry) => !isFile(path.join(root, entry)));
}

function moduleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

export function autoDetectInstallRoot(env: Env, start: string | null = null): string | null {
  for (const variable of ENV_FALLBACKS) {
    const value = env[variable];
    if (value) {
      const candidate = resolvePath(value);
      if (verifyInstallRoot(candidate).length === 0) return candidate;
    }
  }
  let current = resolvePath(start ?? moduleDir());
  for (;;) {
    if (verifyInstallRoot(current).length === 0) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function setupMissing(root: string): string[] {
  return SETUP_EVIDENCE.filter((entry) => !pathExists(path.join(root, entry)));
}

export function classifyInstallRoot(explicitRoot: string | null, env: Env): Dict {
  const source = explicitRoot !== null ? "argument" : "auto";
  const root = explicitRoot !== null ? resolvePath(expanduser(explicitRoot)) : autoDetectInstallRoot(env);
  if (root === null) {
    return {
      status: "fail",
      path: null,
      source,
      kind: null,
      gap: "user_environment",
      message:
        "could not resolve an Agentera install root; pass --install-root or set AGENTERA_HOME",
      missing: [...SETUP_EVIDENCE],
    };
  }

  const classification = classifyResolvedRoot(root, { source: explicitRoot !== null ? "explicit" : "default" });
  if (classification.kind !== "managed_fresh") {
    return {
      status: "fail",
      path: root,
      source,
      kind: null,
      gap: "bundle_packaging",
      message: "install root is missing canonical Agentera entries",
      missing: setupMissing(root),
    };
  }

  const helperMissing = verifyHelperAccess(root);
  const status = helperMissing.length === 0 ? "pass" : "fail";
  return {
    status,
    path: root,
    source,
    kind: pathExists(path.join(root, ".git")) ? "local-clone" : "installed-bundle",
    gap: status === "pass" ? null : "bundle_packaging",
    message:
      status === "pass"
        ? "install root is valid"
        : "install root is valid but shared helper scripts are missing",
    missing: helperMissing,
  };
}

// ── generic check / aggregation helpers ─────────────────────────────

export function mkCheck(
  name: string,
  status: string,
  message: string,
  opts: { source?: string | null; path?: string | null; gap?: string | null; details?: string[] | null } = {},
): Dict {
  return {
    name,
    status,
    message,
    source: opts.source ?? null,
    path: opts.path ?? null,
    gap: opts.gap ?? null,
    details: opts.details ?? [],
  };
}

export function aggregateStatus(checks: Dict[]): string {
  const statuses = checks.map((c) => c.status);
  if (statuses.length > 0 && statuses.every((s) => s === "skip")) return "skip";
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  if (statuses.includes("pass")) return "pass";
  return "skip";
}

export function summarizeStatuses(items: Record<string, Dict> | Dict[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of STATUSES) counts[status] = 0;
  const values = Array.isArray(items) ? items : Object.values(items);
  for (const item of values) counts[item.status] += 1;
  return counts;
}

export function tail(text: string, limit = 5): string[] {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim());
  return lines.slice(-limit);
}

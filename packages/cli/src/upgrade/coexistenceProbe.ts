import path from "node:path";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import { NPX_BUNDLE_SENTINEL } from "../core/sourceRoot.js";
import { BUNDLE_MARKER, defaultAppHome } from "../state/installRoot.js";
import { hasBundleRootEvidence } from "./bundleEvidence.js";
import type { JsonObject } from "../core/jsonValue.js";

/**
 * v2/v3 coexistence doctor probe (authority: references/cli/coexistence-probe.yaml).
 */

export const COEXISTENCE_PROBE_AUTHORITY = "references/cli/coexistence-probe.yaml";
export const COEXISTENCE_SECTION_HEADER = "Coexistence";
export const COEXISTENCE_NAMING_DIVERGENCE_LABEL = "naming divergence";

type Env = Record<string, string | undefined>;

function authorityPath(sourceRoot: string): string {
  const candidate = path.join(sourceRoot, COEXISTENCE_PROBE_AUTHORITY);
  if (pathExists(candidate)) {
    return candidate;
  }
  return path.join(process.cwd(), COEXISTENCE_PROBE_AUTHORITY);
}

export function loadCoexistenceProbeAuthority(sourceRoot: string): JsonObject {
  return loadYamlMappingFile(authorityPath(sourceRoot)) as JsonObject; // cast: YAML parse IO boundary
}

/** True when the platform default app home holds a v2 Python-managed install. */
export function isV2ManagedInstallAtAppHome(appHome: string): boolean {
  if (!pathExists(appHome)) {
    return false;
  }
  const activeBundleRoot = path.join(appHome, "app");
  if (!pathExists(activeBundleRoot)) {
    return false;
  }
  if (isFile(path.join(activeBundleRoot, NPX_BUNDLE_SENTINEL))) {
    return false;
  }
  const bundleMarker = isFile(path.join(activeBundleRoot, BUNDLE_MARKER));
  const agenteraScript = isFile(path.join(activeBundleRoot, "scripts", "agentera"));
  return (bundleMarker || agenteraScript) && hasBundleRootEvidence(activeBundleRoot);
}

export function detectV2Coexistence(opts: { home: string; env?: Env }): string[] {
  const env = opts.env ?? process.env;
  const appHome = resolvePath(defaultAppHome(env, opts.home));
  if (!isV2ManagedInstallAtAppHome(appHome)) {
    return [];
  }
  return [`v2 managed app home: ${appHome}`];
}

/**
 * Renders the naming-divergence dimension from the coexistence probe contract.
 * Surfaces the v3 English capability IDs against the v2 stable Swedish -era IDs
 * so a doctor reader can see the vocabulary split between the two CLI lines.
 * Returns null when the contract omits or malforms the dimension.
 */
export function formatNamingDivergenceLines(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const block = raw as JsonObject;
  const v3 = block.v3_canonical;
  const v2 = block.v2_stable;
  if (!Array.isArray(v3) || v3.length === 0 || !Array.isArray(v2) || v2.length === 0) {
    return null;
  }
  return [
    `  ${COEXISTENCE_NAMING_DIVERGENCE_LABEL}:`,
    `    v3: ${v3.map(String).join(", ")}`,
    `    v2: ${v2.map(String).join(", ")}`,
  ];
}

export function formatCoexistenceDoctorLines(contract: JsonObject): string[] {
  const section = String(contract.section_header ?? COEXISTENCE_SECTION_HEADER);
  const warning = contract.warning;
  if (!warning || typeof warning !== "object" || Array.isArray(warning)) {
    throw new Error("coexistence probe contract: warning must be a mapping");
  }
  const block = warning as JsonObject;
  const headline = String(block.headline ?? "").trim();
  const resolutions = block.resolutions;
  if (!headline || !Array.isArray(resolutions) || resolutions.length === 0) {
    throw new Error("coexistence probe contract: warning headline and resolutions required");
  }
  const lines = [section, headline];
  for (const item of resolutions) {
    lines.push(`  - ${String(item)}`);
  }
  const divergence = formatNamingDivergenceLines(contract.naming_divergence);
  if (divergence) {
    lines.push(...divergence);
  }
  return lines;
}

export function resolveCoexistenceDoctorLines(opts: {
  home: string;
  sourceRoot: string;
  env?: Env;
}): string[] | null {
  const evidence = detectV2Coexistence({ home: opts.home, env: opts.env });
  if (evidence.length === 0) {
    return null;
  }
  const contract = loadCoexistenceProbeAuthority(opts.sourceRoot);
  return formatCoexistenceDoctorLines(contract);
}

export function prependCoexistenceDoctorSection(text: string, sectionLines: string[] | null): string {
  if (!sectionLines || sectionLines.length === 0) {
    return text;
  }
  return `${sectionLines.join("\n")}\n\n${text}`;
}

/** Reset nothing today; reserved for future contract caching in tests. */
export function resetCoexistenceProbeCache(): void {}

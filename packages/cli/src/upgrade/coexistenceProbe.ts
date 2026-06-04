import path from "node:path";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import { NPX_BUNDLE_SENTINEL } from "../core/sourceRoot.js";
import { BUNDLE_MARKER, defaultAppHome } from "../state/installRoot.js";

/**
 * v2/v3 coexistence doctor probe (authority: references/cli/coexistence-probe.yaml).
 */

export const COEXISTENCE_PROBE_AUTHORITY = "references/cli/coexistence-probe.yaml";
export const COEXISTENCE_SECTION_HEADER = "Coexistence";

type Dict = Record<string, unknown>;
type Env = Record<string, string | undefined>;

function authorityPath(sourceRoot: string): string {
  const candidate = path.join(sourceRoot, COEXISTENCE_PROBE_AUTHORITY);
  if (pathExists(candidate)) {
    return candidate;
  }
  return path.join(process.cwd(), COEXISTENCE_PROBE_AUTHORITY);
}

export function loadCoexistenceProbeAuthority(sourceRoot: string): Dict {
  return loadYamlMappingFile(authorityPath(sourceRoot));
}

function hasBundleRootEvidence(root: string): boolean {
  return (
    isFile(path.join(root, "scripts", "agentera")) &&
    isFile(path.join(root, "skills", "agentera", "SKILL.md"))
  );
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

export function formatCoexistenceDoctorLines(contract: Dict): string[] {
  const section = String(contract.section_header ?? COEXISTENCE_SECTION_HEADER);
  const warning = contract.warning;
  if (!warning || typeof warning !== "object" || Array.isArray(warning)) {
    throw new Error("coexistence probe contract: warning must be a mapping");
  }
  const block = warning as Dict;
  const headline = String(block.headline ?? "").trim();
  const resolutions = block.resolutions;
  if (!headline || !Array.isArray(resolutions) || resolutions.length === 0) {
    throw new Error("coexistence probe contract: warning headline and resolutions required");
  }
  const lines = [section, headline];
  for (const item of resolutions) {
    lines.push(`  - ${String(item)}`);
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

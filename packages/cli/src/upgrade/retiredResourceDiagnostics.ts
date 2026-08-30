import fs from "node:fs";
import path from "node:path";

import {
  loadNativeResourceCleanupContract,
  resolveRetiredResourceDiagnosticId,
  type NativeResourceCleanupContract,
  type RetiredResourceDiagnosticDefinition,
} from "../runtime/nativeResourceCleanup.js";
import { opencodeConfigDir } from "../setup/opencode.js";

export interface RetiredResourceDiagnostic {
  id: string;
  status: "action_required";
  kind: RetiredResourceDiagnosticDefinition["kind"];
  ownershipMode: RetiredResourceDiagnosticDefinition["ownershipMode"];
  ownershipEvidence: string;
  focusedPreview: RetiredResourceDiagnosticDefinition["focusedPreview"];
  markerKind: RetiredResourceDiagnosticDefinition["markerKind"];
  markerSyntax: string | null;
  evidence: {
    paths: string[];
    observation: "path_present" | "uninspectable";
  };
}

export interface RetiredResourceDiagnosis {
  schemaVersion: "agentera.retiredResourceDiagnosis.v1";
  status: "clean" | "action_required";
  selectedResourceId: string | null;
  resources: RetiredResourceDiagnostic[];
  omittedResourceCount: number;
}

interface ResourceObservation {
  path: string;
  observation: RetiredResourceDiagnostic["evidence"]["observation"];
}

export interface RetiredResourceRoots {
  home: string;
  project: string;
  install_root: string;
  opencode_config: string;
}

function templateRoot(template: string, roots: RetiredResourceRoots): string {
  const match = /^\{(home|project|install_root|opencode_config)\}\//.exec(template);
  if (!match) throw new Error(`unsafe retired-resource diagnostic path template: ${template}`);
  return roots[match[1] as "home" | "project" | "install_root" | "opencode_config"];
}

export function expandRetiredResourcePath(template: string, roots: RetiredResourceRoots, name: string | null = null): string {
  const root = templateRoot(template, roots);
  const expanded = template
    .replace("{home}", roots.home)
    .replace("{project}", roots.project)
    .replace("{install_root}", roots.install_root)
    .replace("{opencode_config}", roots.opencode_config)
    .replace("{name}", name ?? "");
  if (expanded.includes("{") || expanded.includes("..")) {
    throw new Error(`unsafe retired-resource diagnostic path template: ${template}`);
  }
  const resolved = path.resolve(expanded);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`retired-resource diagnostic path escapes its root: ${template}`);
  }
  return resolved;
}

export function resolveRetiredResourceRoots(opts: {
  home: string;
  project: string;
  installRoot: string;
  env?: Record<string, string | undefined>;
}): RetiredResourceRoots {
  const home = path.resolve(opts.home);
  const configured = path.resolve(opencodeConfigDir(home, { ...opts.env, HOME: home }));
  const configuredRelative = path.relative(home, configured);
  const opencodeConfig = configuredRelative === ""
    || (configuredRelative !== ".." && !configuredRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(configuredRelative))
    ? configured
    : path.join(home, ".config", "opencode");
  return {
    home,
    project: path.resolve(opts.project),
    install_root: path.resolve(opts.installRoot),
    opencode_config: opencodeConfig,
  };
}

function fileContains(pathname: string, marker: string, maximumFileBytes: number): ResourceObservation["observation"] | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "uninspectable";
  }
  if (!stat.isFile() || stat.size > maximumFileBytes) return "uninspectable";
  const fd = fs.openSync(pathname, "r");
  try {
    const content = Buffer.alloc(stat.size);
    fs.readSync(fd, content, 0, content.length, 0);
    return content.toString("utf8").includes(marker) ? "path_present" : null;
  } catch {
    return "uninspectable";
  } finally {
    fs.closeSync(fd);
  }
}

function observeDestination(
  pathname: string,
  definition: RetiredResourceDiagnosticDefinition,
  maximumFileBytes: number,
): ResourceObservation | null {
  if (definition.contains) {
    const observation = fileContains(pathname, definition.contains, maximumFileBytes);
    return observation ? { path: pathname, observation } : null;
  }
  try {
    fs.lstatSync(pathname);
    return { path: pathname, observation: "path_present" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : { path: pathname, observation: "uninspectable" };
  }
}

function namesFor(definition: RetiredResourceDiagnosticDefinition): string[] {
  return definition.id.includes("{name}") || definition.destinations.some((item) => item.includes("{name}"))
    ? definition.names
    : [""];
}

export function diagnoseRetiredResources(
  opts: {
    home: string;
    project: string;
    installRoot: string;
    resourceId?: string | null;
    contract?: NativeResourceCleanupContract;
    env?: Record<string, string | undefined>;
    sourceRoot?: string | null;
  },
): RetiredResourceDiagnosis {
  const contract = opts.contract ?? loadNativeResourceCleanupContract();
  const selected = opts.resourceId ? resolveRetiredResourceDiagnosticId(opts.resourceId, contract) : null;
  if (opts.resourceId && !selected) {
    throw new Error(`unknown retired Agentera resource ID: ${opts.resourceId}`);
  }
  const roots = resolveRetiredResourceRoots(opts);
  const observed = new Map<string, { definition: RetiredResourceDiagnosticDefinition; observations: ResourceObservation[] }>();
  for (const definition of contract.diagnosticResources) {
    if (definition.boundary === "external_install_only"
      && opts.sourceRoot && path.resolve(opts.sourceRoot) === roots.install_root) continue;
    for (const name of namesFor(definition)) {
      const id = definition.id.replace("{name}", name);
      if (selected && id !== selected.id) continue;
      for (const destination of definition.destinations) {
        const pathname = expandRetiredResourcePath(destination, roots, name || null);
        const observation = observeDestination(pathname, definition, contract.diagnosticMaximumFileBytes);
        if (!observation) continue;
        const current = observed.get(id) ?? { definition, observations: [] };
        if (!current.observations.some((item) => item.path === observation.path)) current.observations.push(observation);
        observed.set(id, current);
      }
    }
  }
  const entries = [...observed.entries()].sort(([left], [right]) => left.localeCompare(right));
  const retained = entries.slice(0, contract.diagnosticMaximumResources).map(([id, { definition, observations }]) => ({
    id,
    status: "action_required" as const,
    kind: definition.kind,
    ownershipMode: definition.ownershipMode,
    ownershipEvidence: definition.ownershipEvidence,
    focusedPreview: definition.focusedPreview,
    markerKind: definition.markerKind,
    markerSyntax: definition.markerSyntax,
    evidence: {
      paths: [...new Set(observations.map((observation) => observation.path))].sort(),
      observation: observations.some((observation) => observation.observation === "uninspectable")
        ? "uninspectable" as const
        : "path_present" as const,
    },
  }));
  return {
    schemaVersion: "agentera.retiredResourceDiagnosis.v1",
    status: retained.length > 0 || entries.length > contract.diagnosticMaximumResources ? "action_required" : "clean",
    selectedResourceId: selected?.id ?? null,
    resources: retained,
    omittedResourceCount: Math.max(0, entries.length - retained.length),
  };
}

import fs from "node:fs";
import path from "node:path";

import {
  loadNativeResourceCleanupContract,
  retiredResourceDiagnosticIds,
  type NativeResourceCleanupContract,
  type RetiredResourceDiagnosticDefinition,
} from "../runtime/nativeResourceCleanup.js";

export interface RetiredResourceDiagnostic {
  id: string;
  status: "action_required";
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

function templateRoot(template: string, roots: Record<string, string>): string {
  const match = /^\{(home|project|install_root)\}\//.exec(template);
  if (!match) throw new Error(`unsafe retired-resource diagnostic path template: ${template}`);
  return roots[match[1]]!;
}

function expandTemplate(template: string, roots: Record<string, string>, name: string | null): string {
  const root = templateRoot(template, roots);
  const expanded = template
    .replace("{home}", roots.home)
    .replace("{project}", roots.project)
    .replace("{install_root}", roots.install_root)
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
  },
): RetiredResourceDiagnosis {
  const contract = opts.contract ?? loadNativeResourceCleanupContract();
  if (opts.resourceId && !retiredResourceDiagnosticIds(contract).includes(opts.resourceId)) {
    throw new Error(`unknown retired Agentera resource ID: ${opts.resourceId}`);
  }
  const roots = {
    home: path.resolve(opts.home),
    project: path.resolve(opts.project),
    install_root: path.resolve(opts.installRoot),
  };
  const observed = new Map<string, ResourceObservation[]>();
  for (const definition of contract.diagnosticResources) {
    for (const name of namesFor(definition)) {
      const id = definition.id.replace("{name}", name);
      if (opts.resourceId && id !== opts.resourceId) continue;
      for (const destination of definition.destinations) {
        const pathname = expandTemplate(destination, roots, name || null);
        const observation = observeDestination(pathname, definition, contract.diagnosticMaximumFileBytes);
        if (!observation) continue;
        const current = observed.get(id) ?? [];
        current.push(observation);
        observed.set(id, current);
      }
    }
  }
  const entries = [...observed.entries()].sort(([left], [right]) => left.localeCompare(right));
  const retained = entries.slice(0, contract.diagnosticMaximumResources).map(([id, observations]) => ({
    id,
    status: "action_required" as const,
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
    selectedResourceId: opts.resourceId ?? null,
    resources: retained,
    omittedResourceCount: Math.max(0, entries.length - retained.length),
  };
}

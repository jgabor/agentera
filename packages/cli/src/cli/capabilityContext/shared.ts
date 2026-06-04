import fs from "node:fs";
import path from "node:path";
import { loadYamlMapping } from "../../core/yaml.js";
import { activeAppModel, discoverSchemasDir } from "../appContext.js";
import { asList, firstPresent } from "../stateQuery.js";
import { CAPABILITY_NAMES } from "./types.js";

export { CAPABILITY_NAMES };
import type { Dict } from "./types.js";

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function entryStatus(entry: Dict, def = "open"): string {
  const raw = "status" in entry ? entry.status : def;
  return String(raw || def).toLowerCase();
}

export function pyRepr(value: string): string {
  return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
}

export function validatePrimeCapability(capability: string): void {
  if (!CAPABILITY_NAMES.includes(capability)) {
    const valid = CAPABILITY_NAMES.join(", ");
    throw new Error(
      `unsupported capability ${pyRepr(capability)}; valid capabilities: ${valid}. ` +
        "Example: agentera prime --context planera --format json",
    );
  }
}

export function appendUnique(items: string[], value: string): void {
  if (value && !items.includes(value)) items.push(value);
}

export function taskRef(task: Dict): Dict {
  return { number: task.number ?? null, name: firstPresent(task, ["name", "title"], ""), status: entryStatus(task, "pending") };
}

export function sourceProvenance(sourceFamily: string, command: string, field: string | null = null): Dict {
  const provenance: Dict = { source_family: sourceFamily, command };
  if (field) provenance.field = field;
  return provenance;
}

export function docsConventions(docs: Dict): Dict {
  const conventions = docs.conventions;
  return conventions && typeof conventions === "object" && !Array.isArray(conventions) ? conventions : {};
}

export function hasRecordedValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Dict).length > 0;
  return true;
}

export function fallbackStatePointer(artifactId: string, command: string): Dict {
  return { status: "fallback_only", artifact_id: artifactId, fallback_command: command, raw_artifact_reads_required: false };
}

export function capabilityContextAppSummary(appHome: Dict, bundle: Dict): Dict {
  const caveats: string[] = [];
  if (appHome.status !== "up_to_date") {
    caveats.push("Agentera app files are not up to date; this is a caveat, not approval to repair or update app files.");
  }
  return {
    status: appHome.status,
    home: appHome.home,
    source: appHome.source,
    managed_app_root: appHome.managed_app_root,
    user_data_root: appHome.user_data_root,
    expected_version: bundle.expectedVersion,
    caveats,
  };
}

export function capabilityContextProfileSummary(profile: Dict): Dict {
  const caveats: string[] = [];
  if (profile.status !== "loaded") caveats.push("profile-derived state is unavailable in prime --context response.");
  else if (profile.stale === true) caveats.push("profile-derived state is stale; this is a caveat, not approval to refresh profile state.");
  const summary: Dict = {};
  for (const key of ["status", "path", "stale", "days_since_generated", "stale_threshold_days", "suggested_action"]) {
    if (key in profile) summary[key] = profile[key];
  }
  summary.caveats = caveats;
  return summary;
}

export function uniqueList(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) if (!out.includes(item)) out.push(item);
  return out;
}

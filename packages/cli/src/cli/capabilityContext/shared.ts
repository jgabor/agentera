import fs from "node:fs";
import path from "node:path";
import { loadYamlMapping } from "../../core/yaml.js";
import { activeAppModel, discoverSchemasDir } from "../appContext.js";
import { asList, firstPresent } from "../stateQuery.js";
import { CAPABILITY_NAMES } from "./types.js";
import { preCutoverCommand } from "../preCutoverCommand.js";

export { CAPABILITY_NAMES };
import type { JsonObject } from "../../core/jsonValue.js";

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function entryStatus(entry: JsonObject, def = "open"): string {
  const raw = "status" in entry ? entry.status : def;
  return String(raw || def).toLowerCase();
}

export function pyRepr(value: string): string {
  return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
}

export function validatePrimeCapability(capability: string): void {
  if (!CAPABILITY_NAMES.includes(capability)) {
    const valid = CAPABILITY_NAMES.join(", ");
    throw new Error(`unsupported capability ${pyRepr(capability)}; valid capabilities: ${valid}. ` + `Example: ${preCutoverCommand("prime --context plan")}`);
  }
}

export function appendUnique(items: string[], value: string): void {
  if (value && !items.includes(value)) items.push(value);
}

export function taskRef(task: JsonObject): JsonObject {
  const record = task.record && typeof task.record === "object" && !Array.isArray(task.record) ? (task.record as JsonObject) : task;
  return {
    id: task.id ?? null,
    artifact: task.artifact ?? "plan",
    name: firstPresent(record, ["name", "title"], ""),
    status: entryStatus(record, "pending"),
  };
}

export function sourceProvenance(sourceFamily: string, command: string, field: string | null = null): JsonObject {
  const provenance: JsonObject = { source_family: sourceFamily, command };
  if (field) provenance.field = field;
  return provenance;
}

export function docsConventions(docs: JsonObject): JsonObject {
  const conventions = docs.conventions;
  return conventions && typeof conventions === "object" && !Array.isArray(conventions) ? conventions : {};
}

export function hasRecordedValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as JsonObject).length > 0;
  return true;
}

export function capabilityContextAppSummary(appHome: JsonObject, bundle: JsonObject): JsonObject {
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

export function uniqueList(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) if (!out.includes(item)) out.push(item);
  return out;
}

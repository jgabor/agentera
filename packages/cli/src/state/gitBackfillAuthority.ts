import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

const AUTHORITY_RELATIVE_PATH = "references/artifacts/state-storage-authority.yaml";

export interface StateGitBackfillContract {
  command: string;
  formats: string[];
  defaultLimit: number;
  maximumLimit: number;
  maximumCommits: number;
  maximumHistoryBytes: number;
  supportedArtifacts: string[];
  reachableRefs: string[];
  excludedRefs: string[];
  ambiguityReasons: string[];
}

function mapping(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`state storage authority field '${field}' must be a non-empty string`);
  }
  return value;
}

function requiredList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`state storage authority field '${field}' must be a list of non-empty strings`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`state storage authority field '${field}' must be a positive integer`);
  }
  return value;
}

export function stateGitBackfillContract(
  sourceRoot: string = resolveSourceRoot(),
): StateGitBackfillContract {
  const authority = loadYamlMapping(
    fs.readFileSync(path.join(sourceRoot, AUTHORITY_RELATIVE_PATH), "utf8"),
  );
  if (authority.schema_version !== "agentera.stateStorageAuthority.v1") {
    throw new Error("state storage authority schema_version is unsupported");
  }
  if (authority.status !== "active_authority") {
    throw new Error("state storage authority must be active_authority");
  }
  const api = mapping(authority.api);
  const backfill = mapping(api.backfill);
  const formats = requiredList(backfill.formats, "api.backfill.formats");
  if (formats.join(",") !== "text,json,yaml") {
    throw new Error("state storage authority backfill formats must be text, json, yaml");
  }
  const defaultLimit = requiredPositiveInteger(backfill.default_limit, "api.backfill.default_limit");
  const maximumLimit = requiredPositiveInteger(backfill.maximum_limit, "api.backfill.maximum_limit");
  if (defaultLimit > maximumLimit) {
    throw new Error("state storage authority backfill default limit exceeds maximum limit");
  }
  return {
    command: requiredString(backfill.command, "api.backfill.command"),
    formats,
    defaultLimit,
    maximumLimit,
    maximumCommits: requiredPositiveInteger(backfill.maximum_commits, "api.backfill.maximum_commits"),
    maximumHistoryBytes: requiredPositiveInteger(
      backfill.maximum_history_bytes,
      "api.backfill.maximum_history_bytes",
    ),
    supportedArtifacts: requiredList(backfill.supported_artifacts, "api.backfill.supported_artifacts"),
    reachableRefs: requiredList(backfill.reachable_refs, "api.backfill.reachable_refs"),
    excludedRefs: requiredList(backfill.excluded_refs, "api.backfill.excluded_refs"),
    ambiguityReasons: requiredList(backfill.ambiguity_reasons, "api.backfill.ambiguity_reasons"),
  };
}

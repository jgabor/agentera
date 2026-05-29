import fs from "node:fs";

import YAML from "yaml";

/**
 * Parse YAML text as a mapping. Empty/whitespace-only documents return `{}`.
 * Non-mapping roots throw. Faithful port of `scripts/yaml_mapping.py`.
 */
export function loadYamlMapping(text: string): Record<string, unknown> {
  const parsed = YAML.parse(text);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("YAML root must be a mapping");
  }
  return parsed as Record<string, unknown>;
}

/** Read `path` and parse it with {@link loadYamlMapping}. */
export function loadYamlMappingFile(path: string): Record<string, unknown> {
  return loadYamlMapping(fs.readFileSync(path, "utf8"));
}

/** Parse arbitrary YAML (any root type). */
export function parseYaml(text: string): unknown {
  return YAML.parse(text);
}

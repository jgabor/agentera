import crypto from "node:crypto";
import fs from "node:fs";

import YAML from "yaml";

const MAX_MAPPING_CACHE_ENTRIES = 64;
type CachedMapping = { digest: string; value: Record<string, unknown> };
type MappingCache = { entries: Map<string, CachedMapping>; readOnly: boolean };
let activeMappingCache: MappingCache | null = null;

/** Run synchronous work with a bounded, content-invalidated YAML mapping cache. */
export function withYamlMappingCache<T>(run: () => T): T {
  return withActiveYamlMappingCache(run, false);
}

/** Share frozen YAML mappings only inside one trusted read-only operation. */
export function withReadOnlyYamlMappingCache<T>(run: () => T): T {
  return withActiveYamlMappingCache(run, true);
}

function withActiveYamlMappingCache<T>(run: () => T, readOnly: boolean): T {
  const previous = activeMappingCache;
  activeMappingCache = { entries: new Map(), readOnly };
  try {
    return run();
  } finally {
    activeMappingCache = previous;
  }
}

function freezeYamlValue(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeYamlValue(child, seen);
  Object.freeze(value);
}

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
  const cache = activeMappingCache;
  if (cache === null) return loadYamlMapping(fs.readFileSync(path, "utf8"));
  // One synchronous operation sees a stable frozen authority snapshot.
  // A fresh scope still fingerprints its current bytes before reuse.
  if (cache.readOnly) {
    const cached = cache.entries.get(path);
    if (cached) return cached.value;
  }
  const text = fs.readFileSync(path, "utf8");
  const digest = crypto.createHash("sha256").update(text).digest("hex");
  // A digest check preserves fresh authority reads while avoiding repeated parses.
  const cached = cache.entries.get(path);
  if (cached?.digest === digest) return cache.readOnly ? cached.value : structuredClone(cached.value);
  const value = loadYamlMapping(text);
  if (cache.readOnly) freezeYamlValue(value);
  cache.entries.set(path, { digest, value });
  if (cache.entries.size > MAX_MAPPING_CACHE_ENTRIES) {
    cache.entries.delete(cache.entries.keys().next().value!);
  }
  return cache.readOnly ? value : structuredClone(value);
}

/** Parse arbitrary YAML (any root type). */
export function parseYaml(text: string): unknown {
  return YAML.parse(text);
}

/** Serialize a YAML mapping with stable block-style prose and insertion-order keys. */
export function dumpYamlMapping(doc: Record<string, unknown>): string {
  return YAML.stringify(doc, {
    blockQuote: "literal",
    collectionStyle: "block",
    lineWidth: 0,
  });
}

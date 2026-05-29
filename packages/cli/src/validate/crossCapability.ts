import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  ArtifactRecord,
  artifactSchemasDir as defaultArtifactSchemasDir,
  loadArtifactRegistry,
} from "../registries/artifactRegistry.js";

/**
 * Validate cross-capability artifact producer/consumer consistency. Faithful TS
 * port of scripts/validate_cross_capability.py.
 */

type Dict = Record<string, any>;

export interface CanonicalArtifact {
  artifactId: string;
  displayName: string;
  producers: Set<string>;
  consumers: Set<string>;
}

export interface CapabilityArtifact {
  capability: string;
  artifactId: string;
  displayName: string;
  producers: Set<string>;
  consumers: Set<string>;
}

function capabilitiesDirDefault(): string {
  return path.join(resolveSourceRoot(), "skills", "agentera", "capabilities");
}

function loadYaml(p: string): Dict {
  return loadYamlMapping(fs.readFileSync(p, "utf8"));
}

export function loadCanonicalArtifacts(
  artifactSchemasDir: string = defaultArtifactSchemasDir(),
): Map<string, CanonicalArtifact> {
  const out = new Map<string, CanonicalArtifact>();
  for (const [artifactId, record] of loadArtifactRegistry(artifactSchemasDir)) {
    out.set(artifactId, {
      artifactId: record.artifactId,
      displayName: record.displayName,
      producers: record.producers,
      consumers: record.consumers,
    });
  }
  return out;
}

function listCapabilityDirs(capabilitiesDir: string): string[] {
  if (!fs.existsSync(capabilitiesDir) || !fs.statSync(capabilitiesDir).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(capabilitiesDir)
    .filter((name) => fs.statSync(path.join(capabilitiesDir, name)).isDirectory())
    .sort();
}

export function loadCapabilityArtifacts(
  capabilitiesDir: string = capabilitiesDirDefault(),
): CapabilityArtifact[] {
  const records: CapabilityArtifact[] = [];
  for (const capName of listCapabilityDirs(capabilitiesDir)) {
    const artifactPath = path.join(capabilitiesDir, capName, "schemas", "artifacts.yaml");
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      continue;
    }
    const data = loadYaml(artifactPath);
    const entries = data.ARTIFACTS ?? {};
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
      continue;
    }
    for (const entry of Object.values(entries)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const e = entry as Dict;
      const artifactId = String(e.artifact_id ?? "").trim();
      const localRole = String(e.local_role ?? "").trim();
      if (!artifactId) {
        continue;
      }
      const produces = localRole === "produces" || localRole === "produces_and_consumes";
      const consumes = localRole === "consumes" || localRole === "produces_and_consumes";
      records.push({
        capability: capName,
        artifactId,
        displayName: artifactId,
        producers: produces ? new Set([capName]) : new Set(),
        consumers: consumes ? new Set([capName]) : new Set(),
      });
    }
  }
  return records;
}

function displayName(record: CapabilityArtifact, registry: Map<string, ArtifactRecord>): string {
  const artifact = registry.get(record.artifactId);
  return artifact ? artifact.displayName : record.artifactId;
}

function unionSets(sets: Iterable<Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const s of sets) {
    for (const v of s) {
      out.add(v);
    }
  }
  return out;
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const v of a) {
    if (b.has(v)) {
      out.add(v);
    }
  }
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const v of a) {
    if (!b.has(v)) {
      return false;
    }
  }
  return true;
}

function sortedListRepr(s: Set<string>): string {
  const arr = [...s].sort();
  return "[" + arr.map((v) => `'${v}'`).join(", ") + "]";
}

export function validateGraph(
  artifactSchemasDir: string = defaultArtifactSchemasDir(),
  capabilitiesDir: string = capabilitiesDirDefault(),
): string[] {
  const registry = loadArtifactRegistry(artifactSchemasDir);
  const canonical = loadCanonicalArtifacts(artifactSchemasDir);
  const capabilityArtifacts = loadCapabilityArtifacts(capabilitiesDir);
  const capabilityNames = new Set(listCapabilityDirs(capabilitiesDir));
  const errors: string[] = [];

  const byArtifactId = new Map<string, CapabilityArtifact[]>();
  for (const record of capabilityArtifacts) {
    if (!byArtifactId.has(record.artifactId)) {
      byArtifactId.set(record.artifactId, []);
    }
    byArtifactId.get(record.artifactId)!.push(record);
    const name = displayName(record, registry);
    if (!canonical.has(record.artifactId)) {
      errors.push(`${record.capability}: unknown artifact_id '${record.artifactId}'`);
      continue;
    }
    if (record.producers.size === 0 && record.consumers.size === 0) {
      errors.push(`${record.capability}: ${name} neither produces nor consumes`);
    }
  }

  for (const [artifactId, artifact] of canonical) {
    const records = byArtifactId.get(artifactId) ?? [];
    const producedBy = records.length ? unionSets(records.map((r) => r.producers)) : new Set<string>();
    const consumedBy = records.length ? unionSets(records.map((r) => r.consumers)) : new Set<string>();
    const schemaProducers = intersect(artifact.producers, capabilityNames);
    const schemaConsumers = intersect(artifact.consumers, capabilityNames);
    if (schemaProducers.size > 0 && !setsEqual(schemaProducers, producedBy)) {
      errors.push(
        `${artifact.displayName}: registry producers ${sortedListRepr(schemaProducers)} ` +
          `do not match capability producers ${sortedListRepr(producedBy)}`,
      );
    }
    if (
      artifact.consumers.size > 0 &&
      !artifact.consumers.has("all_skills") &&
      !setsEqual(schemaConsumers, consumedBy)
    ) {
      errors.push(
        `${artifact.displayName}: registry consumers ${sortedListRepr(schemaConsumers)} ` +
          `do not match capability consumers ${sortedListRepr(consumedBy)}`,
      );
    }
  }

  return errors;
}

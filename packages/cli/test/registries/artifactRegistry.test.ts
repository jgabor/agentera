import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadArtifactRegistry,
  loadDocsPathOverrides,
  resolveArtifactPath,
} from "../../src/registries/artifactRegistry.js";
import type { JsonObject } from "../../src/core/jsonValue.js";
import { repoStateFixturePath } from "../helpers/useFixtureProject.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MODEL_PATH = path.join(REPO_ROOT, "references/artifacts/artifact-registry-interface-model.yaml");
const ARTIFACT_SCHEMA_DIR = path.join(REPO_ROOT, "skills/agentera/schemas/artifacts");
const CAPABILITY_DIR = path.join(REPO_ROOT, "skills/agentera/capabilities");
const DOCS_PATH = path.join(repoStateFixturePath("ok"), ".agentera/docs.yaml");

function loadYaml(p: string): JsonObject {
  const data = YAML.parse(fs.readFileSync(p, "utf8"));
  expect(typeof data).toBe("object");
  return data as JsonObject; // cast: IO boundary — YAML.parse of registry fixture; guarded by typeof expect above
}

function modelFixture(): JsonObject {
  return loadYaml(MODEL_PATH);
}

function artifactSchemaMetas(): Record<string, JsonObject> {
  const metas: Record<string, JsonObject> = {};
  const files = fs.readdirSync(ARTIFACT_SCHEMA_DIR).filter((n) => n.endsWith(".yaml")).sort();
  for (const name of files) {
    const meta = loadYaml(path.join(ARTIFACT_SCHEMA_DIR, name)).meta;
    expect(meta, `${name} missing meta`).toBeTruthy();
    const artifactId = meta.name;
    expect(typeof artifactId, `${name} meta.name must be a string`).toBe("string");
    metas[artifactId] = meta;
  }
  return metas;
}

function asList(value: any): any[] {
  return Array.isArray(value) ? value : [value];
}

function knownDisplayNames(model: JsonObject): Set<string> {
  const names = new Set<string>();
  for (const records of Object.values(model.required_artifact_identities) as any[][]) {
    for (const record of records) names.add(record.display_name);
  }
  for (const record of model.explicit_special_cases as any[]) names.add(record.display_name);
  return names;
}

function validateRegistryContract(model: JsonObject, metas: Record<string, JsonObject>): string[] {
  const errors: string[] = [];
  const enumValues = model.owned_enums ?? {};
  const artifactTypes = new Set<string>(enumValues.artifact_type ?? []);
  const scopes = new Set<string>(enumValues.scope ?? []);
  const seenIds = new Set<string>();
  const seenDisplayNames = new Set<string>();

  for (const group of model.record.required_groups) {
    if (!(group in model.record.groups)) {
      errors.push(`record.groups missing required group ${group}`);
    }
  }

  for (const [scope, records] of Object.entries(model.required_artifact_identities ?? {}) as [string, any[]][]) {
    if (!scopes.has(scope)) {
      errors.push(`required_artifact_identities.${scope} unknown scope`);
    }
    records.forEach((record, index) => {
      const prefix = `required_artifact_identities.${scope}[${index}]`;
      const artifactId = record.artifact_id;
      const displayName = record.display_name;
      const defaultPath = record.default_path;
      const meta = metas[artifactId];
      if (!meta) {
        errors.push(`${prefix}.artifact_id unknown artifact schema: ${artifactId}`);
        return;
      }
      if (seenIds.has(artifactId)) errors.push(`duplicate artifact_id: ${artifactId}`);
      seenIds.add(artifactId);
      if (seenDisplayNames.has(displayName)) errors.push(`duplicate display_name: ${displayName}`);
      seenDisplayNames.add(displayName);
      if (meta.path !== defaultPath) {
        errors.push(`${prefix}.default_path differs from canonical schema meta.path`);
      }
      if (!artifactTypes.has(meta.artifact_type)) {
        errors.push(`${prefix}.artifact_type unknown: ${meta.artifact_type}`);
      }
      for (const relationshipField of ["producer", "consumers"]) {
        const values = asList(meta[relationshipField]);
        if (values.length === 0 || !values.every((value) => typeof value === "string" && value)) {
          errors.push(`${prefix}.${relationshipField} must be non-empty string or list[string]`);
        }
      }
      if (
        (defaultPath.includes("<") || defaultPath.includes("{") || defaultPath.includes("$")) &&
        !record.path_template
      ) {
        errors.push(`${prefix}.path_template required for templated default_path`);
      }
    });
  }

  (model.explicit_special_cases ?? []).forEach((record: JsonObject, index: number) => {
    const prefix = `explicit_special_cases[${index}]`;
    for (const field of [
      "artifact_id",
      "display_name",
      "artifact_type",
      "scope",
      "default_path",
      "docs_yaml_can_override_path",
    ]) {
      if (!(field in record)) errors.push(`${prefix}.${field} missing`);
    }
    const artifactId = record.artifact_id;
    const displayName = record.display_name;
    if (seenIds.has(artifactId)) errors.push(`duplicate artifact_id: ${artifactId}`);
    seenIds.add(artifactId);
    if (seenDisplayNames.has(displayName)) errors.push(`duplicate display_name: ${displayName}`);
    seenDisplayNames.add(displayName);
    if (!artifactTypes.has(record.artifact_type)) {
      errors.push(`${prefix}.artifact_type unknown: ${record.artifact_type}`);
    }
    if (!scopes.has(record.scope)) {
      errors.push(`${prefix}.scope unknown: ${record.scope}`);
    }
    const template = record.path_template;
    const dp = String(record.default_path);
    if ((dp.includes("<") || dp.includes("{") || dp.includes("$")) && !template) {
      errors.push(`${prefix}.path_template required for special-case default_path`);
    }
    if (
      template &&
      typeof template === "object" &&
      (template.aliases_rejected_after_migration ?? []).includes(template.placeholder)
    ) {
      errors.push(`${prefix}.path_template.placeholder uses rejected alias: ${template.placeholder}`);
    }
  });

  return errors;
}

function validateCapabilityReference(reference: JsonObject, model: JsonObject): string[] {
  const errors: string[] = [];
  const validIds = new Set<string>();
  for (const records of Object.values(model.required_artifact_identities) as any[][]) {
    for (const record of records) validIds.add(record.artifact_id);
  }
  for (const record of model.explicit_special_cases as any[]) validIds.add(record.artifact_id);
  const validRoles = new Set<string>(model.owned_enums.local_usage_role);

  const artifactId = reference.artifact_id;
  const localRole = reference.local_role;
  if (!validIds.has(artifactId)) errors.push(`capability_reference.artifact_id unknown: ${artifactId}`);
  if (!("local_role" in reference)) {
    errors.push("capability_reference.local_role missing");
  } else if (!validRoles.has(localRole)) {
    errors.push(`capability_reference.local_role unsupported: ${localRole}`);
  }
  for (const forbidden of model.capability_local_reference_shape.forbidden_repetition as string[]) {
    const field = forbidden.replace(/^canonical /, "").replace(/ /g, "_");
    if (field in reference) errors.push(`capability_reference.${field} repeats canonical registry fact`);
  }
  return errors;
}

function capabilityArtifactEntries(): Record<string, JsonObject[]> {
  const entriesByCapability: Record<string, JsonObject[]> = {};
  const capDirs = fs.existsSync(CAPABILITY_DIR) ? fs.readdirSync(CAPABILITY_DIR).sort() : [];
  for (const cap of capDirs) {
    const p = path.join(CAPABILITY_DIR, cap, "schemas", "artifacts.yaml");
    if (!fs.existsSync(p)) continue;
    const data = loadYaml(p);
    const artifacts = data.ARTIFACTS;
    expect(artifacts, `${p} missing ARTIFACTS`).toBeTruthy();
    entriesByCapability[cap] = Object.values(artifacts);
  }
  return entriesByCapability;
}

function validateCapabilityArtifactEntries(model: JsonObject): string[] {
  const errors: string[] = [];
  for (const [capability, entries] of Object.entries(capabilityArtifactEntries())) {
    for (const entry of entries) {
      const entryId = entry.id ?? "<missing id>";
      const prefix = `${capability}.${entryId}`;
      for (const error of validateCapabilityReference(entry, model)) {
        errors.push(`${prefix}: ${error}`);
      }
      for (const legacyField of ["name", "path", "produces", "consumes"]) {
        if (legacyField in entry) errors.push(`${prefix}: legacy artifact field remains: ${legacyField}`);
      }
    }
  }
  return errors;
}

function validateDocsMappingOverrides(docs: JsonObject, model: JsonObject): string[] {
  const errors: string[] = [];
  const knownNames = knownDisplayNames(model);
  const forbiddenCanonicalFields = new Set([
    "artifact_id",
    "display_name",
    "default_path",
    "consumers",
    "artifact_type",
    "scope",
    "path_template",
  ]);
  (docs.mapping ?? []).forEach((mapping: any, index: number) => {
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      errors.push(`mapping[${index}] must be an object`);
      return;
    }
    const extra = Object.keys(mapping).filter((k) => forbiddenCanonicalFields.has(k));
    if (extra.length > 0) {
      errors.push(`mapping[${index}] defines canonical registry fields: ${extra.sort().join(", ")}`);
    }
    if (knownNames.has(mapping.artifact) && !mapping.path) {
      errors.push(`mapping[${index}] known artifact override missing path`);
    }
  });
  return errors;
}

describe("artifact registry contract", () => {
  it("validates current model and canonical schema metadata", () => {
    expect(validateRegistryContract(modelFixture(), artifactSchemaMetas())).toEqual([]);
  });

  it("reports invalid ids and unsupported special cases clearly", () => {
    const malformed = structuredClone(modelFixture());
    malformed.required_artifact_identities.project_root[0].artifact_id = "ghost";
    malformed.explicit_special_cases[0].artifact_type = "runtime_config";
    malformed.explicit_special_cases[2].path_template.placeholder = "<objective-name>";

    const errors = validateRegistryContract(malformed, artifactSchemaMetas());
    expect(errors).toContain(
      "required_artifact_identities.project_root[0].artifact_id unknown artifact schema: ghost",
    );
    expect(errors).toContain("explicit_special_cases[0].artifact_type unknown: runtime_config");
    expect(errors).toContain(
      "explicit_special_cases[2].path_template.placeholder uses rejected alias: <objective-name>",
    );
  });

  it("rejects invalid ids, missing roles, and repeated registry facts in capability references", () => {
    const model = modelFixture();
    expect(validateCapabilityReference({ artifact_id: "ghost", display_name: "PLAN.md" }, model)).toEqual([
      "capability_reference.artifact_id unknown: ghost",
      "capability_reference.local_role missing",
      "capability_reference.display_name repeats canonical registry fact",
    ]);

    const validId = model.required_artifact_identities.project_agent_state[0].artifact_id;
    expect(validateCapabilityReference({ artifact_id: validId, local_role: "consumes" }, model)).toEqual([]);
    expect(validateCapabilityReference({ artifact_id: validId, local_role: "observes" }, model)).toEqual([
      "capability_reference.local_role unsupported: observes",
    ]);
  });

  it("capability artifact schemas use registry references for local usage", () => {
    expect(validateCapabilityArtifactEntries(modelFixture())).toEqual([]);
  });

  it("docs.yaml mapping remains runtime override data not canonical registry definition", () => {
    const model = modelFixture();
    const docs = loadYaml(DOCS_PATH);
    expect(validateDocsMappingOverrides(docs, model)).toEqual([]);

    const unknownRuntime = structuredClone(docs);
    unknownRuntime.mapping.push({ artifact: "EXTRA.md", path: "notes/EXTRA.md" });
    expect(validateDocsMappingOverrides(unknownRuntime, model)).toEqual([]);

    const canonical = structuredClone(docs);
    canonical.mapping[0].artifact_id = "vision";
    canonical.mapping[0].scope = "project_agent_state";
    const errors = validateDocsMappingOverrides(canonical, model);
    expect(errors).toContain("mapping[0] defines canonical registry fields: artifact_id, scope");
  });
});

describe("artifact registry module", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("warns and returns {} for corrupt docs.yaml", () => {
    fs.mkdirSync(path.join(tmp, ".agentera"));
    fs.writeFileSync(path.join(tmp, ".agentera", "docs.yaml"), "not: [valid\n yaml");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const overrides = loadDocsPathOverrides(tmp);
    const written = spy.mock.calls.map((c) => String(c[0])).join("");
    spy.mockRestore();
    expect(overrides).toEqual({});
    expect(written).toContain("warning: failed to load docs path overrides");
  });

  it("loads the real registry and resolves a project-relative artifact path", () => {
    const records = loadArtifactRegistry();
    expect(records.size).toBeGreaterThan(0);
    // PLAN.md is a canonical project_agent_state artifact.
    const plan = [...records.values()].find((r) => r.displayName === "PLAN.md");
    expect(plan).toBeTruthy();
    const resolved = resolveArtifactPath(plan!, REPO_ROOT);
    expect(resolved.startsWith(REPO_ROOT)).toBe(true);
  });
});

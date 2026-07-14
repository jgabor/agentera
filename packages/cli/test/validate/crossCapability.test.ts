import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadCanonicalArtifacts,
  validateGraph,
} from "../../src/validate/crossCapability.js";
import { EXPECTED_ARTIFACT_SCHEMA_VERSION } from "../../src/registries/artifactRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REGISTRY_MODEL = path.join(REPO_ROOT, "references", "artifacts", "artifact-registry-interface-model.yaml");

function writeYaml(p: string, data: any): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, YAML.stringify(data));
}

/** Build a minimal registry model containing exactly the required identities
 *  under test. Synthetic tests pass this model into `validateGraph` so absent
 *  unrelated identities (e.g. the full production set) don't fan out
 *  "no matching schema file" warnings. */
function minimalRegistryModel(
  identities: { artifact_id: string; display_name: string; default_path: string }[],
): any {
  return {
    interface: "ArtifactRegistry",
    status: "design_contract",
    required_artifact_identities: { project_agent_state: identities },
    explicit_special_cases: [],
  };
}

function schemaMeta(artifactId: string, p: string, producer: string, consumers: string[]): any {
  return {
    meta: {
      name: artifactId,
      version: EXPECTED_ARTIFACT_SCHEMA_VERSION,
      path: p,
      producer,
      consumers,
      artifact_type: "agent_facing",
    },
  };
}

function capabilityArtifact(artifactId: string, localRole: string): any {
  return {
    ARTIFACTS: {
      1: {
        id: `${artifactId}-${localRole}`,
        artifact_id: artifactId,
        local_role: localRole,
      },
    },
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-graph-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("validateGraph", () => {
  it("the repository cross-capability graph is valid", () => {
    expect(validateGraph()).toEqual([]);
  });

  it("validates capability relationships from registry records", () => {
    const schemas = path.join(tmp, "schemas");
    const caps = path.join(tmp, "capabilities");
    const model = path.join(tmp, "model.yaml");
    writeYaml(model, minimalRegistryModel([
      { artifact_id: "plan", display_name: "PLAN.md", default_path: ".agentera/plan.yaml" },
    ]));
    writeYaml(path.join(schemas, "plan.yaml"), schemaMeta("plan", ".agentera/plan.yaml", "plan", ["build"]));
    writeYaml(path.join(caps, "plan", "schemas", "artifacts.yaml"), capabilityArtifact("plan", "produces"));
    writeYaml(path.join(caps, "build", "schemas", "artifacts.yaml"), capabilityArtifact("plan", "consumes"));

    expect(validateGraph(schemas, caps, model)).toEqual([]);
  });

  it("reports a producer mismatch", () => {
    const schemas = path.join(tmp, "schemas");
    const caps = path.join(tmp, "capabilities");
    const model = path.join(tmp, "model.yaml");
    writeYaml(model, minimalRegistryModel([
      { artifact_id: "health", display_name: "HEALTH.md", default_path: ".agentera/health.yaml" },
    ]));
    writeYaml(path.join(schemas, "health.yaml"), schemaMeta("health", ".agentera/health.yaml", "audit", ["build"]));
    writeYaml(path.join(caps, "audit", "schemas", "artifacts.yaml"), capabilityArtifact("health", "consumes"));
    writeYaml(
      path.join(caps, "build", "schemas", "artifacts.yaml"),
      capabilityArtifact("health", "produces_and_consumes"),
    );

    const errors = validateGraph(schemas, caps, model);
    expect(errors.some((e) => e.includes("producers"))).toBe(true);
  });

  it("reports an unknown artifact_id without a display-name translation map", () => {
    const schemas = path.join(tmp, "schemas");
    const caps = path.join(tmp, "capabilities");
    const model = path.join(tmp, "model.yaml");
    writeYaml(model, minimalRegistryModel([
      { artifact_id: "plan", display_name: "PLAN.md", default_path: ".agentera/plan.yaml" },
    ]));
    writeYaml(path.join(schemas, "plan.yaml"), schemaMeta("plan", ".agentera/plan.yaml", "plan", ["build"]));
    writeYaml(path.join(caps, "plan", "schemas", "artifacts.yaml"), capabilityArtifact("ghost", "produces"));

    expect(validateGraph(schemas, caps, model)).toContain("plan: unknown artifact_id 'ghost'");
  });

  it("loads special cases from the registry not validator-local exceptions", () => {
    const model = YAML.parse(fs.readFileSync(REGISTRY_MODEL, "utf8"));
    const specialCaseIds = new Set<string>(
      (model.explicit_special_cases as any[])
        .filter((record) => ["global_user_state", "archive", "local_harness"].includes(record.artifact_type))
        .map((record) => record.artifact_id),
    );
    const canonical = loadCanonicalArtifacts();
    for (const id of specialCaseIds) {
      expect(canonical.has(id), `canonical missing special case ${id}`).toBe(true);
    }
  });
});

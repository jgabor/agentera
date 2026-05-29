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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REGISTRY_MODEL = path.join(REPO_ROOT, "references", "artifacts", "artifact-registry-interface-model.yaml");

function writeYaml(p: string, data: any): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, YAML.stringify(data));
}

function schemaMeta(artifactId: string, p: string, producer: string, consumers: string[]): any {
  return {
    meta: {
      name: artifactId,
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
    writeYaml(path.join(schemas, "plan.yaml"), schemaMeta("plan", ".agentera/plan.yaml", "planera", ["realisera"]));
    writeYaml(path.join(caps, "planera", "schemas", "artifacts.yaml"), capabilityArtifact("plan", "produces"));
    writeYaml(path.join(caps, "realisera", "schemas", "artifacts.yaml"), capabilityArtifact("plan", "consumes"));

    expect(validateGraph(schemas, caps)).toEqual([]);
  });

  it("reports a producer mismatch", () => {
    const schemas = path.join(tmp, "schemas");
    const caps = path.join(tmp, "capabilities");
    writeYaml(path.join(schemas, "health.yaml"), schemaMeta("health", ".agentera/health.yaml", "inspektera", ["realisera"]));
    writeYaml(path.join(caps, "inspektera", "schemas", "artifacts.yaml"), capabilityArtifact("health", "consumes"));
    writeYaml(
      path.join(caps, "realisera", "schemas", "artifacts.yaml"),
      capabilityArtifact("health", "produces_and_consumes"),
    );

    const errors = validateGraph(schemas, caps);
    expect(errors.some((e) => e.includes("producers"))).toBe(true);
  });

  it("reports an unknown artifact_id without a display-name translation map", () => {
    const schemas = path.join(tmp, "schemas");
    const caps = path.join(tmp, "capabilities");
    writeYaml(path.join(schemas, "plan.yaml"), schemaMeta("plan", ".agentera/plan.yaml", "planera", ["realisera"]));
    writeYaml(path.join(caps, "planera", "schemas", "artifacts.yaml"), capabilityArtifact("ghost", "produces"));

    expect(validateGraph(schemas, caps)).toContain("planera: unknown artifact_id 'ghost'");
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

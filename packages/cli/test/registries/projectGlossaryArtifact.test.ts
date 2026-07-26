import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const MODEL_PATH = path.join(ROOT, "references/artifacts/artifact-registry-interface-model.yaml");
const SCHEMA_PATH = path.join(ROOT, "skills/agentera/schemas/artifacts/glossary.yaml");
const AUTHORITY = "references/artifacts/glossary-entry-contract.yaml";

function load(): { model: any; schema: any } {
  return {
    model: YAML.parse(fs.readFileSync(MODEL_PATH, "utf8")),
    schema: YAML.parse(fs.readFileSync(SCHEMA_PATH, "utf8")),
  };
}

function validateProjectGlossary(model: any, schema: any): string[] {
  const errors: string[] = [];
  const identities = model.required_artifact_identities?.project_agent_state ?? [];
  const identity = identities.find((candidate: any) => candidate.artifact_id === "glossary");
  const profile = (model.explicit_special_cases ?? []).find(
    (candidate: any) => candidate.artifact_id === "profile",
  );

  if (!identity) errors.push("glossary must have project_agent_state scope");
  if (
    identity?.default_path !== ".agentera/glossary.yaml" ||
    schema.meta?.path !== identity?.default_path
  ) {
    errors.push("glossary path must be .agentera/glossary.yaml in registry and schema");
  }
  if (
    profile?.scope !== "global_user_state" ||
    profile?.default_path !== "$AGENTERA_PROFILE_DIR/PROFILE.md" ||
    profile?.docs_yaml_can_override_path !== false
  ) {
    errors.push("profile identity must remain isolated global user state");
  }
  if (
    schema.meta?.producer !== "build" ||
    schema.CONFORMANCE?.authority !== AUTHORITY ||
    schema.CONFORMANCE?.ownership_contract !== "project"
  ) {
    errors.push("glossary must derive project ownership from the shared authority");
  }
  if (schema.CONFORMANCE?.provenance_variant !== "project_file") {
    errors.push("glossary must use project_file provenance");
  }
  if (schema.meta?.implementation_status !== "active") {
    errors.push("glossary producer and confirmed-variant guard must be active");
  }
  return errors;
}

describe("project glossary artifact conformance", () => {
  it("conforms to project identity, build ownership, provenance, and active publication", () => {
    const { model, schema } = load();
    expect(validateProjectGlossary(model, schema)).toEqual([]);
  });

  it.each([
    [
      "scope",
      (model: any) => {
        model.required_artifact_identities.project_agent_state =
          model.required_artifact_identities.project_agent_state.filter(
            (record: any) => record.artifact_id !== "glossary",
          );
      },
      "glossary must have project_agent_state scope",
    ],
    [
      "path",
      (_model: any, schema: any) => {
        schema.meta.path = "GLOSSARY.md";
      },
      "glossary path must be .agentera/glossary.yaml in registry and schema",
    ],
    [
      "profile isolation",
      (model: any) => {
        model.explicit_special_cases.find(
          (record: any) => record.artifact_id === "profile",
        ).docs_yaml_can_override_path = true;
      },
      "profile identity must remain isolated global user state",
    ],
    [
      "ownership",
      (_model: any, schema: any) => {
        schema.CONFORMANCE.ownership_contract = "personal";
      },
      "glossary must derive project ownership from the shared authority",
    ],
    [
      "provenance",
      (_model: any, schema: any) => {
        schema.CONFORMANCE.provenance_variant = "personal_inferred_usage";
      },
      "glossary must use project_file provenance",
    ],
    [
      "publication status",
      (_model: any, schema: any) => {
        schema.meta.implementation_status = "declared_deferred";
      },
      "glossary producer and confirmed-variant guard must be active",
    ],
  ])("rejects invalid %s", (_name, mutate, expected) => {
    const { model, schema } = load();
    mutate(model, schema);
    expect(validateProjectGlossary(model, schema)).toContain(expected);
  });
});

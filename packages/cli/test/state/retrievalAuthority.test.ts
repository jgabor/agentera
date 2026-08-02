import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  loadStateRetrievalAuthority,
  STATE_RETRIEVAL_AUTHORITY_PATH,
  validateExperimentPublicationParity,
  validateStateRetrievalAuthority,
} from "../../src/state/retrievalAuthority.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function authority(): Record<string, any> {
  return YAML.parse(fs.readFileSync(path.join(REPO_ROOT, STATE_RETRIEVAL_AUTHORITY_PATH), "utf8"));
}

describe("canonical state retrieval authority", () => {
  it("loads one canonical public projection with unique policy in the same model", () => {
    const value = authority();
    expect(validateStateRetrievalAuthority(value)).toEqual([]);
    expect(value).not.toHaveProperty("retrieval");
    expect(value.historical_retrieval_evidence).toMatchObject({
      status: "retired_historical_evidence",
      runtime_consumption: "forbidden",
    });
    expect(value.historical_retrieval_evidence).not.toHaveProperty("commands");
    expect(value.historical_retrieval_evidence).not.toHaveProperty("identity");

    const loaded = loadStateRetrievalAuthority(REPO_ROOT);
    expect(loaded.authority).toBe(STATE_RETRIEVAL_AUTHORITY_PATH);
    expect(loaded.retrieval).toEqual(value.entity_target.public_retrieval);
    expect(loaded.retrieval).toMatchObject({
      schema_version: "agentera.entityPublicRetrieval.v1",
      status: "final",
      policy: {
        schema_version: "agentera.entityPublicRetrievalPolicy.v1",
        output_bounds: { maximum_limit: 100, max_serialized_utf8_bytes: 32_768 },
        failures: { schema_version: "agentera.stateFailure.v1" },
        archive_policy: {
          plan: { owner: "canonical_plan_entities_and_immutable_plan_archive_entities" },
          experiments: { owner: "experiment_archival" },
        },
      },
    });
  });

  it.each([
    ["root duplicate", (value: any) => { value.retrieval = { commands: { plans: { list: "contradiction" } } }; }, "duplicate_active_map"],
    ["historical commands", (value: any) => { value.historical_retrieval_evidence.commands = { plans: {} }; }, "historical_retrieval_evidence.commands"],
    ["historical identity", (value: any) => { value.historical_retrieval_evidence.identity = { plan: {} }; }, "historical_retrieval_evidence.identity"],
    ["plan filters", (value: any) => { value.entity_target.public_retrieval.list_help.families.plans.filters = []; }, "plans.filters.runtime_parity"],
    ["plan command filter", (value: any) => { value.entity_target.public_retrieval.commands.plans.list = "agentera state plan list [--limit N] [--cursor TOKEN] [--ids-only | --fields FIELDS] --format json"; }, "plans.list_command"],
    ["experiment exact get", (value: any) => { value.entity_target.public_retrieval.commands.experiments.get = "agentera state experiments get --objective ID --id ID --format json"; }, "experiments.get_command"],
    ["composite IDs", (value: any) => { value.entity_target.identity.accepted_pattern = "^plan:[a-z]{10}$"; }, "identity.accepted_pattern"],
  ])("fails closed when a second map or canonical grammar can contradict %s", (_name, mutate, expected) => {
    const value = authority();
    mutate(value);
    expect(validateStateRetrievalAuthority(value).some((error) => error.includes(expected))).toBe(true);
  });

  it.each([
    ["policy schema", (value: any) => { value.entity_target.public_retrieval.policy.schema_version = "wrong"; }, "policy.schema_version"],
    ["minimum TODO identity", (value: any) => { value.entity_target.public_retrieval.policy.envelope.bounded_summary_projection.family_minimum_fields.todo = []; }, "family_minimum_fields.todo"],
    ["degradation metadata", (value: any) => { value.entity_target.public_retrieval.policy.envelope.bounded_summary_projection.optional_detail_degradation.required_metadata = ["reason"]; }, "required_metadata.omitted_fields"],
    ["row loss", (value: any) => { value.entity_target.public_retrieval.policy.output_bounds.row_omission_under_byte_pressure = "allowed"; }, "row_omission_under_byte_pressure"],
    ["byte bound", (value: any) => { value.entity_target.public_retrieval.policy.output_bounds.max_serialized_utf8_bytes = 1; }, "max_serialized_utf8_bytes"],
    ["failure class", (value: any) => { delete value.entity_target.public_retrieval.policy.failures.classes.unsupported_state; }, "failures.classes.unsupported_state"],
    ["plan archive owner", (value: any) => { delete value.entity_target.public_retrieval.policy.archive_policy.plan.owner; }, "archive_policy.plan.owner"],
  ])("rejects malformed unique policy: %s", (_name, mutate, expected) => {
    const value = authority();
    mutate(value);
    expect(validateStateRetrievalAuthority(value).some((error) => error.includes(expected))).toBe(true);
  });

  it("binds experiment archive policy to its owning archive contract without a second command grammar", () => {
    const value = authority();
    expect(validateExperimentPublicationParity(value)).toEqual([]);
    value.entity_target.public_retrieval.policy.archive_policy.experiments.storage_scope = "project_archive";
    expect(validateExperimentPublicationParity(value)).toContain(
      "entity_target.public_retrieval.policy.archive_policy.experiments.storage_scope",
    );
  });
});

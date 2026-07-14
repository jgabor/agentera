import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  loadStateRetrievalAuthority,
  STATE_RETRIEVAL_AUTHORITY_PATH,
  validateStateRetrievalAuthority,
} from "../../src/state/retrievalAuthority.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function authority(): Record<string, any> {
  return YAML.parse(fs.readFileSync(path.join(REPO_ROOT, STATE_RETRIEVAL_AUTHORITY_PATH), "utf8"));
}

function invalid(mutator: (value: Record<string, any>) => void): string[] {
  const value = structuredClone(authority());
  mutator(value);
  return validateStateRetrievalAuthority(value);
}

describe("state retrieval authority", () => {
  it("loads the valid authority as the executable retrieval source", () => {
    expect(validateStateRetrievalAuthority(authority())).toEqual([]);
    const loaded = loadStateRetrievalAuthority(REPO_ROOT);
    expect(loaded.authority).toBe(STATE_RETRIEVAL_AUTHORITY_PATH);
    expect(loaded.retrieval.schema_version).toBe("agentera.stateRetrievalAuthority.v1");
  });

  it.each([
    "growth",
    "identity",
    "storage_ownership",
    "ordering",
    "bounds",
    "cursor",
    "omission",
    "get",
  ])("rejects a collection without explicit %s behavior", (field) => {
    expect(invalid((value) => delete value.retrieval.collections[0][field])).toContain(
      `retrieval.collections[0].${field}`,
    );
  });

  it("rejects missing or duplicate state collection classifications", () => {
    expect(invalid((value) => value.retrieval.collections.pop())).toContain(
      "retrieval.collections.missing.changelog.entries",
    );
    expect(
      invalid((value) => value.retrieval.collections.push(structuredClone(value.retrieval.collections[0]))),
    ).toContain("retrieval.collections.duplicate_collection_id");
  });

  it.each([
    ["plan_tasks", "list"],
    ["plan_tasks", "get"],
    ["plans", "list"],
    ["plans", "get"],
    ["experiments", "list"],
    ["experiments", "get"],
  ])("rejects drift in %s %s grammar", (command, verb) => {
    expect(invalid((value) => value.retrieval.commands[command][verb] = "agentera invalid")).toContain(
      `retrieval.commands.${command}.${verb}`,
    );
  });

  it("accepts experiment zero and rejects negative, padded, or fractional selectors", () => {
    const pattern = new RegExp(authority().retrieval.commands.experiments.selectors.number.pattern);
    expect(["0", "1", "42"].every((value) => pattern.test(value))).toBe(true);
    expect(["-1", "01", "1.0"].every((value) => !pattern.test(value))).toBe(true);
    expect(
      invalid((value) => value.retrieval.commands.experiments.selectors.number.pattern = "^[1-9][0-9]*$"),
    ).toContain("retrieval.commands.experiments.selectors.number.accepted_examples");
  });

  it("requires objective scope and positive task selectors", () => {
    expect(
      invalid((value) => value.retrieval.commands.experiments.selectors.objective.list_required = false),
    ).toContain("retrieval.commands.experiments.selectors.objective.required");
    expect(
      invalid((value) => value.retrieval.commands.plan_tasks.selectors.task.pattern = "^[0-9]+$"),
    ).toContain("retrieval.commands.plan_tasks.selectors.task.rejected_examples");
    expect(
      invalid((value) => value.retrieval.commands.plan_tasks.selectors.plan.pattern = "^plan:[0-9a-f-]+$"),
    ).toContain("retrieval.commands.plan_tasks.selectors.plan.rejected_examples");
    expect(
      invalid((value) => value.retrieval.commands.plans.selectors.plan.get_required = false),
    ).toContain("retrieval.commands.plans.selectors.plan.get_required");
    expect(
      invalid((value) => value.retrieval.commands.experiments.selectors.objective.pattern = "^objective:.*$"),
    ).toContain("retrieval.commands.experiments.selectors.objective.rejected_examples");
  });

  it("publishes deterministic legacy identity and collision examples without rewriting history", () => {
    const identities = authority().retrieval.identity;
    const plan = identities.plan.test_vectors[0];
    const objective = identities.objective.test_vectors[0];
    expect(`legacy-plan:${createHash("sha256").update(plan.canonical_json).digest("hex")}`).toBe(plan.stable_id);
    expect(`legacy-objective:${createHash("sha256").update(objective.canonical_json).digest("hex")}`).toBe(objective.stable_id);
    expect(plan.identical_result).toBe("mirrored_provenance");
    expect(objective.root_variants).toEqual([
      ".agentera/optimize/cli-latency",
      ".agentera/optimera/faster-cli",
    ]);
    expect(invalid((value) => delete value.retrieval.identity.plan.test_vectors)).toContain(
      "retrieval.identity.plan.test_vectors",
    );
    expect(invalid((value) => delete value.retrieval.identity.objective.test_vectors)).toContain(
      "retrieval.identity.objective.test_vectors",
    );
    expect(
      invalid((value) => value.retrieval.identity.plan.test_vectors[0].stable_id = "legacy-plan:wrong"),
    ).toContain("retrieval.identity.plan.test_vectors[0].stable_id");
    expect(
      invalid((value) => value.retrieval.identity.objective.test_vectors[0].canonical_json = "{"),
    ).toEqual(expect.arrayContaining([
      "retrieval.identity.objective.test_vectors[0].canonical_json",
      "retrieval.identity.objective.test_vectors[0].stable_id",
    ]));
  });

  it.each(["omitted", "omitted_count", "omission_reason", "retrieval"])(
    "rejects omission envelopes without %s",
    (field) => {
      expect(
        invalid((value) => value.retrieval.omission.required_when_any_entry_is_not_returned =
          value.retrieval.omission.required_when_any_entry_is_not_returned.filter((item: string) => item !== field)),
      ).toContain(`retrieval.omission.required_when_any_entry_is_not_returned.${field}`);
    },
  );

  it.each(["vocabulary", "response_field", "binding", "invalid_behavior", "unavailable_behavior"])(
    "rejects cursor vocabulary without %s",
    (field) => {
      expect(invalid((value) => delete value.retrieval.cursor[field])).toContain(`retrieval.cursor.${field}`);
    },
  );

  it.each(["class", "message", "syntax", "example", "recovery"])(
    "rejects a structured error without required field %s",
    (field) => {
      expect(
        invalid((value) => value.retrieval.failures.required_fields =
          value.retrieval.failures.required_fields.filter((item: string) => item !== field)),
      ).toContain(`retrieval.failures.required_fields.${field}`);
    },
  );

  it.each([
    "invalid_request",
    "unsupported_artifact",
    "not_found",
    "ambiguous",
    "corrupt",
    "incomplete",
    "cursor_invalid",
    "cursor_snapshot_unavailable",
    "unsupported_state",
  ])("rejects a missing structured failure class %s", (failureClass) => {
    expect(invalid((value) => delete value.retrieval.failures.classes[failureClass])).toContain(
      `retrieval.failures.classes.${failureClass}`,
    );
  });

  it("requires plan and experiment gap evidence plus degraded archive smoke classification", () => {
    expect(invalid((value) => value.retrieval.current_gap_evidence = [])).toEqual(
      expect.arrayContaining([
        "retrieval.current_gap_evidence.plan",
        "retrieval.current_gap_evidence.experiments",
      ]),
    );
    expect(
      invalid((value) => value.retrieval.plan_archive_diagnostics.classification = "fail_all_reads"),
    ).toContain("retrieval.plan_archive_diagnostics.classification");
  });
});

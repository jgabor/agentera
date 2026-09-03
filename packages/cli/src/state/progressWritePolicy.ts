import type { JsonObject } from "../core/jsonValue.js";

const APPEND_GUIDANCE =
  "Append progress only for durable project truth that future work needs, a required glossary_caveat lifecycle event, or a plan-completion sweep. Glossary caveats and plan-completion sweeps require a record; an ordinary build or release attempt with no durable project truth change, and an outcome future work does not need as a milestone, require no progress append.";

const RECEIPT_GUIDANCE = "Qualification and publication receipts own timings, integrity, digests, retries, and replay; do not duplicate receipt detail in progress.";

const PROGRESS_WRITE_POLICY: JsonObject = {
  schemaVersion: "agentera.progressWritePolicy.v1",
  append: {
    mode: "conditional",
    allowed_when: ["durable_project_truth_needed_by_future_work", "required_glossary_caveat", "plan_completion_sweep"],
    required_when: ["required_glossary_caveat", "plan_completion_sweep"],
    no_append_required_when: ["ordinary_build_or_release_attempt_without_durable_project_truth_change", "durable_outcome_not_needed_by_future_work"],
    guidance: APPEND_GUIDANCE,
  },
  receipt_detail: {
    owners: ["qualification_receipt", "publication_receipt"],
    fields: ["timings", "integrity", "digests", "retries", "replay"],
    guidance: RECEIPT_GUIDANCE,
  },
};

export function progressWritePolicy(): JsonObject {
  return structuredClone(PROGRESS_WRITE_POLICY);
}

export function progressWriteGuidance(): string[] {
  return [APPEND_GUIDANCE, RECEIPT_GUIDANCE];
}

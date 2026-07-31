import { glossaryCaveatContract } from "../../registries/glossaryCaveatContract.js";
import { loadTodoReadinessContract } from "../../registries/todoReadinessContract.js";

export const RUNTIME_WRITABLE_ARTIFACTS = [
  "progress", "decisions", "plan", "health", "objective", "experiments", "todo", "docs", "glossary",
] as const;
export type RuntimeWritableArtifact = (typeof RUNTIME_WRITABLE_ARTIFACTS)[number];

export type RuntimeFieldKind = "string" | "integer" | "string_list" | "integer_list" | "date" | "datetime";

export interface RuntimeOperationField {
  flag: string;
  field: string;
  kind: RuntimeFieldKind;
  required?: boolean;
  repeatable?: boolean;
  validValues?: string[];
  validValuesSource?: string;
  description?: string;
}

export interface RuntimeOperationSpec {
  artifact: RuntimeWritableArtifact;
  verb: Exclude<RuntimeWriteVerb, "explain">;
  selectors: string[];
  fields: RuntimeOperationField[];
  ownedFields: string[];
  inputMode: "none" | "structured" | "flags_until_conversion";
  inputRoot?: string;
  inputSources: string[];
  structuredInputSources: string[];
  cliOwnedFields: string[];
  inputMaxBytes: number;
  allowForce: boolean;
  compacts: boolean;
}

export const RUNTIME_WRITE_VERBS = [
  "append", "update", "amend", "set-status", "supersede", "set-plan-status",
  "record-evaluation", "archive", "create", "publish", "resolve", "explain",
] as const;
export type RuntimeWriteVerb = (typeof RUNTIME_WRITE_VERBS)[number];

const caveat = glossaryCaveatContract();
const readiness = loadTodoReadinessContract();

const f = (
  flag: string,
  field: string,
  kind: RuntimeFieldKind,
  options: Omit<RuntimeOperationField, "flag" | "field" | "kind"> = {},
): RuntimeOperationField => ({ flag, field, kind, required: false, ...options });

const todoReadinessFields: RuntimeOperationField[] = [
  f("--capability", "readiness.capability", "string", { validValues: readiness.allowedDestinations, validValuesSource: "todo_readiness.allowed_destinations", description: "Reviewer-approved capability that owns the next action." }),
  f("--reason", "readiness.reason", "string", { description: "Durable intent explaining why the destination is correct." }),
  f("--dependency", "readiness.dependencies", "string_list", { repeatable: true, description: "Bare ten-letter canonical TODO prerequisite ID; repeat for each dependency." }),
  f("--blocked-reason", "readiness.blocked.reason", "string", { description: "Explicit blocker reason; requires --blocked-recovery." }),
  f("--blocked-recovery", "readiness.blocked.recovery", "string", { description: "Bounded action that clears the declared blocker; requires --blocked-reason." }),
  f("--gate-state", "readiness.gate.state", "string", { validValues: ["pending", "satisfied"], description: "Declared external or approval gate state." }),
  f("--gate-reason", "readiness.gate.reason", "string", { description: "Reason for the declared gate." }),
  f("--gate-recovery", "readiness.gate.recovery", "string", { description: "Bounded action for the declared gate." }),
  f("--queue-rank", "readiness.queue_rank", "integer", { description: "Reviewer-assigned intent order within severity; lower values run first." }),
  f("--order-reason", "readiness.order_reason", "string", { description: "Durable reason for the queue rank." }),
];

const progressFields: RuntimeOperationField[] = [
  f("--type", "type", "string", { required: true, validValues: ["feat", "fix", "docs", "refactor", "chore", "test"] }),
  f("--phase", "phase", "string", { required: true, validValues: ["envision", "deliberate", "plan", "build", "audit"] }),
  f("--what", "what", "string", { required: true }),
  f("--intent", "context.intent", "string", { required: true }),
  f("--timestamp", "timestamp", "datetime", { required: false }),
  f("--glossary-caveat-event", "glossary_caveat.event", "string", { validValues: caveat.events, validValuesSource: "glossary_caveat.events" }),
  f("--glossary-caveat-reason", "glossary_caveat.reason", "string", { validValues: caveat.reasons, validValuesSource: "glossary_caveat.reasons" }),
  f("--glossary-caveat-ownership-state", "glossary_caveat.ownership_state", "string", { validValues: caveat.ownershipStates, validValuesSource: "glossary_caveat.ownershipStates" }),
  f("--glossary-caveat-id", "glossary_caveat.caveat_id", "string"),
  f("--glossary-caveat-transition-id", "glossary_caveat.transition_id", "string"),
  f("--inspiration", "inspiration", "string"), f("--discovered", "discovered", "string"),
  f("--verified", "verified", "string"), f("--next", "next", "string"),
  f("--constraints", "context.constraints", "string"), f("--unknowns", "context.unknowns", "string"), f("--scope", "context.scope", "string"),
];

const decisionAppendFields: RuntimeOperationField[] = [
  f("--question", "question", "string", { required: true }),
  f("--context", "context", "string", { required: true }),
  f("--alternative-chosen", "alternatives.chosen", "string", { required: true }),
  f("--alternative-rejected", "alternatives.rejected", "string_list", { repeatable: true }),
  f("--choice", "choice", "string", { required: true }),
  f("--reasoning", "reasoning", "string", { required: true }),
  f("--confidence", "confidence", "string", { required: true, validValues: ["firm", "provisional", "exploratory"] }),
  f("--feeds-into", "feeds_into", "string"), f("--date", "date", "date", { required: false }),
];

const decisionAmendFields: RuntimeOperationField[] = [
  f("--id", "id", "string", { required: true }), f("--base-sha256", "base_sha256", "string", { required: true }),
  f("--question", "question", "string", { required: false }), f("--context", "context", "string", { required: false }),
  f("--alternative-chosen", "alternatives.chosen", "string", { required: false }),
  f("--alternative-rejected", "alternatives.rejected", "string_list", { repeatable: true, required: false }),
  f("--choice", "choice", "string", { required: false }), f("--reasoning", "reasoning", "string", { required: false }),
  f("--confidence", "confidence", "string", { required: false, validValues: ["firm", "provisional", "exploratory"] }),
  f("--feeds-into", "feeds_into", "string", { required: false }),
];

const taskContentFields: RuntimeOperationField[] = [
  f("--name", "name", "string", { required: true }),
  f("--depends-on", "depends_on", "string_list", { repeatable: true }),
  f("--acceptance", "acceptance", "string_list", { repeatable: true }),
  f("--status", "status", "string", { validValues: ["complete", "in_progress", "pending", "blocked"], description: "Task execution status. Does not change the plan lifecycle." }),
];

const planAppendFields: RuntimeOperationField[] = [f("--plan", "plan", "string"), ...taskContentFields];

const planUpdateFields: RuntimeOperationField[] = [
  f("--id", "id", "string", { required: true }), f("--plan", "plan", "string"),
  ...taskContentFields.filter((field) => field.field !== "status").map((field) => ({ ...field, required: false })),
  f("--evidence", "evidence", "string"), f("--blocked-reason", "blocked_reason", "string"), f("--surprise", "surprise", "string"),
];

const planEvaluationFields: RuntimeOperationField[] = [
  f("--id", "id", "string", { required: true }), f("--plan", "plan", "string"),
  f("--attempt-id", "evaluation.attempt_id", "string", { required: true }),
  f("--verdict", "evaluation.verdict", "string", { required: true, validValues: ["pass", "fail"], description: "Evaluator verdict for this idempotent attempt." }),
  f("--failure-evidence", "evaluation.failure_evidence", "string"), f("--provenance", "evaluation.provenance", "string", { required: true, description: "Stable source reference for the evaluator result." }),
];

const op = (
  artifact: RuntimeWritableArtifact,
  verb: Exclude<RuntimeWriteVerb, "explain">,
  fields: RuntimeOperationField[],
  options: Partial<Omit<RuntimeOperationSpec, "artifact" | "verb" | "fields">> = {},
): RuntimeOperationSpec => ({
  artifact, verb, fields, selectors: [], ownedFields: [], inputMode: "none", inputSources: [], structuredInputSources: [], cliOwnedFields: [], inputMaxBytes: 0, allowForce: false, compacts: false, ...options,
});

const RUNTIME_OPERATIONS: RuntimeOperationSpec[] = [
  op("progress", "append", progressFields, { ownedFields: ["id", "artifact", "publication_order"], inputMode: "flags_until_conversion", inputSources: ["flags"], cliOwnedFields: ["id", "artifact", "publication_order"], compacts: true }),
  op("decisions", "append", decisionAppendFields, { ownedFields: ["id", "artifact"], inputMode: "flags_until_conversion", inputSources: ["flags"], cliOwnedFields: ["id", "artifact"], compacts: true }),
  op("decisions", "update", [f("--id", "id", "string", { required: true }), f("--satisfaction-state", "satisfaction.state", "string", { required: true, validValues: ["open", "provisionally_satisfied", "user_confirmed_satisfied"] }), f("--satisfaction-evidence", "satisfaction.evidence", "string"), f("--confirmed-by", "satisfaction.user_confirmation.confirmed_by", "string"), f("--confirmed-at", "satisfaction.user_confirmation.confirmed_at", "string")], { selectors: ["--id"], ownedFields: ["id", "artifact", "satisfaction"] }),
  op("decisions", "amend", decisionAmendFields, { selectors: ["--id", "--base-sha256"], ownedFields: ["id", "artifact", "base_sha256"], inputMode: "flags_until_conversion", inputSources: ["flags"], cliOwnedFields: ["id", "artifact", "base_sha256"] }),
  op("plan", "append", planAppendFields, { selectors: ["--plan"], ownedFields: ["id", "artifact", "plan"], inputMode: "flags_until_conversion", inputSources: ["flags"], cliOwnedFields: ["id", "artifact", "plan"] }),
  op("plan", "update", planUpdateFields, { selectors: ["--id", "--plan"], ownedFields: ["id", "artifact", "plan"], inputMode: "flags_until_conversion", inputSources: ["flags"], cliOwnedFields: ["id", "artifact", "plan"] }),
  op("plan", "set-status", [f("--id", "id", "string", { required: true }), f("--plan", "plan", "string"), f("--status", "status", "string", { required: true, validValues: ["complete", "in_progress", "pending", "blocked"], description: "Task execution status. Does not change the plan lifecycle." })], { selectors: ["--id", "--plan"], ownedFields: ["id", "artifact", "plan", "status"] }),
  op("plan", "supersede", [f("--id", "id", "string", { required: true }), f("--plan", "plan", "string"), f("--by", "superseded_by", "string_list", { required: true, repeatable: true }), f("--reason", "superseded_reason", "string", { required: true })], { selectors: ["--id", "--plan"], ownedFields: ["id", "artifact", "plan", "superseded_by", "superseded_reason"] }),
  op("plan", "set-plan-status", [f("--plan", "plan", "string"), f("--status", "status", "string", { required: true, validValues: ["open", "complete"], description: "Plan lifecycle status. Positional activity is derived from location." })], { selectors: ["--plan"], ownedFields: ["id", "artifact", "plan", "header.status"] }),
  op("plan", "record-evaluation", planEvaluationFields, { selectors: ["--id", "--plan"], ownedFields: ["id", "artifact", "plan", "evaluation"] }),
  op("plan", "archive", [f("--plan", "plan", "string")], { selectors: ["--plan"], ownedFields: ["id", "artifact", "plan", "header.status"], allowForce: true }),
  op("plan", "create", [], { ownedFields: ["id", "artifact", "header.id", "previous_plan_archived", "task_ids"], inputMode: "structured", inputRoot: "complete plan document", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "header.id", "previous_plan_archived", "task_ids"], inputMaxBytes: 32768, allowForce: true }),
  op("health", "append", [], { ownedFields: ["id", "artifact", "appended_at"], inputMode: "structured", inputRoot: "one audit entry", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "appended_at"], inputMaxBytes: 32768, compacts: true }),
  op("objective", "create", [], { ownedFields: ["id", "artifact", "header.id"], inputMode: "structured", inputRoot: "one objective document", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "header.id"], inputMaxBytes: 32768 }),
  op("objective", "update", [f("--id", "id", "string", { required: true })], { selectors: ["--id"], ownedFields: ["id", "artifact", "header.id"], inputMode: "structured", inputRoot: "one objective document", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "header.id"], inputMaxBytes: 32768 }),
  op("experiments", "publish", [f("--objective", "objective", "string", { required: true }), f("--id", "id", "string")], { selectors: ["--objective", "--id"], ownedFields: ["id", "artifact", "objective", "archive_identity"], inputMode: "structured", inputRoot: "one experiment entry", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "objective"], inputMaxBytes: 32768, compacts: true }),
  op("todo", "create", [f("--severity", "severity", "string", { required: true, validValues: ["critical", "degraded", "normal", "annoying"] }), f("--description", "description", "string", { required: true }), ...todoReadinessFields], { ownedFields: ["id", "artifact", "status", "public_order"], inputMode: "flags_until_conversion", inputSources: ["flags"], cliOwnedFields: ["id", "artifact", "status", "public_order"] }),
  op("todo", "update", [f("--id", "id", "string", { required: true }), f("--severity", "severity", "string", { validValues: ["critical", "degraded", "normal", "annoying"] }), f("--description", "description", "string"), ...todoReadinessFields], { selectors: ["--id"], ownedFields: ["id", "artifact", "status", "public_order"], inputMode: "flags_until_conversion", inputSources: ["flags"], cliOwnedFields: ["id", "artifact", "status", "public_order"] }),
  op("todo", "resolve", [f("--id", "id", "string", { required: true })], { selectors: ["--id"], ownedFields: ["id", "artifact", "status"] }),
  op("docs", "create", [], { ownedFields: ["id", "artifact"], inputMode: "structured", inputRoot: "one documentation inventory entry", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact"], inputMaxBytes: 32768 }),
  op("docs", "update", [f("--id", "id", "string", { required: true })], { selectors: ["--id"], ownedFields: ["id", "artifact"], inputMode: "structured", inputRoot: "one documentation inventory entry", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact"], inputMaxBytes: 32768 }),
  op("glossary", "publish", [], { ownedFields: ["approval_id", "glossary_entry_id"], inputMode: "structured", inputRoot: "one glossary publication request", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], inputMaxBytes: 32768 }),
];

export function runtimeOperationSpecs(): RuntimeOperationSpec[] {
  return RUNTIME_OPERATIONS.map((spec) => ({ ...spec, fields: spec.fields.map((field) => ({ ...field })) }));
}

export function runtimeOperationSpec(artifact: string, verb: string): RuntimeOperationSpec | null {
  return RUNTIME_OPERATIONS.find((spec) => spec.artifact === artifact && spec.verb === verb) ?? null;
}

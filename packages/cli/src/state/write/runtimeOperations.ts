import { loadTodoReadinessContract } from "../../registries/todoReadinessContract.js";
import { CANONICAL_DEVELOPMENT_CLI } from "../../core/developmentChannel.js";

export const RUNTIME_WRITABLE_ARTIFACTS = [
  "progress", "decisions", "plan", "health", "objective", "experiments", "todo", "docs", "glossary",
] as const;
export type RuntimeWritableArtifact = (typeof RUNTIME_WRITABLE_ARTIFACTS)[number];

export type RuntimeFieldKind = "string" | "boolean" | "integer" | "string_list" | "date" | "datetime";

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

export interface RuntimeOperationProjectionTemplate {
  source: string;
  runtime: string;
}

export interface RuntimeOperationProjectionContract {
  recovery: RuntimeOperationProjectionTemplate;
  examples: RuntimeOperationProjectionTemplate[];
  formatValues: readonly ["text", "json"];
}

export interface RuntimeOperationSpec {
  artifact: RuntimeWritableArtifact;
  verb: Exclude<RuntimeWriteVerb, "explain">;
  selectors: string[];
  fields: RuntimeOperationField[];
  ownedFields: string[];
  inputMode: "none" | "structured" | "flags_until_conversion";
  inputRoot?: string;
  inputOptional?: boolean;
  inputSources: string[];
  structuredInputSources: string[];
  cliOwnedFields: string[];
  inputMaxBytes: number;
  allowForce: boolean;
  compacts: boolean;
  recoveryCommand?: readonly string[];
  projection: RuntimeOperationProjectionContract;
}

export const RUNTIME_WRITE_VERBS = [
  "append", "update", "amend", "set-status", "supersede", "set-plan-status",
  "record-evaluation", "archive", "create", "replace", "publish", "activate", "repair", "correct-owners", "set-severity", "resolve", "reopen", "explain",
] as const;
export type RuntimeWriteVerb = (typeof RUNTIME_WRITE_VERBS)[number];

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

const planEvaluationFields: RuntimeOperationField[] = [
  f("--id", "id", "string", { required: true }), f("--plan", "plan", "string"),
  f("--attempt-id", "evaluation.attempt_id", "string", { required: true }),
  f("--verdict", "evaluation.verdict", "string", { required: true, validValues: ["pass", "fail"], description: "Evaluator verdict for this idempotent attempt." }),
  f("--failure-evidence", "evaluation.failure_evidence", "string"), f("--provenance", "evaluation.provenance", "string", { required: true, description: "Stable source reference for the evaluator result." }),
];

type RuntimeOperationCoreSpec = Omit<RuntimeOperationSpec, "projection">;

const op = (
  artifact: RuntimeWritableArtifact,
  verb: Exclude<RuntimeWriteVerb, "explain">,
  fields: RuntimeOperationField[],
  options: Partial<Omit<RuntimeOperationCoreSpec, "artifact" | "verb" | "fields">> = {},
): RuntimeOperationCoreSpec => ({
  artifact, verb, fields, selectors: [], ownedFields: [], inputMode: "none", inputSources: [], structuredInputSources: [], cliOwnedFields: [], inputMaxBytes: 0, allowForce: false, compacts: false, ...options,
});

const RUNTIME_OPERATION_CORES: RuntimeOperationCoreSpec[] = [
  op("progress", "append", [], { ownedFields: ["id", "artifact", "publication_order"], inputMode: "structured", inputRoot: "one progress cycle record", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "publication_order"], inputMaxBytes: 32768, compacts: true }),
  op("decisions", "append", [], { ownedFields: ["id", "artifact"], inputMode: "structured", inputRoot: "one decision record", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact"], inputMaxBytes: 32768, compacts: true }),
  op("decisions", "update", [f("--id", "id", "string", { required: true }), f("--satisfaction-state", "satisfaction.state", "string", { required: true, validValues: ["open", "provisionally_satisfied", "user_confirmed_satisfied"] }), f("--satisfaction-evidence", "satisfaction.evidence", "string"), f("--confirmed-by", "satisfaction.user_confirmation.confirmed_by", "string"), f("--confirmed-at", "satisfaction.user_confirmation.confirmed_at", "string")], { selectors: ["--id"], ownedFields: ["id", "artifact", "satisfaction"] }),
  op("decisions", "amend", [f("--id", "id", "string", { required: true }), f("--base-sha256", "base_sha256", "string", { required: true })], { selectors: ["--id", "--base-sha256"], ownedFields: ["id", "artifact", "base_sha256"], inputMode: "structured", inputRoot: "amendable decision content", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "base_sha256"], inputMaxBytes: 32768 }),
  op("plan", "append", [f("--plan", "plan", "string")], { selectors: ["--plan"], ownedFields: ["id", "artifact", "plan", "status", "superseded_by", "superseded_reason", "evaluation", "header.status", "header.id", "previous_plan_archived", "task_ids"], inputMode: "structured", inputRoot: "one plan task record", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "plan", "status", "superseded_by", "superseded_reason", "evaluation", "header.status", "header.id", "previous_plan_archived", "task_ids"], inputMaxBytes: 32768 }),
  op("plan", "update", [f("--id", "id", "string", { required: true }), f("--plan", "plan", "string")], { selectors: ["--id", "--plan"], ownedFields: ["id", "artifact", "plan", "status", "superseded_by", "superseded_reason", "evaluation", "header.status", "header.id", "previous_plan_archived", "task_ids"], inputMode: "structured", inputRoot: "plan task patch", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "plan", "status", "superseded_by", "superseded_reason", "evaluation", "header.status", "header.id", "previous_plan_archived", "task_ids"], inputMaxBytes: 32768 }),
  op("plan", "set-status", [f("--id", "id", "string", { required: true }), f("--plan", "plan", "string"), f("--status", "status", "string", { required: true, validValues: ["complete", "in_progress", "pending", "blocked"], description: "Task execution status. Does not change the plan lifecycle." })], { selectors: ["--id", "--plan"], ownedFields: ["id", "artifact", "plan", "status"] }),
  op("plan", "supersede", [f("--id", "id", "string", { required: true }), f("--plan", "plan", "string"), f("--by", "superseded_by", "string_list", { required: true, repeatable: true }), f("--reason", "superseded_reason", "string", { required: true })], { selectors: ["--id", "--plan"], ownedFields: ["id", "artifact", "plan", "superseded_by", "superseded_reason"] }),
  op("plan", "set-plan-status", [f("--plan", "plan", "string"), f("--status", "status", "string", { required: true, validValues: ["open", "complete"], description: "Plan lifecycle status. Positional activity is derived from location." })], { selectors: ["--plan"], ownedFields: ["id", "artifact", "plan", "header.status"] }),
  op("plan", "record-evaluation", planEvaluationFields, { selectors: ["--id", "--plan"], ownedFields: ["id", "artifact", "plan", "evaluation"] }),
  op("plan", "archive", [f("--plan", "plan", "string")], { selectors: ["--plan"], ownedFields: ["id", "artifact", "plan", "header.status"], allowForce: true }),
  op("plan", "create", [], { ownedFields: ["id", "artifact", "header.id", "previous_plan_archived", "task_ids"], inputMode: "structured", inputRoot: "complete plan document", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "header.id", "previous_plan_archived", "task_ids"], inputMaxBytes: 32768, allowForce: true }),
  op("plan", "replace", [f("--predecessor", "predecessor", "string", { required: true, description: "Bare plan ID to archive as the explicit predecessor." }), f("--successor", "successor", "string", { description: "Existing bare open plan ID to retain as the explicit successor." })], { selectors: ["--predecessor", "--successor"], ownedFields: ["id", "artifact", "header.status", "header.id", "previous_plan_archived", "replacement_input_sha256", "task_ids"], inputMode: "structured", inputRoot: "complete plan document when creating a successor", inputOptional: true, inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "header.id", "previous_plan_archived", "replacement_input_sha256", "task_ids"], inputMaxBytes: 32768 }),
  op("health", "append", [], { ownedFields: ["id", "artifact", "appended_at"], inputMode: "structured", inputRoot: "one audit entry", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "appended_at"], inputMaxBytes: 32768, compacts: true, recoveryCommand: ["check", "validate", "state", "--format", "json"] }),
  op("objective", "create", [], { ownedFields: ["id", "artifact", "header.id"], inputMode: "structured", inputRoot: "one objective document", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "header.id"], inputMaxBytes: 32768 }),
  op("objective", "update", [f("--id", "id", "string", { required: true })], { selectors: ["--id"], ownedFields: ["id", "artifact", "header.id"], inputMode: "structured", inputRoot: "one objective document", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "header.id"], inputMaxBytes: 32768 }),
  op("experiments", "publish", [f("--objective", "objective", "string", { required: true }), f("--id", "id", "string")], { selectors: ["--objective", "--id"], ownedFields: ["id", "artifact", "objective", "archive_identity"], inputMode: "structured", inputRoot: "one experiment entry", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "objective"], inputMaxBytes: 32768, compacts: true }),
  op("todo", "activate", [f("--effect-sha256", "effect_sha256", "string"), f("--yes", "confirmed", "boolean")], { ownedFields: ["reconciliation", "public_document", "activation"], compacts: true }),
  op("todo", "repair", [f("--effect-sha256", "effect_sha256", "string"), f("--yes", "confirmed", "boolean")], { ownedFields: ["reconciliation", "public_document", "activation"], compacts: true }),
  op("todo", "correct-owners", [f("--effect-sha256", "effect_sha256", "string"), f("--yes", "confirmed", "boolean")], { ownedFields: ["reconciliation", "public_document", "activation"], inputMode: "structured", inputRoot: "one unsafe TODO owner mapping", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], inputMaxBytes: 32768, compacts: true }),
  op("todo", "create", [], { ownedFields: ["id", "artifact", "status", "public_order", "lifecycle"], inputMode: "structured", inputRoot: "full typed TODO record", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "status", "public_order", "lifecycle"], inputMaxBytes: 32768 }),
  op("todo", "update", [f("--id", "id", "string", { required: true }), f("--effect-sha256", "effect_sha256", "string"), f("--yes", "confirmed", "boolean")], { selectors: ["--id"], ownedFields: ["id", "artifact", "status", "public_order", "lifecycle"], inputMode: "structured", inputRoot: "TODO record patch or agentera.todoUpdateBatch.v1 envelope", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact", "status", "public_order", "lifecycle"], inputMaxBytes: 32768 }),
  op("todo", "set-severity", [f("--id", "id", "string", { required: true }), f("--severity", "severity", "string", { required: true, validValues: ["critical", "degraded", "normal", "annoying"] }), f("--reason", "lifecycle.reason", "string", { required: true }), f("--date", "lifecycle.date", "date", { required: true })], { selectors: ["--id"], ownedFields: ["id", "artifact", "severity", "lifecycle"] }),
  op("todo", "supersede", [f("--id", "id", "string", { required: true }), f("--replacement", "lifecycle.replacement", "string", { required: true }), f("--reason", "lifecycle.reason", "string", { required: true }), f("--date", "lifecycle.date", "date", { required: true })], { selectors: ["--id"], ownedFields: ["id", "artifact", "status", "lifecycle"] }),
  op("todo", "resolve", [f("--id", "id", "string", { required: true }), f("--reason", "lifecycle.reason", "string", { required: true }), f("--date", "lifecycle.date", "date", { required: true })], { selectors: ["--id"], ownedFields: ["id", "artifact", "status", "lifecycle"] }),
  op("todo", "reopen", [f("--id", "id", "string", { required: true }), f("--reason", "lifecycle.reason", "string", { required: true }), f("--date", "lifecycle.date", "date", { required: true })], { selectors: ["--id"], ownedFields: ["id", "artifact", "status", "lifecycle"] }),
  op("docs", "create", [], { ownedFields: ["id", "artifact"], inputMode: "structured", inputRoot: "one documentation inventory entry", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact"], inputMaxBytes: 32768 }),
  op("docs", "update", [f("--id", "id", "string", { required: true })], { selectors: ["--id"], ownedFields: ["id", "artifact"], inputMode: "structured", inputRoot: "one documentation inventory entry", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], cliOwnedFields: ["id", "artifact"], inputMaxBytes: 32768 }),
  op("glossary", "publish", [], { ownedFields: ["approval_id", "glossary_entry_id"], inputMode: "structured", inputRoot: "one glossary publication request", inputSources: ["file", "stdin"], structuredInputSources: ["file", "stdin"], inputMaxBytes: 32768 }),
];

const LOCAL_PREFIX = "agentera";

function developmentCommand(argumentsText: string): string {
  return `${CANONICAL_DEVELOPMENT_CLI} ${argumentsText}`;
}

function projectionTemplate(source: string): RuntimeOperationProjectionTemplate {
  return {
    source,
    runtime: source.split(CANONICAL_DEVELOPMENT_CLI).join(LOCAL_PREFIX),
  };
}

function projection(
  recovery: string,
  ...examples: string[]
): RuntimeOperationProjectionContract {
  return {
    recovery: projectionTemplate(recovery),
    examples: examples.map(projectionTemplate),
    formatValues: ["text", "json"],
  };
}

const RUNTIME_OPERATION_PROJECTIONS: Record<string, RuntimeOperationProjectionContract> = {
  "progress.append": projection(
    `Run \`${developmentCommand("state progress explain --verb append --format json")}\` and correct the rejected field; no state was changed.`,
    developmentCommand("state progress append --input progress.yaml --format json"),
  ),
  "decisions.append": projection(
    `Run \`${developmentCommand("state decisions explain --verb append --format json")}\` and supply every required field; no state was changed.`,
    developmentCommand("state decisions append --input decision.yaml --format json"),
  ),
  "decisions.update": projection(
    `Run ${developmentCommand("state decisions explain --verb update --format json")}, use the returned bare decision ID, and provide a valid satisfaction transition.`,
    developmentCommand('state decisions update --id qjtrmnpvka --satisfaction-state provisionally_satisfied --satisfaction-evidence "..." --format json'),
  ),
  "decisions.amend": projection(
    "Reread the exact decision, copy its current effective SHA-256, and retry with at least one amendable field; no state was changed.",
    developmentCommand("state decisions amend --id qjtrmnpvka --base-sha256 HASH --input amendment.yaml --format json"),
  ),
  "plan.append": projection(
    `Use ${developmentCommand("state plan explain --verb append --format json")}, select an open plan, and supply one complete task record with bare same-plan dependencies.`,
    developmentCommand("state plan append --plan qjtrmnpvka --input task.yaml --format json"),
  ),
  "plan.update": projection(
    "Reread the plan task by its bare ID, supply an omission-preserving patch through --input, and retry; no state was changed.",
    developmentCommand("state plan update --id qjtrmnpvka --plan abcdefghij --input task-patch.yaml --format json"),
  ),
  "plan.set-status": projection(
    "Reread the task list, copy its bare task ID, and use one of complete, in_progress, pending, or blocked.",
    developmentCommand("state plan set-status --id qjtrmnpvka --status complete --format json"),
  ),
  "plan.supersede": projection(
    "Complete and evaluate each replacement task with latest PASS evidence, then retry with the returned bare IDs.",
    developmentCommand('state plan supersede --id qjtrmnpvka --by zqtrmnpvka --reason "Replacement task" --format json'),
  ),
  "plan.set-plan-status": projection(
    "Keep the plan open or resolve every incomplete task and replacement evaluation before retrying completion.",
    developmentCommand("state plan set-plan-status --status complete --format json"),
  ),
  "plan.record-evaluation": projection(
    "Use the task's bare ID, a stable attempt ID, and evaluator provenance, then retry without changing published evidence.",
    developmentCommand('state plan record-evaluation --id qjtrmnpvka --attempt-id audit-1 --verdict pass --provenance "audit report" --format json'),
  ),
  "plan.archive": projection(
    "Archive a complete plan normally. With --force, archive the selected open plan unchanged only after the locked canonical snapshot identifies it; multiple implicit open-plan candidates are rejected without effects.",
    developmentCommand("state plan archive --dry-run --format json"),
    developmentCommand("state plan archive --force --dry-run --format json"),
  ),
  "plan.create": projection(
    `Run ${developmentCommand("state plan explain --verb create --format json")}, keep task ordinals and dependencies local to this atomic input, remove CLI-owned fields, and use --force only when the locked canonical snapshot has exactly one open predecessor to archive unchanged.`,
    developmentCommand("state plan create --input plan.yaml --format json"),
    developmentCommand("state plan create --force --input plan.yaml --format json"),
  ),
  "plan.replace": projection(
    "Name one bare predecessor and either one existing bare successor or one complete successor plan input. The operation archives only the named predecessor, derives reverse lineage from the successor, and rejects divergent retries before effects. Competing-open diagnostics retain bounded bare IDs without assigning roles and recover through npx -y agentera@next state plan replace --predecessor PREDECESSOR_ID --successor SUCCESSOR_ID --format json.",
    developmentCommand("state plan replace --predecessor abcdefghij --successor klmnopqrst --format json"),
    developmentCommand("state plan replace --predecessor abcdefghij --input plan.yaml --format json"),
  ),
  "health.append": projection(
    `Run ${developmentCommand("check validate state --format json")}, preserve audit evidence, and retry with one schema-valid audit entry.`,
    developmentCommand("state health append --input audit.yaml --format json"),
  ),
  "objective.create": projection(
    "Remove identity fields assigned by the CLI and retry with one schema-valid objective document.",
    developmentCommand("state objective create --input objective.yaml --format json"),
  ),
  "objective.update": projection(
    "Reread the objective, copy its bare ID to --id, remove CLI-owned fields, and retry.",
    developmentCommand("state objective update --id qjtrmnpvka --input objective.yaml --format json"),
  ),
  "experiments.publish": projection(
    "Use a bare objective ID, omit numeric legacy selectors, and retry the exact input; divergent immutable identities remain untouched.",
    developmentCommand("state experiments publish --objective qjtrmnpvka --input experiment.yaml --format json"),
  ),
  "todo.activate": projection(
    "Preview and review every reported safe activation effect before explicit confirmed apply; unsafe inactive evidence requires the separate effect-bound owner-correction operation.",
    developmentCommand("state todo activate --dry-run --format json"),
    developmentCommand("state todo activate --effect-sha256 EFFECT_SHA256 --yes --format json"),
  ),
  "todo.repair": projection(
    "Preview and review every diagnosed repair decision before explicit confirmed apply; ambiguous evidence is rejected without effects.",
    developmentCommand("state todo repair --dry-run --format json"),
    developmentCommand("state todo repair --effect-sha256 EFFECT_SHA256 --yes --format json"),
  ),
  "todo.correct-owners": projection(
    "Supply one complete id/source_line owner mapping, preview its bounded effect, then apply only the exact returned effect; malformed, ambiguous, unmatched, or stale evidence is rejected without effects.",
    developmentCommand("state todo correct-owners --input owner-mapping.yaml --dry-run --format json"),
    developmentCommand("state todo correct-owners --input owner-mapping.yaml --effect-sha256 EFFECT_SHA256 --yes --format json"),
  ),
  "todo.create": projection(
    `Run ${developmentCommand("state todo explain --verb create --format json")}, remove CLI-owned fields, provide the full typed TODO record, and retry.`,
    developmentCommand("state todo create --input todo.yaml --format json"),
  ),
  "todo.update": projection(
    "For one item, preserve the existing --id and patch form. For a batch, supply agentera.todoUpdateBatch.v1, preview with --dry-run, then repeat the same input with its effect SHA-256 and --yes.",
    developmentCommand("state todo update --id qjtrmnpvka --input todo-patch.yaml --format json"),
  ),
  "todo.set-severity": projection(
    "Use the bare TODO ID, one immediate-impact severity, a reason, and a YYYY-MM-DD date; no record input is accepted.",
    developmentCommand('state todo set-severity --id qjtrmnpvka --severity degraded --reason "Impact changed" --date 2026-07-31 --format json'),
  ),
  "todo.supersede": projection(
    "Use the selected bare TODO ID, an existing distinct replacement ID, a reason, and a YYYY-MM-DD date; no record input is accepted.",
    developmentCommand('state todo supersede --id qjtrmnpvka --replacement zqtrmnpvka --reason "Replaced by narrower work" --date 2026-07-31 --format json'),
  ),
  "todo.resolve": projection(
    "Use the bare TODO ID, a reason, and a YYYY-MM-DD date; no record input is accepted.",
    developmentCommand('state todo resolve --id qjtrmnpvka --reason "Shipped" --date 2026-07-31 --format json'),
  ),
  "todo.reopen": projection(
    "Use the bare resolved TODO ID, a reason, and a YYYY-MM-DD date; no record input is accepted.",
    developmentCommand('state todo reopen --id qjtrmnpvka --reason "Scope returned" --date 2026-07-31 --format json'),
  ),
  "docs.create": projection(
    "Remove id and artifact from the input and retry with one schema-valid documentation inventory entry.",
    developmentCommand("state docs create --input documentation.yaml --format json"),
  ),
  "docs.update": projection(
    "Reread the documentation entry, copy its bare ID to --id, remove CLI-owned fields, and retry.",
    developmentCommand("state docs update --id qjtrmnpvka --input documentation.yaml --format json"),
  ),
  "glossary.publish": projection(
    `Run ${developmentCommand("state glossary explain --verb publish --format json")} and correct the bounded request or confirmation.`,
    developmentCommand("state glossary publish --input glossary-publication.yaml --format json"),
  ),
};

const operationKeys = RUNTIME_OPERATION_CORES.map(({ artifact, verb }) => `${artifact}.${verb}`);
const projectionKeys = Object.keys(RUNTIME_OPERATION_PROJECTIONS);
const missingProjection = operationKeys.find((key) => !(key in RUNTIME_OPERATION_PROJECTIONS));
const unknownProjection = projectionKeys.find((key) => !operationKeys.includes(key));
if (missingProjection || unknownProjection) {
  throw new Error(`invalid runtime operation projection registry: ${missingProjection ? `missing ${missingProjection}` : `unknown ${unknownProjection}`}`);
}

const RUNTIME_OPERATIONS: RuntimeOperationSpec[] = RUNTIME_OPERATION_CORES.map((operation) => ({
  ...operation,
  projection: RUNTIME_OPERATION_PROJECTIONS[`${operation.artifact}.${operation.verb}`],
}));

function cloneOperation(spec: RuntimeOperationSpec): RuntimeOperationSpec {
  return {
    ...spec,
    selectors: [...spec.selectors],
    ownedFields: [...spec.ownedFields],
    inputSources: [...spec.inputSources],
    structuredInputSources: [...spec.structuredInputSources],
    cliOwnedFields: [...spec.cliOwnedFields],
    ...(spec.recoveryCommand ? { recoveryCommand: [...spec.recoveryCommand] } : {}),
    fields: spec.fields.map((field) => ({ ...field, ...(field.validValues ? { validValues: [...field.validValues] } : {}) })),
    projection: {
      recovery: { ...spec.projection.recovery },
      examples: spec.projection.examples.map((example) => ({ ...example })),
      formatValues: [...spec.projection.formatValues] as ["text", "json"],
    },
  };
}

export function runtimeOperationSpecs(): RuntimeOperationSpec[] {
  return RUNTIME_OPERATIONS.map(cloneOperation);
}

export function runtimeOperationSpec(artifact: string, verb: string): RuntimeOperationSpec | null {
  const spec = RUNTIME_OPERATIONS.find((candidate) => candidate.artifact === artifact && candidate.verb === verb);
  return spec ? cloneOperation(spec) : null;
}

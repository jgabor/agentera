import type { JsonObject } from "../../core/jsonValue.js";
import { loadTodoReadinessContract } from "../../registries/todoReadinessContract.js";
import { glossaryCaveatContract } from "../../registries/glossaryCaveatContract.js";

export const WRITABLE_ARTIFACTS = ["progress", "decisions", "plan", "health", "objective", "experiments", "todo", "docs", "glossary"] as const;
export type WritableArtifact = (typeof WRITABLE_ARTIFACTS)[number];

export const WRITE_VERBS = [
  "append",
  "update",
  "amend",
  "set-status",
  "supersede",
  "set-plan-status",
  "record-evaluation",
  "repair",
  "archive",
  "create",
  "publish",
  "resolve",
  "explain",
] as const;
export type WriteVerb = (typeof WRITE_VERBS)[number];

export type FieldKind = "string" | "integer" | "string_list" | "integer_list" | "date" | "datetime";

export interface OperationField {
  flag: string;
  field: string;
  kind: FieldKind;
  required?: boolean;
  repeatable?: boolean;
  validValues?: string[];
  description?: string;
}

export interface OperationSpec {
  artifact: WritableArtifact;
  verb: Exclude<WriteVerb, "explain">;
  fields: OperationField[];
  inputRoot?: "one audit entry" | "complete plan document" | "one objective document" | "one experiment entry" | "one documentation inventory entry" | "one glossary publication request";
  cliOwnedFields?: string[];
  allowForce?: boolean;
  compacts?: boolean;
}

export interface StateWriteRequest {
  artifact: WritableArtifact;
  spec: OperationSpec;
  projectRoot: string;
  dryRun: boolean;
  force: boolean;
  values: Record<string, unknown>;
  callerPayload: Record<string, unknown>;
  input: Record<string, unknown> | null;
}

export interface StateWriteEnvelope extends Record<string, unknown> {
  schemaVersion: "agentera.stateWrite.v1";
  status: "pass";
}

const todoReadinessFields: OperationField[] = [
  { flag: "--capability", field: "readiness.capability", kind: "string", description: "Reviewer-approved capability that owns the next action." },
  { flag: "--reason", field: "readiness.reason", kind: "string", description: "Durable intent explaining why the destination is correct." },
  { flag: "--dependency", field: "readiness.dependencies", kind: "string_list", repeatable: true, description: "Bare ten-letter canonical TODO prerequisite ID; repeat for each dependency." },
  { flag: "--blocked-reason", field: "readiness.blocked.reason", kind: "string", description: "Explicit blocker reason; requires --blocked-recovery." },
  { flag: "--blocked-recovery", field: "readiness.blocked.recovery", kind: "string", description: "Bounded action that clears the declared blocker; requires --blocked-reason." },
  { flag: "--gate-state", field: "readiness.gate.state", kind: "string", validValues: ["pending", "satisfied"], description: "Declared external or approval gate state." },
  { flag: "--gate-reason", field: "readiness.gate.reason", kind: "string", description: "Reason for the declared gate." },
  { flag: "--gate-recovery", field: "readiness.gate.recovery", kind: "string", description: "Bounded action for the declared gate." },
  { flag: "--queue-rank", field: "readiness.queue_rank", kind: "integer", description: "Reviewer-assigned intent order within severity; lower values run first." },
  { flag: "--order-reason", field: "readiness.order_reason", kind: "string", description: "Durable reason for the queue rank." },
];

const glossaryCaveat = glossaryCaveatContract();

const progressAppend: OperationField[] = [
  {
    flag: "--type",
    field: "type",
    kind: "string",
    required: true,
    validValues: ["feat", "fix", "docs", "refactor", "chore", "test"],
  },
  {
    flag: "--phase",
    field: "phase",
    kind: "string",
    required: true,
    validValues: ["envision", "deliberate", "plan", "build", "audit"],
  },
  { flag: "--what", field: "what", kind: "string", required: true },
  { flag: "--intent", field: "context.intent", kind: "string", required: true },
  { flag: "--timestamp", field: "timestamp", kind: "datetime", required: false },
  { flag: "--glossary-caveat-event", field: "glossary_caveat.event", kind: "string", validValues: glossaryCaveat.events, description: "Build-owned glossary caveat lifecycle event. Other caveat flags are conditionally required; identity is CLI-assigned for current." },
  { flag: "--glossary-caveat-reason", field: "glossary_caveat.reason", kind: "string", validValues: glossaryCaveat.reasons, description: "Bounded glossary caveat reason; never include a term, meaning, path, anchor, or provenance." },
  { flag: "--glossary-caveat-ownership-state", field: "glossary_caveat.ownership_state", kind: "string", validValues: glossaryCaveat.ownershipStates, description: "Bounded authority state for the glossary caveat." },
  { flag: "--glossary-caveat-id", field: "glossary_caveat.caveat_id", kind: "string", description: "Existing opaque caveat identity for resolved or superseded; forbidden for current." },
  { flag: "--glossary-caveat-transition-id", field: "glossary_caveat.transition_id", kind: "string", description: "Fresh successor caveat identity for superseded; forbidden for current and resolved." },
  { flag: "--inspiration", field: "inspiration", kind: "string" },
  { flag: "--discovered", field: "discovered", kind: "string" },
  { flag: "--verified", field: "verified", kind: "string" },
  { flag: "--next", field: "next", kind: "string" },
  { flag: "--constraints", field: "context.constraints", kind: "string" },
  { flag: "--unknowns", field: "context.unknowns", kind: "string" },
  { flag: "--scope", field: "context.scope", kind: "string" },
];

const decisionAppend: OperationField[] = [
  { flag: "--question", field: "question", kind: "string", required: true },
  { flag: "--context", field: "context", kind: "string", required: true },
  { flag: "--alternative-chosen", field: "alternatives.chosen", kind: "string", required: true },
  {
    flag: "--alternative-rejected",
    field: "alternatives.rejected",
    kind: "string_list",
    repeatable: true,
  },
  { flag: "--choice", field: "choice", kind: "string", required: true },
  { flag: "--reasoning", field: "reasoning", kind: "string", required: true },
  {
    flag: "--confidence",
    field: "confidence",
    kind: "string",
    required: true,
    validValues: ["firm", "provisional", "exploratory"],
  },
  { flag: "--feeds-into", field: "feeds_into", kind: "string" },
  { flag: "--date", field: "date", kind: "date", required: false },
];

const decisionUpdate: OperationField[] = [
  { flag: "--id", field: "id", kind: "string" },
  {
    flag: "--satisfaction-state",
    field: "satisfaction.state",
    kind: "string",
    required: true,
    validValues: ["open", "provisionally_satisfied", "user_confirmed_satisfied"],
  },
  { flag: "--satisfaction-evidence", field: "satisfaction.evidence", kind: "string" },
  { flag: "--confirmed-by", field: "satisfaction.user_confirmation.confirmed_by", kind: "string" },
  { flag: "--confirmed-at", field: "satisfaction.user_confirmation.confirmed_at", kind: "string" },
];

/** Current decision amendments publish immutable revision entities by bare ID. */
const decisionAmend: OperationField[] = [
  { flag: "--id", field: "id", kind: "string" },
  { flag: "--base-sha256", field: "base_sha256", kind: "string" },
  { flag: "--question", field: "question", kind: "string", required: false },
  { flag: "--context", field: "context", kind: "string", required: false },
  { flag: "--alternative-chosen", field: "alternatives.chosen", kind: "string", required: false },
  {
    flag: "--alternative-rejected",
    field: "alternatives.rejected",
    kind: "string_list",
    repeatable: true,
    required: false,
  },
  { flag: "--choice", field: "choice", kind: "string", required: false },
  { flag: "--reasoning", field: "reasoning", kind: "string", required: false },
  {
    flag: "--confidence",
    field: "confidence",
    kind: "string",
    required: false,
    validValues: ["firm", "provisional", "exploratory"],
  },
  { flag: "--feeds-into", field: "feeds_into", kind: "string", required: false },
];

const planTaskFields: OperationField[] = [
  { flag: "--name", field: "name", kind: "string", required: true },
  { flag: "--depends-on", field: "depends_on", kind: "integer_list", repeatable: true },
  { flag: "--acceptance", field: "acceptance", kind: "string_list", repeatable: true },
  {
    flag: "--status",
    field: "status",
    kind: "string",
    required: false,
    validValues: ["complete", "in_progress", "pending", "blocked"],
    description: "Task execution status. Does not change the plan lifecycle.",
  },
];

const planEvaluationFields: OperationField[] = [
  { flag: "--task", field: "task", kind: "integer", required: true },
  { flag: "--attempt-id", field: "evaluation.attempt_id", kind: "string", required: true },
  {
    flag: "--verdict",
    field: "evaluation.verdict",
    kind: "string",
    required: true,
    validValues: ["pass", "fail"],
    description: "Evaluator verdict for this idempotent attempt.",
  },
  { flag: "--failure-evidence", field: "evaluation.failure_evidence", kind: "string" },
  {
    flag: "--provenance",
    field: "evaluation.provenance",
    kind: "string",
    required: true,
    description: "Stable source reference for the evaluator result.",
  },
];

const planSupersedeFields: OperationField[] = [
  { flag: "--by", field: "superseded_by", kind: "string_list", required: true, repeatable: true, description: "Distinct same-plan replacement task IDs that are complete with latest persisted PASS." },
  { flag: "--reason", field: "superseded_reason", kind: "string", required: true, description: "Required explanation, at most 500 characters." },
];

const SPECS: OperationSpec[] = [
  { artifact: "progress", verb: "append", fields: progressAppend, compacts: true },
  { artifact: "decisions", verb: "append", fields: decisionAppend, compacts: true },
  { artifact: "decisions", verb: "update", fields: decisionUpdate },
  { artifact: "decisions", verb: "amend", fields: decisionAmend },
  { artifact: "plan", verb: "append", fields: planTaskFields },
  {
    artifact: "plan",
    verb: "update",
    fields: [
      { flag: "--task", field: "task", kind: "integer", required: true },
      ...planTaskFields
        .filter((field) => field.field !== "status")
        .map((field) => ({ ...field, required: false })),
      { flag: "--evidence", field: "evidence", kind: "string" },
      { flag: "--blocked-reason", field: "blocked_reason", kind: "string" },
      { flag: "--surprise", field: "surprise", kind: "string" },
    ],
  },
  {
    artifact: "plan",
    verb: "set-status",
    fields: [
      { flag: "--task", field: "task", kind: "integer", required: true },
      {
        flag: "--status",
        field: "status",
        kind: "string",
        required: true,
        validValues: ["complete", "in_progress", "pending", "blocked"],
        description: "Task execution status. Does not change the plan lifecycle.",
      },
    ],
  },
  { artifact: "plan", verb: "supersede", fields: planSupersedeFields },
  {
    artifact: "plan",
    verb: "set-plan-status",
    fields: [
      {
        flag: "--status",
        field: "status",
        kind: "string",
        required: true,
        validValues: ["open", "complete"],
        description: "Plan lifecycle status. Positional activity is derived from location.",
      },
    ],
  },
  { artifact: "plan", verb: "record-evaluation", fields: planEvaluationFields },
  { artifact: "plan", verb: "archive", fields: [], allowForce: true },
  {
    artifact: "plan",
    verb: "create",
    fields: [],
    inputRoot: "complete plan document",
    cliOwnedFields: ["header.id", "previous_plan_archived"],
    allowForce: true,
  },
  {
    artifact: "health",
    verb: "append",
    fields: [],
    inputRoot: "one audit entry",
    cliOwnedFields: ["number"],
    compacts: true,
  },
  {
    artifact: "health",
    verb: "repair",
    fields: [
      { flag: "--number", field: "number", kind: "integer", required: true },
      { flag: "--keep", field: "keep", kind: "string", required: false, validValues: ["first", "last"] },
    ],
    allowForce: true,
  },
  {
    artifact: "objective",
    verb: "create",
    fields: [],
    inputRoot: "one objective document",
    cliOwnedFields: ["id", "artifact", "header.id"],
  },
  {
    artifact: "objective",
    verb: "update",
    fields: [{ flag: "--id", field: "id", kind: "string", required: true }],
    inputRoot: "one objective document",
    cliOwnedFields: ["id", "artifact", "header.id"],
  },
  {
    artifact: "experiments",
    verb: "publish",
    fields: [
      {
        flag: "--objective",
        field: "objective",
        kind: "string",
        required: true,
        description: "Stable objective identity owning the experiment.",
      },
      {
        flag: "--number",
        field: "number",
        kind: "integer",
        description: "Non-negative experiment number, including baseline 0.",
      },
      { flag: "--id", field: "id", kind: "string", description: "Existing immutable entity ID for exact replay in entity mode." },
    ],
    inputRoot: "one experiment entry",
    cliOwnedFields: ["number"],
    compacts: true,
  },
  {
    artifact: "todo",
    verb: "create",
    fields: [
      { flag: "--severity", field: "severity", kind: "string", required: true, validValues: ["critical", "degraded", "normal", "annoying"] },
      { flag: "--description", field: "description", kind: "string", required: true },
      ...todoReadinessFields,
    ],
  },
  {
    artifact: "todo",
    verb: "update",
    fields: [
      { flag: "--id", field: "id", kind: "string", required: true, description: "Bare ten-letter TODO item ID returned by create or list." },
      { flag: "--severity", field: "severity", kind: "string", required: false, validValues: ["critical", "degraded", "normal", "annoying"] },
      { flag: "--description", field: "description", kind: "string", required: false },
      ...todoReadinessFields,
    ],
  },
  { artifact: "todo", verb: "resolve", fields: [{ flag: "--id", field: "id", kind: "string", required: true, description: "Bare ten-letter TODO item ID returned by create or list." }] },
  { artifact: "docs", verb: "create", fields: [], inputRoot: "one documentation inventory entry", cliOwnedFields: ["id", "artifact"] },
  {
    artifact: "docs",
    verb: "update",
    fields: [{ flag: "--id", field: "id", kind: "string", required: true, description: "Bare ten-letter documentation inventory ID returned by create or list." }],
    inputRoot: "one documentation inventory entry",
    cliOwnedFields: ["id", "artifact"],
  },
  {
    artifact: "glossary",
    verb: "publish",
    fields: [],
    inputRoot: "one glossary publication request",
  },
];

export function operationSpec(artifact: string, verb: string): OperationSpec | null {
  const spec = SPECS.find((candidate) => candidate.artifact === artifact && candidate.verb === verb) ?? null;
  if (!spec || artifact !== "todo" || !["create", "update"].includes(verb)) return spec;
  const allowedDestinations = loadTodoReadinessContract().allowedDestinations;
  return {
    ...spec,
    fields: spec.fields.map((field) => field.flag === "--capability" ? { ...field, validValues: allowedDestinations } : field),
  };
}

export function verbsForArtifact(artifact: string): WriteVerb[] {
  if (!WRITABLE_ARTIFACTS.includes(artifact as WritableArtifact)) return [];
  return [
    ...SPECS.filter((spec) => spec.artifact === artifact).map((spec) => spec.verb),
    "explain",
  ];
}

export function isWriteVerb(value: string | undefined): boolean {
  return Boolean(value && WRITE_VERBS.includes(value as WriteVerb));
}

export function isWritableArtifact(value: string): value is WritableArtifact {
  return WRITABLE_ARTIFACTS.includes(value as WritableArtifact);
}

export function writerOwnedFields(artifact: string): string[] {
  if (artifact === "progress") return ["id", "artifact", "publication_order"];
  if (artifact === "health") return ["id", "artifact", "appended_at"];
  return [];
}

export function stateWriterArtifactContract(artifact: string, projectRoot = process.cwd()): JsonObject | null {
  if (!isWritableArtifact(artifact)) return null;
  void projectRoot;
  const verbs = verbsForArtifact(artifact);
  const mutations = verbs.filter((verb) => verb !== "explain");
  const owned = writerOwnedFields(artifact);
  return {
    artifact,
    mutations,
    explain_command: `agentera state ${artifact} explain --format json`,
    explain_by_verb: Object.fromEntries(
      mutations.map((verb) => [
        verb,
        `agentera state ${artifact} explain --verb ${verb} --format json`,
      ]),
    ),
    supports_dry_run: true,
    ...(owned.length ? { writer_owned_fields: owned } : {}),
  };
}

export function stateWriterContract(
  targets: readonly string[] = WRITABLE_ARTIFACTS,
): JsonObject {
  const uniqueTargets = [...new Set(targets)];
  const artifacts = uniqueTargets
    .map((target) => stateWriterArtifactContract(target))
    .filter((entry): entry is JsonObject => entry !== null);
  return {
    schemaVersion: "agentera.stateWriterDiscovery.v1",
    namespace: "agentera state",
    policy:
      "Use the state writer for supported artifact mutations; do not hand-edit those artifacts during normal capability execution.",
    authority: "runtime operation registry",
    discovery_command: "agentera schema --format json",
    artifacts,
    unsupported_targets: uniqueTargets.filter((target) => stateWriterArtifactContract(target) === null),
  };
}

import type { JsonObject } from "../../core/jsonValue.js";

export const WRITABLE_ARTIFACTS = ["progress", "decisions", "plan", "health", "objective", "experiments", "todo", "docs"] as const;
export type WritableArtifact = (typeof WRITABLE_ARTIFACTS)[number];

export const WRITE_VERBS = [
  "append",
  "update",
  "amend",
  "set-status",
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
  inputRoot?: "one audit entry" | "complete plan document" | "one objective document" | "one experiment entry" | "one documentation inventory entry";
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

/** Caller-selected existing decision number (update/amend). Never CLI-assigned. */
const EXISTING_DECISION_NUMBER_DESCRIPTION =
  "Existing decision number to update or amend. Caller-selected: it must match a numbered decision in the active projection or numbered archive and is never assigned by the CLI.";

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
    flag: "--number",
    field: "number",
    kind: "integer",
    required: false,
    description: EXISTING_DECISION_NUMBER_DESCRIPTION,
  },
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

/**
 * Amending decision content fields. `--number` is caller-selected (an existing
 * decision). At least one amendable content field must be supplied; individual
 * fields are optional so the writer can validate the union requirement.
 * `--alternative-rejected` is repeatable and appends rejected alternatives.
 * Confidence values must be current vocabulary (firm|provisional|exploratory).
 * Amendment publication publishes a record-local revision document override
 * with recovery; the decisions projection is never rewritten.
 */
const decisionAmend: OperationField[] = [
  { flag: "--id", field: "id", kind: "string" },
  { flag: "--base-sha256", field: "base_sha256", kind: "string" },
  {
    flag: "--number",
    field: "number",
    kind: "integer",
    required: false,
    description: EXISTING_DECISION_NUMBER_DESCRIPTION,
  },
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
    ],
  },
  {
    artifact: "todo",
    verb: "update",
    fields: [
      { flag: "--id", field: "id", kind: "string", required: true, description: "Bare ten-letter TODO item ID returned by create or list." },
      { flag: "--severity", field: "severity", kind: "string", required: false, validValues: ["critical", "degraded", "normal", "annoying"] },
      { flag: "--description", field: "description", kind: "string", required: false },
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
];

export function operationSpec(artifact: string, verb: string): OperationSpec | null {
  return SPECS.find((spec) => spec.artifact === artifact && spec.verb === verb) ?? null;
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

export function stateWriterArtifactContract(artifact: string, projectRoot = process.cwd()): JsonObject | null {
  if (!isWritableArtifact(artifact)) return null;
  void projectRoot;
  const verbs = verbsForArtifact(artifact);
  const mutations = verbs.filter((verb) => verb !== "explain");
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

import type { JsonObject } from "../../core/jsonValue.js";

export const WRITABLE_ARTIFACTS = ["progress", "decisions", "plan", "health"] as const;
export type WritableArtifact = (typeof WRITABLE_ARTIFACTS)[number];

export const WRITE_VERBS = [
  "append",
  "update",
  "set-status",
  "set-plan-status",
  "record-evaluation",
  "archive",
  "create",
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
  inputRoot?: "one audit entry" | "complete plan document";
  cliOwnedFields?: string[];
  allowForce?: boolean;
  compacts?: boolean;
}

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
  { flag: "--number", field: "number", kind: "integer", required: true },
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
    cliOwnedFields: ["previous_plan_archived"],
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

export function stateWriterArtifactContract(artifact: string): JsonObject | null {
  if (!isWritableArtifact(artifact)) return null;
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
    .map(stateWriterArtifactContract)
    .filter((entry): entry is JsonObject => entry !== null);
  return {
    schemaVersion: "agentera.stateWriterDiscovery.v1",
    namespace: "agentera state",
    policy:
      "Use the state writer for supported artifact mutations; do not hand-edit those artifacts during normal capability execution.",
    authority: "runtime operation registry",
    discovery_command: "agentera schema --format json",
    artifacts,
    unsupported_targets: uniqueTargets.filter((target) => !isWritableArtifact(target)),
  };
}

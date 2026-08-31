import { CANONICAL_DEVELOPMENT_CLI } from "../core/developmentChannel.js";

export type EntityListParser = "generic" | "plans" | "plan_tasks" | "experiments";

export interface EntityListRuntimeFilter {
  name: string;
  flag: string;
  values: "free_text" | readonly string[];
}

export interface EntityListRuntimeProjection {
  list: string;
  get: string;
  example: string;
  bareRecovery?: string;
}

export interface EntityListRuntimeFamily {
  key: string;
  commandTokens: readonly string[];
  parser: EntityListParser;
  artifact: string;
  boundary: string;
  boundsBoundary?: string;
  bareRead: "alias" | "correction";
  filters: readonly EntityListRuntimeFilter[];
  familyIdentifier?: { syntax: string; required: boolean };
  bareRecoveryCommandTokens?: readonly string[];
  summaryFields: readonly string[];
  projection: EntityListRuntimeProjection;
}

const COMMON_SUMMARY_FIELDS = ["id", "artifact", "retrieval.get"] as const;

export const ENTITY_LIST_RUNTIME_FORMATS = ["text", "json", "yaml"] as const;
export const ENTITY_LIST_RUNTIME_BOUNDS = {
  minimum: 1,
  default: 20,
  maximum: 100,
  maxUtf8Bytes: 32768,
} as const;
export const ENTITY_LIST_RUNTIME_SELECTORS = {
  idsOnly: "--ids-only",
  fields: "--fields FIELDS",
} as const;

type FamilyOptions = Omit<EntityListRuntimeFamily, "projection"> & {
  exampleArguments: string;
  bareRecoveryArguments?: string;
};

function family<const T extends FamilyOptions>(options: T): Omit<T, "exampleArguments" | "bareRecoveryArguments"> & {
  projection: EntityListRuntimeProjection;
} {
  const identifier = options.familyIdentifier
    ? ` ${options.familyIdentifier.required ? options.familyIdentifier.syntax : `[${options.familyIdentifier.syntax}]`}`
    : "";
  const filters = options.filters.map(({ flag }) => ` [${flag}]`).join("");
  const root = `${CANONICAL_DEVELOPMENT_CLI} state ${options.commandTokens.join(" ")}`;
  const projection = {
    list: `${root} list${identifier}${filters} [--limit N] [--cursor TOKEN] [--ids-only | --fields FIELDS]`,
    get: `${root} get --id ID`,
    example: `${CANONICAL_DEVELOPMENT_CLI} ${options.exampleArguments}`,
    ...(options.bareRecoveryArguments ? { bareRecovery: `${CANONICAL_DEVELOPMENT_CLI} ${options.bareRecoveryArguments}` } : {}),
  };
  const { exampleArguments: _example, bareRecoveryArguments: _bareRecovery, ...runtime } = options;
  return { ...runtime, projection };
}

export const ENTITY_LIST_RUNTIME_REGISTRY = {
  progress: family({ key: "progress", commandTokens: ["progress"], parser: "generic", artifact: "progress", boundary: "progress_cycle", bareRead: "alias", filters: [{ name: "topic", flag: "--topic TEXT", values: "free_text" }, { name: "status", flag: "--status STATUS", values: "free_text" }], summaryFields: COMMON_SUMMARY_FIELDS, exampleArguments: "state progress list --limit 20" }),
  decisions: family({ key: "decisions", commandTokens: ["decisions"], parser: "generic", artifact: "decisions", boundary: "decision", bareRead: "alias", filters: [{ name: "topic", flag: "--topic TEXT", values: "free_text" }], summaryFields: COMMON_SUMMARY_FIELDS, exampleArguments: "state decisions list --limit 20" }),
  health: family({ key: "health", commandTokens: ["health"], parser: "generic", artifact: "health", boundary: "health_audit", bareRead: "correction", filters: [{ name: "dimension", flag: "--dimension DIMENSION", values: "free_text" }], summaryFields: COMMON_SUMMARY_FIELDS, exampleArguments: "state health list --limit 20", bareRecoveryArguments: "state health list --limit 20" }),
  plans: family({ key: "plans", commandTokens: ["plan"], parser: "plans", artifact: "plan", boundary: "plan", bareRead: "correction", filters: [{ name: "status", flag: "--status open|complete|archived", values: ["open", "complete", "archived"] }], summaryFields: COMMON_SUMMARY_FIELDS, exampleArguments: "state plan list --status open --limit 20", bareRecoveryArguments: "state plan list --status open --limit 20" }),
  plan_tasks: family({ key: "plan_tasks", commandTokens: ["plan", "tasks"], parser: "plan_tasks", artifact: "plan", boundary: "plan_task", boundsBoundary: "plan", bareRead: "correction", filters: [], familyIdentifier: { syntax: "PLAN_ID", required: false }, summaryFields: COMMON_SUMMARY_FIELDS, exampleArguments: "state plan tasks list --limit 20", bareRecoveryArguments: "state plan tasks list --limit 20" }),
  objective: family({ key: "objective", commandTokens: ["objective"], parser: "generic", artifact: "objective", boundary: "objective", bareRead: "correction", filters: [], summaryFields: COMMON_SUMMARY_FIELDS, exampleArguments: "state objective list --limit 20", bareRecoveryArguments: "state objective list --limit 20" }),
  experiments: family({ key: "experiments", commandTokens: ["experiments"], bareRecoveryCommandTokens: ["objective"], parser: "experiments", artifact: "experiments", boundary: "experiment", bareRead: "correction", filters: [], familyIdentifier: { syntax: "--objective ID", required: true }, summaryFields: COMMON_SUMMARY_FIELDS, exampleArguments: "state experiments list --objective qjtrmnpvka --limit 20", bareRecoveryArguments: "state objective list --limit 20" }),
  todo: family({ key: "todo", commandTokens: ["todo"], parser: "generic", artifact: "todo", boundary: "todo_item", bareRead: "alias", filters: [{ name: "severity", flag: "--severity SEVERITY", values: "free_text" }, { name: "status", flag: "--status STATUS", values: "free_text" }], summaryFields: ["id", "artifact", "public_order", "readiness", "actionability", "queue_rank", "reconciliation", "retrieval.get"], exampleArguments: "state todo list --severity critical --ids-only --limit 20" }),
  docs: family({ key: "docs", commandTokens: ["docs"], parser: "generic", artifact: "docs", boundary: "documentation_inventory_entry", bareRead: "correction", filters: [{ name: "topic", flag: "--topic TEXT", values: "free_text" }, { name: "status", flag: "--status STATUS", values: "free_text" }], summaryFields: COMMON_SUMMARY_FIELDS, exampleArguments: "state docs list --limit 20", bareRecoveryArguments: "state docs list --limit 20" }),
} as const satisfies Record<string, EntityListRuntimeFamily>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

deepFreeze(ENTITY_LIST_RUNTIME_REGISTRY);

export type EntityListRuntimeFamilyKey = keyof typeof ENTITY_LIST_RUNTIME_REGISTRY;

export const ENTITY_LIST_RUNTIME_FAMILIES: readonly EntityListRuntimeFamily[] = Object.freeze(Object.values(ENTITY_LIST_RUNTIME_REGISTRY));

export function runtimeEntityFamiliesForCommand(command: string): readonly EntityListRuntimeFamily[] {
  return ENTITY_LIST_RUNTIME_FAMILIES.filter(({ commandTokens }) => commandTokens[0] === command);
}

export function runtimeEntityListFamilyForStateArgs(command: string, argv: string[]): EntityListRuntimeFamily | undefined {
  return ENTITY_LIST_RUNTIME_FAMILIES
    .filter(({ commandTokens }) => commandTokens[0] === command)
    .sort((left, right) => right.commandTokens.length - left.commandTokens.length)
    .find(({ commandTokens }) => {
      const remainder = commandTokens.slice(1);
      return remainder.every((token, index) => argv[index] === token) && argv[remainder.length] === "list";
    });
}

export function runtimeEntityFamilyForStateCommand(command: string, argv: string[]): EntityListRuntimeFamily | undefined {
  return runtimeEntityFamiliesForCommand(command)
    .slice()
    .sort((left, right) => right.commandTokens.length - left.commandTokens.length)
    .find(({ commandTokens }) => commandTokens.slice(1).every((token, index) => argv[index] === token));
}

export function runtimeEntityListFamilyForHelpArgs(args: string[]): EntityListRuntimeFamily | undefined {
  return ENTITY_LIST_RUNTIME_FAMILIES
    .slice()
    .sort((left, right) => right.commandTokens.length - left.commandTokens.length)
    .find(({ commandTokens }) => args.length === commandTokens.length + 1 && args.at(-1) === "list" && commandTokens.every((token, index) => args[index] === token));
}

export function runtimeEntityFamilyForHelpArgs(args: string[]): { family: EntityListRuntimeFamily; verb: "list" | "get" } | undefined {
  for (const family of ENTITY_LIST_RUNTIME_FAMILIES.slice().sort((left, right) => right.commandTokens.length - left.commandTokens.length)) {
    for (const verb of ["list", "get"] as const) {
      if (args.length === family.commandTokens.length + 1 && args.at(-1) === verb && family.commandTokens.every((token, index) => args[index] === token)) return { family, verb };
    }
  }
  return undefined;
}

export function runtimeGenericEntityListFamily(artifact: string): EntityListRuntimeFamily | undefined {
  return ENTITY_LIST_RUNTIME_FAMILIES.find((family) => family.parser === "generic" && family.artifact === artifact);
}

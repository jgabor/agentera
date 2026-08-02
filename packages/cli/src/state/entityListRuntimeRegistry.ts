export type EntityListParser = "generic" | "plans" | "plan_tasks" | "experiments";

export interface EntityListRuntimeFamily {
  key: string;
  commandTokens: readonly string[];
  parser: EntityListParser;
  artifact: string;
  boundary: string;
  boundsBoundary?: string;
  filters: readonly string[];
  familyIdentifier?: { syntax: string; required: boolean };
  summaryFields: readonly string[];
}

const COMMON_SUMMARY_FIELDS = ["id", "artifact", "retrieval.get"] as const;

export const ENTITY_LIST_RUNTIME_REGISTRY = {
  progress: { key: "progress", commandTokens: ["progress"], parser: "generic", artifact: "progress", boundary: "progress_cycle", filters: ["topic", "status"], summaryFields: COMMON_SUMMARY_FIELDS },
  decisions: { key: "decisions", commandTokens: ["decisions"], parser: "generic", artifact: "decisions", boundary: "decision", filters: ["topic"], summaryFields: COMMON_SUMMARY_FIELDS },
  health: { key: "health", commandTokens: ["health"], parser: "generic", artifact: "health", boundary: "health_audit", filters: ["dimension"], summaryFields: COMMON_SUMMARY_FIELDS },
  plans: { key: "plans", commandTokens: ["plan"], parser: "plans", artifact: "plan", boundary: "plan", filters: ["status"], summaryFields: COMMON_SUMMARY_FIELDS },
  plan_tasks: { key: "plan_tasks", commandTokens: ["plan", "tasks"], parser: "plan_tasks", artifact: "plan", boundary: "plan_task", boundsBoundary: "plan", filters: [], familyIdentifier: { syntax: "PLAN_ID", required: false }, summaryFields: COMMON_SUMMARY_FIELDS },
  objective: { key: "objective", commandTokens: ["objective"], parser: "generic", artifact: "objective", boundary: "objective", filters: [], summaryFields: COMMON_SUMMARY_FIELDS },
  experiments: { key: "experiments", commandTokens: ["experiments"], parser: "experiments", artifact: "experiments", boundary: "experiment", filters: [], familyIdentifier: { syntax: "--objective ID", required: true }, summaryFields: COMMON_SUMMARY_FIELDS },
  todo: { key: "todo", commandTokens: ["todo"], parser: "generic", artifact: "todo", boundary: "todo_item", filters: ["severity", "status"], summaryFields: ["id", "artifact", "queue_rank", "retrieval.get"] },
  docs: { key: "docs", commandTokens: ["docs"], parser: "generic", artifact: "docs", boundary: "documentation_inventory_entry", filters: ["topic", "status"], summaryFields: COMMON_SUMMARY_FIELDS },
} as const satisfies Record<string, EntityListRuntimeFamily>;

export type EntityListRuntimeFamilyKey = keyof typeof ENTITY_LIST_RUNTIME_REGISTRY;

export const ENTITY_LIST_RUNTIME_FAMILIES: readonly EntityListRuntimeFamily[] = Object.values(ENTITY_LIST_RUNTIME_REGISTRY);

export function runtimeEntityListFamilyForStateArgs(command: string, argv: string[]): EntityListRuntimeFamily | undefined {
  return ENTITY_LIST_RUNTIME_FAMILIES
    .filter(({ commandTokens }) => commandTokens[0] === command)
    .sort((left, right) => right.commandTokens.length - left.commandTokens.length)
    .find(({ commandTokens }) => {
      const remainder = commandTokens.slice(1);
      return remainder.every((token, index) => argv[index] === token) && argv[remainder.length] === "list";
    });
}

export function runtimeEntityListFamilyForHelpArgs(args: string[]): EntityListRuntimeFamily | undefined {
  return ENTITY_LIST_RUNTIME_FAMILIES
    .slice()
    .sort((left, right) => right.commandTokens.length - left.commandTokens.length)
    .find(({ commandTokens }) => args.length === commandTokens.length + 1 && args.at(-1) === "list" && commandTokens.every((token, index) => args[index] === token));
}

export function runtimeGenericEntityListFamily(artifact: string): EntityListRuntimeFamily | undefined {
  return ENTITY_LIST_RUNTIME_FAMILIES.find((family) => family.parser === "generic" && family.artifact === artifact);
}

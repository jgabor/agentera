import { emitInvalidInput } from "./errors.js";

export type OutputPathClass = "help" | "version" | "prime_guidance" | "operational";

export interface OutputPathPolicy {
  class: OutputPathClass;
  success: "text" | "json";
  error: "json";
  formatSelector: "reject" | "json_only";
}

export const OUTPUT_PATH_POLICIES: Record<OutputPathClass, OutputPathPolicy> = {
  help: { class: "help", success: "text", error: "json", formatSelector: "reject" },
  version: { class: "version", success: "text", error: "json", formatSelector: "reject" },
  prime_guidance: { class: "prime_guidance", success: "text", error: "json", formatSelector: "reject" },
  operational: { class: "operational", success: "json", error: "json", formatSelector: "json_only" },
};

const OPERATIONAL_ROUTE_PRODUCERS = {
  prime: ["runPrime"],
  "app-home": ["runAppHome"],
  doctor: ["runDoctor"],
  usage: ["runUsage"],
  upgrade: ["runUpgrade"],
  verify: ["emitDeprecationAlias", "runVerify"],
  report: ["runReport"],
  stats: ["emitDeprecationAlias", "runReport"],
  schema: ["runSchema"],
  lint: ["emitDeprecationAlias", "runLint"],
  check: ["runValidate", "runVerify", "runDurability", "runLint", "runCompact", "runGate", "emitInvalidInput"],
  state: ["runQuery", "runState", "emitInvalidInput"],
  query: ["emitDeprecationAlias", "runQuery"],
  compact: ["emitDeprecationAlias", "runCompact", "runGate"],
  validate: ["emitDeprecationAlias", "runValidate"],
  route: ["runRouteRequest", "runRouteReceipt", "runRouteEvaluation", "emitInvalidInput"],
  vision: ["runCapability"],
  discuss: ["runCapability"],
  research: ["runCapability"],
  plan: ["runCapability"],
  build: ["runCapability"],
  optimize: ["runCapability"],
  audit: ["runCapability"],
  document: ["runCapability"],
  profile: ["runCapability"],
  design: ["runCapability"],
  orchestrate: ["runCapability"],
} as const;

export interface OutputRouteInventoryEntry {
  route: string;
  kind: "exception" | "operational" | "error";
  producers: readonly string[];
  success: "text" | "json" | null;
  error: "json";
}

/**
 * Complete output inventory for the live dispatch boundary. The operational
 * rows are checked against the dispatcher command authority, whose activation
 * checks prove parity with the switch, help, schema, and package surfaces.
 */
export const LIVE_OUTPUT_ROUTE_INVENTORY: readonly OutputRouteInventoryEntry[] = [
  { route: "<bare>", kind: "exception", producers: ["applyOutputPolicy", "printTopLevelHelp"], success: "text", error: "json" },
  { route: "--help", kind: "exception", producers: ["applyOutputPolicy", "printTopLevelHelp"], success: "text", error: "json" },
  { route: "<command> --help", kind: "exception", producers: ["applyOutputPolicy", "printCommandHelp", "emitInvalidInput"], success: "text", error: "json" },
  { route: "--version", kind: "exception", producers: ["applyOutputPolicy", "runVersion"], success: "text", error: "json" },
  { route: "prime --guidance", kind: "exception", producers: ["applyOutputPolicy", "runPrime", "cmdPrime"], success: "text", error: "json" },
  { route: "version", kind: "operational", producers: ["applyOutputPolicy", "runVersion"], success: "json", error: "json" },
  ...Object.entries(OPERATIONAL_ROUTE_PRODUCERS).map(([route, producers]) => ({
    route,
    kind: "operational" as const,
    producers: ["applyOutputPolicy", ...producers],
    success: "json" as const,
    error: "json" as const,
  })),
  { route: "<migration guard>", kind: "error", producers: ["enforceProductV1Eol", "enforceCompletedEntityCutover"], success: null, error: "json" },
  { route: "<removed or unknown command>", kind: "error", producers: ["applyOutputPolicy", "emitInvalidInput"], success: null, error: "json" },
];

function hasHelp(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h");
}

export function classifyOutputPath(args: readonly string[]): OutputPathPolicy {
  if (args.length === 0 || hasHelp(args)) return OUTPUT_PATH_POLICIES.help;
  if (args[0] === "--version") return OUTPUT_PATH_POLICIES.version;
  if (args[0] === "prime" && args.includes("--guidance")) return OUTPUT_PATH_POLICIES.prime_guidance;
  return OUTPUT_PATH_POLICIES.operational;
}

function formatSelectors(args: readonly string[]): Array<{ index: number; value: string | null; width: number }> {
  const selectors: Array<{ index: number; value: string | null; width: number }> = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--format") {
      selectors.push({ index, value: args[index + 1] ?? null, width: 2 });
      index++;
    } else if (arg.startsWith("--format=")) {
      selectors.push({ index, value: arg.slice("--format=".length), width: 1 });
    }
  }
  return selectors;
}

export function applyOutputPolicy(args: readonly string[], io: { out?: (text: string) => void; err?: (text: string) => void }): string[] | number {
  const policy = classifyOutputPath(args);
  const selectors = formatSelectors(args);

  if (policy.formatSelector === "reject" && selectors.length > 0) {
    return emitInvalidInput(io, {
      format: "json",
      body: {
        class: "unrecognized_argument",
        message: `${policy.class} output does not accept --format`,
        recovery: "Remove the format selector and retry; no state was changed.",
      },
    });
  }

  if (selectors.some(({ index }) => index === 0)) {
    return emitInvalidInput(io, {
      format: "json",
      body: {
        class: "unrecognized_argument",
        message: "bare output does not accept --format",
        recovery: "Supply a command without a format selector and retry; no state was changed.",
      },
    });
  }

  if ((args[0] === "--help" || args[0] === "-h") && args.length > 1) {
    return emitInvalidInput(io, {
      format: "json",
      body: {
        class: "unrecognized_argument",
        message: `top-level help does not accept arguments: ${args.slice(1).join(" ")}`,
        recovery: "Remove the extra arguments and retry; no state was changed.",
      },
    });
  }

  if (selectors.length > 1 || (selectors.length === 1 && selectors[0].value !== "json")) {
    return emitInvalidInput(io, {
      format: "json",
      body: {
        class: "invalid_choice",
        message: "argument --format: invalid choice (choose from 'json')",
        valid_values: ["json"],
        recovery: "Use or omit the selector; no state was changed.",
      },
    });
  }

  return selectors.length === 0 && policy.class === "operational"
    ? [...args, "--format", "json"]
    : [...args];
}

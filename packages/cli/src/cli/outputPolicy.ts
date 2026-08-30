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

  if (selectors.length > 1 || (selectors.length === 1 && selectors[0].value !== "json")) {
    const value = selectors.length > 1 ? "multiple selectors" : String(selectors[0].value);
    return emitInvalidInput(io, {
      format: "json",
      body: {
        class: "invalid_choice",
        message: `argument --format: invalid choice: '${value}' (choose from 'json')`,
        valid_values: ["json"],
        recovery: "Use --format json or omit the selector; no state was changed.",
      },
    });
  }

  return selectors.length === 0 && policy.class === "operational"
    ? [...args, "--format", "json"]
    : [...args];
}

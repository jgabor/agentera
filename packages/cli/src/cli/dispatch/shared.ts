import {
  emitInvalidInput,
  type InvalidInputErrorBody,
} from "../errors.js";

export type Io = { out?: (t: string) => void; err?: (t: string) => void; stdin?: () => string };

export function emitDeprecationAlias(legacy: string, canonical: string, err: (t: string) => void): void {
  err(`Deprecation: agentera ${legacy} is deprecated; use agentera ${canonical}\n`);
}

/**
 * Map a legacy parse-error string (the kind returned by `parse*Args`) to the
 * canonical invalid-input envelope body. Lets the parse functions keep their
 * simple `{ error: string }` shape while every surface's error path still
 * funnels through `emitInvalidInput` for the frozen envelope contract.
 */
export function classifyParseError(raw: string): InvalidInputErrorBody {
  const required = /^the following arguments are required: (.+)$/.exec(raw);
  if (required) {
    return { class: "missing_argument", message: raw };
  }
  const unrecognized = /^unrecognized arguments: (.+)$/.exec(raw);
  if (unrecognized) {
    return { class: "unrecognized_argument", message: raw };
  }
  const choice = /^argument (--[\w-]+): invalid choice: '([^']+)' \(choose from (.+)\)$/.exec(raw);
  if (choice) {
    const validValues = [...choice[3].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    return {
      class: "invalid_choice",
      message: raw,
      valid_values: validValues,
    };
  }
  const intBad = /^argument (--[\w-]+): invalid int value: '([^']+)'$/.exec(raw);
  if (intBad) {
    return { class: "invalid_int", message: raw };
  }
  const mutex = /^argument (--[\w-]+): not allowed with argument (--[\w-]+)$/.exec(raw);
  if (mutex) {
    return { class: "mutually_exclusive", message: raw };
  }
  return { class: "unrecognized_argument", message: raw };
}

/** Coerce the loose `string` format field on parsed args to the literal union. */
export function asEnvelopeFormat(format: string | undefined | null): "text" | "json" {
  return format === "json" ? "json" : "text";
}

/**
 * Scan a top-level argv slice for `--format json` (or `--format=json`) so
 * main() can decide whether to route its error envelope to stdout or stderr.
 * Unknown format values fall through to "text" — the user will discover the
 * mis-spelling when the underlying command runs.
 */
export function detectTopLevelFormat(args: string[]): "text" | "json" {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--format") {
      const v = args[++i];
      if (v === "json" || v === "text" || v === "yaml") return v === "json" ? "json" : "text";
    } else if (a.startsWith("--format=")) {
      const v = a.slice("--format=".length);
      if (v === "json" || v === "text" || v === "yaml") return v === "json" ? "json" : "text";
    }
  }
  return "text";
}

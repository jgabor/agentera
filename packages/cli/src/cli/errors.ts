/**
 * Canonical invalid-input error envelope for all CLI surfaces.
 *
 * Two output modes:
 *   - json: writes the canonical envelope to stdout, returns rc 2.
 *   - text: writes the four-question guidance template to stderr, returns rc 2.
 *
 * Exit code 2 is reserved for invalid input (per existing CLI convention).
 * Engine failures (rc 1) and pass (rc 0) are handled by the command functions
 * themselves; this helper is for parse-time and run-time input rejection only.
 */

export type InvalidInputErrorClass =
  | "missing_argument"
  | "invalid_choice"
  | "unrecognized_argument"
  | "mutually_exclusive"
  | "invalid_int"
  | "invalid_format"
  | "unsupported_target";

export interface InvalidInputErrorBody {
  class: InvalidInputErrorClass;
  message: string;
  valid_values?: string[];
  syntax?: string;
  example?: string;
}

export interface InvalidInputEnvelope {
  status: "fail";
  error: InvalidInputErrorBody;
}

export interface EmitInvalidInputOptions {
  format: "text" | "json";
  body: InvalidInputErrorBody;
}

export const INVALID_INPUT_EXIT_CODE = 2;

const TEXT_GUIDANCE_LINES = [
  "What happened: {message}",
  "What the preview did: nothing; only the input was rejected.",
  "What the recommended fix will do: take the corrected input and continue.",
  "What it will not do: edit your project files, run live commands, or change unknown state.",
] as const;

export function emitInvalidInput(
  io: { out?: (t: string) => void; err?: (t: string) => void },
  opts: EmitInvalidInputOptions,
): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));

  if (opts.format === "json") {
    const envelope: InvalidInputEnvelope = {
      status: "fail",
      error: opts.body,
    };
    out(JSON.stringify(envelope) + "\n");
    return INVALID_INPUT_EXIT_CODE;
  }

  const lines: string[] = [];
  for (const tmpl of TEXT_GUIDANCE_LINES) {
    lines.push(tmpl.replace("{message}", opts.body.message));
  }
  if (opts.body.valid_values && opts.body.valid_values.length > 0) {
    lines.push("");
    lines.push("Valid values:");
    for (const v of opts.body.valid_values) {
      lines.push(`  - ${v}`);
    }
  }
  if (opts.body.syntax) {
    lines.push("");
    lines.push(`Syntax: ${opts.body.syntax}`);
  }
  if (opts.body.example) {
    lines.push("");
    lines.push("Example:");
    lines.push(`  ${opts.body.example}`);
  }
  err(lines.join("\n") + "\n");
  return INVALID_INPUT_EXIT_CODE;
}

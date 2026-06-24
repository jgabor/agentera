import path from "node:path";

import { emitStructured } from "../structured.js";

/** Port of scripts/agentera cmd_capability (capability-name routing guidance). */

type Io = { out?: (t: string) => void; err?: (t: string) => void };

export const CAPABILITY_ROUTING_NAMES = [
  "vision", "discuss", "research", "plan", "build",
  "optimize", "audit", "document", "profile", "design", "orchestrate",
];

const PRIME_CAPABILITY_CONTEXT_COMMAND = "agentera prime --context {capability} --format json";

export function cmdCapability(capability: string, args: { format?: string }, io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const instructionsPath = `packages/cli/src/capabilities/${capability}/instructions.ts`;
  const startupContext = PRIME_CAPABILITY_CONTEXT_COMMAND.replace("{capability}", capability);
  const payload = {
    command: capability,
    status: "ok",
    capability,
    routing: {
      skill_invocation: `/agentera ${capability}`,
      instructions_path: instructionsPath,
      startup_context: startupContext,
      routine_state_reads:
        "Use top-level agentera state commands for artifact reads; " +
        `agentera ${capability} emits capability routing guidance only.`,
    },
  };
  const format = args.format ?? "text";
  if (format === "json") {
    emitStructured(payload, "json", out);
  } else {
    out(`agentera ${capability}\n`);
    out(`capability: ${capability}\n`);
    out(`invoke: /agentera ${capability} via Agentera skill routing\n`);
    out(`instructions: ${instructionsPath}\n`);
    out(`startup context: ${startupContext}\n`);
    out("note: capability routing guidance only; not a routine state read\n");
  }
  return 0;
}

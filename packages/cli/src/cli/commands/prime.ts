import { PRIME_BLOB } from "../prime-blob.js";
import { BESPOKE_CONTEXT_CAPABILITIES, buildPrimeCapabilityContextPayload, validatePrimeCapability } from "../capabilityContext.js";
import { collectOrientationState } from "./prime/collectOrientationState.js";
import { buildOrientationJsonPayload, emitPrime, printOrientationTextBriefing } from "./prime/orientationOutput.js";
import type { PrimeArgs, Io } from "./prime/types.js";

export type { OrientationState } from "../contracts/orientationState.js";
export type { PrimeArgs } from "./prime/types.js";
export { collectOrientationState } from "./prime/collectOrientationState.js";

/**
 * prime orientation command. Port of scripts/agentera cmd_prime / cmd_status.
 * The text briefing (default) and --guidance are wired; the JSON/dashboard/
 * context paths depend on the 5 bespoke capability contexts (pending slice).
 */

export function cmdPrime(args: PrimeArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const command = args.command ?? "prime";
  const capability = args.context ?? null;
  const dashboard = Boolean(args.dashboard || args.orientation);
  const guidance = Boolean(args.guidance);
  if (capability !== null && dashboard) {
    err("Error: prime --context and prime --dashboard/--orientation are mutually exclusive\n");
    return 2;
  }
  if (capability !== null && guidance) {
    err("Error: prime --context and prime --guidance are mutually exclusive\n");
    return 2;
  }
  if (dashboard && guidance) {
    err("Error: prime --dashboard/--orientation and prime --guidance are mutually exclusive\n");
    return 2;
  }
  if (guidance) {
    out(PRIME_BLOB);
    return 0;
  }
  const format = args.format ?? "text";
  const collectOpts = { home: args.home, installRoot: args.installRoot, expectedVersion: args.expectedVersion };

  if (capability !== null) {
    try {
      validatePrimeCapability(capability);
    } catch (exc) {
      err(`Error: ${(exc as Error).message}\n`);
      return 2;
    }
    if (format === "text") {
      err("Error: prime --context requires --format json\n");
      return 2;
    }
    if (BESPOKE_CONTEXT_CAPABILITIES.has(capability)) {
      err("agentera: prime --context for this capability is not yet ported (pending its bespoke context)\n");
      return 1;
    }
    const state = collectOrientationState(collectOpts);
    const payload = buildPrimeCapabilityContextPayload(state, capability, command);
    return emitPrime(command, payload, format, args.fields, out, err);
  }
  if (dashboard) {
    if (format === "text") {
      err("Error: prime --dashboard requires --format json\n");
      return 2;
    }
    const state = collectOrientationState(collectOpts);
    const payload = buildOrientationJsonPayload(state, command);
    return emitPrime(command, payload, format, args.fields, out, err);
  }
  const state = collectOrientationState(collectOpts);
  if (format !== "text") {
    const payload = buildOrientationJsonPayload(state, command);
    return emitPrime(command, payload, format, args.fields, out, err);
  }
  printOrientationTextBriefing(state, command, out);
  return 0;
}

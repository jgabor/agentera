import { PRIME_BLOB } from "../prime-blob.js";
import { buildPrimeCapabilityContextPayload, validatePrimeCapability } from "../capabilityContext.js";
import { collectOrientationState } from "./prime/collectOrientationState.js";
import {
  buildOrientationJsonPayload,
  buildStatusContextState,
  emitPrime,
  PRIME_BRIEF_MAX_UTF8_BYTES,
  PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES,
  printOrientationTextBriefing,
} from "./prime/orientationOutput.js";
import { briefUtf8Bytes } from "./prime/briefOrientation.js";
import type { PrimeArgs, Io } from "./prime/types.js";
import type { OrientationState } from "../contracts/orientationState.js";
import { startupSurfaceBudget } from "../../state/retrievalAuthority.js";

export type { OrientationState } from "../contracts/orientationState.js";
export type { PrimeArgs } from "./prime/types.js";
export { collectOrientationState } from "./prime/collectOrientationState.js";

export function buildStatusCapabilityContextPayload(state: OrientationState, command = "prime"): Record<string, unknown> {
  const payload = buildPrimeCapabilityContextPayload(state, "status", command);
  return finalizeStatusCapabilityContextPayload(payload, state, command);
}

export function finalizeStatusCapabilityContextPayload(
  payload: Record<string, unknown>,
  state: OrientationState,
  command = "prime",
): Record<string, unknown> {
  const capabilityContext = payload.capability_context as Record<string, unknown>;
  const context = capabilityContext.context as Record<string, unknown>;
  // status_context carries the dashboard state, so only remove generic rich
  // copies already projected there. Contract-owned startup metadata remains.
  delete capabilityContext.app;
  delete capabilityContext.profile;
  const startupState = capabilityContext.state as Record<string, unknown>;
  delete startupState.write_contract;
  delete startupState.retrieval_contract;
  delete context.history;
  // status_context already carries the canonical bounded plan projection.
  delete context.plan;
  let statusBudget = PRIME_BRIEF_MAX_UTF8_BYTES;
  let previousStatusBytes = Number.POSITIVE_INFINITY;
  while (true) {
    context.status_context = buildStatusContextState(state, command, {
      budgetBytes: statusBudget,
      degradedMode: statusBudget < PRIME_BRIEF_MAX_UTF8_BYTES ? "status_routing" : "minimal",
    });
    if (briefUtf8Bytes(payload) <= PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES) break;
    const statusBytes = briefUtf8Bytes(context.status_context);
    if (statusBytes >= previousStatusBytes) {
      throw new Error("status context budget projection did not decrease toward the complete capsule budget");
    }
    previousStatusBytes = statusBytes;
    // One byte below the actual serialized projection forces the next bounded
    // form. Unlike subtracting the outer overage, this transition is monotonic
    // even when the current projection still sits below its prior allowance.
    statusBudget = statusBytes - 1;
  }
  return payload;
}

/**
 * prime orientation command. Port of scripts/agentera cmd_prime / cmd_status.
 * The text briefing (default), --guidance, --dashboard, --context, and
 * --format json paths are all wired.
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
    const state = collectOrientationState(collectOpts);
    const payload = capability === "status"
      ? buildStatusCapabilityContextPayload(state, command)
      : buildPrimeCapabilityContextPayload(state, capability, command);
    return emitPrime(command, payload, format, args.fields, out, err, {
      maxUtf8Bytes: capability === "status" ? PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES : undefined,
    });
  }
  if (dashboard) {
    if (format === "text") {
      err("Error: prime --dashboard requires --format json\n");
      return 2;
    }
    const state = collectOrientationState(collectOpts);
    const payload = buildOrientationJsonPayload(state, command);
    return emitPrime(command, payload, format, args.fields, out, err, {
      maxUtf8Bytes: startupSurfaceBudget("prime_dashboard"),
    });
  }
  const state = collectOrientationState(collectOpts);
  if (format !== "text") {
    const payload = buildOrientationJsonPayload(state, command);
    // Bare default: project to the bounded decision brief (prime-briefing,
    // 12000-byte budget). Explicit `--fields` selection keeps full payload.
    return emitPrime(command, payload, format, args.fields, out, err, { bareBrief: true });
  }
  printOrientationTextBriefing(state, command, out);
  return 0;
}

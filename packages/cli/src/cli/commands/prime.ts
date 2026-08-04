import { PRIME_BLOB } from "../prime-blob.js";
import { buildPrimeCapabilityContextPayload, validatePrimeCapability } from "../capabilityContext.js";
import { collectOrientationState } from "./prime/collectOrientationState.js";
import {
  buildOrientationJsonPayload,
  buildStatusContextState,
  emitPrime,
  rejectRetiredPrimeFields,
  PRIME_BRIEF_MAX_UTF8_BYTES,
  PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES,
  printOrientationTextBriefing,
} from "./prime/orientationOutput.js";
import type { PrimeArgs, Io } from "./prime/types.js";
import type { OrientationState } from "../contracts/orientationState.js";
import { emitInvalidInput } from "../errors.js";
import {
  BuildExecutionRequestError,
  loadBuildExecutionRequest,
  type BuildExecutionRequest,
} from "./prime/buildExecutionRequest.js";
import { preCutoverCommand } from "../preCutoverCommand.js";

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
  // status_context carries the dashboard state. Startup availability remains
  // singular on capability_context.startup.
  delete capabilityContext.app;
  // status_context already carries the canonical bounded plan projection.
  delete context.plan;
  context.status_context = buildStatusContextState(state, command, {
    budgetBytes: PRIME_BRIEF_MAX_UTF8_BYTES,
    degradedMode: "status_routing",
  });
  return payload;
}

/**
 * prime orientation command. Port of scripts/agentera cmd_prime / cmd_status.
 * The text briefing (default), --guidance, deprecated --dashboard, --context,
 * and --format json paths are all wired.
 */

export function cmdPrime(args: PrimeArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const command = args.command ?? "prime";
  const capability = args.context ?? null;
  const dashboard = Boolean(args.dashboard || args.orientation);
  const guidance = Boolean(args.guidance);
  const input = args.input ?? null;
  const format = args.format ?? "text";
  const inputErrorFormat = args.format === "json" || args.format === "yaml" ? args.format : "text";
  const rejectInput = (body: Parameters<typeof emitInvalidInput>[1]["body"]): number =>
    emitInvalidInput(io, { format: inputErrorFormat, body });
  if (input !== null && (capability !== "build" || dashboard || guidance)) {
    return rejectInput({
      class: "unsupported_target",
      message: "--input is valid only with prime --context build",
      syntax: preCutoverCommand("prime --context build --input <file|-> --format json"),
    });
  }
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
  const retiredFieldRejection = rejectRetiredPrimeFields(command, format, args.fields, out, err);
  if (retiredFieldRejection !== null) return retiredFieldRejection;
  if (guidance) {
    out(PRIME_BLOB);
    return 0;
  }
  const collectOpts = {
    projectRoot: args.projectRoot,
    home: args.home,
    installRoot: args.installRoot,
    expectedVersion: args.expectedVersion,
  };

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
    let buildRequest: BuildExecutionRequest | null = null;
    if (input !== null) {
      try {
        buildRequest = loadBuildExecutionRequest(input, io.stdin);
      } catch (error) {
        if (error instanceof BuildExecutionRequestError) return rejectInput(error.body);
        return rejectInput({ class: "invalid_format", message: "Build execution request input could not be read" });
      }
    }
    const state = collectOrientationState(collectOpts);
    if (buildRequest !== null && state.plan.active === true) {
      return rejectInput({
        class: "conflict",
        message: "Transient no-plan Build input conflicts with the current plan-owned execution context",
        recovery: "Run Build without --input for the current plan, or close/archive that plan before retrying; no state was changed.",
      });
    }
    const payload = capability === "status"
      ? buildStatusCapabilityContextPayload(state, command)
      : buildPrimeCapabilityContextPayload(state, capability, command, buildRequest);
    return emitPrime(command, payload, format, args.fields, out, err, {
      maxUtf8Bytes: capability === "status" ? PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES : undefined,
    });
  }
  if (dashboard) {
    if (format === "text") {
      err("Error: prime --dashboard requires --format json\n");
      return 2;
    }
    err("Deprecation: prime --dashboard is retained as an alias for `prime --context status --format json`; use the status startup capsule directly.\n");
    const state = collectOrientationState(collectOpts);
    const payload = buildStatusCapabilityContextPayload(state, command);
    return emitPrime(command, payload, format, args.fields, out, err, {
      maxUtf8Bytes: PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES,
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

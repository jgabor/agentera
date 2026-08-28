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
import { loadSelectedTermInput, SelectedTermInputError } from "./prime/selectedTermInput.js";
import { acquireGlossaryInputs } from "../../analytics/glossaryInputAcquisition.js";
import { resolveStartupGlossaryAdvice } from "../capabilityContext/startupGlossaryAdvice.js";
import { discoverSchemasDir } from "../appContext.js";
import { registryArtifactPath } from "../orientation.js";

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
  const termInput = args.termInput ?? null;
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
  if (termInput !== null && (!capability || !["discuss", "plan", "build"].includes(capability) || dashboard || guidance)) {
    return rejectInput({
      class: "unsupported_target",
      message: "--term-input is valid only with prime --context discuss, plan, or build",
      syntax: preCutoverCommand("prime --context <discuss|plan|build> --term-input <file|-> --format json"),
    });
  }
  if (input === "-" && termInput === "-") {
    return rejectInput({ class: "conflicting_stdin", message: "--input and --term-input cannot both read stdin" });
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
  if (dashboard && args.fields !== undefined) {
    const migrationCommand = preCutoverCommand("prime --context status --format json");
    return rejectInput({
      class: "mutually_exclusive",
      message: "Deprecated prime --dashboard --fields selectors are not supported during status-capsule migration",
      example: migrationCommand,
      diagnosis: {
        migration_command: migrationCommand,
        consumer_path: "capability_context.context.status_context",
      },
      recovery: `Run '${migrationCommand}' and read capability_context.context.status_context; no state was changed.`,
    });
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
    let selectedTerm: string | null = null;
    if (input !== null) {
      try {
        buildRequest = loadBuildExecutionRequest(input, io.stdin);
      } catch (error) {
        if (error instanceof BuildExecutionRequestError) return rejectInput(error.body);
        return rejectInput({ class: "invalid_format", message: "Build execution request input could not be read" });
      }
    }
    if (termInput !== null) {
      try {
        selectedTerm = loadSelectedTermInput(termInput, io.stdin);
      } catch (error) {
        if (error instanceof SelectedTermInputError) {
          return rejectInput({ class: "invalid_selected_term", message: "--term-input must be one non-empty bounded UTF-8 scalar" });
        }
        return rejectInput({ class: "invalid_selected_term", message: "--term-input could not be read" });
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
    let glossaryAdvice = null;
    if (selectedTerm !== null) {
      try {
        const profilePath = registryArtifactPath("profile", discoverSchemasDir());
        glossaryAdvice = resolveStartupGlossaryAdvice(
          capability,
          selectedTerm,
          acquireGlossaryInputs(args.projectRoot ?? process.cwd(), profilePath),
        );
      } catch {
        return rejectInput({ class: "invalid_selected_term", message: "glossary advice could not be resolved" });
      }
    }
    const payload = capability === "status"
      ? buildStatusCapabilityContextPayload(state, command)
      : buildPrimeCapabilityContextPayload(state, capability, command, buildRequest, glossaryAdvice);
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

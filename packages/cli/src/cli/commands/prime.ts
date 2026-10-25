import fs from "node:fs";

import { PRIME_MANUAL } from "../prime-blob.js";
import { buildPrimeCapabilityContextPayload, validatePrimeCapability } from "../capabilityContext.js";
import { collectOrientationState } from "./prime/collectOrientationState.js";
import { bareBriefPayload, buildOrientationJsonPayload, fitRoutedResponse, routedStartBudgetBytes, buildStatusContextState, emitPrime, rejectRetiredPrimeFields, statusStateUtf8Bytes, PRIME_BRIEF_MAX_UTF8_BYTES, STATUS_STATE_MAX_UTF8_BYTES, STATUS_STATE_TOKEN_BUDGET } from "./prime/orientationOutput.js";
import type { PrimeArgs, Io } from "./prime/types.js";
import type { OrientationState } from "../contracts/orientationState.js";

export const PRIME_STRUCTURED_INPUT_SPECS = [
  { context: "build", option: "--input" },
  { context: "build", option: "--term-input" },
  { context: "discuss", option: "--term-input" },
  { context: "plan", option: "--term-input" },
] as const;

const PRIME_INPUT_CONTEXTS = new Set<string>(PRIME_STRUCTURED_INPUT_SPECS.filter(({ option }) => option === "--input").map(({ context }) => context));
const PRIME_TERM_INPUT_CONTEXTS = new Set<string>(PRIME_STRUCTURED_INPUT_SPECS.filter(({ option }) => option === "--term-input").map(({ context }) => context));
import { emitInvalidInput } from "../errors.js";
import { BuildExecutionRequestError, loadBuildExecutionRequest, type BuildExecutionRequest } from "./prime/buildExecutionRequest.js";
import { preCutoverCommand } from "../preCutoverCommand.js";
import { loadSelectedTermInput, SelectedTermInputError } from "./prime/selectedTermInput.js";
import { acquireGlossaryInputs } from "../../analytics/glossaryInputAcquisition.js";
import { resolveStartupGlossaryAdvice } from "../capabilityContext/startupGlossaryAdvice.js";
import { discoverSchemasDir } from "../appContext.js";
import { registryArtifactPath } from "../orientation.js";
import { briefUtf8Bytes } from "./prime/briefOrientation.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { isCorruptSuiteVersion, readSuiteVersion } from "../../upgrade/appModel.js";
import { emitStartupFailure } from "../startupFailure.js";
import { emitStructured } from "../structured.js";
import { enforceCompletedEntityCutover, migrationProject, requiresCompletedEntityCutover } from "../migrationRequired.js";
import { HybridRouteRegistryError, resolveRouteRequest, type RouteResponse } from "../../registries/hybridRoute.js";
import { loadPrimeRouteRequest, PrimeRouteRequestError } from "./route.js";

export type { OrientationState } from "../contracts/orientationState.js";
export type { PrimeArgs } from "./prime/types.js";
export { collectOrientationState } from "./prime/collectOrientationState.js";

export function buildStatusCapabilityContextPayload(state: OrientationState, command = "prime"): Record<string, unknown> {
  const payload = buildPrimeCapabilityContextPayload(state, "status", command);
  return finalizeStatusCapabilityContextPayload(payload, state, command);
}

export function finalizeStatusCapabilityContextPayload(payload: Record<string, unknown>, state: OrientationState, command = "prime"): Record<string, unknown> {
  const capabilityContext = payload.capability_context as Record<string, unknown>;
  const context = capabilityContext.context as Record<string, unknown>;
  // status_context carries the dashboard state. Startup availability remains
  // singular on capability_context.startup.
  delete capabilityContext.app;
  // status_context already carries the canonical bounded plan projection.
  delete context.plan;
  // Startup carries host-health facts, not the repeated diagnostic narrative
  // and repair procedure. Keep the exact, home-scoped read-only preview as the
  // continuation; full diagnostics still live in doctor and explicit prime
  // --fields shared_skill. Do not trim instructions or static detail actions.
  const { message: _message, path: _path, details: _details, ...sharedSkill } = state.shared_skill;
  payload.shared_skill = { ...sharedSkill, detail_availability: "summary" };
  // The instructions are already delivered in full. Repeating their loader
  // paths, provenance and first-read explanation is not dashboard state.
  const firstRead = context.first_invocation_read as Record<string, unknown> | undefined;
  if (firstRead)
    context.first_invocation_read = {
      value: firstRead.value,
      startup_command: firstRead.startup_command,
      runtime_enforcement: firstRead.runtime_enforcement,
    };
  context.status_context = buildStatusContextState(state, command, {
    budgetBytes: PRIME_BRIEF_MAX_UTF8_BYTES,
    degradedMode: "status_routing",
  });
  // Unsafe TODO ownership is already the blocking recommendation. The risk
  // IDs and exact correction remain here; defer repeated reconciliation
  // accounting and lower-ranked suggestions through existing sparse reads.
  const startup = capabilityContext.startup as Record<string, unknown>;
  const reconciliation = startup.todo_reconciliation as Record<string, unknown> | undefined;
  if (reconciliation?.state === "unsafe_inactive") {
    const { counts: _counts, apply_command: _apply, ...summary } = reconciliation;
    startup.todo_reconciliation = {
      ...summary,
      detail_availability: "summary",
      detail_command: preCutoverCommand("prime --fields startup"),
    };
  }
  const status = context.status_context as Record<string, unknown>;
  if (reconciliation?.state === "unsafe_inactive") omitAlternatives(status, 0);
  trimStatusState(payload, status);
  return payload;
}

/** Status keeps at most this many lower-ranked suggestions and attention lines
 *  when state is over budget; the dashboard needs no more. */
const TRIMMED_ALTERNATIVES = 2;
const TRIMMED_ATTENTION = 5;

function omitAlternatives(status: Record<string, unknown>, keep: number): number {
  const next = status.next_action as Record<string, unknown>;
  const alternatives = next.alternatives as unknown[];
  if (alternatives.length <= keep) return 0;
  const priorOmitted = Number((next.alternatives_omission as Record<string, unknown> | undefined)?.omitted_count ?? 0);
  next.alternatives = alternatives.slice(0, keep);
  next.alternatives_omission = {
    omitted_count: priorOmitted + alternatives.length - keep,
    retrieval: preCutoverCommand("prime --fields next_action"),
  };
  return alternatives.length - keep;
}

/**
 * Bring status state within its budget instead of refusing: cut alternatives
 * and attention to what the dashboard renders, then drop the remaining
 * alternatives. Instructions, the primary action and
 * offers are never trimmed. The result reports what was cut and whether state
 * now fits.
 */
function trimStatusState(payload: Record<string, unknown>, status: Record<string, unknown>): void {
  if (statusStateUtf8Bytes(payload) <= STATUS_STATE_MAX_UTF8_BYTES) return;
  let omitted = omitAlternatives(status, TRIMMED_ALTERNATIVES);
  const attention = status.attention as unknown[];
  if (attention.length > TRIMMED_ATTENTION) {
    omitted += attention.length - TRIMMED_ATTENTION;
    status.attention = attention.slice(0, TRIMMED_ATTENTION);
  }
  if (statusStateUtf8Bytes(payload) > STATUS_STATE_MAX_UTF8_BYTES) omitted += omitAlternatives(status, 0);
  status.state_budget = {
    token_budget: STATUS_STATE_TOKEN_BUDGET,
    max_utf8_bytes: STATUS_STATE_MAX_UTF8_BYTES,
    utf8_bytes: 0,
    within_budget: false,
    omitted: true,
    omitted_count: omitted,
    omission_reason: "status_state_budget",
    retrieval: {
      next_action: preCutoverCommand("prime --fields next_action"),
      attention: preCutoverCommand("prime --fields attention"),
    },
  };
  const budget = status.state_budget as Record<string, unknown>;
  budget.utf8_bytes = statusStateUtf8Bytes(payload);
  budget.within_budget = (budget.utf8_bytes as number) <= STATUS_STATE_MAX_UTF8_BYTES;
}

/** The payload `prime --context <capability>` emits. */
function capabilityStartPayload(state: OrientationState, capability: string, command: string, buildRequest: BuildExecutionRequest | null = null, glossaryAdvice: Parameters<typeof buildPrimeCapabilityContextPayload>[4] = null): Record<string, unknown> {
  return capability === "status" ? buildStatusCapabilityContextPayload(state, command) : buildPrimeCapabilityContextPayload(state, capability, command, buildRequest, glossaryAdvice);
}

/** The refusal a direct `prime --context <capability>` start gets from the
 *  project gate, with its exit code, or null when the start may proceed. */
function directStartRefusal(capability: string, projectRoot: string | null): { body: Record<string, unknown>; exitCode: number } | null {
  const argv = ["prime", "--context", capability];
  if (!requiresCompletedEntityCutover(argv)) return null;
  let text = "";
  const capture = (chunk: string) => {
    text += chunk;
  };
  const exitCode = enforceCompletedEntityCutover(migrationProject(argv, projectRoot ?? process.cwd()), "json", { out: capture, err: capture }, argv);
  return exitCode === null ? null : { body: JSON.parse(text) as Record<string, unknown>, exitCode };
}

/** Route one request in-process and carry the unchanged route result. A
 *  deterministic selection starts its capability in the same call: status
 *  gets the manual and its capsule (status_context already orients), others
 *  get the bare brief and their capsule. semantic_required starts nothing. */
function runRoutedPrime(request: string, command: string, collectOpts: Parameters<typeof collectOrientationState>[0], projectRoot: string | null, out: (text: string) => void, rejectInput: (body: Parameters<typeof emitInvalidInput>[1]["body"]) => number): number {
  let route: RouteResponse;
  try {
    route = resolveRouteRequest(request);
  } catch (error) {
    if (error instanceof HybridRouteRegistryError) return rejectInput({ class: "conflict", message: "routing authority validation failed before routing" });
    return rejectInput({ class: "invalid_request", message: "route request could not be resolved" });
  }
  const capability = route.outcome === "deterministic_selection" ? route.capability : null;
  const budget = routedStartBudgetBytes(route);
  const overBudget = (bytes: number): number => {
    const recovery = capability === null ? preCutoverCommand("route request --input -") : preCutoverCommand(`prime --context ${capability}`);
    emitStructured(
      {
        command,
        outcome: "blocked",
        manual: PRIME_MANUAL,
        route,
        error: { class: "routed_output_budget", message: `routed prime output needs ${bytes} UTF-8 bytes, over its ${budget}-byte budget`, budget_utf8_bytes: budget, utf8_bytes: bytes, recovery: `Run \`${recovery}\`.` },
      },
      "json",
      out,
    );
    return 1;
  };
  const refusal = capability === null ? null : directStartRefusal(capability, projectRoot);
  const state = collectOrientationState(collectOpts);
  if (capability === "status") {
    // Status is never gated; its capsule already carries the orientation.
    const start = capabilityStartPayload(state, capability, command);
    const response = { command, manual: PRIME_MANUAL, route, start };
    // The capsule already trimmed its state; a routed status start never refuses for size.
    emitStructured(response, "json", out);
    return 0;
  }
  // The start uses its own copy because capsule builders reshape shared state.
  const start = capability !== null && refusal === null ? capabilityStartPayload(structuredClone(state), capability, command) : null;
  const carried = { route, ...(refusal ? { refusal: refusal.body } : {}), ...(start ? { start } : {}) };
  const fit = fitRoutedResponse(budget, { command, manual: PRIME_MANUAL }, carried, (briefBudget) => bareBriefPayload(buildOrientationJsonPayload(state, command), briefBudget), preCutoverCommand("prime"));
  if (!fit.fits) return overBudget(fit.bytes);
  emitStructured(fit.response, "json", out);
  return refusal ? refusal.exitCode : 0;
}

/**
 * prime orientation command. Port of scripts/agentera cmd_prime / cmd_status.
 * The JSON orientation, --guidance, deprecated --dashboard, and --context
 * paths are all wired.
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
  const format = args.format ?? "json";
  const inputErrorFormat = "json";
  const rejectInput = (body: Parameters<typeof emitInvalidInput>[1]["body"]): number => emitInvalidInput(io, { format: inputErrorFormat, body });
  if (format !== "json") {
    return rejectInput({
      class: "invalid_choice",
      message: `argument --format: invalid choice: '${format}' (choose from 'json')`,
      valid_values: ["json"],
    });
  }
  // Without --context, --input carries a route request; with it, a build request.
  const routedInput = input !== null && capability === null && !dashboard && !guidance;
  if (routedInput && args.fields !== undefined && args.fields !== null) {
    return rejectInput({
      class: "mutually_exclusive",
      message: "prime --input and prime --fields are mutually exclusive",
      syntax: preCutoverCommand("prime --input <file|->"),
    });
  }
  if (input !== null && !routedInput && (!capability || !PRIME_INPUT_CONTEXTS.has(capability) || dashboard || guidance)) {
    return rejectInput({
      class: "unsupported_target",
      message: "--input is valid alone, as a route request, or with prime --context build",
      syntax: `${preCutoverCommand("prime --input <file|->")} | ${preCutoverCommand("prime --context build --input <file|->")}`,
    });
  }
  if (termInput !== null && (!capability || !PRIME_TERM_INPUT_CONTEXTS.has(capability) || dashboard || guidance)) {
    return rejectInput({
      class: "unsupported_target",
      message: "--term-input is valid only with prime --context discuss, plan, or build",
      syntax: preCutoverCommand("prime --context <discuss|plan|build> --term-input <file|->"),
    });
  }
  if (input === "-" && termInput === "-") {
    return rejectInput({
      class: "conflicting_stdin",
      message: "--input and --term-input cannot both read stdin",
    });
  }
  if (capability !== null && dashboard) {
    return rejectInput({
      class: "mutually_exclusive",
      message: "prime --context and prime --dashboard/--orientation are mutually exclusive",
    });
  }
  if (capability !== null && guidance) {
    return rejectInput({
      class: "mutually_exclusive",
      message: "prime --context and prime --guidance are mutually exclusive",
    });
  }
  if (dashboard && guidance) {
    return rejectInput({
      class: "mutually_exclusive",
      message: "prime --dashboard/--orientation and prime --guidance are mutually exclusive",
    });
  }
  if (dashboard && args.fields !== undefined) {
    const migrationCommand = preCutoverCommand("prime --context status");
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
    out(`${PRIME_MANUAL}\n`);
    return 0;
  }
  // A CLI that cannot read its own version cannot report a trustworthy startup.
  const versionAuthority = readSuiteVersion(resolveSourceRoot());
  if (isCorruptSuiteVersion(versionAuthority)) return emitStartupFailure(io, { classification: "version_authority_invalid", reason: versionAuthority.reason }, command);
  const collectOpts = {
    projectRoot: args.projectRoot,
    home: args.home,
    installRoot: args.installRoot,
    expectedVersion: args.expectedVersion,
  };

  if (routedInput) {
    let request: string;
    try {
      request = loadPrimeRouteRequest(input, io.stdin);
    } catch (error) {
      if (error instanceof PrimeRouteRequestError) return rejectInput(error.body);
      return rejectInput({ class: "invalid_format", message: "route request input could not be read" });
    }
    return runRoutedPrime(request, command, collectOpts, args.projectRoot ?? null, out, rejectInput);
  }

  if (capability !== null) {
    try {
      validatePrimeCapability(capability);
    } catch (exc) {
      return rejectInput({ class: "unsupported_target", message: (exc as Error).message });
    }
    let buildRequest: BuildExecutionRequest | null = null;
    let selectedTerm: string | null = null;
    if (input !== null) {
      try {
        buildRequest = loadBuildExecutionRequest(input, io.stdin);
      } catch (error) {
        if (error instanceof BuildExecutionRequestError) return rejectInput(error.body);
        return rejectInput({
          class: "invalid_format",
          message: "Build execution request input could not be read",
        });
      }
    }
    if (termInput !== null) {
      try {
        selectedTerm = loadSelectedTermInput(termInput, io.stdin);
      } catch (error) {
        if (error instanceof SelectedTermInputError) {
          return rejectInput({
            class: "invalid_selected_term",
            message: "--term-input must be one non-empty bounded UTF-8 scalar",
          });
        }
        return rejectInput({
          class: "invalid_selected_term",
          message: "--term-input could not be read",
        });
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
        glossaryAdvice = resolveStartupGlossaryAdvice(capability, selectedTerm, acquireGlossaryInputs(args.projectRoot ?? process.cwd(), profilePath), { profilePresent: fs.existsSync(profilePath) });
      } catch {
        return rejectInput({
          class: "invalid_selected_term",
          message: "glossary advice could not be resolved",
        });
      }
    }
    const payload = capabilityStartPayload(state, capability, command, buildRequest, glossaryAdvice);
    return emitPrime(command, payload, format, args.fields, out, err);
  }
  if (dashboard) {
    err("Deprecation: prime --dashboard is retained as an alias for `prime --context status`; use the status startup capsule directly.\n");
    const state = collectOrientationState(collectOpts);
    const payload = buildStatusCapabilityContextPayload(state, command);
    return emitPrime(command, payload, format, args.fields, out, err);
  }
  const state = collectOrientationState(collectOpts);
  const payload = buildOrientationJsonPayload(state, command);
  // Bare default: project to the bounded decision brief (prime-briefing,
  // 16000-byte budget). Explicit `--fields` selection keeps full payload.
  return emitPrime(command, payload, format, args.fields, out, err, { bareBrief: true });
}

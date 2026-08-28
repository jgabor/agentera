import fs from "node:fs";

import { acquireGlossaryInputs } from "../../analytics/glossaryInputAcquisition.js";
import {
  GlossaryAdviceInputError,
  resolveGlossaryAdvice,
  type GlossaryAdviceHostReview,
} from "../../analytics/glossaryAdviceResolution.js";
import { loadYamlMapping } from "../../core/yaml.js";
import { glossaryAdviceContract } from "../../registries/glossaryAdviceContract.js";
import { discoverSchemasDir } from "../appContext.js";
import type { Io } from "../dispatch/shared.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { registryArtifactPath } from "../orientation.js";
import { emitStructured } from "../structured.js";
import { loadSelectedTermInput, SelectedTermInputError } from "./prime/selectedTermInput.js";

type Mapping = Record<string, unknown>;

const contract = glossaryAdviceContract();
const COMMAND = contract.command.replace("REQUEST", "<file|->");
const RECOVERY = `Correct the bounded request and retry ${COMMAND}; no state was changed.`;
const TERM_INPUT_RECOVERY = "agentera report glossary-advice --term-input <file|-> --format json";

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function invalid(io: Io, body: InvalidInputErrorBody, recovery = RECOVERY): number {
  return emitInvalidInput(io, { format: "json", body: { ...body, recovery } });
}

type AdviceSource = { input: string } | { termInput: string };

function parseArgs(argv: string[]): AdviceSource | InvalidInputErrorBody {
  let input: string | undefined;
  let termInput: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index]!.split("=", 2);
    if (name !== "--input" && name !== "--term-input" && name !== "--format") {
      return {
        class: "unrecognized_argument",
        message: `unrecognized arguments: ${name}`,
        syntax: COMMAND,
      };
    }
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) {
      return {
        class: "missing_argument",
        message: `${name} requires a value`,
        syntax: `${name} VALUE`,
      };
    }
    if (name === "--format" && value !== "json") {
      return {
        class: "invalid_choice",
        message: "glossary-advice requires --format json",
        valid_values: ["json"],
      };
    }
    if (name === "--input") {
      if (input !== undefined)
        return { class: "mutually_exclusive", message: "--input may only be supplied once" };
      input = value;
    } else if (name === "--term-input") {
      if (termInput !== undefined)
        return { class: "mutually_exclusive", message: "--term-input may only be supplied once" };
      termInput = value;
    }
  }
  if (input !== undefined && termInput !== undefined)
    return { class: "mutually_exclusive", message: "--input and --term-input are mutually exclusive" };
  if (input !== undefined) return { input };
  if (termInput !== undefined) return { termInput };
  return { class: "missing_argument", message: "--input or --term-input is required", syntax: COMMAND };
}

function readRequest(source: string, io: Io): Mapping {
  const bytes =
    source === "-"
      ? Buffer.from(io.stdin ? io.stdin() : fs.readFileSync(0))
      : fs.readFileSync(source);
  if (bytes.length > contract.maxRequestUtf8Bytes) throw new Error("over bound");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const request = mapping(loadYamlMapping(text));
  if (!request) throw new Error("not a mapping");
  return request;
}

function validatedRequest(
  request: Mapping,
): { requestedTerm: string; hostReview?: GlossaryAdviceHostReview } | InvalidInputErrorBody {
  const keys = Object.keys(request);
  if (
    keys.some((key) => !contract.requestFields.includes(key)) ||
    contract.requestFields.slice(0, 2).some((key) => !(key in request))
  ) {
    return {
      class: "schema_violation",
      message: "glossary advice request fields are invalid",
      valid_values: contract.requestFields,
    };
  }
  if (
    request.schema_version !== contract.requestSchemaVersion ||
    typeof request.requested_term !== "string"
  ) {
    return {
      class: "schema_violation",
      message: `request must use ${contract.requestSchemaVersion} with one string requested_term`,
      valid_values: [contract.requestSchemaVersion],
    };
  }
  if (request.host_review === undefined || request.host_review === null)
    return { requestedTerm: request.requested_term };
  const review = mapping(request.host_review);
  if (
    !review ||
    JSON.stringify(Object.keys(review).sort()) !==
      JSON.stringify([...contract.hostReviewFields].sort())
  ) {
    return {
      class: "schema_violation",
      message: "host_review fields are invalid",
      valid_values: contract.hostReviewFields,
    };
  }
  return {
    requestedTerm: request.requested_term,
    hostReview: {
      relation: review.relation as GlossaryAdviceHostReview["relation"],
      candidate_owner: review.candidate_owner as GlossaryAdviceHostReview["candidate_owner"],
      candidate_term: review.candidate_term as string,
    },
  };
}

export function runGlossaryAdviceCommand(argv: string[], io: Io): number {
  const parsedArgs = parseArgs(argv);
  if ("class" in parsedArgs) return invalid(io, parsedArgs);
  let requestedTerm: string;
  let hostReview: GlossaryAdviceHostReview | undefined;
  if ("termInput" in parsedArgs) {
    try {
      requestedTerm = loadSelectedTermInput(parsedArgs.termInput, io.stdin);
    } catch (error) {
      if (!(error instanceof SelectedTermInputError)) throw error;
      return invalid(io, {
        class: "invalid_selected_term",
        message: "--term-input must be one readable bounded non-blank UTF-8 scalar",
      }, TERM_INPUT_RECOVERY);
    }
  } else {
    let request: Mapping;
    try {
      request = readRequest(parsedArgs.input, io);
    } catch {
      return invalid(io, {
        class: "invalid_format",
        message: "--input must be one readable bounded UTF-8 YAML or JSON mapping",
      });
    }
    const parsed = validatedRequest(request);
    if ("class" in parsed) return invalid(io, parsed);
    requestedTerm = parsed.requestedTerm;
    hostReview = parsed.hostReview;
  }
  try {
    const profilePath = registryArtifactPath("profile", discoverSchemasDir());
    const advice = resolveGlossaryAdvice(
      requestedTerm,
      acquireGlossaryInputs(process.cwd(), profilePath),
      hostReview,
    );
    emitStructured(
      {
        schemaVersion: contract.schemaVersion,
        command: "report glossary-advice",
        status: "ok",
        advice,
      },
      "json",
      io.out ?? ((text) => process.stdout.write(text)),
    );
    return 0;
  } catch (error) {
    const code = error instanceof GlossaryAdviceInputError ? error.code : "invalid_acquisition";
    return invalid(io, { class: "invalid_request", message: `glossary advice failed: ${code}` });
  }
}

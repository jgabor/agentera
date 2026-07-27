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

type Mapping = Record<string, unknown>;

const contract = glossaryAdviceContract();
const COMMAND = contract.command.replace("REQUEST", "<file|->");
const RECOVERY = `Correct the bounded request and retry ${COMMAND}; no state was changed.`;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function invalid(io: Io, body: InvalidInputErrorBody): number {
  return emitInvalidInput(io, { format: "json", body: { ...body, recovery: RECOVERY } });
}

function parseArgs(argv: string[]): string | InvalidInputErrorBody {
  let input: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index]!.split("=", 2);
    if (name !== "--input" && name !== "--format") {
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
    }
  }
  return input ?? { class: "missing_argument", message: "--input is required", syntax: COMMAND };
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
  if (typeof parsedArgs !== "string") return invalid(io, parsedArgs);
  let request: Mapping;
  try {
    request = readRequest(parsedArgs, io);
  } catch {
    return invalid(io, {
      class: "invalid_format",
      message: "--input must be one readable bounded UTF-8 YAML or JSON mapping",
    });
  }
  const parsed = validatedRequest(request);
  if ("class" in parsed) return invalid(io, parsed);
  try {
    const profilePath = registryArtifactPath("profile", discoverSchemasDir());
    const advice = resolveGlossaryAdvice(
      parsed.requestedTerm,
      acquireGlossaryInputs(process.cwd(), profilePath),
      parsed.hostReview,
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

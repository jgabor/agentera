import crypto from "node:crypto";
import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { preCutoverCommand } from "../cli/preCutoverCommand.js";
import { loadCapabilitySchemaContract } from "./capabilityContract.js";
import { resolveRouteRequest } from "./hybridRoute.js";

type Mapping = Record<string, unknown>;

export type RouteReceiptResult = {
  schemaVersion: "agentera.route_receipt_result.v1";
  outcome: "selected" | "clarification" | "status_fallback";
  capability?: string;
  question?: string;
  deferred_intent?: { remainder_span: { start: number; end: number }; text: string };
  route_provenance: {
    source: "semantic_receipt";
    receipt_version: "agentera.route_receipt.v1";
    startup_command?: string;
    status_reason?: "no_match";
  };
};

export class RouteReceiptValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

function isMapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Mapping, keys: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new RouteReceiptValidationError(`${field}.${key}`, "contains an unsupported field");
  }
}

function requires(value: Mapping, key: string, field: string): unknown {
  if (!(key in value)) throw new RouteReceiptValidationError(`${field}.${key}`, "is required");
  return value[key];
}

function validUtf8String(value: unknown, field: string): string {
  if (typeof value !== "string" || Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new RouteReceiptValidationError(field, "must be a valid UTF-8 string");
  }
  return value;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function nullableHostShape(receipt: unknown, capabilities: Set<string>): Mapping {
  if (!isMapping(receipt)) throw new RouteReceiptValidationError("receipt", "must be a nullable host receipt mapping");
  const keys = ["version", "request_sha256", "semantic_capsule_sha256", "outcome", "capability", "compound", "question", "remainder_span"] as const;
  hasOnlyKeys(receipt, keys, "receipt");
  for (const key of keys) requires(receipt, key, "receipt");

  if (receipt.version !== "agentera.route_receipt.v1") throw new RouteReceiptValidationError("receipt.version", "must be agentera.route_receipt.v1");
  validUtf8String(receipt.request_sha256, "receipt.request_sha256");
  validUtf8String(receipt.semantic_capsule_sha256, "receipt.semantic_capsule_sha256");
  if (!["select", "clarify", "no_match"].includes(receipt.outcome as string)) {
    throw new RouteReceiptValidationError("receipt.outcome", "must be select, clarify, or no_match");
  }
  if (receipt.capability !== null && (typeof receipt.capability !== "string" || !capabilities.has(receipt.capability))) {
    throw new RouteReceiptValidationError("receipt.capability", "must be a canonical capability or null");
  }
  if (receipt.compound !== null && receipt.compound !== "none" && receipt.compound !== "preserve") {
    throw new RouteReceiptValidationError("receipt.compound", "must be none, preserve, or null");
  }
  if (receipt.question !== null) {
    const question = validUtf8String(receipt.question, "receipt.question");
    if (codePointLength(question) > 280) throw new RouteReceiptValidationError("receipt.question", "must be at most 280 characters");
  }
  if (receipt.remainder_span !== null) {
    if (!isMapping(receipt.remainder_span)) throw new RouteReceiptValidationError("receipt.remainder_span", "must be a span mapping or null");
    hasOnlyKeys(receipt.remainder_span, ["start", "end"], "receipt.remainder_span");
    for (const key of ["start", "end"]) {
      if (!Number.isInteger(receipt.remainder_span[key])) throw new RouteReceiptValidationError(`receipt.remainder_span.${key}`, "must be an integer");
    }
  }
  return receipt;
}

/** Projects the required nullable host shape without changing any non-null value. */
function normalizeHostReceipt(hostReceipt: Mapping): Mapping {
  const outcome = hostReceipt.outcome;
  const requireNonNull = (keys: string[]) => {
    for (const key of keys) if (hostReceipt[key] === null) throw new RouteReceiptValidationError(`receipt.${key}`, "must not be null for this outcome");
  };
  const requireNull = (keys: string[]) => {
    for (const key of keys) if (hostReceipt[key] !== null) throw new RouteReceiptValidationError(`receipt.${key}`, "must be null for this outcome");
  };

  if (outcome === "select") {
    requireNonNull(["version", "request_sha256", "semantic_capsule_sha256", "outcome", "capability", "compound"]);
    requireNull(["question"]);
    if (hostReceipt.compound === "none") requireNull(["remainder_span"]);
    else requireNonNull(["remainder_span"]);
  } else if (outcome === "clarify") {
    requireNonNull(["version", "request_sha256", "semantic_capsule_sha256", "outcome", "question"]);
    requireNull(["capability", "compound", "remainder_span"]);
  } else {
    requireNonNull(["version", "request_sha256", "semantic_capsule_sha256", "outcome"]);
    requireNull(["capability", "compound", "question", "remainder_span"]);
  }

  return Object.fromEntries(Object.entries(hostReceipt).filter(([, value]) => value !== null));
}

function exactUtf8Suffix(request: string, span: { start: number; end: number }): string {
  const bytes = Buffer.from(request, "utf8");
  if (span.start < 0 || span.end <= span.start || span.end !== bytes.length) {
    throw new RouteReceiptValidationError("receipt.remainder_span", "must be a non-empty suffix ending at the original request byte length");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(span.start, span.end));
    if (!Buffer.from(text, "utf8").equals(bytes.subarray(span.start, span.end))) {
      throw new RouteReceiptValidationError("receipt.remainder_span", "must preserve exact UTF-8 request bytes");
    }
    return text;
  } catch (error) {
    if (error instanceof RouteReceiptValidationError) throw error;
    throw new RouteReceiptValidationError("receipt.remainder_span", "must start and end on UTF-8 code-point boundaries");
  }
}

function authoritativeReceipt(receipt: Mapping, request: string, capabilities: Set<string>): string | undefined {
  hasOnlyKeys(receipt, ["version", "request_sha256", "semantic_capsule_sha256", "outcome", "capability", "compound", "question", "remainder_span"], "receipt");
  if (receipt.version !== "agentera.route_receipt.v1") throw new RouteReceiptValidationError("receipt.version", "is unsupported");
  if (typeof receipt.request_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.request_sha256)) {
    throw new RouteReceiptValidationError("receipt.request_sha256", "must be a lowercase SHA-256 digest");
  }
  if (typeof receipt.semantic_capsule_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.semantic_capsule_sha256)) {
    throw new RouteReceiptValidationError("receipt.semantic_capsule_sha256", "must be a lowercase SHA-256 digest");
  }
  const digest = crypto.createHash("sha256").update(request, "utf8").digest("hex");
  if (receipt.request_sha256 !== digest) throw new RouteReceiptValidationError("receipt.request_sha256", "does not match the supplied request");

  if (receipt.outcome === "select") {
    if (typeof receipt.capability !== "string" || !capabilities.has(receipt.capability)) throw new RouteReceiptValidationError("receipt.capability", "must name a canonical capability");
    if (receipt.compound !== "none" && receipt.compound !== "preserve") throw new RouteReceiptValidationError("receipt.compound", "must be none or preserve");
    if ("question" in receipt) throw new RouteReceiptValidationError("receipt.question", "is forbidden for select");
    if (receipt.compound === "none" && "remainder_span" in receipt) throw new RouteReceiptValidationError("receipt.remainder_span", "is forbidden when compound is none");
    if (receipt.compound === "preserve" && !("remainder_span" in receipt)) throw new RouteReceiptValidationError("receipt.remainder_span", "is required when compound is preserve");
  } else if (receipt.outcome === "clarify") {
    const question = validUtf8String(receipt.question, "receipt.question");
    if (!question || codePointLength(question) > 280) throw new RouteReceiptValidationError("receipt.question", "must be a non-empty question of at most 280 characters");
    for (const key of ["capability", "compound", "remainder_span"]) if (key in receipt) throw new RouteReceiptValidationError(`receipt.${key}`, "is forbidden for clarify");
  } else if (receipt.outcome === "no_match") {
    for (const key of ["capability", "compound", "question", "remainder_span"]) if (key in receipt) throw new RouteReceiptValidationError(`receipt.${key}`, "is forbidden for no_match");
  } else {
    throw new RouteReceiptValidationError("receipt.outcome", "must be select, clarify, or no_match");
  }

  if (receipt.remainder_span !== undefined) {
    if (!isMapping(receipt.remainder_span) || !Number.isInteger(receipt.remainder_span.start) || !Number.isInteger(receipt.remainder_span.end)) {
      throw new RouteReceiptValidationError("receipt.remainder_span", "must contain integer start and end values");
    }
    return exactUtf8Suffix(request, receipt.remainder_span as { start: number; end: number });
  }
  return undefined;
}

function requireSemanticAuthorization(request: string, receipt: Mapping, sourceRoot: string): void {
  try {
    const phaseOne = resolveRouteRequest(request, sourceRoot);
    if (phaseOne.outcome !== "semantic_required" || phaseOne.request_sha256 !== receipt.request_sha256) {
      throw new RouteReceiptValidationError("receipt.request_sha256", "is not bound to a semantic_required route response");
    }
    if (phaseOne.semantic_capsule_sha256 !== receipt.semantic_capsule_sha256) {
      throw new RouteReceiptValidationError("receipt.semantic_capsule_sha256", "does not match the current semantic capsule");
    }
  } catch (error) {
    if (error instanceof RouteReceiptValidationError) throw error;
    throw new RouteReceiptValidationError("receipt", "could not be authorized by the deterministic route authority");
  }
}

export function validateRouteReceiptSubmission(input: unknown, sourceRoot: string = resolveSourceRoot()): RouteReceiptResult {
  if (!isMapping(input)) throw new RouteReceiptValidationError("input", "must be a mapping with request and receipt");
  hasOnlyKeys(input, ["request", "receipt"], "input");
  const request = validUtf8String(requires(input, "request", "input"), "input.request");
  const hostReceipt = requires(input, "receipt", "input");
  const contract = loadCapabilitySchemaContract(path.join(sourceRoot, "skills/agentera/capability_schema_contract.yaml"));
  const capabilities = new Set(contract.routeAliases.primaryAliases.map(({ capability }) => capability));
  const receipt = normalizeHostReceipt(nullableHostShape(hostReceipt, capabilities));
  const deferredText = authoritativeReceipt(receipt, request, capabilities);
  requireSemanticAuthorization(request, receipt, sourceRoot);

  if (receipt.outcome === "clarify") {
    return {
      schemaVersion: "agentera.route_receipt_result.v1",
      outcome: "clarification",
      question: receipt.question as string,
      route_provenance: {
        source: "semantic_receipt",
        receipt_version: "agentera.route_receipt.v1",
      },
    };
  }
  const capability = receipt.outcome === "no_match" ? "status" : (receipt.capability as string);
  const startupCommand = preCutoverCommand(`prime --context ${capability}`);
  const span = receipt.remainder_span as { start: number; end: number } | undefined;
  return {
    schemaVersion: "agentera.route_receipt_result.v1",
    outcome: receipt.outcome === "no_match" ? "status_fallback" : "selected",
    capability,
    ...(span ? { deferred_intent: { remainder_span: span, text: deferredText! } } : {}),
    route_provenance: {
      source: "semantic_receipt",
      receipt_version: "agentera.route_receipt.v1",
      startup_command: startupCommand,
      ...(receipt.outcome === "no_match" ? { status_reason: "no_match" as const } : {}),
    },
  };
}

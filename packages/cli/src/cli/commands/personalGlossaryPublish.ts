import fs from "node:fs";
import path from "node:path";

import {
  updatePersonalGlossaryProfile,
  type PersonalGlossaryEntry,
} from "../../analytics/personalGlossaryProfile.js";
import { readPersonalGlossaryCandidateProjection } from "../../analytics/personalGlossaryCandidateProjection.js";
import { decidePersonalGlossaryCandidate } from "../../analytics/personalGlossaryDecision.js";
import { defaultProfileDir } from "../../analytics/extractCorpus/core.js";
import { loadYamlMapping } from "../../core/yaml.js";
import {
  createGlossaryPublicationResult,
  validateGlossaryAdmissionDecision,
  validateGlossaryHostClassificationReceipt,
  type GlossaryAdmissionDecision,
  type GlossaryEvidenceCapsule,
  type GlossaryHostClassificationReceipt,
} from "../../registries/glossaryCandidateContracts.js";
import {
  personalGlossaryOutputContract,
  type GlossaryAdmissionContext,
} from "../../registries/glossaryEntryContract.js";
import type { PersonalGlossaryOutputContract } from "../../registries/personalGlossaryContracts.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";

type Mapping = Record<string, unknown>;

const REQUEST_FIELDS = ["schema_version", "receipt", "decision", "as_of"];
const RESULT_FIELDS = [
  "schema_version",
  "owner",
  "candidate_id",
  "candidate_revision",
  "candidate_capsule_sha256",
  "decision_sha256",
  "review_record_sha256",
  "generation",
  "policy_version",
  "status",
  "profile_section_sha256",
  "published_at",
  "result_sha256",
];
const OUTPUT_STATUSES = ["changed", "unchanged_replay", "dry_run_candidate"];
const COMMAND = "agentera report personal-glossary-publish --input <file|-> [--dry-run] --format json";
const RECOVERY =
  "Reread the current personal candidate and authorized decision, then retry; no profile bytes were changed.";

interface PublishRequest {
  receipt: Mapping;
  decision: Mapping;
  asOf: string;
}

type PublishFailure = "publication_unavailable" | "publication_not_authorized" | "profile_unavailable" | "output_bound_exceeded";

function mapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function invalid(io: Io, body: InvalidInputErrorBody): number {
  return emitInvalidInput(io, { format: "json", body: { ...body, recovery: body.recovery ?? RECOVERY } });
}

function failure(io: Io, contract: PersonalGlossaryOutputContract, failureClass: PublishFailure): number {
  emitStructured(
    {
      schemaVersion: contract.resultSchemaVersion,
      command: "report personal-glossary-publish",
      status: "fail",
      error: {
        class: failureClass,
        message: "Personal glossary publication was not applied.",
        recovery: RECOVERY,
      },
    },
    "json",
    io.out ?? ((text) => process.stdout.write(text)),
  );
  return 1;
}

function contract(): PersonalGlossaryOutputContract {
  const value = personalGlossaryOutputContract();
  if (
    value.command !== "agentera report personal-glossary-publish" ||
    value.requestSchemaVersion !== "agentera.personalGlossaryPublishRequest.v1" ||
    !sameStrings(value.requestFields, REQUEST_FIELDS) ||
    value.maxRequestUtf8Bytes !== 16_384 ||
    value.resultSchemaVersion !== "agentera.personalGlossaryPublicationResult.v1" ||
    !sameStrings(value.resultFields, RESULT_FIELDS) ||
    value.maxResultUtf8Bytes !== 4_096 ||
    value.sectionSchemaVersion !== "agentera.personalGlossarySection.v1" ||
    !sameStrings(value.outputStatuses, OUTPUT_STATUSES)
  ) {
    throw new Error("personal glossary publication contract is unavailable");
  }
  return value;
}

function parseArgs(argv: string[]): { input: string; dryRun: boolean } | InvalidInputErrorBody {
  let input: string | undefined;
  let dryRun = false;
  let format = false;
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index]!.split("=", 2);
    if (name === "--dry-run") {
      if (inline !== undefined || dryRun) {
        return { class: "mutually_exclusive", message: "--dry-run may only be supplied once", syntax: COMMAND };
      }
      dryRun = true;
      continue;
    }
    if (name !== "--input" && name !== "--format") {
      return { class: "unrecognized_argument", message: "unrecognized personal publication argument", syntax: COMMAND };
    }
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) {
      return { class: "missing_argument", message: `${name} requires a value`, syntax: `${name} VALUE` };
    }
    if (name === "--format") {
      if (format) return { class: "mutually_exclusive", message: "--format may only be supplied once", syntax: COMMAND };
      if (value !== "json") return { class: "invalid_choice", message: "personal-glossary-publish requires --format json", valid_values: ["json"] };
      format = true;
      continue;
    }
    if (input !== undefined) return { class: "mutually_exclusive", message: "--input may only be supplied once", syntax: COMMAND };
    input = value;
  }
  return input ? { input, dryRun } : { class: "missing_argument", message: "--input is required", syntax: COMMAND };
}

function readBoundedDescriptor(fd: number, maxBytes: number): Buffer {
  const bytes = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset > maxBytes) throw new Error("over bound");
  return bytes.subarray(0, offset);
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedFile(source: string, maxBytes: number): Buffer {
  const observed = fs.lstatSync(source, { bigint: true });
  if (observed.isSymbolicLink() || !observed.isFile() || observed.size > BigInt(maxBytes)) {
    throw new Error("over bound or unreadable");
  }
  let fd: number | null = null;
  try {
    fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(observed, opened) || opened.size > BigInt(maxBytes)) {
      throw new Error("over bound or unreadable");
    }
    return readBoundedDescriptor(fd, maxBytes);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function readBoundedStdin(maxBytes: number, io: Io): Buffer {
  if (io.stdin) {
    const value = io.stdin();
    if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("over bound");
    return Buffer.from(value, "utf8");
  }
  if (process.stdin.isTTY) return Buffer.alloc(0);
  return readBoundedDescriptor(0, maxBytes);
}

function readRequest(source: string, maxBytes: number, io: Io): Mapping {
  const bytes = source === "-" ? readBoundedStdin(maxBytes, io) : readBoundedFile(source, maxBytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = loadYamlMapping(text);
  if (!mapping(value)) throw new Error("not a mapping");
  return value;
}

function validateRequest(
  value: Mapping,
  contractValue: PersonalGlossaryOutputContract,
): PublishRequest | InvalidInputErrorBody {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !contractValue.requestFields.includes(key)) ||
    contractValue.requestFields.some((field) => !(field in value))
  ) {
    return {
      class: "schema_violation",
      message: "personal glossary publish request fields are invalid",
      valid_values: contractValue.requestFields,
    };
  }
  if (
    value.schema_version !== contractValue.requestSchemaVersion ||
    !mapping(value.receipt) ||
    !mapping(value.decision) ||
    !calendarDate(value.as_of)
  ) {
    return {
      class: "schema_violation",
      message: `request requires ${contractValue.requestSchemaVersion}, receipt, decision, and an ISO calendar date`,
      valid_values: [contractValue.requestSchemaVersion, "receipt", "decision", "YYYY-MM-DD"],
    };
  }
  return { receipt: value.receipt, decision: value.decision, asOf: value.as_of };
}

function currentCandidate(receipt: Mapping): { capsule: GlossaryEvidenceCapsule; projectionSha256: string } | null {
  const current = readPersonalGlossaryCandidateProjection();
  if (current.status !== "current" || current.projection === null) return null;
  const candidates = current.projection.candidates.filter(
    ({ capsule }) =>
      capsule.candidate_id === receipt.candidate_id &&
      capsule.candidate_revision === receipt.candidate_revision &&
      capsule.capsule_sha256 === receipt.candidate_capsule_sha256 &&
      capsule.generation === receipt.generation &&
      capsule.policy_version === receipt.policy_version,
  );
  return candidates.length === 1
    ? { capsule: candidates[0]!.capsule, projectionSha256: current.projection.projection_sha256 }
    : null;
}

function authorizedPublication(request: PublishRequest): {
  capsule: GlossaryEvidenceCapsule;
  receipt: GlossaryHostClassificationReceipt;
  decision: GlossaryAdmissionDecision;
} | null {
  const selected = currentCandidate(request.receipt);
  if (!selected) return null;
  if (
    validateGlossaryHostClassificationReceipt(request.receipt, selected.capsule, {
      candidateProjectionSha256: selected.projectionSha256,
    }).length > 0 ||
    validateGlossaryAdmissionDecision(request.decision, selected.capsule, request.receipt).length > 0
  ) {
    return null;
  }
  const current = decidePersonalGlossaryCandidate(request.receipt);
  if (
    current.status !== "automatic_admission" ||
    current.reason !== "explicit_current_authorized" ||
    current.decision === null ||
    current.decision.decision_sha256 !== request.decision.decision_sha256
  ) {
    return null;
  }
  return {
    capsule: selected.capsule,
    receipt: request.receipt as GlossaryHostClassificationReceipt,
    decision: request.decision as GlossaryAdmissionDecision,
  };
}

function entryFor(
  capsule: GlossaryEvidenceCapsule,
  receipt: GlossaryHostClassificationReceipt,
  asOf: string,
): { entry: PersonalGlossaryEntry; context: GlossaryAdmissionContext } | null {
  const classification = receipt.classification;
  const evidence = capsule.evidence;
  if (
    evidence.length !== 1 ||
    classification.term !== capsule.term ||
    classification.meaning !== capsule.meaning ||
    classification.scope !== "personal" ||
    classification.consistency !== "consistent" ||
    !["stable", "durable", "situational"].includes(classification.permanence) ||
    !Number.isInteger(classification.confidence) ||
    classification.confidence < 0 ||
    classification.confidence > 100
  ) {
    return null;
  }
  const source = evidence[0];
  if (
    !mapping(source) ||
    typeof source.source_id !== "string" ||
    typeof source.evidence_anchor !== "string" ||
    typeof source.signal_type !== "string"
  ) {
    return null;
  }
  return {
    entry: {
      term: capsule.term,
      meaning: capsule.meaning,
      confidence: classification.confidence,
      permanence: classification.permanence as PersonalGlossaryEntry["permanence"],
      temporal: { observed_at: asOf, last_confirmed_at: asOf },
      provenance: {
        kind: "personal_explicit_definition",
        evidence: [{
          source_id: source.source_id,
          evidence_anchor: source.evidence_anchor,
          signal_type: source.signal_type,
        }],
      },
    },
    context: {
      retainedHistory: new Map([
        [
          source.evidence_anchor,
          {
            sourceId: source.source_id,
            sourceKind: "conversation_turn",
            signalType: source.signal_type,
          },
        ],
      ]),
    },
  };
}

function publishedAt(asOf: string): string {
  return `${asOf}T00:00:00.000Z`;
}

function resultText(
  contractValue: PersonalGlossaryOutputContract,
  value: ReturnType<typeof createGlossaryPublicationResult>,
): string | null {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  return Buffer.byteLength(text, "utf8") <= contractValue.maxResultUtf8Bytes ? text : null;
}

/** Publish one revalidated automatic personal admission to the owned profile section. */
export function runPersonalGlossaryPublishCommand(argv: string[], io: Io): number {
  let contractValue: PersonalGlossaryOutputContract;
  try {
    contractValue = contract();
  } catch {
    return invalid(io, {
      class: "invalid_request",
      message: "personal glossary publication contract is unavailable",
      recovery: "Restore the bundled glossary authority, then retry; no profile bytes were changed.",
    });
  }
  const parsedArgs = parseArgs(argv);
  if ("class" in parsedArgs) return invalid(io, parsedArgs);
  let input: Mapping;
  try {
    input = readRequest(parsedArgs.input, contractValue.maxRequestUtf8Bytes, io);
  } catch {
    return invalid(io, {
      class: "invalid_format",
      message: "--input must be one readable bounded UTF-8 YAML or JSON mapping",
    });
  }
  const request = validateRequest(input, contractValue);
  if ("class" in request) return invalid(io, request);

  let authorized: ReturnType<typeof authorizedPublication>;
  try {
    authorized = authorizedPublication(request);
  } catch {
    return failure(io, contractValue, "publication_unavailable");
  }
  if (!authorized) return failure(io, contractValue, "publication_not_authorized");
  const publication = entryFor(authorized.capsule, authorized.receipt, request.asOf);
  if (!publication) return failure(io, contractValue, "publication_not_authorized");

  const profileInput = {
    profilePath: path.join(defaultProfileDir(), "PROFILE.md"),
    freshEntries: [publication.entry],
    retainedHistory: publication.context,
    asOf: request.asOf,
  };
  let preview;
  try {
    preview = updatePersonalGlossaryProfile({ ...profileInput, dryRun: true });
  } catch {
    return failure(io, contractValue, "profile_unavailable");
  }
  let text: string | null;
  try {
    text = resultText(
      contractValue,
      createGlossaryPublicationResult({
        capsule: authorized.capsule,
        receipt: authorized.receipt,
        decision: authorized.decision,
        review: null,
        status: parsedArgs.dryRun
          ? "dry_run_candidate"
          : preview.changed
            ? "changed"
            : "unchanged_replay",
        profile_section_sha256: preview.profileSectionSha256,
        published_at: parsedArgs.dryRun ? null : publishedAt(request.asOf),
      }),
    );
  } catch {
    return failure(io, contractValue, "publication_unavailable");
  }
  if (text === null) return failure(io, contractValue, "output_bound_exceeded");
  if (!parsedArgs.dryRun && preview.changed) {
    let beforeEffect: ReturnType<typeof authorizedPublication>;
    try {
      beforeEffect = authorizedPublication(request);
    } catch {
      return failure(io, contractValue, "publication_unavailable");
    }
    if (!beforeEffect || beforeEffect.decision.decision_sha256 !== authorized.decision.decision_sha256) {
      return failure(io, contractValue, "publication_not_authorized");
    }
    try {
      updatePersonalGlossaryProfile(profileInput);
    } catch {
      return failure(io, contractValue, "profile_unavailable");
    }
  }
  (io.out ?? ((line) => process.stdout.write(line)))(text);
  return 0;
}

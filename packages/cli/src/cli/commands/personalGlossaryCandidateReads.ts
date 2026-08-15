import {
  personalGlossaryCandidateProjectionPath,
  type ProjectedPersonalGlossaryCandidate,
} from "../../analytics/personalGlossaryCandidateProjection.js";
import { readCurrentPersonalGlossaryCandidateProjection } from "../../analytics/personalGlossaryCurrentGeneration.js";
import {
  currentPersonalGlossaryCandidateReadView,
  type PersonalGlossaryCandidateReadView as CandidateReadView,
} from "../../analytics/personalGlossaryCandidateReadView.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { shellQuoteArgument } from "../../core/shell.js";
import {
  canonicalGlossaryJson,
  compareGlossaryUnicodeStrings,
  glossaryCanonicalSha256,
} from "../../registries/glossaryTermIdentity.js";
import { glossaryEntryAuthorityPath } from "../../registries/glossaryEntryContract.js";
import { personalGlossaryCandidateProjectionContract } from "../../registries/glossaryCandidateProjectionContract.js";
import {
  decodeListCursor,
  encodeListCursor,
  projectedListSnapshot,
} from "../../state/listCursor.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";

const COLLECTION = "personal_glossary_candidates";
const CURSOR_VERSION = 1;
const OCCURRENCE_SCHEMA_VERSION = "agentera.personalGlossaryCandidateOccurrence.v1";
const MAX_CURSOR_UTF8_BYTES = 4_096;
const SHA256 = /^[a-f0-9]{64}$/u;

type Mapping = Record<string, unknown>;
type SourceFamily = "explicit" | "recurring";
type Scope = "personal" | "ambiguous";

interface CandidateReadContract {
  command: string;
  schemaVersion: string;
  defaultLimit: number;
  maximumLimit: number;
  order: string;
  sourceFamilies: SourceFamily[];
  provenanceKinds: string[];
  scopes: Scope[];
  maxSerializedUtf8Bytes: number;
  exactOccurrencesMax: number;
  safeContextMaxUtf8Bytes: number;
  exactMaxSerializedUtf8Bytes: number;
  cursorAuthority: string;
  cursorVocabulary: string;
  cursorBinding: string[];
  cursorInvalidBehavior: string;
  cursorUnavailableBehavior: string;
  exactBindings: string[];
  safeContextViewAuthority: string;
  safeContextRetentionDays: number;
  safeContextViewExpiry: string;
  safeContextViewMutation: string;
  safeContextViewSnapshot: string;
}

interface ListOptions {
  limit: number;
  cursor?: string;
  sourceFamily?: SourceFamily;
  provenanceKind?: string;
  scope?: Scope;
}

interface ExactOptions {
  candidateId: string;
  candidateRevision: string;
  generation: string;
  policyVersion: string;
}

interface CandidateReadFailure {
  class:
    | "projection_unavailable"
    | "current_generation_unavailable"
    | "projection_stale"
    | "cursor_invalid"
    | "cursor_snapshot_unavailable"
    | "not_found"
    | "current_binding_mismatch"
    | "output_bound_exceeded"
    | "unsupported_state";
  message: string;
  recovery: string;
}

function mapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contract(): CandidateReadContract {
  const value = personalGlossaryCandidateProjectionContract();
  const sourceFamilies = value.candidateReadSourceFamilies as SourceFamily[];
  const provenanceKinds = value.candidateReadProvenanceKinds;
  if (
    value.candidateReadCommand !== "agentera report personal-glossary-candidates" ||
    value.candidateReadSchemaVersion !== "agentera.personalGlossaryCandidateRetrieval.v1" ||
    value.candidateReadDefaultLimit !== 20 ||
    value.candidateReadMaximumLimit !== 50 ||
    value.candidateReadOrder !== "candidate_id_then_candidate_revision_then_capsule_sha256" ||
    value.candidateReadListProjectionBindingField !== "candidate_projection_sha256" ||
    JSON.stringify(sourceFamilies) !== JSON.stringify(["explicit", "recurring"]) ||
    JSON.stringify(provenanceKinds) !==
      JSON.stringify([
        "personal_explicit_definition",
        "personal_inferred_conversation",
        "personal_inferred_usage",
      ]) ||
    JSON.stringify(value.candidateReadScopes) !== JSON.stringify(["personal", "ambiguous"]) ||
    value.candidateReadMaxSerializedUtf8Bytes !== 32_768 ||
    value.candidateReadCursorVocabulary !== "opaque_snapshot_cursor" ||
    JSON.stringify(value.candidateReadCursorBinding) !==
      JSON.stringify([
        "collection",
        "generation",
        "policy_version",
        "filters",
        "limit",
        "order",
        "snapshot",
      ]) ||
    value.candidateReadCursorInvalidBehavior !== "cursor_invalid" ||
    value.candidateReadCursorUnavailableBehavior !== "cursor_snapshot_unavailable" ||
    JSON.stringify(value.candidateReadExactRequiredBindings) !==
      JSON.stringify(["candidate_id", "candidate_revision", "generation", "policy_version"]) ||
    value.candidateReadExactProjectionBindingField !== "candidate_projection_sha256" ||
    value.candidateReadExactOccurrencesMax !== 100 ||
    value.candidateReadSafeContextMaxUtf8Bytes !== 500 ||
    value.candidateReadExactMaxSerializedUtf8Bytes !== 32_768 ||
    value.candidateReadCursorAuthority !==
      "references/artifacts/state-storage-authority.yaml#entity_target.public_retrieval.policy.cursor" ||
    value.candidateReadSafeContextViewAuthority !== "personal_mining_authority.privacy.retention" ||
    value.candidateReadSafeContextRetentionDays !== 30 ||
    value.candidateReadSafeContextViewExpiry !== "expires_at_lte_read_time_is_unavailable" ||
    value.candidateReadSafeContextViewMutation !== "forbidden" ||
    value.candidateReadSafeContextViewSnapshot !==
      "effective_availability_bound_to_opaque_cursor_snapshot" ||
    value.candidateReadCurrentGenerationSource !==
      "current.json_readable_bounded_evidence_tier_generation" ||
    value.candidateReadCurrentGenerationProjectionBinding !== "exact_match_required" ||
    value.candidateReadCurrentGenerationUnavailableBehavior !==
      "current_generation_unavailable" ||
    value.candidateReadCurrentGenerationStaleProjectionBehavior !== "projection_stale"
  ) {
    throw new TypeError("personal glossary candidate retrieval contract is invalid");
  }
  return {
    command: value.candidateReadCommand,
    schemaVersion: value.candidateReadSchemaVersion,
    defaultLimit: value.candidateReadDefaultLimit,
    maximumLimit: value.candidateReadMaximumLimit,
    order: value.candidateReadOrder,
    sourceFamilies,
    provenanceKinds,
    scopes: value.candidateReadScopes as Scope[],
    maxSerializedUtf8Bytes: value.candidateReadMaxSerializedUtf8Bytes,
    exactOccurrencesMax: value.candidateReadExactOccurrencesMax,
    safeContextMaxUtf8Bytes: value.candidateReadSafeContextMaxUtf8Bytes,
    exactMaxSerializedUtf8Bytes: value.candidateReadExactMaxSerializedUtf8Bytes,
    cursorAuthority: value.candidateReadCursorAuthority,
    cursorVocabulary: value.candidateReadCursorVocabulary,
    cursorBinding: value.candidateReadCursorBinding,
    cursorInvalidBehavior: value.candidateReadCursorInvalidBehavior,
    cursorUnavailableBehavior: value.candidateReadCursorUnavailableBehavior,
    exactBindings: value.candidateReadExactRequiredBindings,
    safeContextViewAuthority: value.candidateReadSafeContextViewAuthority,
    safeContextRetentionDays: value.candidateReadSafeContextRetentionDays,
    safeContextViewExpiry: value.candidateReadSafeContextViewExpiry,
    safeContextViewMutation: value.candidateReadSafeContextViewMutation,
    safeContextViewSnapshot: value.candidateReadSafeContextViewSnapshot,
  };
}

function listSyntax(value: CandidateReadContract): string {
  return `${value.command} list [--source-family explicit|recurring] [--provenance-kind KIND] [--scope personal|ambiguous] [--limit N] [--cursor TOKEN] --format json`;
}

function exactSyntax(value: CandidateReadContract): string {
  return `${value.command} get --candidate-id ID --candidate-revision REVISION --generation GENERATION --policy-version POLICY --format json`;
}

function invalid(
  io: Io,
  body: InvalidInputErrorBody,
): number {
  return emitInvalidInput(io, { format: "json", body });
}

function failure(
  io: Io,
  command: string,
  syntax: string,
  example: string,
  body: CandidateReadFailure,
): number {
  emitStructured(
    {
      schemaVersion: "agentera.personalGlossaryCandidateRetrieval.v1",
      command,
      status: "fail",
      error: { ...body, syntax, example },
    },
    "json",
    io.out ?? ((text) => process.stdout.write(text)),
  );
  return 1;
}

function argvPart(argument: string): { name: string; inline?: string } {
  const separator = argument.indexOf("=");
  return separator < 0
    ? { name: argument }
    : { name: argument.slice(0, separator), inline: argument.slice(separator + 1) };
}

function boundedText(value: string, maximum: number): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function parseList(
  argv: string[],
  value: CandidateReadContract,
): ListOptions | InvalidInputErrorBody {
  let limit = value.defaultLimit;
  let cursor: string | undefined;
  let sourceFamily: SourceFamily | undefined;
  let provenanceKind: string | undefined;
  let scope: Scope | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const { name, inline } = argvPart(argument);
    if (!name.startsWith("--")) {
      return {
        class: "unrecognized_argument",
        message: `unrecognized arguments: ${argument}`,
        syntax: listSyntax(value),
      };
    }
    if (![
      "--format",
      "--limit",
      "--cursor",
      "--source-family",
      "--provenance-kind",
      "--scope",
    ].includes(name)) {
      return {
        class: "unrecognized_argument",
        message: `unrecognized arguments: ${argument}`,
        syntax: listSyntax(value),
      };
    }
    if (seen.has(name)) {
      return {
        class: "mutually_exclusive",
        message: `${name} may only be supplied once`,
        syntax: listSyntax(value),
      };
    }
    seen.add(name);
    const option = inline ?? argv[++index];
    if (!option || option.startsWith("--")) {
      return {
        class: "missing_argument",
        message: `${name} requires a value`,
        syntax: `${name} VALUE`,
      };
    }
    if (name === "--format") {
      if (option !== "json") {
        return {
          class: "invalid_choice",
          message: `argument --format: invalid choice: '${option}' (choose from 'json')`,
          valid_values: ["json"],
        };
      }
      continue;
    }
    if (name === "--limit") {
      if (!/^(?:0|[1-9]\d*)$/u.test(option) || !Number.isSafeInteger(Number(option))) {
        return {
          class: "invalid_int",
          message: "--limit must be an integer",
          valid_values: [`1..${value.maximumLimit}`],
          syntax: listSyntax(value),
        };
      }
      limit = Number(option);
      if (limit < 1 || limit > value.maximumLimit) {
        return {
          class: "invalid_request",
          message: `list limit must be 1..${value.maximumLimit}`,
          valid_values: [`1..${value.maximumLimit}`],
          syntax: listSyntax(value),
        };
      }
      continue;
    }
    if (name === "--cursor") {
      if (Buffer.byteLength(option, "utf8") > MAX_CURSOR_UTF8_BYTES) {
        return {
          class: "invalid_request",
          message: `--cursor exceeds its ${MAX_CURSOR_UTF8_BYTES}-byte bound`,
          syntax: listSyntax(value),
        };
      }
      cursor = option;
      continue;
    }
    if (name === "--source-family") {
      if (!value.sourceFamilies.includes(option as SourceFamily)) {
        return {
          class: "invalid_choice",
          message: `argument --source-family: invalid choice: '${option}'`,
          valid_values: value.sourceFamilies,
        };
      }
      sourceFamily = option as SourceFamily;
      continue;
    }
    if (name === "--provenance-kind") {
      if (!value.provenanceKinds.includes(option)) {
        return {
          class: "invalid_choice",
          message: `argument --provenance-kind: invalid choice: '${option}'`,
          valid_values: value.provenanceKinds,
        };
      }
      provenanceKind = option;
      continue;
    }
    if (!value.scopes.includes(option as Scope)) {
      return {
        class: "invalid_choice",
        message: `argument --scope: invalid choice: '${option}'`,
        valid_values: value.scopes,
      };
    }
    scope = option as Scope;
  }
  return { limit, cursor, sourceFamily, provenanceKind, scope };
}

function parseExact(
  argv: string[],
  value: CandidateReadContract,
): ExactOptions | InvalidInputErrorBody {
  const fields: Partial<ExactOptions> = {};
  const names: Record<string, keyof ExactOptions> = {
    "--candidate-id": "candidateId",
    "--candidate-revision": "candidateRevision",
    "--generation": "generation",
    "--policy-version": "policyVersion",
  };
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const { name, inline } = argvPart(argument);
    if (!["--format", ...Object.keys(names)].includes(name)) {
      return {
        class: "unrecognized_argument",
        message: `unrecognized arguments: ${argument}`,
        syntax: exactSyntax(value),
      };
    }
    if (seen.has(name)) {
      return {
        class: "mutually_exclusive",
        message: `${name} may only be supplied once`,
        syntax: exactSyntax(value),
      };
    }
    seen.add(name);
    const option = inline ?? argv[++index];
    if (!option || option.startsWith("--")) {
      return {
        class: "missing_argument",
        message: `${name} requires a value`,
        syntax: `${name} VALUE`,
      };
    }
    if (name === "--format") {
      if (option !== "json") {
        return {
          class: "invalid_choice",
          message: `argument --format: invalid choice: '${option}' (choose from 'json')`,
          valid_values: ["json"],
        };
      }
      continue;
    }
    fields[names[name]!] = option;
  }

  for (const [flag, field] of Object.entries(names)) {
    if (!fields[field]) {
      return {
        class: "missing_argument",
        message: `${flag} is required`,
        syntax: exactSyntax(value),
      };
    }
  }
  if (!SHA256.test(fields.candidateId!)) {
    return {
      class: "invalid_request",
      message: "--candidate-id must be a lowercase SHA-256 identity",
      valid_values: ["64 lowercase hexadecimal characters"],
      syntax: exactSyntax(value),
    };
  }
  if (!SHA256.test(fields.candidateRevision!)) {
    return {
      class: "invalid_request",
      message: "--candidate-revision must be a lowercase SHA-256 identity",
      valid_values: ["64 lowercase hexadecimal characters"],
      syntax: exactSyntax(value),
    };
  }
  for (const [flag, field] of [
    ["--generation", "generation"],
    ["--policy-version", "policyVersion"],
  ] as const) {
    if (!boundedText(fields[field]!, 256)) {
      return {
        class: "invalid_request",
        message: `${flag} must be a non-empty value within 256 UTF-8 bytes`,
        syntax: exactSyntax(value),
      };
    }
  }
  return fields as ExactOptions;
}

function filters(options: ListOptions): Mapping {
  return {
    source_family: options.sourceFamily ?? null,
    provenance_kind: options.provenanceKind ?? null,
    scope: options.scope ?? null,
  };
}

function candidateKey(candidate: ProjectedPersonalGlossaryCandidate): string {
  return [
    candidate.capsule.candidate_id,
    candidate.capsule.candidate_revision,
    candidate.capsule.capsule_sha256,
  ].join("\u0000");
}

function candidateOrder(
  left: ProjectedPersonalGlossaryCandidate,
  right: ProjectedPersonalGlossaryCandidate,
): number {
  return (
    compareGlossaryUnicodeStrings(left.capsule.candidate_id, right.capsule.candidate_id) ||
    compareGlossaryUnicodeStrings(
      left.capsule.candidate_revision,
      right.capsule.candidate_revision,
    ) ||
    compareGlossaryUnicodeStrings(left.capsule.capsule_sha256, right.capsule.capsule_sha256)
  );
}

function candidateSummary(candidate: ProjectedPersonalGlossaryCandidate): Mapping {
  return {
    candidate_id: candidate.capsule.candidate_id,
    candidate_revision: candidate.capsule.candidate_revision,
    term: candidate.capsule.term,
    scope: candidate.capsule.scope,
    provenance_kind: candidate.capsule.provenance_kind,
    source_family: candidate.source_family,
    occurrence_count: candidate.capsule.evidence.length,
    safe_context_available: candidate.safe_excerpt !== null,
  };
}

function projectionSummary(view: CandidateReadView): Mapping {
  const report = view.projection.report;
  const safeContextOmissions = Object.values(report.excerpts.omissions).reduce(
    (total, count) => total + count,
    0,
  );
  const safeContextExpired = report.excerpts.expired + view.expiredSafeContexts;
  const safeContextAvailable = view.candidates.filter(
    (candidate) => candidate.safe_excerpt !== null,
  ).length;
  const safeContextUnavailable = safeContextOmissions + safeContextExpired;
  if (safeContextAvailable + safeContextUnavailable !== view.candidates.length) {
    throw new TypeError("candidate safe-context read view does not reconcile");
  }
  return {
    retained_count: report.retained_count,
    dropped_count: report.dropped_count,
    source_families: report.source_families.map((family) => ({ ...family })),
    projects: { ...report.projects },
    coverage: { ...report.coverage, reasons: [...report.coverage.reasons] },
    abstentions: {
      candidate_selection: {
        count: report.dropped_count,
        reasons: [...report.coverage.reasons],
      },
      safe_context: {
        available: safeContextAvailable,
        count: safeContextUnavailable,
        expired: safeContextExpired,
        omissions: { ...report.excerpts.omissions },
      },
    },
  };
}

function opaqueOccurrence(candidate: ProjectedPersonalGlossaryCandidate, evidence: Mapping): Mapping {
  const occurrence: Mapping = {
    occurrence_id: glossaryCanonicalSha256({
      schema_version: OCCURRENCE_SCHEMA_VERSION,
      candidate_id: candidate.capsule.candidate_id,
      candidate_revision: candidate.capsule.candidate_revision,
      generation: candidate.capsule.generation,
      policy_version: candidate.capsule.policy_version,
      evidence,
    }),
  };
  for (const field of ["source_kind", "signal_type", "author_class"] as const) {
    if (typeof evidence[field] === "string") occurrence[field] = evidence[field];
  }
  return occurrence;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function listFlags(options: ListOptions): string {
  return [
    options.sourceFamily ? ` --source-family ${shellQuoteArgument(options.sourceFamily)}` : "",
    options.provenanceKind
      ? ` --provenance-kind ${shellQuoteArgument(options.provenanceKind)}`
      : "",
    options.scope ? ` --scope ${shellQuoteArgument(options.scope)}` : "",
  ].join("");
}

function currentProjection(
  io: Io,
  value: CandidateReadContract,
  operation: "list" | "get",
): CandidateReadView | null {
  const result = readCurrentPersonalGlossaryCandidateProjection();
  if (result.status === "current" && result.projection) {
    try {
      return currentPersonalGlossaryCandidateReadView(result.projection);
    } catch {
      // Do not return a partially reconciled read view.
    }
  }
  const unavailable = result.status === "current_generation_unavailable"
    ? {
      class: "current_generation_unavailable" as const,
      message: "the current bounded evidence tier generation is unavailable",
      recovery: "Run `npx -y agentera@next report refresh --consent local-history`, then retry; no projection bytes were changed.",
    }
    : result.status === "projection_stale"
      ? {
        class: "projection_stale" as const,
        message: "the candidate projection is stale for the current bounded evidence tier generation",
        recovery: "Run `npx -y agentera@next report refresh --consent local-history`, then retry; no projection bytes were changed.",
      }
      : {
        class: "projection_unavailable" as const,
        message: "the current personal glossary candidate projection is unavailable or invalid",
        recovery: "Run `npx -y agentera@next report refresh --consent local-history`, then retry; no projection bytes were changed.",
      };
  failure(
    io,
    `${value.command} ${operation}`,
    operation === "list" ? listSyntax(value) : exactSyntax(value),
    operation === "list"
      ? `${value.command} list --limit ${value.defaultLimit} --format json`
      : exactSyntax(value),
    unavailable,
  );
  return null;
}

function listCandidates(io: Io, options: ListOptions, value: CandidateReadContract): number {
  const view = currentProjection(io, value, "list");
  if (!view) return 1;
  const projection = view.projection;
  const selectedFilters = filters(options);
  const candidates = view.candidates
    .filter((candidate) =>
      (!options.sourceFamily || candidate.source_family === options.sourceFamily) &&
      (!options.provenanceKind || candidate.capsule.provenance_kind === options.provenanceKind) &&
      (!options.scope || candidate.capsule.scope === options.scope),
    )
    .sort(candidateOrder);
  const snapshotId = projectedListSnapshot({
    schemaVersion: value.schemaVersion,
    command: `${value.command} list`,
    collection: COLLECTION,
    generation: projection.generation,
    policy_version: projection.policy_version,
    projection_sha256: projection.projection_sha256,
    safe_context_view_sha256: view.safeContextViewSha256,
    filters: selectedFilters as JsonObject,
    order: value.order,
  });
  let start = 0;
  if (options.cursor) {
    let cursor: Mapping;
    try {
      cursor = decodeListCursor(
        options.cursor,
        personalGlossaryCandidateProjectionPath(),
        glossaryEntryAuthorityPath(),
      );
    } catch {
      return failure(
        io,
        `${value.command} list`,
        listSyntax(value),
        `${value.command} list --limit ${value.defaultLimit} --format json`,
        {
          class: "cursor_invalid",
          message: "candidate-list cursor is malformed or belongs to another local profile",
          recovery: "Copy next_cursor exactly, or omit --cursor to restart from the current projection; no projection bytes were changed.",
        },
      );
    }
    if (
      cursor.version !== CURSOR_VERSION ||
      cursor.collection !== COLLECTION ||
      cursor.limit !== options.limit ||
      !mapping(cursor.filters) ||
      canonicalGlossaryJson(cursor.filters) !== canonicalGlossaryJson(selectedFilters)
    ) {
      return failure(
        io,
        `${value.command} list`,
        listSyntax(value),
        `${value.command} list --limit ${value.defaultLimit} --format json`,
        {
          class: "cursor_invalid",
          message: "candidate-list cursor filters or limit do not match this request",
          recovery: "Repeat the original filters and limit, or omit --cursor to restart from the current projection; no projection bytes were changed.",
        },
      );
    }
    if (
      cursor.generation !== projection.generation ||
      cursor.policy_version !== projection.policy_version ||
      cursor.order !== value.order ||
      cursor.snapshot_id !== snapshotId ||
      typeof cursor.after !== "string"
    ) {
      return failure(
        io,
        `${value.command} list`,
        listSyntax(value),
        `${value.command} list --limit ${value.defaultLimit} --format json`,
        {
          class: "cursor_snapshot_unavailable",
          message: "candidate-list cursor cannot resume the current projection snapshot",
          recovery: "Omit --cursor to restart from the current projection; no projection bytes were changed.",
        },
      );
    }
    const position = candidates.findIndex((candidate) => candidateKey(candidate) === cursor.after);
    if (position < 0) {
      return failure(
        io,
        `${value.command} list`,
        listSyntax(value),
        `${value.command} list --limit ${value.defaultLimit} --format json`,
        {
          class: "cursor_snapshot_unavailable",
          message: "candidate-list cursor continuation is unavailable",
          recovery: "Omit --cursor to restart from the current projection; no projection bytes were changed.",
        },
      );
    }
    start = position + 1;
  }
  const entries = candidates.slice(start, start + options.limit);
  const remaining = candidates.length - start - entries.length;
  const nextCursor = remaining > 0 && entries.length > 0
    ? encodeListCursor(
      {
        version: CURSOR_VERSION,
        collection: COLLECTION,
        generation: projection.generation,
        policy_version: projection.policy_version,
        filters: selectedFilters as JsonObject,
        limit: options.limit,
        order: value.order,
        snapshot_id: snapshotId,
        after: candidateKey(entries.at(-1)!),
      },
      personalGlossaryCandidateProjectionPath(),
      glossaryEntryAuthorityPath(),
    )
    : undefined;
  const response: Mapping = {
    schemaVersion: value.schemaVersion,
    command: `${value.command} list`,
    status:
      remaining > 0 || projection.report.coverage.status === "degraded" ? "degraded" : "ok",
    generation: projection.generation,
    policy_version: projection.policy_version,
    candidate_projection_sha256: projection.projection_sha256,
    entries: entries.map(candidateSummary),
    counts: {
      total: candidates.length,
      candidate: candidates.length,
      returned: entries.length,
      remaining,
      omitted: remaining,
      continuation: remaining,
    },
    filters: selectedFilters,
    snapshot: {
      id: snapshotId,
      first_page: !options.cursor,
      order: value.order,
      has_more: remaining > 0,
      candidate_count: candidates.length,
    },
    summary: projectionSummary(view),
    source: {
      kind: "user_local_candidate_projection",
      owner: projection.owner,
    },
    source_contract: {
      authority: "references/artifacts/glossary-entry-contract.yaml",
      cursor: value.cursorVocabulary,
      cursor_authority: value.cursorAuthority,
      cursor_binding: [...value.cursorBinding],
      cursor_invalid_behavior: value.cursorInvalidBehavior,
      cursor_unavailable_behavior: value.cursorUnavailableBehavior,
      safe_context_view: {
        authority: value.safeContextViewAuthority,
        retention_days: value.safeContextRetentionDays,
        expiry: value.safeContextViewExpiry,
        mutation: value.safeContextViewMutation,
        snapshot: value.safeContextViewSnapshot,
      },
    },
    retrieval: {
      get: `${value.command} get --candidate-id ID --candidate-revision REVISION --generation GENERATION --policy-version POLICY --format json`,
      ...(nextCursor
        ? {
          continue: `${value.command} list${listFlags(options)} --limit ${options.limit} --cursor ${nextCursor} --format json`,
        }
        : {}),
    },
    ...(remaining > 0
      ? {
        omitted: true,
        omitted_count: remaining,
        omission_reason: "page_limit",
        next_cursor: nextCursor,
      }
      : {}),
  };
  if (serializedBytes(response) > value.maxSerializedUtf8Bytes) {
    return failure(
      io,
      `${value.command} list`,
      listSyntax(value),
      `${value.command} list --limit ${value.defaultLimit} --format json`,
      {
        class: "output_bound_exceeded",
        message: `candidate-list response exceeds its ${value.maxSerializedUtf8Bytes}-byte bound`,
        recovery: "Request fewer rows and retry; no partial candidate rows or projection bytes were returned.",
      },
    );
  }
  emitStructured(response, "json", io.out ?? ((text) => process.stdout.write(text)));
  return 0;
}

function exactCandidate(io: Io, options: ExactOptions, value: CandidateReadContract): number {
  const view = currentProjection(io, value, "get");
  if (!view) return 1;
  const projection = view.projection;
  if (
    options.generation !== projection.generation ||
    options.policyVersion !== projection.policy_version
  ) {
    return failure(
      io,
      `${value.command} get`,
      exactSyntax(value),
      exactSyntax(value),
      {
        class: "current_binding_mismatch",
        message: "candidate generation or policy binding is not current",
        recovery: "List the current projection and retry with its exact generation and policy binding; no projection bytes were changed.",
      },
    );
  }
  const sameId = view.candidates.filter(
    (candidate) => candidate.capsule.candidate_id === options.candidateId,
  );
  if (sameId.length === 0) {
    return failure(
      io,
      `${value.command} get`,
      exactSyntax(value),
      exactSyntax(value),
      {
        class: "not_found",
        message: "candidate identity was not found in the current projection",
        recovery: "List the current projection and retry with one returned candidate identity; no projection bytes were changed.",
      },
    );
  }
  const candidate = sameId.find(
    (item) => item.capsule.candidate_revision === options.candidateRevision,
  );
  if (!candidate) {
    return failure(
      io,
      `${value.command} get`,
      exactSyntax(value),
      exactSyntax(value),
      {
        class: "current_binding_mismatch",
        message: "candidate revision is not current for the requested identity",
        recovery: "List the current projection and retry with its exact candidate revision; no projection bytes were changed.",
      },
    );
  }
  const occurrences = candidate.capsule.evidence.map((evidence) =>
    opaqueOccurrence(candidate, evidence),
  );
  if (occurrences.length > value.exactOccurrencesMax) {
    return failure(
      io,
      `${value.command} get`,
      exactSyntax(value),
      exactSyntax(value),
      {
        class: "unsupported_state",
        message: "current candidate exceeds its validated occurrence bound",
        recovery: "Repair the private candidate projection before retrying; no projection bytes were changed.",
      },
    );
  }
  if (
    candidate.safe_excerpt !== null &&
    Buffer.byteLength(candidate.safe_excerpt.text, "utf8") > value.safeContextMaxUtf8Bytes
  ) {
    return failure(
      io,
      `${value.command} get`,
      exactSyntax(value),
      exactSyntax(value),
      {
        class: "unsupported_state",
        message: "current candidate safe context exceeds its validated bound",
        recovery: "Repair the private candidate projection before retrying; no projection bytes were changed.",
      },
    );
  }
  const response: Mapping = {
    schemaVersion: value.schemaVersion,
    command: `${value.command} get`,
    status: "ok",
    generation: projection.generation,
    policy_version: projection.policy_version,
    candidate_projection_sha256: projection.projection_sha256,
    entry: {
      candidate_id: candidate.capsule.candidate_id,
      candidate_revision: candidate.capsule.candidate_revision,
      capsule_sha256: candidate.capsule.capsule_sha256,
      term: candidate.capsule.term,
      meaning: candidate.capsule.meaning,
      scope: candidate.capsule.scope,
      provenance_kind: candidate.capsule.provenance_kind,
      source_family: candidate.source_family,
      evidence_complete: candidate.capsule.evidence_complete,
      evidence_set_sha256: candidate.capsule.evidence_set_sha256,
      occurrence_count: occurrences.length,
      occurrences,
      safe_context: candidate.safe_excerpt === null ? null : { ...candidate.safe_excerpt },
    },
    source: {
      kind: "user_local_candidate_projection",
      owner: projection.owner,
    },
    source_contract: {
      authority: "references/artifacts/glossary-entry-contract.yaml",
      bindings: [...value.exactBindings],
      max_serialized_utf8_bytes: value.exactMaxSerializedUtf8Bytes,
      safe_context_view: {
        authority: value.safeContextViewAuthority,
        retention_days: value.safeContextRetentionDays,
        expiry: value.safeContextViewExpiry,
        mutation: value.safeContextViewMutation,
      },
    },
  };
  if (serializedBytes(response) > value.exactMaxSerializedUtf8Bytes) {
    return failure(
      io,
      `${value.command} get`,
      exactSyntax(value),
      exactSyntax(value),
      {
        class: "output_bound_exceeded",
        message: `candidate exact-read response exceeds its ${value.exactMaxSerializedUtf8Bytes}-byte bound`,
        recovery: "Repair the private candidate projection before retrying; no partial candidate data was returned.",
      },
    );
  }
  emitStructured(response, "json", io.out ?? ((text) => process.stdout.write(text)));
  return 0;
}

/** Read one current user-local candidate projection without prompting or mutating it. */
export function runPersonalGlossaryCandidateReadsCommand(argv: string[], io: Io): number {
  let value: CandidateReadContract;
  try {
    value = contract();
  } catch {
    return failure(
      io,
      "agentera report personal-glossary-candidates",
      "agentera report personal-glossary-candidates {list,get} --format json",
      "agentera report personal-glossary-candidates list --limit 20 --format json",
      {
        class: "unsupported_state",
        message: "personal glossary candidate retrieval contract is unavailable",
        recovery: "Restore the bundled glossary authority, then retry; no projection bytes were changed.",
      },
    );
  }
  const operation = argv[0];
  if (operation !== "list" && operation !== "get") {
    return invalid(io, {
      class: operation ? "unsupported_target" : "missing_argument",
      message: operation
        ? `unsupported personal glossary candidate operation: ${operation}`
        : "candidate operation is required",
      valid_values: ["list", "get"],
      syntax: `${value.command} {list,get} --format json`,
      example: `${value.command} list --limit ${value.defaultLimit} --format json`,
      recovery: "Choose list or get and retry; no projection bytes were changed.",
    });
  }
  if (operation === "list") {
    const parsed = parseList(argv.slice(1), value);
    if ("class" in parsed) {
      return invalid(io, {
        ...parsed,
        recovery: "Correct the bounded list request and retry; no projection bytes were changed.",
      });
    }
    return listCandidates(io, parsed, value);
  }
  const parsed = parseExact(argv.slice(1), value);
  if ("class" in parsed) {
    return invalid(io, {
      ...parsed,
      recovery: "Correct the exact candidate binding and retry; no projection bytes were changed.",
    });
  }
  return exactCandidate(io, parsed, value);
}

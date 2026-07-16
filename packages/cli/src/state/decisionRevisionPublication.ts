/**
 * Task 3: publish record-local amendments with recovery.
 *
 * The amendment publishes ONLY the revision document
 * (`.agentera/revisions/decisions.yaml`), by replacing one stable-ID entry's
 * bytes in place (record-local replacement) and leaving every other entry's
 * bytes, comments, quoting, block scalars, and provenance untouched. The
 * decisions projection (`.agentera/decisions.yaml`) is never rewritten by an
 * amendment: reads already compose base→revisions→overlay (Task 2), so the
 * immutable base record stays byte-stable and the composed read stays the
 * single source of effective detail — the projection representation "agrees"
 * via composition rather than via a redundant rewrite.
 *
 * A safe target-only change is proven before any side effect: the override
 * bytes are spliced into a candidate, the candidate is re-parsed, every other
 * stable ID's canonical value must be unchanged, and the target's value must
 * equal the appended revision list. When the document cannot be safely
 * byte-isolated (malformed, ambiguous boundaries, non-mapping root), apply
 * refuses without side effects rather than reserialize the whole document.
 *
 * Split out of `decisionRevision.ts` so each module stays under the monolith
 * lint gate. The publication primitives (build, find, project, publish) are
 * exported from here; `decisionRevision.ts` re-exports them for callers that
 * still import from the historical entry point.
 */

import fs from "node:fs";

import { parseDocument } from "yaml";

import type { JsonObject } from "../core/jsonValue.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import {
  decisionRevisionContract,
  decisionRevisionPath,
  decisionRevisionViolations,
  legacyFullProjectionFor,
  loadDecisionRevision,
  prepareDecisionAmendment,
  sha256,
  type DecisionAmendmentPreparation,
  type DecisionRevisionContract,
  type DecisionRevisionDocument,
  type DecisionRevisionList,
  type DecisionRevisionRecord,
  type RevisedTargetProvenance,
} from "./decisionRevision.js";
import { localDate } from "./write/assign.js";
import { reject } from "./write/errors.js";
import {
  withStateMutation,
  type StateMutationOptions,
  type StateMutationTransaction,
} from "./write/mutation.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/transaction.js";
import {
  decisionLegacyCoexistence,
  legacyConfidenceCaveat,
} from "./decisionLegacyValidation.js";

const AMEND_RECOVERY_SYNTAX =
  "agentera state decisions amend --number N [--question ... --choice ... --reasoning ... --confidence firm ...] [--dry-run] --format json";
const AMEND_RECOVERY_EXAMPLE =
  'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json';

/** The exact revision record that would be (or was) published for an amendment. */
export interface PublishedRevisionRecord {
  record: DecisionRevisionRecord;
  /** Canonical sha256 of the full revision record (amendable content + meta). */
  identity: string;
}

/**
 * Build the revision record an amendment publishes. It carries only the
 * authority-declared amendable content paths the caller requested, plus
 * revision provenance (`date`, `provenance`, `base_sha256`). Identity and
 * temporal paths are never amended; the base hash ties the revision to the
 * immutable base it was composed against. `degraded_projection` provenance is
 * preserved when the base was bootstrapped from a complete legacy projection
 * record (never promoted to historical_archive).
 */
export function buildPublishedRevisionRecord(
  preparation: DecisionAmendmentPreparation,
  options: { date?: string } = {},
): PublishedRevisionRecord {
  const record: DecisionRevisionRecord = {
    date: options.date ?? localDate(),
    provenance: preparation.base.provenance === "degraded_projection" ? "degraded_projection" : "historical_revision",
    base_sha256: preparation.base.sha256,
  };
  for (const field of preparation.provenance.amended_fields) {
    record[field] = structuredClone(preparation.requested[field]);
  }
  return { record, identity: sha256(record) };
}

/**
 * Find an identical revision already published for a stable ID. Identity is the
 * canonical content of the full revision record (amendable fields + meta);
 * byte-stable per the authority immutability rule, so an identical re-submission
 * resolves as an idempotent replay.
 */
export function findPublishedRevision(
  revisions: DecisionRevisionList,
  identity: string,
): { index: number; revision: DecisionRevisionRecord } | null {
  for (let index = 0; index < revisions.length; index += 1) {
    if (sha256(revisions[index]) === identity) {
      return { index, revision: revisions[index] };
    }
  }
  return null;
}

/**
 * A revision sharing the publication slot (same `date` + `base_sha256`) but
 * carrying different amendable content is a duplicate-revision conflict: the
 * ordering between them is ambiguous and neither may silently win.
 */
export function findConflictingRevision(
  revisions: DecisionRevisionList,
  candidate: DecisionRevisionRecord,
): { index: number; revision: DecisionRevisionRecord } | null {
  for (let index = 0; index < revisions.length; index += 1) {
    const existing = revisions[index];
    if (sha256(existing) === sha256(candidate)) continue; // identical -> replay
    if (
      typeof existing.date === "string" &&
      typeof candidate.date === "string" &&
      existing.date === candidate.date &&
      existing.base_sha256 === candidate.base_sha256
    ) {
      return { index, revision: existing };
    }
  }
  return null;
}

/** Outcome of projecting a record-local override for one stable ID. */
export interface RevisionOverrideProjection {
  stableId: string;
  before: DecisionRevisionList;
  after: DecisionRevisionList;
  bytes: string;
  /** Unchanged-byte proof: canonical values of every other stable ID. */
  unchangedOthers: { stableId: string; identity: string }[];
}

interface RecordLocalSplice {
  safe: true;
  bytes: string;
  existing: boolean;
  before: DecisionRevisionList;
  after: DecisionRevisionList;
}

interface RecordLocalUnsafe {
  safe: false;
  reason: string;
}

interface RevisionNodeShape {
  range?: number[];
  value?: string;
  items?: unknown[];
  toJSON?: () => unknown;
}
interface RevisionPairShape {
  key?: RevisionNodeShape;
  value?: RevisionNodeShape;
}

/** Coerce a CST list item into a plain revision record (its JSON value). */
function toRevisionRecord(node: RevisionNodeShape | undefined): DecisionRevisionRecord {
  if (!node) return {} as DecisionRevisionRecord;
  if (typeof node.toJSON === "function") {
    return node.toJSON() as DecisionRevisionRecord;
  }
  return structuredClone(node) as unknown as DecisionRevisionRecord;
}

/**
 * Project the new revision-list bytes for one stable ID by splicing the
 * target entry into the existing document bytes, preserving every other
 * entry byte-for-byte. The returned `bytes` are validated by an unchanged-byte
 * proof (re-parse + canonical comparison of every other stable ID) before the
 * caller stages them.
 *
 * When the existing document is absent the override becomes the whole
 * document. When the target ID is absent the override entry is appended. When
 * the target ID is present its key+value byte range is replaced wholesale with
 * a freshly-serialized entry. Any failure to safely isolate the byte boundary
 * (malformed document, non-mapping root, ambiguous identity) returns
 * `{ safe: false }` so the caller refuses without side effects.
 */
export function projectRevisionOverride(
  documentBytes: string,
  stableId: string,
  nextRevisions: DecisionRevisionList,
  contract: DecisionRevisionContract = decisionRevisionContract(resolveSourceRoot()),
): RecordLocalSplice | RecordLocalUnsafe {
  const entryBytes = dumpYamlMapping({ [stableId]: nextRevisions });
  if (documentBytes.length === 0) {
    return {
      safe: true,
      bytes: entryBytes,
      existing: false,
      before: [],
      after: structuredClone(nextRevisions),
    };
  }
  let parsedDoc;
  try {
    parsedDoc = parseDocument(documentBytes);
  } catch (error) {
    return { safe: false, reason: `cannot parse decision revision document: ${(error as Error).message}` };
  }
  const root = parsedDoc.contents as unknown as RevisionNodeShape | null;
  if (!root || !Array.isArray(root.items)) {
    return { safe: false, reason: "decision revision document root must be a mapping keyed by stable decision ID" };
  }
  let before: DecisionRevisionList = [];
  let spliceStart: number;
  let spliceEnd: number;
  let existing = false;
  const items = root.items as RevisionPairShape[];
  const target = items.find((pair) => pair.key && pair.key.value === stableId);
  if (target) {
    existing = true;
    const keyRange = target.key?.range;
    const valueRange = target.value?.range;
    if (!keyRange || !valueRange) {
      return { safe: false, reason: `decision revision entry '${stableId}' has no isolatable byte range` };
    }
    spliceStart = keyRange[0];
    spliceEnd = valueRange[1];
    const valueNode = target.value;
    if (!valueNode || !Array.isArray(valueNode.items)) {
      return { safe: false, reason: `decision revision entry '${stableId}' must be an ordered list` };
    }
    before = (valueNode.items as RevisionNodeShape[]).map((item) => structuredClone(toRevisionRecord(item)));
  } else {
    // Append the new entry after the last byte of the document.
    spliceStart = documentBytes.length;
    spliceEnd = documentBytes.length;
    const needsNewline = documentBytes.length > 0 && !documentBytes.endsWith("\n");
    const candidate = `${needsNewline ? "\n" : ""}${entryBytes}`;
    return {
      safe: true,
      bytes: documentBytes.slice(0, spliceStart) + candidate,
      existing: false,
      before: [],
      after: structuredClone(nextRevisions),
    };
  }
  const candidate = documentBytes.slice(0, spliceStart) + entryBytes + documentBytes.slice(spliceEnd);
  // Unchanged-byte proof: re-parse the candidate and verify every other stable
  // ID's canonical value is identical to the original document's.
  let candidateMapping: Record<string, unknown>;
  try {
    candidateMapping = loadYamlMapping(candidate);
  } catch (error) {
    return { safe: false, reason: `record-local splice produced an unparseable document: ${(error as Error).message}` };
  }
  const originalMapping = loadYamlMapping(documentBytes);
  for (const [id, value] of Object.entries(originalMapping)) {
    if (id === stableId) continue;
    const candidateValue = candidateMapping[id];
    if (canonicalRecordJson(candidateValue) !== canonicalRecordJson(value)) {
      return {
        safe: false,
        reason: `record-local splice would alter unrelated revision entry '${id}'; refusing without side effects`,
      };
    }
  }
  const violations = decisionRevisionViolations(candidateMapping, contract);
  if (violations.length > 0) {
    return { safe: false, reason: `record-local splice produced an invalid revision document: ${violations.join("; ")}` };
  }
  const targetValue = candidateMapping[stableId];
  if (!Array.isArray(targetValue) || canonicalRecordJson(targetValue) !== canonicalRecordJson(nextRevisions)) {
    return { safe: false, reason: `record-local splice did not place the appended revision under '${stableId}'` };
  }
  return {
    safe: true,
    bytes: candidate,
    existing,
    before: before as DecisionRevisionList,
    after: structuredClone(nextRevisions),
  };
}

/** The projection effect an amendment reports for the current decisions projection. */
export interface AmendmentProjectionEffect {
  path: string;
  representation: "full" | "summary" | "missing" | "absent";
  /** The decisions projection is never rewritten by an amendment. */
  rewritten: false;
  reason: string;
  /** Canonical hash of the base record as read at preparation time. */
  base_sha256: string;
}

/** Result of publishing (or dry-running) an amendment. */
export interface DecisionAmendmentPublication {
  number: number;
  revision: DecisionRevisionRecord;
  revision_identity: string;
  revision_path: string;
  effective: JsonObject;
  replay: boolean;
  published: boolean;
  projection_effect: AmendmentProjectionEffect;
  provenance: RevisedTargetProvenance;
  dry_run: boolean;
  diff?: string;
  before?: DecisionRevisionDocument;
  after?: DecisionRevisionDocument;
}

function readRevisionDocumentBytes(revisionPath: string): string {
  if (!fs.existsSync(revisionPath)) return "";
  return fs.readFileSync(revisionPath, "utf8");
}

function diffRevisionDocuments(before: string, after: string, label: string): string {
  if (before === after) return "";
  const beforeLines = before.length === 0 ? [] : before.split(/\n/);
  const afterLines = after.split(/\n/);
  const lines: string[] = [`--- ${label} (before)`, `+++ ${label} (after)`];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
      lines.push(` ${beforeLines[i]}`);
      i += 1;
      j += 1;
    } else if (j < afterLines.length) {
      lines.push(`+${afterLines[j]}`);
      j += 1;
    } else {
      lines.push(`-${beforeLines[i]}`);
      i += 1;
    }
  }
  return lines.join("\n");
}

/**
 * Publish a record-local decision amendment with recovery. Re-prepares the
 * target inside the writer lock so a retry re-derives the same canonical
 * revision identity; an identical re-submission is an idempotent replay that
 * touches no file. Staging, revision publication, directory synchronization,
 * and projection-consistency are distinct failure boundaries: an interruption
 * at any boundary converges on retry without duplicates or mixed state.
 *
 * `transaction` is required for a real apply; omit it (or pass `dryRun`) for a
 * side-effect-free projection of the revision, effective record, and
 * projection effect. Calling with `dryRun: false` and no `transaction` is a
 * caller error and refuses before any side effect.
 */
export function publishDecisionAmendment(
  projectRoot: string,
  preparation: DecisionAmendmentPreparation,
  options: {
    transaction?: StateMutationTransaction;
    dryRun: boolean;
    date?: string;
    sourceRoot?: string;
  },
): DecisionAmendmentPublication {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const contract = decisionRevisionContract(sourceRoot);
  const { record: revision, identity } = buildPublishedRevisionRecord(preparation, { date: options.date });
  const stableId = `${contract.identityPrefix}:${preparation.number}`;
  const revisionPath = decisionRevisionPath(projectRoot, sourceRoot);

  const existingBytes = readRevisionDocumentBytes(revisionPath);
  let existingDocument: DecisionRevisionDocument = {};
  if (existingBytes.length > 0) {
    try {
      existingDocument = loadDecisionRevision(projectRoot, sourceRoot);
    } catch (error) {
      reject({
        class: "conflict",
        message: `decision ${preparation.number} amendment cannot proceed: the revision document is broken: ${(error as Error).message}`,
        syntax: AMEND_RECOVERY_SYNTAX,
        example: AMEND_RECOVERY_EXAMPLE,
        recovery: "Preserve the revision document for diagnostics, repair its YAML and amendable content paths, then retry the amend.",
      });
    }
  }
  const existingRevisions = existingDocument[stableId] ?? [];

  // Idempotent replay: the exact revision is already published.
  const replayMatch = findPublishedRevision(existingRevisions, identity);
  if (replayMatch) {
    return {
      number: preparation.number,
      revision,
      revision_identity: identity,
      revision_path: revisionPath,
      effective: structuredClone(preparation.effective),
      replay: true,
      published: false,
      projection_effect: projectionEffectFor(
        preparation,
        projectRoot,
        sourceRoot,
        existingBytes.length === 0 ? revisionPath : revisionPath,
      ),
      provenance: preparation.provenance,
      dry_run: options.dryRun,
      ...(options.dryRun
        ? {
            diff: "",
            before: structuredClone(existingDocument),
            after: structuredClone(existingDocument),
          }
        : {}),
    };
  }

  // Duplicate-revision conflict: same slot (date + base_sha256), different content.
  const conflict = findConflictingRevision(existingRevisions, revision);
  if (conflict) {
    reject({
      class: "conflict",
      message: `decision ${preparation.number} already has a revision for ${revision.date} against the same base with different content; the ordering between them is ambiguous`,
      syntax: AMEND_RECOVERY_SYNTAX,
      example: AMEND_RECOVERY_EXAMPLE,
      recovery: `Preserve the published revisions, reconcile which amendment for ${revision.date} is authoritative, then retry with a distinct date or after removing the conflicting revision; no files were changed.`,
    });
  }

  const nextRevisions: DecisionRevisionList = [...existingRevisions, structuredClone(revision)];
  const projection = projectRevisionOverride(existingBytes, stableId, nextRevisions, contract);
  if (!projection.safe) {
    reject({
      class: "conflict",
      message: `decision ${preparation.number} amendment cannot be applied with a safe record-local byte boundary: ${projection.reason}`,
      syntax: AMEND_RECOVERY_SYNTAX,
      example: AMEND_RECOVERY_EXAMPLE,
      recovery: "Preserve the revision document for diagnostics, repair its structure (mapping of stable ID → ordered revision list), then retry; no unrelated bytes are reserialized and no files were changed.",
    });
  }

  if (options.dryRun) {
    return {
      number: preparation.number,
      revision,
      revision_identity: identity,
      revision_path: revisionPath,
      effective: structuredClone(preparation.effective),
      replay: false,
      published: false,
      projection_effect: projectionEffectFor(preparation, projectRoot, sourceRoot, revisionPath),
      provenance: preparation.provenance,
      dry_run: true,
      diff: diffRevisionDocuments(existingBytes, projection.bytes, revisionPath),
      before: structuredClone(existingDocument),
      after: structuredClone(loadYamlMapping(projection.bytes) as DecisionRevisionDocument),
    };
  }

  if (!options.transaction) {
    reject({
      class: "invalid_request",
      message: `decision ${preparation.number} amend apply requires a state mutation transaction; a dry-run does not require one`,
      syntax: AMEND_RECOVERY_SYNTAX,
      example: AMEND_RECOVERY_EXAMPLE,
      recovery: "Pass a StateMutationTransaction (the state writer does this for an apply); use --dry-run for a side-effect-free projection.",
    });
  }
  const transaction = options.transaction as StateMutationTransaction;
  transaction.publishRevisionDocument(revisionPath, projection.bytes, existingBytes.length === 0 ? undefined : existingBytes);
  // After the immutable revision evidence is durable, verify the decisions
  // projection base still agrees with the base_sha256 recorded on the revision.
  // A concurrent projection change or stale base hash is caught here; the
  // published revision is truthful evidence, the decisions projection bytes are
  // preserved, and the caller receives an actionable retry/repair action.
  verifyProjectionConsistency(preparation, projectRoot, sourceRoot);
  transaction.revisionConsistencyCheckpoint();

  return {
    number: preparation.number,
    revision,
    revision_identity: identity,
    revision_path: revisionPath,
    effective: structuredClone(preparation.effective),
    replay: false,
    published: true,
    projection_effect: projectionEffectFor(preparation, projectRoot, sourceRoot, revisionPath),
    provenance: preparation.provenance,
    dry_run: false,
    diff: diffRevisionDocuments(existingBytes, projection.bytes, revisionPath),
    before: structuredClone(existingDocument),
    after: structuredClone(loadYamlMapping(projection.bytes) as DecisionRevisionDocument),
  };
}

function projectionEffectFor(
  preparation: DecisionAmendmentPreparation,
  projectRoot: string,
  sourceRoot: string,
  revisionPath: string,
): AmendmentProjectionEffect {
  return {
    path: preparation.provenance.current_projection.path,
    representation: preparation.provenance.current_projection.representation,
    rewritten: false,
    reason: "amendment publishes immutable revision evidence; the decisions projection stays byte-stable and reads compose base→revisions→overlay",
    base_sha256: preparation.base.sha256,
    ...(revisionPath ? {} : {}),
  };
}

/**
 * Re-read the decisions projection base for the amended decision and verify its
 * canonical hash still matches the `base_sha256` recorded on the published
 * revision. A mismatch means the projection drifted after preparation (a
 * concurrent change or a stale base); the amendment refuses to claim success
 * and surfaces an actionable retry/repair action while preserving all bytes.
 */
function verifyProjectionConsistency(
  preparation: DecisionAmendmentPreparation,
  projectRoot: string,
  sourceRoot: string,
): void {
  const number = preparation.number;
  const projectionPath = preparation.provenance.current_projection.path;
  if (preparation.base.source === "archive") {
    // An immutable numbered archive base cannot drift within a writer lock.
    return;
  }
  // degraded_projection base: re-read the legacy full projection record.
  const projection = legacyFullProjectionFor(projectRoot, number, projectionPath, sourceRoot);
  if (projection.kind !== "full") {
    reject({
      class: "conflict",
      message: `decision ${number} projection changed before the amendment completed; the hash-verified base is no longer recoverable`,
      syntax: AMEND_RECOVERY_SYNTAX,
      example: AMEND_RECOVERY_EXAMPLE,
      recovery: "Preserve the published revision and the projection bytes, reconcile the base drift, then retry the amend.",
    });
  }
  const currentHash = sha256(projection.record);
  if (currentHash !== preparation.base.sha256) {
    reject({
      class: "conflict",
      message: `decision ${number} projection base changed before the amendment completed; the revision was published against a stale base hash`,
      syntax: AMEND_RECOVERY_SYNTAX,
      example: AMEND_RECOVERY_EXAMPLE,
      recovery: "Preserve the published revision and the projection bytes, reconcile the base drift (the published revision carries the original base_sha256), then retry the amend.",
    });
  }
}

/* ===========================================================================
 * Writer bridge: shape the typed state-writer request into the amendment
 * publication call and report the result as a StateWriteEnvelope. The envelope
 * carries the published revision, the composed effective record, the projection
 * effect, and the revision identity (for stable idempotent-replay detection).
 * ========================================================================= */

function mapping(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildAmendmentRequested(values: Record<string, unknown>): Record<string, unknown> {
  const requested: Record<string, unknown> = {};
  const alternatives = mapping(values.alternatives);
  const rejected = Array.isArray(alternatives.rejected) ? alternatives.rejected : [];
  const hasAlternatives =
    alternatives.chosen !== undefined || rejected.length > 0;
  if (hasAlternatives) {
    requested.alternatives = [
      ...(alternatives.chosen !== undefined
        ? [{ name: alternatives.chosen, status: "chosen" }]
        : []),
      ...rejected.map((name) => ({ name, status: "rejected" })),
    ];
  }
  for (const field of ["question", "context", "choice", "reasoning", "confidence", "feeds_into"]) {
    if (values[field] !== undefined) requested[field] = values[field];
  }
  return requested;
}

/**
 * Publish (or dry-run) a record-local decision-content amendment. Re-prepares
 * the target inside the writer lock so a retry re-derives the same canonical
 * revision identity; the state writer remains the sole authority over the
 * revision document. Returns the published revision, effective record, and
 * projection effect; the decisions projection bytes are never rewritten.
 */
function executeDecisionAmendment(
  req: StateWriteRequest,
  transaction?: StateMutationTransaction,
): StateWriteEnvelope {
  const number = Number(req.values.number);
  if (!Number.isSafeInteger(number) || number < 1) {
    reject({
      class: "invalid_request",
      message: `decision amend requires a positive decision number; received ${req.values.number ?? ""}`,
      syntax: "agentera state decisions amend --number N [--question ... --confidence firm ...] [--dry-run] --format json",
      example: 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json',
    });
  }
  const requested = buildAmendmentRequested(req.values);
  const preparation = prepareDecisionAmendment(req.projectRoot, number, requested, {
    sourceRoot: resolveSourceRoot(),
  });
  const publication = publishDecisionAmendment(req.projectRoot, preparation, {
    transaction,
    dryRun: req.dryRun,
  });
  // Amendment never rewrites the projection, so an untouched inherited legacy
  // confidence label on the base survives byte-stable in the composed read.
  // Surface it as a truthful compatibility caveat when the amendment did not
  // amend confidence. A confidence the caller amended is current vocabulary
  // (enforced at preparation) and produces no caveat.
  const confidenceTouched = preparation.provenance.amended_fields.includes("confidence");
  const amendCaveat = legacyConfidenceCaveat(
    preparation.effective,
    decisionLegacyCoexistence(resolveSourceRoot()),
    confidenceTouched,
    preparation.provenance.base === "historical_archive" ? "archive" : "active",
  );
  const result: StateWriteEnvelope = {
    schemaVersion: "agentera.stateWrite.v1",
    command: "state decisions amend",
    status: "pass",
    artifact: req.artifact,
    path: publication.revision_path,
    operation: {
      verb: "amend",
      dry_run: publication.dry_run,
      idempotent_replay: publication.replay,
      forced: req.force,
    },
    assigned: { number: publication.number },
    written: {
      ...structuredClone(publication.revision),
      revision_identity: publication.revision_identity,
    },
    state: {
      revision_document: publication.revision_path,
      revision_count: publication.after ? Object.keys(publication.after).length : 0,
    },
    validation: { status: "pass", violations: [] },
    ...(amendCaveat ? { compatibility: { legacy_caveats: [amendCaveat] } } : {}),
    compaction: null,
    amendment: {
      number: publication.number,
      revision: structuredClone(publication.revision),
      revision_identity: publication.revision_identity,
      effective: publication.effective,
      published: publication.published,
      provenance: publication.provenance,
      projection_effect: publication.projection_effect,
    },
  };
  if (publication.diff !== undefined) {
    result.diff = publication.diff;
    result.before = (publication.before ?? {}) as Record<string, unknown>;
    result.after = (publication.after ?? {}) as Record<string, unknown>;
  }
  return result;
}

/**
 * Dispatch an amend request through the typed state writer. Dry-run bypasses
 * the writer lock; a real apply stages, publishes the immutable revision
 * evidence, fsyncs the directory, and runs the projection-consistency
 * checkpoint inside a single StateMutationTransaction. Each interruption
 * boundary converges on retry with a stable revision identity.
 */
export function dispatchDecisionAmendment(
  req: StateWriteRequest,
  options: StateMutationOptions = {},
): StateWriteEnvelope {
  if (req.dryRun) return executeDecisionAmendment(req);
  return withStateMutation(
    req.projectRoot,
    (transaction) => executeDecisionAmendment(req, transaction),
    options,
  );
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  canonicalTerminologyJson,
  type TerminologyDriftFinding,
  validateTerminologyProposal,
} from "../../audit/terminologyDrift.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { dumpYamlMapping, loadYamlMapping } from "../../core/yaml.js";
import {
  loadArtifactRecord,
  resolveArtifactPath,
} from "../../registries/artifactRegistry.js";
import { validateGlossaryEntry } from "../../registries/glossaryEntryContract.js";
import type { ValidatedProjectRoot } from "../projectRoot.js";
import { assertValidatedProjectRoot } from "../projectRoot.js";
import { reject } from "./errors.js";
import { withStateMutation, type StateMutationOptions } from "./mutation.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./operations.js";

const REQUEST_VERSION = "agentera.glossaryPublicationRequest.v1";
const DOCUMENT_VERSION = "agentera.projectGlossary.v1";
const REQUEST_FIELDS = ["schema_version", "proposal", "confirmation"];

interface Confirmation extends JsonObject {
  proposal_digest: string;
  confirmed_by: "user";
  confirmed_at: string;
}

export interface ProjectGlossaryApproval extends JsonObject {
  proposal_digest: string;
  proposal: TerminologyDriftFinding & JsonObject;
  confirmation: Confirmation;
}

export interface ProjectGlossaryDocument extends JsonObject {
  schema_version: typeof DOCUMENT_VERSION;
  approvals: ProjectGlossaryApproval[];
  entries: JsonObject[];
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((field) => allowed.includes(field));
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, offsetHour = "00", offsetMinute = "00"] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return calendar.getUTCFullYear() === Number(year)
    && calendar.getUTCMonth() + 1 === Number(month)
    && calendar.getUTCDate() === Number(day)
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
    && Number(offsetHour) <= 23
    && Number(offsetMinute) <= 59;
}

function correction(
  message: string,
  classification: "schema_violation" | "conflict" = "schema_violation",
  recovery = "Rerun audit against current project files, obtain explicit user confirmation for the returned proposal_digest, and retry the same glossary publish command.",
): never {
  reject({
    class: classification,
    message,
    recovery,
    example: "agentera state glossary publish --input glossary-publication.yaml --format json",
  });
}

function proposal(value: unknown): TerminologyDriftFinding {
  const validated = validateTerminologyProposal(value);
  if (!validated.proposal) {
    correction(`proposal is not canonical Audit output: ${validated.violations.join("; ")}`);
  }
  return validated.proposal;
}

function confirmation(value: unknown, digest: string): Confirmation {
  if (!mapping(value) || !exactFields(value, ["proposal_digest", "confirmed_by", "confirmed_at"])) {
    correction("confirmation must contain only proposal_digest, confirmed_by, and confirmed_at");
  }
  if (value.confirmed_by !== "user") {
    correction("confirmation.confirmed_by must be 'user'; generic consent or agent attribution is not approval");
  }
  if (!validTimestamp(value.confirmed_at)) {
    correction("confirmation.confirmed_at must be a valid ISO 8601 timestamp with timezone");
  }
  if (value.proposal_digest !== digest) {
    correction("confirmation.proposal_digest does not bind the submitted proposal");
  }
  return value as Confirmation;
}

export function containsGlossaryTerm(line: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const identifier = /[\p{L}\p{N}_$]/u;
  const characters = [...term];
  const prefix = identifier.test(characters[0] ?? "") ? "(?<![\\p{L}\\p{N}_$])" : "";
  const suffix = identifier.test(characters.at(-1) ?? "") ? "(?![\\p{L}\\p{N}_$])" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "u").test(line);
}

function revalidateEvidence(root: ValidatedProjectRoot, proposalValue: TerminologyDriftFinding): void {
  const groups = [
    { term: proposalValue.proposed_canonical_term, evidence: proposalValue.canonical_evidence },
    ...proposalValue.variants,
  ];
  for (const group of groups) {
    for (const record of group.evidence) {
      assertValidatedProjectRoot(root);
      const candidate = path.resolve(root.path, record.source_path);
      let resolved: string;
      try {
        resolved = fs.realpathSync(candidate);
      } catch {
        correction(`source evidence '${record.source_path}:${record.line}' is missing or unreadable`);
      }
      if (!resolved.startsWith(`${root.path}${path.sep}`) || !fs.statSync(resolved).isFile()) {
        correction(`source evidence '${record.source_path}:${record.line}' escapes the project or is not a file`);
      }
      const canonicalPath = path.relative(root.path, resolved).split(path.sep).join(path.posix.sep);
      if (canonicalPath !== record.source_path) {
        correction(`source evidence '${record.source_path}:${record.line}' is not the canonical Audit-emitted project identity '${canonicalPath}:${record.line}'`);
      }
      const line = fs.readFileSync(resolved, "utf8").split(/\r?\n/)[record.line - 1];
      const digest = line === undefined ? "" : crypto.createHash("sha256").update(line).digest("hex");
      if (line === undefined || digest !== record.source_record_sha256 || !containsGlossaryTerm(line, group.term)) {
        correction(`source evidence '${record.source_path}:${record.line}' is stale or no longer identifies '${group.term}'`);
      }
    }
  }
}

function deriveEntry(proposalValue: TerminologyDriftFinding, confirmed: Confirmation): JsonObject {
  const source = proposalValue.canonical_evidence[0]!;
  const date = confirmed.confirmed_at.slice(0, 10);
  const entry: JsonObject = {
    term: proposalValue.proposed_canonical_term,
    meaning: proposalValue.concept,
    confidence: proposalValue.confidence,
    permanence: "stable",
    temporal: { observed_at: date, last_confirmed_at: date },
    provenance: {
      kind: "project_file",
      evidence: [{ source_path: source.source_path, source_record_sha256: source.source_record_sha256 }],
    },
  };
  const violations = validateGlossaryEntry(entry, "project");
  if (violations.length > 0) correction(`derived project glossary entry is invalid: ${violations.join("; ")}`);
  return entry;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalTerminologyJson(left) === canonicalTerminologyJson(right);
}

function parseApproval(value: unknown, index: number): { approval: ProjectGlossaryApproval; entry: JsonObject } {
  if (!mapping(value) || !exactFields(value, ["proposal_digest", "proposal", "confirmation"])) {
    correction(`existing approvals[${index}] is malformed`, "conflict");
  }
  const proposed = proposal(value.proposal);
  const confirmed = confirmation(value.confirmation, proposed.proposal_digest);
  if (value.proposal_digest !== proposed.proposal_digest) {
    correction(`existing approvals[${index}] has conflicting digest identity`, "conflict");
  }
  return {
    approval: { proposal_digest: proposed.proposal_digest, proposal: proposed as TerminologyDriftFinding & JsonObject, confirmation: confirmed },
    entry: deriveEntry(proposed, confirmed),
  };
}

function existingDocument(bytes: string): ProjectGlossaryDocument {
  let value: Record<string, unknown>;
  try {
    value = loadYamlMapping(bytes);
  } catch (error) {
    correction(`existing glossary document is malformed: ${(error as Error).message}`, "conflict");
  }
  if (!exactFields(value, ["schema_version", "approvals", "entries"]) || value.schema_version !== DOCUMENT_VERSION || !Array.isArray(value.approvals) || !Array.isArray(value.entries)) {
    correction(`existing glossary document must use ${DOCUMENT_VERSION} with approvals and entries lists`, "conflict");
  }
  const approvals = value.approvals.map((item, index) => parseApproval(item, index));
  const entries = value.entries as unknown[];
  if (entries.length !== approvals.length) correction("existing glossary approvals and entries do not form complete publication pairs", "conflict");
  const terminologyIdentities = new Map<string, { canonical: string; index: number }>();
  const digestIdentities = new Set<string>();
  for (const [index, item] of entries.entries()) {
    if (!mapping(item)) correction(`existing entries[${index}] is malformed`, "conflict");
    const violations = validateGlossaryEntry(item, "project");
    if (violations.length > 0) correction(`existing entries[${index}] is malformed: ${violations.join("; ")}`, "conflict");
    if (!same(item, approvals[index]!.entry)) correction(`existing approval and entry at index ${index} do not match`, "conflict");
    const canonical = String(item.term);
    const digest = approvals[index]!.approval.proposal_digest;
    if (digestIdentities.has(digest)) correction("existing glossary contains duplicate term or approval identity", "conflict");
    digestIdentities.add(digest);
    const terms = [canonical, ...approvals[index]!.approval.proposal.variants.map(({ term }) => term)];
    for (const term of terms) {
      const identity = term.toLowerCase();
      const existing = terminologyIdentities.get(identity);
      if (existing && existing.index !== index) {
        correction(
          `terminology identity collision for '${term}' between canonical sets '${existing.canonical}' and '${canonical}'`,
          "conflict",
          `Choose distinct canonical and variant terms for '${existing.canonical}' and '${canonical}', rerun audit, obtain confirmation for the corrected proposal, and retry the same glossary publish command.`,
        );
      }
      terminologyIdentities.set(identity, { canonical, index });
    }
  }
  return {
    schema_version: DOCUMENT_VERSION,
    approvals: approvals.map(({ approval }) => approval),
    entries: entries as JsonObject[],
  };
}

function validateCandidateBytes(bytes: string): ProjectGlossaryDocument {
  return existingDocument(bytes);
}

export function loadProjectGlossaryDocument(
  projectRoot: string,
): { path: string; document: ProjectGlossaryDocument } | null {
  const record = loadArtifactRecord("glossary");
  if (!record) correction("registered glossary artifact is unavailable");
  const target = resolveArtifactPath(record, projectRoot);
  if (!fs.existsSync(target)) return null;
  return { path: target, document: existingDocument(fs.readFileSync(target, "utf8")) };
}

export function publishGlossary(
  req: StateWriteRequest,
  root: ValidatedProjectRoot,
  options: StateMutationOptions = {},
): StateWriteEnvelope {
  if (!req.input || !exactFields(req.input, REQUEST_FIELDS) || req.input.schema_version !== REQUEST_VERSION) {
    correction(`publication request must use ${REQUEST_VERSION} and contain only proposal and confirmation`);
  }
  const proposed = proposal(req.input.proposal);
  const confirmed = confirmation(req.input.confirmation, proposed.proposal_digest);
  const entry = deriveEntry(proposed, confirmed);
  const approval: ProjectGlossaryApproval = {
    proposal_digest: proposed.proposal_digest,
    proposal: proposed as TerminologyDriftFinding & JsonObject,
    confirmation: confirmed,
  };
  const record = loadArtifactRecord("glossary");
  if (!record) correction("registered glossary artifact is unavailable");

  return withStateMutation(root.path, (transaction) => {
    assertValidatedProjectRoot(root);
    const target = resolveArtifactPath(record, root.path, { strictWrite: true });
    const relativePath = path.relative(root.path, target).split(path.sep).join("/");
    revalidateEvidence(root, proposed);
    const previousBytes = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const current: ProjectGlossaryDocument = previousBytes
      ? existingDocument(previousBytes)
      : { schema_version: DOCUMENT_VERSION, approvals: [], entries: [] };
    const approvalIndex = current.approvals.findIndex((item) => item.proposal_digest === proposed.proposal_digest);
    const termIndex = current.entries.findIndex((item) => String(item.term).toLowerCase() === proposed.proposed_canonical_term.toLowerCase());
    if (approvalIndex >= 0 || termIndex >= 0) {
      if (approvalIndex === termIndex && approvalIndex >= 0 && same(current.approvals[approvalIndex], approval) && same(current.entries[termIndex], entry)) {
        return {
          schemaVersion: "agentera.stateWrite.v1",
          status: "pass",
          command: "state glossary publish",
          artifact: "glossary",
          path: relativePath,
          operation: { dry_run: req.dryRun, changed: false, idempotent_replay: true },
          candidate: current,
        };
      }
      correction(`confirmed term '${proposed.proposed_canonical_term}' conflicts with existing approval or entry state`, "conflict");
    }
    const candidate: ProjectGlossaryDocument = {
      schema_version: DOCUMENT_VERSION,
      approvals: [...current.approvals, approval],
      entries: [...current.entries, entry],
    };
    const bytes = dumpYamlMapping(candidate);
    validateCandidateBytes(bytes);
    if (!req.dryRun) {
      const stage = transaction.stageProjection(target, bytes);
      try {
        transaction.syncStaged(stage);
        assertValidatedProjectRoot(root);
        transaction.publishProjection(stage, target, previousBytes);
      } finally {
        transaction.removeStage(stage);
      }
    }
    return {
      schemaVersion: "agentera.stateWrite.v1",
      status: "pass",
      command: "state glossary publish",
      artifact: "glossary",
      path: relativePath,
      operation: { dry_run: req.dryRun, changed: true, idempotent_replay: false },
      candidate,
    };
  }, options, root);
}

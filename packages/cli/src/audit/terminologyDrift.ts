import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import { isSafeProjectSourcePath } from "../registries/glossaryEntryContract.js";
import { unicodeCaselessExact } from "../registries/glossaryTermIdentity.js";
import { containsGlossaryTerm } from "../registries/glossaryTermOccurrence.js";

export type FindingSeverity = "critical" | "warning" | "info";

export interface ProjectTermEvidenceInput {
  source_path: string;
  line: number;
}

export interface AssessedProjectTerm {
  term: string;
  evidence: ProjectTermEvidenceInput[];
}

export interface AssessedTerminologyConcept {
  concept: string;
  confidence: number;
  severity: FindingSeverity;
  terms: AssessedProjectTerm[];
}

export interface TerminologyDriftInput {
  projectRoot: string;
  concepts: AssessedTerminologyConcept[];
  personalTerms?: ReadonlyMap<string, string>;
  deliberateDecisionConcepts: ReadonlySet<string>;
  trackedIssueConcepts: ReadonlySet<string>;
}

export interface ProjectTermEvidence extends ProjectTermEvidenceInput {
  source_record_sha256: string;
}

export interface TerminologyDriftFinding {
  family: "terminology_drift";
  concept: string;
  proposed_canonical_term: string;
  canonical_evidence: ProjectTermEvidence[];
  variants: Array<{ term: string; evidence: ProjectTermEvidence[] }>;
  severity: FindingSeverity;
  confidence: number;
  personal_divergence?: { personal_term: string; project_term: string };
  proposal_digest: string;
}

type ProposalWithoutDigest = Omit<TerminologyDriftFinding, "proposal_digest">;

export interface TerminologyProposalValidation {
  proposal: TerminologyDriftFinding | null;
  violations: string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic variant ordering only; never use this key for term identity. */
function variantSortKey(term: string): string {
  return term.toLowerCase();
}

function orderedEvidence(evidence: ProjectTermEvidence[]): ProjectTermEvidence[] {
  return [...evidence].sort(
    (left, right) =>
      compareText(left.source_path, right.source_path)
      || left.line - right.line
      || compareText(left.source_record_sha256, right.source_record_sha256),
  );
}

function evidenceIdentity(item: ProjectTermEvidence): string {
  return `${item.source_path}:${item.line}`;
}

function proposalWithoutDigest(proposal: TerminologyDriftFinding | ProposalWithoutDigest): ProposalWithoutDigest {
  const { proposal_digest: _digest, ...finding } = proposal as TerminologyDriftFinding;
  return {
    ...finding,
    canonical_evidence: orderedEvidence(finding.canonical_evidence),
    variants: finding.variants
      .map((variant) => ({ ...variant, evidence: orderedEvidence(variant.evidence) }))
      .sort(
        (left, right) =>
          compareText(variantSortKey(left.term), variantSortKey(right.term))
          || compareText(left.term, right.term),
      ),
  };
}

export function canonicalTerminologyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTerminologyJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalTerminologyJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Digest one complete finding while ignoring semantically irrelevant array order. */
export function terminologyProposalDigest(
  proposal: TerminologyDriftFinding | ProposalWithoutDigest,
): string {
  return crypto
    .createHash("sha256")
    .update(canonicalTerminologyJson(proposalWithoutDigest(proposal)))
    .digest("hex");
}

function canonicalProposal(
  seed: Omit<ProposalWithoutDigest, "proposed_canonical_term" | "canonical_evidence" | "variants"> & {
    terms: Array<{ term: string; evidence: ProjectTermEvidence[] }>;
  },
): TerminologyDriftFinding {
  const ordered = seed.terms
    .map((term) => ({ term: term.term, evidence: orderedEvidence(term.evidence) }))
    .sort((left, right) => right.evidence.length - left.evidence.length || compareText(left.term, right.term));
  const [canonical, ...variants] = ordered;
  const finding: ProposalWithoutDigest = {
    family: "terminology_drift",
    concept: seed.concept,
    proposed_canonical_term: canonical!.term,
    canonical_evidence: canonical!.evidence,
    variants: variants.sort(
      (left, right) =>
        compareText(variantSortKey(left.term), variantSortKey(right.term))
        || compareText(left.term, right.term),
    ),
    severity: seed.confidence < 70 ? "info" : seed.severity,
    confidence: seed.confidence,
    ...(seed.personal_divergence ? { personal_divergence: seed.personal_divergence } : {}),
  };
  return { ...finding, proposal_digest: terminologyProposalDigest(finding) };
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((field) => allowed.includes(field));
}

function proposalEvidence(value: unknown, label: string, violations: string[]): ProjectTermEvidence | null {
  if (!mapping(value) || !exactFields(value, ["source_path", "line", "source_record_sha256"])) {
    violations.push(`${label} must contain only source_path, line, and source_record_sha256`);
    return null;
  }
  if (
    !isSafeProjectSourcePath(value.source_path)
    || !Number.isInteger(value.line)
    || Number(value.line) < 1
    || typeof value.source_record_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.source_record_sha256)
  ) {
    violations.push(`${label} must identify one safe project-relative source line with a lowercase SHA-256`);
    return null;
  }
  return value as unknown as ProjectTermEvidence;
}

/** Validate and normalize the complete finding shape that Audit itself can emit. */
export function validateTerminologyProposal(value: unknown): TerminologyProposalValidation {
  const violations: string[] = [];
  const fields = ["family", "concept", "proposed_canonical_term", "canonical_evidence", "variants", "severity", "confidence", "personal_divergence", "proposal_digest"];
  if (!mapping(value) || !exactFields(value, fields)) {
    return { proposal: null, violations: ["proposal must be one complete terminology_drift finding with no undeclared fields"] };
  }
  if (value.family !== "terminology_drift") violations.push("proposal family must be terminology_drift");
  if (typeof value.concept !== "string" || value.concept.trim() === "") violations.push("proposal concept must be non-empty");
  if (typeof value.proposed_canonical_term !== "string" || value.proposed_canonical_term.trim() === "") violations.push("proposed canonical term must be non-empty");
  if (!["critical", "warning", "info"].includes(String(value.severity))) violations.push("proposal severity is invalid");
  const minimumConfidence = confidenceFloor();
  if (!Number.isInteger(value.confidence) || Number(value.confidence) < minimumConfidence || Number(value.confidence) > 100) {
    violations.push(`proposal confidence must be an integer from ${minimumConfidence} through 100`);
  }
  if (Number.isInteger(value.confidence) && Number(value.confidence) < 70 && value.severity !== "info") {
    violations.push("confidence below 70 requires info severity");
  }
  if (typeof value.proposal_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.proposal_digest)) violations.push("proposal_digest must be a lowercase SHA-256");

  const terms: Array<{ term: string; evidence: ProjectTermEvidence[] }> = [];
  const readTerm = (term: unknown, records: unknown, label: string): void => {
    if (typeof term !== "string" || term.trim() === "") {
      violations.push(`${label} term must be non-empty`);
      return;
    }
    if (!Array.isArray(records) || records.length === 0) {
      violations.push(`${label} evidence must be non-empty`);
      return;
    }
    const parsed = records
      .map((record, index) => proposalEvidence(record, `${label}[${index}]`, violations))
      .filter((record): record is ProjectTermEvidence => record !== null);
    if (new Set(parsed.map(evidenceIdentity)).size !== parsed.length) {
      violations.push(`${label} identities must be distinct`);
    }
    terms.push({ term, evidence: parsed });
  };
  readTerm(value.proposed_canonical_term, value.canonical_evidence, "canonical_evidence");
  if (!Array.isArray(value.variants) || value.variants.length === 0) {
    violations.push("proposal variants must be non-empty");
  } else {
    value.variants.forEach((variant, index) => {
      if (!mapping(variant) || !exactFields(variant, ["term", "evidence"])) {
        violations.push(`variants[${index}] must contain only term and evidence`);
        return;
      }
      readTerm(variant.term, variant.evidence, `variants[${index}].evidence`);
    });
  }
  if (terms.some((term, index) => terms.slice(0, index).some((candidate) => unicodeCaselessExact(candidate.term, term.term)))) {
    violations.push("proposal term identities must be Unicode caseless-exact unique");
  }

  let divergence: { personal_term: string; project_term: string } | undefined;
  if (value.personal_divergence !== undefined) {
    if (
      !mapping(value.personal_divergence)
      || !exactFields(value.personal_divergence, ["personal_term", "project_term"])
      || typeof value.personal_divergence.personal_term !== "string"
      || value.personal_divergence.personal_term.trim() === ""
      || value.personal_divergence.project_term !== value.proposed_canonical_term
    ) violations.push("personal_divergence must bind a non-empty personal term to the proposed project term");
    else divergence = value.personal_divergence as { personal_term: string; project_term: string };
  }

  if (violations.length > 0 || terms.length < 2) return { proposal: null, violations };
  const expected = canonicalProposal({
    family: "terminology_drift",
    concept: value.concept as string,
    terms,
    severity: value.severity as FindingSeverity,
    confidence: value.confidence as number,
    ...(divergence ? { personal_divergence: divergence } : {}),
  });
  if (expected.proposed_canonical_term !== value.proposed_canonical_term) violations.push("proposed canonical term is not the best-supported term under the Audit tie-break");
  if (canonicalTerminologyJson(proposalWithoutDigest(expected)) !== canonicalTerminologyJson(proposalWithoutDigest(value as unknown as TerminologyDriftFinding))) {
    violations.push("proposal shape or ordering is not the canonical Audit output");
  }
  if (expected.proposal_digest !== value.proposal_digest) violations.push("proposal_digest does not match the canonical Audit output");
  return { proposal: violations.length === 0 ? expected : null, violations };
}

function confidenceFloor(): number {
  const protocol = loadYamlMappingFile(
    path.join(resolveSourceRoot(), "skills", "agentera", "protocol.yaml"),
  );
  const scale = protocol.CONFIDENCE_SCALE as Record<string, { range?: unknown }>;
  const range = scale?.["3"]?.range;
  if (!Array.isArray(range) || !Number.isInteger(range[0])) {
    throw new Error("protocol CONFIDENCE_SCALE CS3 lower bound is unavailable");
  }
  return Number(range[0]);
}

function verifiedEvidence(
  projectRoot: string,
  term: string,
  evidence: ProjectTermEvidenceInput[],
): ProjectTermEvidence[] | null {
  const root = fs.realpathSync(projectRoot);
  const verified: ProjectTermEvidence[] = [];
  const identities = new Set<string>();
  for (const item of evidence) {
    if (!Number.isInteger(item.line) || item.line < 1 || !isSafeProjectSourcePath(item.source_path))
      return null;
    const pathname = path.resolve(root, item.source_path);
    if (pathname !== root && !pathname.startsWith(`${root}${path.sep}`)) return null;
    let realPath: string;
    try {
      realPath = fs.realpathSync(pathname);
    } catch {
      return null;
    }
    if (!realPath.startsWith(`${root}${path.sep}`) || !fs.statSync(realPath).isFile()) return null;
    const line = fs.readFileSync(realPath, "utf8").split(/\r?\n/)[item.line - 1];
    if (line === undefined || !containsGlossaryTerm(line, term)) return null;
    const sourcePath = path.relative(root, realPath).split(path.sep).join(path.posix.sep);
    const identity = `${sourcePath}:${item.line}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    verified.push({
      source_path: sourcePath,
      line: item.line,
      source_record_sha256: crypto.createHash("sha256").update(line).digest("hex"),
    });
  }
  return verified.length > 0 ? verified : null;
}

/** Generate findings from assessed concepts without writing project or personal state. */
export function assessTerminologyDrift(input: TerminologyDriftInput): TerminologyDriftFinding[] {
  const minimumConfidence = confidenceFloor();
  const findings: TerminologyDriftFinding[] = [];
  for (const concept of input.concepts) {
    if (
      concept.confidence < minimumConfidence ||
      concept.confidence > 100 ||
      !Number.isInteger(concept.confidence) ||
      input.deliberateDecisionConcepts.has(concept.concept) ||
      input.trackedIssueConcepts.has(concept.concept)
    )
      continue;

    const consolidated: Array<{ term: string; evidence: Map<string, ProjectTermEvidence> }> = [];
    let invalidEvidence = false;
    for (const candidate of concept.terms) {
      const term = candidate.term.trim();
      const evidence = term ? verifiedEvidence(input.projectRoot, term, candidate.evidence) : null;
      if (!evidence) {
        invalidEvidence = true;
        break;
      }
      const group = consolidated.find((item) => unicodeCaselessExact(item.term, term)) ?? { term, evidence: new Map() };
      for (const item of evidence) group.evidence.set(`${item.source_path}:${item.line}`, item);
      if (!consolidated.includes(group)) consolidated.push(group);
    }
    if (invalidEvidence || consolidated.length < 2) continue;
    const terms = consolidated.map((term) => ({
      term: term.term,
      evidence: orderedEvidence([...term.evidence.values()]),
    }));

    const seed = {
      family: "terminology_drift",
      concept: concept.concept,
      terms,
      severity: concept.severity,
      confidence: concept.confidence,
    } as const;
    let finding = canonicalProposal(seed);
    const personalTerm = input.personalTerms?.get(concept.concept)?.trim();
    if (personalTerm && !unicodeCaselessExact(personalTerm, finding.proposed_canonical_term)) {
      finding = canonicalProposal({
        ...seed,
        personal_divergence: {
          personal_term: personalTerm,
          project_term: finding.proposed_canonical_term,
        },
      });
    }
    const validated = validateTerminologyProposal(finding);
    if (!validated.proposal) throw new Error(`Audit produced an invalid terminology proposal: ${validated.violations.join("; ")}`);
    findings.push(validated.proposal);
  }
  return findings;
}

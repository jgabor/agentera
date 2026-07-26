import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import { isSafeProjectSourcePath } from "../registries/glossaryEntryContract.js";

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
    if (line === undefined || !line.includes(term)) return null;
    const identity = `${item.source_path}:${item.line}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    verified.push({
      source_path: item.source_path,
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

    const terms = concept.terms.map((candidate) => ({
      term: candidate.term.trim(),
      evidence: candidate.term.trim()
        ? verifiedEvidence(input.projectRoot, candidate.term.trim(), candidate.evidence)
        : null,
    }));
    if (terms.length < 2 || terms.some((term) => !term.evidence)) continue;
    if (new Set(terms.map((term) => term.term.toLocaleLowerCase())).size < 2) continue;

    const ordered = [...terms].sort(
      (left, right) =>
        right.evidence!.length - left.evidence!.length || left.term.localeCompare(right.term),
    );
    const [canonical, ...variants] = ordered;
    const finding: TerminologyDriftFinding = {
      family: "terminology_drift",
      concept: concept.concept,
      proposed_canonical_term: canonical.term,
      canonical_evidence: canonical.evidence!,
      variants: variants
        .map((variant) => ({ term: variant.term, evidence: variant.evidence! }))
        .sort((left, right) => left.term.localeCompare(right.term)),
      severity: concept.confidence < 70 ? "info" : concept.severity,
      confidence: concept.confidence,
    };
    const personalTerm = input.personalTerms?.get(concept.concept)?.trim();
    if (personalTerm && personalTerm.toLocaleLowerCase() !== canonical.term.toLocaleLowerCase()) {
      finding.personal_divergence = {
        personal_term: personalTerm,
        project_term: canonical.term,
      };
    }
    findings.push(finding);
  }
  return findings;
}

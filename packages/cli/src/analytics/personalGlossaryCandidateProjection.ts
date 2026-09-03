import fs from "node:fs";
import path from "node:path";

import { personalGlossaryCandidateProjectionContract } from "../registries/glossaryCandidateProjectionContract.js";
import { validateGlossaryEvidenceCapsule, type GlossaryEvidenceCapsule } from "../registries/glossaryCandidateContracts.js";
import { canonicalGlossaryJson, compareGlossaryUnicodeStrings, glossaryCanonicalSha256 } from "../registries/glossaryTermIdentity.js";
import { defaultProfileDir } from "./extractCorpus/core.js";
import { EXCERPT_OMISSION_REASONS, containsPersonalGlossarySensitiveContent, personalGlossaryCandidateProjectionExcerptExpiry, selectPersonalGlossarySafeExcerpt, validPersonalGlossarySafeExcerpt, type ExcerptOmissionReason } from "./personalGlossaryCandidateProjectionExcerpts.js";
import type {
  PersonalGlossaryCandidateProjection,
  PersonalGlossaryCandidateProjectionInput,
  PersonalGlossaryCandidateProjectionMaintenanceInput,
  PersonalGlossaryCandidateProjectionMaintenanceResult,
  PersonalGlossaryCandidateProjectionReadResult,
  PersonalGlossaryCandidateProjectionReport,
  PersonalGlossaryCandidateProjectionStorageOptions,
  PersonalGlossaryMiningFamilySummary,
  PersonalGlossaryMiningSummary,
  PersonalGlossaryProjectionCandidateInput,
  PersonalGlossarySafeExcerpt,
  PersonalGlossaryProjectionSourceFamily as SourceFamily,
  ProjectedPersonalGlossaryCandidate,
} from "./personalGlossaryCandidateProjectionModel.js";
export type * from "./personalGlossaryCandidateProjectionModel.js";

const PROJECTION_SCHEMA_VERSION = "agentera.personalGlossaryCandidateProjection.v1";
const PROJECTION_REPORT_SCHEMA_VERSION = "agentera.personalGlossaryCandidateProjectionReport.v1";
const MINING_SUMMARY_SCHEMA_VERSION = "agentera.personalGlossaryMiningSummary.v1";
const PROJECT_IDENTITY_SCHEMA_VERSION = "agentera.personalGlossaryProjectionProjectIdentity.v1";
const PROJECTION_OWNER = "deterministic_discovery_projection";
const SHA256_RE = /^[a-f0-9]{64}$/u;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
type Mapping = Record<string, unknown>;

interface ProjectionContract {
  candidatesMax: number;
  projectIdsMaxPerCandidate: number;
  sourceExcerptMaxUtf8Bytes: number;
  pendingExcerptDays: number;
  sourceFamilies: Record<string, string[]>;
  selectionAlgorithm: string;
  tieBreak: string;
  storageFile: string;
  candidateSecretReason: string;
  excerptSensitiveContentAction: string;
  miningSummarySchemaVersion: string;
  explicitAbstentionKeys: string[];
  recurringAbstentionKeys: string[];
}

interface MergedCandidate {
  capsule: GlossaryEvidenceCapsule;
  sourceFamily: SourceFamily;
  projectKeys: Set<string>;
  excerpts: Set<string>;
}

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Mapping) : null;
}

function compareText(left: string, right: string): number {
  return compareGlossaryUnicodeStrings(left, right);
}

function exactKeys(value: Mapping, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  return JSON.stringify(actual) === JSON.stringify([...expected].sort(compareText));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function requireBoundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new TypeError(`${label} is outside its bound`);
  }
  return value;
}

function projectionContract(): ProjectionContract {
  const contract = personalGlossaryCandidateProjectionContract();
  const families = contract.sourceFamilies;
  if (
    contract.schemaVersion !== PROJECTION_SCHEMA_VERSION ||
    contract.owner !== PROJECTION_OWNER ||
    contract.candidatesMax !== 50 ||
    contract.projectIdsMaxPerCandidate !== 100 ||
    contract.sourceExcerptMaxUtf8Bytes !== 4096 ||
    contract.pendingExcerptDays !== 30 ||
    contract.selectionAlgorithm !== "least_retained_source_family_then_project_then_canonical_candidate" ||
    contract.tieBreak !== "candidate_id_then_candidate_revision_then_capsule_sha256" ||
    contract.projectIdentitySchemaVersion !== PROJECT_IDENTITY_SCHEMA_VERSION ||
    contract.storageFile !== "candidate-projection.json" ||
    contract.candidateSecretReason !== "secret_content" ||
    contract.excerptSensitiveContentAction !== "omit_complete_excerpt_before_projection" ||
    contract.miningSummarySchemaVersion !== MINING_SUMMARY_SCHEMA_VERSION ||
    contract.explicitAbstentionKeys.length !== 24 ||
    contract.recurringAbstentionKeys.length !== 12 ||
    JSON.stringify(Object.keys(families)) !== JSON.stringify(["explicit", "recurring"]) ||
    JSON.stringify(families.explicit) !== JSON.stringify(["personal_explicit_definition"]) ||
    JSON.stringify(families.recurring) !== JSON.stringify(["personal_inferred_usage", "personal_inferred_conversation"])
  ) {
    throw new TypeError("personal glossary candidate projection contract is invalid");
  }
  return contract;
}

function zeroReasons(keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function projectionMiningSummary(input: PersonalGlossaryCandidateProjectionInput, contract: ProjectionContract): PersonalGlossaryMiningSummary {
  if (input.mining_summary) return input.mining_summary;
  let explicit = 0;
  let recurring = 0;
  for (const candidate of input.candidates) {
    if (candidate.capsule.provenance_kind === "personal_explicit_definition") explicit += 1;
    else recurring += 1;
  }
  return {
    schema_version: MINING_SUMMARY_SCHEMA_VERSION,
    explicit: {
      candidate_count: explicit,
      abstention_count: 0,
      abstentions_by_reason: zeroReasons(contract.explicitAbstentionKeys),
    },
    recurring: {
      candidate_count: recurring,
      abstention_count: 0,
      abstentions_by_reason: zeroReasons(contract.recurringAbstentionKeys),
    },
    total_candidate_count: explicit + recurring,
    total_abstention_count: 0,
  };
}

function validMiningFamily(value: unknown, keys: readonly string[]): boolean {
  const family = mapping(value);
  const reasons = mapping(family?.abstentions_by_reason);
  return (
    family !== null &&
    reasons !== null &&
    exactKeys(family, ["candidate_count", "abstention_count", "abstentions_by_reason"]) &&
    nonNegativeInteger(family.candidate_count) &&
    nonNegativeInteger(family.abstention_count) &&
    exactKeys(reasons, keys) &&
    Object.values(reasons).every(nonNegativeInteger) &&
    family.abstention_count === Object.values(reasons).reduce<number>((sum, count) => sum + Number(count), 0)
  );
}

function validMiningSummary(value: unknown, inputCount: number, contract: ProjectionContract): value is PersonalGlossaryMiningSummary {
  const summary = mapping(value);
  if (
    summary === null ||
    !exactKeys(summary, ["schema_version", "explicit", "recurring", "total_candidate_count", "total_abstention_count"]) ||
    summary.schema_version !== MINING_SUMMARY_SCHEMA_VERSION ||
    !validMiningFamily(summary.explicit, contract.explicitAbstentionKeys) ||
    !validMiningFamily(summary.recurring, contract.recurringAbstentionKeys) ||
    !nonNegativeInteger(summary.total_candidate_count) ||
    !nonNegativeInteger(summary.total_abstention_count)
  )
    return false;
  const explicit = summary.explicit as PersonalGlossaryMiningFamilySummary;
  const recurring = summary.recurring as PersonalGlossaryMiningFamilySummary;
  return summary.total_candidate_count === explicit.candidate_count + recurring.candidate_count && summary.total_candidate_count === inputCount && summary.total_abstention_count === explicit.abstention_count + recurring.abstention_count;
}

function sourceFamily(capsule: GlossaryEvidenceCapsule, contract: ProjectionContract): SourceFamily {
  const matches = (Object.entries(contract.sourceFamilies) as Array<[SourceFamily, string[]]>).filter(([, kinds]) => kinds.includes(capsule.provenance_kind)).map(([family]) => family);
  if (matches.length !== 1) throw new TypeError("candidate provenance has no projection source family");
  return matches[0]!;
}

/** Hash the exact transient diversity label before it enters projection metadata or reports. */
export function personalGlossaryProjectionProjectIdentity(projectId: string): string {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new TypeError("candidate project identity must be non-empty");
  }
  return glossaryCanonicalSha256({
    schema_version: PROJECT_IDENTITY_SCHEMA_VERSION,
    project_id: projectId,
  });
}

function candidateOrder(left: MergedCandidate, right: MergedCandidate): number {
  return compareText(left.capsule.candidate_id, right.capsule.candidate_id) || compareText(left.capsule.candidate_revision, right.capsule.candidate_revision) || compareText(left.capsule.capsule_sha256, right.capsule.capsule_sha256);
}

function candidateKey(capsule: GlossaryEvidenceCapsule): string {
  return `${capsule.candidate_id}\u0000${capsule.candidate_revision}`;
}

function projectCandidate(candidate: PersonalGlossaryProjectionCandidateInput, input: PersonalGlossaryCandidateProjectionInput, contract: ProjectionContract): MergedCandidate {
  const errors = validateGlossaryEvidenceCapsule(candidate.capsule);
  if (errors.length > 0) throw new TypeError("candidate capsule is invalid");
  if (containsPersonalGlossarySensitiveContent(candidate.capsule.term) || containsPersonalGlossarySensitiveContent(candidate.capsule.meaning)) {
    throw new TypeError(`candidate content is ineligible: ${contract.candidateSecretReason}`);
  }
  if (candidate.capsule.generation !== input.generation || candidate.capsule.policy_version !== input.policy_version) {
    throw new TypeError("candidate capsule bindings do not match projection input");
  }
  if (!Array.isArray(candidate.project_ids) || candidate.project_ids.length === 0 || candidate.project_ids.length > contract.projectIdsMaxPerCandidate) {
    throw new TypeError("candidate project identities are outside their bound");
  }
  const projectKeys = new Set<string>();
  for (const projectId of candidate.project_ids) {
    const bounded = requireBoundedText(projectId, 256, "candidate project identity");
    projectKeys.add(personalGlossaryProjectionProjectIdentity(bounded));
  }
  if (projectKeys.size > contract.projectIdsMaxPerCandidate) {
    throw new TypeError("candidate project identities are outside their bound");
  }
  const excerpts = candidate.excerpts ?? [];
  if (!Array.isArray(excerpts) || excerpts.some((excerpt) => typeof excerpt !== "string")) {
    throw new TypeError("candidate excerpts must be strings");
  }
  return {
    capsule: candidate.capsule,
    sourceFamily: sourceFamily(candidate.capsule, contract),
    projectKeys,
    excerpts: new Set(excerpts),
  };
}

function mergeCandidates(input: PersonalGlossaryCandidateProjectionInput, contract: ProjectionContract): { candidates: MergedCandidate[]; duplicates: number } {
  const merged = new Map<string, MergedCandidate>();
  let duplicates = 0;
  for (const rawCandidate of input.candidates) {
    const candidate = projectCandidate(rawCandidate, input, contract);
    const key = candidateKey(candidate.capsule);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    if (existing.capsule.capsule_sha256 !== candidate.capsule.capsule_sha256 || canonicalGlossaryJson(existing.capsule) !== canonicalGlossaryJson(candidate.capsule)) {
      throw new TypeError("candidate revision collision has non-identical capsule bytes");
    }
    duplicates += 1;
    for (const projectKey of candidate.projectKeys) existing.projectKeys.add(projectKey);
    if (existing.projectKeys.size > contract.projectIdsMaxPerCandidate) {
      throw new TypeError("candidate project identities are outside their bound");
    }
    for (const excerpt of candidate.excerpts) existing.excerpts.add(excerpt);
  }
  return { candidates: [...merged.values()].sort(candidateOrder), duplicates };
}

function countByFamily(candidates: readonly MergedCandidate[]): Map<SourceFamily, number> {
  const counts = new Map<SourceFamily, number>([
    ["explicit", 0],
    ["recurring", 0],
  ]);
  for (const candidate of candidates) {
    counts.set(candidate.sourceFamily, (counts.get(candidate.sourceFamily) ?? 0) + 1);
  }
  return counts;
}

function countByProject(candidates: readonly MergedCandidate[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const projectKey of candidate.projectKeys) {
      counts.set(projectKey, (counts.get(projectKey) ?? 0) + 1);
    }
  }
  return counts;
}

function selectCandidates(candidates: readonly MergedCandidate[], contract: ProjectionContract): { retained: MergedCandidate[]; ties: number } {
  const remaining = [...candidates];
  const familyRetained = new Map<SourceFamily, number>([
    ["explicit", 0],
    ["recurring", 0],
  ]);
  const projectRetained = new Map<string, number>([...countByProject(candidates).keys()].map((projectKey) => [projectKey, 0]));
  const retained: MergedCandidate[] = [];
  let ties = 0;
  const rank = (candidate: MergedCandidate): [number, number] => [familyRetained.get(candidate.sourceFamily) ?? 0, Math.min(...[...candidate.projectKeys].map((projectKey) => projectRetained.get(projectKey) ?? 0))];
  while (remaining.length > 0 && retained.length < contract.candidatesMax) {
    remaining.sort((left, right) => {
      const leftRank = rank(left);
      const rightRank = rank(right);
      return leftRank[0] - rightRank[0] || leftRank[1] - rightRank[1] || candidateOrder(left, right);
    });
    const next = remaining.shift()!;
    const nextRank = rank(next);
    if (
      remaining.some((candidate) => {
        const candidateRank = rank(candidate);
        return candidateRank[0] === nextRank[0] && candidateRank[1] === nextRank[1];
      })
    ) {
      ties += 1;
    }
    retained.push(next);
    familyRetained.set(next.sourceFamily, (familyRetained.get(next.sourceFamily) ?? 0) + 1);
    for (const projectKey of next.projectKeys) {
      projectRetained.set(projectKey, (projectRetained.get(projectKey) ?? 0) + 1);
    }
  }
  return { retained: retained.sort(candidateOrder), ties };
}

function emptyOmissions(): Record<ExcerptOmissionReason, number> {
  return Object.fromEntries(EXCERPT_OMISSION_REASONS.map((reason) => [reason, 0])) as Record<ExcerptOmissionReason, number>;
}

/**
 * Build the bounded, user-local candidate projection. This is an internal
 * producer seam only. It deliberately exposes no list, exact-read, review, or
 * publication CLI behavior.
 */
export function projectPersonalGlossaryCandidates(input: PersonalGlossaryCandidateProjectionInput): PersonalGlossaryCandidateProjection {
  const contract = projectionContract();
  requireBoundedText(input.generation, 256, "projection generation");
  requireBoundedText(input.policy_version, 256, "projection policy version");
  if (!validTimestamp(input.retained_at)) {
    throw new TypeError("projection retained_at must be an ISO timestamp");
  }
  if (!Array.isArray(input.candidates)) {
    throw new TypeError("projection candidates must be a list");
  }
  const miningSummary = projectionMiningSummary(input, contract);
  if (!validMiningSummary(miningSummary, input.candidates.length, contract)) {
    throw new TypeError("candidate mining summary is invalid");
  }
  const merged = mergeCandidates(input, contract);
  const selected = selectCandidates(merged.candidates, contract);
  const availableByFamily = countByFamily(merged.candidates);
  const availableByProject = countByProject(merged.candidates);
  const retainedByFamily = countByFamily(selected.retained);
  const retainedByProject = countByProject(selected.retained);
  const omissions = emptyOmissions();
  let provided = 0;
  let safeRetained = 0;
  let redacted = 0;
  let truncated = 0;
  const candidates = selected.retained.map((candidate) => {
    const excerpt = selectPersonalGlossarySafeExcerpt(candidate.excerpts, candidate.capsule.term, input.retained_at, contract);
    provided += excerpt.provided;
    if (excerpt.excerpt !== null) {
      safeRetained += 1;
      if (excerpt.excerpt.redacted) redacted += 1;
    } else if (excerpt.omission !== null) {
      omissions[excerpt.omission] += 1;
    }
    if (excerpt.truncated) truncated += 1;
    return {
      capsule: candidate.capsule,
      source_family: candidate.sourceFamily,
      project_keys: [...candidate.projectKeys].sort(compareText),
      safe_excerpt: excerpt.excerpt,
    };
  });
  const capApplied = merged.candidates.length > contract.candidatesMax;
  const uncoveredSourceFamilies = (["explicit", "recurring"] as const).filter((family) => (availableByFamily.get(family) ?? 0) > 0 && (retainedByFamily.get(family) ?? 0) === 0);
  const uncoveredProjects = [...availableByProject.keys()].filter((projectKey) => (retainedByProject.get(projectKey) ?? 0) === 0).length;
  const coverageReasons = [...(capApplied ? ["candidate_cap"] : []), ...(uncoveredSourceFamilies.length > 0 ? ["source_family_uncovered"] : []), ...(uncoveredProjects > 0 ? ["project_uncovered"] : [])];
  const report: PersonalGlossaryCandidateProjectionReport = {
    schema_version: PROJECTION_REPORT_SCHEMA_VERSION,
    input_count: input.candidates.length,
    duplicate_count: merged.duplicates,
    unique_count: merged.candidates.length,
    retained_count: candidates.length,
    dropped_count: merged.candidates.length - candidates.length,
    cap: { maximum: contract.candidatesMax, applied: capApplied },
    allocation: {
      algorithm: contract.selectionAlgorithm,
      tie_break: contract.tieBreak,
      tie_breaks_resolved: selected.ties,
    },
    source_families: (["explicit", "recurring"] as const).map((family) => ({
      family,
      available: availableByFamily.get(family) ?? 0,
      retained: retainedByFamily.get(family) ?? 0,
      dropped: (availableByFamily.get(family) ?? 0) - (retainedByFamily.get(family) ?? 0),
    })),
    projects: {
      available: availableByProject.size,
      retained: [...retainedByProject.values()].filter((count) => count > 0).length,
      dropped: uncoveredProjects,
    },
    coverage: {
      status: coverageReasons.length === 0 ? "complete" : "degraded",
      reasons: coverageReasons,
      uncovered_source_families: [...uncoveredSourceFamilies],
      uncovered_projects: uncoveredProjects,
    },
    excerpts: {
      provided,
      retained: safeRetained,
      redacted,
      truncated,
      expired: 0,
      omissions,
    },
    mining_summary: miningSummary,
  };
  const projection = {
    schema_version: PROJECTION_SCHEMA_VERSION,
    owner: PROJECTION_OWNER,
    generation: input.generation,
    policy_version: input.policy_version,
    retained_at: input.retained_at,
    candidates,
    report,
  } as Omit<PersonalGlossaryCandidateProjection, "projection_sha256">;
  return {
    ...projection,
    projection_sha256: glossaryCanonicalSha256(projection),
  };
}

export function personalGlossaryCandidateProjectionPath(options: PersonalGlossaryCandidateProjectionStorageOptions = {}): string {
  const contract = projectionContract();
  return path.join(defaultProfileDir(options.env ?? process.env, options.platform ?? process.platform), "intermediate", "personal-glossary", contract.storageFile);
}

function privateWrite(pathname: string, text: string): void {
  const directory = path.dirname(pathname);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${pathname}.tmp.${process.pid}.${Date.now()}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "w", 0o600);
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, pathname);
    fs.chmodSync(pathname, 0o600);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}

function ensurePrivateProjectionMode(pathname: string): void {
  const metadata = fs.statSync(pathname);
  if (!metadata.isFile()) {
    throw new TypeError("stored candidate projection is not a private file");
  }
  if ((metadata.mode & 0o777) === 0o600) return;
  fs.chmodSync(pathname, 0o600);
  if ((fs.statSync(pathname).mode & 0o777) !== 0o600) {
    throw new TypeError("stored candidate projection could not be made private");
  }
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function validProjectionReport(value: unknown): value is PersonalGlossaryCandidateProjectionReport {
  const report = mapping(value);
  const cap = mapping(report?.cap);
  const allocation = mapping(report?.allocation);
  const projects = mapping(report?.projects);
  const coverage = mapping(report?.coverage);
  const excerpts = mapping(report?.excerpts);
  const omissions = mapping(excerpts?.omissions);
  if (
    report === null ||
    !exactKeys(report, ["schema_version", "input_count", "duplicate_count", "unique_count", "retained_count", "dropped_count", "cap", "allocation", "source_families", "projects", "coverage", "excerpts", "mining_summary"]) ||
    report.schema_version !== PROJECTION_REPORT_SCHEMA_VERSION ||
    ![report.input_count, report.duplicate_count, report.unique_count, report.retained_count, report.dropped_count].every(nonNegativeInteger) ||
    cap === null ||
    !exactKeys(cap, ["maximum", "applied"]) ||
    cap.maximum !== projectionContract().candidatesMax ||
    typeof cap.applied !== "boolean" ||
    allocation === null ||
    !exactKeys(allocation, ["algorithm", "tie_break", "tie_breaks_resolved"]) ||
    allocation.algorithm !== projectionContract().selectionAlgorithm ||
    allocation.tie_break !== projectionContract().tieBreak ||
    !nonNegativeInteger(allocation.tie_breaks_resolved) ||
    !Array.isArray(report.source_families) ||
    report.source_families.length !== 2 ||
    projects === null ||
    !exactKeys(projects, ["available", "retained", "dropped"]) ||
    !Object.values(projects).every(nonNegativeInteger) ||
    coverage === null ||
    !exactKeys(coverage, ["status", "reasons", "uncovered_source_families", "uncovered_projects"]) ||
    !["complete", "degraded"].includes(String(coverage.status)) ||
    !Array.isArray(coverage.reasons) ||
    coverage.reasons.some((reason) => typeof reason !== "string" || !["candidate_cap", "source_family_uncovered", "project_uncovered"].includes(reason)) ||
    !Array.isArray(coverage.uncovered_source_families) ||
    coverage.uncovered_source_families.some((family) => family !== "explicit" && family !== "recurring") ||
    !nonNegativeInteger(coverage.uncovered_projects) ||
    !validMiningSummary(report.mining_summary, Number(report.input_count), projectionContract()) ||
    excerpts === null ||
    !exactKeys(excerpts, ["provided", "retained", "redacted", "truncated", "expired", "omissions"]) ||
    ![excerpts.provided, excerpts.retained, excerpts.redacted, excerpts.truncated, excerpts.expired].every(nonNegativeInteger) ||
    omissions === null ||
    !exactKeys(omissions, EXCERPT_OMISSION_REASONS) ||
    !Object.values(omissions).every(nonNegativeInteger)
  ) {
    return false;
  }
  return report.source_families.every((family) => {
    const item = mapping(family);
    return item !== null && exactKeys(item, ["family", "available", "retained", "dropped"]) && (item.family === "explicit" || item.family === "recurring") && [item.available, item.retained, item.dropped].every(nonNegativeInteger);
  });
}

function projectedCandidateOrder(left: ProjectedPersonalGlossaryCandidate, right: ProjectedPersonalGlossaryCandidate): number {
  return compareText(left.capsule.candidate_id, right.capsule.candidate_id) || compareText(left.capsule.candidate_revision, right.capsule.candidate_revision) || compareText(left.capsule.capsule_sha256, right.capsule.capsule_sha256);
}

function sameTextArray(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validProjectedCandidate(value: unknown, projection: Pick<PersonalGlossaryCandidateProjection, "generation" | "policy_version" | "retained_at">, contract: ProjectionContract): value is ProjectedPersonalGlossaryCandidate {
  const item = mapping(value);
  if (
    item === null ||
    !exactKeys(item, ["capsule", "source_family", "project_keys", "safe_excerpt"]) ||
    !Array.isArray(item.project_keys) ||
    item.project_keys.length === 0 ||
    item.project_keys.length > contract.projectIdsMaxPerCandidate ||
    item.project_keys.some((projectKey) => typeof projectKey !== "string" || !SHA256_RE.test(projectKey)) ||
    new Set(item.project_keys).size !== item.project_keys.length ||
    !sameTextArray(
      item.project_keys as string[],
      [...item.project_keys].sort((left, right) => compareText(String(left), String(right))),
    ) ||
    (item.safe_excerpt !== null && !validPersonalGlossarySafeExcerpt(item.safe_excerpt))
  ) {
    return false;
  }
  const capsule = item.capsule as GlossaryEvidenceCapsule;
  if (validateGlossaryEvidenceCapsule(capsule).length > 0) return false;
  if (containsPersonalGlossarySensitiveContent(capsule.term) || containsPersonalGlossarySensitiveContent(capsule.meaning)) {
    return false;
  }
  try {
    return (
      (item.source_family === "explicit" || item.source_family === "recurring") &&
      capsule.generation === projection.generation &&
      capsule.policy_version === projection.policy_version &&
      sourceFamily(capsule, contract) === item.source_family &&
      (item.safe_excerpt === null || item.safe_excerpt.expires_at === personalGlossaryCandidateProjectionExcerptExpiry(projection.retained_at, contract.pendingExcerptDays))
    );
  } catch {
    return false;
  }
}

function validProjectionBindings(projection: PersonalGlossaryCandidateProjection, contract: ProjectionContract): boolean {
  const { candidates, report } = projection;
  const families: readonly SourceFamily[] = ["explicit", "recurring"];
  if (
    report.retained_count !== candidates.length ||
    report.unique_count !== report.retained_count + report.dropped_count ||
    report.input_count !== report.unique_count + report.duplicate_count ||
    report.cap.applied !== report.unique_count > contract.candidatesMax ||
    report.dropped_count !== Math.max(0, report.unique_count - contract.candidatesMax) ||
    report.retained_count !== Math.min(report.unique_count, contract.candidatesMax) ||
    report.allocation.tie_breaks_resolved > report.retained_count
  ) {
    return false;
  }

  const candidateKeys = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const key = candidateKey(candidate.capsule);
    if (candidateKeys.has(key)) return false;
    candidateKeys.add(key);
    if (index > 0 && projectedCandidateOrder(candidates[index - 1]!, candidate) >= 0) return false;
  }

  const retainedByFamily = new Map<SourceFamily, number>(families.map((family) => [family, 0]));
  const retainedProjectKeys = new Set<string>();
  for (const candidate of candidates) {
    retainedByFamily.set(candidate.source_family, (retainedByFamily.get(candidate.source_family) ?? 0) + 1);
    for (const projectKey of candidate.project_keys) retainedProjectKeys.add(projectKey);
  }

  if (
    !sameTextArray(
      report.source_families.map((item) => item.family),
      families,
    )
  )
    return false;
  let availableCandidates = 0;
  let droppedCandidates = 0;
  for (const family of families) {
    const item = report.source_families.find((entry) => entry.family === family)!;
    const retained = retainedByFamily.get(family) ?? 0;
    if (item.retained !== retained || item.available < item.retained || item.dropped !== item.available - item.retained) {
      return false;
    }
    availableCandidates += item.available;
    droppedCandidates += item.dropped;
  }
  if (availableCandidates !== report.unique_count || droppedCandidates !== report.dropped_count) {
    return false;
  }

  if (report.projects.retained !== retainedProjectKeys.size || report.projects.available < report.projects.retained || report.projects.dropped !== report.projects.available - report.projects.retained) {
    return false;
  }

  const uncoveredSourceFamilies = families.filter((family) => {
    const item = report.source_families.find((entry) => entry.family === family)!;
    return item.available > 0 && item.retained === 0;
  });
  const coverageReasons = [...(report.cap.applied ? ["candidate_cap"] : []), ...(uncoveredSourceFamilies.length > 0 ? ["source_family_uncovered"] : []), ...(report.projects.dropped > 0 ? ["project_uncovered"] : [])];
  if (report.coverage.uncovered_projects !== report.projects.dropped || !sameTextArray(report.coverage.uncovered_source_families, uncoveredSourceFamilies) || !sameTextArray(report.coverage.reasons, coverageReasons) || report.coverage.status !== (coverageReasons.length === 0 ? "complete" : "degraded")) {
    return false;
  }

  const activeExcerpts = candidates.flatMap((candidate) => (candidate.safe_excerpt === null ? [] : [candidate.safe_excerpt]));
  const omissionCount = Object.values(report.excerpts.omissions).reduce((total, count) => total + count, 0);
  if (
    report.excerpts.retained !== activeExcerpts.length ||
    report.excerpts.provided !== candidates.length - report.excerpts.omissions.no_excerpt ||
    report.excerpts.retained + report.excerpts.expired + omissionCount !== candidates.length ||
    report.excerpts.redacted < activeExcerpts.filter((excerpt) => excerpt.redacted).length ||
    report.excerpts.redacted > report.excerpts.retained + report.excerpts.expired ||
    report.excerpts.truncated > report.excerpts.provided ||
    report.excerpts.expired > report.excerpts.provided
  ) {
    return false;
  }
  return true;
}

function validProjection(value: unknown): value is PersonalGlossaryCandidateProjection {
  const projection = mapping(value);
  const contract = projectionContract();
  if (
    projection === null ||
    !exactKeys(projection, ["schema_version", "owner", "generation", "policy_version", "retained_at", "candidates", "report", "projection_sha256"]) ||
    projection.schema_version !== PROJECTION_SCHEMA_VERSION ||
    projection.owner !== PROJECTION_OWNER ||
    typeof projection.generation !== "string" ||
    projection.generation.length === 0 ||
    Buffer.byteLength(projection.generation, "utf8") > 256 ||
    typeof projection.policy_version !== "string" ||
    projection.policy_version.length === 0 ||
    Buffer.byteLength(projection.policy_version, "utf8") > 256 ||
    !validTimestamp(projection.retained_at) ||
    !Array.isArray(projection.candidates) ||
    projection.candidates.length > contract.candidatesMax ||
    !validProjectionReport(projection.report) ||
    typeof projection.projection_sha256 !== "string" ||
    !SHA256_RE.test(projection.projection_sha256)
  ) {
    return false;
  }
  const body = { ...projection };
  delete body.projection_sha256;
  if (projection.projection_sha256 !== glossaryCanonicalSha256(body)) return false;
  const typed = projection as unknown as PersonalGlossaryCandidateProjection;
  return typed.candidates.every((candidate) => validProjectedCandidate(candidate, typed, contract)) && validProjectionBindings(typed, contract);
}

export function readPersonalGlossaryCandidateProjection(options: PersonalGlossaryCandidateProjectionStorageOptions = {}): PersonalGlossaryCandidateProjectionReadResult {
  const pathname = personalGlossaryCandidateProjectionPath(options);
  let text: string;
  try {
    text = fs.readFileSync(pathname, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing", projection: null } : { status: "corrupt", projection: null };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!validProjection(parsed) || text !== `${canonicalGlossaryJson(parsed)}\n`) {
      return { status: "corrupt", projection: null };
    }
    return { status: "current", projection: parsed };
  } catch {
    return { status: "corrupt", projection: null };
  }
}

export function persistPersonalGlossaryCandidateProjection(projection: PersonalGlossaryCandidateProjection, options: PersonalGlossaryCandidateProjectionStorageOptions = {}): { status: "changed" | "unchanged_replay"; path: string } {
  if (!validProjection(projection)) throw new TypeError("candidate projection is invalid");
  const pathname = personalGlossaryCandidateProjectionPath(options);
  const text = `${canonicalGlossaryJson(projection)}\n`;
  if (fs.existsSync(pathname)) {
    const current = readPersonalGlossaryCandidateProjection(options);
    if (current.status === "corrupt") throw new TypeError("stored candidate projection is corrupt");
    if (current.status === "current") {
      const existing = fs.readFileSync(pathname, "utf8");
      if (existing === text) {
        ensurePrivateProjectionMode(pathname);
        return { status: "unchanged_replay", path: pathname };
      }
    }
  }
  privateWrite(pathname, text);
  return { status: "changed", path: pathname };
}

/** Persist after explicit refresh consent, replacing only a malformed owned regular file. */
export function persistPersonalGlossaryCandidateProjectionAfterRefresh(projection: PersonalGlossaryCandidateProjection, options: PersonalGlossaryCandidateProjectionStorageOptions = {}): { status: "changed" | "unchanged_replay"; path: string } {
  if (!validProjection(projection)) throw new TypeError("candidate projection is invalid");
  const pathname = personalGlossaryCandidateProjectionPath(options);
  const root = path.resolve(defaultProfileDir(options.env ?? process.env, options.platform ?? process.platform), "intermediate", "personal-glossary");
  if (path.resolve(pathname) !== path.join(root, projectionContract().storageFile)) {
    throw new TypeError("candidate projection path escapes its configured storage root");
  }
  try {
    const metadata = fs.lstatSync(pathname);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TypeError("candidate projection replacement requires the exact regular file");
    }
    const text = `${canonicalGlossaryJson(projection)}\n`;
    const current = readPersonalGlossaryCandidateProjection(options);
    if (current.status === "current" && fs.readFileSync(pathname, "utf8") === text) {
      ensurePrivateProjectionMode(pathname);
      return { status: "unchanged_replay", path: pathname };
    }
    privateWrite(pathname, text);
    return { status: "changed", path: pathname };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  privateWrite(pathname, `${canonicalGlossaryJson(projection)}\n`);
  return { status: "changed", path: pathname };
}

/**
 * Apply only expiry or a local-host-authorized purge to the private projection.
 * No CLI command exposes this primitive. The later review lifecycle owns the
 * authentication ceremony and any review-disposition storage.
 */
export function maintainPersonalGlossaryCandidateProjection(input: PersonalGlossaryCandidateProjectionMaintenanceInput): PersonalGlossaryCandidateProjectionMaintenanceResult {
  if (!validTimestamp(input.now)) throw new TypeError("maintenance now must be an ISO timestamp");
  const options = { env: input.env, platform: input.platform };
  const current = readPersonalGlossaryCandidateProjection(options);
  if (current.status === "missing" || current.status === "corrupt") {
    return { status: current.status, expired_excerpts: 0 };
  }
  const pathname = personalGlossaryCandidateProjectionPath(options);
  if (input.current_user_purge_authorized === true) {
    fs.rmSync(pathname, { force: true });
    return { status: "purged", expired_excerpts: 0 };
  }
  let expired = 0;
  const candidates = current.projection!.candidates.map((candidate) => {
    if (candidate.safe_excerpt !== null && Date.parse(candidate.safe_excerpt.expires_at) <= Date.parse(input.now)) {
      expired += 1;
      return { ...candidate, safe_excerpt: null };
    }
    return candidate;
  });
  if (expired === 0) return { status: "unchanged", expired_excerpts: 0 };
  const report = structuredClone(current.projection!.report);
  report.excerpts.retained -= expired;
  report.excerpts.expired += expired;
  const { projection_sha256: _previousDigest, ...previous } = current.projection!;
  const body = {
    ...previous,
    candidates,
    report,
  } as Omit<PersonalGlossaryCandidateProjection, "projection_sha256">;
  const next: PersonalGlossaryCandidateProjection = {
    ...body,
    projection_sha256: glossaryCanonicalSha256(body),
  };
  privateWrite(pathname, `${canonicalGlossaryJson(next)}\n`);
  return { status: "changed", expired_excerpts: expired };
}

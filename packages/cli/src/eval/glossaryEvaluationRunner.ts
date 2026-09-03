import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonObject } from "../core/jsonValue.js";
import { BOOTSTRAP_SOURCE_ROOT_ENV, resolveSourceRoot } from "../core/sourceRoot.js";
import { withReadOnlyYamlMappingCache } from "../core/yaml.js";
import { persistPersonalGlossaryCandidateProjection, projectPersonalGlossaryCandidates, type PersonalGlossaryCandidateProjection } from "../analytics/personalGlossaryCandidateProjection.js";
import { ADAPTER_VERSION, contentFingerprint, originIdentity } from "../analytics/extractCorpus/core.js";
import { publishEvidenceTiers } from "../analytics/extractCorpus/evidenceTiers.js";
import { mineExplicitGlossaryCandidates } from "../analytics/personalGlossaryExplicitMining.js";
import { mineRecurringGlossaryCandidates } from "../analytics/personalGlossaryRecurrence.js";
import { readCurrentPersonalGlossaryCandidateProjection, type PersonalGlossaryCurrentGenerationResult } from "../analytics/personalGlossaryCurrentGeneration.js";
import { runPersonalGlossaryEvaluationDecisionCommand } from "../cli/commands/personalGlossaryDecision.js";
import type { GlossaryEvidenceCapsule } from "../registries/glossaryCandidateContracts.js";
import { personalGlossaryCandidateDecisionContract } from "../registries/glossaryCandidateDecisionContract.js";
import { personalGlossaryCandidateProjectionContract } from "../registries/glossaryCandidateProjectionContract.js";
import {
  calculateDiscoveryRecall,
  calculateExplicitAdmissionPrecision,
  calculateInferredReviewPrecision,
  calculateScopeAccuracy,
  canonicalDigest,
  glossaryEvaluationCaseCounts,
  glossaryEvaluationLabelDigest,
  type BinaryEvaluationExample,
  type Mapping,
  type MetricResult,
  GLOSSARY_EVALUATION_SCHEMA_VERSION,
  GLOSSARY_OBSERVATIONS_SCHEMA_VERSION,
  glossaryEvaluationAuthorityPath,
  glossaryEvaluationBehaviorFixturePath,
  glossaryEvaluationHoldoutPath,
  loadGlossaryEvaluationAuthority,
  loadGlossaryEvaluationBehaviorFixture,
  loadGlossaryEvaluationHoldout,
  mappings,
  metricRule,
  nonEmptyString,
  sha256,
  type ScopeEvaluationExample,
  validateFrozenGlossaryBehaviorFixture,
  validateFrozenGlossaryHoldout,
  validateGlossaryEvaluationAuthority,
  validateGlossaryObservations,
  mapping,
} from "./glossaryEvaluation.js";

type BehaviorExecution = {
  discovery: Mapping[];
  scope: Mapping[];
  inferred_review: Mapping[];
  explicit_admission: Mapping[];
  seams: Mapping[];
};

type EvaluationDecisionCandidate = {
  id: string;
  capsule: GlossaryEvidenceCapsule;
};

type EvaluationDecisionStatus = "automatic_admission" | "review_required" | "abstain";

const FIXED_TIMESTAMP = "2026-08-10T00:00:00.000Z";
const FIXED_RETAINED_AT = "2026-08-10T00:00:00.000Z";

function syntheticSourceId(id: string, index = 0): string {
  return `synthetic:${id}:${index}`;
}

function syntheticRecord(id: string, sourceKind: string, text: string, index = 0, actor: "user" | "agent" = "user"): JsonObject {
  const sourceId = syntheticSourceId(id, index);
  const conversation = sourceKind === "conversation_turn";
  const data = sourceKind === "instruction_document" ? { content: text, signal_type: "instruction" } : sourceKind === "project_config_signal" ? { signals: [text], signal_type: "configuration" } : { text, signal_type: "correction", actor: actor === "user" ? "user" : "assistant" };
  return {
    source_id: sourceId,
    source_kind: sourceKind,
    timestamp: FIXED_TIMESTAMP,
    project_id: `evaluation-${id}-${index}`,
    runtime: conversation ? "opencode" : "filesystem",
    source_class: conversation ? "active_runtime" : "project",
    source_product: conversation ? "opencode" : "filesystem",
    active_runtime: conversation,
    adapter_version: ADAPTER_VERSION,
    data,
    origin_id: originIdentity(`personal-glossary-evaluation:${id}:${index}`),
    content_fingerprint: contentFingerprint(text),
    ...(conversation
      ? {
          session_id: `evaluation-session-${id}-${index}`,
          conversation_key: `evaluation-session-${id}-${index}`,
          author_class: actor,
        }
      : {}),
  } as unknown as JsonObject;
}

function withBehaviorWorkspace<T>(label: string, run: (tiersDir: string, root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentera-glossary-evaluation-${label}-`));
  try {
    return run(path.join(root, "profile", "intermediate", "tiers"), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function behaviorList(fixture: Mapping, key: "discovery" | "scope" | "inferred_review" | "explicit_admission"): Mapping[] {
  const records = mappings(fixture[key]);
  if (records.length === 0) throw new Error(`behavior fixture ${key} is unavailable`);
  return records;
}

function mapExplicitCandidates<T extends { capsule: GlossaryEvidenceCapsule }>(candidates: readonly T[]): Map<string, T> {
  return new Map(
    candidates.flatMap((candidate) => {
      const sourceId = candidate.capsule.evidence[0]?.source_id;
      return typeof sourceId === "string" ? [[sourceId, candidate] as const] : [];
    }),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateIdentity(capsule: GlossaryEvidenceCapsule): string {
  return `${capsule.candidate_id}\0${capsule.candidate_revision}\0${capsule.capsule_sha256}`;
}

function evaluationDecisionBatches(candidates: readonly EvaluationDecisionCandidate[]): EvaluationDecisionCandidate[][] {
  const maximum = personalGlossaryCandidateProjectionContract().candidatesMax;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("candidate projection maximum is unavailable");
  }
  const byGeneration = new Map<string, EvaluationDecisionCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.capsule.generation}\0${candidate.capsule.policy_version}`;
    const group = byGeneration.get(key) ?? [];
    group.push(candidate);
    byGeneration.set(key, group);
  }

  const batches: EvaluationDecisionCandidate[][] = [];
  for (const key of [...byGeneration.keys()].sort(compareText)) {
    const group = byGeneration.get(key)!;
    const ordered = [...group].sort((left, right) => compareText(`${candidateIdentity(left.capsule)}\0${left.id}`, `${candidateIdentity(right.capsule)}\0${right.id}`));
    let batch: EvaluationDecisionCandidate[] = [];
    let candidateIds = new Set<string>();
    for (const candidate of ordered) {
      if (batch.length === maximum || candidateIds.has(candidate.capsule.candidate_id)) {
        batches.push(batch);
        batch = [];
        candidateIds = new Set();
      }
      batch.push(candidate);
      candidateIds.add(candidate.capsule.candidate_id);
    }
    if (batch.length > 0) batches.push(batch);
  }
  return batches;
}

function assertCompleteEvaluationBatch(projection: PersonalGlossaryCandidateProjection, batch: readonly EvaluationDecisionCandidate[]): void {
  const capsule = batch[0]?.capsule;
  if (capsule === undefined || projection.generation !== capsule.generation || projection.policy_version !== capsule.policy_version || projection.report.cap.applied || projection.candidates.length !== batch.length) {
    throw new Error("evaluation projection did not retain its complete batch");
  }
  const retained = new Set(projection.candidates.map((candidate) => candidateIdentity(candidate.capsule)));
  if (batch.some((candidate) => !retained.has(candidateIdentity(candidate.capsule)))) {
    throw new Error("evaluation projection omitted a decision candidate");
  }
}

function runEvaluationDecision(
  capsule: GlossaryEvidenceCapsule,
  projection: PersonalGlossaryCandidateProjection,
  env: { AGENTERA_PROFILE_DIR: string },
  tiersDir: string,
  precomputedCurrentProjection: PersonalGlossaryCurrentGenerationResult,
  precomputedDecisionContract: ReturnType<typeof personalGlossaryCandidateDecisionContract>,
  precomputedExplicitMining?: ReturnType<typeof mineExplicitGlossaryCandidates>,
): EvaluationDecisionStatus {
  const request = JSON.stringify({
    schema_version: "agentera.personalGlossaryAdmissionRequest.v2",
    candidate_id: capsule.candidate_id,
    candidate_revision: capsule.candidate_revision,
    candidate_capsule_sha256: capsule.capsule_sha256,
    candidate_projection_sha256: projection.projection_sha256,
    generation: capsule.generation,
    policy_version: capsule.policy_version,
    classification: {
      term: capsule.term,
      meaning: capsule.meaning,
      scope: capsule.scope,
      permanence: "durable",
      consistency: "consistent",
      confidence: 80,
    },
  });
  let stdout = "";
  const exit = runPersonalGlossaryEvaluationDecisionCommand(
    ["--input", "-", "--format", "json"],
    {
      stdin: () => request,
      out: (line) => {
        stdout += line;
      },
      err: () => undefined,
    },
    {
      env,
      tiersDir,
      precomputedCurrentProjection,
      precomputedDecisionContract,
      ...(precomputedExplicitMining === undefined ? {} : { precomputedExplicitMining }),
    },
  );
  if (exit !== 0) throw new Error("evaluation decision command failed");
  let result: Mapping | null = null;
  try {
    result = mapping(JSON.parse(stdout));
  } catch {
    throw new Error("evaluation decision command did not return JSON");
  }
  if (result?.schemaVersion !== "agentera.personalGlossaryAdmissionResult.v2" || mapping(result.receipt) === null || !["automatic_admission", "review_required", "abstain"].includes(String(result.status))) {
    throw new Error("evaluation decision command did not construct a current receipt");
  }
  return result.status as EvaluationDecisionStatus;
}

function runEvaluationDecisions(candidates: readonly EvaluationDecisionCandidate[], tiersDir: string, root: string, precomputedExplicitMining?: ReturnType<typeof mineExplicitGlossaryCandidates>): Map<string, EvaluationDecisionStatus> {
  const outcomes = new Map<string, EvaluationDecisionStatus>();
  const decisionContract = personalGlossaryCandidateDecisionContract();
  for (const [index, batch] of evaluationDecisionBatches(candidates).entries()) {
    const capsule = batch[0]!.capsule;
    const env = { AGENTERA_PROFILE_DIR: path.join(root, "profiles", `batch-${index + 1}`) };
    const projection = projectPersonalGlossaryCandidates({
      generation: capsule.generation,
      policy_version: capsule.policy_version,
      retained_at: FIXED_RETAINED_AT,
      candidates: batch.map((candidate) => ({
        capsule: candidate.capsule,
        project_ids: [`evaluation-${candidate.id}`],
      })),
    });
    assertCompleteEvaluationBatch(projection, batch);
    persistPersonalGlossaryCandidateProjection(projection, { env });
    const current = readCurrentPersonalGlossaryCandidateProjection({ env, tiersDir });
    if (current.status !== "current" || current.projection === null || current.projection.projection_sha256 !== projection.projection_sha256) {
      throw new Error("evaluation projection is not bound to its current tier");
    }
    for (const candidate of batch) {
      if (outcomes.has(candidate.id)) throw new Error("evaluation decision IDs must be unique");
      outcomes.set(candidate.id, runEvaluationDecision(candidate.capsule, projection, env, tiersDir, current, decisionContract, precomputedExplicitMining));
    }
  }
  return outcomes;
}

function executeExplicitDiscovery(fixture: Mapping): { observations: Mapping[]; seam: Mapping } {
  return withBehaviorWorkspace("discovery", (tiersDir) => {
    const cases = behaviorList(fixture, "discovery");
    publishEvidenceTiers(
      cases.map((record) => syntheticRecord(String(record.id), "conversation_turn", String(record.text))),
      { tiersDir, adapterVersion: ADAPTER_VERSION, publishedAt: FIXED_TIMESTAMP },
    );
    const mined = mineExplicitGlossaryCandidates({ tiersDir });
    if (mined.state !== "current") throw new Error("explicit discovery did not receive a current generation");
    const bySource = mapExplicitCandidates(mined.candidates);
    return {
      observations: cases.map((record) => ({
        id: record.id,
        observed_discovered: bySource.has(syntheticSourceId(String(record.id))),
      })),
      seam: {
        metric: "discovery_recall",
        producer: "mineExplicitGlossaryCandidates",
        cases: cases.length,
        candidates: mined.candidates.length,
      },
    };
  });
}

function executeScopeClassification(fixture: Mapping): { observations: Mapping[]; seam: Mapping } {
  return withBehaviorWorkspace("scope", (tiersDir) => {
    const cases = behaviorList(fixture, "scope");
    publishEvidenceTiers(
      cases.map((record) => syntheticRecord(String(record.id), "conversation_turn", String(record.text), 0, record.actor === "agent" ? "agent" : "user")),
      { tiersDir, adapterVersion: ADAPTER_VERSION, publishedAt: FIXED_TIMESTAMP },
    );
    const mined = mineExplicitGlossaryCandidates({ tiersDir });
    if (mined.state !== "current") throw new Error("scope classification did not receive a current generation");
    const bySource = mapExplicitCandidates(mined.candidates);
    const projectSources = new Set(mined.abstentions.filter((abstention) => abstention.reason === "project_only_scope").map((abstention) => abstention.source_id));
    return {
      observations: cases.map((record) => {
        const sourceId = syntheticSourceId(String(record.id));
        return {
          id: record.id,
          observed_scope: bySource.has(sourceId) ? "personal" : projectSources.has(sourceId) ? "project" : "neither",
        };
      }),
      seam: {
        metric: "scope_accuracy",
        producer: "mineExplicitGlossaryCandidates",
        cases: cases.length,
        candidates: mined.candidates.length,
        abstentions: mined.abstentions.length,
      },
    };
  });
}

function executeInferredReview(fixture: Mapping): { observations: Mapping[]; seam: Mapping } {
  return withBehaviorWorkspace("inferred", (tiersDir, root) => {
    const cases = behaviorList(fixture, "inferred_review");
    const records = cases.flatMap((record) => {
      const id = String(record.id);
      return mappings(record.sources).map((source, index) => syntheticRecord(id, String(source.source_kind), String(source.text), index));
    });
    publishEvidenceTiers(records, {
      tiersDir,
      adapterVersion: ADAPTER_VERSION,
      publishedAt: FIXED_TIMESTAMP,
    });
    const mined = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: cases.map((record) => String(record.term)),
    });
    if (mined.state !== "current") throw new Error("inferred review did not receive a current generation");
    const byTerm = new Map(mined.candidates.map((candidate) => [candidate.capsule.term, candidate]));
    const decisionCandidates = cases.flatMap((record) => {
      const candidate = byTerm.get(String(record.term));
      return candidate === undefined ? [] : [{ id: String(record.id), capsule: candidate.capsule }];
    });
    const decisions = runEvaluationDecisions(decisionCandidates, tiersDir, root);
    const observations = cases.map((record) => {
      const id = String(record.id);
      const candidate = byTerm.get(String(record.term));
      if (candidate === undefined) return { id: record.id, observed_reviewed: false };
      const decision = decisions.get(id);
      if (decision === undefined) throw new Error("inferred review decision is unavailable");
      return { id: record.id, observed_reviewed: decision === "review_required" };
    });
    return {
      observations,
      seam: {
        metric: "inferred_review_precision",
        producer: "mineRecurringGlossaryCandidates+personalGlossaryDecision.v2",
        cases: cases.length,
        candidates: decisionCandidates.length,
      },
    };
  });
}

function executeExplicitAdmission(fixture: Mapping): { observations: Mapping[]; seam: Mapping } {
  return withBehaviorWorkspace("admission", (tiersDir, root) => {
    const cases = behaviorList(fixture, "explicit_admission");
    publishEvidenceTiers(
      cases.map((record) => syntheticRecord(String(record.id), "conversation_turn", String(record.text))),
      { tiersDir, adapterVersion: ADAPTER_VERSION, publishedAt: FIXED_TIMESTAMP },
    );
    const mined = mineExplicitGlossaryCandidates({ tiersDir });
    if (mined.state !== "current") throw new Error("explicit admission did not receive a current generation");
    const bySource = mapExplicitCandidates(mined.candidates);
    const decisionCandidates = cases.flatMap((record) => {
      const id = String(record.id);
      const candidate = bySource.get(syntheticSourceId(id));
      return candidate === undefined ? [] : [{ id, capsule: candidate.capsule }];
    });
    const decisions = runEvaluationDecisions(decisionCandidates, tiersDir, root, mined);
    return {
      observations: cases.map((record) => {
        const id = String(record.id);
        const candidate = bySource.get(syntheticSourceId(id));
        if (candidate === undefined) return { id: record.id, observed_admitted: false };
        const decision = decisions.get(id);
        if (decision === undefined) throw new Error("explicit admission decision is unavailable");
        return { id: record.id, observed_admitted: decision === "automatic_admission" };
      }),
      seam: {
        metric: "explicit_admission_precision",
        producer: "mineExplicitGlossaryCandidates+personalGlossaryDecision.v2",
        cases: cases.length,
        candidates: mined.candidates.length,
      },
    };
  });
}

/**
 * Run only frozen synthetic input through current discovery, classification, and
 * V2 decision seams. It receives no expected labels and cannot persist effects
 * outside its deleted user-local temporary workspace.
 */
export function evaluateGlossaryBehavior(fixture: Mapping): BehaviorExecution {
  return withReadOnlyYamlMappingCache(() => {
    const discovery = executeExplicitDiscovery(fixture);
    const scope = executeScopeClassification(fixture);
    const inferredReview = executeInferredReview(fixture);
    const explicitAdmission = executeExplicitAdmission(fixture);
    return {
      discovery: discovery.observations,
      scope: scope.observations,
      inferred_review: inferredReview.observations,
      explicit_admission: explicitAdmission.observations,
      seams: [discovery.seam, scope.seam, inferredReview.seam, explicitAdmission.seam],
    };
  });
}

function binaryExamples(holdout: Mapping, observations: Mapping, key: "discovery" | "inferred_review" | "explicit_admission", expected: string, observed: string): BinaryEvaluationExample[] {
  const observedById = new Map(mappings(observations[key]).flatMap((record) => (nonEmptyString(record.id) ? [[record.id, record] as const] : [])));
  return mappings(holdout[key]).flatMap((record) => {
    const evaluated = nonEmptyString(record.id) ? observedById.get(record.id) : undefined;
    if (!record || !evaluated || !nonEmptyString(record.id) || typeof record[expected] !== "boolean" || typeof evaluated[observed] !== "boolean") {
      return [];
    }
    return [
      {
        id: record.id,
        expected: record[expected] as boolean,
        observed: evaluated[observed] as boolean,
      },
    ];
  });
}

function scopeExamples(holdout: Mapping, observations: Mapping): ScopeEvaluationExample[] {
  const observedById = new Map(mappings(observations.scope).flatMap((record) => (nonEmptyString(record.id) ? [[record.id, record] as const] : [])));
  return mappings(holdout.scope).flatMap((record) => {
    const evaluated = nonEmptyString(record.id) ? observedById.get(record.id) : undefined;
    if (!record || !evaluated || !nonEmptyString(record.id) || !nonEmptyString(record.expected_scope) || !nonEmptyString(evaluated.observed_scope)) {
      return [];
    }
    return [{ id: record.id, expected: record.expected_scope, observed: evaluated.observed_scope }];
  });
}

function metricCounts(results: readonly MetricResult[]): Record<string, number> {
  return Object.fromEntries(results.map((result) => [result.metric, result.denominator]));
}

function productPolicyProvenance(): Mapping {
  const sourceRoot = resolveSourceRoot();
  const policyPath = path.join(sourceRoot, "references", "artifacts", "glossary-entry-contract.yaml");
  return {
    path: "references/artifacts/glossary-entry-contract.yaml",
    sha256: sha256(fs.readFileSync(policyPath)),
  };
}

function failureReport(errors: string[]): JsonObject {
  return {
    schemaVersion: GLOSSARY_EVALUATION_SCHEMA_VERSION,
    status: "fail",
    report: {
      exploratory: { release_authorizing: false, status: "not_run" },
      release_gate: {
        release_authorizing: true,
        release_authorized: false,
        status: "fail",
        failure_reasons: errors,
      },
    },
    authority: { path: "references/analysis/personal-glossary-evaluation-authority.yaml" },
    holdout: { path: "references/analysis/personal-glossary-holdout.yaml", status: "not_verified" },
    metrics: [],
    metrics_sha256: canonicalDigest([]),
    gates: {
      explicit_admission: {
        metric: "explicit_admission_precision",
        status: "fail",
        qualification_blocker: true,
        outcome: "explicit_automatic_admission_only",
      },
      inferred_automatic_admission: {
        status: "disabled",
        enabled: false,
        measured_result: "cannot_enable",
      },
      release_authorizing: "fail_closed",
    },
    errors,
  } as unknown as JsonObject;
}

export function evaluateGlossaryHoldout(root: string = resolveSourceRoot()): JsonObject {
  const authorityPath = glossaryEvaluationAuthorityPath(root);
  let authority: Mapping;
  try {
    authority = loadGlossaryEvaluationAuthority(root);
  } catch {
    return failureReport(["cannot load evaluation authority"]);
  }
  const authorityErrors = validateGlossaryEvaluationAuthority(authority);
  const holdoutPath = glossaryEvaluationHoldoutPath(root);
  const behaviorPath = glossaryEvaluationBehaviorFixturePath(root);
  let holdout: Mapping;
  let holdoutBytes: Buffer;
  let behavior: Mapping;
  let behaviorBytes: Buffer;
  try {
    holdoutBytes = fs.readFileSync(holdoutPath);
    holdout = loadGlossaryEvaluationHoldout(root);
    behaviorBytes = fs.readFileSync(behaviorPath);
    behavior = loadGlossaryEvaluationBehaviorFixture(root);
  } catch {
    return failureReport([...authorityErrors, "cannot load frozen glossary evaluation fixture"]);
  }
  const fixtureErrors = [...validateFrozenGlossaryHoldout(authority, holdout, holdoutBytes), ...validateFrozenGlossaryBehaviorFixture(authority, holdout, behavior, behaviorBytes)];
  if (authorityErrors.length > 0 || fixtureErrors.length > 0) {
    return failureReport([...authorityErrors, ...fixtureErrors]);
  }

  let execution: BehaviorExecution;
  try {
    // Labels are deliberately absent from this production-seam execution.
    execution = evaluateGlossaryBehavior(behavior);
  } catch {
    return failureReport(["current personal glossary behavior could not be evaluated"]);
  }
  const observations: Mapping = {
    schema_version: GLOSSARY_OBSERVATIONS_SCHEMA_VERSION,
    holdout_id: holdout.holdout_id,
    holdout_fixture_sha256: sha256(holdoutBytes),
    behavior_fixture_sha256: sha256(behaviorBytes),
    discovery: execution.discovery,
    scope: execution.scope,
    inferred_review: execution.inferred_review,
    explicit_admission: execution.explicit_admission,
  };
  const observationErrors = validateGlossaryObservations(authority, holdout, observations);
  if (observationErrors.length > 0) return failureReport(observationErrors);

  let policy: Mapping;
  try {
    policy = productPolicyProvenance();
  } catch {
    return failureReport(["current personal glossary policy could not be recorded"]);
  }
  const results = [
    calculateDiscoveryRecall(binaryExamples(holdout, observations, "discovery", "expected_discoverable", "observed_discovered"), metricRule(authority, "discovery_recall")),
    calculateScopeAccuracy(scopeExamples(holdout, observations), metricRule(authority, "scope_accuracy")),
    calculateInferredReviewPrecision(binaryExamples(holdout, observations, "inferred_review", "expected_reviewable", "observed_reviewed"), metricRule(authority, "inferred_review_precision")),
    calculateExplicitAdmissionPrecision(binaryExamples(holdout, observations, "explicit_admission", "expected_admissible", "observed_admitted"), metricRule(authority, "explicit_admission_precision")),
  ];
  const releaseGatePass = results.every((result) => result.status === "pass");
  const releaseFailures = results.filter((result) => result.status !== "pass").map((result) => `${result.metric}:${result.failure_reasons.join(",")}`);
  return {
    schemaVersion: GLOSSARY_EVALUATION_SCHEMA_VERSION,
    status: releaseGatePass ? "pass" : "fail",
    report: {
      exploratory: { release_authorizing: false, status: "report_only", metrics: results },
      release_gate: {
        release_authorizing: true,
        release_authorized: releaseGatePass,
        status: releaseGatePass ? "pass" : "fail",
        failure_reasons: releaseFailures,
      },
    },
    authority: {
      schema_version: authority.schema_version,
      path: "references/analysis/personal-glossary-evaluation-authority.yaml",
      sha256: sha256(fs.readFileSync(authorityPath)),
    },
    policy,
    holdout: {
      id: holdout.holdout_id,
      status: holdout.status,
      fixture_sha256: sha256(holdoutBytes),
      labels_sha256: glossaryEvaluationLabelDigest(holdout),
      provenance: holdout.provenance as JsonObject,
      case_counts: glossaryEvaluationCaseCounts(holdout),
    },
    behavior_fixture: {
      id: behavior.fixture_id,
      status: behavior.status,
      path: "references/analysis/personal-glossary-evaluation-corpus.yaml",
      fixture_sha256: sha256(behaviorBytes),
      provenance: behavior.provenance as JsonObject,
      case_counts: glossaryEvaluationCaseCounts(behavior),
    },
    observations: {
      schema_version: observations.schema_version,
      source: "current_product_behavior",
      sha256: canonicalDigest(observations),
      holdout_fixture_sha256: observations.holdout_fixture_sha256,
      behavior_fixture_sha256: observations.behavior_fixture_sha256,
      case_counts: glossaryEvaluationCaseCounts(observations),
      seams: execution.seams,
      effects: [],
    },
    metrics: results,
    metrics_sha256: canonicalDigest(results),
    gates: {
      explicit_admission: {
        metric: "explicit_admission_precision",
        status: results[3]!.status,
        qualification_blocker: true,
        outcome: "explicit_automatic_admission_only",
      },
      inferred_review: {
        metric: "inferred_review_precision",
        status: results[2]!.status,
        outcome: "review_suggestions_only",
      },
      inferred_automatic_admission: {
        status: "disabled",
        enabled: false,
        measured_result: "cannot_enable",
      },
      release_authorizing: releaseGatePass ? "pass" : "fail_closed",
    },
    denominator_counts: metricCounts(results),
  } as unknown as JsonObject;
}

export function main(out: (line: string) => void = (line) => process.stdout.write(line), root: string = resolveSourceRoot()): number {
  const report = evaluateGlossaryHoldout(root);
  out(JSON.stringify(report, null, 2) + "\n");
  return report.status === "pass" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  const previous = process.env[BOOTSTRAP_SOURCE_ROOT_ENV];
  if (root) process.env[BOOTSTRAP_SOURCE_ROOT_ENV] = root;
  try {
    process.exitCode = main();
  } finally {
    if (previous === undefined) delete process.env[BOOTSTRAP_SOURCE_ROOT_ENV];
    else process.env[BOOTSTRAP_SOURCE_ROOT_ENV] = previous;
  }
}

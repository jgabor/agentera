import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { resolveRouteRequest } from "../registries/hybridRoute.js";
import { validateRouteReceiptSubmission } from "../registries/hybridRouteReceipt.js";

type Mapping = Record<string, unknown>;

type RouteCase = {
  id: string;
  partition: string;
  request: string;
  expected: { phase1: string; tier?: string; capability?: string };
};

type ReceiptCase = {
  id: string;
  partition: string;
  valid: boolean;
  request: string;
  expected_terminal: string;
  receipt: Mapping;
};

function mapping(value: unknown, source: string): Mapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must be a mapping`);
  return value as Mapping;
}

function requiredString(value: unknown, source: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${source} must be a non-empty string`);
  return value;
}

function cases(value: unknown, source: string): Array<RouteCase | ReceiptCase> {
  if (!Array.isArray(value)) throw new Error(`${source} must be a list`);
  return value;
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function percentile(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function nullableFixtureReceipt(receipt: Mapping): Mapping {
  return {
    version: null,
    request_sha256: null,
    outcome: null,
    capability: null,
    compound: null,
    question: null,
    remainder_span: null,
    ...receipt,
  };
}

/** Runs only frozen visible conformance; live and sealed evaluation stay external to this command. */
export function evaluateHybridRoute(
  sourceRoot: string = resolveSourceRoot(),
  environment: NodeJS.ProcessEnv = process.env,
): Mapping {
  const contractPath = path.join(sourceRoot, "references/cli/hybrid-route-contract.yaml");
  const corpusPath = path.join(sourceRoot, "fixtures/routing/hybrid-corpus.yaml");
  const manifestPath = path.join(sourceRoot, "fixtures/routing/holdout-manifest.yaml");
  const phrasePath = path.join(sourceRoot, "skills/agentera/route-phrases.yaml");
  const skillPath = path.join(sourceRoot, "skills/agentera/SKILL.md");
  const contract = loadYamlMapping(fs.readFileSync(contractPath, "utf8"));
  const corpus = loadYamlMapping(fs.readFileSync(corpusPath, "utf8"));
  const manifest = loadYamlMapping(fs.readFileSync(manifestPath, "utf8"));
  const evaluation = mapping(contract.evaluation, "contract.evaluation");
  const targetGates = mapping(evaluation.target_gates, "contract.evaluation.target_gates");
  const referenceHost = mapping(evaluation.reference_host, "contract.evaluation.reference_host");
  const holdout = mapping(manifest.holdout, "holdout manifest.holdout");
  const routeCases = cases(corpus.route_cases, "corpus.route_cases") as RouteCase[];
  const receiptCases = cases(corpus.receipt_cases, "corpus.receipt_cases") as ReceiptCase[];
  const results: Mapping[] = [];
  const deterministicTimings: number[] = [];
  const receiptTimings: number[] = [];

  for (const routeCase of routeCases) {
    const start = process.hrtime.bigint();
    const observed = resolveRouteRequest(routeCase.request, sourceRoot);
    const elapsed = elapsedMs(start);
    deterministicTimings.push(elapsed);
    const passed = observed.outcome === routeCase.expected.phase1
      && (observed.outcome !== "deterministic_selection" || (
        observed.tier === routeCase.expected.tier && observed.capability === routeCase.expected.capability
      ));
    results.push({
      case_id: routeCase.id,
      partition: routeCase.partition,
      routing_tier: observed.outcome === "deterministic_selection" ? observed.tier : "deterministic_abstention",
      expected_outcome: routeCase.expected.phase1,
      observed_outcome: observed.outcome,
      ...(observed.outcome === "deterministic_selection" ? { capability: observed.capability } : {}),
      status: passed ? "pass" : "fail",
      elapsed_ms: elapsed,
    });
  }

  for (const receiptCase of receiptCases) {
    const start = process.hrtime.bigint();
    let terminal = "invalid_receipt";
    try {
      const receipt = receiptCase.valid ? nullableFixtureReceipt(receiptCase.receipt) : receiptCase.receipt;
      terminal = validateRouteReceiptSubmission({ request: receiptCase.request, receipt }, sourceRoot).outcome;
    } catch {
      terminal = "invalid_receipt";
    }
    const elapsed = elapsedMs(start);
    receiptTimings.push(elapsed);
    results.push({
      case_id: receiptCase.id,
      partition: receiptCase.partition,
      routing_tier: "semantic_receipt_validation",
      expected_outcome: receiptCase.expected_terminal,
      observed_outcome: terminal,
      status: terminal === receiptCase.expected_terminal ? "pass" : "fail",
      elapsed_ms: elapsed,
    });
  }

  const failed = results.filter(({ status }) => status === "fail");
  const model = mapping(referenceHost.request, "contract.evaluation.reference_host.request");
  const credentialConfigured = Boolean(environment.OPENAI_API_KEY);
  const zdrApproved = environment.AGENTERA_OPENAI_ZDR_APPROVED === "true";
  const holdoutConfigured = Boolean(environment.AGENTERA_ROUTING_HOLDOUT);
  const liveBlockers = [
    ...(credentialConfigured ? [] : ["OPENAI_API_KEY is not configured in this process"]),
    ...(zdrApproved ? [] : ["approved ZDR custody was not supplied"]),
    ...(holdoutConfigured ? [] : ["evaluator-owned holdout custody was not supplied"]),
  ];
  return {
    schemaVersion: "agentera.hybrid_route_evaluation.v1",
    status: failed.length === 0 ? "pass" : "fail",
    authority: {
      contract_version: requiredString(contract.schema_version, "contract.schema_version"),
      protocol_sha256: hashFile(contractPath),
      phrase_authority_sha256: hashFile(phrasePath),
      shared_skill_sha256: hashFile(skillPath),
    },
    corpus: {
      schema_version: requiredString(corpus.schema_version, "corpus.schema_version"),
      content_sha256: hashFile(corpusPath),
      partitions: corpus.partitions,
      case_count: results.length,
    },
    results,
    aggregate_metrics: {
      passed: results.length - failed.length,
      failed: failed.length,
      harmful_misroutes: {
        target: targetGates.harmful_misroutes,
        status: "not_measured_without_independent_baseline_and_holdout",
        taxonomy: evaluation.harmful_misroute_taxonomy,
      },
    },
    model_context: {
      profile_version: referenceHost.profile_version,
      model: model.model,
      reasoning_effort: mapping(model.reasoning, "reference host reasoning").effort,
      max_output_tokens: model.max_output_tokens,
      store: model.store,
      samples: 0,
      distributions: {},
      variance: "not_measured_without_live_reference_host",
      retention_caveat: referenceHost.retention_caveat,
    },
    latency: {
      deterministic_phase1: { sample_count: deterministicTimings.length, p95_ms: percentile(deterministicTimings), target: targetGates.deterministic_phase1_p95 },
      receipt_validation: { sample_count: receiptTimings.length, p95_ms: percentile(receiptTimings), target: targetGates.receipt_validation_p95 },
      semantic_model: { status: "not_measured_without_live_reference_host", target: targetGates.semantic_end_to_end_p95 },
      end_to_end: { status: "not_measured_without_live_reference_host", target: targetGates.semantic_end_to_end_p95 },
    },
    prerequisites: {
      live_reference_host: { configured: credentialConfigured, status: credentialConfigured ? "configured_not_run" : "blocked" },
      zero_data_retention: { approved: zdrApproved, status: zdrApproved ? "approved_not_run" : "blocked" },
      sealed_holdout: {
        configured: holdoutConfigured,
        status: holdoutConfigured ? "configured_not_run" : "blocked",
        corpus_version: holdout.corpus_version,
        canonical_content_sha256: holdout.canonical_content_sha256,
        case_count: holdout.case_count,
      },
      blockers: liveBlockers,
    },
  };
}

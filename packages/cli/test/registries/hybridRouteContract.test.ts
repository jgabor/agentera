import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { loadCapabilitySchemaContract } from "../../src/registries/capabilityContract.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const CONTRACT_PATH = path.join(ROOT, "references/cli/hybrid-route-contract.yaml");
const PHRASES_PATH = path.join(ROOT, "skills/agentera/route-phrases.yaml");
const CORPUS_PATH = path.join(ROOT, "fixtures/routing/hybrid-corpus.yaml");
const CAPABILITY_CONTRACT_PATH = path.join(ROOT, "skills/agentera/capability_schema_contract.yaml");

function yaml(file: string): Record<string, any> {
  return YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
}

function normalizedPhrase(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

function receiptErrors(receipt: Record<string, unknown>): string[] {
  const outcome = receipt.outcome;
  if (outcome === "select") {
    const errors = typeof receipt.capability === "string" ? [] : ["missing_capability"];
    if (!(["none", "preserve"] as const).includes(receipt.compound as "none" | "preserve")) errors.push("invalid_compound");
    if (receipt.compound === "preserve" && !receipt.remainder_span) errors.push("missing_remainder_span");
    return errors;
  }
  if (outcome === "clarify") return typeof receipt.question === "string" && receipt.question ? [] : ["missing_question"];
  if (outcome === "no_match") return receipt.capability === undefined && receipt.question === undefined && receipt.compound === undefined ? [] : ["forbidden_capability"];
  return ["invalid_outcome"];
}

describe("hybrid route contract", () => {
  const contract = yaml(CONTRACT_PATH);
  const phrases = yaml(PHRASES_PATH);
  const corpus = yaml(CORPUS_PATH);
  const capabilityContract = loadCapabilitySchemaContract(CAPABILITY_CONTRACT_PATH);
  const capabilities = capabilityContract.routeAliases.primaryAliases.map(({ capability }) => capability);

  it("defines the versioned cascade, terminal outcomes, and receipt authorization", () => {
    expect(contract.schema_version).toBe("agentera.hybrid_route_contract.v1");
    expect(contract.protocol.response.outcomes).toEqual(["deterministic_selection", "semantic_required"]);
    expect(contract.protocol.receipt.outcomes).toEqual(["select", "clarify", "no_match"]);
    expect(contract.precedence.map((entry: { name: string }) => entry.name)).toEqual([
      "bare",
      "direct",
      "curated_phrase",
      "deterministic_abstention",
      "semantic_receipt",
    ]);
    expect(contract.protocol.validation_result.startup_authorization).toEqual({
      selected: "selected capability only",
      clarification: "none",
      status_fallback: "status only",
      invalid_receipt: "none",
    });
    expect(contract.compound_intent.principle).toContain("never silently chained");
    expect(contract.privacy.default_persistence).toBe("forbidden");
  });

  it("assigns every active literal phrase one collision-free capability and corpus proof", () => {
    expect(phrases.schema_version).toBe("agentera.route_phrase_registry.v1");
    const seen = new Set<string>();
    const routeCases = corpus.route_cases as Array<Record<string, any>>;

    expect(phrases.phrases).toHaveLength(capabilities.length);
    for (const entry of phrases.phrases as Array<Record<string, any>>) {
      expect(entry.id).toMatch(/^RP_[A-Z_]+$/);
      expect(capabilities).toContain(entry.capability);
      expect(entry.status).toBe("active");
      const phrase = normalizedPhrase(entry.phrase);
      expect(seen.has(phrase), `phrase collision: ${entry.phrase}`).toBe(false);
      seen.add(phrase);
      expect(capabilities.some((capability) => phrase === capability || phrase.startsWith(`${capability} `))).toBe(false);

      const evidence = routeCases.find((routeCase) => routeCase.id === entry.evidence[0]);
      expect(evidence).toMatchObject({
        partition: "development",
        expected: { phase1: "deterministic_selection", tier: "phrase", capability: entry.capability },
      });
    }
  });

  it("freezes positive and deterministic-abstention fixtures at every capability boundary", () => {
    const routeCases = corpus.route_cases as Array<Record<string, any>>;
    for (const capability of capabilities) {
      expect(routeCases.some((routeCase) => routeCase.id === `DEV-PHRASE-${capability.toUpperCase()}`)).toBe(true);
      expect(routeCases.some((routeCase) => routeCase.expected?.phase1 === "semantic_required" && routeCase.expected?.boundary === capability)).toBe(true);
    }
    expect(corpus.partitions).toMatchObject({
      development: { status: "frozen" },
      holdout: { status: "locked" },
      adversarial: { status: "frozen" },
    });
    expect(corpus.text_provenance).toContain("synthetic");
    expect(corpus.retention_policy).toContain("never these request strings");
  });

  it("contains passing and failing receipt fixtures for select, clarify, no-match, and compounds", () => {
    const receiptCases = corpus.receipt_cases as Array<Record<string, any>>;
    for (const outcome of ["select", "clarify", "no_match"]) {
      const cases = receiptCases.filter((receiptCase) => receiptCase.receipt.outcome === outcome);
      expect(cases.some((receiptCase) => receiptCase.valid)).toBe(true);
      expect(cases.some((receiptCase) => !receiptCase.valid)).toBe(true);
    }
    for (const receiptCase of receiptCases) {
      const errors = receiptErrors(receiptCase.receipt);
      expect(errors.length === 0, receiptCase.id).toBe(receiptCase.valid);
      if (!receiptCase.valid) expect(errors).toContain(receiptCase.error);
    }
    expect(receiptCases.some((receiptCase) => receiptCase.receipt.compound === "preserve" && receiptCase.valid)).toBe(true);
    expect(receiptCases.some((receiptCase) => receiptCase.error === "invalid_compound" && !receiptCase.valid)).toBe(true);
  });

  it("freezes the reference host, safety taxonomy, and Task 5 target gates without claiming a benchmark run", () => {
    expect(contract.evaluation.reference_host).toMatchObject({
      protocol: "agentera.semantic_receipt_json.v1",
      provider: "OpenAI Responses API",
      model: "openai/gpt-5.6-terra",
      settings: { temperature: 0, top_p: 1, max_output_tokens: 256, seed: "unsupported" },
    });
    expect(contract.evaluation.target_gates).toMatchObject({
      deterministic_fixture_accuracy: "100_percent",
      harmful_misroutes: 0,
      required_abstention_recall: "100_percent",
      required_clarification_recall: "100_percent",
      compound_preservation_recall: "100_percent",
    });
    expect(contract.evaluation.harmful_misroute_taxonomy).toHaveLength(4);
    expect(contract.evaluation.execution_status).toContain("Task 5");
  });

  it("defines normalized leading matching while retaining the original span and remainder", () => {
    const example = contract.phrase_matching.example;
    expect(normalizedPhrase(example.recognized_span.text)).toBe(example.normalized_leading_phrase);
    expect(example.request.slice(example.recognized_span.start, example.recognized_span.end)).toBe(example.recognized_span.text);
    expect(example.request.slice(example.topic_span.start, example.topic_span.end)).toBe(example.topic_span.text);
    const fullwidth = (corpus.route_cases as Array<Record<string, any>>).find(({ id }) => id === "ADV-FULLWIDTH-PHRASE")!;
    expect(normalizedPhrase(fullwidth.request).startsWith("help me decide ")).toBe(true);
    expect(fullwidth.expected.topic).toBe(" cache");
  });
});

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { loadCapabilitySchemaContract } from "../../src/registries/capabilityContract.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const CONTRACT_PATH = path.join(ROOT, "references/cli/hybrid-route-contract.yaml");
const PHRASES_PATH = path.join(ROOT, "skills/agentera/route-phrases.yaml");
const CORPUS_PATH = path.join(ROOT, "fixtures/routing/hybrid-corpus.yaml");
const HOLDOUT_MANIFEST_PATH = path.join(ROOT, "fixtures/routing/holdout-manifest.yaml");
const CAPABILITY_CONTRACT_PATH = path.join(ROOT, "skills/agentera/capability_schema_contract.yaml");

type RecordValue = Record<string, any>;

function yaml(file: string): RecordValue {
  return YAML.parse(fs.readFileSync(file, "utf8")) as RecordValue;
}

function normalizedPhrase(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

function utf8Offset(value: string, utf16Offset: number): number {
  return Buffer.byteLength(value.slice(0, utf16Offset), "utf8");
}

function normalizedSourceToken(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function sourceSeparatorOffset(value: string): number | undefined {
  let offset = 0;
  for (const character of value) {
    if ([":", "-", "—"].includes(character.normalize("NFKC"))) return offset;
    offset += character.length;
  }
  return undefined;
}

function deriveLeadingPhrase(request: string, phrase: string): { recognized: string; topic: string; utf8Start: number; utf8End: number } | undefined {
  const phraseTokens = normalizedPhrase(phrase).split(" ");
  const sourceTokens = [...request.matchAll(/\S+/gu)];
  if (sourceTokens.length < phraseTokens.length) return undefined;

  for (let index = 0; index < phraseTokens.length - 1; index += 1) {
    if (normalizedSourceToken(sourceTokens[index][0]) !== phraseTokens[index]) return undefined;
  }

  const finalToken = sourceTokens[phraseTokens.length - 1];
  const separatorOffset = sourceSeparatorOffset(finalToken[0]);
  const finalEnd = separatorOffset === undefined ? finalToken[0].length : separatorOffset;
  if (normalizedSourceToken(finalToken[0].slice(0, finalEnd)) !== phraseTokens.at(-1)) return undefined;

  const start = sourceTokens[0].index!;
  const end = finalToken.index! + finalEnd;
  const utf8Start = utf8Offset(request, start);
  const utf8End = utf8Offset(request, end);
  const bytes = Buffer.from(request, "utf8");
  return {
    recognized: bytes.subarray(utf8Start, utf8End).toString("utf8"),
    topic: bytes.subarray(utf8End).toString("utf8"),
    utf8Start,
    utf8End,
  };
}

function validateSchema(schema: RecordValue, value: unknown, location = "$"): string[] {
  const errors: string[] = [];
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => (
    (type === "object" && isObject)
    || (type === "string" && typeof value === "string")
    || (type === "integer" && Number.isInteger(value) && typeof value === "number")
    || (type === "null" && value === null)
  ))) return [`${location}.type`];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${location}.const`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${location}.enum`);
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${location}.minLength`);
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${location}.pattern`);
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${location}.minimum`);

  if (isObject) {
    const object = value as RecordValue;
    for (const required of schema.required ?? []) if (!(required in object)) errors.push(`${location}.required.${required}`);
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(object)) if (!(field in (schema.properties ?? {}))) errors.push(`${location}.additionalProperties.${field}`);
    }
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      if (field in object) errors.push(...validateSchema(fieldSchema as RecordValue, object[field], `${location}.${field}`));
    }
  }
  for (const member of schema.allOf ?? []) {
    const memberSchema = member as RecordValue;
    if (memberSchema.if) {
      if (validateSchema(memberSchema.if as RecordValue, value, location).length === 0 && memberSchema.then) {
        errors.push(...validateSchema(memberSchema.then as RecordValue, value, location));
      }
    } else {
      errors.push(...validateSchema(memberSchema, value, location));
    }
  }
  if (schema.not && validateSchema(schema.not as RecordValue, value, location).length === 0) errors.push(`${location}.not`);
  return errors;
}

function apiOutputSchemaErrors(schema: RecordValue, location = "$"): string[] {
  const errors: string[] = [];
  const supportedKeywords = new Set(["type", "enum", "properties", "required", "additionalProperties"]);
  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) errors.push(`${location}.unsupported.${keyword}`);
  }

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    const properties = schema.properties as RecordValue | undefined;
    const required = schema.required as string[] | undefined;
    if (!properties || !required || new Set(required).size !== Object.keys(properties).length || Object.keys(properties).some((field) => !required.includes(field))) {
      errors.push(`${location}.all_properties_required`);
    }
    if (schema.additionalProperties !== false) errors.push(`${location}.additional_properties`);
    for (const [field, fieldSchema] of Object.entries(properties ?? {})) {
      errors.push(...apiOutputSchemaErrors(fieldSchema as RecordValue, `${location}.${field}`));
    }
  }
  if (location === "$") {
    for (const field of ["capability", "compound", "question", "remainder_span"]) {
      const fieldTypes = (schema.properties as RecordValue)[field].type;
      if (!Array.isArray(fieldTypes) || !fieldTypes.includes("null")) errors.push(`${location}.${field}.nullable`);
    }
  }
  return errors;
}

function apiProfileErrors(host: RecordValue): string[] {
  const errors: string[] = [];
  const request = host.request as RecordValue;
  const format = (request.text as RecordValue).format as RecordValue;
  if (request.method !== "POST" || request.path !== "/v1/responses") errors.push("request.endpoint");
  if (request.model !== "gpt-5.6-terra") errors.push("request.model");
  if (request.store !== false) errors.push("request.store");
  if ((request.reasoning as RecordValue).effort !== "low") errors.push("request.reasoning.effort");
  if (request.max_output_tokens !== 256) errors.push("request.max_output_tokens");
  if (Object.keys(format).some((field) => !["type", "name", "strict", "schema"].includes(field))) errors.push("request.text.format.keys");
  if (format.type !== "json_schema" || format.name !== "agentera_route_receipt" || format.strict !== true) errors.push("request.text.format");
  errors.push(...apiOutputSchemaErrors(format.schema as RecordValue, "request.text.format.schema"));
  return errors;
}

function holdoutProvenanceErrors(manifest: RecordValue): string[] {
  const errors: string[] = [];
  const holdout = manifest.holdout as RecordValue;
  const provenance = holdout.content_provenance as RecordValue | undefined;
  if (!provenance || provenance.declaration !== "evaluator_attested" || provenance.attested_by !== "independent_evaluator") errors.push("provenance.evaluator_attestation");
  if (!Array.isArray(provenance?.text_origin) || !provenance.text_origin.every((source: unknown) => ["synthetic", "explicitly_consented"].includes(source as string))) {
    errors.push("provenance.text_origin");
  }
  if (provenance?.imported_production_prompts !== false) errors.push("provenance.imported_production_prompts");
  const custody = holdout.custody as RecordValue | undefined;
  if (!custody || custody.owner !== "independent_evaluator" || custody.access !== "sealed_private") errors.push("custody");
  return errors;
}

function receiptErrors(receipt: RecordValue, request: string, authority: RecordValue, capabilities: string[]): string[] {
  const errors = validateSchema(authority.schema, receipt).map((error) => error.replace("$.", ""));
  if (typeof receipt.capability === "string" && !capabilities.includes(receipt.capability)) errors.push("binding.capability");
  if (typeof receipt.request_sha256 === "string") {
    const expected = crypto.createHash("sha256").update(request, "utf8").digest("hex");
    if (receipt.request_sha256 !== expected) errors.push("binding.request_sha256");
  }
  for (const field of Object.keys(authority.request_bound_fields)) {
    const span = receipt[field] as RecordValue | undefined;
    if (span && !(0 <= span.start && span.start < span.end && span.end <= Buffer.byteLength(request, "utf8"))) {
      errors.push(`binding.${field}`);
    }
  }
  return errors;
}

describe("hybrid route contract", () => {
  const contract = yaml(CONTRACT_PATH);
  const phrases = yaml(PHRASES_PATH);
  const corpus = yaml(CORPUS_PATH);
  const holdoutManifest = yaml(HOLDOUT_MANIFEST_PATH);
  const capabilityContract = loadCapabilitySchemaContract(CAPABILITY_CONTRACT_PATH);
  const capabilities = capabilityContract.routeAliases.primaryAliases.map(({ capability }) => capability);

  it("defines the versioned cascade, terminal outcomes, and receipt authorization", () => {
    expect(contract.schema_version).toBe("agentera.hybrid_route_contract.v2");
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
    expect(contract.compound_intent.semantic.dispositions).toEqual(["none", "preserve"]);
    expect(contract.compound_intent.semantic.clarification).toContain("outcome only");
    expect(contract.protocol.receipt.clarify.forbidden_fields).toContain("remainder_span");
    expect(contract.protocol.receipt.no_match.forbidden_fields).toContain("remainder_span");
    expect(contract.privacy.default_persistence).toBe("forbidden");
  });

  it("assigns every active literal phrase one collision-free capability and corpus proof", () => {
    expect(phrases.schema_version).toBe("agentera.route_phrase_registry.v1");
    const seen = new Set<string>();
    const routeCases = corpus.route_cases as RecordValue[];

    expect(phrases.phrases).toHaveLength(capabilities.length);
    for (const entry of phrases.phrases as RecordValue[]) {
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

  it("keeps visible development and adversarial data separate from the sealed holdout", () => {
    const routeCases = corpus.route_cases as RecordValue[];
    expect(corpus.schema_version).toBe("agentera.hybrid_routing_corpus.v2");
    expect(Object.keys(corpus.partitions).sort()).toEqual(["adversarial", "development"]);
    expect(routeCases.every((routeCase) => routeCase.partition !== "holdout")).toBe(true);
    expect(corpus.freeze_policy).toContain("not a holdout");
    expect(holdoutManifest.holdout).toMatchObject({ corpus_version: "agentera.hybrid_routing_holdout.v1", case_count: 4 });
    expect(holdoutManifest.holdout.canonical_content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(holdoutManifest.holdout.excluded_content).toEqual(expect.arrayContaining(["requests", "expected_labels"]));
    expect(holdoutProvenanceErrors(holdoutManifest)).toEqual([]);
    expect(holdoutManifest.holdout.custody.repository_retains).toEqual(expect.arrayContaining([
      "version",
      "case_count",
      "canonical_content_sha256",
      "aggregate_result_binding",
    ]));
    expect(holdoutManifest.result_binding.required_fields).toEqual(expect.arrayContaining(["canonical_content_sha256", "aggregate_metrics"]));
    expect(holdoutManifest.result_binding.prohibited_fields).toEqual(expect.arrayContaining(["raw_request", "expected_label"]));
  });

  it("covers positive and negative boundaries for all phrases plus bare and direct tiers", () => {
    const routeCases = corpus.route_cases as RecordValue[];
    for (const capability of capabilities) {
      expect(routeCases.some((routeCase) => routeCase.id === `DEV-PHRASE-${capability.toUpperCase()}`)).toBe(true);
      expect(routeCases.some((routeCase) => routeCase.expected?.phase1 === "semantic_required" && routeCase.expected?.boundary === capability)).toBe(true);
    }
    expect(routeCases.find((routeCase) => routeCase.id === "DEV-BARE")?.expected.tier).toBe("bare");
    expect(routeCases.find((routeCase) => routeCase.id === "DEV-DIRECT")?.expected.tier).toBe("direct");
    expect(routeCases.find((routeCase) => routeCase.id === "ADV-BARE-WITH-TEXT")?.expected.boundary).toBe("bare");
    expect(routeCases.find((routeCase) => routeCase.id === "ADV-DIRECT-PARTIAL")?.expected.boundary).toBe("direct");
  });

  it("derives literal spans and UTF-8 topic slices from complete requests", () => {
    const phraseEntries = phrases.phrases as RecordValue[];
    const routeCases = corpus.route_cases as RecordValue[];
    for (const routeCase of routeCases.filter((candidate) => candidate.expected?.tier === "phrase")) {
      const match = phraseEntries
        .map((entry) => ({ entry, span: deriveLeadingPhrase(routeCase.request, entry.phrase) }))
        .find((candidate) => candidate.span);
      expect(match, routeCase.id).toBeDefined();
      expect(match!.entry.capability, routeCase.id).toBe(routeCase.expected.capability);
      expect(Buffer.from(routeCase.request, "utf8").subarray(match!.span.utf8Start, match!.span.utf8End).toString("utf8")).toBe(match!.span.recognized);
      if (routeCase.expected.topic !== undefined) expect(match!.span.topic, routeCase.id).toBe(routeCase.expected.topic);
    }
    for (const id of ["ADV-QUOTED-PHRASE", "ADV-NEGATED-PHRASE", "ADV-PARTIAL-PHRASE", "ADV-UNSUPPORTED-PUNCTUATION"]) {
      const routeCase = routeCases.find((candidate) => candidate.id === id)!;
      expect(deriveLeadingPhrase(routeCase.request, "help me decide"), id).toBeUndefined();
    }
  });

  it("validates complete receipt fixtures through the formal contract authority", () => {
    const authority = contract.protocol.receipt.validation_authority;
    const receiptCases = corpus.receipt_cases as RecordValue[];
    expect(authority.canonical_capability_source).toBe("skills/agentera/capability_schema_contract.yaml#route_aliases.primary_aliases");
    for (const receiptCase of receiptCases) {
      const errors = receiptErrors(receiptCase.receipt, receiptCase.request, authority, capabilities);
      expect(errors.length === 0, `${receiptCase.id}: ${errors.join(", ")}`).toBe(receiptCase.valid);
      if (!receiptCase.valid) expect(errors).toContain(receiptCase.error);
      if (receiptCase.valid) {
        expect(receiptCase.receipt).toEqual(expect.objectContaining({
          version: "agentera.route_receipt.v1",
          request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          outcome: expect.any(String),
        }));
      }
    }
    for (const terminal of contract.protocol.validation_result.terminal_outcomes) {
      expect(receiptCases.some((receiptCase) => receiptCase.expected_terminal === terminal), terminal).toBe(true);
    }
    expect(receiptCases.some((receiptCase) => receiptCase.valid && receiptCase.receipt.compound === "preserve")).toBe(true);
    expect(receiptCases.some((receiptCase) => !receiptCase.valid && receiptCase.error === "binding.remainder_span")).toBe(true);
  });

  it("keeps the API output shape separate from CLI outcome validation", () => {
    const authority = contract.protocol.receipt.validation_authority;
    const apiShape = authority.api_output_shape;
    expect(apiShape.canonical_capability_values_source).toBe(authority.canonical_capability_source);
    expect(apiShape.schema.properties.capability.enum.slice(0, -1)).toEqual(capabilities);
    expect(apiOutputSchemaErrors(apiShape.schema)).toEqual([]);

    const request = "choose a route";
    const hash = crypto.createHash("sha256").update(request, "utf8").digest("hex");
    const apiSelect = {
      version: "agentera.route_receipt.v1",
      request_sha256: hash,
      outcome: "select",
      capability: "plan",
      compound: "none",
      question: null,
      remainder_span: null,
    };
    expect(validateSchema(apiShape.schema, apiSelect)).toEqual([]);
    expect(receiptErrors({
      version: apiSelect.version,
      request_sha256: apiSelect.request_sha256,
      outcome: apiSelect.outcome,
      capability: apiSelect.capability,
      compound: apiSelect.compound,
    }, request, authority, capabilities)).toEqual([]);
  });

  it("rejects unsupported or incomplete API schemas, extra format fields, and missing holdout provenance", () => {
    const invalidSchema = structuredClone(contract.protocol.receipt.validation_authority.api_output_shape.schema);
    invalidSchema.allOf = [];
    invalidSchema.required = invalidSchema.required.filter((field: string) => field !== "question");
    invalidSchema.properties.question.type = "string";
    expect(apiOutputSchemaErrors(invalidSchema)).toEqual(expect.arrayContaining([
      "$.unsupported.allOf",
      "$.all_properties_required",
      "$.question.nullable",
    ]));

    const invalidProfile = structuredClone(contract.evaluation.reference_host);
    invalidProfile.request.text.format.canonical_capability_values_source = "not_an_api_field";
    invalidProfile.request.store = true;
    expect(apiProfileErrors(invalidProfile)).toEqual(expect.arrayContaining([
      "request.store",
      "request.text.format.keys",
    ]));

    const missingProvenance = structuredClone(holdoutManifest);
    delete missingProvenance.holdout.content_provenance;
    expect(holdoutProvenanceErrors(missingProvenance)).toContain("provenance.evaluator_attestation");
  });

  it("freezes an API-accepted, retention-bounded reference-host profile without claiming execution", () => {
    const host = contract.evaluation.reference_host;
    expect(host).toMatchObject({
      protocol: "agentera.semantic_receipt_json.v1",
      provider: "OpenAI Responses API",
      profile_version: "agentera.openai_responses_receipt.v1",
      request: {
        method: "POST",
        path: "/v1/responses",
        model: "gpt-5.6-terra",
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 256,
        text: { format: { type: "json_schema", name: "agentera_route_receipt", strict: true } },
      },
    });
    expect(host.harness.retry).toEqual({ max_attempts: 1, automatic_retry: false });
    expect(host.harness.timestamp_metadata.forbidden_fields).toEqual(expect.arrayContaining(["raw_request", "receipt_question"]));
    expect(host.request.text.format.schema).toEqual(contract.protocol.receipt.validation_authority.api_output_shape.schema);
    expect(apiProfileErrors(host)).toEqual([]);
    expect(host.retention_caveat).toContain("Zero Data Retention");
    expect(host.retention_caveat).toContain("not a promise");
    expect(host.data_controls_authority).toContain("https://developers.openai.com/api/docs/guides/your-data");
    expect(contract.evaluation.execution_status).toContain("Task 2 proves structural contract conformance only");
    expect(contract.evaluation.execution_status).toContain("Tasks 3–5");
  });
});

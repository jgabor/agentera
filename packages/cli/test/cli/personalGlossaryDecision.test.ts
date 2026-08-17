import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decidePersonalGlossaryCandidate } from "../../src/analytics/personalGlossaryDecision.js";
import {
  personalGlossaryCandidateProjectionPath,
  persistPersonalGlossaryCandidateProjection,
  projectPersonalGlossaryCandidates,
  type PersonalGlossaryCandidateProjection,
} from "../../src/analytics/personalGlossaryCandidateProjection.js";
import { ADAPTER_VERSION, contentFingerprint, originIdentity } from "../../src/analytics/extractCorpus/core.js";
import { publishEvidenceTiers } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { mineExplicitGlossaryCandidates } from "../../src/analytics/personalGlossaryExplicitMining.js";
import { main } from "../../src/cli/dispatch.js";
import { setGlossaryEvaluationRunnerForTest } from "../../src/eval/glossaryEvaluationProcess.js";
import { printReportHelp } from "../../src/cli/help.js";
import { requiresCompletedEntityCutover } from "../../src/cli/migrationRequired.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { sourceGlossaryEvaluationRunnerPath } from "../helpers/sourceSubprocess.js";
import {
  createGlossaryEvidenceCapsule,
  createGlossaryHostClassificationReceipt,
  type GlossaryEvidenceCapsule,
  type GlossaryHostClassification,
} from "../../src/registries/glossaryCandidateContracts.js";
import { glossaryCanonicalSha256 } from "../../src/registries/glossaryTermIdentity.js";
import { PERSONAL_GLOSSARY_MINING_POLICY_VERSION } from "../../src/registries/glossaryMiningAuthority.js";
import { personalGlossaryCandidateDecisionContract } from "../../src/registries/glossaryCandidateDecisionContract.js";
import {
  GLOSSARY_ADMISSION_OUTCOMES,
  GLOSSARY_ADMISSION_REASONS_BY_OUTCOME,
} from "../../src/registries/glossaryCandidateDecisionAuthority.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const SOURCE_BUILD_RUNNER = sourceGlossaryEvaluationRunnerPath();
const SOURCE_BUILD_RUNNER_URL = pathToFileURL(SOURCE_BUILD_RUNNER).href;
setGlossaryEvaluationRunnerForTest(SOURCE_BUILD_RUNNER);
const RETAINED_AT = "2026-08-10T00:00:00.000Z";
const AUTHORITY_PATH = path.join(ROOT, "references/artifacts/glossary-entry-contract.yaml");
const ADMISSION_REASON_PAIRS = Object.entries(GLOSSARY_ADMISSION_REASONS_BY_OUTCOME).flatMap(
  ([outcome, reasons]) => reasons.map((reason) => ({ outcome, reason })),
);

let profileDir: string;
let currentGeneration: string;
let previousProfileDir: string | undefined;
let previousProfileraProfileDir: string | undefined;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-decision-"));
  previousProfileDir = process.env.AGENTERA_PROFILE_DIR;
  previousProfileraProfileDir = process.env.PROFILERA_PROFILE_DIR;
  process.env.AGENTERA_PROFILE_DIR = profileDir;
  delete process.env.PROFILERA_PROFILE_DIR;
  currentGeneration = publish([]).generation;
});

afterEach(() => {
  setGlossaryEvaluationRunnerForTest(SOURCE_BUILD_RUNNER);
  if (previousProfileDir === undefined) delete process.env.AGENTERA_PROFILE_DIR;
  else process.env.AGENTERA_PROFILE_DIR = previousProfileDir;
  if (previousProfileraProfileDir === undefined) delete process.env.PROFILERA_PROFILE_DIR;
  else process.env.PROFILERA_PROFILE_DIR = previousProfileraProfileDir;
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function tiersDir(): string {
  return path.join(profileDir, "intermediate", "tiers");
}

function record(
  sourceId: string,
  text: string,
  authorClass = "user",
): Record<string, unknown> {
  return {
    source_id: sourceId,
    source_kind: "conversation_turn",
    timestamp: "2026-08-10T00:00:00.000Z",
    project_id: "private-project",
    runtime: "opencode",
    source_class: "active_runtime",
    source_product: "opencode",
    active_runtime: true,
    adapter_version: ADAPTER_VERSION,
    data: { actor: authorClass === "user" ? "user" : "assistant", signal_type: "correction", text },
    origin_id: originIdentity(`fixture:${sourceId}`),
    content_fingerprint: contentFingerprint(text),
    session_id: `session-${sourceId}`,
    conversation_key: `session-${sourceId}`,
    author_class: authorClass,
  };
}

function publish(records: Array<Record<string, unknown>>) {
  return publishEvidenceTiers(records, {
    tiersDir: tiersDir(),
    adapterVersion: ADAPTER_VERSION,
    publishedAt: RETAINED_AT,
  });
}

function persist(capsules: readonly GlossaryEvidenceCapsule[], retainedAt = RETAINED_AT): PersonalGlossaryCandidateProjection {
  const projection = projectPersonalGlossaryCandidates({
    generation: capsules[0]!.generation,
    policy_version: capsules[0]!.policy_version,
    retained_at: retainedAt,
    candidates: capsules.map((capsule) => ({ capsule, project_ids: ["private-project"] })),
  });
  persistPersonalGlossaryCandidateProjection(projection);
  return projection;
}

function explicitFixture(
  text = "Actually, `ship shape` means the complete form of a deliverable.",
  authorClass = "user",
): { capsule: GlossaryEvidenceCapsule; projection: PersonalGlossaryCandidateProjection } {
  publish([record("explicit-source", text, authorClass)]);
  const mined = mineExplicitGlossaryCandidates({ tiersDir: tiersDir() });
  expect(mined.state).toBe("current");
  expect(mined.candidates).toHaveLength(1);
  const capsule = mined.candidates[0]!.capsule;
  return { capsule, projection: persist([capsule]) };
}

function receiptFor(
  capsule: GlossaryEvidenceCapsule,
  projection: PersonalGlossaryCandidateProjection,
  overrides: Partial<GlossaryHostClassification> = {},
) {
  return createGlossaryHostClassificationReceipt({
    capsule,
    candidate_projection_sha256: projection.projection_sha256,
    classification: {
      term: capsule.term,
      meaning: capsule.meaning,
      scope: capsule.scope,
      permanence: "durable",
      consistency: "consistent",
      confidence: 100,
      ...overrides,
    },
  });
}

function reseal(receipt: Record<string, unknown>): Record<string, unknown> {
  const { receipt_sha256: _receiptSha256, ...body } = receipt;
  return { ...body, receipt_sha256: glossaryCanonicalSha256(body) };
}

function run(args: string[], stdin?: string): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], {
    stdin: () => {
      if (stdin === undefined) throw new Error("decision command unexpectedly read stdin");
      return stdin;
    },
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { rc, out, err };
}

function request(receipt: unknown): string {
  return JSON.stringify({
    schema_version: "agentera.personalGlossaryAdmissionRequest.v1",
    receipt,
  });
}

function receiptConstructionRequest(
  capsule: GlossaryEvidenceCapsule,
  projection: PersonalGlossaryCandidateProjection,
  classification: Partial<GlossaryHostClassification> = {},
): string {
  return JSON.stringify({
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
      confidence: 100,
      ...classification,
    },
  });
}

function fileBytesOrNull(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function noEffectSnapshot() {
  return {
    projection: fileBytesOrNull(personalGlossaryCandidateProjectionPath()),
    profile: fileBytesOrNull(path.join(profileDir, "PROFILE.md")),
    reviews: fs.existsSync(path.join(profileDir, "intermediate", "personal-glossary", "reviews")),
  };
}

function expectNoEffects(before: ReturnType<typeof noEffectSnapshot>): void {
  expect(noEffectSnapshot()).toEqual(before);
}

function runRequest(source: "file" | "stdin", input: string): { rc: number; out: string; err: string } {
  const args = ["report", "personal-glossary-decision", "--input"];
  if (source === "stdin") return run([...args, "-", "--format", "json"], input);
  const file = path.join(profileDir, "decision-request.json");
  fs.writeFileSync(file, input);
  return run([...args, file, "--format", "json"]);
}

function requestAtByteLength(receipt: unknown, maxBytes: number): string {
  const value = request(receipt);
  return `${value}${" ".repeat(maxBytes - Buffer.byteLength(value, "utf8"))}`;
}

function inferredFixture(): { capsule: GlossaryEvidenceCapsule; projection: PersonalGlossaryCandidateProjection } {
  const capsule = createGlossaryEvidenceCapsule({
    term: "recurring term",
    meaning: "a term observed in recurring private use",
    scope: "personal",
    provenance_kind: "personal_inferred_usage",
    evidence: [
      { source_id: "source-a", evidence_anchor: "anchor-a", source_kind: "instruction_document" },
      { source_id: "source-b", evidence_anchor: "anchor-b", source_kind: "project_config_signal" },
    ],
    policy_version: PERSONAL_GLOSSARY_MINING_POLICY_VERSION,
    generation: currentGeneration,
  });
  return { capsule, projection: persist([capsule]) };
}

function unavailableExplicitFixture(): { capsule: GlossaryEvidenceCapsule; projection: PersonalGlossaryCandidateProjection } {
  const capsule = createGlossaryEvidenceCapsule({
    term: "unavailable evidence",
    meaning: "a definition whose source tier is unavailable",
    scope: "personal",
    provenance_kind: "personal_explicit_definition",
    evidence: [{ source_id: "unavailable-source", evidence_anchor: "unavailable-anchor", signal_type: "correction" }],
    policy_version: PERSONAL_GLOSSARY_MINING_POLICY_VERSION,
    generation: currentGeneration,
  });
  return { capsule, projection: persist([capsule]) };
}

function qualityGateRoot(): string {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-quality-gate-"));
  const analysis = path.join(sourceRoot, "references", "analysis");
  fs.mkdirSync(analysis, { recursive: true });
  for (const name of [
    "personal-glossary-evaluation-authority.yaml",
    "personal-glossary-holdout.yaml",
    "personal-glossary-evaluation-corpus.yaml",
  ]) {
    fs.copyFileSync(path.join(ROOT, "references", "analysis", name), path.join(analysis, name));
  }
  const artifactPath = path.join(sourceRoot, "references", "artifacts", "glossary-entry-contract.yaml");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "references", "artifacts", "glossary-entry-contract.yaml"), artifactPath);
  fs.copyFileSync(
    path.join(ROOT, "references", "analysis", "evidence-tier-authority.yaml"),
    path.join(analysis, "evidence-tier-authority.yaml"),
  );
  return sourceRoot;
}

function failingQualityGateRoot(): string {
  const sourceRoot = qualityGateRoot();
  fs.appendFileSync(
    path.join(sourceRoot, "references", "analysis", "personal-glossary-evaluation-corpus.yaml"),
    "\n# fixture drift\n",
  );
  return sourceRoot;
}

function useEvaluationRunner(sourceRoot: string, source: string): void {
  const runner = path.join(sourceRoot, "glossary-evaluation-test-runner.mjs");
  fs.writeFileSync(runner, source, "utf8");
  setGlossaryEvaluationRunnerForTest(runner);
}

function evaluatedReportRunner(exitCode: number, mutate = ""): string {
  return [
    "process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = process.argv[2] ?? \"\";",
    `const { evaluateGlossaryHoldout } = await import(${JSON.stringify(SOURCE_BUILD_RUNNER_URL)});`,
    "const report = evaluateGlossaryHoldout(process.argv[2]);",
    mutate,
    "process.stdout.write(JSON.stringify(report));",
    `process.exitCode = ${exitCode};`,
  ].join("\n");
}

function minimalPassShapedRunner(): string {
  return `process.stdout.write(${JSON.stringify(JSON.stringify({
    schemaVersion: "agentera.personalGlossaryEvaluation.v1",
    status: "pass",
    gates: {
      release_authorizing: "pass",
      explicit_admission: { status: "pass" },
    },
  }))});`;
}

function expectQualityGateBlocked(
  capsule: GlossaryEvidenceCapsule,
  projection: PersonalGlossaryCandidateProjection,
  sourceRoot: string,
): void {
  expect(decidePersonalGlossaryCandidate(receiptFor(capsule, projection), { sourceRoot })).toMatchObject({
    status: "review_required",
    reason: "quality_gate_not_authorizing",
    decision: { outcome: "review_required" },
  });
}

function invalidDecisionAuthorityRoot(): string {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-decision-authority-"));
  const authorityPath = path.join(sourceRoot, "references", "artifacts", "glossary-entry-contract.yaml");
  fs.mkdirSync(path.dirname(authorityPath), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "references", "analysis"), { recursive: true });
  const authority = YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8")) as Record<string, any>;
  authority.candidate_contracts.layers.cli_decision.automatic_admission.allowed_provenance = "provenance_variants.invalid";
  fs.writeFileSync(authorityPath, YAML.stringify(authority), "utf8");
  fs.copyFileSync(
    path.join(ROOT, "references", "analysis", "evidence-tier-authority.yaml"),
    path.join(sourceRoot, "references", "analysis", "evidence-tier-authority.yaml"),
  );
  return sourceRoot;
}

describe("agentera report personal-glossary-decision", () => {
  it("exposes a bounded read-only decision contract and replays an authorized explicit admission without effects", () => {
    expect(printReportHelp()).toContain(
      "agentera report personal-glossary-decision --input <file|-> --format json",
    );
    expect(requiresCompletedEntityCutover(["report", "personal-glossary-decision"])).toBe(false);
    expect((buildSchemaPayload().integration as any).personal_glossary.candidate_decision).toMatchObject({
      command: "agentera report personal-glossary-decision",
      request_schema_version: "agentera.personalGlossaryAdmissionRequest.v1",
      result_schema_version: "agentera.personalGlossaryAdmissionResult.v1",
      statuses: ["automatic_admission", "review_required", "abstain"],
      reason_codes_by_outcome: GLOSSARY_ADMISSION_REASONS_BY_OUTCOME,
      effects: [],
      automatic_admission: {
        allowed_provenance: "provenance_variants.personal_explicit_definition",
        inferred_automatic_admission: "disabled",
      },
      receipt_construction: {
        request_schema_version: "agentera.personalGlossaryAdmissionRequest.v2",
        request_fields: [
          "schema_version",
          "candidate_id",
          "candidate_revision",
          "candidate_capsule_sha256",
          "candidate_projection_sha256",
          "generation",
          "policy_version",
          "classification",
        ],
        result_schema_version: "agentera.personalGlossaryAdmissionResult.v2",
        result_fields: ["schemaVersion", "command", "status", "receipt", "decision", "reason", "effects"],
      },
    });

    const { capsule, projection } = explicitFixture();
    const receipt = receiptFor(capsule, projection);
    const projectionPath = personalGlossaryCandidateProjectionPath();
    const projectionBefore = fs.readFileSync(projectionPath, "utf8");
    const tiersBefore = fs.readFileSync(path.join(tiersDir(), "current.json"), "utf8");
    const first = run(
      ["report", "personal-glossary-decision", "--input", "-", "--format", "json"],
      request(receipt),
    );
    const replay = run(
      ["report", "personal-glossary-decision", "--input=-", "--format=json"],
      request(receipt),
    );

    expect(first).toMatchObject({ rc: 0, err: "" });
    expect(replay).toEqual(first);
    expect(JSON.parse(first.out)).toMatchObject({
      status: "automatic_admission",
      reason: "explicit_current_authorized",
      effects: [],
      decision: {
        candidate_id: capsule.candidate_id,
        candidate_revision: capsule.candidate_revision,
        candidate_capsule_sha256: capsule.capsule_sha256,
        candidate_projection_sha256: projection.projection_sha256,
        classification_contract_version: "agentera.personalGlossaryHostClassificationReceipt.v1",
        semantic_fingerprint: receipt.semantic_fingerprint,
        outcome: "automatic_admission",
      },
    });
    expect(first.out).not.toContain(capsule.term);
    expect(first.out).not.toContain(capsule.meaning);
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    expect(fs.readFileSync(path.join(tiersDir(), "current.json"), "utf8")).toBe(tiersBefore);
    expect(fs.existsSync(path.join(profileDir, "PROFILE.md"))).toBe(false);
    expect(fs.existsSync(path.join(profileDir, "intermediate", "personal-glossary", "reviews"))).toBe(false);
  });

  it("constructs a sealed receipt from a bounded classification and exact current bindings", () => {
    const { capsule, projection } = explicitFixture();
    const before = noEffectSnapshot();
    const first = run(
      ["report", "personal-glossary-decision", "--input", "-", "--format", "json"],
      receiptConstructionRequest(capsule, projection),
    );
    const replay = run(
      ["report", "personal-glossary-decision", "--input=-", "--format=json"],
      receiptConstructionRequest(capsule, projection),
    );

    expect(first).toMatchObject({ rc: 0, err: "" });
    expect(replay).toEqual(first);
    const body = JSON.parse(first.out);
    expect(body).toMatchObject({
      schemaVersion: "agentera.personalGlossaryAdmissionResult.v2",
      status: "automatic_admission",
      reason: "explicit_current_authorized",
      effects: [],
      receipt: {
        candidate_id: capsule.candidate_id,
        candidate_revision: capsule.candidate_revision,
        candidate_capsule_sha256: capsule.capsule_sha256,
        candidate_projection_sha256: projection.projection_sha256,
        semantic_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      decision: {
        host_receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        semantic_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(body.decision.host_receipt_sha256).toBe(body.receipt.receipt_sha256);
    expect(body.decision.semantic_fingerprint).toBe(body.receipt.semantic_fingerprint);
    expectNoEffects(before);
  });

  it("does not construct a receipt for a stale exact candidate binding", () => {
    const { capsule, projection } = explicitFixture();
    const before = noEffectSnapshot();
    const request = JSON.parse(receiptConstructionRequest(capsule, projection));
    request.candidate_projection_sha256 = "f".repeat(64);
    const result = run(
      ["report", "personal-glossary-decision", "--input", "-", "--format", "json"],
      JSON.stringify(request),
    );

    expect(result).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: "agentera.personalGlossaryAdmissionResult.v2",
      status: "abstain",
      reason: "candidate_unavailable",
      receipt: null,
      decision: null,
      effects: [],
    });
    expectNoEffects(before);
  });

  it("loads only the authority-owned outcome/reason pairs", () => {
    expect(personalGlossaryCandidateDecisionContract().reasonCodesByOutcome).toEqual(
      GLOSSARY_ADMISSION_REASONS_BY_OUTCOME,
    );
    const authority = YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8")) as Record<string, any>;
    authority.candidate_contracts.layers.cli_decision.reason_codes_by_outcome.abstain.push(
      "classification_changed",
    );
    const invalid = path.join(profileDir, "invalid-glossary-authority.yaml");
    fs.writeFileSync(invalid, YAML.stringify(authority), "utf8");
    expect(() => personalGlossaryCandidateDecisionContract(invalid)).toThrow(
      "personal glossary decision outcome/reason authority is unavailable",
    );
  });

  it.each([
    ["candidate ID", (receipt: Record<string, unknown>) => ({ ...receipt, candidate_id: "f".repeat(64) }), true],
    ["revision", (receipt: Record<string, unknown>) => ({ ...receipt, candidate_revision: "f".repeat(64) }), true],
    ["capsule digest", (receipt: Record<string, unknown>) => ({ ...receipt, candidate_capsule_sha256: "f".repeat(64) }), true],
    ["projection digest", (receipt: Record<string, unknown>) => ({ ...receipt, candidate_projection_sha256: "f".repeat(64) }), true],
    ["generation", (receipt: Record<string, unknown>) => ({ ...receipt, generation: "other-generation" }), true],
    ["policy", (receipt: Record<string, unknown>) => ({ ...receipt, policy_version: "other-policy" }), true],
    ["classification contract", (receipt: Record<string, unknown>) => ({ ...receipt, schema_version: "agentera.personalGlossaryHostClassificationReceipt.v2" }), true],
    ["semantic fingerprint", (receipt: Record<string, unknown>) => ({ ...receipt, semantic_fingerprint: "f".repeat(64) }), true],
    ["receipt digest", (receipt: Record<string, unknown>) => ({ ...receipt, receipt_sha256: "f".repeat(64) }), false],
    ["unknown authority field", (receipt: Record<string, unknown>) => ({ ...receipt, admission: "automatic_admission" }), true],
  ])("abstains for a mismatched %s without projection effects", (_name, mutate, seals) => {
    const { capsule, projection } = explicitFixture();
    const receipt = receiptFor(capsule, projection) as Record<string, unknown>;
    const mutated = mutate(receipt);
    const candidate = seals ? reseal(mutated) : mutated;
    const projectionPath = personalGlossaryCandidateProjectionPath();
    const before = fs.readFileSync(projectionPath, "utf8");

    const result = decidePersonalGlossaryCandidate(candidate);

    expect(result).toMatchObject({ status: "abstain", decision: null, effects: [] });
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(before);
  });

  it.each([
    {
      name: "unavailable projection",
      status: "abstain",
      reason: "projection_unavailable",
      hasDecision: false,
      execute: () => {
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate({}) };
      },
    },
    {
      name: "unavailable candidate",
      status: "abstain",
      reason: "candidate_unavailable",
      hasDecision: false,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        const receipt = reseal({ ...receiptFor(capsule, projection), candidate_id: "f".repeat(64) });
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receipt) };
      },
    },
    {
      name: "digest-valid conflicting receipt",
      status: "abstain",
      reason: "receipt_invalid",
      hasDecision: false,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        const valid = receiptFor(capsule, projection);
        const receipt = reseal({
          ...valid,
          classification: { ...valid.classification, meaning: "a conflicting semantic meaning" },
        });
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receipt) };
      },
    },
    {
      name: "digest-valid projection binding mismatch",
      status: "abstain",
      reason: "projection_changed",
      hasDecision: false,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        const receipt = reseal({
          ...receiptFor(capsule, projection),
          candidate_projection_sha256: "f".repeat(64),
        });
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receipt) };
      },
    },
    {
      name: "decision validation failure",
      status: "abstain",
      reason: "decision_validation_failed",
      hasDecision: false,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        const sourceRoot = invalidDecisionAuthorityRoot();
        const previous = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
        process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = sourceRoot;
        try {
          const before = noEffectSnapshot();
          return {
            before,
            result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection), { sourceRoot: ROOT }),
          };
        } finally {
          if (previous === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
          else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = previous;
          fs.rmSync(sourceRoot, { recursive: true, force: true });
        }
      },
    },
    {
      name: "project scope",
      status: "abstain",
      reason: "scope_project",
      hasDecision: true,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection, { scope: "project" })) };
      },
    },
    {
      name: "ambiguous scope",
      status: "review_required",
      reason: "scope_ambiguous",
      hasDecision: true,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection, { scope: "ambiguous" })) };
      },
    },
    {
      name: "inconsistent classification",
      status: "review_required",
      reason: "classification_inconsistent",
      hasDecision: true,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection, { consistency: "inconsistent" })) };
      },
    },
    {
      name: "changed classification",
      status: "review_required",
      reason: "classification_changed",
      hasDecision: true,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection, { meaning: "a changed meaning" })) };
      },
    },
    {
      name: "entry conflict",
      status: "review_required",
      reason: "entry_conflict",
      hasDecision: true,
      execute: () => {
        const { capsule } = explicitFixture();
        const conflicting = createGlossaryEvidenceCapsule({
          term: capsule.term,
          meaning: "a conflicting definition",
          scope: "personal",
          provenance_kind: "personal_explicit_definition",
          evidence: [{ source_id: "conflict-source", evidence_anchor: "conflict-anchor", signal_type: "correction" }],
          policy_version: capsule.policy_version,
          generation: capsule.generation,
        });
        const projection = persist([capsule, conflicting]);
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection)) };
      },
    },
    {
      name: "inferred candidate",
      status: "review_required",
      reason: "inferred_requires_review",
      hasDecision: true,
      execute: () => {
        const { capsule, projection } = inferredFixture();
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection)) };
      },
    },
    {
      name: "missing explicit evidence",
      status: "abstain",
      reason: "evidence_changed",
      hasDecision: true,
      execute: () => {
        const { capsule, projection } = unavailableExplicitFixture();
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection)) };
      },
    },
    {
      name: "changed explicit evidence",
      status: "abstain",
      reason: "projection_stale",
      hasDecision: false,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        publish([record("changed-source", "Actually, `ship shape` means a changed form.")]);
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection)) };
      },
    },
    {
      name: "retracted explicit evidence",
      status: "review_required",
      reason: "evidence_retracted_or_conflicted",
      hasDecision: true,
      execute: () => {
        const text = "Actually, `ship shape` means the complete form. That definition is no longer valid for ship shape.";
        publish([record("retracted-source", text)]);
        const capsule = createGlossaryEvidenceCapsule({
          term: "ship shape",
          meaning: "the complete form",
          scope: "personal",
          provenance_kind: "personal_explicit_definition",
          evidence: [{ source_id: "retracted-source", evidence_anchor: "retracted-source", signal_type: "correction" }],
          policy_version: PERSONAL_GLOSSARY_MINING_POLICY_VERSION,
          generation: mineExplicitGlossaryCandidates({ tiersDir: tiersDir() }).generation!,
        });
        const projection = persist([capsule]);
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection)) };
      },
    },
    {
      name: "non-authorizing quality gate",
      status: "review_required",
      reason: "quality_gate_not_authorizing",
      hasDecision: true,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        const sourceRoot = failingQualityGateRoot();
        try {
          const before = noEffectSnapshot();
          return {
            before,
            result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection), { sourceRoot }),
          };
        } finally {
          fs.rmSync(sourceRoot, { recursive: true, force: true });
        }
      },
    },
    {
      name: "authorized explicit definition",
      status: "automatic_admission",
      reason: "explicit_current_authorized",
      hasDecision: true,
      execute: () => {
        const { capsule, projection } = explicitFixture();
        const before = noEffectSnapshot();
        return { before, result: decidePersonalGlossaryCandidate(receiptFor(capsule, projection)) };
      },
    },
  ])("returns a no-effect result for $name", ({ status, reason, hasDecision, execute }) => {
    const { before, result } = execute();
    expect(result).toMatchObject({ status, reason, effects: [] });
    if (hasDecision) expect(result.decision).toMatchObject({ outcome: status });
    else expect(result.decision).toBeNull();
    expectNoEffects(before);
  });

  it("invalidates a cached quality gate when its frozen behavior fixture changes", () => {
    const { capsule, projection } = explicitFixture();
    const sourceRoot = qualityGateRoot();
    try {
      const receipt = receiptFor(capsule, projection);
      expect(decidePersonalGlossaryCandidate(receipt, { sourceRoot })).toMatchObject({
        status: "automatic_admission",
        reason: "explicit_current_authorized",
      });
      fs.appendFileSync(
        path.join(sourceRoot, "references", "analysis", "personal-glossary-evaluation-corpus.yaml"),
        "\n# fixture drift\n",
      );
      expect(decidePersonalGlossaryCandidate(receipt, { sourceRoot })).toMatchObject({
        status: "review_required",
        reason: "quality_gate_not_authorizing",
      });
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a valid-looking evaluator report exits nonzero and never caches its pass", () => {
    const { capsule, projection } = explicitFixture();
    const sourceRoot = qualityGateRoot();
    try {
      useEvaluationRunner(sourceRoot, evaluatedReportRunner(1));
      expectQualityGateBlocked(capsule, projection, sourceRoot);

      // A cached pass from the nonzero child would bypass this invalid second report.
      useEvaluationRunner(sourceRoot, minimalPassShapedRunner());
      expectQualityGateBlocked(capsule, projection, sourceRoot);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a zero-exit evaluator report has stale authority bindings", () => {
    const { capsule, projection } = explicitFixture();
    const sourceRoot = qualityGateRoot();
    try {
      useEvaluationRunner(
        sourceRoot,
        evaluatedReportRunner(0, 'report.authority.sha256 = "0".repeat(64);'),
      );
      expectQualityGateBlocked(capsule, projection, sourceRoot);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("authorizes only a zero-exit complete current evaluator report", () => {
    const { capsule, projection } = explicitFixture();
    const sourceRoot = qualityGateRoot();
    try {
      setGlossaryEvaluationRunnerForTest(SOURCE_BUILD_RUNNER);
      expect(decidePersonalGlossaryCandidate(receiptFor(capsule, projection), { sourceRoot })).toMatchObject({
        status: "automatic_admission",
        reason: "explicit_current_authorized",
        decision: { outcome: "automatic_admission" },
      });
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("keeps high-confidence inferred candidates and semantic uncertainty out of automatic admission", () => {
    const inferred = inferredFixture();
    expect(decidePersonalGlossaryCandidate(receiptFor(inferred.capsule, inferred.projection))).toMatchObject({
      status: "review_required",
      reason: "inferred_requires_review",
      decision: { outcome: "review_required" },
    });

    const { capsule, projection } = explicitFixture();
    for (const [overrides, expected] of [
      [{ scope: "ambiguous" }, "scope_ambiguous"],
      [{ scope: "project" }, "scope_project"],
      [{ consistency: "inconsistent", meaning: "a conflicting meaning" }, "classification_inconsistent"],
      [{ meaning: "a changed meaning" }, "classification_changed"],
    ] as Array<[Partial<GlossaryHostClassification>, string]>) {
      expect(decidePersonalGlossaryCandidate(receiptFor(capsule, projection, overrides))).toMatchObject({
        status: expected === "scope_project" ? "abstain" : "review_required",
        reason: expected,
      });
    }
  });

  it("queues a divergent same-identity candidate for review instead of overwriting it", () => {
    const { capsule } = explicitFixture();
    const conflicting = createGlossaryEvidenceCapsule({
      term: capsule.term,
      meaning: "a conflicting definition",
      scope: "personal",
      provenance_kind: "personal_explicit_definition",
      evidence: [{ source_id: "conflict-source", evidence_anchor: "conflict-anchor", signal_type: "correction" }],
      policy_version: capsule.policy_version,
      generation: capsule.generation,
    });
    const projection = persist([capsule, conflicting]);

    expect(decidePersonalGlossaryCandidate(receiptFor(capsule, projection))).toMatchObject({
      status: "review_required",
      reason: "entry_conflict",
      decision: { outcome: "review_required" },
    });
  });

  it("requires a current complete explicit anchor and detects retraction, generation changes, and changed projections", () => {
    const initial = explicitFixture();
    const receipt = receiptFor(initial.capsule, initial.projection);
    const changedProjection = persist([initial.capsule], "2026-08-11T00:00:00.000Z");
    expect(changedProjection.projection_sha256).not.toBe(initial.projection.projection_sha256);
    expect(decidePersonalGlossaryCandidate(receipt)).toMatchObject({
      status: "abstain",
      reason: "projection_changed",
      decision: null,
    });

    const changedEvidence = explicitFixture();
    publish([record("changed-source", "Actually, `ship shape` means a changed form.")]);
    expect(decidePersonalGlossaryCandidate(receiptFor(changedEvidence.capsule, changedEvidence.projection))).toMatchObject({
      status: "abstain",
      reason: "projection_stale",
      decision: null,
    });

    const retractedText = "Actually, `ship shape` means the complete form. That definition is no longer valid for ship shape.";
    publish([record("retracted-source", retractedText)]);
    const retractedCapsule = createGlossaryEvidenceCapsule({
      term: "ship shape",
      meaning: "the complete form",
      scope: "personal",
      provenance_kind: "personal_explicit_definition",
      evidence: [{ source_id: "retracted-source", evidence_anchor: "retracted-source", signal_type: "correction" }],
      policy_version: PERSONAL_GLOSSARY_MINING_POLICY_VERSION,
      generation: mineExplicitGlossaryCandidates({ tiersDir: tiersDir() }).generation!,
    });
    const retractedProjection = persist([retractedCapsule]);
    expect(decidePersonalGlossaryCandidate(receiptFor(retractedCapsule, retractedProjection))).toMatchObject({
      status: "review_required",
      reason: "evidence_retracted_or_conflicted",
      decision: { outcome: "review_required" },
    });
  });

  it("abstains when the only explicit anchor is not a complete user-authored current record", () => {
    publish([
      record(
        "agent-source",
        "Actually, `ship shape` means the complete form of a deliverable.",
        "agent",
      ),
    ]);
    const mined = mineExplicitGlossaryCandidates({ tiersDir: tiersDir() });
    expect(mined).toMatchObject({ state: "current", candidates: [] });
    const capsule = createGlossaryEvidenceCapsule({
      term: "ship shape",
      meaning: "the complete form of a deliverable",
      scope: "personal",
      provenance_kind: "personal_explicit_definition",
      evidence: [{ source_id: "agent-source", evidence_anchor: "agent-source", signal_type: "correction" }],
      policy_version: PERSONAL_GLOSSARY_MINING_POLICY_VERSION,
      generation: mined.generation!,
    });
    const projection = persist([capsule]);
    const projectionPath = personalGlossaryCandidateProjectionPath();
    const before = fs.readFileSync(projectionPath, "utf8");

    expect(decidePersonalGlossaryCandidate(receiptFor(capsule, projection))).toMatchObject({
      status: "abstain",
      reason: "evidence_changed",
      decision: { outcome: "abstain" },
      effects: [],
    });
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(before);
  });

  it("fails the explicit automatic path when the quality gate is not authorizing", () => {
    const { capsule, projection } = explicitFixture();
    const sourceRoot = failingQualityGateRoot();
    try {
      expect(decidePersonalGlossaryCandidate(receiptFor(capsule, projection), { sourceRoot })).toMatchObject({
        status: "review_required",
        reason: "quality_gate_not_authorizing",
        decision: { outcome: "review_required" },
      });
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed request envelopes before reading or changing local candidate state", () => {
    const result = run(
      ["report", "personal-glossary-decision", "--input", "-", "--format", "json"],
      JSON.stringify({ schema_version: "agentera.personalGlossaryAdmissionRequest.v1", receipt: [], extra: true }),
    );
    expect(result).toMatchObject({ rc: 2, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      status: "fail",
      error: { class: "schema_violation" },
    });
  });

  it.each(["stdin", "file"] as const)("accepts an exact 16,384-byte %s request without effects", (source) => {
    const { capsule, projection } = explicitFixture();
    const maxBytes = personalGlossaryCandidateDecisionContract().maxRequestUtf8Bytes;
    const input = requestAtByteLength(receiptFor(capsule, projection), maxBytes);
    expect(Buffer.byteLength(input, "utf8")).toBe(maxBytes);
    const before = noEffectSnapshot();
    const result = runRequest(source, input);

    expect(result).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({
      status: "automatic_admission",
      reason: "explicit_current_authorized",
      effects: [],
    });
    expectNoEffects(before);
  });

  it.each(["stdin", "file"] as const)("rejects a 16,385-byte %s request before effects", (source) => {
    const { capsule, projection } = explicitFixture();
    const maxBytes = personalGlossaryCandidateDecisionContract().maxRequestUtf8Bytes;
    const input = `${requestAtByteLength(receiptFor(capsule, projection), maxBytes)} `;
    expect(Buffer.byteLength(input, "utf8")).toBe(maxBytes + 1);
    const before = noEffectSnapshot();
    const result = runRequest(source, input);

    expect(result).toMatchObject({ rc: 2, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      error: { class: "invalid_format" },
    });
    expectNoEffects(before);
  });

  it("rejects a duplicate receipt mapping before effects", () => {
    const input = [
      "schema_version: agentera.personalGlossaryAdmissionRequest.v1",
      "receipt: {}",
      "receipt: {}",
      "",
    ].join("\n");
    const before = noEffectSnapshot();
    const result = runRequest("stdin", input);

    expect(result).toMatchObject({ rc: 2, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      error: { class: "invalid_format" },
    });
    expectNoEffects(before);
  });

  it("rejects an oversized file before opening or reading it", () => {
    const maxBytes = personalGlossaryCandidateDecisionContract().maxRequestUtf8Bytes;
    const input = " ".repeat(maxBytes + 1);
    const read = vi.spyOn(fs, "readSync");
    const open = vi.spyOn(fs, "openSync");
    try {
      const before = noEffectSnapshot();
      const result = runRequest("file", input);
      expect(result).toMatchObject({ rc: 2, err: "" });
      expect(read).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expectNoEffects(before);
    } finally {
      read.mockRestore();
      open.mockRestore();
    }
  });

  it("rejects decision input replaced by a symlink while it is opened", () => {
    const { capsule, projection } = explicitFixture();
    const input = path.join(profileDir, "decision-request.json");
    const original = path.join(profileDir, "original-decision-request.json");
    fs.writeFileSync(input, request(receiptFor(capsule, projection)));
    const before = noEffectSnapshot();
    const nativeOpen = fs.openSync;
    const open = vi.spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
      if (target === input) {
        fs.renameSync(input, original);
        fs.symlinkSync(original, input);
      }
      return nativeOpen(target, flags, mode);
    }) as typeof fs.openSync);
    try {
      const result = run([
        "report", "personal-glossary-decision", "--input", input, "--format", "json",
      ]);
      expect(result).toMatchObject({ rc: 2, err: "" });
      expect(JSON.parse(result.out)).toMatchObject({ error: { class: "invalid_format" } });
      expectNoEffects(before);
    } finally {
      open.mockRestore();
    }
  });

  it("returns a no-effect abstention for an unknown host receipt field", () => {
    const { capsule, projection } = explicitFixture();
    const receipt = reseal({
      ...receiptFor(capsule, projection),
      admission: "automatic_admission",
    });
    const projectionPath = personalGlossaryCandidateProjectionPath();
    const before = fs.readFileSync(projectionPath, "utf8");
    const result = run(
      ["report", "personal-glossary-decision", "--input", "-", "--format", "json"],
      request(receipt),
    );

    expect(result).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({
      status: "abstain",
      reason: "receipt_invalid",
      decision: null,
      effects: [],
    });
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(before);
  });
});

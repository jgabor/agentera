import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  personalGlossaryCandidateProjectionPath,
  persistPersonalGlossaryCandidateProjection,
  projectPersonalGlossaryCandidates,
  type PersonalGlossaryCandidateProjection,
} from "../../src/analytics/personalGlossaryCandidateProjection.js";
import {
  ADAPTER_VERSION,
  contentFingerprint,
  originIdentity,
} from "../../src/analytics/extractCorpus/core.js";
import { publishEvidenceTiers } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { mineExplicitGlossaryCandidates } from "../../src/analytics/personalGlossaryExplicitMining.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { main } from "../../src/cli/dispatch.js";
import { printReportHelp, printStateHelp } from "../../src/cli/help.js";
import { requiresCompletedEntityCutover } from "../../src/cli/migrationRequired.js";
import {
  createGlossaryAdmissionDecision,
  createGlossaryEvidenceCapsule,
  createGlossaryHostClassificationReceipt,
  type GlossaryAdmissionDecision,
  type GlossaryEvidenceCapsule,
  type GlossaryHostClassificationReceipt,
} from "../../src/registries/glossaryCandidateContracts.js";
import {
  canonicalGlossaryJson,
  glossaryCanonicalSha256,
} from "../../src/registries/glossaryTermIdentity.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const RETAINED_AT = "2026-08-10T00:00:00.000Z";
const AS_OF = "2026-08-10";
const BASE_PROFILE = "# Decision Profile: Publish Test\n\n## Process\n\nKeep these bytes exactly.\n";

let profileDir: string;
let previousProfileDir: string | undefined;
let previousProfileraProfileDir: string | undefined;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-publish-"));
  previousProfileDir = process.env.AGENTERA_PROFILE_DIR;
  previousProfileraProfileDir = process.env.PROFILERA_PROFILE_DIR;
  process.env.AGENTERA_PROFILE_DIR = profileDir;
  delete process.env.PROFILERA_PROFILE_DIR;
});

afterEach(() => {
  if (previousProfileDir === undefined) delete process.env.AGENTERA_PROFILE_DIR;
  else process.env.AGENTERA_PROFILE_DIR = previousProfileDir;
  if (previousProfileraProfileDir === undefined) delete process.env.PROFILERA_PROFILE_DIR;
  else process.env.PROFILERA_PROFILE_DIR = previousProfileraProfileDir;
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function profilePath(): string {
  return path.join(profileDir, "PROFILE.md");
}

function tiersDir(): string {
  return path.join(profileDir, "intermediate", "tiers");
}

function projectionPath(): string {
  return personalGlossaryCandidateProjectionPath();
}

function writeProfile(contents = BASE_PROFILE): void {
  fs.writeFileSync(profilePath(), contents, "utf8");
}

function record(sourceId: string, text: string, authorClass = "user"): Record<string, unknown> {
  return {
    source_id: sourceId,
    source_kind: "conversation_turn",
    timestamp: RETAINED_AT,
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

function publishEvidence(records: Array<Record<string, unknown>>): void {
  publishEvidenceTiers(records, {
    tiersDir: tiersDir(),
    adapterVersion: ADAPTER_VERSION,
    publishedAt: RETAINED_AT,
  });
}

function persist(capsules: readonly GlossaryEvidenceCapsule[]): PersonalGlossaryCandidateProjection {
  const projection = projectPersonalGlossaryCandidates({
    generation: capsules[0]!.generation,
    policy_version: capsules[0]!.policy_version,
    retained_at: RETAINED_AT,
    candidates: capsules.map((capsule, index) => ({
      capsule,
      project_ids: [`private-project-${index}`],
    })),
  });
  persistPersonalGlossaryCandidateProjection(projection);
  return projection;
}

function receiptFor(
  capsule: GlossaryEvidenceCapsule,
  projection: PersonalGlossaryCandidateProjection,
  overrides: Record<string, unknown> = {},
): GlossaryHostClassificationReceipt {
  return createGlossaryHostClassificationReceipt({
    capsule,
    candidate_projection_sha256: projection.projection_sha256,
    classification: {
      term: capsule.term,
      meaning: capsule.meaning,
      scope: capsule.scope,
      permanence: "durable",
      consistency: "consistent",
      confidence: 80,
      ...overrides,
    },
  });
}

function run(args: string[], stdin = ""): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], {
    stdin: () => stdin,
    out: (text) => { out += text; },
    err: (text) => { err += text; },
  });
  return { rc, out, err };
}

function cliDecision(receipt: GlossaryHostClassificationReceipt): GlossaryAdmissionDecision {
  const result = run(
    ["report", "personal-glossary-decision", "--input", "-", "--format", "json"],
    JSON.stringify({ schema_version: "agentera.personalGlossaryAdmissionRequest.v1", receipt }),
  );
  expect(result).toMatchObject({ rc: 0, err: "" });
  const output = JSON.parse(result.out);
  expect(output).toMatchObject({ status: "automatic_admission", reason: "explicit_current_authorized" });
  return output.decision as GlossaryAdmissionDecision;
}

function publicationRequest(
  receipt: GlossaryHostClassificationReceipt,
  decision: GlossaryAdmissionDecision,
  asOf = AS_OF,
): Record<string, unknown> {
  return {
    schema_version: "agentera.personalGlossaryPublishRequest.v1",
    receipt,
    decision,
    as_of: asOf,
  };
}

function publishRequest(request: Record<string, unknown>, dryRun = false): { rc: number; out: string; err: string } {
  return run(
    [
      "report",
      "personal-glossary-publish",
      "--input",
      "-",
      ...(dryRun ? ["--dry-run"] : []),
      "--format",
      "json",
    ],
    JSON.stringify(request),
  );
}

function section(): Record<string, any> {
  const profile = fs.readFileSync(profilePath(), "utf8");
  const match = /<!-- agentera:personal-glossary:start -->\n## Glossary\n\n```json\n([\s\S]*?)\n```\n<!-- agentera:personal-glossary:end -->/.exec(profile);
  if (!match) throw new Error("owned glossary section is missing");
  return JSON.parse(match[1]);
}

function bytes(file: string): Buffer | null {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function mode(file: string): number | null {
  return fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : null;
}

function noEffectSnapshot(): { profile: Buffer | null; profileMode: number | null; projection: Buffer | null } {
  return { profile: bytes(profilePath()), profileMode: mode(profilePath()), projection: bytes(projectionPath()) };
}

function expectNoEffects(before: ReturnType<typeof noEffectSnapshot>): void {
  expect(bytes(profilePath())).toEqual(before.profile);
  expect(mode(profilePath())).toBe(before.profileMode);
  expect(bytes(projectionPath())).toEqual(before.projection);
}

function authorizedFixture(
  text = "Actually, `ship shape` means the complete form of a deliverable.",
): {
  capsule: GlossaryEvidenceCapsule;
  projection: PersonalGlossaryCandidateProjection;
  receipt: GlossaryHostClassificationReceipt;
  decision: GlossaryAdmissionDecision;
} {
  writeProfile();
  publishEvidence([record("explicit-source", text)]);
  const mined = mineExplicitGlossaryCandidates({ tiersDir: tiersDir() });
  expect(mined).toMatchObject({ state: "current" });
  expect(mined.candidates).toHaveLength(1);
  const capsule = mined.candidates[0]!.capsule;
  const projection = persist([capsule]);
  const receipt = receiptFor(capsule, projection);
  return { capsule, projection, receipt, decision: cliDecision(receipt) };
}

function resealReceipt(value: Record<string, unknown>): Record<string, unknown> {
  const { receipt_sha256: _receiptSha256, ...body } = value;
  return { ...body, receipt_sha256: glossaryCanonicalSha256(body) };
}

function resealDecision(value: Record<string, unknown>): Record<string, unknown> {
  const { decision_sha256: _decisionSha256, ...body } = value;
  return { ...body, decision_sha256: glossaryCanonicalSha256(body) };
}

function forcedAutomaticDecision(
  capsule: GlossaryEvidenceCapsule,
  receipt: GlossaryHostClassificationReceipt,
): GlossaryAdmissionDecision {
  const body = {
    schema_version: "agentera.personalGlossaryAdmissionDecision.v1",
    owner: "deterministic_cli_admission_validation",
    candidate_id: capsule.candidate_id,
    candidate_revision: capsule.candidate_revision,
    candidate_capsule_sha256: capsule.capsule_sha256,
    candidate_projection_sha256: receipt.candidate_projection_sha256,
    host_receipt_sha256: receipt.receipt_sha256,
    classification_contract_version: receipt.schema_version,
    semantic_fingerprint: receipt.semantic_fingerprint,
    generation: capsule.generation,
    policy_version: capsule.policy_version,
    outcome: "automatic_admission",
    reason: "explicit_current_authorized",
  };
  return { ...body, decision_sha256: glossaryCanonicalSha256(body) } as GlossaryAdmissionDecision;
}

describe("agentera report personal-glossary-publish", () => {
  it("makes one bounded personal publication grammar canonical without changing project grammar", () => {
    const help = printReportHelp();
    const schema = (buildSchemaPayload().integration as any).personal_glossary;

    expect(help).toContain("agentera report personal-glossary-publish --input <file|-> [--dry-run] --format json");
    expect(help).not.toContain("report profile-glossary");
    expect(schema).toMatchObject({
      command: "agentera report personal-glossary-publish",
      request_schema_version: "agentera.personalGlossaryPublishRequest.v1",
      request_fields: ["schema_version", "receipt", "decision", "as_of"],
      max_request_utf8_bytes: 16_384,
      result_schema_version: "agentera.personalGlossaryPublicationResult.v1",
      output_statuses: ["changed", "unchanged_replay", "dry_run_candidate"],
      project_checkout: "not_required",
    });
    expect(requiresCompletedEntityCutover(["report", "personal-glossary-publish"])).toBe(false);
    expect(printStateHelp("glossary")).toContain("agentera state glossary publish --input REQUEST.yaml");

    writeProfile();
    const old = run(["report", "profile-glossary", "--input", "-", "--format", "json"], "{}");
    expect(old.rc).not.toBe(0);
    expect(fs.readFileSync(profilePath(), "utf8")).toBe(BASE_PROFILE);
  });

  it("publishes one authorized explicit decision, preserves non-owned bytes, and exactly replays", () => {
    const { receipt, decision } = authorizedFixture();
    const before = fs.readFileSync(profilePath(), "utf8");
    const request = publicationRequest(receipt, decision);

    const first = publishRequest(request);
    expect(first).toMatchObject({ rc: 0, err: "" });
    const firstResult = JSON.parse(first.out);
    expect(firstResult).toMatchObject({
      schema_version: "agentera.personalGlossaryPublicationResult.v1",
      owner: "personal_profile_publication",
      status: "changed",
      candidate_id: receipt.candidate_id,
      decision_sha256: decision.decision_sha256,
      review_record_sha256: null,
      published_at: "2026-08-10T00:00:00.000Z",
    });
    for (const sensitive of ["ship shape", "complete form", "explicit-source", "private-project", profilePath()]) {
      expect(first.out).not.toContain(sensitive);
    }
    const changed = fs.readFileSync(profilePath(), "utf8");
    expect(changed.startsWith(before)).toBe(true);
    expect(section()).toMatchObject({
      schema_version: "agentera.personalGlossarySection.v1",
      as_of: AS_OF,
      entries: [{ term: "ship shape", meaning: "the complete form of a deliverable", confidence: 80 }],
    });

    const replay = publishRequest(request);
    expect(replay).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(replay.out)).toMatchObject({ status: "unchanged_replay" });
    expect(fs.readFileSync(profilePath(), "utf8")).toBe(changed);
  });

  it("preserves an existing restrictive profile mode across publication", () => {
    const { receipt, decision } = authorizedFixture();
    fs.chmodSync(profilePath(), 0o600);

    expect(publishRequest(publicationRequest(receipt, decision))).toMatchObject({ rc: 0, err: "" });

    expect(fs.statSync(profilePath()).mode & 0o777).toBe(0o600);
  });

  it("uses the injected date deterministically and dry-runs without a write", () => {
    const { receipt, decision } = authorizedFixture();
    const request = publicationRequest(receipt, decision);
    const before = noEffectSnapshot();
    const dryRun = publishRequest(request, true);
    expect(dryRun).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(dryRun.out)).toMatchObject({ status: "dry_run_candidate", published_at: null });
    expectNoEffects(before);

    expect(publishRequest(request)).toMatchObject({ rc: 0 });
    const later = publicationRequest(receipt, decision, "2026-08-11");
    expect(publishRequest(later)).toMatchObject({ rc: 0 });
    expect(section()).toMatchObject({ as_of: "2026-08-11", entries: [{ temporal: { last_confirmed_at: "2026-08-11" } }] });
    const bytesAfterLater = fs.readFileSync(profilePath(), "utf8");
    expect(JSON.parse(publishRequest(later).out)).toMatchObject({ status: "unchanged_replay" });
    expect(fs.readFileSync(profilePath(), "utf8")).toBe(bytesAfterLater);
  });

  it("adds and refreshes authorized entries in deterministic Unicode order", () => {
    writeProfile();
    publishEvidence([
      record("zeta", "Actually, `zeta term` means the final value."),
      record("alpha", "Actually, `alpha term` means the initial value."),
      record("accent-a", "Actually, `café` means the composed value."),
      record("accent-b", "Actually, `café` means the decomposed value."),
    ]);
    const mined = mineExplicitGlossaryCandidates({ tiersDir: tiersDir() });
    expect(mined.candidates).toHaveLength(4);
    const projection = persist(mined.candidates.map((candidate) => candidate.capsule));
    const authorized = mined.candidates.map(({ capsule }) => {
      const receipt = receiptFor(capsule, projection);
      return { receipt, decision: cliDecision(receipt) };
    });
    for (const item of authorized) expect(publishRequest(publicationRequest(item.receipt, item.decision))).toMatchObject({ rc: 0 });

    const entries = section().entries as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry.term)).toEqual(["alpha term", "café", "café", "zeta term"]);
    expect(new Set(entries.map((entry) => entry.term))).toHaveLength(4);

    const zeta = authorized.find((item) => item.receipt.classification.term === "zeta term")!;
    const refreshed = publicationRequest(zeta.receipt, zeta.decision, "2026-08-11");
    expect(publishRequest(refreshed)).toMatchObject({ rc: 0 });
    expect(section().entries.find((entry: any) => entry.term === "zeta term")).toMatchObject({
      temporal: { observed_at: AS_OF, last_confirmed_at: "2026-08-11" },
    });
  });

  it("rejects a changed meaning that conflicts with an established profile entry before effects", () => {
    const first = authorizedFixture();
    expect(publishRequest(publicationRequest(first.receipt, first.decision))).toMatchObject({ rc: 0 });
    publishEvidence([record("changed", "Actually, `ship shape` means an incompatible form.")]);
    const mined = mineExplicitGlossaryCandidates({ tiersDir: tiersDir() });
    const capsule = mined.candidates[0]!.capsule;
    const projection = persist([capsule]);
    const receipt = receiptFor(capsule, projection);
    const decision = cliDecision(receipt);
    const before = noEffectSnapshot();

    const result = publishRequest(publicationRequest(receipt, decision));
    expect(result).toMatchObject({ rc: 1, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({ error: { class: "profile_unavailable" } });
    expectNoEffects(before);
  });

  it.each([
    ["receipt candidate_id", (request: any) => { request.receipt.candidate_id = "0".repeat(64); }],
    ["receipt candidate_revision", (request: any) => { request.receipt.candidate_revision = "1".repeat(64); }],
    ["receipt capsule", (request: any) => { request.receipt.candidate_capsule_sha256 = "2".repeat(64); }],
    ["receipt projection", (request: any) => { request.receipt.candidate_projection_sha256 = "3".repeat(64); }],
    ["receipt generation", (request: any) => { request.receipt.generation = "stale-generation"; }],
    ["receipt policy", (request: any) => { request.receipt.policy_version = "stale-policy"; }],
    ["receipt semantic fingerprint", (request: any) => { request.receipt.semantic_fingerprint = "4".repeat(64); }],
    ["decision candidate_id", (request: any) => { request.decision.candidate_id = "5".repeat(64); request.decision = resealDecision(request.decision); }],
    ["decision candidate_revision", (request: any) => { request.decision.candidate_revision = "6".repeat(64); request.decision = resealDecision(request.decision); }],
    ["decision capsule", (request: any) => { request.decision.candidate_capsule_sha256 = "a".repeat(64); request.decision = resealDecision(request.decision); }],
    ["decision projection", (request: any) => { request.decision.candidate_projection_sha256 = "7".repeat(64); request.decision = resealDecision(request.decision); }],
    ["decision receipt", (request: any) => { request.decision.host_receipt_sha256 = "8".repeat(64); request.decision = resealDecision(request.decision); }],
    ["decision classification contract", (request: any) => { request.decision.classification_contract_version = "agentera.personalGlossaryHostClassificationReceipt.v9"; request.decision = resealDecision(request.decision); }],
    ["decision semantic fingerprint", (request: any) => { request.decision.semantic_fingerprint = "9".repeat(64); request.decision = resealDecision(request.decision); }],
    ["decision generation", (request: any) => { request.decision.generation = "stale-generation"; request.decision = resealDecision(request.decision); }],
    ["decision policy", (request: any) => { request.decision.policy_version = "stale-policy"; request.decision = resealDecision(request.decision); }],
  ])("fails stale %s before effects", (_name, mutate) => {
    const { receipt, decision } = authorizedFixture();
    const request = structuredClone(publicationRequest(receipt, decision)) as any;
    const before = noEffectSnapshot();
    mutate(request);

    const result = publishRequest(request);
    expect(result).toMatchObject({ rc: 1, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({ error: { class: "publication_not_authorized" } });
    expectNoEffects(before);
  });

  it.each([
    ["changed meaning", (request: any) => {
      request.receipt.classification.meaning = "changed semantic meaning";
      request.receipt = resealReceipt(request.receipt);
    }],
    ["invalid scope", (request: any) => {
      request.receipt.classification.scope = "project";
      request.receipt = resealReceipt(request.receipt);
    }],
    ["unknown receipt field", (request: any) => { request.receipt.unexpected = true; }],
    ["unknown decision field", (request: any) => { request.decision.unexpected = true; }],
  ])("fails %s before effects", (_name, mutate) => {
    const { receipt, decision } = authorizedFixture();
    const request = structuredClone(publicationRequest(receipt, decision)) as any;
    const before = noEffectSnapshot();
    mutate(request);

    const result = publishRequest(request);
    expect(result.rc).toBe(1);
    expectNoEffects(before);
  });

  it("revalidates changed anchors, retraction, unresolved evidence, secret projections, and inferred automatic admission", () => {
    const changed = authorizedFixture();
    const changedBefore = noEffectSnapshot();
    publishEvidence([record("new-anchor", "Actually, `ship shape` means the complete form of a deliverable.")]);
    expect(publishRequest(publicationRequest(changed.receipt, changed.decision)).rc).toBe(1);
    expectNoEffects(changedBefore);

    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.mkdirSync(profileDir, { recursive: true });
    writeProfile();
    const retractedText = "Actually, `ship shape` means the complete form. That definition is no longer valid for ship shape.";
    publishEvidence([record("retracted", retractedText)]);
    const retractedMined = mineExplicitGlossaryCandidates({ tiersDir: tiersDir() });
    const retractedCapsule = createGlossaryEvidenceCapsule({
      term: "ship shape",
      meaning: "the complete form",
      scope: "personal",
      provenance_kind: "personal_explicit_definition",
      evidence: [{ source_id: "retracted", evidence_anchor: "retracted", signal_type: "correction" }],
      policy_version: "agentera.personalGlossaryMiningPolicy.v1",
      generation: retractedMined.generation!,
    });
    const retractedProjection = persist([retractedCapsule]);
    const retractedReceipt = receiptFor(retractedCapsule, retractedProjection);
    const retractedDecision = createGlossaryAdmissionDecision({
      capsule: retractedCapsule,
      receipt: retractedReceipt,
      outcome: "automatic_admission",
      reason: "explicit_current_authorized",
    });
    const retractedBefore = noEffectSnapshot();
    expect(publishRequest(publicationRequest(retractedReceipt, retractedDecision)).rc).toBe(1);
    expectNoEffects(retractedBefore);

    const unresolvedCapsule = createGlossaryEvidenceCapsule({
      term: "unresolved term",
      meaning: "an unresolved meaning",
      scope: "personal",
      provenance_kind: "personal_explicit_definition",
      evidence: [{ source_id: "missing-source", evidence_anchor: "missing-anchor", signal_type: "correction" }],
      policy_version: "agentera.personalGlossaryMiningPolicy.v1",
      generation: retractedMined.generation!,
    });
    const unresolvedProjection = persist([unresolvedCapsule]);
    const unresolvedReceipt = receiptFor(unresolvedCapsule, unresolvedProjection);
    const unresolvedDecision = createGlossaryAdmissionDecision({
      capsule: unresolvedCapsule,
      receipt: unresolvedReceipt,
      outcome: "automatic_admission",
      reason: "explicit_current_authorized",
    });
    const unresolvedBefore = noEffectSnapshot();
    expect(publishRequest(publicationRequest(unresolvedReceipt, unresolvedDecision)).rc).toBe(1);
    expectNoEffects(unresolvedBefore);

    const inferredCapsule = createGlossaryEvidenceCapsule({
      term: "inferred term",
      meaning: "an inferred meaning",
      scope: "personal",
      provenance_kind: "personal_inferred_usage",
      evidence: [
        { source_id: "inferred-a", evidence_anchor: "inferred-a", source_kind: "instruction_document" },
        { source_id: "inferred-b", evidence_anchor: "inferred-b", source_kind: "project_config_signal" },
      ],
      policy_version: "agentera.personalGlossaryMiningPolicy.v1",
      generation: retractedMined.generation!,
    });
    const inferredProjection = persist([inferredCapsule]);
    const inferredReceipt = receiptFor(inferredCapsule, inferredProjection);
    const inferredDecision = forcedAutomaticDecision(inferredCapsule, inferredReceipt);
    const inferredBefore = noEffectSnapshot();
    expect(publishRequest(publicationRequest(inferredReceipt, inferredDecision)).rc).toBe(1);
    expectNoEffects(inferredBefore);

    const secret = "AuthToken_987654321";
    const corrupt = JSON.parse(fs.readFileSync(projectionPath(), "utf8"));
    corrupt.candidates[0].capsule.meaning = `Authorization: Bearer ${secret}`;
    const { capsule_sha256: _digest, ...capsuleBody } = corrupt.candidates[0].capsule;
    corrupt.candidates[0].capsule.capsule_sha256 = glossaryCanonicalSha256(capsuleBody);
    const { projection_sha256: _projectionDigest, ...projectionBody } = corrupt;
    corrupt.projection_sha256 = glossaryCanonicalSha256(projectionBody);
    fs.writeFileSync(projectionPath(), `${canonicalGlossaryJson(corrupt)}\n`);
    const secretBefore = noEffectSnapshot();
    const secretResult = publishRequest(publicationRequest(inferredReceipt, inferredDecision));
    expect(secretResult.rc).toBe(1);
    expect(secretResult.out).not.toContain(secret);
    expectNoEffects(secretBefore);
  });

  it.each([
    ["not a mapping", "[]"],
    ["invalid JSON", "{"],
    ["unknown request field", JSON.stringify({ schema_version: "agentera.personalGlossaryPublishRequest.v1", receipt: {}, decision: {}, as_of: AS_OF, unexpected: true })],
  ])("rejects malformed %s before effects", (_name, stdin) => {
    writeProfile();
    const before = noEffectSnapshot();
    const result = run(["report", "personal-glossary-publish", "--input", "-", "--format", "json"], stdin);
    expect(result.rc).toBe(2);
    expectNoEffects(before);
  });

  it("rejects missing and malformed profile targets or boundaries before effects", () => {
    const { receipt, decision } = authorizedFixture();
    fs.rmSync(profilePath());
    const missing = noEffectSnapshot();
    expect(publishRequest(publicationRequest(receipt, decision)).rc).toBe(1);
    expectNoEffects(missing);

    for (const malformed of [
      "# Profile\n\n## Glossary\nmanual\n",
      "# Profile\n\n<!-- agentera:personal-glossary:start -->\n## Glossary\n",
      "# Profile\n\n<!-- agentera:personal-glossary:start -->\n## Glossary\n\n```json\n{}\n```\n<!-- agentera:personal-glossary:end -->\n",
      "# Profile\n\n<!-- agentera:personal-glossary:start -->\n## Glossary\n\n```json\n{}\n```\n<!-- agentera:personal-glossary:end -->\n<!-- agentera:personal-glossary:start -->\n",
    ]) {
      fs.writeFileSync(profilePath(), malformed);
      const before = noEffectSnapshot();
      expect(publishRequest(publicationRequest(receipt, decision)).rc).toBe(1);
      expectNoEffects(before);
    }
  });

  it("replaces only the owned profile section and leaves native atomic failures unchanged", () => {
    const { receipt, decision } = authorizedFixture();
    expect(publishRequest(publicationRequest(receipt, decision)).rc).toBe(0);
    const original = fs.readFileSync(profilePath(), "utf8");
    fs.writeFileSync(profilePath(), `before-owned-bytes\n${original}after-owned-bytes\n`);
    const projectState = path.join(profileDir, "project-glossary-trap.yaml");
    fs.writeFileSync(projectState, "keep: unchanged\n");

    expect(publishRequest(publicationRequest(receipt, decision, "2026-08-11")).rc).toBe(0);
    const changed = fs.readFileSync(profilePath(), "utf8");
    expect(changed.startsWith("before-owned-bytes\n")).toBe(true);
    expect(changed.endsWith("after-owned-bytes\n")).toBe(true);
    expect(fs.readFileSync(projectState, "utf8")).toBe("keep: unchanged\n");

    const beforeAtomic = noEffectSnapshot();
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("native rename failure");
    });
    try {
      const result = publishRequest(publicationRequest(receipt, decision, "2026-08-12"));
      expect(result).toMatchObject({ rc: 1, err: "" });
      expectNoEffects(beforeAtomic);
    } finally {
      rename.mockRestore();
    }
  });

  it("bounds input and has no interactive or sensitive output path", () => {
    writeProfile();
    const before = noEffectSnapshot();
    const overBound = run(
      ["report", "personal-glossary-publish", "--input", "-", "--format", "json"],
      "x".repeat(16_385),
    );
    expect(overBound.rc).toBe(2);
    expectNoEffects(before);

    const source = fs.readFileSync(path.join(ROOT, "packages/cli/src/cli/commands/personalGlossaryPublish.ts"), "utf8");
    expect(source).toContain("Buffer.allocUnsafe(maxBytes + 1)");
    expect(source).toContain("fs.readSync(fd");
    expect(source).not.toContain("readline");
    expect(source).not.toContain("prompt(");
  });
});

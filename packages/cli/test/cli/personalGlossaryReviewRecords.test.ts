import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  personalGlossaryReviewRecordsPath,
  personalGlossaryTrustedLocalHostPath,
  type PersonalGlossaryReviewRecord,
} from "../../src/analytics/personalGlossaryReviewRecords.js";
import {
  personalGlossaryCandidateProjectionPath,
  persistPersonalGlossaryCandidateProjection,
  projectPersonalGlossaryCandidates,
  type PersonalGlossaryCandidateProjection,
} from "../../src/analytics/personalGlossaryCandidateProjection.js";
import { ADAPTER_VERSION, contentFingerprint, originIdentity } from "../../src/analytics/extractCorpus/core.js";
import { publishEvidenceTiers } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { main } from "../../src/cli/dispatch.js";
import { printReportHelp } from "../../src/cli/help.js";
import { requiresCompletedEntityCutover } from "../../src/cli/migrationRequired.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import {
  createGlossaryEvidenceCapsule,
  createGlossaryHostClassificationReceipt,
  type GlossaryEvidenceCapsule,
} from "../../src/registries/glossaryCandidateContracts.js";
import { canonicalGlossaryJson, glossaryCanonicalSha256 } from "../../src/registries/glossaryTermIdentity.js";

const POLICY = "agentera.personalGlossaryMiningPolicy.v1";
const RETAINED_AT = "2026-08-10T00:00:00.000Z";
const REVIEW_SUBJECT = "user:current";
const REVIEW_KEY_PAIR = generateKeyPairSync("ed25519");

let profileDir: string;
let generation: string;
let previousProfileDir: string | undefined;
let previousProfileraProfileDir: string | undefined;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-review-cli-"));
  previousProfileDir = process.env.AGENTERA_PROFILE_DIR;
  previousProfileraProfileDir = process.env.PROFILERA_PROFILE_DIR;
  process.env.AGENTERA_PROFILE_DIR = profileDir;
  delete process.env.PROFILERA_PROFILE_DIR;
  generation = publishCurrentTier();
});

function publishCurrentTier(seed = "initial"): string {
  const text = `review tier generation ${seed}`;
  return publishEvidenceTiers([{
    source_id: `review-tier-source-${seed}`,
    source_kind: "conversation_turn",
    timestamp: RETAINED_AT,
    project_id: "private-review-tier",
    runtime: "opencode",
    source_class: "active_runtime",
    source_product: "opencode",
    active_runtime: true,
    adapter_version: ADAPTER_VERSION,
    data: { actor: "user", signal_type: "decision", text },
    origin_id: originIdentity(`review-tier-source-${seed}`),
    content_fingerprint: contentFingerprint(text),
    session_id: `review-tier-session-${seed}`,
    conversation_key: `review-tier-session-${seed}`,
    author_class: "user",
  }], {
    tiersDir: path.join(profileDir, "intermediate", "tiers"),
    adapterVersion: ADAPTER_VERSION,
    publishedAt: RETAINED_AT,
  }).generation;
}

afterEach(() => {
  if (previousProfileDir === undefined) delete process.env.AGENTERA_PROFILE_DIR;
  else process.env.AGENTERA_PROFILE_DIR = previousProfileDir;
  if (previousProfileraProfileDir === undefined) delete process.env.PROFILERA_PROFILE_DIR;
  else process.env.PROFILERA_PROFILE_DIR = previousProfileraProfileDir;
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function candidate(
  index: number,
  candidateGeneration = generation,
  policyVersion = POLICY,
): GlossaryEvidenceCapsule {
  return createGlossaryEvidenceCapsule({
    term: `private CLI review term ${index}`,
    meaning: `private CLI review meaning ${index}`,
    scope: "personal",
    provenance_kind: "personal_inferred_usage",
    evidence: [
      {
        source_id: `source-cli-private-${index}-a`,
        evidence_anchor: `anchor-cli-private-${index}-a`,
        source_kind: "instruction_document",
      },
      {
        source_id: `source-cli-private-${index}-b`,
        evidence_anchor: `anchor-cli-private-${index}-b`,
        source_kind: "project_config_signal",
      },
    ],
    generation: candidateGeneration,
    policy_version: policyVersion,
  });
}

function persist(candidates: readonly GlossaryEvidenceCapsule[]): PersonalGlossaryCandidateProjection {
  const projection = projectPersonalGlossaryCandidates({
    generation: candidates[0]!.generation,
    policy_version: candidates[0]!.policy_version,
    retained_at: RETAINED_AT,
    candidates: candidates.map((capsule, index) => ({
      capsule,
      project_ids: [`project-cli-private-${index}`],
      excerpts: [`${capsule.term} has a safe candidate excerpt.`],
    })),
  });
  persistPersonalGlossaryCandidateProjection(projection);
  return projection;
}

function receipt(capsule: GlossaryEvidenceCapsule, projection: PersonalGlossaryCandidateProjection) {
  return createGlossaryHostClassificationReceipt({
    capsule,
    candidate_projection_sha256: projection.projection_sha256,
    classification: {
      term: capsule.term,
      meaning: capsule.meaning,
      scope: capsule.scope,
      permanence: "durable",
      consistency: "inconsistent",
      confidence: 81,
    },
  });
}

function request(value: unknown): string {
  return JSON.stringify({
    schema_version: "agentera.personalGlossaryReviewQueueRequest.v1",
    receipt: value,
  });
}

function run(argv: string[], stdin?: string): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...argv], {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
    stdin: () => stdin ?? "",
  });
  return { rc, out, err };
}

function queue(capsule: GlossaryEvidenceCapsule, projection: PersonalGlossaryCandidateProjection) {
  const result = run(
    ["report", "personal-glossary-reviews", "queue", "--input", "-", "--format", "json"],
    request(receipt(capsule, projection)),
  );
  expect(result, result.out).toMatchObject({ rc: 0, err: "" });
  expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(4_096);
  return JSON.parse(result.out) as { record: PersonalGlossaryReviewRecord; status: string };
}

function writeTrustedHost(): void {
  const pathname = personalGlossaryTrustedLocalHostPath();
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const host = {
    owner: "current_user",
    public_key_spki_base64url: REVIEW_KEY_PAIR.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
    schema_version: "agentera.personalGlossaryTrustedLocalHost.v1",
    subject: REVIEW_SUBJECT,
  };
  fs.writeFileSync(pathname, `${canonicalGlossaryJson(host)}\n`, { encoding: "utf8", mode: 0o600 });
}

function approval(
  record: PersonalGlossaryReviewRecord,
  disposition: "accept" | "correct" | "reject" | "defer",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { signature: signatureOverride, ...fields } = overrides;
  const disposedAt = new Date(Math.max(Date.parse(record.queued_at), Date.now() - 100)).toISOString();
  const unsigned = {
    schema_version: "agentera.personalGlossaryReviewApproval.v1",
    issuer: "agentera-local-host",
    subject: REVIEW_SUBJECT,
    trusted_channel: "agentera-local-host-ipc",
    review_id: record.review_id,
    candidate_id: record.candidate_id,
    candidate_revision: record.candidate_revision,
    candidate_projection_sha256: record.candidate_projection_sha256,
    semantic_fingerprint: record.semantic_fingerprint,
    generation: record.generation,
    policy_version: record.policy_version,
    disposition,
    corrected_meaning: disposition === "correct" ? "A corrected private meaning." : null,
    corrected_scope: disposition === "correct" ? "personal" : null,
    disposed_at: disposedAt,
    expires_at: new Date(Date.parse(disposedAt) + 299_000).toISOString(),
    nonce: `review-cli-nonce-${record.review_id.slice(0, 12)}`,
    ...fields,
  };
  return {
    ...unsigned,
    signature: signatureOverride ?? sign(
      null,
      Buffer.from(JSON.stringify(unsigned), "utf8"),
      REVIEW_KEY_PAIR.privateKey,
    ).toString("base64url"),
  };
}

function dispositionRequest(
  review: PersonalGlossaryReviewRecord,
  hostReceipt: unknown,
  signedApproval: unknown,
): string {
  return JSON.stringify({
    schema_version: "agentera.personalGlossaryReviewDispositionRequest.v1",
    review_id: review.review_id,
    receipt: hostReceipt,
    approval: signedApproval,
  });
}

function exactArgs(record: PersonalGlossaryReviewRecord, overrides: Partial<Record<string, string>> = {}): string[] {
  const values = {
    reviewId: record.review_id,
    candidateId: record.candidate_id,
    candidateRevision: record.candidate_revision,
    generation: record.generation,
    policyVersion: record.policy_version,
    ...overrides,
  };
  return [
    "report",
    "personal-glossary-reviews",
    "get",
    "--review-id",
    values.reviewId,
    "--candidate-id",
    values.candidateId,
    "--candidate-revision",
    values.candidateRevision,
    "--generation",
    values.generation,
    "--policy-version",
    values.policyVersion,
    "--format",
    "json",
  ];
}

function writeLegacyStore(record: PersonalGlossaryReviewRecord): string {
  const pending = {
    schema_version: "agentera.personalGlossaryPendingReviewRecord.v1",
    owner: "current_user",
    review_id: record.review_id,
    candidate_id: record.candidate_id,
    candidate_revision: record.candidate_revision,
    candidate_capsule_sha256: record.candidate_capsule_sha256,
    candidate_projection_sha256: record.candidate_projection_sha256,
    host_receipt_sha256: record.host_receipt_sha256,
    cli_decision_sha256: record.cli_decision_sha256,
    semantic_fingerprint: record.semantic_fingerprint,
    generation: record.generation,
    policy_version: record.policy_version,
    reason: record.reason,
    status: "pending",
    queued_at: record.queued_at,
    terminal_at: null,
    expires_at: null,
  };
  const legacyRecord = { ...pending, record_sha256: glossaryCanonicalSha256(pending) };
  const body = {
    schema_version: "agentera.personalGlossaryReviewStore.v1",
    owner: "current_user",
    records: [legacyRecord],
  };
  const bytes = `${canonicalGlossaryJson({ ...body, store_sha256: glossaryCanonicalSha256(body) })}\n`;
  fs.writeFileSync(personalGlossaryReviewRecordsPath(), bytes, { encoding: "utf8", mode: 0o600 });
  return bytes;
}

describe("agentera report personal-glossary-reviews", () => {
  it("documents private queue/list/get grammar, schema, and no-cutover access", () => {
    const help = printReportHelp();
    expect(help).toContain("personal-glossary-reviews queue --input <file|-> --format json");
    expect(help).toContain("personal-glossary-reviews disposition --input <file|-> --format json");
    expect(help).toContain("personal-glossary-reviews list [--status pending|terminal]");
    expect(help).toContain("fresh signed current-user");
    expect(requiresCompletedEntityCutover(["report", "personal-glossary-reviews", "list"])).toBe(false);
    expect((buildSchemaPayload().integration as any).personal_glossary.review_records).toMatchObject({
      command: "agentera report personal-glossary-reviews",
      queue: {
        request_schema_version: "agentera.personalGlossaryReviewQueueRequest.v1",
        decision_outcome: "review_required",
        statuses: ["queued", "unchanged_replay", "suppressed", "reopened"],
      },
      disposition: {
        request_schema_version: "agentera.personalGlossaryReviewDispositionRequest.v1",
        statuses: ["disposed", "unchanged_replay"],
        publication_authorization: {
          dispositions: ["accept", "correct"],
          fields: ["review_id", "review_record_sha256"],
        },
      },
      persistence: {
        owner: "current_user",
        file: "review-records.json",
        records_max: 100,
        compatibility: {
          accepted_store_schema_versions: ["agentera.personalGlossaryReviewStore.v1", "agentera.personalGlossaryReviewStore.v2"],
          read_mutation: "forbidden",
          migration_operation: "disposition_only",
        },
      },
      retrieval: {
        owner: "current_user",
        list: { default_limit: 20, maximum_limit: 50, statuses: ["pending", "terminal"] },
      },
      maintenance: {
        terminal_metadata_days: 90,
        forbidden_effects: ["profile_entry", "project_state", "candidate_projection", "publication"],
      },
    });
  });

  it("lists and gets a canonical v1 record without changing it", () => {
    const capsule = candidate(3);
    const projection = persist([capsule]);
    const queued = queue(capsule, projection);
    const bytes = writeLegacyStore(queued.record);

    const listed = run(["report", "personal-glossary-reviews", "list", "--format", "json"]);
    expect(listed).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(listed.out)).toMatchObject({
      status: "ok",
      entries: [{ review_id: queued.record.review_id, scope: null, disposition: null }],
    });
    const exact = run(exactArgs(queued.record));
    expect(exact).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(exact.out)).toMatchObject({ record: { review_id: queued.record.review_id, scope: null } });
    expect(fs.readFileSync(personalGlossaryReviewRecordsPath(), "utf8")).toBe(bytes);
  });

  it("queues a review-required receipt without a question channel or unrelated mutation", () => {
    const capsule = candidate(1);
    const projection = persist([capsule]);
    const profilePath = path.join(profileDir, "PROFILE.md");
    fs.writeFileSync(profilePath, "profile bytes before queue\n", "utf8");
    const projectionPath = personalGlossaryCandidateProjectionPath();
    const projectionBefore = fs.readFileSync(projectionPath, "utf8");
    const profileBefore = fs.readFileSync(profilePath, "utf8");

    const result = run(
      ["report", "personal-glossary-reviews", "queue", "--input", "-", "--format", "json"],
      request(receipt(capsule, projection)),
    );
    expect(result).toMatchObject({ rc: 0, err: "" });
    const output = JSON.parse(result.out);
    expect(output).toMatchObject({
      schemaVersion: "agentera.personalGlossaryReviewQueueResult.v1",
      status: "queued",
      owner: "current_user",
      reason: "classification_inconsistent",
      effects: {
        review_metadata: "created",
        profile_entry: "unchanged",
        project_state: "unchanged",
        candidate_projection: "unchanged",
        publication: "unchanged",
      },
    });
    expect(result.out).not.toContain(capsule.term);
    expect(result.out).not.toContain(capsule.meaning);
    expect(result.out).not.toMatch(/source-cli-private|anchor-cli-private|project-cli-private|question/i);
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    expect(fs.readFileSync(profilePath, "utf8")).toBe(profileBefore);
    const recordBytes = fs.readFileSync(personalGlossaryReviewRecordsPath(), "utf8");
    expect(recordBytes).not.toContain(capsule.term);
    expect(recordBytes).not.toContain(capsule.meaning);
  });

  it("accepts one current signed disposition, replays it exactly, and rejects reused nonce content", () => {
    const capsule = candidate(8);
    const projection = persist([capsule]);
    const hostReceipt = receipt(capsule, projection);
    const queued = queue(capsule, projection);
    writeTrustedHost();
    const signed = approval(queued.record, "accept", { nonce: "single-use-cli-review-nonce" });
    const input = dispositionRequest(queued.record, hostReceipt, signed);
    const pathname = personalGlossaryReviewRecordsPath();

    const first = run(
      ["report", "personal-glossary-reviews", "disposition", "--input", "-", "--format", "json"],
      input,
    );
    expect(first).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(first.out)).toMatchObject({
      schemaVersion: "agentera.personalGlossaryReviewDispositionResult.v1",
      status: "disposed",
      record: { review_id: queued.record.review_id, disposition: "accept", status: "terminal" },
      publication_authorization: {
        review_id: queued.record.review_id,
        review_record_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      effects: {
        review_metadata: "changed",
        profile_entry: "unchanged",
        project_state: "unchanged",
        candidate_projection: "unchanged",
        publication: "unchanged",
      },
    });
    expect(first.out).not.toContain(capsule.term);
    expect(first.out).not.toContain(capsule.meaning);
    const afterFirst = fs.readFileSync(pathname, "utf8");

    const replay = run(
      ["report", "personal-glossary-reviews", "disposition", "--input", "-", "--format", "json"],
      input,
    );
    expect(replay).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(replay.out)).toMatchObject({ status: "unchanged_replay" });
    expect(fs.readFileSync(pathname, "utf8")).toBe(afterFirst);

    const changed = run(
      ["report", "personal-glossary-reviews", "disposition", "--input", "-", "--format", "json"],
      dispositionRequest(
        queued.record,
        hostReceipt,
        approval(queued.record, "reject", { nonce: "single-use-cli-review-nonce" }),
      ),
    );
    expect(changed).toMatchObject({ rc: 1, err: "" });
    expect(JSON.parse(changed.out)).toMatchObject({ error: { class: "review_approval_replayed" } });
    expect(changed.out).not.toContain("single-use-cli-review-nonce");
    expect(fs.readFileSync(pathname, "utf8")).toBe(afterFirst);
  });

  it("rejects oversized or secret signed corrections before it changes review metadata", () => {
    const capsule = candidate(9);
    const projection = persist([capsule]);
    const hostReceipt = receipt(capsule, projection);
    const queued = queue(capsule, projection);
    writeTrustedHost();
    const pathname = personalGlossaryReviewRecordsPath();
    const before = fs.readFileSync(pathname, "utf8");
    for (const correctedMeaning of [
      "x".repeat(4_097),
      "Authorization: Bearer secret-review-token",
    ]) {
      const invalid = run(
        ["report", "personal-glossary-reviews", "disposition", "--input", "-", "--format", "json"],
        dispositionRequest(
          queued.record,
          hostReceipt,
          approval(queued.record, "correct", { corrected_meaning: correctedMeaning }),
        ),
      );
      expect(invalid).toMatchObject({ rc: 1, err: "" });
      expect(JSON.parse(invalid.out)).toMatchObject({ error: { class: "review_approval_invalid" } });
      expect(invalid.out).not.toContain(correctedMeaning.slice(0, 64));
    }
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
  });

  it("rejects unsafe queue metadata without persisting or echoing it", () => {
    const unsafeBindings = [
      ["/home/current-user/private-generation", POLICY, "review_not_required"],
      [generation, "api_key=review-secret-123456", "current_binding_mismatch"],
    ] as const;

    for (const [unsafeGeneration, policyVersion, errorClass] of unsafeBindings) {
      const capsule = candidate(7, unsafeGeneration, policyVersion);
      const projection = persist([capsule]);
      const projectionPath = personalGlossaryCandidateProjectionPath();
      const projectionBefore = fs.readFileSync(projectionPath, "utf8");
      const result = run(
        ["report", "personal-glossary-reviews", "queue", "--input", "-", "--format", "json"],
        request(receipt(capsule, projection)),
      );

      expect(result).toMatchObject({ rc: 1, err: "" });
      expect(JSON.parse(result.out)).toMatchObject({ error: { class: errorClass } });
      expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(4_096);
      expect(result.out).not.toContain(unsafeGeneration);
      expect(result.out).not.toContain(policyVersion);
      expect(fs.existsSync(personalGlossaryReviewRecordsPath())).toBe(false);
      expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    }
  });

  it("treats missing private storage as an empty list and an exact not-found read", () => {
    const list = run(["report", "personal-glossary-reviews", "list", "--format", "json"]);
    expect(list).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(list.out)).toMatchObject({
      status: "ok",
      entries: [],
      counts: { total: 0, returned: 0, remaining: 0 },
      retention: { expired_records: 0, stale_records: 0, mutation: "forbidden" },
    });
    expect(Buffer.byteLength(list.out, "utf8")).toBeLessThanOrEqual(32_768);

    const get = run([
      "report",
      "personal-glossary-reviews",
      "get",
      "--review-id",
      "a".repeat(64),
      "--candidate-id",
      "b".repeat(64),
      "--candidate-revision",
      "c".repeat(64),
      "--generation",
      generation,
      "--policy-version",
      POLICY,
      "--format",
      "json",
    ]);
    expect(get).toMatchObject({ rc: 1, err: "" });
    expect(JSON.parse(get.out)).toMatchObject({ error: { class: "not_found" } });
    expect(Buffer.byteLength(get.out, "utf8")).toBeLessThanOrEqual(8_192);
    expect(fs.existsSync(personalGlossaryReviewRecordsPath())).toBe(false);
  });

  it("lists paginated private records and retrieves one full current identity", () => {
    const firstCandidate = candidate(2);
    const secondCandidate = candidate(3);
    const projection = persist([firstCandidate, secondCandidate]);
    const first = queue(firstCandidate, projection);
    const second = queue(secondCandidate, projection);
    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");

    const page = run([
      "report",
      "personal-glossary-reviews",
      "list",
      "--status",
      "pending",
      "--limit",
      "1",
      "--format",
      "json",
    ]);
    expect(page).toMatchObject({ rc: 0, err: "" });
    const firstPage = JSON.parse(page.out);
    expect(firstPage).toMatchObject({
      schemaVersion: "agentera.personalGlossaryReviewRetrieval.v1",
      status: "ok",
      owner: "current_user",
      counts: { total: 2, returned: 1, remaining: 1 },
      filters: { status: "pending" },
      omitted: true,
    });
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    expect(page.out).not.toMatch(/private CLI review (term|meaning)|source-cli-private|anchor-cli-private|project-cli-private/i);
    expect(Buffer.byteLength(page.out, "utf8")).toBeLessThanOrEqual(32_768);

    const continued = run([
      "report",
      "personal-glossary-reviews",
      "list",
      "--status",
      "pending",
      "--limit",
      "1",
      "--cursor",
      firstPage.next_cursor,
      "--format",
      "json",
    ]);
    expect(continued).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(continued.out)).toMatchObject({ counts: { returned: 1, remaining: 0 } });

    const exact = run(exactArgs(first.record));
    expect(exact).toMatchObject({ rc: 0, err: "" });
    expect(Buffer.byteLength(exact.out, "utf8")).toBeLessThanOrEqual(8_192);
    expect(JSON.parse(exact.out)).toMatchObject({
      status: "ok",
      owner: "current_user",
      record: {
        review_id: first.record.review_id,
        candidate_id: first.record.candidate_id,
        candidate_revision: first.record.candidate_revision,
        candidate_projection_sha256: projection.projection_sha256,
        reason: "classification_inconsistent",
        status: "pending",
      },
    });
  });

  it("does not present G1 review metadata after the current tier advances to G2", () => {
    const capsule = candidate(6);
    const projection = persist([capsule]);
    const queued = queue(capsule, projection);
    const projectionPath = personalGlossaryCandidateProjectionPath();
    const reviewPath = personalGlossaryReviewRecordsPath();
    const projectionBefore = fs.readFileSync(projectionPath, "utf8");
    const reviewsBefore = fs.readFileSync(reviewPath, "utf8");

    const nextGeneration = publishCurrentTier("g2");
    expect(nextGeneration).not.toBe(generation);

    const listed = run(["report", "personal-glossary-reviews", "list", "--format", "json"]);
    expect(listed).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(listed.out)).toMatchObject({
      status: "degraded",
      entries: [],
      retention: { stale_records: 1, mutation: "forbidden" },
    });

    const exact = run(exactArgs(queued.record));
    expect(exact).toMatchObject({ rc: 1, err: "" });
    expect(JSON.parse(exact.out)).toMatchObject({ error: { class: "current_binding_mismatch" } });
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    expect(fs.readFileSync(reviewPath, "utf8")).toBe(reviewsBefore);
  });

  it("rejects malformed requests, owner mismatches, and cursor changes without effects", () => {
    const capsule = candidate(4);
    const projection = persist([capsule]);
    const queued = queue(capsule, projection);
    const pathname = personalGlossaryReviewRecordsPath();
    const bytes = fs.readFileSync(pathname, "utf8");

    const malformed = run([
      "report",
      "personal-glossary-reviews",
      "list",
      "--limit",
      "0",
      "--format",
      "json",
    ]);
    expect(malformed).toMatchObject({ rc: 2, err: "" });
    expect(JSON.parse(malformed.out)).toMatchObject({ error: { class: "invalid_int" } });
    expect(fs.readFileSync(pathname, "utf8")).toBe(bytes);

    const hostile = `api_key=${"x".repeat(40_000)}`;
    const parserFailures = [
      {
        result: run(["report", "personal-glossary-reviews", "list", "--format", hostile]),
        maximum: 32_768,
      },
      {
        result: run(["report", "personal-glossary-reviews", "list", `--${hostile}`, "--format", "json"]),
        maximum: 32_768,
      },
      {
        result: run(exactArgs(queued.record, { generation: "/home/current-user/private-generation" })),
        maximum: 8_192,
      },
      {
        result: run(exactArgs(queued.record, { policyVersion: hostile })),
        maximum: 8_192,
      },
      {
        result: run(["report", "personal-glossary-reviews", hostile]),
        maximum: 4_096,
      },
    ];
    for (const { result, maximum } of parserFailures) {
      expect(result).toMatchObject({ rc: 2, err: "" });
      expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(maximum);
      expect(result.out).not.toContain(hostile);
    }
    expect(fs.readFileSync(pathname, "utf8")).toBe(bytes);

    const oversized = run(
      ["report", "personal-glossary-reviews", "queue", "--input", "-", "--format", "json"],
      "x".repeat(16_385),
    );
    expect(oversized).toMatchObject({ rc: 2, err: "" });
    expect(JSON.parse(oversized.out)).toMatchObject({ error: { class: "invalid_format" } });
    expect(fs.readFileSync(pathname, "utf8")).toBe(bytes);

    const ownerMismatch = JSON.parse(bytes) as Record<string, any>;
    ownerMismatch.owner = "other_user";
    const { store_sha256: _storeSha, ...body } = ownerMismatch;
    ownerMismatch.store_sha256 = glossaryCanonicalSha256(body);
    const mismatchBytes = `${canonicalGlossaryJson(ownerMismatch)}\n`;
    fs.writeFileSync(pathname, mismatchBytes, "utf8");
    const privateRead = run(["report", "personal-glossary-reviews", "list", "--format", "json"]);
    expect(privateRead).toMatchObject({ rc: 1, err: "" });
    expect(JSON.parse(privateRead.out)).toMatchObject({ error: { class: "review_records_unavailable" } });
    expect(privateRead.out).not.toContain(capsule.term);
    expect(fs.readFileSync(pathname, "utf8")).toBe(mismatchBytes);
  });

  it("fails exact stale bindings and mismatched continuations without changing records", () => {
    const firstCandidate = candidate(5);
    const secondCandidate = candidate(6);
    const projection = persist([firstCandidate, secondCandidate]);
    const record = queue(firstCandidate, projection).record;
    queue(secondCandidate, projection);
    const pathname = personalGlossaryReviewRecordsPath();
    const before = fs.readFileSync(pathname, "utf8");
    const page = run([
      "report",
      "personal-glossary-reviews",
      "list",
      "--limit",
      "1",
      "--format",
      "json",
    ]);
    const nextCursor = JSON.parse(page.out).next_cursor;
    const changedCursor = run([
      "report",
      "personal-glossary-reviews",
      "list",
      "--status",
      "pending",
      "--limit",
      "1",
      "--cursor",
      nextCursor,
      "--format",
      "json",
    ]);
    expect(changedCursor).toMatchObject({ rc: 1, err: "" });
    expect(JSON.parse(changedCursor.out)).toMatchObject({ error: { class: "cursor_invalid" } });

    const replacement = candidate(5, "review-cli-generation-next");
    persist([replacement]);
    const staleList = run(["report", "personal-glossary-reviews", "list", "--format", "json"]);
    expect(staleList).toMatchObject({ rc: 0, err: "" });
    expect(JSON.parse(staleList.out)).toMatchObject({
      status: "degraded",
      entries: [],
      retention: { stale_records: 2, mutation: "forbidden" },
    });
    const staleExact = run(exactArgs(record));
    expect(staleExact).toMatchObject({ rc: 1, err: "" });
    expect(JSON.parse(staleExact.out)).toMatchObject({ error: { class: "current_binding_mismatch" } });
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
  });

  it("rejects queue input replaced by a symlink while it is opened", () => {
    const capsule = candidate(8);
    const projection = persist([capsule]);
    const input = path.join(profileDir, "review-request.json");
    const original = path.join(profileDir, "original-review-request.json");
    fs.writeFileSync(input, request(receipt(capsule, projection)));
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
        "report", "personal-glossary-reviews", "queue", "--input", input, "--format", "json",
      ]);
      expect(result).toMatchObject({ rc: 2, err: "" });
      expect(JSON.parse(result.out)).toMatchObject({ error: { class: "invalid_format" } });
      expect(fs.existsSync(personalGlossaryReviewRecordsPath())).toBe(false);
    } finally {
      open.mockRestore();
    }
  });
});

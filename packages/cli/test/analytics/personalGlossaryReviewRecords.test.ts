import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  currentPersonalGlossaryReviewRecords,
  dispositionPersonalGlossaryReviewRecord,
  maintainPersonalGlossaryReviewRecords,
  personalGlossaryReviewRecordsPath,
  personalGlossaryTrustedLocalHostPath,
  queuePersonalGlossaryReviewRecord,
  readPersonalGlossaryReviewRecords,
  validPersonalGlossaryReviewMetadataBinding,
  validPersonalGlossaryReviewGenerationBinding,
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
import {
  createGlossaryReviewRecord,
  createGlossaryEvidenceCapsule,
  createGlossaryHostClassificationReceipt,
  type GlossaryEvidenceCapsule,
} from "../../src/registries/glossaryCandidateContracts.js";
import { validatePersonalReviewApprovalReceipt } from "../../src/registries/glossaryMiningAuthority.js";
import { decidePersonalGlossaryCandidate } from "../../src/analytics/personalGlossaryDecision.js";
import { canonicalGlossaryJson, glossaryCanonicalSha256 } from "../../src/registries/glossaryTermIdentity.js";

const POLICY = "agentera.personalGlossaryMiningPolicy.v1";
const RETAINED_AT = "2026-08-10T00:00:00.000Z";
const QUEUED_AT = "2026-08-11T00:00:00.000Z";
const REVIEW_SUBJECT = "user:current";
const REVIEW_KEY_PAIR = generateKeyPairSync("ed25519");

let profileDir: string;
let generation: string;
let extraPaths: string[];

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-review-records-"));
  extraPaths = [];
  generation = publishCurrentTier(profileDir, "initial");
});

function publishCurrentTier(root: string, seed: string): string {
  const text = `review record tier generation ${seed}`;
  return publishEvidenceTiers([{
    source_id: `review-record-tier-source-${seed}`,
    source_kind: "conversation_turn",
    timestamp: RETAINED_AT,
    project_id: "private-review-record-tier",
    runtime: "opencode",
    source_class: "active_runtime",
    source_product: "opencode",
    active_runtime: true,
    adapter_version: ADAPTER_VERSION,
    data: { actor: "user", signal_type: "decision", text },
    origin_id: originIdentity(`review-record-tier-source-${seed}`),
    content_fingerprint: contentFingerprint(text),
    session_id: `review-record-tier-session-${seed}`,
    conversation_key: `review-record-tier-session-${seed}`,
    author_class: "user",
  }], {
    tiersDir: path.join(root, "intermediate", "tiers"),
    adapterVersion: ADAPTER_VERSION,
    publishedAt: RETAINED_AT,
  }).generation;
}

afterEach(() => {
  for (const pathname of extraPaths) fs.rmSync(pathname, { recursive: true, force: true });
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function storage(root = profileDir) {
  return { env: { AGENTERA_PROFILE_DIR: root } };
}

function candidate(
  index: number,
  candidateGeneration = generation,
  policyVersion = POLICY,
  evidenceVariant = "",
): GlossaryEvidenceCapsule {
  const variant = evidenceVariant ? `-${evidenceVariant}` : "";
  return createGlossaryEvidenceCapsule({
    term: `private review term ${index}`,
    meaning: `private review meaning ${index}`,
    scope: "personal",
    provenance_kind: "personal_inferred_usage",
    evidence: [
      {
        source_id: `source-private-${index}${variant}-a`,
        evidence_anchor: `anchor-private-${index}${variant}-a`,
        source_kind: "instruction_document",
      },
      {
        source_id: `source-private-${index}${variant}-b`,
        evidence_anchor: `anchor-private-${index}${variant}-b`,
        source_kind: "project_config_signal",
      },
    ],
    generation: candidateGeneration,
    policy_version: policyVersion,
  });
}

function persist(candidates: readonly GlossaryEvidenceCapsule[], root = profileDir): PersonalGlossaryCandidateProjection {
  const projection = projectPersonalGlossaryCandidates({
    generation: candidates[0]!.generation,
    policy_version: candidates[0]!.policy_version,
    retained_at: RETAINED_AT,
    candidates: candidates.map((capsule, index) => ({
      capsule,
      project_ids: [`project-private-${index}`],
      excerpts: [`${capsule.term} has bounded safe context.`],
    })),
  });
  persistPersonalGlossaryCandidateProjection(projection, storage(root));
  return projection;
}

function receipt(
  capsule: GlossaryEvidenceCapsule,
  projection: PersonalGlossaryCandidateProjection,
  consistency: "inconsistent" | "uncertain" = "inconsistent",
) {
  return createGlossaryHostClassificationReceipt({
    capsule,
    candidate_projection_sha256: projection.projection_sha256,
    classification: {
      term: capsule.term,
      meaning: capsule.meaning,
      scope: capsule.scope,
      permanence: "durable",
      consistency,
      confidence: 83,
    },
  });
}

function queue(
  capsule: GlossaryEvidenceCapsule,
  projection: PersonalGlossaryCandidateProjection,
  options = storage(),
  now = QUEUED_AT,
) {
  return queuePersonalGlossaryReviewRecord({
    ...options,
    receipt: receipt(capsule, projection),
    now,
  });
}

function writeTrustedHost(root = profileDir, subject = REVIEW_SUBJECT): void {
  const pathname = personalGlossaryTrustedLocalHostPath(storage(root));
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const host = {
    owner: "current_user",
    public_key_spki_base64url: REVIEW_KEY_PAIR.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
    schema_version: "agentera.personalGlossaryTrustedLocalHost.v1",
    subject,
  };
  fs.writeFileSync(pathname, `${canonicalGlossaryJson(host)}\n`, { encoding: "utf8", mode: 0o600 });
}

function approval(
  record: PersonalGlossaryReviewRecord,
  disposition: "accept" | "correct" | "reject" | "defer",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { signature: signatureOverride, ...fields } = overrides;
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
    disposed_at: "2026-08-11T00:01:00.000Z",
    expires_at: "2026-08-11T00:06:00.000Z",
    nonce: `review-nonce-${record.review_id.slice(0, 12)}`,
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

function dispose(
  capsule: GlossaryEvidenceCapsule,
  projection: PersonalGlossaryCandidateProjection,
  record: PersonalGlossaryReviewRecord,
  disposition: "accept" | "correct" | "reject" | "defer",
  overrides: Record<string, unknown> = {},
  now = "2026-08-11T00:02:00.000Z",
) {
  return dispositionPersonalGlossaryReviewRecord({
    ...storage(),
    review_id: record.review_id,
    receipt: receipt(capsule, projection),
    approval: approval(record, disposition, overrides),
    now,
  });
}

function legacyPendingRecord(record: PersonalGlossaryReviewRecord): Record<string, unknown> {
  const body = {
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
  return { ...body, record_sha256: glossaryCanonicalSha256(body) };
}

function writeLegacyStore(records: readonly Record<string, unknown>[]): string {
  const body = {
    schema_version: "agentera.personalGlossaryReviewStore.v1",
    owner: "current_user",
    records: [...records].sort((left, right) => String(left.review_id).localeCompare(String(right.review_id))),
  };
  const store = { ...body, store_sha256: glossaryCanonicalSha256(body) };
  const bytes = `${canonicalGlossaryJson(store)}\n`;
  const pathname = personalGlossaryReviewRecordsPath(storage());
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pathname, bytes, { encoding: "utf8", mode: 0o600 });
  return bytes;
}

describe("personal glossary review-record persistence", () => {
  it("queues only opaque current review metadata and replays without profile or projection mutation", () => {
    const capsule = candidate(1);
    const projection = persist([capsule]);
    const profilePath = path.join(profileDir, "PROFILE.md");
    fs.writeFileSync(profilePath, "private profile bytes\n", "utf8");
    const projectionPath = personalGlossaryCandidateProjectionPath(storage());
    const projectionBefore = fs.readFileSync(projectionPath, "utf8");
    const profileBefore = fs.readFileSync(profilePath, "utf8");

    const first = queue(capsule, projection);
    expect(first.status).toBe("queued");
    expect(first.record).toMatchObject({
      owner: "current_user",
      candidate_id: capsule.candidate_id,
      candidate_revision: capsule.candidate_revision,
      candidate_projection_sha256: projection.projection_sha256,
      reason: "classification_inconsistent",
      status: "pending",
      terminal_at: null,
      expires_at: null,
    });
    const pathname = personalGlossaryReviewRecordsPath(storage());
    const bytes = fs.readFileSync(pathname, "utf8");
    expect(bytes).not.toContain(capsule.term);
    expect(bytes).not.toContain(capsule.meaning);
    expect(bytes).not.toMatch(/source-private|anchor-private|project-private|safe context/i);
    expect(fs.statSync(pathname).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(pathname)).mode & 0o777).toBe(0o700);

    fs.chmodSync(pathname, 0o644);
    const replay = queue(capsule, projection, storage(), "2026-08-12T00:00:00.000Z");
    expect(replay).toMatchObject({ status: "unchanged_replay", record: { review_id: first.record!.review_id, queued_at: QUEUED_AT } });
    expect(fs.readFileSync(pathname, "utf8")).toBe(bytes);
    expect(fs.statSync(pathname).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    expect(fs.readFileSync(profilePath, "utf8")).toBe(profileBefore);
  });

  it("reads a canonical v1 pending store without changing its bytes", () => {
    const capsule = candidate(7);
    const projection = persist([capsule]);
    const queued = queue(capsule, projection);
    const legacy = legacyPendingRecord(queued.record!);
    const bytes = writeLegacyStore([legacy]);

    expect(readPersonalGlossaryReviewRecords(storage())).toMatchObject({
      status: "current",
      store: { schema_version: "agentera.personalGlossaryReviewStore.v1", records: [legacy] },
    });
    expect(currentPersonalGlossaryReviewRecords(storage(), "2026-08-11T00:02:00.000Z")).toMatchObject({
      status: "current",
      records: [{ review_id: queued.record!.review_id, scope: null, disposition: null }],
    });
    expect(fs.readFileSync(personalGlossaryReviewRecordsPath(storage()), "utf8")).toBe(bytes);
  });

  it("migrates only the disposed v1 record into v2 lifecycle and replays exactly", () => {
    const first = candidate(8);
    const second = candidate(9);
    const projection = persist([first, second]);
    const queuedFirst = queue(first, projection);
    const queuedSecond = queue(second, projection);
    const firstLegacy = legacyPendingRecord(queuedFirst.record!);
    const secondLegacy = legacyPendingRecord(queuedSecond.record!);
    writeLegacyStore([firstLegacy, secondLegacy]);
    const projectionBytes = fs.readFileSync(personalGlossaryCandidateProjectionPath(storage()), "utf8");
    writeTrustedHost();
    const signed = approval(queuedFirst.record!, "accept", { nonce: "legacy-v1-single-use" });
    const input = {
      ...storage(),
      review_id: queuedFirst.record!.review_id,
      receipt: receipt(first, projection),
      approval: signed,
      now: "2026-08-11T00:02:00.000Z",
    };

    const disposed = dispositionPersonalGlossaryReviewRecord(input);
    expect(disposed).toMatchObject({ status: "disposed", record: { review_id: firstLegacy.review_id, disposition: "accept" } });
    const migratedBytes = fs.readFileSync(personalGlossaryReviewRecordsPath(storage()), "utf8");
    const migrated = JSON.parse(migratedBytes) as { schema_version: string; replay_index: unknown[]; records: Record<string, unknown>[] };
    expect(migrated).toMatchObject({ schema_version: "agentera.personalGlossaryReviewStore.v2", replay_index: [expect.any(Object)] });
    expect(migrated.records.find((record) => record.review_id === firstLegacy.review_id)).toMatchObject({
      schema_version: "agentera.personalGlossaryReviewRecord.v2",
      review_id: firstLegacy.review_id,
      candidate_id: firstLegacy.candidate_id,
      candidate_revision: firstLegacy.candidate_revision,
      candidate_capsule_sha256: firstLegacy.candidate_capsule_sha256,
      record_sha256: expect.not.stringMatching(new RegExp(`^${firstLegacy.record_sha256}$`, "u")),
    });
    expect(migrated.records.find((record) => record.review_id === secondLegacy.review_id)).toEqual(secondLegacy);
    expect(fs.readFileSync(personalGlossaryCandidateProjectionPath(storage()), "utf8")).toBe(projectionBytes);
    expect(dispositionPersonalGlossaryReviewRecord(input)).toMatchObject({ status: "unchanged_replay" });
    expect(fs.readFileSync(personalGlossaryReviewRecordsPath(storage()), "utf8")).toBe(migratedBytes);
  });

  it.each([
    ["invalid v1 digest", (record: Record<string, unknown>) => { record.record_sha256 = "0".repeat(64); }],
    ["unavailable v1 scope", (_record: Record<string, unknown>) => undefined],
  ] as const)("fails %s before changing v1 bytes", (name, mutate) => {
    const capsule = candidate(13);
    const projection = persist([capsule]);
    const queued = queue(capsule, projection);
    const legacy = legacyPendingRecord(queued.record!);
    mutate(legacy);
    const bytes = writeLegacyStore([legacy]);
    writeTrustedHost();
    const currentReceipt = receipt(capsule, projection) as Record<string, any>;
    if (name === "unavailable v1 scope") currentReceipt.classification.scope = "project";

    const result = dispositionPersonalGlossaryReviewRecord({
      ...storage(),
      review_id: queued.record!.review_id,
      receipt: currentReceipt,
      approval: approval(queued.record!, "reject"),
      now: "2026-08-11T00:02:00.000Z",
    });
    expect(["records_unavailable", "current_binding_mismatch"]).toContain(result.status);
    expect(fs.readFileSync(personalGlossaryReviewRecordsPath(storage()), "utf8")).toBe(bytes);
  });

  it("requires a fresh trusted current-user approval before it changes a queued review", () => {
    const capsule = candidate(8);
    const projection = persist([capsule]);
    const queued = queue(capsule, projection);
    const pathname = personalGlossaryReviewRecordsPath(storage());
    writeTrustedHost();
    const before = fs.readFileSync(pathname, "utf8");

    expect(dispose(capsule, projection, queued.record!, "accept", { issuer: "agent" })).toEqual({
      status: "approval_invalid",
      record: null,
      publication_authorization: null,
    });
    expect(dispose(capsule, projection, queued.record!, "accept", {
      disposed_at: "2026-08-11T00:00:00.000Z",
      expires_at: "2026-08-11T00:01:00.000Z",
    }, "2026-08-11T00:06:00.000Z")).toEqual({
      status: "approval_invalid",
      record: null,
      publication_authorization: null,
    });
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);

    expect(validatePersonalReviewApprovalReceipt(approval(queued.record!, "accept"), {
      currentUserSubject: REVIEW_SUBJECT,
      reviewId: queued.record!.review_id,
      candidateId: queued.record!.candidate_id,
      candidateRevision: queued.record!.candidate_revision,
      candidateProjectionSha256: queued.record!.candidate_projection_sha256,
      semanticFingerprint: queued.record!.semantic_fingerprint,
      generation: queued.record!.generation,
      policyVersion: queued.record!.policy_version,
      now: new Date("2026-08-11T00:02:00.000Z"),
      trustedHostPublicKey: REVIEW_KEY_PAIR.publicKey,
    })).toEqual([]);
    const currentDecision = decidePersonalGlossaryCandidate(receipt(capsule, projection), storage());
    expect(currentDecision).toMatchObject({ status: "review_required", decision: expect.any(Object) });
    expect(() => createGlossaryReviewRecord({
      capsule,
      receipt: receipt(capsule, projection),
      decision: currentDecision.decision!,
      disposition: "accept",
      corrected_meaning: null,
      corrected_scope: null,
      disposed_at: "2026-08-11T00:01:00.000Z",
      expires_at: "2026-11-09T00:01:00.000Z",
    })).not.toThrow();
    const accepted = dispose(capsule, projection, queued.record!, "accept");
    expect(accepted).toMatchObject({
      status: "disposed",
      record: {
        candidate_id: capsule.candidate_id,
        candidate_revision: capsule.candidate_revision,
        semantic_fingerprint: queued.record!.semantic_fingerprint,
        generation: capsule.generation,
        policy_version: capsule.policy_version,
        disposition: "accept",
        status: "terminal",
      },
      publication_authorization: {
        review_id: queued.record!.review_id,
        review_record_sha256: expect.stringMatching(SHA256),
      },
    });
    const stored = fs.readFileSync(pathname, "utf8");
    expect(stored).not.toContain(capsule.term);
    expect(stored).not.toContain(capsule.meaning);
    expect(stored).not.toContain("review-nonce-");
  });

  it("makes exact approval replay idempotent and rejects changed content with a reused nonce", () => {
    const capsule = candidate(9);
    const projection = persist([capsule]);
    const queued = queue(capsule, projection);
    writeTrustedHost();
    const signed = approval(queued.record!, "accept", { nonce: "single-use-review-nonce" });
    const input = {
      ...storage(),
      review_id: queued.record!.review_id,
      receipt: receipt(capsule, projection),
      approval: signed,
      now: "2026-08-11T00:02:00.000Z",
    };
    const first = dispositionPersonalGlossaryReviewRecord(input);
    expect(first).toMatchObject({ status: "disposed", publication_authorization: expect.any(Object) });
    const pathname = personalGlossaryReviewRecordsPath(storage());
    const afterFirst = fs.readFileSync(pathname, "utf8");

    expect(dispositionPersonalGlossaryReviewRecord(input)).toMatchObject({
      status: "unchanged_replay",
      record: { review_id: queued.record!.review_id },
      publication_authorization: first.publication_authorization,
    });
    expect(fs.readFileSync(pathname, "utf8")).toBe(afterFirst);

    const changed = dispositionPersonalGlossaryReviewRecord({
      ...input,
      approval: approval(queued.record!, "reject", { nonce: "single-use-review-nonce" }),
    });
    expect(changed).toEqual({
      status: "approval_conflicting_replay",
      record: null,
      publication_authorization: null,
    });
    expect(fs.readFileSync(pathname, "utf8")).toBe(afterFirst);
  });

  it.each([
    ["accept", "terminal", true],
    ["correct", "terminal", true],
    ["reject", "terminal", false],
    ["defer", "pending", false],
  ] as const)("records %s as %s with only the allowed publication authority", (disposition, status, publishable) => {
    const capsule = candidate(10);
    const projection = persist([capsule]);
    const queued = queue(capsule, projection);
    writeTrustedHost();

    const result = dispose(capsule, projection, queued.record!, disposition);
    expect(result).toMatchObject({
      status: "disposed",
      record: {
        disposition,
        status,
        terminal_at: status === "terminal" ? "2026-08-11T00:01:00.000Z" : null,
      },
      publication_authorization: publishable ? expect.any(Object) : null,
    });
    if (disposition === "correct") {
      expect(result.record?.review_record).toMatchObject({
        corrected_meaning: "A corrected private meaning.",
        corrected_scope: "personal",
      });
    }
  });

  it.each(["reject", "defer"] as const)(
    "suppresses a semantically unchanged %s recurrence when only corroborating evidence changes",
    (disposition) => {
      const initial = candidate(11);
      const initialProjection = persist([initial]);
      const queued = queue(initial, initialProjection);
      writeTrustedHost();
      expect(dispose(initial, initialProjection, queued.record!, disposition)).toMatchObject({
        status: "disposed",
        record: { disposition },
      });

      const corroborated = candidate(
        11,
        publishCurrentTier(profileDir, "corroborated"),
        POLICY,
        "corroborated",
      );
      const corroboratedProjection = persist([corroborated]);
      const recurrence = queue(corroborated, corroboratedProjection, storage(), "2026-08-11T00:03:00.000Z");
      expect(corroborated.candidate_id).toBe(initial.candidate_id);
      expect(corroborated.candidate_revision).not.toBe(initial.candidate_revision);
      expect(recurrence).toMatchObject({
        status: "suppressed",
        record: { review_id: queued.record!.review_id, disposition },
        reopen_reason: null,
      });
    },
  );

  it.each([
    ["reject", "policy", "policy_changed"],
    ["reject", "scope", "scope_changed"],
    ["reject", "meaning", "meaning_changed"],
    ["defer", "policy", "policy_changed"],
    ["defer", "scope", "scope_changed"],
    ["defer", "meaning", "meaning_changed"],
  ] as const)("reopens a %s review when its %s changes after exact disposition replay", (disposition, change, reopenReason) => {
    const initial = candidate(12);
    const initialProjection = persist([initial]);
    const queued = queue(initial, initialProjection);
    writeTrustedHost();
    const signed = approval(queued.record!, disposition, { nonce: `reopen-${disposition}-${change}` });
    const input = {
      ...storage(),
      review_id: queued.record!.review_id,
      receipt: receipt(initial, initialProjection),
      approval: signed,
      now: "2026-08-11T00:02:00.000Z",
    };
    expect(dispositionPersonalGlossaryReviewRecord(input)).toMatchObject({
      status: "disposed",
      record: { disposition },
    });
    expect(dispositionPersonalGlossaryReviewRecord(input)).toMatchObject({ status: "unchanged_replay" });

    if (change === "policy") {
      const changed = candidate(12, generation, "agentera.personalGlossaryMiningPolicy.v2", "policy");
      const changedProjection = persist([changed]);
      expect(queue(changed, changedProjection, storage(), "2026-08-11T00:03:00.000Z")).toMatchObject({
        status: "reopened",
        reopen_reason: reopenReason,
      });
      return;
    }

    const changedReceipt = createGlossaryHostClassificationReceipt({
      capsule: initial,
      candidate_projection_sha256: initialProjection.projection_sha256,
      classification: {
        term: initial.term,
        meaning: change === "meaning" ? "A changed personal meaning." : initial.meaning,
        scope: change === "scope" ? "ambiguous" : "personal",
        permanence: "durable",
        consistency: "inconsistent",
        confidence: 83,
      },
    });
    expect(queuePersonalGlossaryReviewRecord({
      ...storage(),
      receipt: changedReceipt,
      now: "2026-08-11T00:03:00.000Z",
    })).toMatchObject({
      status: "reopened",
      reopen_reason: reopenReason,
    });
  });

  it("creates a distinct current record for a changed reason instead of overwriting", () => {
    const capsule = candidate(2);
    const projection = persist([capsule]);
    const first = queue(capsule, projection);
    const second = queuePersonalGlossaryReviewRecord({
      ...storage(),
      receipt: receipt(capsule, projection, "uncertain"),
      now: "2026-08-11T00:01:00.000Z",
    });

    expect(first).toMatchObject({ status: "queued", reason: "classification_inconsistent" });
    expect(second).toMatchObject({ status: "queued", reason: "classification_changed" });
    expect(second.record!.review_id).not.toBe(first.record!.review_id);
    expect(readPersonalGlossaryReviewRecords(storage())).toMatchObject({
      status: "current",
      store: { records: expect.arrayContaining([
        expect.objectContaining({ review_id: first.record!.review_id }),
        expect.objectContaining({ review_id: second.record!.review_id }),
      ]) },
    });
  });

  it("rejects secret or path-shaped binding metadata before it persists review records", () => {
    const unsafeBindings = [
      [
        "/home/current-user/private-generation",
        POLICY,
        "decision_not_review_required",
        "projection_stale",
      ],
      [
        generation,
        "api_key=review-secret-123456",
        "current_binding_mismatch",
        "record_binding_mismatch",
      ],
    ] as const;

    for (const [unsafeGeneration, policyVersion, status, reason] of unsafeBindings) {
      const capsule = candidate(7, unsafeGeneration, policyVersion);
      const projection = persist([capsule]);
      const projectionPath = personalGlossaryCandidateProjectionPath(storage());
      const projectionBefore = fs.readFileSync(projectionPath, "utf8");

      expect(queue(capsule, projection)).toMatchObject({
        status,
        reason,
        record: null,
      });
      expect(fs.existsSync(personalGlossaryReviewRecordsPath(storage()))).toBe(false);
      expect(readPersonalGlossaryReviewRecords(storage())).toEqual({ status: "missing", store: null });
      expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    }

    expect(validPersonalGlossaryReviewMetadataBinding(generation)).toBe(true);
    expect(validPersonalGlossaryReviewGenerationBinding(generation)).toBe(true);
    expect(validPersonalGlossaryReviewMetadataBinding("agentera.personalGlossaryMiningPolicy.v1")).toBe(true);
    expect(validPersonalGlossaryReviewMetadataBinding("/home/current-user/private-generation")).toBe(false);
    expect(validPersonalGlossaryReviewMetadataBinding("api_key=review-secret-123456")).toBe(false);
    expect(validPersonalGlossaryReviewMetadataBinding("password=secret")).toBe(false);
  });

  it("treats no review-record file as an empty current view", () => {
    expect(currentPersonalGlossaryReviewRecords(storage(), QUEUED_AT)).toEqual({
      status: "current",
      records: [],
      expired_records: 0,
      stale_records: 0,
    });
    expect(fs.existsSync(personalGlossaryReviewRecordsPath(storage()))).toBe(false);
  });

  it("rejects stale or non-review decisions before it creates metadata", () => {
    const capsule = candidate(3);
    const projection = persist([capsule]);
    const oldReceipt = receipt(capsule, projection);
    const replacement = candidate(3, "review-record-generation-next");
    persist([replacement]);
    const projectionPath = personalGlossaryCandidateProjectionPath(storage());
    const projectionBefore = fs.readFileSync(projectionPath, "utf8");

    expect(queuePersonalGlossaryReviewRecord({ ...storage(), receipt: oldReceipt, now: QUEUED_AT })).toMatchObject({
      status: "decision_not_review_required",
      record: null,
    });
    expect(readPersonalGlossaryReviewRecords(storage())).toEqual({ status: "missing", store: null });
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
  });

  it("fails closed for over-bound or owner-mismatched stored metadata", () => {
    const capsule = candidate(4);
    const projection = persist([capsule]);
    const first = queue(capsule, projection);
    const pathname = personalGlossaryReviewRecordsPath(storage());
    const original = fs.readFileSync(pathname, "utf8");
    const altered = JSON.parse(original) as Record<string, any>;
    altered.owner = "another_user";
    const { store_sha256: _digest, ...body } = altered;
    altered.store_sha256 = glossaryCanonicalSha256(body);
    const ownerMismatch = `${canonicalGlossaryJson(altered)}\n`;
    fs.writeFileSync(pathname, ownerMismatch, "utf8");

    expect(readPersonalGlossaryReviewRecords(storage())).toEqual({ status: "corrupt", store: null });
    expect(queue(capsule, projection)).toMatchObject({ status: "records_unavailable", record: null });
    expect(fs.readFileSync(pathname, "utf8")).toBe(ownerMismatch);

    fs.writeFileSync(pathname, "x".repeat(262_145), "utf8");
    expect(readPersonalGlossaryReviewRecords(storage())).toEqual({ status: "corrupt", store: null });
    expect(first.record!.record_sha256).toMatch(SHA256);
  });

  it("expires terminal metadata or purges only review records without touching profile or projection", () => {
    const capsule = candidate(5);
    const projection = persist([capsule]);
    const profilePath = path.join(profileDir, "PROFILE.md");
    fs.writeFileSync(profilePath, "accepted profile bytes\n", "utf8");
    const projectionPath = personalGlossaryCandidateProjectionPath(storage());
    const projectionBefore = fs.readFileSync(projectionPath, "utf8");
    const profileBefore = fs.readFileSync(profilePath, "utf8");
    const first = queue(capsule, projection);
    writeTrustedHost();
    expect(dispose(capsule, projection, first.record!, "accept")).toMatchObject({
      status: "disposed",
      record: { status: "terminal", disposition: "accept" },
    });
    const pathname = personalGlossaryReviewRecordsPath(storage());

    expect(currentPersonalGlossaryReviewRecords(storage(), "2026-11-11T00:00:00.000Z")).toMatchObject({
      status: "current",
      records: [],
      expired_records: 1,
    });
    expect(maintainPersonalGlossaryReviewRecords({ ...storage(), now: "2026-11-11T00:00:00.000Z" })).toEqual({
      status: "changed",
      expired_records: 1,
      expired_receipts: 1,
    });
    expect(fs.existsSync(pathname)).toBe(false);
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    expect(fs.readFileSync(profilePath, "utf8")).toBe(profileBefore);

    const second = queue(capsule, projection, storage(), "2026-08-13T00:00:00.000Z");
    expect(second.status).toBe("queued");
    expect(maintainPersonalGlossaryReviewRecords({
      ...storage(),
      now: "2027-08-13T00:00:00.000Z",
    })).toEqual({ status: "unchanged", expired_records: 0, expired_receipts: 0 });
    expect(fs.existsSync(pathname)).toBe(true);
    expect(maintainPersonalGlossaryReviewRecords({
      ...storage(),
      now: "2026-08-13T00:00:00.000Z",
      current_user_purge_authorized: true,
    })).toEqual({ status: "purged", expired_records: 0, expired_receipts: 0 });
    expect(fs.existsSync(pathname)).toBe(false);
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    expect(fs.readFileSync(profilePath, "utf8")).toBe(profileBefore);
  });

  it("retains a deferred review while separately purging its expired replay receipt", () => {
    const capsule = candidate(13);
    const projection = persist([capsule]);
    const queued = queue(capsule, projection);
    writeTrustedHost();
    expect(dispose(capsule, projection, queued.record!, "defer")).toMatchObject({
      status: "disposed",
      record: { status: "pending", disposition: "defer" },
    });

    expect(maintainPersonalGlossaryReviewRecords({
      ...storage(),
      now: "2026-11-11T00:00:00.000Z",
    })).toEqual({ status: "changed", expired_records: 0, expired_receipts: 1 });
    expect(currentPersonalGlossaryReviewRecords(storage(), "2026-11-11T00:00:00.000Z")).toMatchObject({
      status: "current",
      expired_records: 0,
      records: [{ review_id: queued.record!.review_id, status: "pending", disposition: "defer" }],
    });
  });

  it("uses the configured user-local path with ordinary native filesystem behavior", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-review-target-"));
    const link = `${target}-link`;
    extraPaths.push(target, link);
    fs.symlinkSync(target, link, "dir");
    const capsule = candidate(6, publishCurrentTier(link, "symlink"));
    const projection = persist([capsule], link);
    const result = queue(capsule, projection, storage(link));
    const pathname = personalGlossaryReviewRecordsPath(storage(link));

    expect(result.status).toBe("queued");
    expect(pathname).toBe(path.join(link, "intermediate", "personal-glossary", "review-records.json"));
    expect(fs.existsSync(path.join(target, "intermediate", "personal-glossary", "review-records.json"))).toBe(true);

    const obstructed = path.join(profileDir, "not-a-directory");
    fs.writeFileSync(obstructed, "host-owned obstruction", "utf8");
    const obstructedOptions = storage(obstructed);
    expect(readPersonalGlossaryReviewRecords(obstructedOptions)).toEqual({ status: "corrupt", store: null });
    expect(maintainPersonalGlossaryReviewRecords({
      ...obstructedOptions,
      now: "2026-08-12T00:00:00.000Z",
      current_user_purge_authorized: true,
    })).toEqual({ status: "corrupt", expired_records: 0, expired_receipts: 0 });
    expect(fs.readFileSync(obstructed, "utf8")).toBe("host-owned obstruction");
  });
});

const SHA256 = /^[a-f0-9]{64}$/u;

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  currentPersonalGlossaryReviewRecords,
  maintainPersonalGlossaryReviewRecords,
  personalGlossaryReviewRecordsPath,
  queuePersonalGlossaryReviewRecord,
  readPersonalGlossaryReviewRecords,
  validPersonalGlossaryReviewMetadataBinding,
  type PersonalGlossaryReviewRecord,
} from "../../src/analytics/personalGlossaryReviewRecords.js";
import {
  personalGlossaryCandidateProjectionPath,
  persistPersonalGlossaryCandidateProjection,
  projectPersonalGlossaryCandidates,
  type PersonalGlossaryCandidateProjection,
} from "../../src/analytics/personalGlossaryCandidateProjection.js";
import {
  createGlossaryEvidenceCapsule,
  createGlossaryHostClassificationReceipt,
  type GlossaryEvidenceCapsule,
} from "../../src/registries/glossaryCandidateContracts.js";
import { canonicalGlossaryJson, glossaryCanonicalSha256 } from "../../src/registries/glossaryTermIdentity.js";

const GENERATION = "review-record-generation";
const POLICY = "agentera.personalGlossaryMiningPolicy.v1";
const RETAINED_AT = "2026-08-10T00:00:00.000Z";
const QUEUED_AT = "2026-08-11T00:00:00.000Z";

let profileDir: string;
let extraPaths: string[];

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-review-records-"));
  extraPaths = [];
});

afterEach(() => {
  for (const pathname of extraPaths) fs.rmSync(pathname, { recursive: true, force: true });
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function storage(root = profileDir) {
  return { env: { AGENTERA_PROFILE_DIR: root } };
}

function candidate(
  index: number,
  generation = GENERATION,
  policyVersion = POLICY,
): GlossaryEvidenceCapsule {
  return createGlossaryEvidenceCapsule({
    term: `private review term ${index}`,
    meaning: `private review meaning ${index}`,
    scope: "personal",
    provenance_kind: "personal_inferred_usage",
    evidence: [
      {
        source_id: `source-private-${index}-a`,
        evidence_anchor: `anchor-private-${index}-a`,
        source_kind: "instruction_document",
      },
      {
        source_id: `source-private-${index}-b`,
        evidence_anchor: `anchor-private-${index}-b`,
        source_kind: "project_config_signal",
      },
    ],
    generation,
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

function terminalize(record: PersonalGlossaryReviewRecord, terminalAt: string): void {
  const pathname = personalGlossaryReviewRecordsPath(storage());
  const store = JSON.parse(fs.readFileSync(pathname, "utf8")) as Record<string, any>;
  const persisted = store.records.find((item: PersonalGlossaryReviewRecord) => item.review_id === record.review_id)!;
  persisted.status = "terminal";
  persisted.terminal_at = terminalAt;
  persisted.expires_at = new Date(Date.parse(terminalAt) + 90 * 86_400_000).toISOString();
  const { record_sha256: _recordSha256, ...recordBody } = persisted;
  persisted.record_sha256 = glossaryCanonicalSha256(recordBody);
  const { store_sha256: _storeSha256, ...storeBody } = store;
  store.store_sha256 = glossaryCanonicalSha256(storeBody);
  fs.writeFileSync(pathname, `${canonicalGlossaryJson(store)}\n`, "utf8");
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
      ["/home/current-user/private-generation", POLICY],
      [GENERATION, "api_key=review-secret-123456"],
    ] as const;

    for (const [generation, policyVersion] of unsafeBindings) {
      const capsule = candidate(7, generation, policyVersion);
      const projection = persist([capsule]);
      const projectionPath = personalGlossaryCandidateProjectionPath(storage());
      const projectionBefore = fs.readFileSync(projectionPath, "utf8");

      expect(queue(capsule, projection)).toMatchObject({
        status: "current_binding_mismatch",
        reason: "record_binding_mismatch",
        record: null,
      });
      expect(fs.existsSync(personalGlossaryReviewRecordsPath(storage()))).toBe(false);
      expect(readPersonalGlossaryReviewRecords(storage())).toEqual({ status: "missing", store: null });
      expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    }

    expect(validPersonalGlossaryReviewMetadataBinding(GENERATION)).toBe(true);
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
    terminalize(first.record!, "2026-08-12T00:00:00.000Z");
    const pathname = personalGlossaryReviewRecordsPath(storage());

    expect(currentPersonalGlossaryReviewRecords(storage(), "2026-11-11T00:00:00.000Z")).toMatchObject({
      status: "current",
      records: [],
      expired_records: 1,
    });
    expect(maintainPersonalGlossaryReviewRecords({ ...storage(), now: "2026-11-11T00:00:00.000Z" })).toEqual({
      status: "changed",
      expired_records: 1,
    });
    expect(fs.existsSync(pathname)).toBe(false);
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    expect(fs.readFileSync(profilePath, "utf8")).toBe(profileBefore);

    const second = queue(capsule, projection, storage(), "2026-08-13T00:00:00.000Z");
    expect(second.status).toBe("queued");
    expect(maintainPersonalGlossaryReviewRecords({
      ...storage(),
      now: "2027-08-13T00:00:00.000Z",
    })).toEqual({ status: "unchanged", expired_records: 0 });
    expect(fs.existsSync(pathname)).toBe(true);
    expect(maintainPersonalGlossaryReviewRecords({
      ...storage(),
      now: "2026-08-13T00:00:00.000Z",
      current_user_purge_authorized: true,
    })).toEqual({ status: "purged", expired_records: 0 });
    expect(fs.existsSync(pathname)).toBe(false);
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    expect(fs.readFileSync(profilePath, "utf8")).toBe(profileBefore);
  });

  it("uses the configured user-local path with ordinary native filesystem behavior", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-review-target-"));
    const link = `${target}-link`;
    extraPaths.push(target, link);
    fs.symlinkSync(target, link, "dir");
    const capsule = candidate(6);
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
    })).toEqual({ status: "corrupt", expired_records: 0 });
    expect(fs.readFileSync(obstructed, "utf8")).toBe("host-owned obstruction");
  });
});

const SHA256 = /^[a-f0-9]{64}$/u;

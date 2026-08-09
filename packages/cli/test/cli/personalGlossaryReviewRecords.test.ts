import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  personalGlossaryReviewRecordsPath,
  type PersonalGlossaryReviewRecord,
} from "../../src/analytics/personalGlossaryReviewRecords.js";
import {
  personalGlossaryCandidateProjectionPath,
  persistPersonalGlossaryCandidateProjection,
  projectPersonalGlossaryCandidates,
  type PersonalGlossaryCandidateProjection,
} from "../../src/analytics/personalGlossaryCandidateProjection.js";
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

const GENERATION = "review-cli-generation";
const POLICY = "agentera.personalGlossaryMiningPolicy.v1";
const RETAINED_AT = "2026-08-10T00:00:00.000Z";
const ROOT = path.resolve(import.meta.dirname, "../../../..");
const COMMAND_SOURCE = path.join(ROOT, "packages/cli/src/cli/commands/personalGlossaryReviewRecords.ts");

let profileDir: string;
let previousProfileDir: string | undefined;
let previousProfileraProfileDir: string | undefined;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-review-cli-"));
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

function candidate(
  index: number,
  generation = GENERATION,
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
    generation,
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
  expect(result).toMatchObject({ rc: 0, err: "" });
  expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(4_096);
  return JSON.parse(result.out) as { record: PersonalGlossaryReviewRecord; status: string };
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

describe("agentera report personal-glossary-reviews", () => {
  it("documents private queue/list/get grammar, schema, and no-cutover access", () => {
    const help = printReportHelp();
    expect(help).toContain("personal-glossary-reviews queue --input <file|-> --format json");
    expect(help).toContain("personal-glossary-reviews list [--status pending|terminal]");
    expect(help).toContain("does not accept a user disposition");
    expect(requiresCompletedEntityCutover(["report", "personal-glossary-reviews", "list"])).toBe(false);
    expect((buildSchemaPayload().integration as any).personal_glossary.review_records).toMatchObject({
      command: "agentera report personal-glossary-reviews",
      queue: {
        request_schema_version: "agentera.personalGlossaryReviewQueueRequest.v1",
        decision_outcome: "review_required",
        statuses: ["queued", "unchanged_replay"],
      },
      persistence: {
        owner: "current_user",
        file: "review-records.json",
        records_max: 100,
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

  it("rejects unsafe queue metadata without persisting or echoing it", () => {
    const unsafeBindings = [
      ["/home/current-user/private-generation", POLICY],
      [GENERATION, "api_key=review-secret-123456"],
    ] as const;

    for (const [generation, policyVersion] of unsafeBindings) {
      const capsule = candidate(7, generation, policyVersion);
      const projection = persist([capsule]);
      const projectionPath = personalGlossaryCandidateProjectionPath();
      const projectionBefore = fs.readFileSync(projectionPath, "utf8");
      const result = run(
        ["report", "personal-glossary-reviews", "queue", "--input", "-", "--format", "json"],
        request(receipt(capsule, projection)),
      );

      expect(result).toMatchObject({ rc: 1, err: "" });
      expect(JSON.parse(result.out)).toMatchObject({ error: { class: "current_binding_mismatch" } });
      expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(4_096);
      expect(result.out).not.toContain(generation);
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
      GENERATION,
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

  it("uses bounded descriptor reads for untrusted queue input", () => {
    const source = fs.readFileSync(COMMAND_SOURCE, "utf8");
    expect(source).toContain("Buffer.allocUnsafe(maxBytes + 1)");
    expect(source).toContain("fs.lstatSync(source");
    expect(source).toContain("fs.fstatSync(descriptor");
    expect(source).toContain("fs.constants.O_NOFOLLOW");
    expect(source).not.toContain("fs.readFileSync(source");
    expect(source).not.toContain("fs.readFileSync(0");
  });
});

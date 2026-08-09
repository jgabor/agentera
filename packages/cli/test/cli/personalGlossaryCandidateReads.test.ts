import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  personalGlossaryCandidateProjectionPath,
  persistPersonalGlossaryCandidateProjection,
  projectPersonalGlossaryCandidates,
  type PersonalGlossaryProjectionCandidateInput,
} from "../../src/analytics/personalGlossaryCandidateProjection.js";
import { main } from "../../src/cli/dispatch.js";
import { printReportHelp } from "../../src/cli/help.js";
import { requiresCompletedEntityCutover } from "../../src/cli/migrationRequired.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { glossaryEntryAuthorityPath } from "../../src/registries/glossaryEntryContract.js";
import { createGlossaryEvidenceCapsule } from "../../src/registries/glossaryCandidateContracts.js";
import { decodeListCursor, encodeListCursor } from "../../src/state/listCursor.js";

const GENERATION = "candidate-read-generation";
const POLICY = "agentera.personalGlossaryMiningPolicy.v1";
const RETAINED_AT = "2026-08-10T00:00:00.000Z";

let profileDir: string;
let previousProfileDir: string | undefined;
let previousProfileraProfileDir: string | undefined;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-candidate-reads-"));
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

function explicit(index: number, generation = GENERATION, policy = POLICY) {
  return createGlossaryEvidenceCapsule({
    term: `candidate term ${String(index).padStart(3, "0")}`,
    meaning: `candidate meaning ${index}`,
    scope: "personal",
    provenance_kind: "personal_explicit_definition",
    evidence: [{
      source_id: `source-private-${index}`,
      evidence_anchor: `anchor-private-${index}`,
      signal_type: "decision",
    }],
    generation,
    policy_version: policy,
  });
}

function recurring(index: number, generation = GENERATION, policy = POLICY) {
  return createGlossaryEvidenceCapsule({
    term: `recurring term ${String(index).padStart(3, "0")}`,
    meaning: "meaning pending semantic review",
    scope: "ambiguous",
    provenance_kind: "personal_inferred_usage",
    evidence: [
      {
        source_id: `instruction-private-${index}`,
        evidence_anchor: `instruction-anchor-private-${index}`,
        source_kind: "instruction_document",
      },
      {
        source_id: `config-private-${index}`,
        evidence_anchor: `config-anchor-private-${index}`,
        source_kind: "project_config_signal",
      },
    ],
    generation,
    policy_version: policy,
  });
}

function conversation(count = 3, generation = GENERATION, policy = POLICY) {
  return createGlossaryEvidenceCapsule({
    term: "private conversation term",
    meaning: "A candidate supported by bounded user-authored conversation evidence.",
    scope: "ambiguous",
    provenance_kind: "personal_inferred_conversation",
    evidence: Array.from({ length: count }, (_, index) => ({
      source_id: `source-private-${index}`,
      evidence_anchor: `anchor-private-${index}`,
      source_kind: "conversation_turn",
      signal_type: "correction",
      session_id: `session-private-${index % 2}`,
      project_id: `project-private-${index % 2}`,
      content_fingerprint: index.toString(16).padStart(64, "0"),
      author_class: "user",
    })),
    generation,
    policy_version: policy,
  });
}

function candidate(
  capsule: ReturnType<typeof explicit>,
  projectIds: string[] = ["project-private"],
  excerpts: string[] = [],
): PersonalGlossaryProjectionCandidateInput {
  return { capsule, project_ids: projectIds, excerpts };
}

function persist(
  candidates: PersonalGlossaryProjectionCandidateInput[],
  generation = GENERATION,
  policy = POLICY,
) {
  const projection = projectPersonalGlossaryCandidates({
    generation,
    policy_version: policy,
    retained_at: RETAINED_AT,
    candidates,
  });
  persistPersonalGlossaryCandidateProjection(projection);
  return projection;
}

function run(args: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], {
    stdin: () => {
      throw new Error("candidate reads must not read stdin");
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

function listArgs(cursor?: string, extra: string[] = []): string[] {
  return [
    "report",
    "personal-glossary-candidates",
    "list",
    "--source-family",
    "explicit",
    "--provenance-kind",
    "personal_explicit_definition",
    "--scope",
    "personal",
    "--limit",
    "1",
    ...extra,
    ...(cursor ? ["--cursor", cursor] : []),
    "--format",
    "json",
  ];
}

function exactArgs(
  projection: ReturnType<typeof persist>,
  overrides: Partial<{
    candidateId: string;
    candidateRevision: string;
    generation: string;
    policyVersion: string;
  }> = {},
): string[] {
  const capsule = projection.candidates[0]!.capsule;
  return [
    "report",
    "personal-glossary-candidates",
    "get",
    "--candidate-id",
    overrides.candidateId ?? capsule.candidate_id,
    "--candidate-revision",
    overrides.candidateRevision ?? capsule.candidate_revision,
    "--generation",
    overrides.generation ?? projection.generation,
    "--policy-version",
    overrides.policyVersion ?? projection.policy_version,
    "--format",
    "json",
  ];
}

describe("agentera report personal-glossary-candidates", () => {
  it("discovers the private read contract through help and schema without requiring project state", () => {
    expect(printReportHelp()).toContain(
      "agentera report personal-glossary-candidates list [--source-family explicit|recurring]",
    );
    expect(requiresCompletedEntityCutover(["report", "personal-glossary-candidates", "list"])).toBe(false);
    expect(printReportHelp()).toContain("Safe context becomes unavailable at its 30-day expiry");
    expect((buildSchemaPayload().integration as any).personal_glossary.candidate_retrieval).toEqual({
      command: "agentera report personal-glossary-candidates",
      schema_version: "agentera.personalGlossaryCandidateRetrieval.v1",
      list: {
        default_limit: 20,
        maximum_limit: 50,
        max_serialized_utf8_bytes: 32768,
        order: "candidate_id_then_candidate_revision_then_capsule_sha256",
        projection_binding_field: "candidate_projection_sha256",
        source_families: ["explicit", "recurring"],
        provenance_kinds: [
          "personal_explicit_definition",
          "personal_inferred_conversation",
          "personal_inferred_usage",
        ],
        scopes: ["personal", "ambiguous"],
        cursor: {
          authority:
            "references/artifacts/state-storage-authority.yaml#entity_target.public_retrieval.policy.cursor",
          vocabulary: "opaque_snapshot_cursor",
          binding: [
            "collection",
            "generation",
            "policy_version",
            "filters",
            "limit",
            "order",
            "snapshot",
          ],
          invalid_behavior: "cursor_invalid",
          unavailable_behavior: "cursor_snapshot_unavailable",
        },
      },
      exact: {
        required_bindings: ["candidate_id", "candidate_revision", "generation", "policy_version"],
        projection_binding_field: "candidate_projection_sha256",
        occurrences_max: 100,
        safe_context_max_utf8_bytes: 500,
        max_serialized_utf8_bytes: 32768,
      },
      safe_context_view: {
        authority: "personal_mining_authority.privacy.retention",
        retention_days: 30,
        expiry: "expires_at_lte_read_time_is_unavailable",
        mutation: "forbidden",
        snapshot: "effective_availability_bound_to_opaque_cursor_snapshot",
      },
      project_checkout: "not_required",
    });
  });

  it("lists filtered bounded summaries, continuation, coverage, and projection-local abstentions without mutation", () => {
    persist([
      candidate(explicit(1), ["project-a"], ["candidate term 001 safe context."]),
      candidate(explicit(2), ["project-b"]),
      candidate(recurring(3), ["project-c"]),
    ]);
    const pathname = personalGlossaryCandidateProjectionPath();
    const before = fs.readFileSync(pathname, "utf8");

    const first = run(listArgs());
    expect(first).toMatchObject({ rc: 0, err: "" });
    const firstBody = JSON.parse(first.out);
    expect(firstBody).toMatchObject({
      schemaVersion: "agentera.personalGlossaryCandidateRetrieval.v1",
      command: "agentera report personal-glossary-candidates list",
      status: "degraded",
      generation: GENERATION,
      policy_version: POLICY,
      candidate_projection_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      counts: { total: 2, candidate: 2, returned: 1, remaining: 1, omitted: 1, continuation: 1 },
      filters: {
        source_family: "explicit",
        provenance_kind: "personal_explicit_definition",
        scope: "personal",
      },
      summary: {
        coverage: { status: "complete" },
        abstentions: {
          candidate_selection: { count: 0 },
          safe_context: { count: expect.any(Number) },
        },
      },
      omitted: true,
      omitted_count: 1,
      omission_reason: "page_limit",
      next_cursor: expect.any(String),
    });
    expect(firstBody.entries).toHaveLength(1);
    expect(firstBody.entries[0]).toEqual(expect.objectContaining({
      candidate_id: expect.stringMatching(/^[a-f0-9]{64}$/),
      candidate_revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      occurrence_count: 1,
    }));
    expect(first.out).not.toContain("candidate meaning");
    expect(first.out).not.toContain("project-a");
    expect(first.out).not.toContain("source-private");

    const second = run(listArgs(firstBody.next_cursor));
    expect(second).toMatchObject({ rc: 0, err: "" });
    const secondBody = JSON.parse(second.out);
    expect(secondBody).toMatchObject({
      status: "ok",
      counts: { total: 2, returned: 1, remaining: 0, omitted: 0, continuation: 0 },
      snapshot: { first_page: false, has_more: false },
    });
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
  });

  it("derives expiry-aware list and exact safe-context views without mutating the projection", () => {
    const projection = persist([
      candidate(explicit(1), ["project-a"], ["candidate term 001 expiry-only safe context"]),
      candidate(explicit(2), ["project-b"], ["candidate term 002 second safe context"]),
    ]);
    const pathname = personalGlossaryCandidateProjectionPath();
    const beforeBytes = fs.readFileSync(pathname, "utf8");
    const firstCandidate = projection.candidates[0]!;
    const safeContext = firstCandidate.safe_excerpt!;

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.parse(safeContext.expires_at) - 1));
      const beforeListResult = run(listArgs());
      expect(beforeListResult).toMatchObject({ rc: 0, err: "" });
      const beforeList = JSON.parse(beforeListResult.out);
      expect(beforeList).toMatchObject({
        entries: [expect.objectContaining({ safe_context_available: true })],
        summary: { abstentions: { safe_context: { available: 2, count: 0, expired: 0 } } },
        next_cursor: expect.any(String),
      });

      const beforeExactResult = run(exactArgs(projection));
      expect(beforeExactResult).toMatchObject({ rc: 0, err: "" });
      expect(JSON.parse(beforeExactResult.out).entry.safe_context).toMatchObject({
        text: safeContext.text,
        expires_at: safeContext.expires_at,
      });

      vi.setSystemTime(new Date(safeContext.expires_at));
      const afterListResult = run(listArgs());
      expect(afterListResult).toMatchObject({ rc: 0, err: "" });
      const afterList = JSON.parse(afterListResult.out);
      expect(afterList.entries[0]).toEqual(
        expect.objectContaining({ safe_context_available: false }),
      );
      expect(afterList.summary.abstentions.safe_context).toMatchObject({
        available: 0,
        count: 2,
        expired: 2,
      });
      expect(
        afterList.summary.abstentions.safe_context.available +
          afterList.summary.abstentions.safe_context.count,
      ).toBe(afterList.summary.retained_count);
      expect(afterListResult.out).not.toContain(safeContext.text);

      const afterExactResult = run(exactArgs(projection));
      expect(afterExactResult).toMatchObject({ rc: 0, err: "" });
      expect(JSON.parse(afterExactResult.out).entry.safe_context).toBeNull();
      expect(afterExactResult.out).not.toContain(safeContext.text);

      const resumed = run(listArgs(beforeList.next_cursor));
      expect(resumed).toMatchObject({ rc: 1, err: "" });
      expect(JSON.parse(resumed.out)).toMatchObject({
        status: "fail",
        error: { class: "cursor_snapshot_unavailable" },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(fs.readFileSync(pathname, "utf8")).toBe(beforeBytes);
  });

  it("reports bounded projection-local selection abstentions and coverage instead of reconstructing upstream abstentions", () => {
    persist(Array.from({ length: 51 }, (_, index) => candidate(explicit(index))));

    const result = run([
      "report",
      "personal-glossary-candidates",
      "list",
      "--limit",
      "50",
      "--format",
      "json",
    ]);

    expect(result).toMatchObject({ rc: 0, err: "" });
    const body = JSON.parse(result.out);
    expect(body).toMatchObject({
      status: "degraded",
      summary: {
        retained_count: 50,
        dropped_count: 1,
        coverage: { status: "degraded", reasons: ["candidate_cap"] },
        abstentions: { candidate_selection: { count: 1, reasons: ["candidate_cap"] } },
      },
    });
    expect(body.counts).toMatchObject({ total: 50, returned: 50, remaining: 0 });
    expect(body.summary.abstentions).not.toHaveProperty("entries");
  });

  it.each([
    ["source family", ["--source-family", "unknown"], "invalid_choice"],
    ["provenance kind", ["--provenance-kind", "project_file"], "invalid_choice"],
    ["scope", ["--scope", "project"], "invalid_choice"],
    ["limit", ["--limit", "51"], "invalid_request"],
    ["cursor", ["--cursor", "x".repeat(4097)], "invalid_request"],
  ])("rejects invalid %s filters or bounds before projection effects", (_name, extra, errorClass) => {
    persist([candidate(explicit(1)), candidate(explicit(2))]);
    const pathname = personalGlossaryCandidateProjectionPath();
    const before = fs.readFileSync(pathname, "utf8");
    const result = run([
      "report",
      "personal-glossary-candidates",
      "list",
      ...extra,
      "--format",
      "json",
    ]);

    expect(result).toMatchObject({ rc: 2, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({ status: "fail", error: { class: errorClass } });
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
  });

  it("fails closed for malformed, filter- or limit-mismatched, and order-mismatched cursors", () => {
    persist([candidate(explicit(1)), candidate(explicit(2)), candidate(recurring(3))]);
    const pathname = personalGlossaryCandidateProjectionPath();
    const before = fs.readFileSync(pathname, "utf8");
    const first = JSON.parse(run(listArgs()).out);
    const decoded = decodeListCursor(
      first.next_cursor,
      personalGlossaryCandidateProjectionPath(),
      glossaryEntryAuthorityPath(),
    );
    const changedOrder = encodeListCursor(
      { ...decoded, order: "term_asc" },
      personalGlossaryCandidateProjectionPath(),
      glossaryEntryAuthorityPath(),
    );
    const cases = [
      ["malformed", listArgs("not-a-cursor"), "cursor_invalid"],
      [
        "source-family mismatch",
        [
          "report", "personal-glossary-candidates", "list", "--source-family", "recurring", "--limit", "1", "--cursor", first.next_cursor, "--format", "json",
        ],
        "cursor_invalid",
      ],
      [
        "provenance-kind mismatch",
        [
          "report", "personal-glossary-candidates", "list", "--source-family", "explicit", "--provenance-kind", "personal_inferred_usage", "--scope", "personal", "--limit", "1", "--cursor", first.next_cursor, "--format", "json",
        ],
        "cursor_invalid",
      ],
      [
        "scope mismatch",
        [
          "report", "personal-glossary-candidates", "list", "--source-family", "explicit", "--provenance-kind", "personal_explicit_definition", "--scope", "ambiguous", "--limit", "1", "--cursor", first.next_cursor, "--format", "json",
        ],
        "cursor_invalid",
      ],
      [
        "limit mismatch",
        [
          "report", "personal-glossary-candidates", "list", "--source-family", "explicit", "--provenance-kind", "personal_explicit_definition", "--scope", "personal", "--limit", "2", "--cursor", first.next_cursor, "--format", "json",
        ],
        "cursor_invalid",
      ],
      ["order mismatch", listArgs(changedOrder), "cursor_snapshot_unavailable"],
    ] as const;

    for (const [_name, args, errorClass] of cases) {
      const result = run(args);
      expect(result).toMatchObject({ rc: 1, err: "" });
      expect(JSON.parse(result.out)).toMatchObject({ status: "fail", error: { class: errorClass } });
      expect(result.out).not.toContain("candidate term");
    }
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
  });

  it.each([
    ["generation", "next-generation", POLICY],
    ["policy", GENERATION, "agentera.personalGlossaryMiningPolicy.v2"],
  ])("fails closed when a continuation crosses %s", (_name, generation, policy) => {
    persist([candidate(explicit(1)), candidate(explicit(2))]);
    const first = JSON.parse(run(listArgs()).out);
    const next = persist([
      candidate(explicit(1, generation, policy)),
      candidate(explicit(2, generation, policy)),
    ], generation, policy);
    const pathname = personalGlossaryCandidateProjectionPath();
    const before = fs.readFileSync(pathname, "utf8");

    const result = run(listArgs(first.next_cursor));
    expect(result).toMatchObject({ rc: 1, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({
      status: "fail",
      error: { class: "cursor_snapshot_unavailable" },
    });
    expect(result.out).not.toContain(next.candidates[0]!.capsule.term);
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
  });

  it("returns only opaque validated occurrences and safe context for one current exact binding without mutation", () => {
    const projection = persist([
      candidate(
        conversation(),
        ["project-private-one", "project-private-two"],
        ["private conversation term has safe review context."],
      ),
    ]);
    const pathname = personalGlossaryCandidateProjectionPath();
    const before = fs.readFileSync(pathname, "utf8");

    const result = run(exactArgs(projection));
    expect(result).toMatchObject({ rc: 0, err: "" });
    const body = JSON.parse(result.out);
    expect(body).toMatchObject({
      status: "ok",
      generation: GENERATION,
      policy_version: POLICY,
      candidate_projection_sha256: projection.projection_sha256,
      entry: {
        occurrence_count: 3,
        safe_context: {
          text: "private conversation term has safe review context.",
          redacted: false,
        },
      },
    });
    expect(body.entry.occurrences).toHaveLength(3);
    expect(body.entry.occurrences[0]).toEqual({
      occurrence_id: expect.stringMatching(/^[a-f0-9]{64}$/),
      source_kind: "conversation_turn",
      signal_type: "correction",
      author_class: "user",
    });
    for (const leaked of [
      "source-private",
      "anchor-private",
      "session-private",
      "project-private",
      "content_fingerprint",
      "project_keys",
    ]) {
      expect(result.out).not.toContain(leaked);
    }
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
  });

  it("keeps the exact occurrence and context bounds whole", () => {
    const projection = persist([
      candidate(
        conversation(100),
        ["project-one", "project-two"],
        [`private conversation term ${"x".repeat(470)}`],
      ),
    ]);

    const result = run(exactArgs(projection));
    expect(result).toMatchObject({ rc: 0, err: "" });
    const body = JSON.parse(result.out);
    expect(body.entry.occurrences).toHaveLength(100);
    expect(Buffer.byteLength(body.entry.safe_context.text, "utf8")).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(32_768);
  });

  it.each([
    ["stale revision", { candidateRevision: "f".repeat(64) }, 1, "current_binding_mismatch"],
    ["unknown identity", { candidateId: "0".repeat(64) }, 1, "not_found"],
    ["mismatched generation", { generation: "other-generation" }, 1, "current_binding_mismatch"],
    ["mismatched policy", { policyVersion: "other-policy" }, 1, "current_binding_mismatch"],
    ["malformed revision", { candidateRevision: "not-a-revision" }, 2, "invalid_request"],
  ])("fails closed for a %s exact read without candidate disclosure or mutation", (_name, overrides, code, errorClass) => {
    const projection = persist([candidate(conversation())]);
    const pathname = personalGlossaryCandidateProjectionPath();
    const before = fs.readFileSync(pathname, "utf8");
    const result = run(exactArgs(projection, overrides));

    expect(result).toMatchObject({ rc: code, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({ status: "fail", error: { class: errorClass } });
    expect(result.out).not.toContain("private conversation term");
    expect(result.out).not.toContain("project-private");
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
  });

  it("uses JSON stdout and documented exit codes without reading stdin", () => {
    const missing = run([
      "report",
      "personal-glossary-candidates",
      "list",
      "--format",
      "json",
    ]);
    expect(missing).toMatchObject({ rc: 1, err: "" });
    expect(JSON.parse(missing.out)).toMatchObject({
      status: "fail",
      error: { class: "projection_unavailable" },
    });

    const invalid = run([
      "report",
      "personal-glossary-candidates",
      "list",
      "--format",
      "yaml",
    ]);
    expect(invalid).toMatchObject({ rc: 2, err: "" });
    expect(JSON.parse(invalid.out)).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      status: "fail",
      error: { class: "invalid_choice" },
    });
  });
});

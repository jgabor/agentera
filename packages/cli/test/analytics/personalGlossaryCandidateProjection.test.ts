import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  maintainPersonalGlossaryCandidateProjection,
  personalGlossaryCandidateProjectionPath,
  persistPersonalGlossaryCandidateProjection,
  projectPersonalGlossaryCandidates,
  readPersonalGlossaryCandidateProjection,
  type PersonalGlossaryProjectionCandidateInput,
} from "../../src/analytics/personalGlossaryCandidateProjection.js";
import {
  canonicalGlossaryJson,
  glossaryCanonicalSha256,
} from "../../src/registries/glossaryTermIdentity.js";
import { createGlossaryEvidenceCapsule } from "../../src/registries/glossaryCandidateContracts.js";

const GENERATION = "generation-candidate-projection";
const POLICY = "agentera.personalGlossaryMiningPolicy.v1";
const RETAINED_AT = "2026-08-01T00:00:00.000Z";

let profileDir: string;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-projection-"));
});

afterEach(() => fs.rmSync(profileDir, { recursive: true, force: true }));

function explicit(index: number, generation = GENERATION, policy = POLICY) {
  return createGlossaryEvidenceCapsule({
    term: `explicit-${String(index).padStart(3, "0")}`,
    meaning: `explicit meaning ${index}`,
    scope: "personal",
    provenance_kind: "personal_explicit_definition",
    evidence: [
      {
        source_id: `explicit-source-${index}`,
        evidence_anchor: `explicit-anchor-${index}`,
        signal_type: "decision",
      },
    ],
    policy_version: policy,
    generation,
  });
}

function recurring(index: number) {
  return createGlossaryEvidenceCapsule({
    term: `recurring-${String(index).padStart(3, "0")}`,
    meaning: "meaning pending semantic review",
    scope: "ambiguous",
    provenance_kind: "personal_inferred_usage",
    evidence: [
      {
        source_id: `recurring-config-${index}`,
        evidence_anchor: `recurring-config-anchor-${index}`,
        source_kind: "project_config_signal",
      },
      {
        source_id: `recurring-instruction-${index}`,
        evidence_anchor: `recurring-instruction-anchor-${index}`,
        source_kind: "instruction_document",
      },
    ],
    policy_version: POLICY,
    generation: GENERATION,
  });
}

function candidate(
  capsule: ReturnType<typeof explicit>,
  projectIds: readonly string[],
  excerpts: readonly string[] = [],
): PersonalGlossaryProjectionCandidateInput {
  return { capsule, project_ids: projectIds, excerpts };
}

function input(
  candidates: readonly PersonalGlossaryProjectionCandidateInput[],
  retainedAt = RETAINED_AT,
) {
  return {
    generation: GENERATION,
    policy_version: POLICY,
    retained_at: retainedAt,
    candidates,
  };
}

function storageOptions() {
  return { env: { AGENTERA_PROFILE_DIR: profileDir } };
}

function rehashProjection<T extends Record<string, unknown>>(projection: T): T {
  const { projection_sha256: _digest, ...body } = projection;
  return { ...body, projection_sha256: glossaryCanonicalSha256(body) } as T;
}

describe("bounded personal glossary candidate projection", () => {
  it("allocates capped candidates deterministically, retains both families, and reports ties and coverage", () => {
    const candidates = [
      ...Array.from({ length: 51 }, (_, index) => candidate(explicit(index), ["project-abundant"])),
      candidate(recurring(1), ["project-recurring-a"]),
      candidate(recurring(2), ["project-recurring-b"]),
    ];

    const first = projectPersonalGlossaryCandidates(input(candidates));
    const replay = projectPersonalGlossaryCandidates(
      input(
        candidates
          .map((item) => ({ ...item, project_ids: [...item.project_ids].reverse() }))
          .reverse(),
      ),
    );

    expect(canonicalGlossaryJson(replay)).toBe(canonicalGlossaryJson(first));
    expect(first.report).toMatchObject({
      input_count: 53,
      duplicate_count: 0,
      unique_count: 53,
      retained_count: 50,
      dropped_count: 3,
      cap: { maximum: 50, applied: true },
      allocation: {
        algorithm: "least_retained_source_family_then_project_then_canonical_candidate",
        tie_break: "candidate_id_then_candidate_revision_then_capsule_sha256",
      },
      projects: { available: 3, retained: 3, dropped: 0 },
      coverage: { status: "degraded", reasons: ["candidate_cap"] },
    });
    expect(first.report.allocation.tie_breaks_resolved).toBeGreaterThan(0);
    expect(first.report.source_families).toEqual([
      { family: "explicit", available: 51, retained: 48, dropped: 3 },
      { family: "recurring", available: 2, retained: 2, dropped: 0 },
    ]);
    expect(first.candidates.map((item) => item.capsule.candidate_id)).toEqual(
      [...first.candidates.map((item) => item.capsule.candidate_id)].sort(),
    );
  });

  it("fails closed when a candidate exceeds the declared project-diversity bound", () => {
    expect(() =>
      projectPersonalGlossaryCandidates(
        input([
          candidate(
            explicit(1),
            Array.from({ length: 101 }, (_, index) => `project-${index}`),
          ),
        ]),
      ),
    ).toThrow("candidate project identities are outside their bound");
  });

  it("enforces the project cap after merging duplicate candidates", () => {
    const capsule = explicit(150);
    const projectIds = Array.from({ length: 101 }, (_, index) => `project-merged-${index}`);
    const exact = projectPersonalGlossaryCandidates(
      input([
        candidate(capsule, projectIds.slice(0, 50)),
        candidate(capsule, projectIds.slice(50, 100)),
      ]),
    );

    expect(exact.report.duplicate_count).toBe(1);
    expect(exact.candidates[0]?.project_keys).toHaveLength(100);
    expect(() =>
      projectPersonalGlossaryCandidates(
        input([
          candidate(capsule, projectIds.slice(0, 50)),
          candidate(capsule, projectIds.slice(50)),
        ]),
      ),
    ).toThrow("candidate project identities are outside their bound");
  });

  it("redacts quoted JSON sensitive keys and omits an unsafe incomplete structure", () => {
    const capsule = explicit(175);
    const rawPassword = "raw-password-987";
    const rawSession = "sid987654";
    const projection = projectPersonalGlossaryCandidates(
      input([
        candidate(
          capsule,
          ["project-json"],
          [`${capsule.term} {"password":"${rawPassword}","sessionId":"${rawSession}"}`],
        ),
      ]),
    );

    expect(canonicalGlossaryJson(projection)).not.toContain(rawPassword);
    expect(canonicalGlossaryJson(projection)).not.toContain(rawSession);
    const persisted = persistPersonalGlossaryCandidateProjection(projection, storageOptions());
    expect(fs.readFileSync(persisted.path, "utf8")).not.toContain(rawPassword);
    expect(fs.readFileSync(persisted.path, "utf8")).not.toContain(rawSession);

    const malformed = projectPersonalGlossaryCandidates(
      input([candidate(capsule, ["project-json"], [`${capsule.term} {"password":`])]),
    );
    expect(malformed.candidates[0]?.safe_excerpt).toBeNull();
    expect(malformed.report.excerpts.omissions.unsafe_content).toBe(1);
  });

  it.each([
    [
      "capsule generation",
      (projection: any) => {
        projection.candidates[0].capsule = explicit(190, "stale-generation");
      },
    ],
    [
      "capsule policy",
      (projection: any) => {
        projection.candidates[0].capsule = explicit(190, GENERATION, "stale-policy");
      },
    ],
    [
      "merged project cap",
      (projection: any) => {
        projection.candidates[0].project_keys = Array.from({ length: 101 }, (_, index) =>
          `${index}`.padStart(64, "0"),
        );
      },
    ],
    [
      "report counts",
      (projection: any) => {
        projection.report.retained_count = 2;
      },
    ],
    [
      "coverage",
      (projection: any) => {
        projection.report.coverage = {
          status: "degraded",
          reasons: ["candidate_cap"],
          uncovered_source_families: [],
          uncovered_projects: 0,
        };
      },
    ],
    [
      "excerpt totals",
      (projection: any) => {
        projection.report.excerpts.retained = 1;
      },
    ],
  ])("rejects a digest-valid persisted %s contradiction without effects", (_name, mutate) => {
    const projection = projectPersonalGlossaryCandidates(
      input([candidate(explicit(190), ["project-persisted"])]),
    );
    const persisted = persistPersonalGlossaryCandidateProjection(projection, storageOptions());
    const tampered = rehashProjection(structuredClone(projection));
    mutate(tampered);
    const digestValid = rehashProjection(tampered);
    const bytes = `${canonicalGlossaryJson(digestValid)}\n`;
    fs.writeFileSync(persisted.path, bytes, "utf8");

    expect(readPersonalGlossaryCandidateProjection(storageOptions())).toEqual({
      status: "corrupt",
      projection: null,
    });
    expect(() => persistPersonalGlossaryCandidateProjection(projection, storageOptions())).toThrow(
      "stored candidate projection is corrupt",
    );
    expect(fs.readFileSync(persisted.path, "utf8")).toBe(bytes);
  });

  it("rejects digest-valid candidate order and uniqueness contradictions", () => {
    const projection = projectPersonalGlossaryCandidates(
      input([
        candidate(explicit(191), ["project-order-a"]),
        candidate(explicit(192), ["project-order-b"]),
      ]),
    );
    const persisted = persistPersonalGlossaryCandidateProjection(projection, storageOptions());
    const reversed = rehashProjection({
      ...structuredClone(projection),
      candidates: [...projection.candidates].reverse(),
    });
    fs.writeFileSync(persisted.path, `${canonicalGlossaryJson(reversed)}\n`, "utf8");
    expect(readPersonalGlossaryCandidateProjection(storageOptions()).status).toBe("corrupt");

    const duplicate = rehashProjection({
      ...structuredClone(projection),
      candidates: [projection.candidates[0]!, projection.candidates[0]!],
    });
    fs.writeFileSync(persisted.path, `${canonicalGlossaryJson(duplicate)}\n`, "utf8");
    expect(readPersonalGlossaryCandidateProjection(storageOptions()).status).toBe("corrupt");
  });

  it("preserves and repairs the private mode for unchanged replay", () => {
    const projection = projectPersonalGlossaryCandidates(
      input([candidate(explicit(195), ["project-mode"])]),
    );
    const persisted = persistPersonalGlossaryCandidateProjection(projection, storageOptions());
    expect(fs.statSync(persisted.path).mode & 0o777).toBe(0o600);
    expect(persistPersonalGlossaryCandidateProjection(projection, storageOptions()).status).toBe(
      "unchanged_replay",
    );

    fs.chmodSync(persisted.path, 0o644);
    expect(persistPersonalGlossaryCandidateProjection(projection, storageOptions()).status).toBe(
      "unchanged_replay",
    );
    expect(fs.statSync(persisted.path).mode & 0o777).toBe(0o600);
  });

  it("redacts and persists only safe candidate-adjacent excerpts while omitting unsafe context", () => {
    const capsule = explicit(200);
    const projection = projectPersonalGlossaryCandidates(
      input([
        candidate(
          capsule,
          ["private-project"],
          [
            `${capsule.term} uses API_KEY=top-secret for jane@example.com from /home/jane/session-abc.`,
          ],
        ),
      ]),
    );
    const safe = projection.candidates[0]!.safe_excerpt;

    expect(safe).toMatchObject({ redacted: true, expires_at: "2026-08-31T00:00:00.000Z" });
    expect(safe?.text).toContain("[REDACTED]");
    expect(safe?.text).not.toMatch(/top-secret|jane@example\.com|\/home\/jane|session-abc/);
    expect(canonicalGlossaryJson(projection)).not.toContain("private-project");
    expect(projection.report.excerpts).toMatchObject({ retained: 1, redacted: 1 });

    const persisted = persistPersonalGlossaryCandidateProjection(projection, storageOptions());
    expect(persisted.status).toBe("changed");
    expect(fs.statSync(persisted.path).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(persisted.path, "utf8")).not.toMatch(
      /top-secret|jane@example\.com|\/home\/jane|session-abc|private-project/,
    );
    expect(persistPersonalGlossaryCandidateProjection(projection, storageOptions()).status).toBe(
      "unchanged_replay",
    );
    expect(readPersonalGlossaryCandidateProjection(storageOptions())).toEqual({
      status: "current",
      projection,
    });

    const unsafe = projectPersonalGlossaryCandidates(
      input([
        candidate(
          capsule,
          ["private-project"],
          [`${capsule.term} tool arguments: {"token":"do-not-retain"}`],
        ),
      ]),
    );
    expect(unsafe.candidates[0]!.safe_excerpt).toBeNull();
    expect(unsafe.report.excerpts.omissions.unsafe_tool_arguments).toBe(1);

    const bounded = projectPersonalGlossaryCandidates(
      input([
        candidate(
          capsule,
          ["private-project"],
          [
            `${capsule.term}\n${"x".repeat(600)}`,
            `${capsule.term} alternate context that must not become a second excerpt.`,
          ],
        ),
      ]),
    );
    expect(Buffer.byteLength(bounded.candidates[0]!.safe_excerpt!.text, "utf8")).toBe(500);
    expect(bounded.report.excerpts.truncated).toBe(1);

    const omitted = projectPersonalGlossaryCandidates(
      input([candidate(capsule, ["private-project"], ["unrelated context"])]),
    );
    expect(omitted.candidates[0]!.safe_excerpt).toBeNull();
    expect(omitted.report.excerpts.omissions.unrelated_context).toBe(1);

    const oversized = projectPersonalGlossaryCandidates(
      input([candidate(capsule, ["private-project"], [`${capsule.term} ${"x".repeat(4096)}`])]),
    );
    expect(oversized.candidates[0]!.safe_excerpt).toBeNull();
    expect(oversized.report.excerpts.omissions.source_bound_exceeded).toBe(1);

    fs.writeFileSync(persisted.path, '{"unexpected":"candidate projection"}\n', "utf8");
    expect(readPersonalGlossaryCandidateProjection(storageOptions())).toEqual({
      status: "corrupt",
      projection: null,
    });
    expect(() => persistPersonalGlossaryCandidateProjection(projection, storageOptions())).toThrow(
      "stored candidate projection is corrupt",
    );
  });

  it("expires safe excerpts and applies the local-host-authorized purge without a public read surface", () => {
    const capsule = explicit(300);
    const projection = projectPersonalGlossaryCandidates(
      input([candidate(capsule, ["project-retention"], [`${capsule.term} is review context.`])]),
    );
    persistPersonalGlossaryCandidateProjection(projection, storageOptions());

    expect(
      maintainPersonalGlossaryCandidateProjection({
        ...storageOptions(),
        now: "2026-08-31T00:00:00.000Z",
      }),
    ).toEqual({ status: "changed", expired_excerpts: 1 });
    const expired = readPersonalGlossaryCandidateProjection(storageOptions());
    expect(expired.status).toBe("current");
    expect(expired.projection?.candidates[0]?.safe_excerpt).toBeNull();
    expect(expired.projection?.report.excerpts).toMatchObject({ retained: 0, expired: 1 });
    expect(() =>
      maintainPersonalGlossaryCandidateProjection({ ...storageOptions(), now: "not-a-time" }),
    ).toThrow("maintenance now must be an ISO timestamp");

    expect(
      maintainPersonalGlossaryCandidateProjection({
        ...storageOptions(),
        now: "2026-09-01T00:00:00.000Z",
        current_user_purge_authorized: true,
      }),
    ).toEqual({ status: "purged", expired_excerpts: 0 });
    expect(readPersonalGlossaryCandidateProjection(storageOptions())).toEqual({
      status: "missing",
      projection: null,
    });
    expect(fs.existsSync(personalGlossaryCandidateProjectionPath(storageOptions()))).toBe(false);
  });
});

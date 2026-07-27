import { describe, expect, it } from "vitest";

import {
  classifyGlossaryAdviceInputs,
  GlossaryAdviceInputError,
  resolveGlossaryAdvice,
  type GlossaryAdviceHostReview,
} from "../../src/analytics/glossaryAdviceResolution.js";
import type {
  AcquiredGlossaryInputs,
  ConsumerGlossaryEntry,
  GlossaryAvailability,
  GlossaryInputAvailability,
} from "../../src/analytics/glossaryInputAcquisition.js";
import { glossaryAdviceContract } from "../../src/registries/glossaryAdviceContract.js";
import { glossaryAcquisitionContract } from "../../src/registries/glossaryEntryContract.js";

const REQUESTED = "Ship Shape";

function source(
  owner: "project" | "personal",
  availability: GlossaryAvailability,
  entries: ConsumerGlossaryEntry[] = [],
): GlossaryInputAvailability {
  const valid = ["absent", "valid_empty", "valid_present"].includes(availability);
  return {
    owner,
    availability,
    entries,
    gap_proving: owner === "project" && ["absent", "valid_empty"].includes(availability),
    diagnostic: valid
      ? null
      : {
          class: availability,
          recovery: "Repair the unavailable glossary source and retry advice resolution.",
        },
  };
}

function entry(
  owner: "project" | "personal",
  term: string,
  meaning: string,
): ConsumerGlossaryEntry {
  return { owner, term, meaning };
}

function acquired(
  project: GlossaryInputAvailability,
  personal: GlossaryInputAvailability,
): AcquiredGlossaryInputs {
  return { project, personal };
}

function projectExact(meaning = "Project meaning"): GlossaryInputAvailability {
  return source("project", "valid_present", [entry("project", REQUESTED, meaning)]);
}

function projectGap(): GlossaryInputAvailability {
  return source("project", "valid_present", [entry("project", "Other project term", "Other")]);
}

function personalExact(meaning = "Personal meaning"): GlossaryInputAvailability {
  return source("personal", "valid_present", [entry("personal", "ship shape", meaning)]);
}

function personalCandidate(): GlossaryInputAvailability {
  return source("personal", "valid_present", [
    entry("personal", "Ready to sail", "A potentially equivalent personal meaning"),
  ]);
}

const inferredReview: GlossaryAdviceHostReview = {
  relation: "inferred_equivalence",
  candidate_owner: "personal",
  candidate_term: "Ready to sail",
};

describe("shared glossary advice resolution", () => {
  it("loads the active runtime, host-review vocabulary, output schema, and failure classes from authority", () => {
    const contract = glossaryAdviceContract();
    expect(contract).toMatchObject({
      implementation: "active",
      runtime: "packages/cli/src/analytics/glossaryAdviceResolution.ts#resolveGlossaryAdvice",
      hostReviewRelations: ["inferred_equivalence"],
      hostReviewCandidateOwners: ["personal"],
      schemaVersion: "agentera.glossaryAdvice.v1",
      outputFields: [
        "outcome",
        "applicable_meaning",
        "applicable_owner",
        "review",
        "tension",
        "advisory",
      ],
      failureClasses: ["invalid_request", "invalid_acquisition", "invalid_host_review"],
    });
    expect(contract.maxRequestedTermUtf8Bytes).toBe(
      glossaryAcquisitionContract().maxSourceUtf8Bytes,
    );
  });

  it.each([
    {
      name: "invalid project authority",
      inputs: acquired(source("project", "malformed"), personalExact()),
      expected: {
        outcome: "invalid_or_unavailable_project",
        applicable_meaning: null,
        applicable_owner: null,
        review: "unavailable",
        tension: "authority_unavailable",
        advisory: null,
      },
    },
    {
      name: "equivalent exact collision",
      inputs: acquired(projectExact("Same"), personalExact("Same")),
      expected: {
        outcome: "equivalent_exact_collision",
        applicable_meaning: "Same",
        applicable_owner: "project",
        review: "none",
        tension: "none",
        advisory: null,
      },
    },
    {
      name: "divergent exact collision",
      inputs: acquired(projectExact(), personalExact()),
      expected: {
        outcome: "divergent_exact_collision",
        applicable_meaning: "Project meaning",
        applicable_owner: "project",
        review: "none",
        tension: "divergent_exact_collision",
        advisory: null,
      },
    },
    {
      name: "project exact only",
      inputs: acquired(projectExact(), source("personal", "valid_empty")),
      expected: {
        outcome: "project_only",
        applicable_meaning: "Project meaning",
        applicable_owner: "project",
        review: "none_for_primary",
        tension: "none",
        advisory: null,
      },
    },
    {
      name: "personal fallback across a valid nonmatching project",
      inputs: acquired(projectGap(), personalExact()),
      expected: {
        outcome: "proven_project_gap",
        applicable_meaning: "Personal meaning",
        applicable_owner: "personal",
        review: "none",
        tension: "none",
        advisory: null,
      },
    },
    {
      name: "inferred candidate across a proven gap",
      inputs: acquired(projectGap(), personalCandidate()),
      hostReview: inferredReview,
      expected: {
        outcome: "inferred_equivalence",
        applicable_meaning: null,
        applicable_owner: null,
        review: "required_when_meaning_sensitive",
        tension: "inferred_equivalence",
        advisory: null,
      },
    },
    {
      name: "personal unavailable across a proven gap",
      inputs: acquired(source("project", "absent"), source("personal", "over_bound")),
      expected: {
        outcome: "invalid_or_unavailable_personal",
        applicable_meaning: null,
        applicable_owner: null,
        review: "unavailable",
        tension: "input_unavailable",
        advisory: null,
      },
    },
    {
      name: "no applicable entry",
      inputs: acquired(source("project", "valid_empty"), personalCandidate()),
      expected: {
        outcome: "no_applicable_entry",
        applicable_meaning: null,
        applicable_owner: null,
        review: "none",
        tension: "none",
        advisory: null,
      },
    },
  ])("implements $name", ({ inputs, hostReview, expected }) => {
    expect(resolveGlossaryAdvice(REQUESTED, inputs, hostReview)).toEqual(expected);
  });

  it("keeps exact project authority while reporting each bounded orthogonal advisory", () => {
    expect(
      resolveGlossaryAdvice(REQUESTED, acquired(projectExact(), source("personal", "unreadable"))),
    ).toEqual({
      outcome: "project_only",
      applicable_meaning: "Project meaning",
      applicable_owner: "project",
      review: "none_for_primary",
      tension: "none",
      advisory: {
        reason: "personal_input_unavailable",
        ownership_state: "project_governs_exact",
      },
    });

    expect(
      resolveGlossaryAdvice(
        REQUESTED,
        acquired(projectExact(), personalCandidate()),
        inferredReview,
      ),
    ).toEqual({
      outcome: "project_only",
      applicable_meaning: "Project meaning",
      applicable_owner: "project",
      review: "required_when_the_inferred_relation_is_meaning_sensitive",
      tension: "none",
      advisory: {
        reason: "inferred_equivalence",
        ownership_state: "project_governs_exact",
      },
    });
  });

  it("uses case-insensitive exact term identity and exact-string meaning equality", () => {
    const equal = acquired(
      source("project", "valid_present", [entry("project", "SHIP SHAPE", "Same")]),
      source("personal", "valid_present", [entry("personal", "ship shape", "Same")]),
    );
    expect(resolveGlossaryAdvice("Ship Shape", equal).outcome).toBe("equivalent_exact_collision");

    equal.personal.entries[0]!.meaning = "Same ";
    expect(resolveGlossaryAdvice("ship shape", equal).outcome).toBe("divergent_exact_collision");
  });

  it("uses Unicode caseless-exact identity for Greek authority, collisions, duplicates, and host candidates", () => {
    const greekProject = source("project", "valid_present", [
      entry("project", "ΟΣ", "Project Greek meaning"),
    ]);
    expect(
      resolveGlossaryAdvice("οσ", acquired(greekProject, source("personal", "valid_empty"))),
    ).toMatchObject({ outcome: "project_only", applicable_meaning: "Project Greek meaning" });
    expect(
      resolveGlossaryAdvice(
        "οσ",
        acquired(
          greekProject,
          source("personal", "valid_present", [
            entry("personal", "ος", "Divergent personal meaning"),
          ]),
        ),
      ),
    ).toMatchObject({
      outcome: "divergent_exact_collision",
      applicable_owner: "project",
      tension: "divergent_exact_collision",
    });

    expect(() =>
      resolveGlossaryAdvice(
        "other",
        acquired(
          source("project", "valid_present", [
            entry("project", "ΟΣ", "One"),
            entry("project", "οσ", "Two"),
          ]),
          source("personal", "absent"),
        ),
      ),
    ).toThrow(GlossaryAdviceInputError);

    expect(
      resolveGlossaryAdvice(
        "requested",
        acquired(
          source("project", "valid_empty"),
          source("personal", "valid_present", [entry("personal", "ΟΣ", "Candidate")]),
        ),
        {
          relation: "inferred_equivalence",
          candidate_owner: "personal",
          candidate_term: "οσ",
        },
      ),
    ).toMatchObject({ outcome: "inferred_equivalence", applicable_meaning: null });
  });

  it("does not normalize canonically distinct terms during lookup", () => {
    expect(
      resolveGlossaryAdvice(
        "e\u0301",
        acquired(
          source("project", "valid_present", [entry("project", "é", "Project precomposed")]),
          source("personal", "valid_present", [
            entry("personal", "e\u0301", "Personal decomposed"),
          ]),
        ),
      ),
    ).toMatchObject({
      outcome: "proven_project_gap",
      applicable_meaning: "Personal decomposed",
      applicable_owner: "personal",
    });
  });

  it("covers absent, empty, nonmatching, and every invalid availability without unsafe fallback", () => {
    for (const availability of ["malformed", "unreadable", "ambiguous", "over_bound"] as const) {
      expect(
        resolveGlossaryAdvice(
          REQUESTED,
          acquired(source("project", availability), personalExact()),
        ),
      ).toMatchObject({
        outcome: "invalid_or_unavailable_project",
        applicable_meaning: null,
        applicable_owner: null,
      });
      expect(
        resolveGlossaryAdvice(
          REQUESTED,
          acquired(projectExact(), source("personal", availability)),
        ),
      ).toMatchObject({
        outcome: "project_only",
        applicable_owner: "project",
        advisory: { reason: "personal_input_unavailable" },
      });
    }

    for (const project of [
      source("project", "absent"),
      source("project", "valid_empty"),
      projectGap(),
    ]) {
      expect(resolveGlossaryAdvice(REQUESTED, acquired(project, personalExact()))).toMatchObject({
        outcome: "proven_project_gap",
        applicable_owner: "personal",
      });
    }
    for (const [personal, outcome] of [
      [source("personal", "absent"), "invalid_or_unavailable_personal"],
      [source("personal", "valid_empty"), "no_applicable_entry"],
    ] as const) {
      expect(
        resolveGlossaryAdvice(REQUESTED, acquired(source("project", "valid_empty"), personal)),
      ).toMatchObject({ outcome, applicable_meaning: null });
    }
  });

  it("derives every lawful tuple's first matching row and row semantics from the loaded authority", () => {
    const contract = glossaryAdviceContract();
    const projectStates = {
      invalid: () => source("project", "malformed"),
      valid_gap: () => projectGap(),
      valid_exact: () => projectExact("Same"),
    };
    const personalStates = {
      invalid: () => source("personal", "absent"),
      valid_without_exact: () => personalCandidate(),
      valid_exact: (meaning: string) => personalExact(meaning),
    };

    for (const projectInput of contract.dimensions.project_input!) {
      for (const personalInput of contract.dimensions.personal_input!) {
        const exactMeanings =
          projectInput === "valid_exact" && personalInput === "valid_exact"
            ? ["equivalent", "divergent"]
            : ["not_applicable"];
        const inferredCandidates =
          personalInput === "valid_without_exact" ? ["absent", "present"] : ["absent"];
        for (const exactMeaning of exactMeanings) {
          for (const inferredCandidate of inferredCandidates) {
            const project = projectStates[projectInput as keyof typeof projectStates]();
            const personal =
              personalInput === "valid_exact"
                ? personalStates.valid_exact(exactMeaning === "equivalent" ? "Same" : "Different")
                : personalStates[personalInput as "invalid" | "valid_without_exact"]();
            const hostReview = inferredCandidate === "present" ? inferredReview : undefined;
            const inputs = acquired(project, personal);
            const result = resolveGlossaryAdvice(REQUESTED, inputs, hostReview);
            const state = classifyGlossaryAdviceInputs(REQUESTED, inputs, hostReview);
            const matching = contract.rows.filter((row) =>
              Object.entries(state).every(([dimension, value]) =>
                row.match[dimension]!.includes(value),
              ),
            );
            const advisory = contract.advisories.find(
              (candidate) =>
                candidate.primaryOutcome === matching[0]?.name &&
                Object.entries(state).every(([dimension, value]) =>
                  candidate.match[dimension]?.includes(value),
                ),
            );
            expect(matching, JSON.stringify(state)).toHaveLength(1);
            expect(result).toMatchObject({
              outcome: matching[0]!.name,
              applicable_owner:
                matching[0]!.selectedOwner === "project" ||
                matching[0]!.selectedOwner === "personal"
                  ? matching[0]!.selectedOwner
                  : null,
              review: advisory?.review ?? matching[0]!.review,
              tension: matching[0]!.tension,
            });
          }
        }
      }
    }
  });

  it("fails once and privacy-safely for duplicate, malformed, over-bound, and unknown review input", () => {
    const privateTrap = "PRIVATE_MEANING_PATH_ANCHOR_APPROVAL_TRAP";
    const duplicate = acquired(
      source("project", "valid_present", [
        entry("project", REQUESTED, privateTrap),
        entry("project", "ship shape", privateTrap),
      ]),
      source("personal", "absent"),
    );
    const overBound = "x".repeat(glossaryAcquisitionContract().maxSourceUtf8Bytes + 1);
    const tooManyEntries = acquired(
      source(
        "project",
        "valid_present",
        Array.from({ length: glossaryAcquisitionContract().maxEntries + 1 }, (_, index) =>
          entry("project", `Term ${index}`, `Meaning ${index}`),
        ),
      ),
      source("personal", "absent"),
    );
    const attempts: Array<() => unknown> = [
      () => resolveGlossaryAdvice(REQUESTED, duplicate),
      () => resolveGlossaryAdvice(REQUESTED, tooManyEntries),
      () =>
        resolveGlossaryAdvice(
          REQUESTED,
          acquired(projectExact(), source("personal", "valid_present", [])),
        ),
      () => resolveGlossaryAdvice(overBound, acquired(projectExact(), personalExact())),
      () => resolveGlossaryAdvice("", acquired(projectExact(), personalExact())),
      () =>
        resolveGlossaryAdvice(REQUESTED, acquired(projectGap(), personalCandidate()), {
          ...inferredReview,
          relation: privateTrap,
        } as never),
      () =>
        resolveGlossaryAdvice(REQUESTED, acquired(projectGap(), personalCandidate()), {
          ...inferredReview,
          candidate_owner: "project",
        } as never),
      () =>
        resolveGlossaryAdvice(REQUESTED, acquired(projectGap(), personalCandidate()), {
          ...inferredReview,
          candidate_term: privateTrap,
        }),
    ];

    for (const attempt of attempts) {
      let failure: unknown;
      try {
        attempt();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(GlossaryAdviceInputError);
      const serialized = JSON.stringify({
        code: (failure as GlossaryAdviceInputError).code,
        message: (failure as Error).message,
      });
      expect(serialized).not.toContain(privateTrap);
      expect(serialized).not.toContain(REQUESTED);
      expect(["invalid_request", "invalid_acquisition", "invalid_host_review"]).toContain(
        (failure as GlossaryAdviceInputError).code,
      );
    }
  });

  it("returns only selected transient content and is deterministic, read-only, and unrelated-entry safe", () => {
    const privateTrap = "PRIVATE_UNRELATED_TERM_MEANING_PATH_ANCHOR_APPROVAL_PROVENANCE";
    const inputs = acquired(
      source("project", "valid_present", [
        entry("project", REQUESTED, "Selected project meaning"),
        entry("project", privateTrap, privateTrap),
      ]),
      source("personal", "valid_present", [entry("personal", privateTrap, privateTrap)]),
    );
    const before = structuredClone(inputs);

    const first = resolveGlossaryAdvice(REQUESTED, inputs);
    const second = resolveGlossaryAdvice(REQUESTED, inputs);

    expect(first).toEqual(second);
    expect(inputs).toEqual(before);
    expect(Object.keys(first)).toEqual(glossaryAdviceContract().outputFields);
    expect(JSON.stringify(first)).not.toContain(privateTrap);
    expect(JSON.stringify(first)).not.toContain(REQUESTED);
  });
});

import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMappingFile } from "../core/yaml.js";

type Mapping = Record<string, unknown>;

const OUTCOME_SEMANTICS = {
  invalid_or_unavailable_project: {
    judgment: "deterministic",
    selected_owner: "none",
    selected_meaning: "none",
    review: "unavailable",
    tension: "authority_unavailable",
  },
  equivalent_exact_collision: {
    judgment: "deterministic",
    selected_owner: "project",
    selected_meaning: "project",
    review: "none",
    tension: "none",
  },
  divergent_exact_collision: {
    judgment: "deterministic",
    selected_owner: "project",
    selected_meaning: "project",
    review: "none",
    tension: "divergent_exact_collision",
  },
  project_only: {
    judgment: "deterministic",
    selected_owner: "project",
    selected_meaning: "project",
    review: "none_for_primary",
    tension: "none",
  },
  proven_project_gap: {
    judgment: "deterministic",
    selected_owner: "personal",
    selected_meaning: "personal",
    review: "none",
    tension: "none",
  },
  inferred_equivalence: {
    judgment: "host_reviewed",
    selected_owner: "none_until_review",
    selected_meaning: "none_until_review",
    review: "required_when_meaning_sensitive",
    tension: "inferred_equivalence",
  },
  invalid_or_unavailable_personal: {
    judgment: "deterministic",
    selected_owner: "none",
    selected_meaning: "none",
    review: "unavailable",
    tension: "input_unavailable",
  },
  no_applicable_entry: {
    judgment: "deterministic",
    selected_owner: "none",
    selected_meaning: "none",
    review: "none",
    tension: "none",
  },
} as const;

const OUTCOME_SEMANTIC_FIELDS = [
  "judgment",
  "selected_owner",
  "selected_meaning",
  "review",
  "tension",
] as const;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function contract(pathname: string): Mapping {
  return loadYamlMappingFile(pathname) as Mapping;
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return JSON.stringify(strings(actual)) === JSON.stringify(expected);
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateConsumerBoundary(consumer: Mapping | null): string[] {
  const errors: string[] = [];
  const implementation = mapping(consumer?.implementation);
  if (
    consumer?.contract_status !== "active" ||
    implementation?.acquisition !== "declared_deferred" ||
    implementation?.advice_resolution !== "declared_deferred" ||
    implementation?.capability_integrations !== "declared_deferred"
  ) {
    errors.push(
      "consumer_boundary.implementation must activate only the contract while acquisition, advice resolution, and capability integrations remain declared_deferred",
    );
  }

  const judgments = mapping(consumer?.deterministic_judgments);
  const hostJudgments = mapping(consumer?.host_reviewed_judgments);
  const projectState = mapping(consumer?.project_state);
  if (
    judgments?.term_identity !== "case_insensitive_exact" ||
    judgments?.meaning_identity !== "exact_string" ||
    judgments?.project_state_validity !== "schema_and_bound_validation" ||
    judgments?.project_gap !== "valid_project_state_without_exact_term_identity" ||
    !sameStrings(judgments?.forbidden_semantic_heuristics, [
      "scores",
      "thresholds",
      "embeddings",
      "automatic_merge",
    ]) ||
    !nonEmpty(hostJudgments?.inferred_semantic_equivalence) ||
    !sameStrings(projectState?.gap_proving_states, [
      "canonically_absent",
      "valid_empty",
      "valid_nonmatching",
    ]) ||
    !sameStrings(projectState?.invalid_states, [
      "malformed",
      "unreadable",
      "ambiguous_path",
      "over_bound",
    ]) ||
    !nonEmpty(projectState?.invalid_rule)
  ) {
    errors.push(
      "consumer_boundary judgments must separate deterministic exact identity and valid gaps from host-reviewed inferred equivalence and invalid project state",
    );
  }

  const selection = mapping(consumer?.primary_selection);
  const dimensions = mapping(selection?.dimensions);
  const matrix = mapping(consumer?.outcome_matrix);
  // These literals validate the authority's fixed primary-outcome shape; runtime
  // behavior and predicates remain owned by the YAML contract below this gate.
  const expectedOutcomes = Object.keys(OUTCOME_SEMANTICS) as Array<keyof typeof OUTCOME_SEMANTICS>;
  const matrixValid =
    sameStrings(dimensions?.project_input, ["invalid", "valid_gap", "valid_exact"]) &&
    sameStrings(dimensions?.personal_input, ["invalid", "valid_without_exact", "valid_exact"]) &&
    sameStrings(dimensions?.exact_meaning, ["not_applicable", "equivalent", "divergent"]) &&
    sameStrings(dimensions?.inferred_candidate, ["absent", "present"]) &&
    nonEmpty(selection?.valid_state_rule) &&
    sameStrings(selection?.order, expectedOutcomes) &&
    nonEmpty(selection?.rule) &&
    sameStrings(Object.keys(matrix ?? {}), expectedOutcomes) &&
    expectedOutcomes.every((name) => {
      const outcome = mapping(matrix?.[name]);
      const match = mapping(outcome?.match);
      return (
        nonEmpty(outcome?.when) &&
        strings(match?.project_input).length > 0 &&
        strings(match?.project_input).every((value) =>
          strings(dimensions?.project_input).includes(value),
        ) &&
        strings(match?.personal_input).length > 0 &&
        strings(match?.personal_input).every((value) =>
          strings(dimensions?.personal_input).includes(value),
        ) &&
        strings(match?.exact_meaning).length > 0 &&
        strings(match?.exact_meaning).every((value) =>
          strings(dimensions?.exact_meaning).includes(value),
        ) &&
        strings(match?.inferred_candidate).length > 0 &&
        strings(match?.inferred_candidate).every((value) =>
          strings(dimensions?.inferred_candidate).includes(value),
        )
      );
    });
  if (!matrixValid) {
    errors.push(
      "consumer_boundary outcome matrix and primary_selection must define all eight ordered collision, gap, review, absence, and invalid-input outcomes",
    );
  }

  for (const outcomeName of expectedOutcomes) {
    const outcome = mapping(matrix?.[outcomeName]);
    const expected = OUTCOME_SEMANTICS[outcomeName];
    for (const field of OUTCOME_SEMANTIC_FIELDS) {
      if (outcome?.[field] === expected[field]) continue;
      const actual = outcome && field in outcome ? JSON.stringify(outcome[field]) : "missing";
      errors.push(
        `consumer_boundary.outcome_matrix.${outcomeName}.${field} must be ${JSON.stringify(expected[field])} (found ${actual}); restore the canonical primary-outcome semantics and rerun agentera check validate vocabularyAuthority --format json`,
      );
    }
  }

  const validStates: Array<Record<string, string>> = [];
  for (const projectInput of ["invalid", "valid_gap", "valid_exact"]) {
    for (const personalInput of ["invalid", "valid_without_exact", "valid_exact"]) {
      const exactMeanings =
        projectInput === "valid_exact" && personalInput === "valid_exact"
          ? ["equivalent", "divergent"]
          : ["not_applicable"];
      for (const exactMeaning of exactMeanings) {
        for (const inferredCandidate of ["absent", "present"]) {
          validStates.push({
            project_input: projectInput,
            personal_input: personalInput,
            exact_meaning: exactMeaning,
            inferred_candidate: inferredCandidate,
          });
        }
      }
    }
  }
  const selectionFailures = validStates.flatMap((state) => {
    const matches = expectedOutcomes.filter((name) => {
      const match = mapping(mapping(matrix?.[name])?.match);
      return Object.entries(state).every(([dimension, value]) =>
        strings(match?.[dimension]).includes(value),
      );
    });
    return matches.length === 1 ? [] : [`${JSON.stringify(state)} matched [${matches.join(", ")}]`];
  });
  if (selectionFailures.length > 0) {
    errors.push(
      `consumer_boundary.primary_selection must be exhaustive and non-overlapping: ${selectionFailures[0]}; correct outcome_matrix[*].match and rerun agentera check validate vocabularyAuthority --format json`,
    );
  }

  const advisories = mapping(consumer?.orthogonal_advisories);
  const unavailableAdvisory = mapping(advisories?.personal_input_unavailable_with_project_exact);
  const inferredAdvisory = mapping(advisories?.inferred_equivalence_with_project_exact);
  if (
    unavailableAdvisory?.primary_outcome !== "project_only" ||
    unavailableAdvisory?.caveat_reason !== "personal_input_unavailable" ||
    unavailableAdvisory?.ownership_state !== "project_governs_exact" ||
    !nonEmpty(unavailableAdvisory?.rule) ||
    inferredAdvisory?.primary_outcome !== "project_only" ||
    inferredAdvisory?.caveat_reason !== "inferred_equivalence" ||
    inferredAdvisory?.ownership_state !== "project_governs_exact" ||
    !nonEmpty(inferredAdvisory?.review) ||
    !nonEmpty(inferredAdvisory?.rule)
  ) {
    errors.push(
      "consumer_boundary.orthogonal_advisories must preserve exact project authority while bounding personal availability and inferred-equivalence review caveats",
    );
  }

  const refresh = mapping(consumer?.refresh_events);
  if (
    !sameStrings(refresh?.required, [
      "initial_meaning_sensitive_input",
      "later_user_requirement_change_that_can_change_meaning",
      "later_user_intent_change_that_can_change_meaning",
      "later_acceptance_change_that_can_change_meaning",
      "later_deliberation_premise_change_that_can_change_meaning",
      "later_cycle_intent_change_that_can_change_meaning",
      "clarification_answer_for_a_reviewed_term",
    ]) ||
    !sameStrings(refresh?.not_required, [
      "unrelated_conversation_turn",
      "unchanged_input_replay",
      "background_state_reread",
      "status_or_progress_render",
      "tool_output_without_requirement_or_intent_change",
    ]) ||
    !nonEmpty(refresh?.rule)
  ) {
    errors.push(
      "consumer_boundary.refresh_events must require meaning-sensitive initial and changed intent inputs and exclude unrelated turns and background rereads",
    );
  }

  const disclosure = mapping(consumer?.disclosure);
  const transient = mapping(disclosure?.transient_advice);
  const durable = mapping(disclosure?.durable_surfaces);
  const durableForbidden = [
    "personal_definition",
    "project_definition",
    "personal_evidence_anchor",
    "personal_profile_path",
    "raw_personal_glossary_section",
    "raw_project_glossary_section",
    "unrelated_entry",
    "provenance",
    "project_source_path",
  ];
  if (
    !sameStrings(transient?.allowed, [
      "outcome",
      "applicable_meaning",
      "applicable_owner",
      "review",
      "tension",
    ]) ||
    !nonEmpty(transient?.minimum_rule) ||
    !sameStrings(durable?.surfaces, [
      "progress_evidence",
      "prime_attention",
      "diagnostics",
      "errors",
    ]) ||
    !sameStrings(durable?.allowed, [
      "caveat_id",
      "event",
      "capability",
      "reason",
      "ownership_state",
      "transition_id",
    ]) ||
    !sameStrings(durable?.forbidden, durableForbidden) ||
    !nonEmpty(durable?.failure_rule)
  ) {
    errors.push(
      "consumer_boundary.disclosure must bound transient advice and exclude definitions, anchors, paths, raw sections, unrelated entries, and provenance from durable output and errors",
    );
  }

  const caveat = mapping(consumer?.autonomous_caveat);
  const identity = mapping(caveat?.identity);
  const envelope = mapping(caveat?.envelope);
  const lifecycle = mapping(caveat?.lifecycle);
  const handoff = mapping(caveat?.handoff);
  if (
    caveat?.durable_owner !== "build" ||
    caveat?.durable_channel !== "progress" ||
    caveat?.authority !== "skills/agentera/schemas/artifacts/progress.yaml#ENTITY_AUTHORITY" ||
    caveat?.publication_command !== "agentera state progress append" ||
    caveat?.publication_boundary !== "progress_cycle.glossary_caveat" ||
    caveat?.publication_status !== "declared_deferred" ||
    identity?.field !== "caveat_id" ||
    identity?.type !== "opaque_non_content_id" ||
    !nonEmpty(identity?.rule) ||
    envelope?.schema_version !== "agentera.glossaryConsumerCaveat.v1" ||
    !sameStrings(envelope?.fields, [
      "caveat_id",
      "event",
      "capability",
      "reason",
      "ownership_state",
      "transition_id",
    ]) ||
    !sameStrings(envelope?.capabilities, ["discuss", "plan", "build"]) ||
    !sameStrings(envelope?.reasons, [
      "inferred_equivalence",
      "authority_unavailable",
      "personal_input_unavailable",
    ]) ||
    !sameStrings(envelope?.ownership_states, [
      "project_governs_exact",
      "review_required",
      "authority_unavailable",
    ]) ||
    !nonEmpty(lifecycle?.current) ||
    !nonEmpty(lifecycle?.resolved) ||
    !nonEmpty(lifecycle?.superseded) ||
    !nonEmpty(lifecycle?.matching_rule) ||
    lifecycle?.expiration !== "none" ||
    !nonEmpty(lifecycle?.expiration_rule) ||
    !nonEmpty(handoff?.plan) ||
    !nonEmpty(handoff?.discuss) ||
    !nonEmpty(handoff?.build)
  ) {
    errors.push(
      "consumer_boundary.autonomous_caveat must use Build-owned progress evidence with an opaque identity, current/resolved/superseded transitions, Plan handoff, and explicit no-expiration",
    );
  }

  const publication = mapping(consumer?.publication_isolation);
  if (
    !nonEmpty(publication?.rule) ||
    publication?.project_publication_authority !== "ownership_contracts.project.publication"
  ) {
    errors.push(
      "consumer_boundary.publication_isolation must keep advice and caveat lifecycle separate from Build-owned digest-confirmed publication and approval",
    );
  }

  const gate = mapping(consumer?.downstream_gate);
  if (
    gate?.status !== "blocked_until_contract_valid" ||
    gate?.validator !==
      "packages/cli/src/registries/glossaryEntryContract.ts#validateGlossaryEntryContract" ||
    gate?.command !== "agentera check validate vocabularyAuthority --format json" ||
    !sameStrings(gate?.required_sections, [
      "consumer_boundary.primary_selection",
      "consumer_boundary.outcome_matrix",
      "consumer_boundary.orthogonal_advisories",
      "consumer_boundary.refresh_events",
      "consumer_boundary.disclosure",
      "consumer_boundary.autonomous_caveat",
      "consumer_boundary.publication_isolation",
    ]) ||
    !nonEmpty(gate?.failure_rule)
  ) {
    errors.push(
      "consumer_boundary.downstream_gate must block integration with section-specific validation and an actionable local command",
    );
  }
  return errors;
}

export function validateConsumerEvidenceOwner(consumer: Mapping | null): string[] {
  let progress: Mapping;
  try {
    progress = contract(
      path.join(resolveSourceRoot(), "skills", "agentera", "schemas", "artifacts", "progress.yaml"),
    );
  } catch (error) {
    return [
      `consumer_boundary.autonomous_caveat progress authority is unavailable: ${(error as Error).message}`,
    ];
  }
  const cycle = mapping(mapping(progress.CYCLE)?.["11"]);
  const schema = mapping(progress.GLOSSARY_CAVEAT);
  const fields = mapping(schema?.fields);
  const caveat = mapping(consumer?.autonomous_caveat);
  const envelope = mapping(caveat?.envelope);
  if (
    cycle?.field !== "glossary_caveat" ||
    cycle?.implementation_status !== "declared_deferred" ||
    cycle?.authority !==
      "references/artifacts/glossary-entry-contract.yaml#consumer_boundary.autonomous_caveat" ||
    schema?.schema_version !== envelope?.schema_version ||
    schema?.implementation_status !== "declared_deferred" ||
    !sameStrings(Object.keys(fields ?? {}), strings(envelope?.fields)) ||
    !sameStrings(mapping(fields?.capability)?.values, strings(envelope?.capabilities)) ||
    !sameStrings(mapping(fields?.reason)?.values, strings(envelope?.reasons)) ||
    !sameStrings(mapping(fields?.ownership_state)?.values, strings(envelope?.ownership_states))
  ) {
    return [
      "consumer_boundary.autonomous_caveat must match the deferred progress_cycle.glossary_caveat schema owned by Build",
    ];
  }
  return [];
}

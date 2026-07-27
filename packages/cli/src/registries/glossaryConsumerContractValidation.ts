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

function sameMappings(actual: unknown, expected: readonly Mapping[]): boolean {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

const ALLOWED_CAVEAT_PAIRS = [
  { reason: "inferred_equivalence", ownership_state: "review_required" },
  { reason: "inferred_equivalence", ownership_state: "project_governs_exact" },
  { reason: "authority_unavailable", ownership_state: "authority_unavailable" },
  { reason: "personal_input_unavailable", ownership_state: "authority_unavailable" },
] as const;

export function validateConsumerBoundary(consumer: Mapping | null): string[] {
  const errors: string[] = [];
  const implementation = mapping(consumer?.implementation);
  const integrations = mapping(implementation?.capability_integrations);
  if (
    consumer?.contract_status !== "active" ||
    implementation?.acquisition !== "active" ||
    implementation?.advice_resolution !== "active" ||
    integrations?.build !== "active" ||
    integrations?.discuss !== "active" ||
    integrations?.plan !== "active" ||
    integrations?.prime !== "active"
  ) {
    errors.push(
      "consumer_boundary.implementation must activate Build, Discuss, Plan, and prime",
    );
  }

  const discuss = mapping(consumer?.discuss_integration);
  const discussInteraction = mapping(discuss?.interaction);
  if (
    discuss?.implementation !== "active" ||
    discuss?.invocation !== "consumer_boundary.advice_resolution.invocation" ||
    discuss?.governed_events !== "consumer_boundary.refresh_events" ||
    discuss?.outcome_authority !== "consumer_boundary.outcome_matrix" ||
    discuss?.disclosure !== "consumer_boundary.disclosure.transient_advice" ||
    discussInteraction?.scope !== "current_user_authored_meaning_sensitive_input" ||
    discussInteraction?.transcript_scan !== "forbidden" ||
    discussInteraction?.done_only_control !== "no_refresh" ||
    !nonEmpty(discussInteraction?.review_rule) ||
    !nonEmpty(discussInteraction?.exact_collision_rule) ||
    !nonEmpty(discussInteraction?.unavailable_rule) ||
    !nonEmpty(discuss?.output_rule) ||
    discuss?.mutation !== "forbidden" ||
    !sameStrings(discuss?.forbidden_effects, [
      "glossary_write",
      "glossary_approval",
      "publication_consent",
      "progress_caveat",
      "plan_conflict",
      "decision_conflict",
    ])
  ) {
    errors.push(
      "consumer_boundary.discuss_integration must use bounded transient advice without mutation",
    );
  }

  const plan = mapping(consumer?.plan_integration);
  const planMode = mapping(plan?.mode);
  const planSignals = mapping(planMode?.signals);
  const planInteraction = mapping(plan?.interaction);
  const planReview = mapping(planInteraction?.review);
  const handoffIntent = mapping(plan?.autonomous_handoff_intent);
  const exactProjectUnavailable = mapping(plan?.exact_project_personal_unavailable);
  const unavailable = mapping(plan?.unavailable);
  const invalidProject = mapping(unavailable?.invalid_project);
  const invalidPersonalGap = mapping(unavailable?.invalid_personal_after_project_gap);
  const behavior = mapping(plan?.behavior_matrix);
  if (
    plan?.implementation !== "active" ||
    plan?.invocation !== "consumer_boundary.advice_resolution.invocation" ||
    plan?.governed_events !== "consumer_boundary.refresh_events" ||
    plan?.outcome_authority !== "consumer_boundary.outcome_matrix" ||
    plan?.disclosure !== "consumer_boundary.disclosure.transient_advice" ||
    !sameStrings(planMode?.precedence, [
      "explicit_delegated_or_orchestrated_no_pause",
      "direct_user_invocation_with_available_clarification_turn",
      "unknown_or_ambiguous",
    ]) ||
    mapping(planSignals?.explicit_delegated_or_orchestrated_no_pause)?.result !== "autonomous" ||
    mapping(planSignals?.direct_user_invocation_with_available_clarification_turn)?.result !==
      "interactive" ||
    mapping(planSignals?.unknown_or_ambiguous)?.result !== "interactive_waiting" ||
    planMode?.silence_or_timeout !== "never_autonomous" ||
    !nonEmpty(planMode?.rule) ||
    planInteraction?.scope !== "current_user_authored_meaning_sensitive_input" ||
    planInteraction?.transcript_scan !== "forbidden" ||
    planInteraction?.control_only_continuation !== "no_refresh" ||
    !sameStrings(planReview?.interactive_sequence, [
      "emit_one_focused_clarification",
      "wait_for_user_answer",
      "refresh_advice_for_affected_term",
      "finalize_affected_scope_requirements_tasks_acceptance",
    ]) ||
    !sameStrings(planReview?.autonomous_sequence, [
      "abstain_from_disputed_meaning",
      "defer_affected_scope_requirements_tasks_acceptance",
      "emit_transient_handoff_intent",
    ]) ||
    !sameStrings(planReview?.clarification_effects, [
      "not_plan_approval",
      "not_decision_confirmation",
      "not_glossary_approval",
      "not_publication_consent",
    ]) ||
    !nonEmpty(planInteraction?.exact_collision_rule) ||
    !nonEmpty(planInteraction?.unavailable_rule) ||
    handoffIntent?.status !== "transient_emitted_not_delivered" ||
    !sameStrings(handoffIntent?.caller_fields, ["event", "reason", "ownership_state"]) ||
    JSON.stringify(mapping(handoffIntent?.fixed_values)) !== JSON.stringify({ event: "current" }) ||
    !sameStrings(handoffIntent?.accepted_writer_flags, [
      "--glossary-caveat-event",
      "--glossary-caveat-reason",
      "--glossary-caveat-ownership-state",
    ]) ||
    !sameStrings(handoffIntent?.writer_owned_fields, [
      "caveat_id",
      "capability",
      "transition_id",
    ]) ||
    !sameStrings(handoffIntent?.forbidden_fields, ["caveat_id", "capability", "transition_id"]) ||
    !sameStrings(handoffIntent?.forbidden_claims, [
      "delivered",
      "stored",
      "persisted",
      "published",
      "durable_envelope",
    ]) ||
    handoffIntent?.durable_writer !== "build" ||
    handoffIntent?.writer_interface !==
      "agentera state progress explain --verb append --format json" ||
    handoffIntent?.writer_result !== "authoritative_identity_and_six_field_envelope" ||
    handoffIntent?.allowed_reason_state_pairs !==
      "consumer_boundary.autonomous_caveat.allowed_current_pairs" ||
    !nonEmpty(handoffIntent?.rule) ||
    !nonEmpty(plan?.output_rule) ||
    plan?.handoff !== "consumer_boundary.autonomous_caveat.handoff.plan" ||
    plan?.mutation !== "forbidden" ||
    !sameStrings(plan?.forbidden_effects, [
      "glossary_write",
      "glossary_approval",
      "publication_consent",
      "progress_caveat",
      "plan_conflict",
      "decision_conflict",
    ])
  ) {
    errors.push(
      "consumer_boundary.plan_integration must define deterministic mode, ordered review, autonomous abstention, and an emitted event/reason/state writer intent",
    );
  }
  if (
    exactProjectUnavailable?.primary_outcome !== "project_only" ||
    exactProjectUnavailable?.advisory_reason !== "personal_input_unavailable" ||
    exactProjectUnavailable?.advisory_ownership_state !== "project_governs_exact" ||
    exactProjectUnavailable?.plan_action !== "ground_exact_project_meaning" ||
    exactProjectUnavailable?.autonomous_handoff_intent !== "none" ||
    exactProjectUnavailable?.durable_unresolved_caveat !== "none" ||
    !nonEmpty(exactProjectUnavailable?.rule) ||
    invalidProject?.interactive !== "clarify_or_wait_when_meaning_critical" ||
    invalidProject?.autonomous !== "abstain_defer_and_emit_authority_unavailable" ||
    !sameStrings(invalidProject?.handoff_pair, [
      "authority_unavailable",
      "authority_unavailable",
    ]) ||
    invalidPersonalGap?.interactive !== "clarify_or_wait_when_meaning_critical" ||
    invalidPersonalGap?.autonomous !== "abstain_defer_and_emit_personal_input_unavailable" ||
    !sameStrings(invalidPersonalGap?.handoff_pair, [
      "personal_input_unavailable",
      "authority_unavailable",
    ]) ||
    mapping(behavior?.interactive_review_required)?.mode !== "interactive" ||
    mapping(behavior?.interactive_review_required)?.plan_action !==
      "clarify_refresh_then_finalize" ||
    mapping(behavior?.interactive_review_required)?.handoff_intent !== "none" ||
    mapping(behavior?.autonomous_review_required)?.mode !== "autonomous" ||
    mapping(behavior?.autonomous_review_required)?.plan_action !== "abstain_and_defer" ||
    mapping(behavior?.autonomous_review_required)?.handoff_intent !== "emitted" ||
    mapping(behavior?.exact_project_personal_unavailable)?.mode !== "any" ||
    mapping(behavior?.exact_project_personal_unavailable)?.plan_action !==
      "ground_exact_project_meaning" ||
    mapping(behavior?.exact_project_personal_unavailable)?.handoff_intent !== "none" ||
    mapping(behavior?.unavailable_unresolved)?.mode !== "autonomous" ||
    mapping(behavior?.unavailable_unresolved)?.plan_action !== "abstain_and_defer" ||
    mapping(behavior?.unavailable_unresolved)?.handoff_intent !== "emitted" ||
    mapping(behavior?.divergent_exact_collision)?.mode !== "any" ||
    mapping(behavior?.divergent_exact_collision)?.plan_action !==
      "ground_project_and_bound_tension" ||
    mapping(behavior?.divergent_exact_collision)?.handoff_intent !== "none" ||
    mapping(behavior?.irrelevant_or_no_applicable_entry)?.mode !== "any" ||
    mapping(behavior?.irrelevant_or_no_applicable_entry)?.plan_action !==
      "leave_unaffected_planning_unchanged" ||
    mapping(behavior?.irrelevant_or_no_applicable_entry)?.handoff_intent !== "none"
  ) {
    errors.push(
      "consumer_boundary.plan_integration must separate exact-project personal-input advice from unresolved autonomous handoff",
    );
  }

  const advice = mapping(consumer?.advice_resolution);
  const invocation = mapping(advice?.invocation);
  const adviceInput = mapping(advice?.input);
  const hostReview = mapping(adviceInput?.host_review);
  const adviceOutput = mapping(advice?.output);
  const adviceFailure = mapping(advice?.failure);
  if (
    advice?.implementation !== "active" ||
    advice?.runtime !==
      "packages/cli/src/analytics/glossaryAdviceResolution.ts#resolveGlossaryAdvice" ||
    advice?.mutation !== "forbidden" ||
    invocation?.command !== "agentera report glossary-advice --input REQUEST --format json" ||
    invocation?.request_schema_version !== "agentera.glossaryAdviceRequest.v1" ||
    !sameStrings(invocation?.request_fields, ["schema_version", "requested_term", "host_review"]) ||
    invocation?.max_request_utf8_bytes !== 131072 ||
    invocation?.acquisition !== "internal_bounded_owned_sources" ||
    invocation?.project_root !== "current_working_directory" ||
    invocation?.profile_path !== "canonical_registry_resolution" ||
    !sameStrings(invocation?.output_envelope_fields, [
      "schemaVersion",
      "command",
      "status",
      "advice",
    ]) ||
    !nonEmpty(invocation?.rule) ||
    !sameStrings(adviceInput?.fields, ["requested_term", "acquired", "host_review"]) ||
    adviceInput?.requested_term_utf8_bound !==
      "consumer_boundary.acquisition.bounds.max_source_utf8_bytes" ||
    adviceInput?.acquired_contract !== "consumer_boundary.acquisition.output" ||
    hostReview?.optional !== true ||
    !sameStrings(hostReview?.fields, ["relation", "candidate_owner", "candidate_term"]) ||
    !sameStrings(hostReview?.relations, ["inferred_equivalence"]) ||
    !sameStrings(hostReview?.candidate_owners, ["personal"]) ||
    !nonEmpty(hostReview?.rule) ||
    adviceInput?.additional_fields !== "forbidden" ||
    adviceOutput?.schema_version !== "agentera.glossaryAdvice.v1" ||
    !sameStrings(adviceOutput?.fields, [
      "outcome",
      "applicable_meaning",
      "applicable_owner",
      "review",
      "tension",
      "advisory",
    ]) ||
    !sameStrings(adviceOutput?.owners, ["personal", "project"]) ||
    !sameStrings(adviceOutput?.advisory_fields, ["reason", "ownership_state"]) ||
    !sameStrings(adviceOutput?.advisory_reasons, [
      "personal_input_unavailable",
      "inferred_equivalence",
    ]) ||
    !sameStrings(adviceOutput?.advisory_ownership_states, ["project_governs_exact"]) ||
    !nonEmpty(adviceOutput?.rule) ||
    !sameStrings(adviceFailure?.classes, [
      "invalid_request",
      "invalid_acquisition",
      "invalid_host_review",
    ]) ||
    !nonEmpty(adviceFailure?.rule)
  ) {
    errors.push(
      "consumer_boundary.advice_resolution must define the active bounded read-only runtime, host-review input, transient output, and privacy-safe failure contract",
    );
  }

  const acquisition = mapping(consumer?.acquisition);
  const bounds = mapping(acquisition?.bounds);
  const availability = mapping(acquisition?.availability);
  const projectAcquisition = mapping(acquisition?.project);
  const personalAcquisition = mapping(acquisition?.personal);
  const acquisitionOutput = mapping(acquisition?.output);
  if (
    acquisition?.implementation !== "active" ||
    acquisition?.runtime !==
      "packages/cli/src/analytics/glossaryInputAcquisition.ts#acquireGlossaryInputs" ||
    acquisition?.mutation !== "forbidden" ||
    bounds?.authority !== "consumer_boundary.profile_grounding.max_profile_utf8_bytes" ||
    bounds?.max_source_utf8_bytes !== 65536 ||
    bounds?.max_entries !== 100 ||
    !nonEmpty(bounds?.rule) ||
    !sameStrings(availability?.states, [
      "absent",
      "valid_empty",
      "valid_present",
      "malformed",
      "unreadable",
      "ambiguous",
      "over_bound",
    ]) ||
    !sameStrings(availability?.valid, ["absent", "valid_empty", "valid_present"]) ||
    !sameStrings(availability?.invalid, ["malformed", "unreadable", "ambiguous", "over_bound"]) ||
    !sameStrings(availability?.project_gap_proving, ["absent", "valid_empty"]) ||
    !nonEmpty(availability?.rule) ||
    projectAcquisition?.identity !== "glossary" ||
    projectAcquisition?.discovery !==
      "packages/cli/src/registries/artifactRegistry.ts#loadArtifactRecord" ||
    projectAcquisition?.path_resolution !==
      "packages/cli/src/registries/artifactRegistry.ts#resolveArtifactPath" ||
    projectAcquisition?.docs_override_read !== "bounded_no_follow_regular_file" ||
    projectAcquisition?.project_root !==
      "packages/cli/src/state/projectRoot.ts#validateRealProjectRoot" ||
    !nonEmpty(projectAcquisition?.filesystem_guarantee) ||
    !nonEmpty(projectAcquisition?.external_docs_rule) ||
    projectAcquisition?.approval_output !== "forbidden" ||
    projectAcquisition?.raw_source_provenance_output !== "forbidden" ||
    personalAcquisition?.parser !==
      "packages/cli/src/analytics/personalGlossaryProfile.ts#personalGlossaryConsumerEntries" ||
    personalAcquisition?.provenance_output !== "forbidden" ||
    !nonEmpty(personalAcquisition?.profile_path_input) ||
    !nonEmpty(personalAcquisition?.grounding_parser_isolation) ||
    !nonEmpty(personalAcquisition?.producer_invariance) ||
    !sameStrings(acquisitionOutput?.entry_fields, ["term", "meaning", "owner"]) ||
    !sameStrings(acquisitionOutput?.owners, ["personal", "project"]) ||
    !sameStrings(acquisitionOutput?.source_fields, [
      "owner",
      "availability",
      "entries",
      "gap_proving",
      "diagnostic",
    ]) ||
    !sameStrings(acquisitionOutput?.diagnostic_fields, ["class", "recovery"]) ||
    !nonEmpty(acquisitionOutput?.diagnostic_rule) ||
    !nonEmpty(acquisitionOutput?.entry_rule)
  ) {
    errors.push(
      "consumer_boundary.acquisition must define canonical bounded independent project and personal reads with sanitized term/meaning/owner output",
    );
  }

  const judgments = mapping(consumer?.deterministic_judgments);
  const hostJudgments = mapping(consumer?.host_reviewed_judgments);
  const projectState = mapping(consumer?.project_state);
  if (
    judgments?.term_identity !== "unicode_caseless_exact_no_normalization" ||
    judgments?.term_identity_runtime !==
      "packages/cli/src/registries/glossaryTermIdentity.ts#unicodeCaselessExact" ||
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
    !sameStrings(mapping(unavailableAdvisory?.match)?.project_input, ["valid_exact"]) ||
    !sameStrings(mapping(unavailableAdvisory?.match)?.personal_input, ["invalid"]) ||
    !sameStrings(mapping(unavailableAdvisory?.match)?.exact_meaning, ["not_applicable"]) ||
    !sameStrings(mapping(unavailableAdvisory?.match)?.inferred_candidate, ["absent", "present"]) ||
    unavailableAdvisory?.caveat_reason !== "personal_input_unavailable" ||
    unavailableAdvisory?.ownership_state !== "project_governs_exact" ||
    !nonEmpty(unavailableAdvisory?.rule) ||
    inferredAdvisory?.primary_outcome !== "project_only" ||
    !sameStrings(mapping(inferredAdvisory?.match)?.project_input, ["valid_exact"]) ||
    !sameStrings(mapping(inferredAdvisory?.match)?.personal_input, ["valid_without_exact"]) ||
    !sameStrings(mapping(inferredAdvisory?.match)?.exact_meaning, ["not_applicable"]) ||
    !sameStrings(mapping(inferredAdvisory?.match)?.inferred_candidate, ["present"]) ||
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
      "artifact_rendering",
      "evaluator_text_without_user_change",
      "control_only_continuation",
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
  const planArtifacts = mapping(disclosure?.plan_artifacts);
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
      "advisory",
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
  if (
    !sameStrings(planArtifacts?.surfaces, [
      "scope",
      "requirements",
      "constraints",
      "tasks",
      "task_acceptance",
      "overall_acceptance",
      "diagnostics",
      "handoff",
    ]) ||
    !sameStrings(planArtifacts?.allowed_sources, [
      "user_authored_term",
      "user_authored_clarification",
      "derived_behavioral_requirement",
    ]) ||
    !sameStrings(planArtifacts?.forbidden_content, [
      "profile_derived_definition",
      "personal_glossary_definition",
      "personal_evidence_anchor",
      "personal_profile_path",
      "raw_personal_glossary_section",
      "raw_project_glossary_section",
      "unrelated_entry",
      "provenance",
      "project_source_path",
    ]) ||
    !nonEmpty(planArtifacts?.user_term_rule)
  ) {
    errors.push(
      "consumer_boundary.disclosure must forbid private glossary content in every durable Plan surface while allowing user-authored terms and derived requirements",
    );
  }

  const caveat = mapping(consumer?.autonomous_caveat);
  const identity = mapping(caveat?.identity);
  const envelope = mapping(caveat?.envelope);
  const currentAppend = mapping(envelope?.current_append);
  const lifecycle = mapping(caveat?.lifecycle);
  const handoff = mapping(caveat?.handoff);
  const primeProjection = mapping(caveat?.prime_projection);
  const primeSource = mapping(primeProjection?.source);
  const primeCapacity = mapping(primeProjection?.capacity);
  const malformedEvidence = mapping(primeProjection?.malformed_evidence);
  if (
    caveat?.durable_owner !== "build" ||
    caveat?.durable_channel !== "progress" ||
    caveat?.authority !== "skills/agentera/schemas/artifacts/progress.yaml#ENTITY_AUTHORITY" ||
    caveat?.publication_command !== "agentera state progress append" ||
    caveat?.publication_boundary !== "progress_cycle.glossary_caveat" ||
    caveat?.publication_status !== "active_build" ||
    caveat?.writer_runtime !== "packages/cli/src/state/progressEntities.ts#appendProgressEntity" ||
    caveat?.writer_interface !== "agentera state progress explain --verb append --format json" ||
    caveat?.envelope_validator !==
      "packages/cli/src/state/progressGlossaryCaveat.ts#validateProgressGlossaryCaveat" ||
    caveat?.lifecycle_validator !==
      "packages/cli/src/state/progressGlossaryCaveat.ts#glossaryCaveatLifecycleInvalidEntities" ||
    !sameMappings(caveat?.allowed_current_pairs, ALLOWED_CAVEAT_PAIRS) ||
    identity?.field !== "caveat_id" ||
    identity?.type !== "opaque_non_content_id" ||
    identity?.alphabet !== "abcdefghijklmnopqrstuvwxyz" ||
    identity?.length !== 10 ||
    identity?.pattern !== "^[a-z]{10}$" ||
    !nonEmpty(identity?.rule) ||
    envelope?.schema_version !== "agentera.glossaryConsumerCaveat.v1" ||
    envelope?.additional_fields !== "forbidden" ||
    envelope?.max_string_utf8_bytes !== 64 ||
    !sameStrings(envelope?.events, ["current", "resolved", "superseded"]) ||
    !sameStrings(envelope?.fields, [
      "caveat_id",
      "event",
      "capability",
      "reason",
      "ownership_state",
      "transition_id",
    ]) ||
    !sameStrings(envelope?.capabilities, ["build"]) ||
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
    !sameStrings(currentAppend?.caller_fields, ["event", "reason", "ownership_state"]) ||
    JSON.stringify(mapping(currentAppend?.caller_fixed_values)) !==
      JSON.stringify({ event: "current" }) ||
    !sameStrings(currentAppend?.writer_fields, ["caveat_id", "capability", "transition_id"]) ||
    JSON.stringify(mapping(currentAppend?.writer_fixed_values)) !==
      JSON.stringify({ capability: "build", transition_id: null }) ||
    !nonEmpty(currentAppend?.rule) ||
    !nonEmpty(envelope?.transition_rule) ||
    !nonEmpty(lifecycle?.current) ||
    !nonEmpty(lifecycle?.resolved) ||
    !nonEmpty(lifecycle?.superseded) ||
    !nonEmpty(lifecycle?.matching_rule) ||
    lifecycle?.expiration !== "none" ||
    !nonEmpty(lifecycle?.expiration_rule) ||
    primeProjection?.status !== "active" ||
    primeProjection?.runtime !==
      "packages/cli/src/state/progressGlossaryCaveat.ts#projectCurrentGlossaryCaveats" ||
    primeProjection?.retrieval !== "canonical_validated_progress_entities" ||
    !nonEmpty(primeProjection?.attention_text) ||
    primeProjection?.max_attention_entries !== 1 ||
    primeProjection?.insertion !== "reserved_final_slot_when_current" ||
    !nonEmpty(primeProjection?.rule) ||
    primeProjection?.expiration !== "none" ||
    !sameStrings(primeProjection?.forbidden_sources, [
      "timestamp",
      "recency",
      "plan_state",
      "transient_plan_handoff",
      "profile_presence",
      "unrelated_progress",
    ]) ||
    !sameStrings(primeProjection?.forbidden_output, [
      "caveat_id",
      "transition_id",
      "reason",
      "ownership_state",
      "definition",
      "meaning",
      "anchor",
      "path",
      "raw_section",
      "provenance",
      "source_bytes",
    ]) ||
    primeSource?.artifact !== "progress" ||
    primeSource?.boundary !== "progress_cycle" ||
    primeSource?.capability !== "build" ||
    primeCapacity?.public_attention_limit !== 6 ||
    primeCapacity?.reserved_glossary_slots !== 1 ||
    primeCapacity?.policy !== "reserve_final_slot_when_current" ||
    primeCapacity?.unrelated_retention !== "first_five_in_existing_order" ||
    malformedEvidence?.prime !== "omit" ||
    malformedEvidence?.direct_progress_retrieval !== "fail_closed_generic_corrupt_entity" ||
    !nonEmpty(malformedEvidence?.allowed_diagnostic) ||
    !sameStrings(malformedEvidence?.forbidden_diagnostic_content, [
      "stored_filename",
      "stored_path",
      "parser_text",
      "raw_value",
      "raw_bytes",
      "provenance",
    ]) ||
    !nonEmpty(handoff?.plan) ||
    !nonEmpty(handoff?.discuss) ||
    !nonEmpty(handoff?.build)
  ) {
    errors.push(
      "consumer_boundary.autonomous_caveat must define Build-owned progress evidence, exact pairs, lifecycle, and bounded active prime projection",
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
      "consumer_boundary.acquisition",
      "consumer_boundary.advice_resolution",
      "consumer_boundary.primary_selection",
      "consumer_boundary.outcome_matrix",
      "consumer_boundary.orthogonal_advisories",
      "consumer_boundary.refresh_events",
      "consumer_boundary.discuss_integration",
      "consumer_boundary.plan_integration",
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
  const schemaCurrentAppend = mapping(schema?.current_append);
  const caveat = mapping(consumer?.autonomous_caveat);
  const envelope = mapping(caveat?.envelope);
  const authorityCurrentAppend = mapping(envelope?.current_append);
  if (
    cycle?.field !== "glossary_caveat" ||
    cycle?.implementation_status !== "active_build" ||
    cycle?.authority !==
      "references/artifacts/glossary-entry-contract.yaml#consumer_boundary.autonomous_caveat" ||
    schema?.schema_version !== envelope?.schema_version ||
    schema?.implementation_status !== "active_build" ||
    mapping(schema?.reader_status)?.prime !== "active" ||
    schema?.envelope_validator !== caveat?.envelope_validator ||
    schema?.lifecycle_validator !== caveat?.lifecycle_validator ||
    schema?.allowed_current_pairs !==
      "references/artifacts/glossary-entry-contract.yaml#consumer_boundary.autonomous_caveat.allowed_current_pairs" ||
    !sameStrings(Object.keys(fields ?? {}), strings(envelope?.fields)) ||
    !sameStrings(mapping(fields?.capability)?.values, strings(envelope?.capabilities)) ||
    !sameStrings(mapping(fields?.reason)?.values, strings(envelope?.reasons)) ||
    !sameStrings(mapping(fields?.ownership_state)?.values, strings(envelope?.ownership_states)) ||
    !sameStrings(
      schemaCurrentAppend?.caller_fields,
      strings(authorityCurrentAppend?.caller_fields),
    ) ||
    JSON.stringify(mapping(schemaCurrentAppend?.caller_fixed_values)) !==
      JSON.stringify(mapping(authorityCurrentAppend?.caller_fixed_values)) ||
    !sameStrings(
      schemaCurrentAppend?.writer_fields,
      strings(authorityCurrentAppend?.writer_fields),
    ) ||
    JSON.stringify(mapping(schemaCurrentAppend?.writer_fixed_values)) !==
      JSON.stringify(mapping(authorityCurrentAppend?.writer_fixed_values)) ||
    !nonEmpty(schemaCurrentAppend?.rule) ||
    schema?.prime_projection !==
      "references/artifacts/glossary-entry-contract.yaml#consumer_boundary.autonomous_caveat.prime_projection"
  ) {
    return [
      "consumer_boundary.autonomous_caveat must match the active Build-owned progress_cycle.glossary_caveat schema",
    ];
  }
  return [];
}

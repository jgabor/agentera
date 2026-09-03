import path from "node:path";

import { loadYamlMappingFile } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

export const EXPLICIT_SEGMENT_GRAMMAR_SCHEMA_VERSION = "agentera.personalGlossarySegmentGrammar.v1";

export const EXPLICIT_SEGMENT_FORM_IDS = ["quoted_means", "definition_list_colon", "acronym_stands_for", "acronym_parenthetical", "by_i_mean", "use_for", "use_to_mean", "refers_to", "clarification_prefer_to_mean", "correction_means"] as const;

export type ExplicitSegmentFormId = (typeof EXPLICIT_SEGMENT_FORM_IDS)[number];

export const EXPLICIT_SEGMENT_STATES = ["outside", "cue", "inline_meaning", "continuation", "structural_config", "terminated", "rejected"] as const;

export type ExplicitSegmentState = (typeof EXPLICIT_SEGMENT_STATES)[number];

export const EXPLICIT_SEGMENT_INPUTS = ["approved_cue", "non_empty_inline_meaning", "continuation_line", "blank_line", "next_cue", "structural_fragment", "comment", "list_boundary", "indentation", "nested_marker", "block_scalar", "prose", "unsupported", "eof"] as const;

export type ExplicitSegmentInput = (typeof EXPLICIT_SEGMENT_INPUTS)[number];

export const EXPLICIT_SEGMENT_REASONS = {
  unsupportedTransition: "unsupported_transition",
  structuralFragment: "structural_fragment",
  emptyMeaning: "empty_meaning",
  meaningBoundExceeded: "meaning_bound_exceeded",
  ambiguousReference: "ambiguous_reference",
  conflictingMeaning: "conflicting_meaning",
  invalidExitBoundary: "invalid_exit_boundary",
} as const;

export type ExplicitSegmentReason = (typeof EXPLICIT_SEGMENT_REASONS)[keyof typeof EXPLICIT_SEGMENT_REASONS];

export interface ExplicitSegmentTransition {
  from: ExplicitSegmentState;
  input: ExplicitSegmentInput;
  to: ExplicitSegmentState;
  action: string;
  reason?: ExplicitSegmentReason;
}

function transition(from: ExplicitSegmentState, input: ExplicitSegmentInput, to: ExplicitSegmentState, action: string, reason?: ExplicitSegmentReason): ExplicitSegmentTransition {
  return { from, input, to, action, ...(reason === undefined ? {} : { reason }) };
}

const REQUIRED_TRANSITIONS: readonly ExplicitSegmentTransition[] = [
  transition("outside", "approved_cue", "cue", "enter_cue_segment"),
  transition("outside", "structural_fragment", "structural_config", "enter_structural_config", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("outside", "list_boundary", "structural_config", "enter_structural_config", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("outside", "unsupported", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.unsupportedTransition),
  transition("cue", "non_empty_inline_meaning", "inline_meaning", "capture_inline_meaning"),
  transition("cue", "blank_line", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.emptyMeaning),
  transition("cue", "next_cue", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.emptyMeaning),
  transition("cue", "structural_fragment", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.emptyMeaning),
  transition("cue", "unsupported", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.unsupportedTransition),
  transition("inline_meaning", "continuation_line", "continuation", "append_original_newline"),
  transition("inline_meaning", "blank_line", "terminated", "finish_before_boundary"),
  transition("inline_meaning", "next_cue", "terminated", "finish_before_boundary"),
  transition("inline_meaning", "structural_fragment", "terminated", "finish_before_boundary"),
  transition("inline_meaning", "comment", "terminated", "finish_before_boundary"),
  transition("inline_meaning", "list_boundary", "terminated", "finish_before_boundary"),
  transition("inline_meaning", "prose", "continuation", "append_original_newline"),
  transition("inline_meaning", "eof", "terminated", "finish_at_eof"),
  transition("inline_meaning", "unsupported", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.unsupportedTransition),
  transition("continuation", "continuation_line", "continuation", "append_original_newline"),
  transition("continuation", "prose", "continuation", "append_original_newline"),
  transition("continuation", "blank_line", "terminated", "finish_before_boundary"),
  transition("continuation", "next_cue", "terminated", "finish_before_boundary"),
  transition("continuation", "structural_fragment", "terminated", "finish_before_boundary"),
  transition("continuation", "comment", "terminated", "finish_before_boundary"),
  transition("continuation", "list_boundary", "terminated", "finish_before_boundary"),
  transition("continuation", "eof", "terminated", "finish_at_eof"),
  transition("continuation", "unsupported", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.unsupportedTransition),
  transition("structural_config", "approved_cue", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("structural_config", "structural_fragment", "structural_config", "reject_structural_fragment", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("structural_config", "comment", "structural_config", "reject_structural_fragment", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("structural_config", "blank_line", "structural_config", "reject_structural_fragment", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("structural_config", "indentation", "structural_config", "reject_structural_fragment", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("structural_config", "nested_marker", "structural_config", "reject_structural_fragment", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("structural_config", "block_scalar", "structural_config", "reject_structural_fragment", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("structural_config", "list_boundary", "structural_config", "reject_structural_fragment", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("structural_config", "prose", "outside", "reject_fragment_then_exit", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("structural_config", "unsupported", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.unsupportedTransition),
  transition("structural_config", "eof", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.structuralFragment),
  transition("terminated", "unsupported", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.unsupportedTransition),
  transition("rejected", "unsupported", "rejected", "reject", EXPLICIT_SEGMENT_REASONS.unsupportedTransition),
];
export interface ExplicitSegmentForm {
  id: ExplicitSegmentFormId;
  segmentClass: string;
  syntax: string;
  entry: "outside_approved_cue";
  termination: "shared_bounded_termination";
  output: "shared_cue_segment_output";
}
export interface ExplicitStructuralConfigurationContract {
  state: "structural_config";
  entryInputs: ExplicitSegmentInput[];
  persistInputs: ExplicitSegmentInput[];
  rejectInputs: ExplicitSegmentInput[];
  exit: {
    input: "prose";
    condition: string;
    action: string;
    nextState: "outside";
    definitionAllowed: "next_physical_line_only";
  };
}
export interface ExplicitReferenceBindingContract {
  following: "nearest_next_cue";
  this: "nearest_previous_cue";
  exactTerm: "nearest_matching_cue";
  matching: "unicode_caseless_exact_no_normalization";
  duplicateTargetReason: typeof EXPLICIT_SEGMENT_REASONS.ambiguousReference;
  missingTargetReason: typeof EXPLICIT_SEGMENT_REASONS.ambiguousReference;
  duplicateTargetOutcome: "exclude_bound_cue_only";
  missingTargetOutcome: "exclude_bound_cue_only";
  unrelatedCueOutcome: "retain";
}
export interface ExplicitContinuationContract {
  startsAfter: "non_empty_inline_meaning";
  preserves: "exact_source_newlines_and_utf8_bytes";
  stopsOn: ExplicitSegmentInput[];
  maximumUtf8Bytes: number;
  limit: "inclusive";
  overLimit: "reject";
  overLimitReason: typeof EXPLICIT_SEGMENT_REASONS.meaningBoundExceeded;
}
export interface ExplicitSegmentOutputContract {
  fields: ["term", "meaning", "term_span", "meaning_span"];
  spanEncoding: "utf8_byte_offsets";
  sourceSemantics: "exact_source_bytes_without_unicode_normalization";
}
export interface ExplicitCanonicalOrderContract {
  fields: ["term", "meaning", "term_span.start", "meaning_span.start"];
  comparator: "unicode_scalar_code_point_ascending";
  direction: "ascending";
}
export interface ExplicitSegmentGrammarContract {
  schemaVersion: typeof EXPLICIT_SEGMENT_GRAMMAR_SCHEMA_VERSION;
  segmentClass: "explicit_cue_segment";
  states: readonly ExplicitSegmentState[];
  inputClasses: readonly ExplicitSegmentInput[];
  initialState: "outside";
  terminalStates: readonly ["terminated", "rejected"];
  forms: ReadonlyMap<ExplicitSegmentFormId, ExplicitSegmentForm>;
  entry: {
    from: "outside";
    input: "approved_cue";
    to: "cue";
    acceptedForms: readonly ExplicitSegmentFormId[];
    unsupportedReason: typeof EXPLICIT_SEGMENT_REASONS.unsupportedTransition;
  };
  termination: {
    startState: "inline_meaning";
    continuationState: "continuation";
    terminalState: "terminated";
    required: "non_empty_inline_meaning";
    boundaryInputs: readonly ExplicitSegmentInput[];
    maximumMeaningUtf8Bytes: 4096;
    limit: "inclusive";
    overLimitReason: typeof EXPLICIT_SEGMENT_REASONS.meaningBoundExceeded;
  };
  output: ExplicitSegmentOutputContract;
  continuation: ExplicitContinuationContract;
  structuralConfiguration: ExplicitStructuralConfigurationContract;
  referenceBinding: ExplicitReferenceBindingContract;
  deduplication: {
    identity: "personal_mining_authority.term_identity.stable_term_identity";
    sameIdentitySameMeaning: "retain_one_earliest_source_span";
    sameIdentityDifferentMeaning: "reject_all_conflicting_meaning";
    unrelatedCueOutcome: "retain";
  };
  canonicalOrder: ExplicitCanonicalOrderContract;
  transitions: ReadonlyMap<string, ExplicitSegmentTransition>;
  fallbacks: ReadonlyMap<ExplicitSegmentState, ExplicitSegmentTransition>;
}
export class ExplicitSegmentGrammarContractError extends Error {}
type Mapping = Record<string, unknown>;
function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Mapping) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...(value as string[])] : [];
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return JSON.stringify(strings(value)) === JSON.stringify(expected);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isState(value: unknown): value is ExplicitSegmentState {
  return EXPLICIT_SEGMENT_STATES.includes(value as ExplicitSegmentState);
}

function isInput(value: unknown): value is ExplicitSegmentInput {
  return EXPLICIT_SEGMENT_INPUTS.includes(value as ExplicitSegmentInput);
}

function isReason(value: unknown): value is ExplicitSegmentReason {
  return Object.values(EXPLICIT_SEGMENT_REASONS).includes(value as ExplicitSegmentReason);
}

function transitionKey(from: ExplicitSegmentState, input: ExplicitSegmentInput): string {
  return `${from}:${input}`;
}

function formMappings(value: unknown): Mapping[] {
  return Array.isArray(value) ? value.map(mapping).filter((item): item is Mapping => item !== null) : [];
}

function validateTransition(value: unknown, label: string, fallback: boolean, errors: string[]): void {
  const transition = mapping(value);
  if (!transition) {
    errors.push(`${label} must be a mapping`);
    return;
  }
  if (!isState(transition.from)) errors.push(`${label}.from is not a declared state`);
  if (fallback) {
    if (transition.input !== "unsupported") {
      errors.push(`${label}.input must be unsupported`);
    }
  } else if (!isInput(transition.input)) {
    errors.push(`${label}.input is not a declared input class`);
  }
  if (!isState(transition.to)) errors.push(`${label}.to is not a declared state`);
  if (!nonEmpty(transition.action)) errors.push(`${label}.action is required`);
  if (transition.reason !== undefined && !isReason(transition.reason)) {
    errors.push(`${label}.reason is not a stable grammar reason`);
  }
}

function validateExactObjectFields(value: unknown, fields: readonly string[], label: string, errors: string[]): Mapping | null {
  const result = mapping(value);
  if (!result) {
    errors.push(`${label} must be a mapping`);
    return null;
  }
  for (const field of fields) {
    if (result[field] === undefined) errors.push(`${label}.${field} is required`);
  }
  return result;
}

/** Validate the finite grammar projection nested under explicit_discovery.grammar. */
export function validateExplicitSegmentGrammar(value: unknown): string[] {
  const errors: string[] = [];
  const grammar = mapping(value);
  const segment = mapping(grammar?.segment_grammar);
  if (!segment) {
    errors.push("explicit segment grammar must declare segment_grammar");
    return errors;
  }
  if (segment.schema_version !== EXPLICIT_SEGMENT_GRAMMAR_SCHEMA_VERSION) {
    errors.push("explicit segment grammar schema_version is unsupported");
  }
  if (segment.segment_class !== "explicit_cue_segment") {
    errors.push("explicit segment grammar must declare explicit_cue_segment");
  }
  if (!sameStrings(segment.states, EXPLICIT_SEGMENT_STATES)) {
    errors.push("explicit segment grammar states must remain finite and ordered");
  }
  if (!sameStrings(segment.input_classes, EXPLICIT_SEGMENT_INPUTS)) {
    errors.push("explicit segment grammar input_classes must remain finite and ordered");
  }
  if (segment.initial_state !== "outside") {
    errors.push("explicit segment grammar initial_state must be outside");
  }
  if (!sameStrings(segment.terminal_states, ["terminated", "rejected"])) {
    errors.push("explicit segment grammar terminal_states must be terminated and rejected");
  }

  const forms = formMappings(grammar?.forms);
  if (
    !sameStrings(
      forms.map((form) => String(form.id)),
      EXPLICIT_SEGMENT_FORM_IDS,
    )
  ) {
    errors.push("explicit segment grammar must cover the approved ten cue forms in order");
  }
  for (const [index, form] of forms.entries()) {
    if (!EXPLICIT_SEGMENT_FORM_IDS.includes(form.id as ExplicitSegmentFormId)) {
      errors.push(`explicit segment grammar form[${index}].id is not approved`);
    }
    if (form.segment_class !== "explicit_cue_segment") {
      errors.push(`explicit segment grammar form[${index}] must map to explicit_cue_segment`);
    }
    if (!nonEmpty(form.syntax)) errors.push(`explicit segment grammar form[${index}].syntax is required`);
    if (form.entry !== "outside_approved_cue") {
      errors.push(`explicit segment grammar form[${index}].entry is invalid`);
    }
    if (form.termination !== "shared_bounded_termination") {
      errors.push(`explicit segment grammar form[${index}].termination is invalid`);
    }
    if (form.output !== "shared_cue_segment_output") {
      errors.push(`explicit segment grammar form[${index}].output is invalid`);
    }
  }

  const entry = validateExactObjectFields(segment.entry, ["from", "input", "to", "accepted_forms", "unsupported_reason"], "explicit segment grammar entry", errors);
  if (entry) {
    if (entry.from !== "outside" || entry.input !== "approved_cue" || entry.to !== "cue") {
      errors.push("explicit segment grammar entry must transition outside approved_cue to cue");
    }
    if (!sameStrings(entry.accepted_forms, EXPLICIT_SEGMENT_FORM_IDS)) {
      errors.push("explicit segment grammar entry must accept every approved cue form");
    }
    if (entry.unsupported_reason !== EXPLICIT_SEGMENT_REASONS.unsupportedTransition) {
      errors.push("explicit segment grammar entry must fail closed with unsupported_transition");
    }
  }

  const termination = validateExactObjectFields(segment.termination, ["start_state", "continuation_state", "terminal_state", "required", "boundary_inputs", "maximum_meaning_utf8_bytes", "limit", "over_limit_reason"], "explicit segment grammar termination", errors);
  if (termination) {
    if (termination.start_state !== "inline_meaning" || termination.continuation_state !== "continuation" || termination.terminal_state !== "terminated" || termination.required !== "non_empty_inline_meaning") {
      errors.push("explicit segment grammar termination states are invalid");
    }
    if (!sameStrings(termination.boundary_inputs, ["blank_line", "next_cue", "structural_fragment", "comment", "list_boundary"])) {
      errors.push("explicit segment grammar termination boundary_inputs are invalid");
    }
    if (termination.maximum_meaning_utf8_bytes !== 4096 || termination.limit !== "inclusive") {
      errors.push("explicit segment grammar termination must accept exactly 4096 UTF-8 bytes");
    }
    if (termination.over_limit_reason !== EXPLICIT_SEGMENT_REASONS.meaningBoundExceeded) {
      errors.push("explicit segment grammar termination over_limit_reason is invalid");
    }
  }

  const output = validateExactObjectFields(segment.output, ["fields", "span_encoding", "source_semantics"], "explicit segment grammar output", errors);
  if (output) {
    if (!sameStrings(output.fields, ["term", "meaning", "term_span", "meaning_span"])) {
      errors.push("explicit segment grammar output fields are invalid");
    }
    if (output.span_encoding !== "utf8_byte_offsets") {
      errors.push("explicit segment grammar output must use UTF-8 byte offsets");
    }
    if (output.source_semantics !== "exact_source_bytes_without_unicode_normalization") {
      errors.push("explicit segment grammar output must preserve exact source bytes");
    }
  }

  const continuation = validateExactObjectFields(segment.continuation, ["starts_after", "preserves", "stops_on", "maximum_utf8_bytes", "limit", "over_limit", "over_limit_reason"], "explicit segment grammar continuation", errors);
  if (continuation) {
    if (continuation.starts_after !== "non_empty_inline_meaning") {
      errors.push("explicit segment grammar continuation must start after non-empty inline meaning");
    }
    if (continuation.preserves !== "exact_source_newlines_and_utf8_bytes") {
      errors.push("explicit segment grammar continuation must preserve original newlines and bytes");
    }
    if (!sameStrings(continuation.stops_on, ["blank_line", "next_cue", "structural_fragment", "comment", "list_boundary"])) {
      errors.push("explicit segment grammar continuation stops_on is invalid");
    }
    if (continuation.maximum_utf8_bytes !== 4096 || continuation.limit !== "inclusive") {
      errors.push("explicit segment grammar continuation must accept exactly 4096 UTF-8 bytes");
    }
    if (continuation.over_limit !== "reject" || continuation.over_limit_reason !== EXPLICIT_SEGMENT_REASONS.meaningBoundExceeded) {
      errors.push("explicit segment grammar continuation must reject one byte over the bound");
    }
  }

  const structural = validateExactObjectFields(segment.structural_configuration, ["state", "entry_inputs", "persist_inputs", "reject_inputs", "exit"], "explicit segment grammar structural_configuration", errors);
  if (structural) {
    if (structural.state !== "structural_config") {
      errors.push("explicit segment grammar structural_configuration state is invalid");
    }
    if (!sameStrings(structural.entry_inputs, ["structural_fragment", "list_boundary"])) {
      errors.push("explicit segment grammar structural_configuration entry_inputs are invalid");
    }
    if (!sameStrings(structural.persist_inputs, ["comment", "blank_line", "indentation", "nested_marker", "block_scalar", "structural_fragment", "list_boundary"])) {
      errors.push("explicit segment grammar structural_configuration persist_inputs are invalid");
    }
    if (!sameStrings(structural.reject_inputs, ["comment", "blank_line", "indentation", "nested_marker", "block_scalar", "structural_fragment", "list_boundary", "approved_cue"])) {
      errors.push("explicit segment grammar structural_configuration reject_inputs are invalid");
    }
    const exit = mapping(structural.exit);
    if (!exit) {
      errors.push("explicit segment grammar structural_configuration.exit must be a mapping");
    } else if (exit.input !== "prose" || !nonEmpty(exit.condition) || !nonEmpty(exit.action) || exit.next_state !== "outside" || exit.definition_allowed !== "next_physical_line_only") {
      errors.push("explicit segment grammar structural_configuration must have one finite prose exit");
    }
  }

  const references = validateExactObjectFields(segment.reference_binding, ["following", "this", "exact_term", "matching", "duplicate_target_reason", "missing_target_reason", "duplicate_target_outcome", "missing_target_outcome", "unrelated_cue_outcome"], "explicit segment grammar reference_binding", errors);
  if (references) {
    if (
      references.following !== "nearest_next_cue" ||
      references.this !== "nearest_previous_cue" ||
      references.exact_term !== "nearest_matching_cue" ||
      references.matching !== "unicode_caseless_exact_no_normalization" ||
      references.duplicate_target_reason !== EXPLICIT_SEGMENT_REASONS.ambiguousReference ||
      references.missing_target_reason !== EXPLICIT_SEGMENT_REASONS.ambiguousReference ||
      references.duplicate_target_outcome !== "exclude_bound_cue_only" ||
      references.missing_target_outcome !== "exclude_bound_cue_only" ||
      references.unrelated_cue_outcome !== "retain"
    ) {
      errors.push("explicit segment grammar reference_binding direction and ambiguity rules are invalid");
    }
  }

  const deduplication = validateExactObjectFields(segment.deduplication, ["identity", "same_identity_same_meaning", "same_identity_different_meaning", "unrelated_cue_outcome"], "explicit segment grammar deduplication", errors);
  if (deduplication) {
    if (deduplication.identity !== "personal_mining_authority.term_identity.stable_term_identity" || deduplication.same_identity_same_meaning !== "retain_one_earliest_source_span" || deduplication.same_identity_different_meaning !== "reject_all_conflicting_meaning" || deduplication.unrelated_cue_outcome !== "retain") {
      errors.push("explicit segment grammar deduplication must preserve identity and conflict semantics");
    }
  }

  const order = validateExactObjectFields(segment.canonical_order, ["fields", "comparator", "direction"], "explicit segment grammar canonical_order", errors);
  if (order) {
    if (!sameStrings(order.fields, ["term", "meaning", "term_span.start", "meaning_span.start"]) || order.comparator !== "unicode_scalar_code_point_ascending" || order.direction !== "ascending") {
      errors.push("explicit segment grammar canonical_order must remain lexical and ascending");
    }
  }

  const transitions = Array.isArray(segment.transitions) ? segment.transitions : [];
  const canonicalTransitionKeys = new Set(REQUIRED_TRANSITIONS.map((transition) => transitionKey(transition.from, transition.input)));
  const transitionKeys = new Set<string>();
  for (const [index, value] of transitions.entries()) {
    validateTransition(value, `explicit segment grammar transitions[${index}]`, false, errors);
    const transition = mapping(value);
    if (transition && isState(transition.from) && isInput(transition.input)) {
      const key = transitionKey(transition.from, transition.input);
      if (transitionKeys.has(key)) errors.push(`explicit segment grammar transition ${key} is duplicated`);
      transitionKeys.add(key);
      if (!canonicalTransitionKeys.has(key)) errors.push(`explicit segment grammar transition ${key} is not declared by its finite rule`);
    }
  }
  for (const expected of REQUIRED_TRANSITIONS) {
    const key = transitionKey(expected.from, expected.input);
    const actual = transitions.map(mapping).find((transition): transition is Mapping => transition?.from === expected.from && transition.input === expected.input);
    if (!actual) {
      errors.push(`explicit segment grammar transition ${key} is required`);
      continue;
    }
    if (actual.to !== expected.to || actual.action !== expected.action || (expected.reason === undefined ? actual.reason !== undefined : actual.reason !== expected.reason)) {
      errors.push(`explicit segment grammar transition ${key} does not match its finite rule`);
    }
  }
  const fallbacks = mapping(segment.fallback_transitions);
  if (!fallbacks) {
    errors.push("explicit segment grammar fallback_transitions must declare every state");
  } else {
    for (const state of EXPLICIT_SEGMENT_STATES) {
      const fallback = mapping(fallbacks[state]);
      if (!fallback) {
        errors.push(`explicit segment grammar fallback_transitions.${state} is required`);
        continue;
      }
      validateTransition(fallback, `explicit segment grammar fallback_transitions.${state}`, true, errors);
      if (fallback.from !== state || fallback.to !== "rejected") {
        errors.push(`explicit segment grammar fallback_transitions.${state} must reject from its state`);
      }
      if (fallback.reason !== EXPLICIT_SEGMENT_REASONS.unsupportedTransition) {
        errors.push(`explicit segment grammar fallback_transitions.${state} must use unsupported_transition`);
      }
    }
  }

  const reasonMap = mapping(segment.reasons);
  if (!reasonMap) {
    errors.push("explicit segment grammar reasons must be declared");
  } else {
    for (const [key, reason] of Object.entries(EXPLICIT_SEGMENT_REASONS)) {
      const yamlKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      if (reasonMap[yamlKey] !== reason) {
        errors.push(`explicit segment grammar reasons.${yamlKey} must be ${reason}`);
      }
    }
  }
  return errors;
}

export function explicitSegmentGrammarAuthorityPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "artifacts", "glossary-entry-contract.yaml");
}

function requiredString(value: unknown, label: string): string {
  if (!nonEmpty(value)) throw new ExplicitSegmentGrammarContractError(`${label} must be non-empty`);
  return value;
}

/** Load the validated finite contract that a future explicit parser consumes. */
export function loadExplicitSegmentGrammarContract(pathname: string = explicitSegmentGrammarAuthorityPath()): ExplicitSegmentGrammarContract {
  let authority: Mapping;
  try {
    authority = loadYamlMappingFile(pathname);
  } catch (error) {
    throw new ExplicitSegmentGrammarContractError(`glossary entry authority ${pathname} is unreadable or malformed: ${(error as Error).message}`);
  }
  const mining = mapping(authority.personal_mining_authority);
  const explicitDiscovery = mapping(mining?.explicit_discovery);
  const grammar = mapping(explicitDiscovery?.grammar);
  const errors = validateExplicitSegmentGrammar(grammar);
  if (errors.length > 0) throw new ExplicitSegmentGrammarContractError(errors.join("; "));

  const segment = mapping(grammar?.segment_grammar)!;
  const forms = new Map<ExplicitSegmentFormId, ExplicitSegmentForm>();
  for (const value of formMappings(grammar?.forms)) {
    const id = value.id as ExplicitSegmentFormId;
    forms.set(id, {
      id,
      segmentClass: requiredString(value.segment_class, `form ${id}.segment_class`),
      syntax: requiredString(value.syntax, `form ${id}.syntax`),
      entry: "outside_approved_cue",
      termination: "shared_bounded_termination",
      output: "shared_cue_segment_output",
    });
  }

  const transitions = new Map<string, ExplicitSegmentTransition>();
  for (const value of Array.isArray(segment.transitions) ? segment.transitions : []) {
    const transition = mapping(value)!;
    const from = transition.from as ExplicitSegmentState;
    const input = transition.input as ExplicitSegmentInput;
    transitions.set(transitionKey(from, input), {
      from,
      input,
      to: transition.to as ExplicitSegmentState,
      action: requiredString(transition.action, `${from}:${input}.action`),
      ...(transition.reason === undefined ? {} : { reason: transition.reason as ExplicitSegmentReason }),
    });
  }
  const fallbackMap = new Map<ExplicitSegmentState, ExplicitSegmentTransition>();
  const fallbackMappings = mapping(segment.fallback_transitions)!;
  for (const state of EXPLICIT_SEGMENT_STATES) {
    const value = mapping(fallbackMappings[state])!;
    fallbackMap.set(state, {
      from: state,
      input: "unsupported",
      to: "rejected",
      action: requiredString(value.action, `fallback ${state}.action`),
      reason: value.reason as ExplicitSegmentReason,
    });
  }

  const entry = mapping(segment.entry)!;
  const termination = mapping(segment.termination)!;
  const continuation = mapping(segment.continuation)!;
  const structural = mapping(segment.structural_configuration)!;
  const structuralExit = mapping(structural.exit)!;
  const references = mapping(segment.reference_binding)!;

  return {
    schemaVersion: segment.schema_version as typeof EXPLICIT_SEGMENT_GRAMMAR_SCHEMA_VERSION,
    segmentClass: segment.segment_class as "explicit_cue_segment",
    states: [...(strings(segment.states) as ExplicitSegmentState[])],
    inputClasses: [...(strings(segment.input_classes) as ExplicitSegmentInput[])],
    initialState: "outside",
    terminalStates: ["terminated", "rejected"],
    forms,
    entry: {
      from: "outside",
      input: "approved_cue",
      to: "cue",
      acceptedForms: strings(entry.accepted_forms) as ExplicitSegmentFormId[],
      unsupportedReason: entry.unsupported_reason as typeof EXPLICIT_SEGMENT_REASONS.unsupportedTransition,
    },
    termination: {
      startState: "inline_meaning",
      continuationState: "continuation",
      terminalState: "terminated",
      required: "non_empty_inline_meaning",
      boundaryInputs: strings(termination.boundary_inputs) as ExplicitSegmentInput[],
      maximumMeaningUtf8Bytes: 4096,
      limit: "inclusive",
      overLimitReason: termination.over_limit_reason as typeof EXPLICIT_SEGMENT_REASONS.meaningBoundExceeded,
    },
    output: {
      fields: ["term", "meaning", "term_span", "meaning_span"],
      spanEncoding: "utf8_byte_offsets",
      sourceSemantics: "exact_source_bytes_without_unicode_normalization",
    },
    continuation: {
      startsAfter: "non_empty_inline_meaning",
      preserves: "exact_source_newlines_and_utf8_bytes",
      stopsOn: strings(continuation.stops_on) as ExplicitSegmentInput[],
      maximumUtf8Bytes: 4096,
      limit: "inclusive",
      overLimit: "reject",
      overLimitReason: continuation.over_limit_reason as typeof EXPLICIT_SEGMENT_REASONS.meaningBoundExceeded,
    },
    structuralConfiguration: {
      state: "structural_config",
      entryInputs: strings(structural.entry_inputs) as ExplicitSegmentInput[],
      persistInputs: strings(structural.persist_inputs) as ExplicitSegmentInput[],
      rejectInputs: strings(structural.reject_inputs) as ExplicitSegmentInput[],
      exit: {
        input: "prose",
        condition: requiredString(structuralExit.condition, "structural exit.condition"),
        action: requiredString(structuralExit.action, "structural exit.action"),
        nextState: "outside",
        definitionAllowed: "next_physical_line_only",
      },
    },
    referenceBinding: {
      following: "nearest_next_cue",
      this: "nearest_previous_cue",
      exactTerm: "nearest_matching_cue",
      matching: "unicode_caseless_exact_no_normalization",
      duplicateTargetReason: references.duplicate_target_reason as typeof EXPLICIT_SEGMENT_REASONS.ambiguousReference,
      missingTargetReason: references.missing_target_reason as typeof EXPLICIT_SEGMENT_REASONS.ambiguousReference,
      duplicateTargetOutcome: "exclude_bound_cue_only",
      missingTargetOutcome: "exclude_bound_cue_only",
      unrelatedCueOutcome: "retain",
    },
    deduplication: {
      identity: "personal_mining_authority.term_identity.stable_term_identity",
      sameIdentitySameMeaning: "retain_one_earliest_source_span",
      sameIdentityDifferentMeaning: "reject_all_conflicting_meaning",
      unrelatedCueOutcome: "retain",
    },
    canonicalOrder: {
      fields: ["term", "meaning", "term_span.start", "meaning_span.start"],
      comparator: "unicode_scalar_code_point_ascending",
      direction: "ascending",
    },
    transitions,
    fallbacks: fallbackMap,
  };
}

/** Resolve one transition, falling back to the declared stable rejection. */
export function explicitSegmentTransition(contract: ExplicitSegmentGrammarContract, state: ExplicitSegmentState, input: ExplicitSegmentInput): ExplicitSegmentTransition {
  return (
    contract.transitions.get(transitionKey(state, input)) ??
    contract.fallbacks.get(state) ?? {
      from: state,
      input,
      to: "rejected",
      action: "reject",
      reason: EXPLICIT_SEGMENT_REASONS.unsupportedTransition,
    }
  );
}

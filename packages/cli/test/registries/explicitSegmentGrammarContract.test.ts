import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXPLICIT_SEGMENT_FORM_IDS,
  EXPLICIT_SEGMENT_INPUTS,
  EXPLICIT_SEGMENT_REASONS,
  EXPLICIT_SEGMENT_STATES,
  explicitSegmentTransition,
  loadExplicitSegmentGrammarContract,
  validateExplicitSegmentGrammar,
} from "../../src/registries/explicitSegmentGrammarContract.js";
import {
  glossaryEntryAuthorityPath,
  validateGlossaryEntryContract,
} from "../../src/registries/glossaryEntryContract.js";

const productionAuthority = glossaryEntryAuthorityPath();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function grammarFixture(mutate: (grammar: Record<string, any>) => void = () => undefined): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-segment-grammar-"));
  temporaryDirectories.push(directory);
  const authority = YAML.parse(fs.readFileSync(productionAuthority, "utf8")) as Record<string, any>;
  const grammar = authority.personal_mining_authority.explicit_discovery.grammar as Record<
    string,
    any
  >;
  mutate(grammar);
  const pathname = path.join(directory, "authority.yaml");
  fs.writeFileSync(pathname, YAML.stringify(authority), "utf8");
  return pathname;
}

function grammarAt(pathname: string): Record<string, any> {
  const authority = YAML.parse(fs.readFileSync(pathname, "utf8")) as Record<string, any>;
  return authority.personal_mining_authority.explicit_discovery.grammar;
}

describe("finite explicit segment grammar authority", () => {
  it("loads one bounded segment class for all ten approved forms", () => {
    const contract = loadExplicitSegmentGrammarContract(productionAuthority);

    expect(contract.segmentClass).toBe("explicit_cue_segment");
    expect([...contract.forms.keys()]).toEqual([...EXPLICIT_SEGMENT_FORM_IDS]);
    expect(
      [...contract.forms.values()].every(
        (form) =>
          form.segmentClass === contract.segmentClass &&
          form.entry === "outside_approved_cue" &&
          form.termination === "shared_bounded_termination" &&
          form.output === "shared_cue_segment_output",
      ),
    ).toBe(true);
    expect(contract.states).toEqual(EXPLICIT_SEGMENT_STATES);
    expect(contract.inputClasses).toEqual(EXPLICIT_SEGMENT_INPUTS);
    expect(contract.entry).toMatchObject({
      from: "outside",
      input: "approved_cue",
      to: "cue",
      acceptedForms: EXPLICIT_SEGMENT_FORM_IDS,
      unsupportedReason: EXPLICIT_SEGMENT_REASONS.unsupportedTransition,
    });
    expect(contract.output).toEqual({
      fields: ["term", "meaning", "term_span", "meaning_span"],
      spanEncoding: "utf8_byte_offsets",
      sourceSemantics: "exact_source_bytes_without_unicode_normalization",
    });
  });

  it("declares a fail-closed transition or fallback for every state and input", () => {
    const contract = loadExplicitSegmentGrammarContract(productionAuthority);

    for (const state of EXPLICIT_SEGMENT_STATES) {
      for (const input of EXPLICIT_SEGMENT_INPUTS) {
        const transition = explicitSegmentTransition(contract, state, input);
        expect(transition.from).toBe(state);
        expect(transition.to).toBeTruthy();
        expect(transition.action).toBeTruthy();
        if (!contract.transitions.has(`${state}:${input}`)) {
          expect(transition.to).toBe("rejected");
          expect(transition.reason).toBe(EXPLICIT_SEGMENT_REASONS.unsupportedTransition);
        }
      }
    }
  });

  it("enters structural_config for an outside list boundary", () => {
    const contract = loadExplicitSegmentGrammarContract(productionAuthority);
    expect(explicitSegmentTransition(contract, "outside", "list_boundary")).toEqual({
      from: "outside",
      input: "list_boundary",
      to: "structural_config",
      action: "enter_structural_config",
      reason: EXPLICIT_SEGMENT_REASONS.structuralFragment,
    });
  });

  it("rejects every mutated declared transition", () => {
    const sourceTransitions = grammarAt(productionAuthority).segment_grammar.transitions as Array<
      Record<string, any>
    >;
    for (const [index, source] of sourceTransitions.entries()) {
      const pathname = grammarFixture((grammar) => {
        const transition = grammar.segment_grammar.transitions[index] as Record<string, any>;
        transition.to = transition.to === "rejected" ? "outside" : "rejected";
      });
      expect(
        validateGlossaryEntryContract(pathname).some((error) =>
          error.includes(
            `transition ${source.from}:${source.input} does not match its finite rule`,
          ),
        ),
      ).toBe(true);
    }
  });

  it("rejects an appended transition outside the canonical finite table", () => {
    const pathname = grammarFixture((grammar) => {
      grammar.segment_grammar.transitions.push({
        from: "outside",
        input: "prose",
        to: "cue",
        action: "enter_cue_segment",
      });
    });
    expect(validateGlossaryEntryContract(pathname)).toContain(
      "explicit segment grammar transition outside:prose is not declared by its finite rule",
    );
  });

  it("declares structural persistence, one finite exit, reference binding, and exact continuation bounds", () => {
    const contract = loadExplicitSegmentGrammarContract(productionAuthority);

    expect(contract.structuralConfiguration).toEqual({
      state: "structural_config",
      entryInputs: ["structural_fragment", "list_boundary"],
      persistInputs: [
        "comment",
        "blank_line",
        "indentation",
        "nested_marker",
        "block_scalar",
        "structural_fragment",
        "list_boundary",
      ],
      rejectInputs: [
        "comment",
        "blank_line",
        "indentation",
        "nested_marker",
        "block_scalar",
        "structural_fragment",
        "list_boundary",
        "approved_cue",
      ],
      exit: {
        input: "prose",
        condition: "top_level_nonempty_noncomment_nonmarker_nonstructural_line",
        action: "reject_fragment_then_exit",
        nextState: "outside",
        definitionAllowed: "next_physical_line_only",
      },
    });
    expect(contract.referenceBinding).toEqual({
      following: "nearest_next_cue",
      this: "nearest_previous_cue",
      exactTerm: "nearest_matching_cue",
      matching: "unicode_caseless_exact_no_normalization",
      duplicateTargetReason: EXPLICIT_SEGMENT_REASONS.ambiguousReference,
      missingTargetReason: EXPLICIT_SEGMENT_REASONS.ambiguousReference,
      duplicateTargetOutcome: "exclude_bound_cue_only",
      missingTargetOutcome: "exclude_bound_cue_only",
      unrelatedCueOutcome: "retain",
    });
    expect(contract.continuation).toEqual({
      startsAfter: "non_empty_inline_meaning",
      preserves: "exact_source_newlines_and_utf8_bytes",
      stopsOn: ["blank_line", "next_cue", "structural_fragment", "comment", "list_boundary"],
      maximumUtf8Bytes: 4096,
      limit: "inclusive",
      overLimit: "reject",
      overLimitReason: EXPLICIT_SEGMENT_REASONS.meaningBoundExceeded,
    });
    expect(contract.deduplication).toEqual({
      identity: "personal_mining_authority.term_identity.stable_term_identity",
      sameIdentitySameMeaning: "retain_one_earliest_source_span",
      sameIdentityDifferentMeaning: "reject_all_conflicting_meaning",
      unrelatedCueOutcome: "retain",
    });
    expect(contract.canonicalOrder).toEqual({
      fields: ["term", "meaning", "term_span.start", "meaning_span.start"],
      comparator: "unicode_scalar_code_point_ascending",
      direction: "ascending",
    });
  });

  it.each([
    [
      "state transition",
      (segment: Record<string, any>) => (segment.transitions[0].to = "outside"),
      "transition",
    ],
    [
      "rejection reason",
      (segment: Record<string, any>) => (segment.reasons.unsupported_transition = "wrong"),
      "reasons.unsupported_transition",
    ],
    [
      "exit boundary",
      (segment: Record<string, any>) =>
        (segment.structural_configuration.exit.definition_allowed = "same_line"),
      "structural_configuration must have one finite prose exit",
    ],
    [
      "direction",
      (segment: Record<string, any>) =>
        (segment.reference_binding.following = "nearest_previous_cue"),
      "reference_binding direction",
    ],
    [
      "direction",
      (segment: Record<string, any>) => (segment.reference_binding.this = "nearest_next_cue"),
      "reference_binding direction",
    ],
    [
      "direction",
      (segment: Record<string, any>) =>
        (segment.reference_binding.exact_term = "nearest_previous_cue"),
      "reference_binding direction",
    ],
    [
      "duplicate target",
      (segment: Record<string, any>) =>
        (segment.reference_binding.duplicate_target_reason = "unsupported_transition"),
      "reference_binding direction",
    ],
    [
      "missing target",
      (segment: Record<string, any>) =>
        (segment.reference_binding.missing_target_reason = "unsupported_transition"),
      "reference_binding direction",
    ],
    [
      "bound",
      (segment: Record<string, any>) => (segment.continuation.maximum_utf8_bytes = 4097),
      "continuation must accept exactly 4096",
    ],
    [
      "termination bound",
      (segment: Record<string, any>) => (segment.termination.maximum_meaning_utf8_bytes = 4097),
      "termination must accept exactly 4096",
    ],
    [
      "continuation entry",
      (segment: Record<string, any>) =>
        (segment.continuation.starts_after = "empty_inline_meaning"),
      "continuation must start after non-empty inline meaning",
    ],
    [
      "continuation boundary",
      (segment: Record<string, any>) => (segment.continuation.stops_on = ["blank_line"]),
      "continuation stops_on is invalid",
    ],
    [
      "output contract",
      (segment: Record<string, any>) => (segment.output.span_encoding = "character_offsets"),
      "output must use UTF-8 byte offsets",
    ],
    [
      "deduplication conflict",
      (segment: Record<string, any>) =>
        (segment.deduplication.same_identity_different_meaning = "retain_both"),
      "deduplication must preserve identity and conflict semantics",
    ],
    [
      "canonical lexical order",
      (segment: Record<string, any>) => (segment.canonical_order.direction = "descending"),
      "canonical_order must remain lexical",
    ],
    [
      "canonical lexical comparator",
      (segment: Record<string, any>) => (segment.canonical_order.comparator = "locale_compare"),
      "canonical_order must remain lexical",
    ],
    [
      "canonical lexical fields",
      (segment: Record<string, any>) =>
        (segment.canonical_order.fields = [
          "meaning",
          "term",
          "term_span.start",
          "meaning_span.start",
        ]),
      "canonical_order must remain lexical",
    ],
  ] as const)("rejects a mutated %s rule", (_name, mutate, expected) => {
    const pathname = grammarFixture((grammar) => mutate(grammar.segment_grammar));
    const errors = validateGlossaryEntryContract(pathname);
    expect(errors.some((error) => error.includes(expected))).toBe(true);
  });

  it.each([
    ["entry", (form: Record<string, any>) => (form.entry = "anywhere")],
    ["termination", (form: Record<string, any>) => (form.termination = "unbounded")],
    ["output", (form: Record<string, any>) => (form.output = "display_only")],
  ] as const)("rejects a mutated form %s rule", (_name, mutate) => {
    const pathname = grammarFixture((grammar) => mutate(grammar.forms[0]));
    expect(validateGlossaryEntryContract(pathname).some((error) => error.includes("form[0]"))).toBe(
      true,
    );
  });

  it("rejects an undeclared structural persistence input and a missing fail-closed state fallback", () => {
    const persistencePath = grammarFixture((grammar) => {
      grammar.segment_grammar.structural_configuration.persist_inputs = ["comment"];
    });
    expect(
      validateGlossaryEntryContract(persistencePath).some((error) =>
        error.includes("persist_inputs"),
      ),
    ).toBe(true);

    const fallbackPath = grammarFixture((grammar) => {
      delete grammar.segment_grammar.fallback_transitions.structural_config;
    });
    expect(
      validateGlossaryEntryContract(fallbackPath).some((error) =>
        error.includes("fallback_transitions.structural_config"),
      ),
    ).toBe(true);
  });

  it("accepts the production authority and rejects the same mutations through the direct grammar validator", () => {
    expect(validateExplicitSegmentGrammar(grammarAt(productionAuthority))).toEqual([]);
    const pathname = grammarFixture((grammar) => {
      grammar.segment_grammar.termination.maximum_meaning_utf8_bytes = 4097;
    });
    expect(validateExplicitSegmentGrammar(grammarAt(pathname))).toContain(
      "explicit segment grammar termination must accept exactly 4096 UTF-8 bytes",
    );
  });
});

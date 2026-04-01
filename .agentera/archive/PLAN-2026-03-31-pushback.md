# Plan: Add pushback discipline to resonera

<!-- Level: light | Created: 2026-03-31 | Status: active -->

## What

Add a "Pushback discipline" subsection to resonera's "Asking good questions" section with
3-4 explicit principles for not accepting vague, unverified, or imprecise answers during
deliberation. Inspired by gstack/office-hours anti-sycophancy patterns (Decision 10).

## Why

Resonera says "gently challenge assumptions" but doesn't codify HOW to push back. A user
can give a vague answer ("it should be faster," "everyone needs this," "the obvious approach")
and resonera has no explicit instruction to press for specifics. Adding pushback discipline
makes deliberation sharper without changing resonera's warm personality.

## Constraints

- Preserve resonera's personality (warm, casual, curious — not aggressive or interrogative)
- Fit within the existing "Asking good questions" section structure
- Do not add a separate mode or phase — these are principles, not a workflow change
- Do not touch safety rails, cross-skill integration, or artifact format

## Acceptance Criteria

- GIVEN a new "Pushback discipline" subsection in "Asking good questions" WHEN reading it THEN it contains at least 3 named principles with concrete example phrasings
- GIVEN the pushback principles WHEN comparing tone to resonera's personality section THEN they feel like the same voice (warm challenge, not cold interrogation)
- GIVEN the modified SKILL.md WHEN running the ecosystem linter THEN 0 errors (no regressions)

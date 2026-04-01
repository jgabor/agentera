# Plan: Completion Status Protocol and Eval Framework

<!-- Level: full | Created: 2026-03-31 | Status: active -->
<!-- Reviewed: 2026-03-31 | Critic issues: 9 found, 8 addressed, 1 dismissed -->

## What

Add two new ecosystem primitives (completion status protocol + escalation discipline) to
the shared spec, propagate them to all 10 SKILL.md files as a dedicated structural section,
expand the linter to validate them, and build a Tier 2 eval framework that smoke-tests
skills via `claude -p` for crash/error detection.

## Why

The inspirera analysis of gstack identified three gaps: (1) no standardized way for skills
to report outcomes — each skill currently reports completion differently, making it
impossible for downstream skills to programmatically determine what happened upstream;
(2) no escalation discipline for autonomous loops — realisera and optimera can silently
produce bad work when stuck; (3) no testing beyond structural alignment — the linter
validates SKILL.md structure but not whether skills function when invoked.

Relationship to vision: "compounding over convenience" requires reliable skill outcomes.
If a skill silently fails or reports ambiguously, the compounding chain breaks. Standardized
exit status is the foundation for future cross-skill orchestration.

## Constraints

- Python scripts use stdlib only (no pip dependencies) — existing convention
- The ecosystem linter must continue passing (0 errors) for all 10 skills after changes
- 2 pre-existing advisory warnings (inspektera ISSUES.md format, optimera EXPERIMENTS.md
  format) are known deferrals and not in scope for this plan
- Eval framework requires a Claude Code installation for Tier 2; must exit cleanly without one
- New primitives must follow the same spec pattern: definition, rules, linter check spec
- SKILL.md changes must not break existing skill behavior — additive only
- Completion protocol goes in a dedicated section, not inside safety rails (which has its
  own structural format: NEVER constraints in critical tags)

## Scope

**In**: ecosystem-spec.md (2 new sections), validate-ecosystem.py (2 new checks), all 10
SKILL.md files (new completion protocol section), new eval runner script, CLAUDE.md update

**Out**: Tier 3 LLM-as-judge evaluation. Modifying existing skill workflow logic. Changing
existing artifact formats. Remote telemetry. Machine-readable completion status parsing by
downstream skills (requires artifact format changes not yet designed).

**Deferred**: Tier 3 quality scoring. Downstream skill consumption of completion status
(future plan). Integration of eval runner into pre-commit hooks (too slow for commit-time).

## Design

The completion status protocol adds two new sections to ecosystem-spec.md: one defining
four exit statuses (DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT) with rules for
when each applies, and one defining the escalation discipline for autonomous-loop skills.

Each SKILL.md gets a new `## Completion protocol` section (peer to Safety rails, not nested
inside it) specifying the four statuses and when the skill should report each. For
autonomous-loop skills (realisera, optimera), the section also includes escalation language.
The escalation rule works via PROGRESS.md inspection: the skill reads the last 3 cycle
entries to detect consecutive failure patterns. Optimera's existing plateau detection in
analyze_experiments.py is complementary (it detects experiment stagnation; the new primitive
covers general execution failure).

The spec defines the exact structural pattern the linter matches: a `## Completion protocol`
heading, the four status terms, and for autonomous-loop skills, the escalation threshold
language. The linter gets two new check functions matching these patterns.

The eval framework lives in `scripts/eval-skills.py`. Its scope is crash/error detection
only — it verifies that each skill can be invoked without erroring, not that it produces
correct output. It uses subprocess to spawn `claude -p` sessions with minimal trigger
prompts. Parallel execution uses multiple subprocesses. Output is JSON (per-skill pass/fail
with timing and any error details).

Tasks 2, 3, and 4 modify non-overlapping file sets and can execute in parallel worktrees.

## Tasks

### Task 1: Spec the new primitives in ecosystem-spec.md
**Depends on**: none
**Status**: complete
**Acceptance**:
- GIVEN ecosystem-spec.md WHEN read THEN it contains a "Completion Status Protocol" section defining exactly four statuses (DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT) with clear semantics and rules
- GIVEN ecosystem-spec.md WHEN read THEN it contains an "Escalation Discipline" section specifying the 3-failure threshold with the required response (stop, log to ISSUES.md, surface to user) and how failures are detected via PROGRESS.md inspection
- GIVEN both new sections WHEN read THEN each includes a "Linter check" subsection defining the exact structural pattern and string matches the linter will validate
- GIVEN the spec WHEN read THEN the structural home for completion protocol in SKILL.md files is defined as a `## Completion protocol` section (peer to Safety rails)

### Task 2: Expand the ecosystem linter with new checks
**Depends on**: Task 1
**Status**: complete
**Acceptance**:
- GIVEN a SKILL.md with a `## Completion protocol` section containing all four status terms WHEN the linter runs THEN the completion-protocol check passes
- GIVEN a SKILL.md without a `## Completion protocol` section WHEN the linter runs THEN the check reports an error
- GIVEN realisera or optimera without escalation threshold language WHEN the linter runs THEN the escalation check reports an error
- GIVEN a non-autonomous skill (e.g. inspirera) without escalation language WHEN the linter runs THEN the escalation check passes (not required for non-autonomous skills)

### Task 3: Propagate completion protocol to all 10 SKILL.md files
**Depends on**: Task 1
**Status**: complete
**Acceptance**:
- GIVEN any of the 10 SKILL.md files WHEN read THEN it contains a `## Completion protocol` section as a peer heading to `## Safety rails`
- GIVEN each completion protocol section WHEN read THEN it defines all four statuses with skill-specific guidance on when each applies
- GIVEN realisera and optimera WHEN read THEN their completion protocol sections include explicit escalation discipline with the 3-failure threshold and PROGRESS.md inspection
- GIVEN the ecosystem linter WHEN run after propagation THEN 0 errors across all 10 skills including the new checks

### Task 4: Build the Tier 2 eval runner
**Depends on**: Task 1
**Status**: complete
**Acceptance**:
- GIVEN the eval runner WHEN invoked with `--dry-run` THEN it lists all 10 skills and the prompts it would send without spawning any sessions
- GIVEN the eval runner WHEN invoked for a single skill THEN it reports pass or fail for that skill with timing and any error details
- GIVEN the eval runner WHEN multiple skills are specified THEN it runs them in parallel and reports aggregate results
- GIVEN a machine without Claude Code installed WHEN the eval runner is invoked THEN it exits with a clear error message, not a crash

### Task 5: Integration verification and repo docs update
**Depends on**: Tasks 2, 3, 4
**Status**: complete
**Acceptance**:
- GIVEN the ecosystem linter WHEN run from the repo root THEN it passes with 0 errors across all 10 skills including the 2 new checks (11 total)
- GIVEN CLAUDE.md WHEN read THEN it documents the eval runner under the Python scripts section
- GIVEN the README WHEN read THEN it reflects the updated ecosystem spec scope

## Overall Acceptance

- GIVEN any skill's SKILL.md in the ecosystem WHEN read THEN it contains a completion protocol section with instructions to report one of the four standardized statuses
- GIVEN realisera or optimera WHEN encountering 3 consecutive failed cycles (detected via PROGRESS.md inspection) THEN the SKILL.md instructs the agent to stop, log to ISSUES.md, and surface to the user
- GIVEN the eval framework WHEN run THEN it verifies all 10 skills can be invoked without crashing, reporting per-skill pass/fail
- GIVEN the ecosystem linter WHEN run THEN it validates completion protocol and escalation discipline alongside the existing 9 checks (11 total)

## Surprises

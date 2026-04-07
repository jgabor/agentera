# Plan: Reality verification gate (ISS-36)

<!-- Level: full | Created: 2026-04-07 | Status: active -->
<!-- Reviewed: 2026-04-07 | Critic issues: 12 found, 11 addressed, 1 dismissed -->

## What

Add a "reality verification" requirement to realisera's cycle-close flow and orkestrera's task evaluation. The gate requires running the cycle's new behavior against real project state (not fixtures or mocks) and recording observed output as evidence in PROGRESS.md. The convention is defined abstractly in a new ecosystem-spec Section 19 so it is portable across any runtime that speaks the spec, not Claude Code specific. Adds one linter check with three tests.

## Why

lira Audit 6 (2026-04-07) documented two consecutive milestones (v0.20, v0.21) that shipped "complete" with green tests but critical UX bugs that a single end-to-end run against the production datastore would have caught. Realisera Step 6 currently runs tests/lint/build (structural verification) but has no behavioral verification phase. Orkestrera Step 3 evaluates via inspektera (artifact audit), which reads files but does not verify the feature was executed. Profile entries "Smoke test before declaring done" and "Trust-but-verify: demands proof, not claims" at confidence 85 already validate this direction. The gap is codification in the spec so the convention propagates to any runtime. ISS-36 is the methodology meta-finding behind lira F8/F9/F11/F12.

## Constraints

- Section 19 text must be runtime-agnostic: no Claude Code harness assumptions, no hook-specific language
- MUST NOT merge with the plan-level freshness checkpoint convention (commit 2a44b12): aggregate-artifact rollup and code-behavior verification are orthogonal gates
- MUST NOT invent a new validation mechanism overlapping with PostToolUse or the existing linter (Decision 24: one validation path)
- Realisera and orkestrera each enforce the gate independently (standalone + mesh)
- Orkestrera enforcement is a presence check on PROGRESS.md (an artifact, allowed) plus an inspektera dispatch prompt extension. The conductor never reads implementation source code per its safety rails
- Verification runs on the merged main checkout, NOT inside the dispatched worktree: the sub-agent's responsibility ends at merge, realisera owns verification post-merge
- Test proportionality per Decision 21: default 1 pass + 1 fail per testable unit. Task 4 overrides to 1 pass + 2 fails because the linter check has two subjects (realisera, orkestrera) and the fail case bifurcates
- N/A escape must use an enumerated allowlist to prevent abuse (`docs-only`, `refactor-no-behavior-change`, `chore-dep-bump`, `chore-build-config`, `test-only`); free-form rationales must be ≥ 8 words
- The "primary entrypoint" concept must be defined as a project-archetype taxonomy in Section 19, not asserted per project

## Scope

**In**: ecosystem-spec.md Section 19, realisera SKILL.md Step 6 extension + spec_sections frontmatter + PROGRESS.md cycle entry format addition, orkestrera SKILL.md Step 3 evidence check + spec_sections frontmatter + inspektera dispatch prompt update, 1 new linter check with proportional tests, version bump, plan-level freshness checkpoint
**Out**: automated verification runners, CI gating for the new check (ISS-31 territory), PreToolUse enforcement hooks, per-project verification budgets in DOCS.md (a future convention extension)
**Deferred**: inspektera gaining a graded HEALTH.md verification-hygiene dimension that scores recurring N/A patterns and missing evidence over time (revisit if the gate's adoption surfaces drift)

## Design

The gate lives inside realisera's existing **Step 6: Verify**, extending it from "tests + lint + build" to "tests + lint + build + reality". Not a new step. Verification has two phases: structural (the existing test suite) and behavioral (running the new feature against real project state and observing the output). Evidence is recorded in PROGRESS.md cycle entries as a new `**Verified**` field alongside Commit / Discovered / Next / Context. The field is mandatory for every cycle. Non-runnable work uses `N/A: <enumerated-tag>` from an allowlist; anything outside the allowlist requires a free-form rationale ≥ 8 words.

For dispatched-agent cycles, verification happens in realisera's main checkout AFTER the worktree merge, not inside the worktree. The sub-agent implements; realisera verifies. This preserves the boundary: dispatched agents cannot self-attest verification.

Orkestrera's **Step 3 Evaluate** gains two enforcement points: (1) the conductor reads the latest PROGRESS.md cycle entry and confirms the `**Verified**` field is present and non-empty (artifact read, not source read, complies with conductor safety rails). (2) The dispatch prompt to inspektera is extended with a Section 19 evidence-format snippet so inspektera audits whether the recorded evidence actually corresponds to the task's acceptance criteria. Inspektera does the content quality check; the conductor only does the presence check.

Section 19 in ecosystem-spec.md follows the Section 18 pattern: defines what the gate is, when it applies, the evidence format in PROGRESS.md, the N/A allowlist with each tag's meaning, a project-archetype taxonomy mapping common project types (CLI tool, library/SDK, web service, skill repo, design system, data pipeline) to canonical entrypoint forms, an optional `verification_budget` convention for projects to set wall-clock caps, and a skill-to-gate mapping table showing realisera and orkestrera as enforcers.

The linter gains one new check: realisera and orkestrera SKILL.md must reference Section 19 and must include the new field name (`**Verified**`) in their PROGRESS.md format examples. The check has two subjects, so the test expansion is justified per Decision 21 override discipline: 1 pass + 2 fails (one fail per missing subject).

## Tasks

### Task 1: Section 19 "Reality Verification Gate" in ecosystem-spec.md

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the ecosystem spec WHEN Section 19 is added THEN the section text is runtime-agnostic with no Claude Code harness assumptions
▸ GIVEN Section 19 WHEN the evidence format is defined THEN PROGRESS.md cycle entries are required to include a `**Verified**` field with either observed output from running the primary entrypoint OR an N/A tag from the enumerated allowlist
▸ GIVEN Section 19 WHEN the N/A allowlist is defined THEN it enumerates exactly: `docs-only`, `refactor-no-behavior-change`, `chore-dep-bump`, `chore-build-config`, `test-only`, with one-line meaning per tag, and notes that any free-form N/A rationale must be ≥ 8 words explaining why the change has no observable behavior
▸ GIVEN Section 19 WHEN the project-archetype taxonomy is defined THEN it maps at least these archetypes to canonical entrypoint forms: CLI tool (invoke binary with realistic args), library/SDK (smoke driver exercising the public API), web service (hit production-shaped endpoint), skill repo (dispatch the skill via the runtime's eval mechanism), design system (render a representative component against real tokens), data pipeline (run against a real input sample)
▸ GIVEN Section 19 WHEN the optional verification_budget convention is defined THEN projects can set a per-cycle max wall-clock cap; cycles that exceed the budget MAY downgrade to `**Verified**: partial — <budget hit>` recording what was attempted and observed
▸ GIVEN Section 19 WHEN the skill-to-gate mapping table is defined THEN realisera is listed as primary enforcer (cycle close) and orkestrera is listed as secondary enforcer (task evaluation via PROGRESS.md presence check + inspektera dispatch audit)
▸ GIVEN the spec addition WHEN `python3 scripts/generate_ecosystem_context.py` runs THEN per-skill context files for realisera and orkestrera include Section 19

### Task 2: Realisera Step 6 verification extension and PROGRESS format

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN realisera Step 6 WHEN a cycle reaches verification THEN the cycle runs the existing test/lint/build suite AND observes the new behavior by running the project's primary entrypoint against real project state AND records the observation as a `**Verified**` field in the new PROGRESS.md cycle entry
▸ GIVEN a cycle whose work has no runnable behavior change WHEN Step 6 runs THEN the `**Verified**` field is populated with `N/A: <tag>` using one of the enumerated allowlist tags from Section 19, or with a free-form rationale ≥ 8 words
▸ GIVEN a cycle whose work was implemented by a dispatched sub-agent in a worktree WHEN Step 6 verification runs THEN verification executes against realisera's main checkout AFTER the worktree merge, not inside the worktree
▸ GIVEN the PROGRESS.md cycle entry format WHEN documented in realisera SKILL.md THEN the `**Verified**` field is included alongside the existing Commit / Inspiration / Discovered / Next / Context fields
▸ GIVEN realisera SKILL.md frontmatter WHEN the spec_sections list is updated THEN it includes 19 in addition to the existing sections
▸ GIVEN realisera SKILL.md WHEN Section 19 is referenced in the Step 6 instructions THEN the reference is explicit (e.g., "per ecosystem context Section 19, Reality Verification Gate")

### Task 3: Orkestrera Step 3 evaluation gate

**Depends on**: Task 1, Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN orkestrera Step 3 Evaluate WHEN a task's dispatched skill was realisera THEN the conductor reads the latest PROGRESS.md cycle entry and confirms the `**Verified**` field is present and non-empty (artifact read only, no source code read)
▸ GIVEN a `**Verified**` field that is missing or empty WHEN the conductor checks THEN the conductor flags the task as failed and retries via the existing retry path
▸ GIVEN orkestrera's existing inspektera dispatch prompt in Step 3 WHEN updated THEN the prompt includes a Section 19 evidence-format snippet instructing inspektera to audit whether the recorded `**Verified**` content actually corresponds to the task's acceptance criteria
▸ GIVEN orkestrera SKILL.md frontmatter WHEN the spec_sections list is updated THEN it includes 19 in addition to the existing sections
▸ GIVEN orkestrera SKILL.md WHEN Section 19 is referenced in the Step 3 instructions THEN the reference is explicit
▸ GIVEN the orkestrera safety rails WHEN this task lands THEN the "NEVER read implementation source code" rail is preserved unchanged (the new check reads PROGRESS.md only)

### Task 4: Linter check and tests

**Depends on**: Task 2, Task 3
**Status**: ■ complete
**Acceptance**:
▸ GIVEN scripts/validate_ecosystem.py WHEN the new check function runs THEN it verifies realisera and orkestrera SKILL.md each reference Section 19 by name and include the `**Verified**` field in their format examples
▸ GIVEN both skills referencing Section 19 correctly WHEN the check runs THEN it reports a pass
▸ GIVEN realisera missing the Section 19 reference WHEN the check runs THEN it reports a violation specific to realisera
▸ GIVEN orkestrera missing the Section 19 reference WHEN the check runs THEN it reports a violation specific to orkestrera
▸ GIVEN the linter run on the current repo state WHEN the new check runs THEN total errors and warnings remain 0/0
▸ Test proportionality: 1 pass + 2 fails (3 tests total). Override rationale: the check has two subjects (realisera, orkestrera) so the fail case bifurcates into "realisera missing" and "orkestrera missing"; one fail test would silently leave the second skill unverified

### Task 5: Version bump per DOCS.md convention

**Depends on**: Task 1, Task 2, Task 3, Task 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN all prior tasks complete and the plan's commits include `feat` work WHEN the version bump runs THEN every path listed in DOCS.md `version_files` is bumped per the semver policy (feat = minor)
▸ GIVEN profilera's separate version track WHEN the bump runs THEN profilera is bumped on its own track without downgrade
▸ GIVEN the post-bump state WHEN the linter runs THEN total errors and warnings remain 0/0
▸ GIVEN the post-bump state WHEN the existing test suite runs THEN all 160+ tests pass

### Task 6: Plan-level freshness checkpoint

**Depends on**: Task 5
**Status**: □ pending
**Acceptance**:
▸ GIVEN the plan is otherwise complete WHEN the freshness checkpoint runs THEN CHANGELOG.md has a new versioned section (promoted from `[Unreleased]`) describing Section 19, the realisera and orkestrera gate enforcement, and the new linter check
▸ GIVEN the freshness checkpoint WHEN PROGRESS.md is inspected THEN a plan-level rollup cycle entry exists summarizing the Section 19 addition and the dual-skill enforcement, distinct from any per-cycle entries written during the plan
▸ GIVEN the freshness checkpoint WHEN TODO.md is inspected THEN ISS-36 is moved to the Resolved section with strikethrough and commit references for the plan's work
▸ GIVEN the freshness checkpoint WHEN PLAN.md is processed THEN the plan is archived to `.agentera/archive/PLAN-2026-04-07-iss36.md` and `.agentera/PLAN.md` is removed

## Overall Acceptance

▸ GIVEN any future realisera cycle WHEN the cycle closes THEN its PROGRESS.md entry includes a `**Verified**` field with either observed output from the primary entrypoint OR an enumerated N/A tag with optional rationale; "tests pass" alone is insufficient and fails the gate
▸ GIVEN an orkestrera-driven plan WHEN any realisera task completes THEN the conductor's presence check blocks on missing or empty `**Verified**` fields AND the dispatched inspektera evaluation audits the recorded evidence against the task's acceptance criteria
▸ GIVEN the ecosystem spec WHEN Section 19 is consulted THEN the gate is defined in runtime-agnostic language with: enumerated N/A allowlist, project-archetype taxonomy, optional verification_budget convention, and a skill-to-gate mapping table
▸ GIVEN the complete implementation WHEN the linter runs THEN it catches realisera or orkestrera missing the Section 19 reference, with separate fail signals per skill
▸ GIVEN ISS-36 WHEN the plan is complete THEN it is marked Resolved in TODO.md with commit references and the plan is archived

## Surprises

- **Pre-existing em-dash lint violations (Task 1 discovery)**: baseline `python3 scripts/validate_ecosystem.py` reports 2 errors in planera/SKILL.md line 130 and realisera/SKILL.md line 186. Both em-dashes were introduced in commit 2a44b12 (plan-level freshness checkpoint) and are orthogonal to ISS-36. Task 1 verification confirmed zero new errors were introduced by the Section 19 addition. These should be fixed as part of Task 2 (which already touches realisera/SKILL.md) and a separate follow-up for planera/SKILL.md, or as a standalone lint hygiene cycle before the version bump in Task 5. Flagging here so Task 2 picks up the realisera line and a post-Task-5 sweep handles planera.
- **AC verbatim delimiter (`**Verified**: partial — <budget hit>`) conflicts with Section 14 em-dash ban**: the Task 1 AC literal uses an em-dash inside the inline-code example, but the ecosystem spec prohibits em-dashes in prose. Section 19 resolves this by using parenthetical form: `**Verified**: partial (budget hit)`. The semantic requirement (downgrade marker plus budget-hit rationale) is preserved; only the delimiter character differs. Tasks 2 and 3 should use the parenthetical form when writing implementation text.

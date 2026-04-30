# Plan: Semantic Skill Evaluation Surface

<!-- Level: full | Created: 2026-04-30 | Status: complete -->
<!-- Reviewed: 2026-04-30 | Critic issues: 8 found, 8 addressed, 0 dismissed -->

## What

Build a separate offline semantic evaluation surface for Agentera skills. The first proof targets hej routing correctness: seeded artifacts define the expected attention item and next action, captured output is scored against that oracle, and runtime smoke evaluation remains unchanged.

## Why

Decision 38 adopted the SOB lesson that valid structure can still be value-wrong. Agentera already checks runtime execution and artifact shape, but it lacks a deterministic way to test whether a skill's output means the right thing.

## Constraints

- Keep the existing runtime smoke eval command crash-focused.
- Use stdlib-only project scripts and pytest-backed validation.
- Start offline with captured outputs; do not require live model or runtime execution.
- Preserve Markdown artifacts as the project protocol.
- Treat broad scoring, leaderboards, model comparison, and weighting as out of scope.

## Scope

**In**: semantic fixture contract, offline command, first hej routing fixture, proportional tests, docs, release metadata, plan freshness.
**Out**: live runtime invocation, model ranking, broad artifact field-recall validators, non-hej semantic fixtures.
**Deferred**: optimera semantic fixtures, difficulty weighting, per-runtime semantic score aggregation.

## Design

Add a narrow semantic eval layer beside the existing smoke runner. Fixtures provide seeded project state, captured assistant output, and expected facts. The command reports deterministic pass/fail evidence without invoking an agent runtime. The first hej fixture proves concrete routing correctness before the surface expands.

## Tasks

### Task 1: Define Semantic Fixture Contract

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a semantic fixture WHEN a maintainer reads it THEN the prompt, seeded project state, captured output, and expected facts are unambiguous.
▸ GIVEN a read-only skill fixture WHEN artifact expectations are declared THEN the fixture can state that no writes are expected.
▸ GIVEN a failing fixture WHEN the contract is invalid THEN the failure names the missing or malformed section.
▸ GIVEN tests are added WHEN proportionality is checked THEN coverage is capped at one pass and one fail per contract unit.

### Task 2: Build Offline Semantic Eval Command

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a valid fixture WHEN the semantic eval command runs THEN it evaluates captured output and seeded artifacts without invoking a runtime.
▸ GIVEN all assertions pass WHEN results are emitted THEN the machine-readable summary reports pass status and checked facts.
▸ GIVEN any assertion fails WHEN results are emitted THEN the summary reports fail status and a specific failing fact.
▸ GIVEN the runtime smoke command is inspected WHEN semantic eval lands THEN smoke behavior remains crash-focused.

### Task 3: Add Hej Routing Fixture

**Depends on**: Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN seeded artifacts with one highest-priority action WHEN hej output is evaluated THEN the expected concrete next action is required.
▸ GIVEN output chooses a generic skill without the artifact item WHEN evaluation runs THEN the fixture fails.
▸ GIVEN output chooses a lower-priority item WHEN evaluation runs THEN the fixture fails.
▸ GIVEN output includes the expected status, attention item, and exit condition WHEN evaluation runs THEN the fixture passes.

### Task 4: Add Unit-Level Assertion Tests

**Depends on**: Tasks 1, 2, 3
**Status**: ■ complete
**Acceptance**:
▸ GIVEN fixture parsing is tested WHEN pytest runs THEN one pass and one fail cover each testable contract unit.
▸ GIVEN output matching is tested WHEN pytest runs THEN one pass and one fail cover required and forbidden facts.
▸ GIVEN artifact-derived assertions are tested WHEN pytest runs THEN one pass and one fail cover oracle selection.
▸ GIVEN complex matching branches exist WHEN tests are counted THEN edge cases stay limited to documented parser branches.

### Task 5: Add CLI And Smoke Compatibility Checks

**Depends on**: Task 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN semantic eval succeeds WHEN the command is run from repo root THEN the summary shape is stable for downstream tooling.
▸ GIVEN semantic eval fails WHEN the command is run from repo root THEN the exit status signals failure.
▸ GIVEN the existing smoke eval dry run executes WHEN semantic eval is present THEN its output stays compatible.
▸ GIVEN the smoke runner is reviewed WHEN semantic eval is present THEN semantic correctness checks remain outside it.

### Task 6: Document Semantic Eval Surface

**Depends on**: Task 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a maintainer reads the docs WHEN semantic eval exists THEN they can find the command, fixture location, and offline scope.
▸ GIVEN a maintainer compares eval surfaces WHEN docs are read THEN smoke eval and semantic eval responsibilities are distinct.
▸ GIVEN documentation coverage is updated WHEN DOCS.md is read THEN the new script and fixtures are tracked if applicable.
▸ GIVEN docs are changed WHEN dokumentera verifies them THEN wording is evergreen and implementation-accurate.

### Task 7: Bump Feature Release Metadata

**Depends on**: Task 6
**Status**: ■ complete
**Acceptance**:
▸ GIVEN DOCS.md version policy is read WHEN feature metadata is bumped THEN all listed version files advance by a minor version.
▸ GIVEN current metadata is 1.25.x WHEN the bump runs THEN the expected target is 1.26.0.
▸ GIVEN release notes are updated WHEN CHANGELOG.md is read THEN semantic skill eval support is represented under the correct section.
▸ GIVEN version checks run WHEN the task completes THEN no listed version file is left behind.

### Task 8: Plan-Level Freshness Checkpoint

**Depends on**: Task 7
**Status**: ■ complete
**Acceptance**:
▸ GIVEN all prior tasks are complete WHEN freshness is checked THEN CHANGELOG.md summarizes the plan-level outcome.
▸ GIVEN all prior tasks are complete WHEN PROGRESS.md is read THEN the final cycle records validation evidence and plan closure.
▸ GIVEN TODO.md is read WHEN the checkpoint completes THEN no open semantic eval planning item remains unaddressed.
▸ GIVEN the plan is complete WHEN archived THEN active PLAN.md is removed and the archive records Tasks 1-8 complete.

## Overall Acceptance

▸ GIVEN seeded artifacts and captured hej output WHEN semantic eval runs THEN routing correctness is checked against a concrete artifact-derived oracle.
▸ GIVEN runtime smoke evaluation runs WHEN semantic eval exists THEN smoke behavior stays focused on runtime execution failures.
▸ GIVEN project validation runs WHEN implementation completes THEN tests, spec checks, contracts, docs, and release metadata agree.

## Surprises

Empty; populated by realisera during execution when reality diverges from plan.

## Closure

Task 8 closed the plan-level freshness checkpoint. `CHANGELOG.md` summarizes the outcome, `TODO.md` has no open semantic eval planning item, `PROGRESS.md` records validation evidence, and the active plan was archived after Tasks 1-8 reached `■ complete`.

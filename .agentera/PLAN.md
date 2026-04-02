# Plan: Build orkestrera skill (ISS-29, Decision 20)

<!-- Level: full | Created: 2026-04-02 | Status: active -->
<!-- Reviewed: 2026-04-02 | Critic issues: 9 found, 7 accepted, 1 dismissed, 1 accepted (low) -->

## What

Add orkestrera as the 12th skill in the agentera ecosystem. Orkestrera is a skill-agnostic meta-orchestrator: a thin conductor that dispatches any skill as a subagent, evaluates with inspektera, retries on failure, and loops through plans until work is done. It replaces the dependency on `/loop` for multi-cycle execution and supersedes ISS-21, ISS-22, ISS-23, ISS-24.

## Why

The ecosystem has no conductor. Realisera runs one cycle per invocation and depends on `/loop` for recurrence. Four open issues (separated evaluator, headless runner, AC verification, retry caps) all pointed at the same gap: a missing orchestration layer that chains skills together. Decision 20 resolved this as orkestrera, the conductor that reads PLAN.md, dispatches skills, and gates completion with inspektera.

## Constraints

- Decision 20 (firm): thin conductor, skill-agnostic dispatch, plan-required, inspektera as evaluator, sequential tasks, retry max 2, reuse existing artifacts, multi-cycle session
- All formatting conventions apply: no em-dashes, no hard wraps, colon labels, middle dot heading separators (Decisions 18, 19)
- Ecosystem linter must pass: 0 errors, 0 warnings on all 12 SKILL.md files after every commit
- Orkestrera produces NO new state artifacts (reuses PLAN.md, PROGRESS.md, HEALTH.md, TODO.md)
- Existing skills stay as-is: orkestrera passes task prompts, skills adapt naturally
- The linter itself must be updated before SKILL.md files are changed (it hardcodes "eleven-skill")

## Scope

**In**: SKILL.md, glyph assignment, ecosystem-spec updates (including linter), all SKILL.md count updates, hej routing, manifests, project docs, version bump
**Out**: changes to existing skill workflows, new scripts for orkestrera, runtime infrastructure
**Deferred**: parallel task dispatch (Decision 20 notes sequential for now), self-scheduling via CronCreate

## Design

Orkestrera follows a deterministic conductor protocol. It reads PLAN.md for task state, dispatches skills as subagents (inferring which skill from the task description), evaluates each completed task with inspektera, retries failures (max 2 with inspektera findings as context), and loops until the plan is complete. When no plan exists, it chains inspirera and planera to create one. When a plan completes and health is clean, it chains the same skills for the next plan.

The conductor stays lean by delegating all heavy work (code reads, implementation, testing, auditing) to subagent skills. Each dispatched skill runs in its own context window. Orkestrera's context contains only: artifact reads, dispatch decisions, task-notification results, and status logging.

The ecosystem-spec, linter, and all 11 existing SKILL.md cross-skill sections need the "eleven" to "twelve" language update. The linter must be patched first (it hardcodes the count and skill sets).

## Tasks

### Task 1: Assign orkestrera glyph
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN DESIGN.md glyph registry WHEN reading orkestrera's entry THEN it has a unique glyph with code point and semantic meaning for orchestration
▸ GIVEN ecosystem-spec.md Section 12 glyph table WHEN reading orkestrera's row THEN it matches the DESIGN.md entry
▸ GIVEN the chosen glyph WHEN compared visually against all 11 existing glyphs THEN it is distinct and evokes orchestration or coordination

### Task 2: Write skills/orkestrera/SKILL.md
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a project with PLAN.md WHEN orkestrera is invoked THEN it reads the plan, picks the next pending task with satisfied dependencies, infers the target skill, and dispatches it as a subagent
▸ GIVEN a project without PLAN.md WHEN orkestrera is invoked THEN it chains inspirera (vision-gap analysis) and planera (plan creation) before proceeding to task dispatch
▸ GIVEN a completed task WHEN orkestrera evaluates THEN it dispatches inspektera to verify against the task's acceptance criteria
▸ GIVEN inspektera fails a task with retry count below 2 WHEN orkestrera retries THEN it re-dispatches the skill with inspektera's findings as context
▸ GIVEN inspektera fails a task at retry count 2 WHEN orkestrera handles the failure THEN it marks the task blocked in PLAN.md, logs to TODO.md, and proceeds to the next task
▸ GIVEN all PLAN.md tasks complete WHEN orkestrera checks for more work THEN it dispatches inspektera for health check, then chains inspirera and planera for the next plan
▸ GIVEN orkestrera's State artifacts section WHEN reading artifact ownership THEN orkestrera produces no new artifact files; it reads and updates existing artifacts only
▸ GIVEN the SKILL.md WHEN validated structurally THEN all ecosystem-required sections are present: frontmatter, state artifacts with path resolution, safety rails with critical tags, exit signals with all four statuses, cross-skill integration with ecosystem language, getting started, loop guard

### Task 3: Update ecosystem-spec.md and linter
**Depends on**: Task 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN ecosystem-spec.md Section 7 WHEN reading the cross-skill reference table THEN orkestrera has a row listing its required references (planera, realisera, inspektera, inspirera, dokumentera, profilera, visionera, resonera, optimera, visualisera)
▸ GIVEN ecosystem-spec.md Section 11 WHEN reading the autonomous-loop set THEN orkestrera is listed alongside realisera and optimera, with a note that orkestrera uses retry-based failure detection (max 2 per task) rather than PROGRESS.md consecutive-failure detection
▸ GIVEN ecosystem-spec.md Section 4 format contracts table WHEN reading consumer columns THEN orkestrera appears as consumer of PLAN.md, PROGRESS.md, HEALTH.md, TODO.md, and DECISIONS.md
▸ GIVEN ecosystem-spec.md WHEN searching for "eleven-skill" THEN no instances remain; all say "twelve-skill"
▸ GIVEN scripts/validate_ecosystem.py WHEN reading the skill sets and validation rules THEN it expects 12 skills, includes orkestrera in REQUIRED_REFS, includes orkestrera in AUTONOMOUS_LOOP_SKILLS, and validates against "twelve-skill ecosystem"
▸ GIVEN the linter runs against the updated ecosystem-spec.md THEN it passes without errors

### Task 4: Update all existing SKILL.md files
**Depends on**: Task 3
**Status**: □ pending
**Acceptance**:
▸ GIVEN any of the 11 existing SKILL.md files WHEN reading the cross-skill integration section THEN the ecosystem language says "twelve-skill ecosystem"
▸ GIVEN hej's SKILL.md routing table WHEN reading entries THEN orkestrera appears with its glyph and a trigger description for orchestrated multi-cycle execution
▸ GIVEN hej's SKILL.md cross-skill integration section WHEN reading orkestrera's entry THEN it describes what hej reads from orkestrera's context (no direct artifact, but routes to it for orchestrated execution)
▸ GIVEN hej's SKILL.md WHEN reading count references THEN all instances of "ten" (referring to other skills) are updated to "eleven"
▸ GIVEN the linter runs against all 12 SKILL.md files after this task THEN 0 errors on ecosystem language check

### Task 5: Create manifests and registry entries
**Depends on**: Task 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN skills/orkestrera/.claude-plugin/plugin.json WHEN parsed as JSON THEN it has name, version (1.5.0), description, and author fields consistent with the SKILL.md frontmatter
▸ GIVEN registry.json WHEN parsed as JSON THEN orkestrera entry exists with name, version (1.5.0), description, path, tags, and added date
▸ GIVEN marketplace.json WHEN parsed as JSON THEN orkestrera plugin entry exists with matching metadata and version 1.5.0

### Task 6: Update project documentation
**Depends on**: Tasks 2, 3
**Status**: □ pending
**Acceptance**:
▸ GIVEN README.md skill table WHEN reading entries THEN orkestrera appears with its glyph, name, and description
▸ GIVEN README.md ecosystem diagram WHEN reading THEN orkestrera is represented with its connections to dispatched skills
▸ GIVEN CLAUDE.md WHEN searching for skill counts and layout descriptions THEN all reflect 12 skills
▸ GIVEN DOCS.md artifact format contracts consumer lists WHEN reading THEN orkestrera appears as consumer of PLAN.md, PROGRESS.md, HEALTH.md, TODO.md, DECISIONS.md

### Task 7: Linter validation and version bump
**Depends on**: Tasks 3, 4, 5, 6
**Status**: □ pending
**Acceptance**:
▸ GIVEN the repository WHEN running python3 scripts/validate_ecosystem.py THEN output shows 0 errors and 0 warnings
▸ GIVEN all version_files listed in DOCS.md WHEN reading version fields THEN all show 1.5.0
▸ GIVEN the git log WHEN reading the final commit THEN it follows conventional commit format with appropriate type

## Overall Acceptance

▸ GIVEN the complete repository after all tasks WHEN running the ecosystem linter THEN 0 errors and 0 warnings across all 12 SKILL.md files
▸ GIVEN the agentera marketplace WHEN a user installs orkestrera THEN it integrates with the existing 11 skills via shared artifact conventions
▸ GIVEN a project with planera-produced PLAN.md WHEN orkestrera is invoked THEN it autonomously progresses through the plan's tasks, evaluating each with inspektera
▸ GIVEN orkestrera's SKILL.md WHEN reading the conductor protocol THEN the workflow is deterministic: a fixed state machine that dispatches, evaluates, retries, and loops

## Surprises

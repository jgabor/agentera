# Plan: Prose-Quality Self-Audit Protocol

<!-- Level: full · Created: 2026-04-29 · Status: active -->
<!-- Reviewed: 2026-04-29 | Critic issues: 9 found, 6 addressed, 3 dismissed -->

## What

Add a Self-Audit Protocol to SPEC.md §24 that artifact-producing skills invoke as a mandatory pre-write gate. Three checks run before any entry reaches the artifact: verbosity drift (word count vs token budget), abstraction creep (entry must carry ≥1 concrete anchor), and filler accumulation (scan for banned verbosity patterns already defined in §24). The protocol extends to the post-layer: inspektera gains a prose health audit dimension, and dokumentera enforces prose quality across indexed docs.

## Why

Over long-running projects (300+ cycles), artifact prose drifts toward verbosity and abstraction. Existing compaction thresholds cap entry count but not entry quality — the 10 full-detail slots per artifact fill with increasingly bloated prose. Decision 34 (firm) defines the architecture: §24 extension with pre-write mandatory gate and post-layer enforcement. This plan implements that decision.

## Constraints

- SKILL.md and SPEC.md instruction changes only — no changes to production Python scripts
- Must not break existing artifact format contracts (§4)
- Must work for all producing skills consistently
- The 3 checks must be agent-enforceable without external tooling (the LLM runs them in-context)
- Pre-write gate must not create infinite revision loops (max 3 attempts, then bail with reason)

## Scope

**In**: SPEC.md §24 Self-Audit Protocol definition, pre-write self-audit step in 8 producing SKILL.md files, prose health audit dimension in inspektera, doc prose enforcement in dokumentera
**Out**: Profilera (global artifact, not project-scoped — follow-up), orkestrera (status updates only, no prose production), hej (read-only), any Python script or hook changes, any new test fixtures
**Deferred**: Profilera pre-write gate, regularity-tripwire automation (manual check only for now), word-count enforcement via PostToolUse hook

## Design

The Self-Audit Protocol is a new subsection of SPEC.md §24. It defines 3 checks that producing skills invoke in their artifact-write step, before writing. Checks are ordered: verbosity drift first (hard budget), then abstraction creep (quality), then filler accumulation (cleanup). If any check fails, the entry is revised and re-checked, up to 3 attempts per entry. After 3 failures, the skill writes the entry with a `[post-audit-flagged]` marker for inspektera to catch.

Pre-layer: each producing SKILL.md gains a "Pre-write self-audit" step referencing §24. The step appears immediately before the artifact write instructions. Narration uses the warm-voice riff format (per §14).

Post-layer: inspektera adds "prose health" as the 10th audit dimension. It reads all project artifacts, checks against the 3 rules, and grades A-F using the standard dimension format. Dokumentera adds a doc-prose enforcement pass in its audit step, checking all docs indexed in DOCS.md, bootstrapping DOCS.md if absent.

Self-audit and compaction are orthogonal. Self-audit runs per-entry before writing (quality gate). Compaction runs per-artifact after writing (quantity management, the existing 10/40/50 rule). They do not compose — they operate at different lifecycle points.

The 3 checks:

1. **Verbosity drift**: word count against the §4 token budget for the artifact being written. Over budget → compact. Budgets per §4: PROGRESS.md ≤500/cycle, EXPERIMENTS.md ≤300/experiment, HEALTH.md ≤150/dimension, DECISIONS.md ≤200/decision, TODO.md ≤100/item, CHANGELOG.md ≤300/version, PLAN.md ≤100/task and ≤2500/file, VISION.md ≤1500/file, DESIGN.md ≤2000/file, DOCS.md ≤2000/file.
2. **Abstraction creep**: entry must contain ≥1 concrete anchor from {file path, line number, commit hash, metric value, identifier, direct quote}. Missing → add one before writing.
3. **Filler accumulation**: scan for banned verbosity patterns from §24 (meta-commentary, hedging qualifiers, redundant transitions, self-referential narration, filler introductions, summary preambles, excessive justification). Found → remove before writing.

## Tasks

### Task 1: Extend SPEC.md §24 with Self-Audit Protocol

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a reader of SPEC.md WHEN they reach §24 THEN a "Self-Audit Protocol" subsection defines the 3 checks with operational rules, a producing skill instruction template, and a max-3-retry loop guard with bail-out path
▸ GIVEN a producing SKILL.md author WHEN they read the protocol THEN they can copy the instruction template into their artifact write step
▸ GIVEN the protocol WHEN read THEN the filler check references the existing §24 banned verbosity patterns table (enforcement, not new patterns)
▸ GIVEN `python3 scripts/validate_spec.py` WHEN run THEN it passes with 0 errors
▸ GIVEN `python3 scripts/generate_contracts.py --check` WHEN run THEN all contracts are current

### Task 2: Add pre-write self-audit to realisera SKILL.md

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN realisera's SKILL.md WHEN read THEN a "Pre-write self-audit" step appears before the artifact write step, invoking the §24 Self-Audit Protocol
▸ GIVEN the step WHEN read THEN it refuses to write entries that fail any check after 3 revision attempts and marks them `[post-audit-flagged]`
▸ GIVEN the step WHEN read THEN it includes narration guidance in the warm-voice riff format (§14)
▸ GIVEN `python3 scripts/validate_spec.py` WHEN run THEN it passes with 0 errors

### Task 3: Add pre-write self-audit to resonera, planera, optimera, visualisera, visionera SKILL.md

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN each of the 5 skill SKILL.md files (resonera, planera, optimera, visualisera, visionera) WHEN read THEN a "Pre-write self-audit" step appears before their artifact write steps
▸ GIVEN each step WHEN read THEN it references the §24 Self-Audit Protocol and includes riff narration guidance
▸ GIVEN each step WHEN read THEN it refuses to write entries that fail any check after 3 revision attempts and marks them `[post-audit-flagged]`
▸ GIVEN `python3 scripts/validate_spec.py` WHEN run THEN it passes with 0 errors

### Task 4: Add pre-write self-audit + prose health dimension to inspektera SKILL.md

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN inspektera's SKILL.md WHEN read THEN a "Pre-write self-audit" step appears before HEALTH.md and TODO.md write steps
▸ GIVEN the audit dimensions list WHEN read THEN "prose health" exists as the 10th dimension, reading all project artifacts and checking against the 3 §24 rules
▸ GIVEN the prose health dimension WHEN read THEN it follows standard format (findings with severity + confidence, A-F grade, trajectory vs prior audit)
▸ GIVEN `python3 scripts/validate_spec.py` WHEN run THEN it passes with 0 errors

### Task 5: Add pre-write self-audit + doc prose enforcement to dokumentera SKILL.md

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN dokumentera's SKILL.md WHEN read THEN a "Pre-write self-audit" step appears before the DOCS.md write step
▸ GIVEN dokumentera's audit workflow WHEN read THEN a doc-prose enforcement step checks all docs listed in DOCS.md against the 3 §24 rules, bootstrapping DOCS.md if absent
▸ GIVEN the enforcement step WHEN read THEN it reports findings at standard severity levels
▸ GIVEN `python3 scripts/validate_spec.py` WHEN run THEN it passes with 0 errors

### Task 6: Version bump

**Depends on**: Tasks 2, 3, 4, 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN registry.json WHEN read THEN skill versions for realisera, inspektera, resonera, planera, optimera, dokumentera, visualisera, visionera reflect a minor bump per DOCS.md semver_policy (feat = minor)
▸ GIVEN each skill's `.claude-plugin/plugin.json` WHEN read THEN plugin versions match registry.json
▸ GIVEN CHANGELOG.md WHEN read THEN [Unreleased] Added section references this work

### Task 7: Plan-level freshness checkpoint

**Depends on**: Task 6
**Status**: ■ complete
**Acceptance**:
▸ GIVEN this plan is complete WHEN CHANGELOG.md is checked THEN [Unreleased] Added section summarizes the plan-level result
▸ GIVEN this plan is complete WHEN PROGRESS.md is checked THEN cycle entries cover all completed tasks
▸ GIVEN this plan is complete WHEN TODO.md is checked THEN ISS-41, ISS-42, ISS-43, ISS-44 have Resolved entries
▸ GIVEN this plan is complete WHEN PLAN.md is checked THEN all tasks are marked ■ complete

## Overall Acceptance

▸ GIVEN a producing skill is invoked WHEN it writes an artifact entry THEN it runs the 3 §24 self-audit checks before writing and refuses bloated, abstract, or filler-laden entries
▸ GIVEN inspektera is invoked WHEN it audits codebase health THEN prose health appears as a dimension grading artifact writing quality against the §24 protocol
▸ GIVEN dokumentera is invoked WHEN it audits documentation THEN prose quality of indexed docs is checked against the §24 protocol
▸ GIVEN `python3 scripts/validate_spec.py` WHEN run THEN it passes with 0 errors across all 12 skills

## Surprises

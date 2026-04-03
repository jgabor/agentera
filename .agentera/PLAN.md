# Plan: Hooks infrastructure and security dimension

<!-- Level: full | Created: 2026-04-03 | Status: complete -->
<!-- Reviewed: 2026-04-03 | Critic issues: 10 found, 7 addressed, 3 dismissed -->

## What

Add Claude Code hooks infrastructure to agentera: session start context preloading, session stop state persistence, real-time artifact write validation, and a lightweight security audit dimension in inspektera.

## Why

Agentera currently has zero hooks. All safety rails and validation exist only as text instructions in SKILL.md files that rely on model compliance. The only enforcement mechanism is a git pre-commit hook that validates SKILL.md ecosystem alignment at commit time. This work introduces three lifecycle hooks that run mechanically during Claude Code sessions, providing real-time feedback, automatic context loading, and session-to-session continuity. The inspektera security dimension fills a gap: structural health is well-covered but code security is not assessed at all.

## Constraints

- Python stdlib only for all hook scripts (per ecosystem convention)
- Hooks must respect DOCS.md artifact path resolution (Decision 4, firm)
- Command hooks only: all three capabilities are deterministic, no LLM token spend
- Security dimension is lightweight: regex-based pattern matching, not a vulnerability database or dynamic analysis
- Standard Claude Code plugin hook format (hooks/hooks.json with command type)
- Existing 171 tests must not break
- PROGRESS.md producer contract stays with realisera: session state goes to SESSION.md (Decision 23, firm)
- PostToolUse replaces the git pre-commit hook entirely: one validation path (Decision 24, firm)

## Scope

**In**: hooks/hooks.json registration, 3 Python hook scripts, new SESSION.md artifact, inspektera SKILL.md security dimension, ecosystem-spec.md updates for hooks and security, removal of .githooks/pre-commit, tests, version bump
**Out**: CI/CD integration (ISS-31 covers the manual-edit validation gap), hook profiles (minimal/standard/strict), PreToolUse safety enforcement hooks, full security scanning, prompt-based hooks
**Deferred**: Hook strictness profiles, per-hook disable via env vars, PreToolUse hooks for blocking dangerous operations (git push, VISION.md edits during cycles)

## Design

Three command hooks registered in a root-level hooks/hooks.json, executed by the Claude Code harness at lifecycle events. SessionStart reads .agentera/ artifacts (via DOCS.md path resolution) and emits a compact context digest as raw state for any skill to consume (distinct from hej, which delivers a human-faced interpreted briefing with routing). Session stop checks for modified .agentera/ files and writes a session bookmark to .agentera/SESSION.md (Decision 23: new artifact, not PROGRESS.md, which has a cycle entry format contract owned by realisera). PostToolUse absorbs all validation currently split across the git pre-commit hook and the new artifact validation (Decision 24: one validation path). It runs ecosystem alignment checks (linter + context freshness) on skill definition edits, and structural format contract validation (required headings, markdown structure, token budgets) on operational artifact writes. The .githooks/pre-commit is removed. The manual-edit gap (edits outside Claude Code) is accepted until CI gating (ISS-31) lands. Inspektera gains a 9th audit dimension ("security") with enumerated regex patterns for secrets, dangerous function calls, and injection patterns, graded on the existing A-F scale.

## Tasks

### Task 1: Hooks infrastructure and SessionStart preload

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a fresh session in a project with operational artifacts WHEN the session starts THEN a compact digest of latest progress, health grades, next planned task, and critical issues is available as context
▸ GIVEN a project without operational artifacts WHEN the session starts THEN the hook completes silently with no output
▸ GIVEN a project with custom artifact paths in DOCS.md WHEN the session starts THEN the digest reflects the mapped paths, not defaults
▸ GIVEN the digest content WHEN compared to a hej briefing THEN the digest is raw state (artifact summaries) while hej is interpreted (routing suggestions, attention items, personality)
▸ GIVEN a hook script invoked with realistic session arguments WHEN executed directly THEN it exits with correct exit codes and produces well-formed output
▸ Test proportionality: 1 pass + 1 fail per testable function; entry-point smoke test with realistic arguments

### Task 2: Session stop hook with SESSION.md

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a session where operational artifacts were modified WHEN the session ends THEN a timestamped session bookmark is written to .agentera/SESSION.md with date and summary of changes
▸ GIVEN a session where no operational artifacts were modified WHEN the session ends THEN no session bookmark is written
▸ GIVEN a project with custom artifact paths in DOCS.md WHEN the session ends THEN the bookmark respects the mapped paths
▸ GIVEN .agentera/SESSION.md already has prior bookmarks WHEN a new bookmark is written THEN older bookmarks are compacted to one-line summaries (keep 5 full, 20 one-line)
▸ GIVEN a hook script invoked with realistic stop arguments WHEN executed directly THEN it exits with correct exit codes
▸ GIVEN the new SESSION.md artifact WHEN the ecosystem spec is checked THEN SESSION.md is documented with producers (session stop hook) and consumers (session start hook, hej)
▸ Test proportionality: 1 pass + 1 fail per testable function; entry-point smoke test

### Task 3: Artifact write validation hook (replaces pre-commit)

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a modification to an operational artifact WHEN the modification completes THEN the artifact is validated for required headings, markdown structure, and token budget compliance, and violations are reported
▸ GIVEN a modification to a skill definition file WHEN the modification completes THEN ecosystem alignment checks run (linter checks + context freshness) and violations are reported
▸ GIVEN a modification to ecosystem-spec.md WHEN the modification completes THEN context freshness is checked and stale context files are flagged
▸ GIVEN a modification to a file outside the operational directory, skill definitions, and ecosystem spec WHEN the modification completes THEN no validation runs
▸ GIVEN a valid artifact or skill modification WHEN all validation passes THEN no output is produced
▸ GIVEN "structural validation" for artifacts WHEN scoped THEN it means: required section headings present, markdown well-formed, token budget not exceeded. It does NOT mean: semantic content correctness, cross-artifact reference validity, or content quality
▸ GIVEN "ecosystem alignment" for skill definitions WHEN scoped THEN it means: the same checks currently in validate_ecosystem.py and generate_ecosystem_context.py --check, run at edit time instead of commit time
▸ GIVEN the .githooks/pre-commit file WHEN this task is complete THEN it is removed (Decision 24)
▸ Test proportionality: 1 pass + 1 fail per validation check; artifact type routing (3+ branches) warrants edge case expansion

### Task 4: Inspektera lightweight security dimension

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a codebase with hardcoded secrets (API keys matching common patterns, passwords in assignment statements, tokens in source) WHEN the security dimension assesses it THEN those patterns are flagged as warnings with file locations, evidence, impact, and suggested action
▸ GIVEN a codebase with dangerous function calls (eval on user input, unsanitized shell execution, SQL string concatenation) WHEN the security dimension assesses it THEN they are flagged with severity and confidence scores
▸ GIVEN a codebase with no security findings WHEN the security dimension assesses it THEN it reports a passing grade
▸ GIVEN security findings WHEN reported THEN the output explicitly recommends dedicated security tools (semgrep, Snyk, etc.) for comprehensive analysis
▸ GIVEN the security dimension WHEN integrated into inspektera THEN it follows the existing dimension structure: "When to include" criteria, A-F grade, confidence-scored findings with Location/Evidence/Impact/Suggested action, and trend tracking vs prior audits
▸ GIVEN the security dimension addition WHEN the ecosystem spec is checked THEN the new dimension is documented in the spec's dimension table

### Task 5: Version bump and manifest updates

**Depends on**: Tasks 1, 2, 3, 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN all prior tasks complete WHEN the version bump runs THEN all version_files listed in DOCS.md are bumped per semver policy (feat = minor)
▸ GIVEN the version bump WHEN CHANGELOG.md is updated THEN a new version section describes the hooks infrastructure, SESSION.md artifact, and security dimension
▸ GIVEN the complete implementation WHEN the ecosystem linter runs THEN all 12 skills pass alignment checks
▸ GIVEN the complete implementation WHEN the existing test suite runs THEN all 171+ tests pass

## Overall Acceptance

▸ GIVEN a fresh session with operational artifacts WHEN any skill is invoked THEN context was already preloaded without requiring /hej first
▸ GIVEN a session that modified artifacts WHEN the session ends THEN SESSION.md captures what happened without explicit user action
▸ GIVEN an agent writing a structurally malformed artifact WHEN the write completes THEN the validation hook reports the structural violation immediately, not at commit time
▸ GIVEN an inspektera audit WHEN all dimensions are assessed THEN security findings appear alongside structural health findings in the same A-F grading system
▸ GIVEN the git pre-commit hook WHEN the PostToolUse hook is in place THEN the pre-commit is removed and all validation runs at edit time via one mechanism (Decision 24)

## Adversarial Review

10 issues raised, 7 addressed, 3 dismissed.

### Addressed

1. **SessionStart duplicates hej** (severity: high). Boundary defined in Design: hook emits raw artifact state (grades, next task, critical items). Hej delivers interpreted briefing with routing suggestions and personality. Different purposes, different outputs.

2. **Stop hook violates PROGRESS.md producer contract** (severity: high). Changed to .agentera/SESSION.md, a new lightweight artifact. Avoids format pollution of realisera's cycle entry schema. Task 2 acceptance includes ecosystem-spec documentation of the new artifact.

3. **Task 3 acceptance criteria leak tool names** (severity: medium). Rewrote to behavioral: "modification to an operational artifact" instead of "Edit or Write to .agentera/*.md". Criteria describe outcomes, not wiring.

4. **Task 4 underspecified on dimension integration** (severity: medium). Added acceptance criteria for A-F grading, confidence-scored findings with Location/Evidence/Impact/Suggested action structure, "When to include" criteria, and trend tracking.

5. **"Malformed" is vague** (severity: medium). Added explicit scoping criterion: "required section headings present, markdown well-formed, token budget not exceeded, required frontmatter fields present. NOT: semantic content correctness, cross-artifact reference validity, or content quality."

6. **Stop hook state detection** (severity: medium). The hook checks repository state (modified files in .agentera/) at stop time. No cross-hook state needed. Acceptance criteria updated to reflect this: "operational artifacts were modified" (verifiable via git status or file mtimes).

7. **Spec changes deferred to Task 5** (severity: low). Moved ecosystem-spec updates into relevant tasks: Task 2 (SESSION.md in artifact table) and Task 4 (security dimension in dimension table). Task 5 is now purely version bump and final validation.

### Revised by deliberation (Decisions 23, 24)

8. **PostToolUse + pre-commit overlap** (severity: low). Originally dismissed as "different concerns." Revisited in deliberation: two validation mechanisms is complexity that accretes. Decision 24 (firm): PostToolUse replaces pre-commit entirely. One validation path.

9. **No integration smoke tests** (severity: low). Addressed within tasks: each task includes "hook script invoked with realistic arguments exits with correct exit codes." This covers the hook entry point contract without requiring a full Claude Code runtime test harness.

10. **Security scope vague** (severity: low). Enumerated in Task 4 acceptance: API keys, passwords, tokens (regex), eval on user input, unsanitized shell execution, SQL string concatenation. The scope constraint already says "not a vulnerability database or dynamic analysis." The boundary is clear: pattern-match what regex can catch, recommend dedicated tools for everything else.

## Surprises

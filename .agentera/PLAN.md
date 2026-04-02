# Plan: Enforce prose formatting conventions ecosystem-wide (ISS-28)

<!-- Level: full | Created: 2026-04-02 | Status: active -->
<!-- Reviewed: 2026-04-02 | Critic issues: 12 found, 10 addressed, 2 dismissed -->

## What

Remove all em-dashes and double dashes from the ecosystem, eliminate hard-wrapped prose paragraphs, and change structural heading separators from em-dash to middle dot (·). Update the linter to enforce both conventions going forward.

## Why

Em-dashes signal AI-generated text (Decision 18). Inconsistent line-wrapping creates visual inconsistency (Decision 19). Both conventions were deliberated and confirmed as firm. The profile has carried the em-dash preference since September 2025 but it was only partially enforced (Decision 14 covered exit signal labels only).

## Constraints
- Restructure sentences when removing em-dashes; do not mechanically swap for another punctuation mark unless restructuring reads worse
- Bash/git command flags in code blocks (`--dry-run`, `--output-dir`) are syntax, not prose; leave unchanged
- SKILL.md behavioral correctness must not change; only prose style changes
- The ecosystem linter must pass after each task

## Scope
**In**: All SKILL.md files, ecosystem-spec, templates, reference docs, project docs, operational artifacts (.agentera/), JSON manifests, PROFILE.md, linter updates
**Out**: Archived plans in .agentera/archive/ (historical record), git commit messages
**Deferred**: None

## Design

Three layers of change: conventions (ecosystem-spec defines the rules), content (all files conform), enforcement (linter prevents regression). Heading separator changes from em-dash to middle dot (·) across all artifact format contracts. Tasks 2, 3, and 4 are independent and can run concurrently.

## Tasks

### Task 1: Codify conventions in ecosystem-spec, apply to spec + reference docs + templates
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN ecosystem-spec.md WHEN read THEN a punctuation convention section exists prohibiting em-dashes and double dashes with the replacement hierarchy (restructure, then comma/period/colon)
▸ GIVEN ecosystem-spec.md WHEN read THEN a line-break convention section exists specifying no hard wraps in prose paragraphs
▸ GIVEN ecosystem-spec.md WHEN heading format definitions are read THEN all use middle dot (·) as separator
▸ GIVEN ecosystem-spec.md and all files under skills/*/references/ WHEN searched for the em-dash character THEN zero matches
▸ GIVEN ecosystem-spec.md WHEN prose paragraphs are examined THEN each paragraph is a single line

### Task 2: Apply conventions to SKILL.md batch 1 (visualisera, realisera, optimera, inspektera)
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN any SKILL.md in this batch WHEN searched for the em-dash character THEN zero matches
▸ GIVEN any SKILL.md in this batch WHEN prose paragraphs are examined THEN each is a single line
▸ GIVEN any SKILL.md in this batch WHEN read aloud THEN restructured sentences sound natural, not like punctuation was mechanically swapped
▸ GIVEN the ecosystem linter WHEN run against these files THEN zero errors

### Task 3: Apply conventions to SKILL.md batch 2 (profilera, visionera, resonera, dokumentera)
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN any SKILL.md in this batch WHEN searched for the em-dash character THEN zero matches
▸ GIVEN any SKILL.md in this batch WHEN prose paragraphs are examined THEN each is a single line
▸ GIVEN any SKILL.md in this batch WHEN read aloud THEN restructured sentences sound natural, not like punctuation was mechanically swapped
▸ GIVEN the ecosystem linter WHEN run against these files THEN zero errors

### Task 4: Apply conventions to SKILL.md batch 3 (planera, hej, inspirera)
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN any SKILL.md in this batch WHEN searched for the em-dash character THEN zero matches
▸ GIVEN any SKILL.md in this batch WHEN prose paragraphs are examined THEN each is a single line
▸ GIVEN any SKILL.md in this batch WHEN read aloud THEN restructured sentences sound natural, not like punctuation was mechanically swapped
▸ GIVEN the ecosystem linter WHEN run against these files THEN zero errors

### Task 5: Apply conventions to project docs, operational artifacts, and JSON manifests
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN VISION.md, README.md, TODO.md, CLAUDE.md, DECISIONS.md, PROGRESS.md, DESIGN.md, DOCS.md, HEALTH.md WHEN searched for the em-dash character THEN zero matches
▸ GIVEN these files WHEN prose paragraphs are examined THEN each is a single line
▸ GIVEN DECISIONS.md, PROGRESS.md, HEALTH.md WHEN heading formats are read THEN all use middle dot (·) as separator
▸ GIVEN registry.json and all plugin.json files WHEN searched for the em-dash character THEN zero matches

### Task 6: Correct PROFILE.md em-dash entry
**Depends on**: none
**Status**: □ pending
**Acceptance**:
▸ GIVEN ~/.claude/profile/PROFILE.md WHEN the em-dash entry is read THEN double dashes are not listed as an acceptable replacement
▸ GIVEN the entry WHEN replacement guidance is read THEN the hierarchy matches Decision 18 (restructure first, then comma/period/colon)

### Task 7: Add linter validation for both conventions
**Depends on**: Tasks 1, 2, 3, 4, 5
**Status**: □ pending
**Acceptance**:
▸ GIVEN a SKILL.md containing an em-dash character WHEN the linter runs THEN it reports an error for that file
▸ GIVEN a SKILL.md with consecutive non-blank prose lines outside code blocks, lists, tables, or frontmatter WHEN the linter runs THEN it reports a warning
▸ GIVEN all current SKILL.md and reference files WHEN the linter runs THEN zero new errors or warnings from these checks

## Overall Acceptance
▸ GIVEN the entire repository outside .agentera/archive/ WHEN searched for em-dash characters THEN zero matches in prose or structured headings (code-level detection patterns in the linter are exempt)
▸ GIVEN the entire repository outside .agentera/archive/ WHEN prose paragraphs are examined THEN each is a single line
▸ GIVEN the ecosystem linter WHEN run THEN zero errors and zero warnings
▸ GIVEN PROFILE.md WHEN the em-dash entry is read THEN it reflects Decision 18 accurately

## Surprises

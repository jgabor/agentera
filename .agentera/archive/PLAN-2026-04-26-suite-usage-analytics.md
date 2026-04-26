# Plan: Suite Usage Analytics

<!-- Level: full | Created: 2026-04-26 | Status: active -->
<!-- Reviewed: 2026-04-26 | Critic issues: 6 found, 6 addressed, 0 dismissed -->

## What

Build `scripts/usage_stats.py` reading the existing Section 21 corpus to count agentera skill invocations across host runtimes. Detect introduction and exit markers in assistant turns, pair them within a conversation to measure completion, classify trigger phrasing as slash or natural language, and emit per-skill totals to a global USAGE.md plus stdout summary, with `--json` and `--project PATH` flags.

## Why

Agentera mines user sessions for the user's own profile (PROFILE.md) but ships nothing that observes the suite itself. Decision 31 closes that gap: a script (no SKILL.md ceremony) reuses the corpus pipeline so the next adoption question (which skills get invoked, which complete, slash-vs-NL mix) has data behind it. Without a baseline, friction and failure analysis cannot be prioritized later. The output sits in the global XDG directory next to PROFILE.md so cross-project usage aggregates naturally.

## Constraints

- Stdlib-only Python (per CLAUDE.md scripts convention)
- Reads `corpus.json` produced by `extract_all.py`; never re-extracts sessions itself
- Output path follows the same XDG default as PROFILE.md, not the per-project `.agentera/`
- No SKILL.md, no plugin entry, no hook (script only)
- Counts only markers in `actor: assistant` turns

## Scope

**In**: marker detection, exit-signal pairing, slash-vs-NL classification, USAGE.md markdown output, stdout summary, `--json`, `--project PATH`, generated-at and corpus-extracted-at timestamps, tests, DOCS.md and README documentation, version bump per DOCS.md policy.
**Out**: friction analysis, failure-mode diagnostics, recommendations, hook scheduling, runtime-specific extension fields, profilera chaining.
**Deferred**: scheduled refresh, per-runtime breakdown, marker false-positive filtering for quoted examples.

## Design

A single self-contained script consumes the Section 21 corpus and produces three output surfaces from one analysis pass: a markdown report (USAGE.md), a stdout summary, and a JSON document. Records group by their per-conversation identifier and sort by timestamp; assistant turns within a conversation are walked to detect introduction markers and matching exit signals; the immediately preceding user turn in the same conversation classifies the trigger phrasing. Cross-project is the default; a path filter scopes to one project's records when supplied.

## Tasks

### Task 1: Detect invocations and pair them with exit signals

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a corpus containing assistant turns with skill introduction markers WHEN the script runs THEN every well-formed introduction marker is counted exactly once per skill.
▸ GIVEN an introduction marker followed by a matching exit signal in the same conversation WHEN pairing runs THEN the invocation is recorded as completed and tagged with the exit status.
▸ GIVEN an introduction marker with no later matching exit signal in its conversation WHEN pairing runs THEN the invocation is recorded as incomplete.
▸ GIVEN markers appearing only in user turns or in non-conversation_turn records WHEN the script runs THEN those markers are ignored.
▸ GIVEN a conversation containing multiple invocations of the same skill WHEN pairing runs THEN introductions are matched to exits in order of appearance.
▸ Test proportionality target: 1 pass + 1 fail per testable unit (marker detector, exit-signal matcher, pairing walker, conversation grouper). Marker detector qualifies for edge expansion: cover each exit status value and at least three skill glyphs.

### Task 2: Classify trigger phrasing and scope output

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN an invocation whose preceding user turn carries a slash-command signature WHEN classification runs THEN the invocation is tagged as slash-triggered.
▸ GIVEN an invocation whose preceding user turn lacks a slash-command signature WHEN classification runs THEN the invocation is tagged as natural-language triggered.
▸ GIVEN classification rules WHEN runtimes other than Claude Code are present THEN at least one non-Claude-Code slash convention is recognized and the rule set is documented in code comments.
▸ GIVEN a `--project PATH` argument WHEN the script runs THEN only records whose project identifier matches the supplied path are analyzed.
▸ GIVEN no `--project` argument WHEN the script runs THEN records from all projects in the corpus are analyzed and the output distinguishes the cross-project total from per-project subtotals.
▸ Test proportionality target: 1 pass + 1 fail per testable unit (slash classifier, project filter). Slash classifier qualifies for edge expansion: cover the Claude Code form and at least one non-Claude-Code form.

### Task 3: Emit USAGE.md, stdout summary, and JSON

**Depends on**: Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a successful analysis pass WHEN no `--json` flag is set THEN a markdown report is written to the global agentera data directory at the same XDG-default location as PROFILE.md, alongside a brief multi-line summary printed to stdout.
▸ GIVEN a `--json` flag WHEN the script runs THEN the full per-skill data structure is printed to stdout in JSON form and no markdown file is written.
▸ GIVEN any successful run WHEN output is produced THEN it includes both the time the script ran and the corpus's extracted-at timestamp, so staleness is visible.
▸ GIVEN the corpus file does not exist or contains no conversation_turn records WHEN the script runs THEN it exits with a clear message naming the extractor command to run.
▸ GIVEN the markdown report WHEN a reader scans it THEN per-skill rows show invocations, completed-by-status counts, incomplete count, slash count, natural-language count, and last-seen timestamp.
▸ Test proportionality target: 1 pass + 1 fail per testable unit (markdown writer, stdout summarizer, JSON emitter, missing-corpus error path).

### Task 4: Document the script

**Depends on**: Task 3
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the README scripts section WHEN a reader looks for usage analytics THEN the new script is listed with its invocation, output path, and the flags it accepts.
▸ GIVEN DOCS.md WHEN a reader audits documented artifacts THEN USAGE.md appears in the artifact mapping or coverage notes with its global XDG path and producer identified as the new script.
▸ GIVEN CLAUDE.md WHEN a reader scans the Python scripts section THEN the new script is included in the list of repo-level utilities runnable from the repo root.
▸ GIVEN any documentation update WHEN it is reviewed THEN it does not invent capabilities the script does not have (no scheduled refresh, no friction scoring, no runtime breakdown beyond what Task 2 produces).

### Task 5: Apply DOCS.md version policy

**Depends on**: Task 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the new script ships as a `feat` and the unreleased third-party validator entry point also ships as a `feat` WHEN release metadata is updated THEN every file listed in DOCS.md `version_files` moves from 1.18.1 to 1.19.0 in one consistent bump.
▸ GIVEN the version bump WHEN CHANGELOG.md is reviewed THEN the unreleased section is promoted to a 1.19.0 heading dated today and lists both shipped feats without inventing extras.
▸ GIVEN the bump WHEN TODO.md is reviewed THEN the existing pending validator-bump item is resolved and references this plan's version task as the resolution point.

### Task 6: Plan-level freshness checkpoint

**Depends on**: Task 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN all prior tasks are complete WHEN PROGRESS.md is reviewed THEN one cycle entry summarizes the plan's outcome at the plan level (not per-cycle restatements).
▸ GIVEN the plan is complete WHEN TODO.md is reviewed THEN the Decision 31 telemetry item and the version-bump item both appear in the Resolved section with this plan's commits cited.
▸ GIVEN the plan is complete WHEN CHANGELOG.md 1.19.0 section is reviewed THEN it represents the suite usage analytics feature and the validator entry point in one coherent release block.

## Overall Acceptance

▸ GIVEN a Section 21 corpus on disk WHEN the script runs THEN per-skill invocation, completion, and trigger-phrasing counts are produced for the configured scope without requiring re-extraction.
▸ GIVEN the script's outputs WHEN a user inspects USAGE.md, stdout, or JSON THEN the same analysis appears consistently across surfaces and includes the corpus extracted-at and the script's run-at timestamps.
▸ GIVEN the plan completes WHEN release metadata, README, DOCS.md, CHANGELOG.md, and TODO.md are reviewed THEN they describe the new capability accurately at version 1.19.0 with no unsupported claims.

## Surprises

- Task 1 dispatch: the realisera subagent worktree branched before the planera write was committed, so it saw the prior marketplace plan still resident, archived it under a different filename, and authored its own version of this plan. Conductor reconciled by keeping the planera-authored PLAN.md and pulling the script, tests, conftest, CHANGELOG, and PROGRESS.md cycle 163 from the subagent's commit. Implication for Tasks 2-6: dispatch from the main tree (not a worktree) so the dispatched skill sees the live plan, OR commit plan changes before dispatching.
- Task 1 design choice: same-skill pairing is LIFO so nested invocations of the same skill match correctly (intro_a, intro_b, exit_b, exit_a). For purely sequential invocations LIFO and FIFO produce identical output, so the acceptance-criteria phrasing "in order of appearance" remains satisfied.
- Task 2 ripple: extending the per-skill bucket shape with `trigger_slash` / `trigger_natural` counters broke the Task 1 `test_user_quoted_markers_are_ignored` exact-dict assertion. Loosened it to assert only the totals/pairing fields (the original invariant), preserving the test's intent. Task 3 should expect the same shape extension when adding output surfaces.
- Task 3 dual-override: `AGENTERA_USAGE_DIR` only relocates USAGE.md, not the corpus. The corpus still resolves under `PROFILERA_PROFILE_DIR`/XDG default because `extract_all.py` writes there. Tests and operators who want to relocate both must set both env vars. Documented in code comments at `_default_corpus_path`.
- Task 5 test sync: `tests/test_runtime_adapters.py::test_opencode_package_fails_on_version_drift` hardcoded `'AGENTERA_VERSION = "1.18.1"'` as the literal it mutates to simulate drift. After the suite bump the literal no longer matched, so `.replace()` no-opped, the validator saw no drift, and the assertion failed. Updated literal to `1.19.0` (same pattern as the 1.18.0 to 1.18.1 bump). Future bumps must continue to sync this literal.
- Task 5 marketplace.json profilera entry: this entry has no `version` key (likely a deliberate omission preserved across multiple prior bumps). Did not introduce one. Worth deciding whether to normalize it before the next bump.

# Plan: Post-1.22 Self-Audit Implementation

<!-- Level: full | Created: 2026-04-29 | Status: active -->
<!-- Reviewed: 2026-04-29 | Critic issues: 12 found, 10 addressed, 2 dismissed -->

## What

Implement three follow-up items from the Self-Audit Protocol spec work (Cycle 216, Decisions 34-37). ISS-47 wraps `validate_artifact.py` in a fail-open guard. ISS-46 parses SPEC.md tables into machine-readable JSON and replaces hardcoded hook constants. ISS-45 extracts duplicated self-audit prose across 8 skills into a shared Python module with hook enforcement.

## Why

Decisions 35-37 (all firm) specify the code-level follow-through on §24's prose-only self-audit protocol. Currently 8 SKILL.md files carry identical 13-line check definitions; a spec change requires editing all 8 identically. `validate_artifact.py` duplicates SPEC §2/§4/§5 tables as hardcoded dicts that drift from the spec. No exception handler guards the hook — an unhandled crash blocks agent writes.

## Constraints

- No changes to SPEC.md §24 content (already finalized in Cycle 216)
- No changes to behavior of existing validation paths
- All 8 producing skills (realisera, inspektera, dokumentera, planera, resonera, optimera, visionera, visualisera) must retain the pre-write self-audit workflow; condense the 13-line prose block to ~4 lines referencing the module
- `scripts/self_audit.py` uses Python stdlib only (no pip deps)
- `--schema` flag writes to `scripts/schemas/contracts.json`
- `--schema` creates the `scripts/schemas/` directory if missing

## Scope

**In**: Build `scripts/self_audit.py` (3 check functions), wire into `hooks/validate_artifact.py` for post-write enforcement. Condense 8 SKILL.md pre-write self-audit blocks (13 lines → ~4 lines) referencing the module while preserving the behavioral instruction. Add `--schema` flag to `scripts/generate_contracts.py` producing `contracts.json` from SPEC.md §2, §4, §5 tables. Replace hardcoded `TOKEN_BUDGETS`, `ARTIFACT_HEADINGS`, `TODO_SEVERITY_HEADINGS` in validate_artifact.py with JSON import. Wrap `main()` call site in fail-open try/except.

**Out**: Inspektera SKILL.md workflow changes (prose health dimension already defined; inspektera imports the module programmatically when it runs, no SKILL.md edits needed). Non-§2/§4/§5 schema extraction. CLI entrypoint for self_audit.py (Python API suffices for hook and inspektera use; the pre-write gate stays as behavioral prose instruction, not a shell command).

**Deferred**: Full protocol surface schema extraction (compaction, confidence, visual tokens). §24 banned verbosity patterns extraction (patterns hardcoded in self_audit.py with a comment noting the drift risk — §24 changes rarely, and extending --schema to §24 is a follow-on). Per-entry extraction logic (initial self_audit checks run against full-file content; splitting at heading boundaries is deferred).

## Design

Three changes on `hooks/validate_artifact.py`, ordered to avoid conflicts:

- **Task 1 (ISS-47)**: Wrap the `main()` call at `if __name__ == "__main__"` in a top-level try/except. On unhandled exception, log `traceback.format_exc()` to stderr and exit 0. The existing inner `try/except (json.JSONDecodeError, KeyError)` at line 679 is untouched.
- **Task 2 (ISS-46)**: `generate_contracts.py` gains `--schema` flag. Parses SPEC.md §2 (severity levels: ⇶/⇉/→/⇢), §4 (token budgets per artifact, artifact heading regexes), §5 (default paths). Outputs `scripts/schemas/contracts.json` with this structure:

```json
{
  "token_budgets": {"PROGRESS.md": 3000, "HEALTH.md": 2000, ...},
  "artifact_headings": {"HEALTH.md": ["^# Health", "^## Audit \\d+"], ...},
  "severity_mappings": {"critical": "⇶", "degraded": "⇉", ...},
  "default_paths": {"VISION.md": "VISION.md", "PLAN.md": ".agentera/PLAN.md", ...}
}
```

`validate_artifact.py` imports this JSON at startup via `_load_contracts()`, falling back to the current hardcoded dicts if the file is missing or malformed. A staleness check compares `contracts.json`'s `generated_at` timestamp against SPEC.md's mtime, emitting a warning if stale.

- **Task 3 (ISS-45)**: New module `scripts/self_audit.py` with `check_verbosity(text, artifact, budgets)`, `check_abstraction(text)`, `check_filler(text)`. Each returns `(passed: bool, details: str)`. Hook imports these and applies them to artifact file content during `_validate_one_path()`. SKILL.md pre-write blocks condense from 13 lines to:

```
Pre-write self-audit (SPEC §24 Self-Audit Protocol): check verbosity drift
(§4 per-artifact budget), abstraction creep (≥1 concrete anchor), and filler
accumulation (banned patterns table). See scripts/self_audit.py.
Max 3 revision attempts. Flag with [post-audit-flagged] if still failing.
```

The hook enforces post-write; the prose instructs Claude to check pre-write.

## Tasks

### Task 1: ISS-47 — Fail-open guard in validate_artifact.py

**Depends on**: none
**Status**: ■ complete
**Tests**: 1 test (verify exception caught → exit 0), 1 test (verify normal execution unchanged)
**Acceptance**:
▸ GIVEN the hook `main()` is called at the `if __name__` site WHEN an unhandled exception occurs in `main()` THEN the exception traceback is logged to stderr and the hook exits with code 0
▸ GIVEN the hook runs normally WHEN validation succeeds or finds violations THEN existing exit behavior is unchanged (exit 0 for Claude Code advisory, exit 2 for Copilot/OpenCode/Codex pre-write blocks)
▸ GIVEN the hook processes a valid file WHEN no exception is raised THEN the try/except has zero effect on execution flow

### Task 2: ISS-46 — Add --schema flag to generate_contracts.py

**Depends on**: Task 1
**Status**: ■ complete
**Tests**: 14 tests (1 pass + 1 fail per schema section: §2 severity, §4 budgets, §4 headings, §5 paths, staleness, fallback; 2 edge case: empty table row, whitespace-only cell; 1 integration: full schema generation)
**Commit**: f7c1bbc
**Acceptance**:
▸ GIVEN `python3 scripts/generate_contracts.py --schema` WHEN SPEC.md has §2, §4, §5 tables THEN `scripts/schemas/contracts.json` is written with structured severity mappings, token budgets, artifact heading regexes, and default paths
▸ GIVEN the `scripts/schemas/` directory does not exist WHEN `--schema` runs THEN the directory is created before writing the JSON
▸ GIVEN `contracts.json` exists WHEN `validate_artifact.py` starts THEN it loads `TOKEN_BUDGETS`, `ARTIFACT_HEADINGS`, and `TODO_SEVERITY_HEADINGS` from the JSON instead of hardcoded dicts
▸ GIVEN `contracts.json` exists WHEN `validate_artifact.py` starts THEN it compares the JSON's generation timestamp against SPEC.md's mtime; if the JSON is stale, it emits a warning to stderr but continues with the JSON values
▸ GIVEN `contracts.json` is missing or malformed WHEN `validate_artifact.py` starts THEN it falls back to the current hardcoded dicts and emits a warning to stderr
▸ GIVEN SPEC.md is modified with §4 budget changes WHEN `generate_contracts.py --schema` is re-run THEN the updated budgets appear in future hook runs without any code change to validate_artifact.py

### Task 3: ISS-45 — Build self_audit.py and wire into hook and skills

**Depends on**: Task 2
**Status**: □ pending
**Tests**: 6 base (1 pass + 1 fail per function: check_verbosity, check_abstraction, check_filler). check_filler qualifies for edge case expansion (+3: empty text, all-patterns text, mixed valid+banned)
**Acceptance**:
▸ GIVEN artifact entry text and an artifact name WHEN `check_verbosity()` is called THEN it returns `(True, ...)` if word count is within the §4 per-entry budget, `(False, reason)` if over
▸ GIVEN artifact entry text WHEN `check_abstraction()` is called THEN it returns `(True, anchor)` if at least one concrete anchor (file path, line number, commit hash, metric value, identifier, quote) is present, `(False, reason)` otherwise
▸ GIVEN artifact entry text WHEN `check_filler()` is called THEN it returns `(True, ...)` if no banned verbosity patterns from §24 are found, `(False, banned_patterns)` if any are detected
▸ GIVEN an artifact `.md` file is written in `.agentera/` or project root WHEN the PostToolUse hook fires THEN `validate_artifact.py` invokes self_audit checks on the file content
▸ GIVEN any of the 8 producing skills WHEN reading their SKILL.md pre-write self-audit step THEN the 13-line prose block is condensed to ~4 lines referencing `scripts/self_audit.py` while preserving the behavioral pre-write instruction
▸ Known risk: `check_filler()` hardcodes the §24 banned patterns table. A SPEC.md comment marks this as a drift point with a reference to the deferred `--schema` §24 extension.

### Task 4: Version bump to 1.23.0

**Depends on**: Tasks 1, 2, 3
**Status**: □ pending
**Acceptance**:
▸ GIVEN Tasks 1-3 are complete WHEN the version bump runs THEN all files listed in DOCS.md `version_files` carry version 1.23.0 (bumped from 1.22.0)
▸ GIVEN the bump is a minor increment (3 feat commits) WHEN committed THEN `1.23.0` appears in registry.json, all plugin.json files, marketplace.json, and .opencode/plugins/agentera.js

### Task 5: Plan-level freshness checkpoint

**Depends on**: Task 4
**Status**: □ pending
**Acceptance**:
▸ GIVEN all implementation tasks are complete WHEN the checkpoint runs THEN CHANGELOG.md [Unreleased] Added section has entries for self_audit.py, --schema flag, and fail-open guard
▸ GIVEN the plan is complete WHEN the checkpoint runs THEN TODO.md marks ISS-45, ISS-46, ISS-47 as resolved with commit references
▸ GIVEN the checkpoint completes WHEN PROGRESS.md is written THEN the cycle entry summarizes the plan as complete with a reference to this PLAN.md

## Overall Acceptance

▸ GIVEN a user writes an artifact entry with abstraction creep WHEN the hook fires THEN it reports the self-audit violation
▸ GIVEN a user writes an artifact entry within all §24 rules WHEN the hook fires THEN no self-audit violations are reported
▸ GIVEN `validate_artifact.py` encounters an unexpected crash WHEN the hook fires THEN the agent's write is not blocked (fail-open)
▸ GIVEN SPEC.md is modified with §4 budget changes WHEN `generate_contracts.py --schema` is re-run THEN `validate_artifact.py` uses the updated values without code changes

## Surprises

[Empty]

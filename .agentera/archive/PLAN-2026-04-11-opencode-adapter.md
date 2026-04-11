# Plan: OpenCode Adapter Implementation

<!-- Level: full | Created: 2026-04-11 | Status: active -->
<!-- Reviewed: 2026-04-11 | Critic issues: 7 found, 6 addressed, 1 dismissed (version naming) -->

## What

Uplift the OpenCode adapter from a proof-of-concept design document to a working implementation that ships alongside the existing Claude Code plugin. Both runtimes discover their respective hooks and skills from this repo without interfering with each other. The eval runner gains runtime detection so it works with either `claude` or `opencode`.

## Why

VISION.md Direction says "the spec becomes a gravity well" and lists OpenCode as a target runtime. The adapter design (cycles 91-92) proved the contracts are sufficient on paper. This plan makes it real: an OpenCode user working on this repo gets hooks automatically, the eval runner works cross-runtime, and installation for end users is documented.

## Constraints

- Must not break existing Claude Code functionality (`.claude-plugin/`, `hooks/hooks.json`, all 240 tests)
- No external dependencies (Python stdlib only for scripts)
- The existing plugin JS file is the starting point, not a rewrite
- Eval runner uses text-mode invocation only (exit code + stderr/stdout scanning); JSON event parsing is deferred
- No `opencode.json`, no `.opencode/agents/`, no compaction hook (YAGNI)

## Scope

**In**: Plugin promotion with module syntax fix, eval runner runtime detection, install documentation, version bump
**Out**: Profilera corpus extraction for OpenCode, `tool.execute.before` / compaction hook integration, end-to-end OpenCode validation, Gemini CLI / Codex CLI adapters
**Deferred**: OpenCode JSON event schema parsing for richer eval output, profilera portability plan

## Design

Three layers. (1) Plugin promotion: fix the CJS/ESM syntax conflict in the existing JS file and place it in `.opencode/plugins/` for auto-discovery. This mirrors the `.claude-plugin/` pattern already used for Claude Code dogfooding. (2) Eval runner: add runtime detection (PATH probing + `--runtime` flag) and an OpenCode invocation path using text-mode output. (3) Documentation: README install section for OpenCode users, adapter design doc status update.

## Tasks

### Task 1: Promote OpenCode plugin with module syntax fix
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the file at `.opencode/plugins/agentera.js` WHEN loaded by a JavaScript runtime THEN it parses without syntax errors (no mixing of CJS `require` and ESM `export`)
▸ GIVEN the agentera repo opened in OpenCode WHEN the runtime scans `.opencode/plugins/` THEN `agentera.js` is discoverable and exports a named async function
▸ GIVEN the original file at `references/adapters/opencode-plugin.js` WHEN the promotion is complete THEN the original is removed (no duplication) and `references/adapters/opencode.md` references the new path
▸ GIVEN the Claude Code plugin at `.claude-plugin/` and hooks at `hooks/` WHEN the OpenCode plugin is added THEN all existing Claude Code functionality is unchanged (240 tests pass, linter 0/0)

### Task 2: Add runtime detection to eval runner
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN both `claude` and `opencode` are absent from PATH WHEN `eval_skills.py` runs THEN it exits with a clear error naming both expected binaries
▸ GIVEN `claude` is on PATH but `opencode` is not WHEN `eval_skills.py` runs without `--runtime` THEN it uses `claude` automatically
▸ GIVEN `--runtime opencode` is passed WHEN `eval_skills.py` runs THEN it uses the OpenCode invocation command regardless of what is on PATH
▸ GIVEN the `--dry-run` flag WHEN listing skills THEN the output shows which runtime would be used
▸ Test proportionality: 1 pass + 1 fail per testable unit (runtime detection, flag parsing, invocation path selection). Budget: 6 tests maximum.

### Task 3: Document OpenCode installation
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a user reading the README WHEN they look for OpenCode setup THEN they find a section covering global skill install (symlink commands), plugin install (copy command), and the profile path convention
▸ GIVEN the adapter design doc at `references/adapters/opencode.md` WHEN a user reads it THEN the Implementation Status section reflects that the plugin is production-located (not in references/) and the design doc cross-references the actual plugin path
▸ GIVEN both README and adapter doc WHEN comparing install instructions THEN README provides concise commands that reference the adapter doc for details (DRY, no duplication)

### Task 4: Version bump per DOCS.md convention
**Depends on**: Tasks 1, 2, 3
**Status**: ■ complete
**Acceptance**:
▸ GIVEN feat commits in this plan WHEN the version bump runs THEN all 11 non-profilera plugin.json files, marketplace.json, and registry.json update to 1.9.0; profilera stays at 2.7.0 (14 files total)
▸ GIVEN the CHANGELOG WHEN the bump completes THEN [Unreleased] is promoted to [1.9.0] with the plan's entries

### Task 5: Plan-level freshness checkpoint
**Depends on**: Task 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN all prior tasks complete WHEN the checkpoint runs THEN CHANGELOG.md has a [1.9.0] section covering the plan's user-facing changes
▸ GIVEN all prior tasks complete WHEN the checkpoint runs THEN PROGRESS.md has an aggregate cycle entry summarizing the plan's work
▸ GIVEN all prior tasks complete WHEN the checkpoint runs THEN TODO.md has no stale entries related to this plan's scope

## Overall Acceptance

▸ GIVEN the agentera repo WHEN opened in Claude Code THEN all existing hooks, skills, and tests work identically to before
▸ GIVEN the agentera repo WHEN opened in OpenCode THEN the plugin at `.opencode/plugins/agentera.js` loads and provides session preload, artifact validation, and session bookmarking
▸ GIVEN the eval runner WHEN invoked with `--runtime auto` (or no flag) THEN it detects the available runtime and runs skill smoke tests using the correct command

## Surprises


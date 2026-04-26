# Plan: Codex and Copilot Setup Helpers

<!-- Level: full · Created: 2026-04-26 · Status: active -->
<!-- Reviewed: 2026-04-26 | Critic issues: 11 found, 10 addressed, 1 dismissed -->

## What

Close the Codex and Copilot AGENTERA_HOME setup gap left by 1.20.0. Ship two stdlib-only Python helpers that idempotently wire AGENTERA_HOME into each runtime's documented mechanism, a smoke harness that exercises both helpers without requiring live Codex or Copilot CLIs, README and DOCS updates that surface the helpers as the recommended path, and a 1.20.0 -> 1.21.0 bump.

## Why

1.20.0 standardized AGENTERA_HOME (SPEC Section 7) and shipped a working OpenCode adapter that bootstraps commands at plugin init and injects AGENTERA_HOME via `shell.env`. Codex and Copilot received SPEC contract plus README setup snippets only; users on those runtimes copy-paste manually and re-paste on every install root change. The two helpers convert manual setup into one idempotent command per runtime, matching the OpenCode UX bar. This resolves the deferred TODO items `[codex-setup-helper]` and `[copilot-setup-helper]` and the Audit 14 Freshness warning in one plan.

## Constraints

- Stdlib-only Python; no third-party dependencies
- Helpers are idempotent (safe to re-run) and dry-runnable
- No sudo, no root
- Codex helper preserves any existing `[shell_environment_policy]` table content and any other top-level tables in `~/.codex/config.toml`
- Copilot helper preserves all other lines in the user's rc file byte-identically
- Auto-detected install root must be verified against canonical entries (`scripts/validate_spec.py`, `hooks/`, `skills/`, `SPEC.md`); refuse with a clear error if verification fails
- Smoke harness exercises helpers in temp directories using injected env vars; does not require live Codex or Copilot CLI
- No SKILL.md changes
- Validators stay green at the post-1.20.0 baseline (`validate_spec.py`, `validate_lifecycle_adapters.py`, `generate_contracts.py --check`, `pytest`)
- No push to remote

## Scope

**In**: `scripts/setup_codex.py`, `scripts/setup_copilot.py`, `scripts/smoke_setup_helpers.py`, README Codex and Copilot setup sections, DOCS.md Index rows for the new scripts, DOCS.md Audit 14 Freshness warning resolution (Index dates and Coverage line), 1.20.0 -> 1.21.0 bump, plan-level freshness checkpoint.

**Out**: live Codex/Copilot CLI integration tests (Audit 14 info finding stays as a continuing live-host caveat); SESSION.md OpenCode bookmark replacement (separate TODO `[opencode-session-events]`); SPEC Section 7 footnote about the PROFILERA_PROFILE_DIR vs AGENTERA_HOME injection asymmetry (Audit 14 info; deferrable docs cycle); SKILL.md prose changes; unified `agentera setup` umbrella CLI.

**Deferred**: A unified setup entry point that auto-detects the runtime; Codex helper auto-merge of conflicting `set` table entries (current cut refuses with a printed diff unless `--force` is passed).

## Design

Two helpers, one harness, one docs surface, one release.

The Codex helper reads `~/.codex/config.toml` via stdlib `tomllib` to detect structural state, then routes to one of three write paths: append a clean fresh `[shell_environment_policy]` section at EOF when the table is absent; insert `set = { AGENTERA_HOME = "<root>" }` after the section header when the table exists without `set`; refuse with a printed diff (or merge under `--force`) when `set` exists with conflicting keys. The line-rewriter only fires for the middle case and is bounded by the section header. AGENTERA_HOME at the desired value is a no-op exit.

The Copilot helper detects shell from `$SHELL` (bash, zsh, fish; other shells exit with a printed bash one-liner the user can adapt). It writes a marker-commented two-line block (`# agentera: AGENTERA_HOME (managed)` followed by the per-shell export syntax) to the resolved rc file. Idempotency is anchored on the marker comment, not the env-var name, so the helper can update the value without grepping bash history. The detected shell and rc target are printed before any write so the user can abort with Ctrl-C.

Both helpers accept `--install-root PATH`, `--config-file` / `--rc-file PATH`, and `--dry-run`. Auto-detected install roots are verified against canonical sibling entries before use. Dry-run exits 0 when no change would be made and exits 1 when a change would be made, mirroring `validate_spec.py`'s drift-detection convention.

The smoke harness is a Python script under `scripts/` (not pytest) that mirrors the `smoke_opencode_bootstrap.mjs` shape: temp directory setup, env-var snapshot/restore in a try/finally, sequential numbered test cases with fail-fast, `PASS:` / `FAIL:` output, exit 0 / exit 1. Tests cover both helpers' fresh-write, idempotent re-run, sibling-preservation, dry-run, and unsupported-shell branches in approximately 10-12 cases total.

README updates add a one-line "or run `python3 scripts/setup_codex.py` / `python3 scripts/setup_copilot.py`" recommended path under each runtime's existing setup section. The manual snippet stays as the alternative for users who prefer transparency. DOCS.md Index gains rows for both helper scripts and the smoke harness; Audit 14's flagged stale dates and Coverage line are refreshed in the same task.

The version bump follows the Cycle 167/173 pattern: every file in DOCS.md `version_files`, CHANGELOG promotion, two feat entries (one per helper). The Cycle 173 test refactor means no test fixture edits are required.

## Tasks

### Task 1: [feat] Codex setup helper

**Depends on**: none
**Status**: ■ complete
**Acceptance**:

- GIVEN a fresh user environment with no `~/.codex/config.toml` WHEN they run `python3 scripts/setup_codex.py` THEN the helper writes a new config file containing only the `[shell_environment_policy]` section with `set = { AGENTERA_HOME = "<install root>" }` at the auto-detected install root
- GIVEN the user's `~/.codex/config.toml` already contains `[shell_environment_policy]` with `set.AGENTERA_HOME` at the desired value WHEN they re-run the helper THEN the helper exits 0 with a no-op message and the file is byte-identical
- GIVEN the user's `~/.codex/config.toml` contains `[shell_environment_policy]` without a `set` key WHEN they run the helper THEN `set = { AGENTERA_HOME = "<install root>" }` is inserted inside that section and every other table in the file remains byte-identical
- GIVEN the user's `~/.codex/config.toml` contains `[shell_environment_policy].set` with sibling keys but no AGENTERA_HOME WHEN they run the helper without `--force` THEN the helper exits non-zero, prints the diff the user should apply, and writes nothing
- GIVEN the user passes `--install-root PATH` to a path that does not contain `scripts/validate_spec.py`, `hooks/`, `skills/`, and `SPEC.md` WHEN the helper runs THEN it exits non-zero with an error naming the missing canonical entries
- GIVEN auto-detection cannot locate a valid install root WHEN the helper runs without `--install-root` THEN it exits non-zero with an error instructing the user to pass `--install-root PATH`
- GIVEN any of the above scenarios that would change the file WHEN the user passes `--dry-run` THEN nothing is written, the would-be diff is printed, and the helper exits 1; when no change would occur, dry-run exits 0
- GIVEN the helper's behavior is exercised by pytest THEN tests cover at most 12 cases (1 pass + 1 fail per testable unit, with edge expansion for the six TOML structural branches: absent file, no section, section without set, section with set at correct value, section with set with conflicting keys, --force merge)

### Task 2: [feat] Copilot setup helper

**Depends on**: none
**Status**: ■ complete
**Acceptance**:

- GIVEN a user whose `$SHELL` is `/bin/bash` with no `~/.bashrc` WHEN they run `python3 scripts/setup_copilot.py` THEN the helper creates `~/.bashrc` containing the marker comment `# agentera: AGENTERA_HOME (managed)` and `export AGENTERA_HOME=<install root>` on the next line
- GIVEN a user whose `$SHELL` ends in `zsh` WHEN they run the helper THEN the helper writes the same marker block to `~/.zshrc` using `export` syntax
- GIVEN a user whose `$SHELL` ends in `fish` WHEN they run the helper THEN the helper writes the marker block to `~/.config/fish/config.fish` using `set -x AGENTERA_HOME <install root>` syntax
- GIVEN a user whose `$SHELL` is unsupported (e.g. `/bin/csh`) WHEN they run the helper THEN it exits non-zero, prints the detected shell name, and shows a bash one-liner the user can adapt for their shell
- GIVEN the user's rc already contains a marker block at the desired install root WHEN they re-run the helper THEN it exits 0 with a no-op message and the rc is byte-identical
- GIVEN the user's rc contains a marker block at a different install root WHEN they re-run the helper THEN the value on the line following the marker is updated in place, every other line in the rc remains byte-identical
- GIVEN the user's rc contains a bare `export AGENTERA_HOME=...` line without the marker WHEN they run the helper THEN the helper appends a fresh marker block and prints a notice that the bare line was left untouched (user owns it)
- GIVEN the user passes `--rc-file PATH` THEN the helper writes to that file regardless of `$SHELL` detection, with syntax matching the file extension or path convention (`.fish` -> fish syntax, otherwise export)
- GIVEN any of the above scenarios that would change the file WHEN the user passes `--dry-run` THEN nothing is written, the would-be change is printed, and the helper exits 1; when no change would occur, dry-run exits 0
- GIVEN the helper's behavior is exercised by pytest THEN tests cover at most 12 cases (1 pass + 1 fail per testable unit, with edge expansion for shell detection branches and rc state branches)

### Task 3: [test] Smoke harness for both setup helpers

**Depends on**: Task 1, Task 2
**Status**: ■ complete
**Acceptance**:

- GIVEN both helpers are implemented WHEN `python3 scripts/smoke_setup_helpers.py` runs THEN it exercises the Codex helper across fresh-write, idempotent re-run, sibling-preservation, and dry-run cases against a temp `~/.codex/config.toml`
- GIVEN both helpers are implemented WHEN the smoke runner continues THEN it exercises the Copilot helper across bash, zsh, fish, and unsupported-shell cases against a temp rc file
- GIVEN every smoke case passes WHEN the runner exits THEN stdout ends with `PASS: all smoke checks passed` and the exit code is 0
- GIVEN any smoke case fails WHEN the runner aborts THEN stdout ends with `FAIL: <reason>` and the exit code is 1, matching the `smoke_opencode_bootstrap.mjs` output protocol
- GIVEN the smoke harness sets up temp directories and overrides env vars WHEN it exits (success or failure) THEN the originals are restored in a finally block and the temp dirs are removed
- GIVEN the smoke harness is run THEN it covers approximately 10-12 sequential test cases total; expansion beyond that requires explicit rationale documented in the script

### Task 4: [docs] README + DOCS surface and Audit 14 Freshness fix

**Depends on**: Task 1, Task 2, Task 3
**Status**: ■ complete
**Acceptance**:

- GIVEN the helpers are implemented WHEN a user reads README's Codex setup section THEN it shows `python3 scripts/setup_codex.py` as the recommended path with the manual TOML snippet retained as the alternative
- GIVEN the helpers are implemented WHEN a user reads README's Copilot setup section THEN it shows `python3 scripts/setup_copilot.py` as the recommended path with the manual rc-export snippet retained as the alternative
- GIVEN README's existing Scripts section enumerates repo-level utilities WHEN the user reads it after this task THEN both helpers and the smoke runner are listed alongside `validate_spec.py`, `eval_skills.py`, and `usage_stats.py`
- GIVEN DOCS.md is consulted by skills for path resolution WHEN it is read after this task THEN the Index has rows for `scripts/setup_codex.py`, `scripts/setup_copilot.py`, and `scripts/smoke_setup_helpers.py`, each with last-updated date and current status
- GIVEN Audit 14 flagged DOCS.md Index dates as stale WHEN this task ships THEN the Index rows for Progress, TODO, Changelog, Health, Plan, and DOCS reflect the actual most-recent commit dates and the Coverage line reflects the actual current test count
- GIVEN this task is complete WHEN DOCS.md Audit Log is read THEN it has a new entry naming the helpers added and the staleness rows fixed
- GIVEN this task does not own SPEC.md changes WHEN it ships THEN SPEC.md is byte-identical to its post-1.20.0 state

### Task 5: [chore] Bump suite to 1.21.0

**Depends on**: Task 1, Task 2, Task 3, Task 4
**Status**: ■ complete
**Acceptance**:

- GIVEN two new feats shipped (Codex helper, Copilot helper) WHEN the bump runs THEN every file listed in DOCS.md `version_files` shows `1.21.0` and zero files show `1.20.0`
- GIVEN CHANGELOG carries unreleased entries WHEN this task ships THEN `## [Unreleased]` is promoted to `## [1.21.0] · 2026-04-26` with one Added entry per helper plus any docs entries from Task 4
- GIVEN the marketplace.json profilera entry has historically been preserved without a `version` key WHEN the bump runs THEN that convention is preserved
- GIVEN validators must stay green WHEN the bump completes THEN `python3 scripts/validate_spec.py`, `python3 scripts/validate_lifecycle_adapters.py`, `python3 scripts/generate_contracts.py --check`, and `python3 -m pytest -q` all exit 0
- GIVEN the test suite count delta from this plan is bounded by Tasks 1 and 2 WHEN pytest runs THEN the new total equals the post-1.20.0 baseline plus the Task 1 and Task 2 test counts (no test changes from this task itself)

### Task 6: Plan-level freshness checkpoint

**Depends on**: Task 1, Task 2, Task 3, Task 4, Task 5
**Status**: □ pending
**Acceptance**:

- GIVEN this plan's user-facing work has shipped WHEN CHANGELOG.md is checked THEN it has Added entries under [1.21.0] covering each helper's user-visible impact (one short line per helper, not commit messages verbatim)
- GIVEN this plan is otherwise complete WHEN PROGRESS.md is checked THEN it has at least one cycle entry whose **What** field summarizes the plan and whose **Commit** field lists the commits this plan produced
- GIVEN this plan is otherwise complete WHEN TODO.md is checked THEN both `[codex-setup-helper]` and `[copilot-setup-helper]` items have corresponding Resolved entries citing this plan and its commits
- GIVEN this plan resolved Audit 14's Freshness warning WHEN HEALTH.md is read THEN that finding is noted as resolved in the next audit entry, or, if no audit has run since, the resolution is mentioned in this checkpoint cycle's PROGRESS.md **Discovered** field
- GIVEN PLAN.md was active for this plan WHEN this task completes THEN every prior task is marked `■ complete` and the plan is left in a state ready for orkestrera to archive

## Overall Acceptance

- GIVEN a Codex user on a fresh machine WHEN they run `python3 scripts/setup_codex.py` after cloning agentera THEN their `~/.codex/config.toml` contains `[shell_environment_policy].set.AGENTERA_HOME` at the install root, observable via stdlib `tomllib`
- GIVEN a Copilot user on a fresh machine with bash, zsh, or fish WHEN they run `python3 scripts/setup_copilot.py` after cloning agentera THEN their shell rc contains the marker block and the export line at the install root, observable via `grep AGENTERA_HOME`
- GIVEN either helper has been run successfully WHEN the user re-runs it THEN the helper exits 0 with a no-op message and the target file is byte-identical
- GIVEN both helpers are implemented WHEN `python3 scripts/smoke_setup_helpers.py` runs THEN it exits 0 without requiring a live Codex or Copilot CLI
- GIVEN the suite has been bumped to 1.21.0 WHEN any of `validate_spec.py`, `validate_lifecycle_adapters.py`, `generate_contracts.py --check`, or `pytest` runs THEN it exits 0
- GIVEN the plan has shipped WHEN HEALTH.md is read THEN Audit 14's Freshness warning is resolved or explicitly carried forward as resolved in the next audit

## Surprises

[Empty; populated by realisera during execution when reality diverges from plan.]

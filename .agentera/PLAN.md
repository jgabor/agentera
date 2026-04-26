# Plan: Live-Host Verification

<!-- Level: full · Created: 2026-04-26 · Status: active -->
<!-- Reviewed: 2026-04-26 | Critic issues: 10 found, 10 addressed, 0 dismissed -->

## What

Bundle three live-host verification gaps from Audit 15: (1) AGENTERA_HOME inheritance under live `codex` and `copilot` CLIs, (2) end-to-end SKILL.md compaction smoke under both runtimes, (3) Codex profilera collection audit. Build `scripts/smoke_live_hosts.py` that exercises (1) and (2) via subprocess against the real CLIs, audit (3) against the live `~/.codex/history.jsonl` and reconcile metadata claims, and document a manual verification protocol for users who cannot run the live smoke.

## Why

The Codex+Copilot Completion plan (1.21.0) shipped the WRITE side: `setup_codex.py` and `setup_copilot.py` correctly emit `[shell_environment_policy]` and shell-rc export blocks. The READ side — does `codex` actually inherit AGENTERA_HOME at runtime, does `copilot` resolve the bash-fallback, does the SKILL.md compaction command actually execute — is documented as untested (HEALTH.md Audit 15 finding 2, conf 50, narrowed from Audit 14 conf 65). VISION compounding: every install path the user might hit needs end-to-end verification or an explicit manual protocol so future runtime updates cannot silently regress the cross-runtime promise.

## Constraints

- Stdlib-only Python per CLAUDE.md scripts convention
- Snapshot ~/.codex/config.toml and shell rc files via copy-to-tmpfile before any mutation; restore in `finally` so a crash mid-run cannot corrupt user config
- Use `env AGENTERA_HOME=...` invocation patterns, never `source ~/.bashrc` (which would pollute the harness's own shell)
- Live CLI sections gated behind explicit `--live` flag with printed cost estimate ($0.20-1.00 per run, two model calls covering both AGENTERA_HOME inheritance and compaction in one combined prompt per runtime)
- Probe both `codex --version` AND auth state (e.g. `codex login status` or equivalent) before any model call; CLI-not-on-PATH and CLI-not-authed must surface as distinct skip messages
- Verification scope is limited to `codex exec` non-interactive mode; interactive-mode behavior is inferred per Codex's `[shell_environment_policy]` semantics
- Profilera Codex audit must NOT modify the existing extractor; only metadata claims (`.codex-plugin/plugin.json` `requiredCapabilities[].status`) and one targeted lifecycle test may evolve
- The duplicate-source_id corpus failure surfaced during plan orient is OUT OF SCOPE unless Task 1 root-causes it to Codex specifically; otherwise log as Surprise and file a TODO follow-up
- Copilot non-interactive runs require `--allow-all-tools`; the harness must print a one-line consent prompt before invoking
- One conventional commit per task per CLAUDE.md convention; no push

## Scope

**In**: `scripts/smoke_live_hosts.py` harness, profilera Codex collection audit, `.codex-plugin/plugin.json` `requiredCapabilities[].status` reconciliation if warranted, README + DOCS.md surface for the new harness and manual verification protocol, version bump if Tasks 2-4 land the runnable harness, plan-level freshness checkpoint.

**Out**: rewriting `extract_all.py`; fixing the duplicate-source_id corpus validation failure unless Codex is root cause; OpenCode live-host smoke (already covered in-process by `smoke_opencode_bootstrap.mjs`); Gemini CLI or other future runtimes; new orchestration layer; pytest expansion of the harness body (the harness IS the test surface per Cycle 177 precedent).

**Deferred**: similar live-host smoke for OpenCode beyond what already exists; full pre-flight authentication automation for the CLIs (the smoke verifies auth state, it does not automate `codex login` or `copilot auth`).

## Design

The harness lives at `scripts/smoke_live_hosts.py` — stdlib Python, repo-level utility, mirrors `scripts/smoke_setup_helpers.py` shape: sequential numbered cases, `PASS:` / `FAIL:` to stdout, fail-fast, cleanup in `finally`, exit 0 / exit 1.

Top-level flow:

1. Default mode: run profilera Codex audit (zero cost), run the in-process setup helper smoke (delegated via subprocess to `smoke_setup_helpers.py`), report pass and exit 0.
2. `--live` mode: probe each CLI, snapshot user config files to tmpfiles, run setup helpers against tmp install root, run one combined `codex exec` prompt that asks the agent to print `$AGENTERA_HOME` and run `python3 ${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py progress <fixture>` against a pre-seeded fixture, parse stream-JSON for both observations, repeat for `copilot -p` invoked via `bash -c 'export AGENTERA_HOME=...; copilot -p "..." --allow-all-tools'`, restore user config from tmpfiles, report.

Per-runtime probe:

- Codex: `codex --version` (PATH check), then a deterministic auth probe (e.g. `codex exec --skip-git-repo-check --output-last-message <tmp> 'reply with the literal text OK'` with a hard 30s timeout treated as auth-required if no output)
- Copilot: `copilot --version` (PATH check), then `gh auth status` or `copilot --allow-all-tools -p 'reply OK'` with same 30s timeout

Profilera Codex audit (Task 1):

- Run `extract_all.py` with `CODEX_DIR=~/.codex` (or default — the live data is there)
- Count records by `runtime` field; expect codex-cli > 0 (orient confirmed 252 history records present)
- If extraction succeeds: read `.codex-plugin/plugin.json` `skillMetadata[name=profilera].requiredCapabilities[name=codex_session_corpus].status` — if the audit shows the path actually works, propose `degraded` → `ok` with updated action text
- If duplicate-source_id failure reproduces: identify which runtime contributes the duplicates via record-by-runtime grouping, log as Surprise, defer fix unless Codex is the cause

Cost guardrail: each `--live` run prints "Estimated cost: $0.20-1.00 across two model calls (one per runtime)" before any subprocess invocation. The combined-prompt design (AGENTERA_HOME echo + compact_artifact.py invocation in one prompt) keeps it to two calls total, not four.

Manual verification protocol (Task 5): three short README sections — "Verify Codex AGENTERA_HOME by hand" (one bash one-liner the user pastes into a real `codex` session), "Verify Copilot AGENTERA_HOME by hand" (same shape), "Verify SKILL.md compaction by hand" (a third one-liner). For users who cannot run `--live` (no auth, no API budget, behind firewall), these protocols are the verification path.

## Tasks

### Task 1: Profilera Codex collection audit and metadata reconciliation

**Depends on**: none

**Status**: ■ complete

**Acceptance**:

- GIVEN a live `~/.codex/history.jsonl` with prior session data WHEN `extract_all.py` runs against it THEN the resulting corpus.json `metadata.runtimes` field includes `codex-cli` with a non-zero record count, OR the audit produces a numbered list of which records the extractor recognizes vs drops with line citations
- GIVEN the audit confirms Codex extraction works end-to-end WHEN `.codex-plugin/plugin.json` `skillMetadata[name=profilera].requiredCapabilities[name=codex_session_corpus].status` is read THEN it is updated from `degraded` to `ok` with action text reflecting the verified path; OR if a real limitation is discovered, `degraded` is preserved with action text naming the specific limitation
- GIVEN `extract_all.py` reproduces the duplicate-source_id corpus failure observed during plan orient WHEN the failing records are grouped by runtime THEN the audit names which runtime contributes the duplicates and either patches it (if Codex is the cause) or files a TODO follow-up (if any other runtime is the cause)
- GIVEN any metadata change to `.codex-plugin/plugin.json` lands WHEN `python3 scripts/validate_lifecycle_adapters.py` runs THEN it reports `lifecycle adapter metadata ok` without new errors
- GIVEN this task introduces no new logic in `extract_all.py` WHEN test files are inspected THEN no new pytest cases are added beyond what `validate_lifecycle_adapters.py` already covers (no proportionality budget for verification-only audits)

### Task 2: Live-host smoke harness scaffold

**Depends on**: none

**Status**: ■ complete

**Acceptance**:

- GIVEN `scripts/smoke_live_hosts.py` is executed without flags WHEN the run completes THEN it runs the profilera Codex audit (Task 1 path) and delegates to `scripts/smoke_setup_helpers.py` and exits 0 with `PASS: all smoke checks passed` (no live CLI invocations)
- GIVEN `scripts/smoke_live_hosts.py --live` is executed WHEN the run starts THEN it prints "Estimated cost: $0.20-1.00 across two model calls" and a one-line consent prompt that the user must accept before any subprocess CLI call
- GIVEN `--live` mode runs WHEN each runtime CLI is probed THEN the harness distinguishes "not on PATH" (no `codex` binary) from "not authenticated" (binary present but auth probe times out at 30s) with distinct skip messages, and skipped sections do not fail the overall run
- GIVEN the harness mutates `~/.codex/config.toml` or any shell rc THEN the original file content is copied to a tmp file BEFORE the mutation, the tmp path is logged, and the original is restored in a top-level `finally` block even on crash
- GIVEN no live CLI is available on the host WHEN `--live` runs THEN both per-runtime sections skip cleanly and the run still exits 0 with a summary noting which sections were skipped and why
- GIVEN the harness is the test surface (per Cycle 177 precedent) WHEN test files are inspected THEN no new pytest cases are added for the harness body itself

### Task 3: Codex live-host AGENTERA_HOME and compaction smoke

**Depends on**: Task 2

**Status**: □ pending

**Acceptance**:

- GIVEN `--live` mode and a live `codex` CLI with valid auth WHEN the Codex section runs THEN exactly ONE `codex exec` invocation issues a combined prompt asking the agent to (a) print the value of `$AGENTERA_HOME` from a bash tool call AND (b) run `python3 ${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py progress <fixture-path>` against a pre-seeded PROGRESS.md fixture in a tmp dir
- GIVEN the `codex exec` invocation completes WHEN the harness parses the output THEN it confirms (a) the printed AGENTERA_HOME value matches the install root that `setup_codex.py` wrote to the (snapshotted) tmp `~/.codex/config.toml`, and (b) the fixture file's modification time advanced and its content reflects compaction (line count reduced or `## Archived Cycles` heading present)
- GIVEN the verification scope is `codex exec` non-interactive mode WHEN the harness reports results THEN the output explicitly states "verified under codex exec; interactive mode inferred via shell_environment_policy semantics" so the limitation is legible
- GIVEN the test runs THEN the user's actual `~/.codex/config.toml` is byte-identical before and after the harness exits (verified via SHA256 comparison logged at exit)
- GIVEN the harness fails for any reason mid-run WHEN the next invocation starts THEN the previous run's tmpfile snapshot is detected and restored automatically (or the harness refuses to start with a clear message naming the orphan snapshot file)

### Task 4: Copilot live-host AGENTERA_HOME and compaction smoke

**Depends on**: Task 2

**Status**: □ pending

**Acceptance**:

- GIVEN `--live` mode and a live `copilot` CLI with valid GitHub auth WHEN the Copilot section runs THEN exactly ONE `bash -c 'export AGENTERA_HOME=<tmp install root>; copilot -p "..." --allow-all-tools'` invocation issues the same combined prompt shape as Task 3 (echo AGENTERA_HOME + run compact_artifact.py via the bash-fallback form)
- GIVEN the `copilot -p` invocation completes WHEN the harness parses the output THEN it confirms (a) the printed AGENTERA_HOME value matches the export, and (b) the pre-seeded fixture was compacted in place
- GIVEN `--allow-all-tools` is required for non-interactive Copilot mode WHEN the consent prompt from Task 2 is displayed THEN it explicitly names the `--allow-all-tools` requirement so the user knows what permission they are granting
- GIVEN the harness uses `bash -c 'export ...'` rather than sourcing the user's shell rc WHEN the test runs THEN the user's actual `~/.bashrc` (and any rc file) is byte-identical before and after the harness exits (verified via SHA256 comparison)
- GIVEN no `gh auth status` equivalent exists for `copilot` WHEN auth probing runs THEN the harness uses a 30s-timeout deterministic prompt (e.g. "reply OK") and treats timeout as auth-required with a skip-with-guidance message

### Task 5: Document manual verification protocol and surface the harness

**Depends on**: Task 1, Task 2, Task 3, Task 4

**Status**: □ pending

**Acceptance**:

- GIVEN README has Codex and Copilot setup sections WHEN the manual verification protocol section is read THEN each runtime has a copy-pasteable one-liner the user runs interactively to verify AGENTERA_HOME inheritance plus a one-liner that triggers a compaction script via the bash-fallback form
- GIVEN README Scripts section WHEN the new `scripts/smoke_live_hosts.py` is added THEN the row names default mode (no cost), `--live` mode (one-line cost estimate), and which gaps it closes (Audit 15 finding 2)
- GIVEN `.agentera/DOCS.md` Index section WHEN the new harness lands THEN it has a row at 2026-04-26 with `■ current` status alongside `smoke_setup_helpers.py` and `smoke_opencode_bootstrap.mjs`
- GIVEN `.agentera/DOCS.md` Audit Log WHEN this task ships THEN one entry under "2026-04-26 (Live-Host Verification Task 5)" lists the README and DOCS surfaces touched with `(fixed)` status per the existing audit log convention
- GIVEN no new functional code lands in this task WHEN test files are inspected THEN no new pytest cases are added (docs-only)

### Task 6: Plan-level freshness checkpoint and conditional version bump

**Depends on**: Task 1, Task 2, Task 3, Task 4, Task 5

**Status**: □ pending

**Acceptance**:

- GIVEN `scripts/smoke_live_hosts.py` lands as a new repo-level utility (Tasks 2-4) WHEN DOCS.md `versioning.semver_policy` (`feat = minor`) is applied THEN the suite version bumps from 1.21.0 to 1.22.0 across every file in DOCS.md `version_files` (Copilot root `plugin.json`, `.github/plugin/plugin.json`, `.codex-plugin/plugin.json`, `.opencode/plugins/agentera.js` AGENTERA_VERSION, `registry.json`, `.claude-plugin/marketplace.json` preserving the profilera entry without a version key, all 12 `skills/*/.claude-plugin/plugin.json`)
- GIVEN the bump lands WHEN CHANGELOG.md is read THEN `## [Unreleased]` is promoted to `## [1.22.0] · 2026-04-26` and the release block lists the live-host smoke harness as Added and any profilera metadata reconciliation under Changed
- GIVEN this plan's user-facing work has shipped WHEN CHANGELOG.md is checked THEN it has Added/Changed/Fixed entries under `## [1.22.0]` covering each task's user-visible impact (one short line per task, not commit messages verbatim)
- GIVEN this plan is otherwise complete WHEN PROGRESS.md is checked THEN it has at least one cycle entry whose **What** field summarizes the plan and whose **Commits** field lists the commits this plan produced
- GIVEN this plan is otherwise complete WHEN TODO.md is checked THEN any per-task follow-ups (e.g. duplicate-source_id deferral if surfaced by Task 1) are present as `[topic]`-prefixed Normal items, and the active milestone is advanced or removed
- GIVEN this plan resolves Audit 15 finding 2 ("Codex and Copilot live-host AGENTERA_HOME inheritance still untested") WHEN HEALTH.md is read THEN the resolution is mentioned in the next audit entry (or, if no audit has run since, in this plan's PROGRESS.md cycle entry's **Discovered** field)
- GIVEN this is a chore-build-config commit per SPEC Section 20 WHEN the Verified field is populated THEN it carries the `N/A: chore-build-config` allowlist tag plus validator outputs (`validate_spec.py`, `validate_lifecycle_adapters.py`, `generate_contracts.py --check`, `pytest`) as supporting evidence

## Overall Acceptance

- GIVEN a user runs `python3 scripts/smoke_live_hosts.py` on this host with both `codex` and `copilot` authenticated and on PATH WHEN they pass `--live` and accept the consent prompt THEN the harness exits 0 with `PASS: all smoke checks passed` after exercising both runtimes' AGENTERA_HOME inheritance AND a SKILL.md-cited compaction command end-to-end with at most two model calls total
- GIVEN a user has neither `codex` nor `copilot` available WHEN they run `python3 scripts/smoke_live_hosts.py --live` THEN both per-runtime sections skip with clear "binary not on PATH" messages, the profilera audit still runs, and the harness exits 0 with a skipped-sections summary
- GIVEN the user's `~/.codex/config.toml` and shell rc files exist before the harness runs WHEN the harness exits (success or failure) THEN those files are byte-identical to their pre-run state, verified via SHA256
- GIVEN the Codex profilera collection works against the live `~/.codex/history.jsonl` WHEN `.codex-plugin/plugin.json` `requiredCapabilities[].status` is inspected THEN it reflects the verified state rather than the unverified `degraded` placeholder
- GIVEN HEALTH.md Audit 15 finding 2 (live-host inheritance, conf 50) is the trigger for this plan WHEN the next inspektera audit runs THEN it can mark the finding resolved with reference to the live smoke harness and the manual verification protocol

## Surprises

- Task 1 (2026-04-26): The 21 duplicate-source_id corpus errors that block `extract_all.py` from writing corpus.json are entirely from `claude-code/conversation_turn` (39 records contributing to 18 duplicate groups, including three triple-duplicates), not Codex. Codex extraction itself is healthy: 252 history_prompt records and 1 project_config_signal record land in the in-memory corpus, with `instruction_document` and `conversation_turn` families correctly reported as `missing` (no documented surface and empty `~/.codex/sessions` respectively). Per Task 1 constraints, the claude-code root cause was filed as TODO `[claude-code-extract-duplicate-source-ids]` (out-of-scope patch path) rather than fixed inline; root cause documented in the TODO entry. Codex `requiredCapabilities[codex_session_corpus].status` was updated `degraded` → `ok` with action text reflecting the verified extraction path because the audit confirmed Codex records DO land in the corpus when produced — the unrelated claude-code blocker is not a Codex limitation and using it to keep `degraded` would misrepresent reality.

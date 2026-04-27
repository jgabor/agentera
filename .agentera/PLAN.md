# Plan: Cross-Runtime Parity Completion

<!-- Level: full · Created: 2026-04-27 · Status: active -->
<!-- Reviewed: 2026-04-27 | Critic issues: 8 found, 7 addressed, 1 deferred to TODO -->

## What

Close the actual cross-runtime parity gaps the Codex+Copilot capabilities research surfaced. Mostly documentation honesty + three small wiring pieces: Codex `apply_patch` hook for real-time artifact validation, `.agents/plugins/marketplace.json` plus `setup_codex.py --enable-agents` for Codex install ergonomics, smoke harness extension verifying the new hook fires. All work folds into the un-pushed 1.20.0 release; no new version bump.

## Why

The original 1.20.0 plan defined parity as specification (per-runtime mechanism table in SPEC Section 7), not working software. The 1.21.0 setup helpers and 1.22.0 live-host verification (now consolidated by Move 1) addressed pieces but not the actual stale-claim and missing-wiring gaps. The Codex+Copilot capabilities research now provides ground truth: Codex `multi_agent` and `codex_hooks` are stable + default-on; `apply_patch` Write/Edit interception works as of v0.124.0; Copilot marketplace install path is verified working; orkestrera dispatch under Codex maps to `[agents.*]` config tables. This plan delivers the coherent 1.20.0 release the user originally expected, with every documented claim verifiable against current runtime behavior.

## Constraints

- No new version bump; folds into pre-push 1.20.0 per user direction
- No push, no remote operations, no aggregator submissions during the plan (filed as TODOs in T7)
- Conventional commits per CLAUDE.md; SHA-pin every cycle
- Test proportionality cap: 2 new pytest cases total (T3 hook code only; T6 IS the test surface per Cycle 177)
- Live model spend bounded at $0.10–0.50 for one `codex exec` invocation in T6
- Mandatory `**Verified**` field per SPEC Section 19 in every PROGRESS cycle
- Marketplace.json profilera entry continues to omit a `version` key per long-standing convention

## Scope

**In**: README + SPEC stale-claim cleanup (prose); structured runtime metadata claim cleanup; dead Copilot `stop.json` hook fix; SKILL.md frontmatter audit for Copilot bug `github/copilot-cli#951`; README install-path swap (granular over umbrella per Copilot bug `#2390`); Codex `apply_patch` hook wiring with stdin schema verification; `.agents/plugins/marketplace.json` plus 12 per-skill `agents/<name>.toml` Codex agent stubs; `setup_codex.py --enable-agents` extension; orkestrera SKILL.md dispatch doc update; `smoke_live_hosts.py` Codex hook verification extension with `--yes` bypass; plan-level freshness checkpoint with CHANGELOG reframing preamble, TODO/HEALTH updates, PLAN.md archival, Move 3 push-readiness verification.

**Out**: aggregator PRs to `github/awesome-copilot` and `hashgraph-online/awesome-codex-plugins` (filed as TODOs in T7); Copilot ACP wiring as programmatic dispatch path (engineering overhead disproportionate); Copilot hook event-name validator (filed as TODO in T7); claude-code/conversation_turn duplicate-source_id fix (separate TODO already filed); opencode-session-events (separate TODO already filed); version bump to 1.21.0 (consolidates into 1.20.0 per user direction).

**Deferred**: aggregator submissions are post-1.20.0 follow-up work; Copilot hook event-name validator becomes a small lint rule once another regression triggers it.

## Design

The work splits cleanly into three layers.

**Documentation layer (T1a, T1b, T2 partial, T5)**: rewrites README runtime support and lifecycle hook tables, SPEC Section 7 per-runtime mechanism table, `.codex-plugin/plugin.json` limitations and `agents/openai.yaml` UI metadata to reflect current Codex + Copilot capability evidence. orkestrera SKILL.md gets a runtime-aware dispatch section naming Codex `[agents.*]` as the conversational substrate plus an honest Copilot `/fleet` user-driven workaround.

**Wiring layer (T2 partial, T3, T4)**: fixes the dead `stop.json` Copilot hook (rename or restructure to canonical `hooks.json` shape per Copilot spec); ports `validate_artifact.py` invocation to a Codex `apply_patch` hook with schema-verified stdin parsing; adds `.agents/plugins/marketplace.json` per Codex marketplace schema plus 12 per-skill `agents/<name>.toml` stubs that map Codex agent names to bundled SKILL.md paths; extends `setup_codex.py` with an `--enable-agents` flag that writes `[agents.<name>]` entries to `~/.codex/config.toml` pointing at the bundled `agents/<name>.toml` files.

**Verification layer (T6, T7)**: extends `smoke_live_hosts.py` with one Codex `apply_patch` hook firing test (one `codex exec` invocation triggering an apply_patch and verifying the hook fired) plus a `--yes` flag that bypasses the interactive consent prompt for non-interactive realisera/orkestrera invocation; freshness checkpoint consolidates CHANGELOG/PROGRESS/TODO/HEALTH updates with a reframing preamble explaining the post-research scope refinement, archives the prior Live-Host Verification PLAN.md, and verifies Move 3 push-readiness.

## Tasks

### Task 1a: Stale-claim cleanup — README + SPEC prose

**Depends on**: none

**Status**: ■ complete

**Acceptance**:

▸ GIVEN README "Runtime support" table WHEN read THEN Codex row reflects `multi_agent` stable + `codex_hooks` stable as of v0.124.0 + `[agents.*]` conversational dispatch substrate + plugin marketplace verified path; Copilot row reflects marketplace verified working (granular and umbrella both functional) and `/fleet` user-driven dispatch
▸ GIVEN README "Lifecycle hooks" table WHEN read THEN Codex row reflects 6 supported events (SessionStart, Stop, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest) with real-time apply_patch Write/Edit interception working per `openai/codex#18391`; Copilot row reflects 6 supported events (sessionStart, sessionEnd, userPromptSubmitted, preToolUse, postToolUse, errorOccurred) with the preToolUse-blocks vs postToolUse-output-ignored asymmetry named explicitly
▸ GIVEN SPEC.md Section 7 per-runtime mechanism table WHEN read THEN every row points at current authoritative source URLs and the PROFILERA_PROFILE_DIR vs AGENTERA_HOME injection asymmetry is named as principled (one sentence per HEALTH Audit 14 finding 2 carry-forward)
▸ GIVEN any other README or SPEC prose mentioning Codex/Copilot capability gaps WHEN read THEN it reflects current evidence (no stale "experimental disabled", "no canonical source verified", "unverified", or "no real-time interception" wording)
▸ GIVEN this task changes prose only WHEN test files inspected THEN no new pytest cases are added

### Task 1b: Stale-claim cleanup — structured runtime metadata

**Depends on**: Task 1a

**Status**: □ pending

**Acceptance**:

▸ GIVEN `.codex-plugin/plugin.json` `lifecycleHooks` block WHEN read THEN `status` reflects current state (no longer `experimental-disabled`); `unsupportedEvents` array updated to reflect actually unsupported events only; `limitations` prose updated to remove stale "experimental, require host config opt-in" claims and add real-time apply_patch interception capability
▸ GIVEN `.codex-plugin/plugin.json` `codex.limitations` array WHEN read THEN no entry claims hooks are unavailable for real-time Write/Edit interception; the AGENTERA_HOME setup limitation entry stays
▸ GIVEN `agents/openai.yaml` and `skills/profilera/agents/openai.yaml` WHEN read THEN any `support.lifecycle_hooks` field that claims "experimental-disabled" is updated to reflect current state; per-skill metadata updates do not break existing `validate_lifecycle_adapters.py` checks
▸ GIVEN this task touches structured metadata WHEN `python3 scripts/validate_lifecycle_adapters.py` runs THEN it reports `lifecycle adapter metadata ok` without new errors
▸ GIVEN this task adds no functional code WHEN test files inspected THEN no new pytest cases are added

### Task 2: Fix dead Copilot hook + SKILL.md frontmatter audit + README install-path swap

**Depends on**: Task 1a

**Status**: □ pending

**Acceptance**:

▸ GIVEN `.github/hooks/stop.json` WHEN inspected THEN the file is renamed to `sessionEnd.json` with `name: sessionEnd` (or restructured to a single canonical `hooks.json` with `{version: 1, hooks: {...}}` shape per Copilot hooks spec); `.github/plugin/plugin.json` `hooks` field updated to point at the correct file or directory
▸ GIVEN all 12 SKILL.md files WHEN frontmatter is inspected THEN no SKILL.md ends frontmatter with a `metadata:` field as the last entry; skills affected get a trailing harmless field appended (specifically `license: MIT` per Copilot bug `github/copilot-cli#951` workaround)
▸ GIVEN README install instructions WHEN read THEN the granular install path (`copilot plugin marketplace add jgabor/agentera && copilot plugin install <skill>@agentera`) is documented as the recommended path until Copilot bug `github/copilot-cli#2390` lands upstream; the umbrella install (`copilot plugin install jgabor/agentera`) is retained as alternative with the bug caveat noted
▸ GIVEN `python3 scripts/validate_spec.py` runs after the frontmatter audit WHEN inspected THEN reports `0 error(s), 0 warning(s) across 12 skills`
▸ GIVEN this task adds no Python code WHEN test files inspected THEN no new pytest cases are added

### Task 3: Codex apply_patch hook for real-time artifact validation

**Depends on**: Task 1b

**Status**: □ pending

**Acceptance**:

▸ GIVEN T3.0 setup gate WHEN any code is written THEN the Codex hook stdin JSON schema is captured first (from `openai/codex#18391` PR diff or a live `codex exec` apply_patch hook capture) and documented in the cycle's PROGRESS entry's Discovered field with explicit field-name and exit-code semantics; ONLY after this is the parser branch implemented
▸ GIVEN a Codex hook config file at `hooks/codex-hooks.json` (or equivalent canonical path) WHEN inspected THEN it declares PreToolUse and PostToolUse entries with `apply_patch` matcher pointing at `hooks/validate_artifact.py` (or a thin Codex-shim wrapper) with the canonical Codex hook config schema
▸ GIVEN `hooks/validate_artifact.py` (or its Codex shim) WHEN invoked from the Codex hook entry point THEN it accepts the captured Codex stdin JSON shape and returns the same exit-code semantics the Claude Code wiring expects (0 for valid, non-zero or `permissionDecision: deny` for blocking depending on Codex's actual schema)
▸ GIVEN README hook setup section WHEN read THEN it documents the Codex hook configuration path and contents alongside the existing OpenCode curl one-liner; setup is a one-command path or a copy-paste block
▸ GIVEN tests/test_validate_artifact.py (or new tests/test_codex_hook.py) WHEN pytest runs THEN at most 2 new test cases verify the Codex stdin parser (one valid input pass + one malformed input fail) per the test proportionality cap
▸ GIVEN this task adds Python hook code WHEN validators run THEN `scripts/validate_spec.py` and `scripts/validate_lifecycle_adapters.py` both stay green

### Task 4: Codex marketplace.json + agent stubs + setup_codex.py --enable-agents

**Depends on**: Task 1a

**Status**: □ pending

**Acceptance**:

▸ GIVEN `.agents/plugins/marketplace.json` WHEN inspected THEN it conforms to the Codex marketplace schema (`name`, `interface.displayName`, `plugins[]` with each plugin's `source.source: local` and `source.path` pointing at relative paths within the agentera repo) and lists all 12 skills as plugin entries
▸ GIVEN per-skill `skills/<name>/agents/<name>.toml` files WHEN inspected THEN all 12 files exist as Codex agent definition stubs with `model`, `model_reasoning_effort`, and `developer_instructions` fields per the Codex agent.toml format; `developer_instructions` references the bundled SKILL.md path
▸ GIVEN `scripts/setup_codex.py --enable-agents` WHEN invoked THEN it writes `[agents.<name>]` entries to `~/.codex/config.toml` for all 12 agentera skills, each pointing at the bundled `agents/<name>.toml` file path; idempotent re-run is a no-op; `--dry-run` previews without writing; `--force` resolves conflicts with existing `[agents.*]` entries
▸ GIVEN README and SPEC.md Codex skill discovery paths WHEN read THEN the canonical user skill path is named as `$HOME/.agents/skills/` (not `~/.codex/skills/` which is system-bundled cache)
▸ GIVEN tests/test_setup_codex.py WHEN pytest runs THEN at most 1 new test case verifies the `--enable-agents` flag writes the expected `[agents.*]` block (the additional case lives within T3's 2-case overall budget if needed; otherwise no new pytest cases are added since the existing setup_codex test surface covers the `[shell_environment_policy]` write path and `--enable-agents` reuses the same idempotent state-classifier)

### Task 5: orkestrera runtime-aware dispatch documentation

**Depends on**: Task 1a, Task 4

**Status**: □ pending

**Acceptance**:

▸ GIVEN `skills/orkestrera/SKILL.md` cross-skill integration section WHEN read THEN dispatch-mechanism prose names Codex `[agents.<name>]` config tables as the conversational dispatch substrate; the existing "spawn the target skill as a background subagent" prose maps to Codex via the `setup_codex.py --enable-agents` install path from T4
▸ GIVEN the same SKILL.md section WHEN read THEN the Copilot programmatic-dispatch gap is explicitly named (no in-session subagent tool call equivalent to Claude Code Task tool) with the user-driven `/fleet` workaround as the documented fallback for Copilot users running orkestrera
▸ GIVEN any other SKILL.md that mentions subagent dispatch (realisera, optimera) WHEN inspected THEN the prose is consistent with orkestrera's runtime-aware framing; existing Claude Code-centric language gets a one-sentence per-runtime translation note where appropriate
▸ GIVEN the existing dispatch protocol in orkestrera SKILL.md Step 2 WHEN read THEN the conductor-side instructions remain unchanged (the work is documentation honesty, not architectural rewrite); the SKILL.md prose continues to work natively on Claude Code Task tool, OpenCode plugin path, Codex `[agents.*]` (via T4 wiring), and degrades to user-driven `/fleet` on Copilot
▸ GIVEN this task changes prose only WHEN test files inspected THEN no new pytest cases are added

### Task 6: Live-host hook verification with --yes consent bypass

**Depends on**: Task 3

**Status**: □ pending

**Acceptance**:

▸ GIVEN `scripts/smoke_live_hosts.py` WHEN inspected THEN a `--yes` flag (or `AGENTERA_LIVE_CONSENT=1` env var) bypasses the interactive consent prompt for non-interactive realisera/orkestrera invocation; interactive sessions without the flag still see the prompt; the bypass logs explicit "auto-consented via flag" to the harness output for audit
▸ GIVEN `scripts/smoke_live_hosts.py --live --yes` WHEN run THEN it issues exactly ONE additional codex exec invocation (beyond the existing AGENTERA_HOME echo + compaction) that triggers an apply_patch (e.g., a tiny tmpfile edit via the `apply_patch` tool) and verifies the new Codex apply_patch hook fired (PreToolUse and/or PostToolUse trace observable in the hook's logged output)
▸ GIVEN the harness section runs WHEN it completes THEN distinct PASS/FAIL/SKIP messages distinguish "hook didn't fire" from "hook fired but returned non-zero" from "hook config absent"; total live model spend bounded at one codex exec invocation per runtime (Codex hook test only; Copilot section unchanged)
▸ GIVEN the harness IS the test surface per Cycle 177 WHEN test files inspected THEN no new pytest cases are added beyond T3's 2-case budget
▸ GIVEN T6 invokes live model spend WHEN executed THEN the user has pre-authorized this invocation via the plan dispatch; explicit cost is logged in the cycle's PROGRESS entry's Verified field

### Task 7: Plan-level freshness checkpoint

**Depends on**: Task 1a, Task 1b, Task 2, Task 3, Task 4, Task 5, Task 6

**Status**: □ pending

**Acceptance**:

▸ GIVEN CHANGELOG.md `## [1.20.0] · 2026-04-27` block WHEN read THEN it carries a one-line preamble noting "Scope refined post-research to address verified cross-runtime parity gaps; consolidates Move 1 renumber and Move 2 parity completion per explicit user direction"; the block is augmented in place (NOT promoted from Unreleased; NO new version bump) with this plan's user-visible changes added under the existing Added/Changed sections
▸ GIVEN PROGRESS.md WHEN read THEN at least one cycle entry summarizes this plan at the plan level (not per-task restatement) with a Commits field listing every commit the plan produced (substantive + SHA-pin pairs across T1a–T6 plus this checkpoint)
▸ GIVEN TODO.md WHEN read THEN `[copilot-marketplace]` is moved to Resolved with citation to the capabilities research that proved the path verified working; new TODOs filed as Normal items: `[awesome-copilot-pr]` (PR submission to `github/awesome-copilot`), `[awesome-codex-plugins-pr]` (PR submission to `hashgraph-online/awesome-codex-plugins`), `[copilot-hook-event-name-validator]` (small lint rule preventing future dead-hook regressions like the original `stop.json` typo)
▸ GIVEN HEALTH.md WHEN read THEN this plan's resolution of any prior-audit findings about Codex/Copilot capability claims is mentioned in the plan's PROGRESS cycle entry's Discovered field; no new audit required during the plan
▸ GIVEN `.agentera/archive/` WHEN inspected THEN the prior Live-Host Verification PLAN.md is archived as `.agentera/archive/PLAN-2026-04-26-live-host-verification.md`; this archival happens at planera time (before T1a starts), not at T7
▸ GIVEN every file in DOCS.md `version_files` WHEN inspected THEN every surface still reads `"version": "1.20.0"` (no bump occurred during the plan); `grep -c '"version": "1.21.0"'` returns 0 across all version_files
▸ GIVEN Move 3 push-readiness verification WHEN inspected THEN working tree is clean post-T1b through T6, no `v1.20.0` tag exists upstream (`git ls-remote --tags origin v1.20.0` returns empty), all four validators report green (validate_spec.py, validate_lifecycle_adapters.py, generate_contracts.py --check, pytest)
▸ GIVEN this is a chore-build-config + docs commit per SPEC Section 19 WHEN the Verified field is populated THEN it carries the `N/A: chore-build-config` allowlist tag plus all four validator outputs as supporting evidence

## Overall Acceptance

▸ GIVEN a user reads the agentera README on 2026-04-27 WHEN they look at the runtime support and lifecycle hook tables THEN every claim is verifiable against current Codex/Copilot/OpenCode/Claude Code documentation; no stale "experimental", "unverified", or "no canonical source" wording remains for capabilities that have shipped
▸ GIVEN a Codex user installs agentera and edits an artifact WHEN apply_patch fires THEN the Codex hook config triggers `validate_artifact.py` in real time (parity with Claude Code PostToolUse and OpenCode `tool.execute.after`)
▸ GIVEN a Codex user runs `codex plugin marketplace add jgabor/agentera` then `codex plugin install <skill>@agentera` WHEN the install completes THEN the skill resolves via `.agents/plugins/marketplace.json` (cross-runtime install symmetry with Copilot's verified granular path)
▸ GIVEN a Codex user runs `python3 scripts/setup_codex.py --enable-agents` WHEN the next interactive `codex` session starts THEN `[agents.<name>]` entries map agentera skill names to bundled SKILL.md paths so orkestrera's "spawn a subagent" prose dispatches natively
▸ GIVEN orkestrera SKILL.md WHEN read on any of the four runtimes THEN the dispatch protocol either works natively (Claude Code Task tool, OpenCode plugin, Codex `[agents.*]` post-T4 setup) or honestly documents the gap with a workaround (Copilot user-driven `/fleet`)
▸ GIVEN this plan completes WHEN the suite is at 1.20.0 still un-pushed THEN Move 3 (push + tag `v1.20.0`) is the next move; no new release block needed in CHANGELOG; the TODO list contains the aggregator-PR follow-ups

## Surprises

[Empty; populated by realisera during execution when reality diverges from plan]

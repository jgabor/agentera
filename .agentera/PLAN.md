# Plan: Cross-Runtime Portability (AGENTERA_HOME on every host)

<!-- Level: full | Created: 2026-04-26 | Status: active -->
<!-- Reviewed: 2026-04-26 | Critic issues: 15 found, 14 addressed, 1 dismissed; revised post-review to include Codex and Copilot -->

## What

Fix two runtime-portability defects so the portable core of agentera runs end-to-end on every supported host (Claude Code, OpenCode, Codex, Copilot), then cut the result as 1.20.0.

The OpenCode plugin registers `bootstrapCommands()` against a `session.created` hook that does not exist in the `@opencode-ai/plugin` Hooks interface, so no agentera slash commands ever appear in OpenCode. Five compaction invocations across four producer SKILL.md files reference `${CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py`, an env var only Claude Code sets; under any other runtime the path stays literal and bash cannot find the script.

The fix standardizes on `AGENTERA_HOME` as the single env var that names the agentera install root. SPEC.md formalizes the contract. Each runtime adheres to its own conventions for getting the var into the agent's shell:

- **Claude Code**: keeps `${CLAUDE_PLUGIN_ROOT}` working untouched via the bash fallback `${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}` in skill prose
- **OpenCode**: real `shell.env` plugin hook injects AGENTERA_HOME into every shell-tool subprocess (the supported plugin API for env injection)
- **Codex**: the user adds `[shell_environment_policy].set = { AGENTERA_HOME = "<install root>" }` to `~/.codex/config.toml`, the runtime's native, non-experimental mechanism for shell-tool env propagation
- **Copilot**: the user exports AGENTERA_HOME in their shell rc; Copilot has no plugin-level env-injection API (verified against the official plugin and hooks references), so user-shell setup is the documented best practice

## Why

VISION.md Direction (line 55): "any agent runtime that speaks the protocol can run the portable core of agentera." Today an OpenCode user sees no agentera slash commands and no working compaction. Codex users had no path either. Copilot users were on the same broken footing. The portable core was Claude-Code-only by accident of one hardcoded env var.

Fixing this means doing the right thing per each runtime's conventions, not inventing a new abstraction. Decision 27 already established adapter-injected env vars (PROFILERA_PROFILE_DIR) as the cross-runtime pattern. AGENTERA_HOME is the natural sibling. OpenCode's `shell.env` hook, Codex's `shell_environment_policy.set`, and Copilot's parent-shell-inheritance model are each the platform-blessed path; the plan adopts each rather than fighting them.

## Constraints

- No Claude Code regression: bash fallback `${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}` keeps Claude Code working without any Claude-side hook changes
- AGENTERA_HOME contract scope is skill-level files (SKILL.md prose) which run cross-runtime. Adapter-internal config files (hooks/hooks.json, .claude-plugin/plugin.json, .codex-plugin/plugin.json, root plugin.json) are per-runtime by design and keep their host-specific tokens
- AGENTERA_HOME is the agentera install root: the directory containing scripts/, hooks/, skills/, and SPEC.md
- Per-runtime mechanism follows that runtime's official documented best practice; do not invent a custom layer for any host
- New shared primitive lives in SPEC.md only (Decision 7); no duplication into per-skill contract.md
- Profilera's effective_profile.py invocation pattern uses a relative path and is unrelated; out of scope

## Scope

**In**: SPEC.md new section defining AGENTERA_HOME with a per-runtime mechanism table; OpenCode plugin refactor (bootstrap-at-init, real shell.env hook, drop phantom hook keys); Codex documentation that names `~/.codex/config.toml` `shell_environment_policy.set` as the supported mechanism; Copilot documentation that names shell-rc export as the supported mechanism; per-runtime plugin manifest descriptions updated to surface the AGENTERA_HOME requirement; 4 SKILL.md files updated at 5 invocation sites; spec validator lint rule against bare `${CLAUDE_PLUGIN_ROOT}` in skill prose; smoke and unit test updates including `tests/test_runtime_adapters.py` fixture refresh; 1.19.0 -> 1.20.0 bump (`tests/test_runtime_adapters.py` AGENTERA_VERSION literal refactored to read from agentera.js so future bumps don't drift); freshness checkpoint with follow-up TODOs

**Out**: SESSION.md OpenCode bookmark replacement (the `session.idle` hook is also phantom - log as follow-up); a setup helper script that auto-edits user `~/.codex/config.toml` or shell rc (preserve user-visible config under user control; document only); profilera path standardization across runtimes; OpenCode `event` hook adoption for full session lifecycle

**Deferred**: hooks/hooks.json migration off `${CLAUDE_PLUGIN_ROOT}` (cosmetic only - that file is loaded by Claude Code itself and works correctly there)

## Design

Standardize `AGENTERA_HOME` as the single env var naming the agentera install root. Adapters set it via each platform's documented mechanism; skills reference it via the bash-fallback form; SPEC.md formalizes the contract; the spec validator enforces no regression.

- **SPEC.md** adds a section after Section 6 (Profile Consumption), the conceptual sibling. Defines AGENTERA_HOME, what counts as the install root, adapter responsibility, skill responsibility, and a per-runtime mechanism table: Claude Code (existing CLAUDE_PLUGIN_ROOT bash fallback); OpenCode (`shell.env` plugin hook); Codex (`~/.codex/config.toml` `[shell_environment_policy].set`); Copilot (shell rc export, since no plugin-level mechanism exists). The table doubles as install guidance for adapter authors
- **OpenCode plugin** (.opencode/plugins/agentera.js): `bootstrapCommands()` moves from phantom `"session.created"` into the Agentera function body. A real `"shell.env"` hook injects `AGENTERA_HOME=resolveAgenteraHome()` when discoverable. Phantom `"session.created"` and `"session.idle"` keys removed. Smoke runner extended; `tests/test_runtime_adapters.py` fixtures asserting the old hook keys updated; `scripts/validate_lifecycle_adapters.py` checked and updated if needed
- **Codex documentation**: README adds a Codex install step with the exact `[shell_environment_policy]` TOML snippet. `.codex-plugin/plugin.json` `codex.limitations` array gets an entry naming the AGENTERA_HOME requirement and pointing at README. No code change in the Codex adapter itself (Codex has no plugin-level env-injection API; user config is the official mechanism)
- **Copilot documentation**: README adds a Copilot install step with the shell-rc `export AGENTERA_HOME=<install root>` line. Root `plugin.json` and `.github/plugin/plugin.json` descriptions get a single sentence flagging the requirement and pointing at README. No code change (Copilot's hook output is "Ignored" per the official reference; user shell setup is the official path)
- **Claude Code path** unchanged at the runtime level. The bash fallback `${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}` substitutes the existing var when AGENTERA_HOME is unset, so SKILL.md instructions resolve identically without requiring a Claude-side env-injection mechanism (which the SessionStart hook contract cannot provide anyway)
- **4 SKILL.md files** (realisera, resonera, optimera, inspektera) get 5 compaction invocations rewritten from `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py` to `python3 ${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py`. Mechanical edit
- **Lint rule** is bundled atomically with the SKILL.md cleanup so the repo never enters a broken intermediate state where the rule warns on still-unfixed files
- **Test brittleness fix**: `tests/test_runtime_adapters.py` AGENTERA_VERSION literal currently hardcodes the version (logged as a Cycle 167 Surprise). Refactor it to read AGENTERA_VERSION from `.opencode/plugins/agentera.js` at test time so future bumps don't require manual literal sync

## Tasks

Dependencies: T1 -> {T2, T3} -> T4 -> T5 -> T6. T2 (OpenCode adapter) and T3 (Codex+Copilot docs) run in parallel after T1 and converge into T4 (SKILL.md cleanup).

### Task 1: [feat] Add AGENTERA_HOME contract to SPEC.md with per-runtime mechanism table

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a reader scanning SPEC.md for cross-runtime env-var contracts WHEN they reach the section after Profile Consumption THEN they find a section that defines AGENTERA_HOME, names it as the agentera install root containing scripts/, hooks/, skills/, and SPEC.md, states the adapter's responsibility, states the skill's responsibility (bash-fallback form), and explicitly excludes adapter-internal config files
▸ GIVEN the same section WHEN read THEN it includes a table mapping each supported runtime to its official mechanism: Claude Code (bash fallback to CLAUDE_PLUGIN_ROOT), OpenCode (shell.env plugin hook), Codex (~/.codex/config.toml shell_environment_policy.set), Copilot (shell rc export); each row cites the runtime's authoritative source for that mechanism
▸ GIVEN the section WHEN cross-referenced from Section 4 and Section 6 THEN the relationship to PROFILERA_PROFILE_DIR is named so future readers see them as siblings
▸ GIVEN no spec validator changes in this task WHEN the validator runs against the 12 canonical SKILL.md files THEN warning and error counts stay at the pre-task baseline
▸ Test proportionality: prose only; existing SPEC structural tests cover heading presence; no new test budget

### Task 2: [feat] OpenCode plugin runs bootstrap at init and injects AGENTERA_HOME via shell.env

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN the agentera.js plugin function under instrumentation WHEN OpenCode loads the plugin in a real or harness-simulated session THEN a diagnostic counter records the actual lifecycle boundary the function fires at, and any divergence from the plan's once-per-plugin-load assumption is logged in PROGRESS.md as a Surprise
▸ GIVEN a fresh OpenCode session loading the updated agentera.js WHEN plugin init completes THEN the OpenCode commands directory contains the version marker file at the current AGENTERA_VERSION and 12 agentera command files
▸ GIVEN the same plugin re-loaded after a successful bootstrap at the current version WHEN init runs again THEN no command files are rewritten and stderr stays clean
▸ GIVEN an OpenCode bash-tool invocation while the plugin is loaded WHEN the agent runs `bash -c 'echo $AGENTERA_HOME'` via the runtime's shell tool THEN the output is the agentera install root and the directory contains scripts/validate_spec.py
▸ GIVEN no agentera install root is discoverable on disk WHEN the shell-env injection point fires THEN AGENTERA_HOME is left unset (not assigned to empty string)
▸ GIVEN the user pre-set AGENTERA_HOME in their environment before loading the plugin WHEN injection fires THEN the user's value is preserved
▸ GIVEN tests/test_runtime_adapters.py fixtures that previously asserted the presence of `session.created` or `session.idle` strings in agentera.js WHEN the test suite runs THEN those fixtures pass against the new hook surface (updated to reflect the real surface)
▸ GIVEN scripts/validate_lifecycle_adapters.py WHEN run after the OpenCode plugin refactor THEN it exits 0; if it carries hook-name expectations they are updated to match the real OpenCode hook interface
▸ GIVEN scripts/smoke_opencode_bootstrap.mjs WHEN run THEN it exercises bootstrap-at-init and shell.env injection (including discoverable, not-discoverable, and pre-set branches) and exits 0
▸ Test proportionality: 1 pass + 1 fail per testable unit; edge expansion warranted for the shell.env injection branch (3 cases) per SPEC Section 16

### Task 3: [docs] Codex and Copilot AGENTERA_HOME setup documentation

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN a Codex user reading README.md install instructions WHEN they reach the Codex section THEN they find an explicit setup step naming `~/.codex/config.toml` and showing the exact `[shell_environment_policy]` `set = { AGENTERA_HOME = "<plugin install root>" }` snippet, plus a one-line rationale citing Codex's official config reference
▸ GIVEN .codex-plugin/plugin.json WHEN read THEN the `codex.limitations` array contains an entry naming the AGENTERA_HOME setup requirement and pointing at README
▸ GIVEN a Copilot user reading README.md install instructions WHEN they reach the Copilot section THEN they find an explicit setup step showing `export AGENTERA_HOME=<plugin install root>` and the rationale that Copilot inherits the parent shell env (citing the Copilot CLI plugin reference)
▸ GIVEN root plugin.json and .github/plugin/plugin.json WHEN read THEN their description fields surface the AGENTERA_HOME requirement in one sentence, pointing at README for setup steps
▸ GIVEN no code or hook changes in this task WHEN the validator and pytest suite run THEN no test status changes (this is documentation and metadata only)
▸ Test proportionality: docs and metadata; no new test budget

### Task 4: [refactor] Update 5 SKILL.md compaction invocations and activate the lint rule atomically

**Depends on**: Task 2, Task 3
**Status**: □ pending
**Acceptance**:
▸ GIVEN the 4 producer SKILL.md files (realisera with 2 invocations, resonera, optimera, inspektera) WHEN scanned for compaction-script invocations THEN no bare `${CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py` form remains at any of the 5 sites
▸ GIVEN the same files WHEN scanned THEN every invocation reads `python3 ${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py <spec> <path>` (preserving the spec name and path placeholder)
▸ GIVEN the spec validator extended in this task with a deterministic lint rule WHEN run against a SKILL.md containing bare `${CLAUDE_PLUGIN_ROOT}` in prose THEN it emits a warning naming the offending file and the suggested replacement
▸ GIVEN the same validator WHEN run against a SKILL.md using only the bash-fallback form THEN no warning is emitted for that file
▸ GIVEN the validator WHEN run against the 12 canonical SKILL.md files after this task's atomic edit lands THEN 0 errors and 0 net-new warnings
▸ GIVEN a Claude Code agent following any updated SKILL.md compaction instruction WHEN it executes the documented bash command THEN the script runs and exits 0 (no Claude Code regression)
▸ GIVEN an OpenCode agent following the same instruction (with shell.env injection working from Task 2) WHEN it executes the bash command THEN the script runs and exits 0
▸ GIVEN a Codex or Copilot agent following the same instruction (with the user setup from Task 3 applied) WHEN it executes the bash command THEN the script runs and exits 0
▸ Test proportionality: 1 pass + 1 fail for the new lint rule; SKILL.md cleanup itself is mechanical and covered by the validator running against the canonical 12 files

### Task 5: [chore] Bump suite metadata 1.19.0 -> 1.20.0 and refactor the test version literal

**Depends on**: Task 4
**Status**: □ pending
**Acceptance**:
▸ GIVEN every file listed in DOCS.md `version_files` WHEN inspected THEN it advertises version 1.20.0
▸ GIVEN tests/test_runtime_adapters.py WHEN inspected THEN the AGENTERA_VERSION literal that previously hardcoded the version string is refactored to read AGENTERA_VERSION from .opencode/plugins/agentera.js at test time, so future bumps do not require manual literal sync
▸ GIVEN CHANGELOG.md WHEN inspected THEN the Unreleased section sits empty above a new [1.20.0] dated heading that lists the AGENTERA_HOME contract feat (T1), the OpenCode bootstrap-at-init plus shell.env injection feat (T2), the Codex and Copilot setup documentation (T3), and the SKILL.md compaction refactor with lint rule (T4) under appropriate Added and Changed subsections
▸ GIVEN scripts/validate_spec.py and scripts/validate_lifecycle_adapters.py WHEN run after the bump THEN both exit 0
▸ GIVEN python3 -m pytest -q WHEN run after the bump and the test refactor THEN all tests pass
▸ Test proportionality: existing tests cover the bump itself; the test refactor adds 1 pass case verifying the test reads the version from agentera.js

### Task 6: [chore] Plan-level freshness checkpoint

**Depends on**: Task 5
**Status**: □ pending
**Acceptance**:
▸ GIVEN PLAN.md after Task 5 commits WHEN read THEN tasks 1 through 5 show ■ complete and Surprises captures any reality divergences logged during execution
▸ GIVEN PROGRESS.md WHEN read THEN one plan-level cycle entry summarizes the cross-runtime portability outcome at the plan level (does not restate per-cycle detail)
▸ GIVEN TODO.md WHEN read THEN follow-up items are filed for: SESSION.md bookmark replacement using OpenCode's real event mechanism (the `session.idle` hook is also phantom and the bookmark is currently dead under OpenCode); optional Codex setup helper that idempotently writes the `[shell_environment_policy]` entry to `~/.codex/config.toml`; optional Copilot setup helper that appends the export line to the user's shell rc
▸ GIVEN CHANGELOG.md 1.20.0 entry from Task 5 WHEN read THEN it represents the plan's three feats, one docs entry, and one refactor coherently without duplication
▸ Test proportionality: docs-only; no new test budget

## Overall Acceptance

▸ GIVEN a fresh OpenCode session loading the 1.20.0 plugin WHEN the user opens the slash-command palette THEN the 12 agentera commands appear without any manual file copying
▸ GIVEN an OpenCode-driven agent under 1.20.0 WHEN it follows any compaction instruction in a SKILL.md after writing an artifact entry THEN the compaction script executes and modifies the file in place
▸ GIVEN a Claude Code agent under 1.20.0 WHEN it follows the same compaction instruction THEN the script executes (no regression)
▸ GIVEN a Codex user who has applied the README setup step WHEN their agent follows the same instruction THEN the script executes
▸ GIVEN a Copilot user who has applied the README setup step WHEN their agent follows the same instruction THEN the script executes
▸ GIVEN the spec validator under 1.20.0 WHEN re-run against the 12 canonical SKILL.md files THEN 0 errors and 0 net-new warnings
▸ GIVEN a reader of SPEC.md after 1.20.0 WHEN they look for the contract that lets a third-party runtime adapter inject the agentera install root THEN they find AGENTERA_HOME defined as a first-class shared primitive next to PROFILERA_PROFILE_DIR, with a per-runtime mechanism table

## Surprises

- **Task 1 (Cycle 169)**: SPEC renumbering produced silent semantic drift in regenerated `skills/*/references/contract.md` files. The "no SKILL.md changes" constraint forbade syncing each skill's `spec_sections` frontmatter, so `spec_sections: [..., 19, 22]` in realisera/optimera/orkestrera now picks up the NEW Section 19 (Staleness Detection) and Section 22 (Session Corpus Contract) instead of Reality Verification Gate (now 20) and Pre-dispatch Commit Gate (now 23). Visual Identity (was 12) is now 13; Test Proportionality (was 16) is now 17; Loop Guard (was 11) is now 12; Phase Tracking (was 17) is now 18; Staleness Detection (was 18) is now 19; Reality Verification Gate (was 19) is now 20; Host Adapter Contract (was 20) is now 21; Session Corpus Contract (was 21) is now 22; Pre-dispatch Commit Gate (was 22) is now 23; Artifact Writing Conventions (was 23) is now 24. Affected SKILL.md `spec_sections` arrays that need a follow-up bump: realisera (19→20, 22→23), optimera (22→23), orkestrera (11→12, 18→19, 19→20), planera (16→17), inspektera (16→17, 17→18, 18→19), inspirera (12→13), visionera (12→13), visualisera (12→13), hej (12→13, 18→19). Affected SKILL.md prose references that need the same shift: every "Section 19" becomes "Section 20", every "Section 22" becomes "Section 23", every "Section 23" becomes "Section 24". Affected validator code (`scripts/validate_spec.py`): hardcoded "Section 19", "Section 22", "Section 23" patterns and the docstring/section-ref tuples must shift one number. Affected tests (`tests/test_validate_spec.py`, `tests/test_runtime_adapters.py`): "Section 19", "Section 21", "Section 22" string literals in fixtures must shift one number where they reference renumbered sections (Section 21 corpus stays 22; Reality Verification Gate fixtures shift). The validator currently passes at baseline (0 errors, 0 warnings) only because its checks are pattern-based and the SKILL.md prose still says the old numbers; if a future task tightens validation to enforce numerical-section-vs-content correspondence, all of the above must be addressed atomically. Owner: a follow-up task (out of Task 1's scope per the constraints) before the cross-runtime portability plan ships.

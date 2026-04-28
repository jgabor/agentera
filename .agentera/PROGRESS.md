# Progress

■ ## Cycle 215 · 2026-04-28 22:13 · chore(plan): close setup bundle checkpoint

**Phase**: verification
**What**: Completed Task 8 and closed the Unified Setup Bundle Doctor And Installer plan. The final checkpoint verified the 1.21.0 setup bundle surface end to end, recorded the Task 4 runtime-host smoke retry as the only plan surprise, and refreshed PROGRESS, TODO, CHANGELOG, DOCS, and PLAN to summarize the plan-level result.
**Commit**: this commit, `chore(plan): close setup bundle checkpoint`
**Inspiration**: Active PLAN.md Task 8. The plan needed one final evidence pass after implementation, release metadata, and docs were already accepted.
**Discovered**: The local setup doctor remains healthy with documented warnings for missing Claude `CLAUDE_PLUGIN_ROOT` and Codex `shell_environment_policy.set.AGENTERA_HOME`; bounded smoke still reports `ok: true` and `modelCallsAttempted: false`.
**Verified**: `python3 scripts/generate_contracts.py --check` passed with 12 current contracts. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings. `python3 scripts/validate_lifecycle_adapters.py --check-uv-runtime` printed `lifecycle adapter metadata ok`, covering lifecycle and package-shape checks. `python3 -m pytest tests/test_validate_artifact.py tests/test_runtime_adapters.py -q` passed with 90 tests. `python3 scripts/setup_doctor.py --install-root . --smoke --json` returned `ok: true`, 6 smoke passes, 0 smoke failures, and `modelCallsAttempted: false`. `python3 scripts/smoke_live_hosts.py` passed default non-live smoke with 6319 corpus records and delegated setup helper smoke passing. `node scripts/smoke_opencode_bootstrap.mjs` printed `PASS: all smoke checks passed`. `node --check .opencode/plugins/agentera.js` passed. `python3 -m pytest -q` passed with 477 tests.
**Next**: The setup bundle plan is complete; the next useful work is a fresh post-1.21 direction.
**Context**: intent (execute only Task 8 final verification and freshness checkpoint) · constraints (no new feature scope, no remote push, commit intended artifact changes only) · unknowns (none after final verification and clean pre-edit worktree) · scope (PLAN, PROGRESS, TODO, CHANGELOG, DOCS).

■ ## Cycle 214 · 2026-04-28 22:03 · docs(setup): refresh bundle doctor guidance

**Phase**: documentation
**What**: Completed Task 7 of the Unified Setup Bundle Doctor And Installer plan. README now recommends the bundle-first setup doctor flow, distinguishes core single-skill behavior from bundle-enhanced tools, and documents confirmed Codex/Copilot installer writes plus no-live-default smoke behavior. DOCS.md now tracks the setup doctor/installer row and 477 collected tests. Runtime parity notes keep granular Copilot installs core-only and suite tools bundle-owned.
**Commit**: this commit, `docs(setup): refresh bundle doctor guidance`
**Inspiration**: Active PLAN.md Task 7. Setup docs needed to move from future-tense helper setup to the shipped doctor and confirmed installer surface.
**Discovered**: The local Codex smoke check can be healthy while still warning about missing `shell_environment_policy.set.AGENTERA_HOME`; that warning is the doctor doing its job, not a docs failure.
**Verified**: `python3 -m pytest --collect-only -q` collected 477 tests. `python3 scripts/setup_doctor.py --help` showed read-only defaults, `--smoke`, `--install`, `--yes`, `--dry-run`, and no-live permission wording. `python3 scripts/setup_doctor.py --install-root . --smoke --runtime codex --json` returned `ok: true`, helper and hook smoke passes, `modelCallsAttempted: false`, and a Codex runtime-config warning for this local config. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`. `python3 -m pytest tests/test_setup_doctor.py tests/test_runtime_adapters.py -q` passed with 57 tests.
**Next**: Task 8, Verification And Freshness Checkpoint.
**Context**: intent (execute only Task 7 documentation refresh) · constraints (no Task 8 final sweep, preserve runtime-native adapter boundaries, no remote push, commit locally) · unknowns (Task 8 will decide plan-level freshness and full verification scope) · scope (README setup guidance, runtime parity install note, DOCS index/audit, PLAN, PROGRESS).

■ ## Cycle 213 · 2026-04-28 21:38 · chore(release): bump suite to 1.21.0

**Phase**: release metadata
**What**: Completed Task 6 of the Unified Setup Bundle Doctor And Installer plan. Applied the DOCS.md `feat = minor` policy by bumping suite version surfaces from `1.20.1` to `1.21.0`, promoted setup changelog entries into `1.21.0`, and marked Task 6 complete.
**Commit**: this commit, `chore(release): bump suite to 1.21.0`
**Inspiration**: Active PLAN.md Task 6. The setup bundle, doctor, smoke, and installer work landed as feature commits after `1.20.1`, so the suite metadata needed the next minor release identifier.
**Discovered**: `.agents/plugins/marketplace.json` is listed in DOCS.md `version_files` but carries no standalone release version field; the scan left that Codex marketplace index schema unchanged while requiring every actual suite version field to read `1.21.0`.
**Verified**: A stdlib JSON/version scan checked the DOCS.md version targets and reported 40 suite version fields matching `1.21.0`, with registry schema version `1` excluded and no release field in `.agents/plugins/marketplace.json`. `rg -n '1\.20\.1'` across those targets returned no matches. `python3 scripts/generate_contracts.py --check` passed with 12 current contracts. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`. `node --check .opencode/plugins/agentera.js` passed. `node scripts/smoke_opencode_bootstrap.mjs` printed `PASS: all smoke checks passed`. `python3 -m pytest -q` passed with 477 tests.
**Next**: Task 7, Documentation Refresh.
**Context**: intent (execute only Task 6 version metadata) · constraints (no README or setup guidance refresh, no Task 8 freshness sweep, no remote push, commit locally) · unknowns (Task 7 will decide release-facing setup guidance) · scope (version targets from DOCS.md, CHANGELOG, PLAN, PROGRESS).

■ ## Cycle 212 · 2026-04-28 21:29 · feat(setup): add confirmed doctor installer

**Phase**: implementation
**What**: Completed Task 5 of the Unified Setup Bundle Doctor And Installer plan. `scripts/setup_doctor.py --install` now reuses doctor findings to plan fixable Codex and Copilot runtime-native config writes, names the runtime, target file, and reason, refuses unconfirmed writes, applies only confirmed selected config files, and re-runs doctor after confirmed changes.
**Commit**: this commit, `feat(setup): add confirmed doctor installer`
**Inspiration**: Active PLAN.md Task 5 and Decision 33. Installer writes should be a confirmed layer on top of doctor evidence, not a separate unchecked setup path.
**Discovered**: Copilot rc configuration should count as a fixed runtime-native setup surface even before the current shell reloads `AGENTERA_HOME`; the doctor now reports a matching managed rc block as pass with restart guidance.
**Verified**: `python3 -m pytest tests/test_setup_doctor.py -q` passed with 12 tests, covering dry-run, denied write, confirmed write, and idempotent re-run for Codex and Copilot temp homes. `python3 scripts/setup_doctor.py --install --runtime codex --dry-run --json` returned a pending Codex change with target and reason while omitting proposed config contents. `python3 scripts/generate_contracts.py --check`, `python3 scripts/validate_spec.py`, `python3 scripts/validate_lifecycle_adapters.py`, and `python3 -m pytest -q` passed; full pytest reported 477 tests.
**Next**: Task 6, Version Metadata.
**Context**: intent (execute only Task 5) · constraints (no version bump, no README or DOCS refresh, no real user config mutation in tests, confirmed writes only) · unknowns (Task 6 will decide release version targets) · scope (`scripts/setup_doctor.py`, focused setup-doctor tests, PLAN, PROGRESS, CHANGELOG).

■ ## Cycle 211 · 2026-04-28 21:18 · fix(setup): prove runtime-host smoke failures

**Phase**: implementation
**What**: Retried Task 4 after evaluation found the runtime-host smoke category lacked a failure branch and explicit process-level failure evidence. Doctor smoke now marks a host-named but non-executable PATH candidate as `runtime_host` failure without invoking the runtime or attempting a model call.
**Commit**: this commit, `fix(setup): prove runtime-host smoke failures`
**Inspiration**: Task 4 retry evaluation. The acceptance wording treats helper, hook, and runtime-host smoke as separate categories, each needing success and failure evidence.
**Discovered**: Runtime-host failure can be proven without crossing the no-live boundary by inspecting PATH candidates that exist but are not executable.
**Verified**: `python3 -m pytest tests/test_setup_doctor.py -q` passed with 8 tests, adding the runtime-host failure branch beside helper and hook failure branches. `python3 scripts/setup_doctor.py --smoke --runtime codex --json` returned `modelCallsAttempted: false` with helper, hook, and host smoke passing against the available Codex binary. Process-level failure probes used a temp PATH containing a non-executable `codex`: human output exited 1 and printed `host.codex: fail - codex PATH candidate is not executable`; JSON output exited 1 with `ok: false`, `smoke.summary.fail: 1`, `host.codex.status: fail`, and details `runtime host was not invoked` plus `no live model call attempted`.
**Next**: Task 5, Confirmed-Write Installer.
**Context**: intent (satisfy Task 4 retry evaluation only) · constraints (no installer, no version bump, no docs refresh, preserve default no-live model behavior) · unknowns (none after process-level human and JSON failure probes) · scope (`scripts/setup_doctor.py`, focused doctor tests, PLAN, PROGRESS, CHANGELOG).

■ ## Cycle 210 · 2026-04-28 21:09 · feat(setup): add doctor smoke evidence

**Phase**: implementation
**What**: Completed Task 4 of the Unified Setup Bundle Doctor And Installer plan. `scripts/setup_doctor.py --smoke` now adds bounded offline evidence for shared helper reachability, artifact-hook validation, and runtime host availability while recording that no live model calls were attempted.
**Commit**: this commit, `feat(setup): add doctor smoke evidence`
**Inspiration**: Active PLAN.md Task 4 and Decision 33. Doctor should prove setup surfaces without crossing into installer writes or live model spend.
**Discovered**: The artifact hook can prove validation non-mutatingly by denying a synthetic invalid TODO.md pre-write candidate, so doctor smoke does not need to create user-facing artifacts.
**Verified**: `python3 -m pytest tests/test_setup_doctor.py -q` passed with 7 tests covering smoke success, helper failure, hook failure, host-binary skip, and no live host subprocess invocation. `python3 scripts/setup_doctor.py --smoke --runtime codex --json` returned `modelCallsAttempted: false` with helper, hook, and host smoke evidence. `PATH=/tmp/agentera-empty-path /usr/bin/python3 scripts/setup_doctor.py --smoke --runtime codex` marked the Codex host smoke skip while helper and hook smoke checks passed.
**Next**: Task 5, Confirmed-Write Installer.
**Context**: intent (execute only Task 4) · constraints (no installer writes, no version bump, no docs refresh, default no-live model behavior, commit locally) · unknowns (installer will decide confirmed-write planning and post-write doctor re-run shape) · scope (`scripts/setup_doctor.py`, focused doctor tests, PLAN, PROGRESS, CHANGELOG).

■ ## Cycle 209 · 2026-04-28 21:00 · feat(setup): add non-mutating setup doctor

**Phase**: implementation
**What**: Completed Task 3 of the Unified Setup Bundle Doctor And Installer plan. Added a read-only setup doctor that reports install-root validity, classifies Claude Code, OpenCode, Copilot, and Codex helper-script access as pass, warn, fail, or skip, and emits a stable JSON summary for downstream tools.
**Commit**: this commit, `feat(setup): add non-mutating setup doctor`
**Inspiration**: Active PLAN.md Task 3 and Decision 33. Doctor should inspect bundle/runtime state before any installer writes exist.
**Discovered**: Runtime diagnosis needs distinct gap labels: missing configured roots are runtime config, missing binaries or unloaded shell env are user environment, and configured roots without shared helper scripts are bundle packaging.
**Verified**: `pytest -q tests/test_setup_doctor.py` passed with 4 tests covering one pass, one warn/fail, and one skip per runtime family plus CLI JSON non-mutation. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`, including packaged executable script metadata for the new doctor. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings. `python3 -m pytest -q` passed with 469 tests.
**Next**: Task 4, Doctor Smoke Evidence.
**Context**: intent (execute only Task 3) · constraints (non-mutating default, no installer writes, no Task 4 smoke evidence, no version bump or docs refresh) · unknowns (Task 4 will decide live/no-model smoke attachment) · scope (`scripts/setup_doctor.py`, focused doctor tests, PLAN, PROGRESS, CHANGELOG).

■ ## Cycle 208 · 2026-04-28 20:50 · feat(setup): validate uv script hygiene

**Phase**: implementation
**What**: Completed Task 2 of the Unified Setup Bundle Doctor And Installer plan. Executable suite scripts now use uv script shebangs and inline stdlib-only metadata. Lifecycle adapter validation now checks packaged executable script headers, empty dependency declarations, library-module exclusions, and optional uv runtime availability with install guidance.
**Commit**: this commit, `feat(setup): validate uv script hygiene`
**Inspiration**: Active PLAN.md Task 2 and Decision 33. Suite infrastructure should be package-root owned and runnable from an installed bundle before doctor or installer behavior is added.
**Discovered**: `scripts/usage_stats.py` and `scripts/validate_lifecycle_adapters.py` were executable packaged scripts without inline script metadata, while the older executable scripts already declared `dependencies = []` but used the old Python shebang.
**Verified**: `python3 -m pytest tests/test_runtime_adapters.py -q` passed with 45 tests, covering one pass fixture, missing uv shebang, missing metadata, non-empty dependency metadata, library-module exclusion, and missing-uv install guidance. `python3 scripts/validate_lifecycle_adapters.py --check-uv-runtime` and `./scripts/validate_lifecycle_adapters.py --check-uv-runtime` printed `lifecycle adapter metadata ok`. `PATH=/tmp/agentera-empty-path /usr/bin/python3 scripts/validate_lifecycle_adapters.py --check-uv-runtime` failed cleanly with uv install guidance and no traceback. Representative uv invocations passed: `uv run --script scripts/validate_lifecycle_adapters.py --check-uv-runtime`, `uv run --script scripts/setup_codex.py --help`, `uv run --script scripts/usage_stats.py --help`, `uv run --script scripts/validate_spec.py`, and `uv run --script scripts/generate_contracts.py --check`. Full verification passed with `python3 scripts/validate_spec.py`, `python3 scripts/generate_contracts.py --check`, and `python3 -m pytest -q` at 465 tests.
**Next**: Task 3, Non-Mutating Setup Doctor.
**Context**: intent (execute only Task 2) · constraints (no doctor, installer, smoke-evidence, version bump, or docs-refresh work; keep behavioral skill scripts in their owning skills; extend existing validator and smoke surfaces) · unknowns (doctor output schema remains Task 3 scope) · scope (executable root script headers, lifecycle validator, focused runtime adapter tests, PLAN, PROGRESS, CHANGELOG).

■ ## Cycle 207 · 2026-04-28 20:39 · feat(setup): define suite bundle surface

**Phase**: implementation
**What**: Completed Task 1 of the Unified Setup Bundle Doctor And Installer plan. Claude Code, Codex, Copilot, and OpenCode aggregate metadata now declare an Agentera suite bundle surface: package shape, install root, shared paths, and the single-skill boundary. Lifecycle validation now checks those runtime package shapes and fails with the owning runtime name when shared paths are absent.
**Commit**: this commit, `feat(setup): define suite bundle surface`
**Inspiration**: Decision 33 and active PLAN.md Task 1. Suite installs should carry shared tools from one root while standalone skills keep core SKILL.md behavior independent from suite infrastructure.
**Discovered**: The existing lifecycle adapter validator was the right owner for package-shape validation because it already guards runtime metadata and bounded runtime claims.
**Verified**: `python3 -m pytest tests/test_runtime_adapters.py -q` passed with 39 tests, including one pass and one missing-`scripts` failure per runtime package shape. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`. `python3 -m json.tool` accepted `plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `.opencode/package.json`.
**Next**: Task 2, Packaged Script Runtime Hygiene.
**Context**: intent (execute only Task 1) · constraints (no doctor or installer behavior, no uv script metadata, preserve single-skill core behavior, commit locally) · unknowns (future doctor will decide report format) · scope (aggregate runtime metadata, lifecycle validator, focused runtime adapter tests, PLAN, PROGRESS, CHANGELOG).

■ ## Cycle 206 · 2026-04-28 19:43 · docs(release): reconcile 1.20.1 artifact state

**Phase**: release freshness
**What**: Reconciled live artifacts after the `1.20.1` patch release was pushed out of band. Updated the active release plan from pre-tag/active wording to complete post-publish state, recorded that `1.20.0` remains the parity-release identifier while `1.20.1` is the follow-up decision-numbering patch, and added a DOCS audit note for the stale release-state surfaces.
**Commit**: this commit, `docs(release): reconcile 1.20.1 artifact state`
**Inspiration**: User reported that `1.20.1` was pushed out of band, so live artifacts needed to match remote truth instead of the older `v1.20.0` publish handoff.
**Discovered**: Remote refs resolve to `origin/main` at `06a81e2`, `v1.20.0` at `629ed22`, and `v1.20.1` at `e9474c6`. The changelog and version surfaces already carry `1.20.1`; the stale pieces were operational artifacts.
**Verified**: `GIT_SSH_COMMAND='ssh -F /dev/null' git ls-remote --heads --tags origin main 'v1.20*'` returned the expected three refs. Version-surface grep found `1.20.1` across registry, marketplace, plugin, per-skill plugin, and OpenCode adapter version targets. `python3 scripts/generate_contracts.py --check`, `python3 scripts/validate_spec.py`, `python3 scripts/validate_lifecycle_adapters.py`, and `python3 -m pytest -q` passed after the artifact update.
**Next**: No release-artifact follow-up remains; the next session can choose a fresh post-1.20 direction.
**Context**: intent (update only live artifacts to reflect out-of-band `1.20.1` push and commit) · constraints (no remote operations, preserve pushed history, keep the patch release distinct from the `1.20.0` parity release) · unknowns (none after remote-ref verification) · scope (`.agentera/PLAN.md`, `.agentera/DOCS.md`, `.agentera/PROGRESS.md`).

## Archived Cycles

- Cycle 205 (2026-04-28): docs(release): record 1.20 readiness handoff
- Cycle 204 (2026-04-28): fix(release): guard hard-gate docs drift
- Cycle 203 (2026-04-28): chore(release): fold metadata to 1.20.0
- Cycle 202 (2026-04-28): docs(runtime): add tracked parity reference
- Cycle 201 (2026-04-28): fix(opencode): preserve empty prewrite candidates
- Cycle 200 (2026-04-28): fix(opencode): hard gate artifact prewrites
- Cycle 199 (2026-04-28): fix(copilot): hard gate artifact prewrites
- Cycle 198 (2026-04-27): fix(copilot): validate documented hook event names
- Cycle 197 (2026-04-27): fix(opencode): restore session bookmarks via event hook
- Cycle 196 (2026-04-27): chore(plan): freshness checkpoint for Cross-Runtime Parity Completion
- Cycle 195 (2026-04-27): feat(smoke): add --yes consent bypass and live Codex apply_patch hook firing verification
- Cycle 194 (2026-04-27): docs(orkestrera): document runtime-aware dispatch substrates
- Cycle 193 (2026-04-27): fix(codex): add explicit model field to 12 agent.toml stubs per AC2
- Cycle 192 (2026-04-27): feat(codex): publish marketplace.json, ship 12 agent.toml stubs, extend setup_codex.py with --enable-agents
- Cycle 191 (2026-04-27): feat(codex): wire apply_patch hook for real-time artifact validation
- Cycle 190 (2026-04-27): fix(copilot): revive dead session-end hook, audit SKILL.md frontmatter for #951 workaround, swap README install path to granular per #2390
- Cycle 189 (2026-04-27): docs(runtime): refresh structured runtime metadata with verified Codex hook capability evidence
- Cycle 188 (2026-04-27): docs(runtime): refresh README and SPEC prose with verified Codex and Copilot capability evidence
- Cycle 187 (2026-04-27): chore(release): renumber and consolidate three local pre-push releases into a single 1.20.0
- Cycle 186 (2026-04-26): chore(release): bump suite to 1.22.0
- Cycle 185 (2026-04-26): docs(verify): document manual AGENTERA_HOME verification and surface smoke_live_hosts.py
- Cycle 184 (2026-04-26): feat(smoke): wire copilot -p AGENTERA_HOME + compaction live verification
- Cycle 183 (2026-04-26): feat(smoke): wire codex exec AGENTERA_HOME + compaction live verification
- Cycle 182 (2026-04-26): feat(smoke): add scripts/smoke_live_hosts.py scaffold for codex+copilot verification
- Cycle 181 (2026-04-26): chore(audit): profilera Codex collection verification and metadata reconciliation
- Cycle 180 (2026-04-26): chore(plan): freshness checkpoint for Codex+Copilot Completion
- Cycle 179 (2026-04-26): chore(release): bump suite to 1.21.0
- Cycle 178 (2026-04-26): docs(install): surface setup helpers in README and refresh DOCS.md Index
- Cycle 177 (2026-04-26): test(smoke): add scripts/smoke_setup_helpers.py for codex and copilot helpers
- Cycle 176 (2026-04-26): feat(setup): add scripts/setup_copilot.py for AGENTERA_HOME shell-rc injection
- Cycle 175 (2026-04-26): feat(setup): add scripts/setup_codex.py for AGENTERA_HOME injection
- Cycle 174 (2026-04-26): chore(plan): freshness checkpoint for Cross-Runtime Portability
- Cycle 173 (2026-04-26): chore(release): bump suite to 1.20.0
- Cycle 172 (2026-04-26): refactor(skills): adopt AGENTERA_HOME bash fallback and shift Section refs after SPEC renumber
- Cycle 171 (2026-04-26): docs(install): codex and copilot AGENTERA_HOME setup steps
- Cycle 170 (2026-04-26): feat(opencode): bootstrap at init and inject AGENTERA_HOME via shell.env
- Cycle 169 (2026-04-26): feat(spec): standardize AGENTERA_HOME contract for cross-runtime helper paths
- Cycle 168 (2026-04-26): chore(plan): freshness checkpoint for Suite Usage Analytics
- Cycle 167 (2026-04-26): chore(release): bump suite to 1.19.0
- Cycle 166 (2026-04-26): docs(usage): document scripts/usage_stats.py across README, DOCS.md, AGENTS.md

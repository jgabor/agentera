# Progress

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

■ ## Cycle 205 · 2026-04-28 16:21 · docs(release): record 1.20 readiness handoff

**Phase**: release readiness
**What**: Prepared the local Task 6 release-readiness handoff without publishing. Folded the remaining Copilot and OpenCode hard-gate changelog entries into the single `1.20.0` section. Updated DOCS coverage to the Task 5 verified 452 tests. Added a TODO for the explicit retag, fast-forward publish, tag push, and remote-ref verification steps. Logged the realisera safety boundary in PLAN because final tag movement and remote publish require explicit release action.
**Commit**: this commit, `docs(release): record 1.20 readiness handoff`
**Inspiration**: Active `.agentera/PLAN.md` Task 6. The plan needs truthful release artifacts before the final publish step, but realisera must not push or force-retag.
**Discovered**: Local `v1.20.0` points at `17c6141`, not the current release head. Remote `v1.20*` tags are absent when checked with `GIT_SSH_COMMAND='ssh -F /dev/null'`.
**Verified**: N/A: docs-only. The cycle changes only release artifacts. `python3 scripts/compact_artifact.py progress .agentera/PROGRESS.md` compacted 11 to 10 full entries. `python3 scripts/generate_contracts.py --check` passed with 12 current contracts. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`. `node --check .opencode/plugins/agentera.js` passed. `node scripts/smoke_opencode_bootstrap.mjs` printed `PASS: all smoke checks passed`. `python3 -m pytest -q` passed with 452 tests. `git rev-parse v1.20.0` returned `17c6141a48648a19e9460b424ad9cb03f742a197`, while HEAD before this cycle was `7143e4acb949680ce336e1be22274fbe947e36c8`. `GIT_SSH_COMMAND='ssh -F /dev/null' git ls-remote --tags origin 'v1.20*'` returned no remote tags. `rg -n "1\.20\.1|1\.21\.0|1\.22\.0"` across release-facing surfaces returned no matches.
**Next**: Release publish is authorized: retag `v1.20.0` at this final artifact commit, fast-forward `origin/main`, push the tag, and verify both remote refs.
**Context**: intent (prepare Task 6 local freshness before publishing) · constraints (explicit user authorization required for remote push and tag movement, keep one 1.20.0 release story) · unknowns (none after release authorization) · scope (`CHANGELOG.md`, `TODO.md`, `.agentera/DOCS.md`, `.agentera/PLAN.md`, `.agentera/PROGRESS.md`).

■ ## Cycle 204 · 2026-04-28 13:27 · fix(release): guard hard-gate docs drift

**Phase**: release verification
**What**: Completed Task 5 of the v1.20 parity plan. Strengthened `scripts/validate_lifecycle_adapters.py` so lifecycle validation now guards the release-facing hard-gate documentation surfaces, not only the shipped hook wiring. Added focused regression tests proving Copilot overclaim drift and OpenCode `apply_patch` limitation drift are caught. Ran the release verification surface and marked Task 5 complete.
**Commit**: this commit, `fix(release): guard hard-gate docs drift`
**Inspiration**: Active `.agentera/PLAN.md` Task 5. The release needed verification to protect both shipped gates and the scoped Copilot/OpenCode claims that explain their limits.
**Discovered**: The existing lifecycle validator required the Copilot `preToolUse` hook and OpenCode `tool.execute.before` hook, but it did not yet fail if docs later broadened those conditional hard-gate claims.
**Verified**: `python3 scripts/generate_contracts.py --check` passed with 12 current contracts. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings across 12 skills. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`. `node --check .opencode/plugins/agentera.js` passed. `node scripts/smoke_opencode_bootstrap.mjs` printed `PASS: all smoke checks passed`. `python3 -m pytest -q` passed with 452 tests. Live-host unavailable behavior was verified without model calls by running `PATH=/tmp/agentera-no-live-bin /bin/python3 scripts/smoke_live_hosts.py --live --yes`; it reported `SKIP: codex (not on PATH)`, `SKIP: codex-hook (not on PATH)`, `SKIP: copilot (not on PATH)`, then `PASS: all smoke checks passed`. `python3 -m pytest tests/test_runtime_adapters.py -q` passed with 35 tests, including drift fixtures that remove the Copilot insufficient-evidence constraint and the OpenCode `apply_patch` limitation.
**Next**: Task 6, Plan-Level Freshness And Publish.
**Context**: intent (complete only Task 5 release verification) · constraints (no publish, no tag changes, no Task 6 freshness sweep, keep release version at 1.20.0, avoid live model spend) · unknowns (none after unavailable live-host smoke and full verification) · scope (`scripts/validate_lifecycle_adapters.py`, `tests/test_runtime_adapters.py`, `.agentera/PLAN.md`, `.agentera/PROGRESS.md`).

■ ## Cycle 203 · 2026-04-28 13:17 · chore(release): fold metadata to 1.20.0

**Phase**: release metadata
**What**: Completed Task 4 of the v1.20 parity plan. Folded local suite metadata back to the single pre-tag `1.20.0` identifier across DOCS.md version targets. Removed the standalone `1.20.1` changelog section and folded the OpenCode session-events fix into the existing `1.20.0` Fixed list. Rewrote TODO release claims so setup helpers and session-event work ship under folded `1.20.0` release metadata. Refreshed DOCS release index rows and marked Task 4 complete.
**Commit**: this commit, `chore(release): fold metadata to 1.20.0`
**Inspiration**: Active `.agentera/PLAN.md` Task 4. The release is still pre-tag, so local patch/minor claims needed one coherent 1.20.0 story.
**Discovered**: `registry.json` has a schema-level `"version": "1"` that is not a suite release surface. The version-file check preserves it while requiring all skill and adapter release entries to read `1.20.0`.
**Verified**: N/A: chore-build-config. Metadata checks passed. A stdlib JSON/version scan checked 18 version files and reported all suite version surfaces read `1.20.0`, with registry schema version `1` preserved. A changelog count check reported one `1.20.0` section and zero `1.20.1` sections. `rg -n "1\.20\.1|1\.21\.0|1\.22\.0"` across TODO, README, AGENTS, CLAUDE, CHANGELOG, DOCS, references, docs, and version files returned no matches. A DOCS check confirmed `449 tests across 17 files` plus 2026-04-28 release index rows for registry, marketplace, Copilot manifests, and Codex manifest. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings across 12 skills. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`. `node --check .opencode/plugins/agentera.js` passed.
**Next**: Task 5, Release Verification Surface.
**Context**: intent (complete only Task 4 release metadata fold-down) · constraints (no Task 5 verification sweep, no publish, no tags, no normal patch bump, commit locally) · unknowns (none after DOCS version_files and release-facing docs checks) · scope (`plugin.json`, `.github/plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.opencode/plugins/agentera.js`, `registry.json`, `skills/*/.claude-plugin/plugin.json`, `CHANGELOG.md`, `TODO.md`, `.agentera/DOCS.md`, `.agentera/PLAN.md`, `.agentera/PROGRESS.md`).

■ ## Cycle 202 · 2026-04-28 13:04 · docs(runtime): add tracked parity reference

**Phase**: documentation
**What**: Completed Task 3 of the v1.20 parity plan. Added `references/adapters/runtime-feature-parity.md` as the tracked adapter-reference comparison for Claude Code, OpenCode, Copilot, and Codex. README now points at the reference and aligns runtime claims with shipped behavior: OpenCode and Copilot hard-gate only reconstructable artifact candidates, Claude Code remains PostToolUse advisory, and Codex ships `apply_patch` PreToolUse/PostToolUse validation without final patch-content reconstruction. Codex plugin metadata now names the bundled hook config and its limits.
**Commit**: this commit, `docs(runtime): add tracked parity reference`
**Inspiration**: Active `.agentera/PLAN.md` Task 3 and the Task 1/Task 2 verification notes. The release needed one tracked comparison that prevents broad hard-gate parity claims from creeping back into README.
**Discovered**: Codex hook firing evidence proves the `apply_patch` hooks run, but it does not prove candidate-content blocking. The reference therefore treats Codex as an active validation surface, not a functional hard gate.
**Verified**: Docs-only evidence check passed. `git ls-files references/adapters/runtime-feature-parity.md README.md .agentera/DOCS.md .agentera/PROGRESS.md` proved the parity reference is tracked and indexed beside README and progress evidence. README links `references/adapters/runtime-feature-parity.md` and its runtime tables agree with the reference: Claude Code stays PostToolUse advisory, OpenCode gates reconstructable write/edit candidates, Copilot gates reconstructable preToolUse candidates, and Codex ships only `apply_patch` PreToolUse/PostToolUse validation. The reference names runtime reasons for degraded or blocked paths: OpenCode preload lacks a model-context injection path, OpenCode `apply_patch` lacks full-content reconstruction, Copilot sparse edits lack enough payload evidence, Codex preload/bookmarks are not wired in the shipped config, and Codex artifact validation does not reconstruct final candidate content. The hard-gate no-overclaim check passed because docs claim functional blocking only for implemented and verified closeable paths: OpenCode and Copilot reconstructable artifact candidates. `python3 scripts/generate_contracts.py --check`, `python3 scripts/validate_spec.py`, `python3 scripts/validate_lifecycle_adapters.py`, `node --check .opencode/plugins/agentera.js`, and `python3 -m pytest -q` passed after the documentation update.
**Next**: Task 4, Single 1.20.0 Release Metadata.
**Context**: intent (complete only Task 3 by creating the tracked parity reference and aligning README with it) · constraints (no Task 4 release metadata fold-down, keep OpenCode preload deferred, avoid universal hard-gate parity claims, update DOCS and PLAN, commit locally) · unknowns (none after comparing the hook configs and validator implementation) · scope (`references/adapters/runtime-feature-parity.md`, README, Codex plugin metadata, DOCS, PLAN, PROGRESS).

## Archived Cycles

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
- Cycle 165 (2026-04-26): feat(usage): emit USAGE.md, stdout summary, and JSON
- Cycle 164 (2026-04-26): feat(usage): classify trigger phrasing and scope by project
- Cycle 163 (2026-04-26): feat(usage): detect skill invocations and pair with exit signals
- Cycle 162 (2026-04-26): feat(validator): accept arbitrary SKILL.md paths for third-party authoring

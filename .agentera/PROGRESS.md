# Progress

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

■ ## Cycle 201 · 2026-04-28 12:55 · fix(opencode): preserve empty prewrite candidates

**Phase**: implementation retry
**What**: Closed the failed Task 2 retry gap. OpenCode pre-write candidate reconstruction now chooses the first string-valued argument by presence, so `content: ""` and `newString: ""` remain valid candidates instead of being skipped by truthiness fallback. The existing single deny smoke branch now denies an empty `.agentera/HEALTH.md` write while the allow and non-artifact no-op branches stay intact. Task 2 remains complete because the retry blocks reconstructable empty-string invalid artifacts before mutation and preserves the session event behavior.
**Commit**: 3f9de12 `fix(opencode): preserve empty prewrite candidates`
**Inspiration**: Evaluator finding for Task 2: OpenCode `write` and `edit` payloads with empty-string candidates were allowed because `args.content || ...` and `args.newString || ...` treated empty strings as missing.
**Discovered**: The hard gate logic was structurally correct, but candidate selection needed presence semantics instead of truthiness semantics. No Task 3 work was needed.
**Verified**: `node scripts/smoke_opencode_bootstrap.mjs` passed and now covers the capped pre-write smoke branches: empty-string invalid artifact write denied, valid artifact write allowed, and non-artifact write no-op, plus preserved `session.idle` SESSION.md bookmark write and `session.created` no-op behavior. Manual OpenCode-shaped `edit` probe with `newString: ""` deleting `## Audit 1` from `.agentera/HEALTH.md` returned `PASS: empty-string edit candidate denied`. `node --check .opencode/plugins/agentera.js` passed. `python3 scripts/generate_contracts.py --check` passed with 12 current contracts. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`. `python3 -m pytest -q` passed with 449 tests.
**Next**: Task 3, Tracked Feature Parity Reference.
**Context**: intent (retry only failed Task 2 edge case) · constraints (preserve smoke cap one allow/deny/no-op branch, no Task 3 work, keep generic OpenCode event lifecycle and no preload claim, commit locally, no push) · unknowns (`apply_patch` patchText full-content reconstruction remains deferred) · scope (`.opencode/plugins/agentera.js`, `scripts/smoke_opencode_bootstrap.mjs`, `.agentera/PROGRESS.md`).

■ ## Cycle 200 · 2026-04-28 12:48 · fix(opencode): hard gate artifact prewrites

**Phase**: implementation
**What**: Completed Task 2 of the v1.20 parity plan. OpenCode now exposes `tool.execute.before` alongside the existing generic `event`, `shell.env`, and `tool.execute.after` hooks. The pre-write hook reconstructs write/edit artifact candidates from OpenCode args, delegates candidate validation to `hooks/validate_artifact.py`, and throws an error to block invalid artifact content before mutation. Valid artifact candidates and non-artifact edits continue. The session lifecycle behavior from Cycle 197 is preserved: `session.idle` still writes SESSION.md bookmarks, and `session.created` remains a documented no-op because no model-context injection path is proven. Docs now state the `apply_patch` patchText limitation rather than claiming universal hard-gate parity.
**Commit**: 9431fe7 `fix(opencode): hard gate artifact prewrites`
**Inspiration**: Active `.agentera/PLAN.md` Task 2 plus OpenCode plugin docs and local `@opencode-ai/plugin` types. Official docs show `tool.execute.before` can mutate args or throw to block, list `session.idle` as an `event` payload, and note `apply_patch` uses `output.args.patchText`.
**Discovered**: OpenCode has enough documented surface for a conditional hard gate on reconstructable write/edit candidates. It does not yet give this adapter a full-content candidate for `apply_patch` patchText, so that path stays allowed and explicitly documented as evidence-insufficient.
**Verified**: `python3 scripts/generate_contracts.py --check` passed with 12 current contracts. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`. `node --check .opencode/plugins/agentera.js` passed. `node scripts/smoke_opencode_bootstrap.mjs` passed and covered pre-write deny, allow, and no-op branches plus idle bookmark write and created-event no-op. `python3 -m pytest -q` passed with 449 tests.
**Next**: Task 3, Tracked Feature Parity Reference.
**Context**: intent (close only Task 2) · constraints (stdlib-only Python, preserve generic OpenCode event lifecycle, no model-visible preload claim, test cap one allow/deny/no-op smoke branch, no Task 3 work) · unknowns (`apply_patch` patchText full-content reconstruction remains deferred) · scope (`.opencode/plugins/agentera.js`, shared artifact validator, OpenCode smoke, lifecycle validator/tests, README, adapter reference, CHANGELOG, DOCS, PLAN, PROGRESS).

■ ## Cycle 199 · 2026-04-28 11:40 · fix(copilot): hard gate artifact prewrites

**Phase**: implementation
**What**: Completed Task 1 of the v1.20 parity plan. Copilot now ships `.github/hooks/preToolUse.json`, which runs the shared artifact validator before tools mutate files. `hooks/validate_artifact.py` parses Copilot `toolName` / JSON-string `toolArgs`, reconstructs candidate content from full-content payloads or old/new replacement payloads, denies invalid artifact candidates with `permissionDecision: deny`, and allows valid, non-artifact, malformed, or evidence-insufficient payloads. Lifecycle validation now requires the shipped pre-write gate, and README wording no longer claims broader hard-gate parity than the payload evidence proves.
**Commit**: 35afaaf `fix(copilot): hard gate artifact prewrites`
**Inspiration**: Active `.agentera/PLAN.md` Task 1 and GitHub Copilot hook docs: `preToolUse` receives `toolName` plus JSON-string `toolArgs`, and blocking is expressed through `permissionDecision: deny`.
**Discovered**: Copilot gives enough documented hook evidence for a conditional hard gate, not for every edit shape. The implementation therefore denies only reconstructable candidates and treats sparse payloads as allowed.
**Verified**: `python3 -m pytest tests/test_validate_artifact.py tests/test_runtime_adapters.py -q` passed with 74 tests. `python3 -m pytest -q` passed with 449 tests. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings. `python3 scripts/generate_contracts.py --check` printed `All contract files are current (12 checked)`. Manual Copilot-shaped stdin probe returned deny for invalid `.agentera/HEALTH.md` candidate and allow for non-artifact `README.md`.
**Next**: Task 2, OpenCode Artifact Validation Hard Gate.
**Context**: intent (close only Task 1) · constraints (stdlib-only Python, extend existing validators, no unsupported parity claim, no Task 2 work, no push) · unknowns (live Copilot host payload variants may include sparse toolArgs) · scope (`preToolUse` hook config, shared artifact validator, lifecycle validator, focused tests, README/CHANGELOG/DOCS, PLAN, PROGRESS).

■ ## Cycle 198 · 2026-04-27 22:15 · fix(copilot): validate documented hook event names

**Phase**: implementation
**What**: Executed the Copilot Hook Event Name Validator plan. `scripts/validate_lifecycle_adapters.py` now uses the full documented Copilot event allowlist, accepts all six supported hook names, rejects stale names such as `stop`, and rejects per-event hook files whose filename does not match the declared event. `tests/test_runtime_adapters.py` gained focused coverage for accepted documented events, unsupported events, filename mismatch, and preserved handler validation.
**Commit**: 73f19dd `fix(copilot): validate documented hook event names`
**Inspiration**: Active PLAN.md and prior Cycle 190 evidence. The earlier `stop` typo showed that the validator must encode the host event allowlist, not only the currently shipped hook files.
**Discovered**: The worker dispatch produced no code, so the scoped edit was completed directly in the main checkout after the pre-dispatch plan checkpoint. No exploratory decisions blocked the work. The active light plan is archived because all acceptance criteria are satisfied.
**Verified**: `python3 -m pytest tests/test_runtime_adapters.py -q` passed with 31 tests. `python3 scripts/validate_lifecycle_adapters.py` printed `lifecycle adapter metadata ok`. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings. `python3 -m pytest -q` passed with 444 tests.
**Next**: The remaining Normal TODOs are external aggregator PRs for Copilot and Codex plugin listings.
**Context**: intent (execute the active Copilot hook event-name validator plan) · constraints (one focused validator cycle, no runtime behavior changes, preserve existing handler checks, no remote operations) · unknowns (worker dispatch did not produce code, so main-checkout implementation completed the same scope) · scope (`scripts/validate_lifecycle_adapters.py`, `tests/test_runtime_adapters.py`, `CHANGELOG.md`, `TODO.md`, PLAN archive, PROGRESS).

■ ## Cycle 197 · 2026-04-27 20:05 · fix(opencode): restore session bookmarks via event hook

**Phase**: implementation
**What**: Executed the OpenCode Session Events plan. Replaced the dead SESSION.md bookmark path with real OpenCode event handling: `.opencode/plugins/agentera.js` now returns a generic `event` hook, explicitly ignores `session.created`, and delegates `session.idle` to the existing `hooks/session_stop.py` bookmark writer. Updated `references/adapters/opencode.md` and README to describe `session.created` / `session.idle` as event payload values, not direct hook keys; OpenCode session-start preload is now documented as deferred because no supported model-context injection path is verified. Extended `scripts/smoke_opencode_bootstrap.mjs`, `tests/test_runtime_adapters.py`, and `scripts/validate_lifecycle_adapters.py` to require the generic event hook, reject phantom direct keys, and prove idle write, idle no-op, created-event no-op, and malformed-event no-op behavior. Applied patch release metadata to 1.20.1 across DOCS.md version targets, promoted CHANGELOG, resolved `[opencode-session-events]`, marked the plan complete, and refreshed DOCS.md coverage to 441 tests.
**Commit**: a4d7d19 `fix(opencode): restore session bookmarks via event hook`
**Inspiration**: OpenCode plugin docs show `event: async ({ event })` with `event.type === "session.idle"`; local `@opencode-ai/plugin` types expose `event?: ({ event }) => Promise<void>` and no direct session hook members. Decision 23 keeps SESSION.md as the continuity artifact, so the fix reuses the existing Python bookmark writer instead of inventing a second format.
**Discovered**: Session-start preload remains unsupported for OpenCode in this adapter. The `session.created` event is observable, but observation alone does not inject digest text into model context. The plan therefore documents preload as deferred and leaves no dead preload branch behind. The smoke harness can exercise event payload behavior without a live OpenCode session by invoking the exported hook object against temp git projects.
**Verified**: `node --check .opencode/plugins/agentera.js` passed. `node scripts/smoke_opencode_bootstrap.mjs` passed and reported 7 plugin init calls, idle bookmark write, created-event no-op, malformed-event no-op, and idle no-op. `python3 scripts/validate_lifecycle_adapters.py` passed. `python3 scripts/validate_spec.py` passed with 0 errors and 0 warnings. `python3 -m pytest tests/test_runtime_adapters.py -q` passed with 28 tests. `python3 -m pytest -q` passed with 441 tests.
**Next**: Commit the 1.20.1 OpenCode session-events fix locally; no push or tag has been performed.
**Context**: intent (execute the active OpenCode Session Events plan through a patch release, restore SESSION.md bookmark behavior on real OpenCode event semantics, and keep preload claims honest) · constraints (generic event hook only, no direct session hook keys, reuse SESSION.md contract, patch bump per DOCS.md, no remote operations) · scope (`.opencode/plugins/agentera.js`, `scripts/smoke_opencode_bootstrap.mjs`, `tests/test_runtime_adapters.py`, `scripts/validate_lifecycle_adapters.py`, `references/adapters/opencode.md`, README, version files, CHANGELOG, TODO, DOCS, PLAN, PROGRESS).

## Archived Cycles

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
- Cycle 161 (2026-04-25): chore(plan): checkpoint copilot marketplace freshness
- Cycle 160 (2026-04-25): docs(release): apply copilot release convention
- Cycle 159 (2026-04-25): docs(copilot): update user guidance
- Cycle 158 (2026-04-25): chore(runtime): verify copilot host state
- Cycle 157 (2026-04-25): test(install): guard copilot marketplace claims

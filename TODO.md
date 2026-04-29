# TODO

## ⇶ Critical

## ⇉ Degraded

## → Normal

- [ ] ISS-41: [feat] Extend SPEC.md §24 with Self-Audit Protocol: define 3 artifact prose-quality checks (verbosity drift, abstraction creep, filler accumulation) with pre-write mandatory-gate instruction template and producing skill obligations · feeds Decision 34
- [ ] ISS-42: [feat] Add pre-write self-audit step to all artifact-producing SKILL.md files (realisera, inspektera, resonera, planera, optimera, dokumentera, visualisera) invoking the §24 Self-Audit Protocol · feeds Decision 34
- [ ] ISS-43: [feat] Add "prose health" audit dimension to inspektera SKILL.md for post-layer artifact prose quality enforcement · feeds Decision 34
- [ ] ISS-44: [feat] Add prose-quality enforcement step to dokumentera SKILL.md for pre-write and post-audit doc quality checks · feeds Decision 34

## ⇢ Annoying

## Resolved

- [x] ~~Task 8: [chore] Verification and Freshness Checkpoint for the Unified Setup Bundle Doctor And Installer plan~~ · resolved in final checkpoint commit; validators, smoke checks, full pytest, and plan artifacts are freshness-complete
- [x] ~~[audit-11] Deferred: Copilot current-checkout plugin smoke is blocked by escaping skills path; installed Copilot skills and Codex `$hej` smoke passed~~ · fixed in Cycle 153; root `plugin.json` loads shared `skills/` through `copilot --plugin-dir`
- [x] ~~[audit-11] Deferred: live Copilot and Codex host behavior remains untested until host smoke tests are available~~ · narrowed by Cycle 152; Codex `$hej` and Copilot installed skills passed, current-checkout Copilot plugin loading remains blocked
- [x] ~~Task 2: [feat] Add native Copilot and Codex packaging metadata~~ · resolved without issue ID; Task 2 lacked a dedicated PROGRESS entry, now covered by Cycle 134 rollup
- [x] ~~Task 6: [chore] Bump native runtime support release metadata to 1.17.0~~ · resolved without issue ID; Cycle 133 added missing evidence and preserved marketplace `profilera` at `2.8.0`
- [x] ~~[telemetry] Build `scripts/usage_stats.py` per Decision 32: detect skill invocations via workflow markers across the Claude Code + OpenCode session corpus, pair with exit signals to count completed workflows, tag slash-vs-NL triggers, default cross-project with a `--project` flag, write markdown to `~/.local/share/agentera/USAGE.md` plus a brief stdout summary, and accept `--json` for machine output.~~ · fixed by Suite Usage Analytics PLAN Tasks 1-3 (commits 7f536a0, dcfb872, 4c4b907), documented by Task 4 (e12c628), released in 1.19.0 by Task 5 (cc1eacc)
- [x] ~~ISS-39: [feat] Implement optimera multi-objective support (Decision 31)~~ · fixed in bd88f63..845a387 (per-objective subdirs under .agentera/optimera/, active-objective inference, SPEC.md/SKILL.md/hooks/DOCS.md updates, version bump 1.12.0)
- [x] ~~ISS-40: [fix] Profile path mismatch after Decision 28~~ · fixed — all SKILL.md, SPEC.md, DOCS.md, DOCS template, README.md, opencode adapter doc, and 12 contract.md files updated to `$PROFILERA_PROFILE_DIR/PROFILE.md` with platform-appropriate defaults; 292 tests pass, validate_spec.py 0 errors
- [x] ~~ISS-38: [feat] Move profile path to XDG-standard agentera data directory (Decision 28)~~ · fixed in 32cd8c7..4870d80 (XDG default with platform detection, auto-migration from ~/.claude/profile/, OpenCode plugin sets PROFILERA_PROFILE_DIR at init)
- [x] ~~ISS-37: [feat] Implement Section 21 session corpus contract (Decision 27)~~ · fixed in 74e539c..277e559 (spec envelope format, multi-runtime corpus builder, self-validation, SKILL.md Steps 1-2 update, 14 new tests, version bump 1.10.0)
- [x] ~~ISS-34: [feat] Plan-relative staleness detection (Decision 22)~~ · fixed in cd519b0..7e3255b
- [x] ~~ISS-19: [feat] Phase tracking spec~~ · spec delivered in 2caa9cb, SKILL.md enforcement dropped per Decision 22 (replaced by ISS-34)
- [x] ~~ISS-33: [docs] Add test proportionality convention (Decision 21)~~ · fixed in 0c67553..61e7f7d
- [x] ~~ISS-29: [feat] Build orkestrera skill (Decision 20)~~ · fixed in 1858de0..3decb87
- [x] ~~ISS-24: [feat] Retry caps in the spec~~ · superseded by ISS-29 (Decision 20: orkestrera)
- [x] ~~ISS-23: [feat] Structured AC verification for planera → realisera handoff~~ · superseded by ISS-29 (Decision 20: orkestrera)
- [x] ~~ISS-22: [feat] Headless runner script~~ · superseded by ISS-29 (Decision 20: orkestrera)
- [x] ~~ISS-21: [feat] Separated evaluator for realisera~~ · superseded by ISS-29 (Decision 20: orkestrera)
- [x] ~~ISS-27: [feat] Add narration voice principle and warm up skill narration (Decision 17)~~ · fixed in 2ee4e99..de45a45
- [x] ~~ISS-26: [refactor] Refine skill voice to match "sharp colleague" standard (Decision 16)~~ · fixed in e17d588..067a251
- [x] ~~ISS-20: [feat] Implement formatting decisions (Decision 14)~~ · fixed in 8dfb6fe..e73d31e
- [x] ~~[audit-11] Refresh DOCS Plan index after the completed runtime portability plan~~ · resolved without commit by explicit user request; Task 8 set DOCS and PLAN to one current completed Audit 11 state
- [x] ~~[audit-11] Treat Audit 11 as the resolution marker for stale historical collector-unavailable wording~~ · resolved without commit by explicit user request; Task 8 records collector cleanup complete while keeping live host behavior deferred
- [x] ~~[refactor] `hooks/common.py` and `hooks/validate_artifact.py` duplicated DOCS.md path resolution (Audit 9 Coupling info)~~ · fixed in 627e30c (validate_artifact now imports parse_artifact_mapping from common; 30 lines of duplicate parser dropped)
- [x] ~~[fix] `.gitignore` missing credential patterns despite cycle 118 CHANGELOG claim (Audit 9 Security info)~~ · fixed in 627e30c (four credential patterns appended)
- [x] ~~[refactor] `_format_todo_oneline` chained 6+ string transformations on same variable (Audit 9 Complexity warning)~~ · fixed in 8b92b91 (extracted 3 module-level regex constants + 3 helpers; orchestrator now 7 lines; 7 proportional tests added)
- [x] ~~[release-publish-1.20.0] Repoint local v1.20.0 to the final verified commit, fast-forward origin/main, push the tag, and verify both remote refs.~~ · Resolved 2026-04-28 by explicit release authorization; this final artifact commit is the tag target, followed by main/tag push and remote-ref verification.
- [x] ~~[copilot-hook-event-name-validator] Add a small lint rule rejecting Copilot hook event names outside the documented allowlist.~~ · Resolved 2026-04-27 by 73f19dd: validator accepts the six documented events and rejects `stop` or filename-mismatched hooks.
- [x] ~~[opencode-session-events] Replace the SESSION.md bookmark wiring using OpenCode's real `event` mechanism.~~ · Resolved 2026-04-27 by folded 1.20.0 release metadata: OpenCode now handles `session.idle` through generic `event`, writes SESSION.md bookmarks for modified artifacts, rejects direct phantom hook keys, and documents session-start preload as deferred.
- [x] ~~[claude-code-extract-duplicate-source-ids] Per-turn extractor schema mismatch produced 21 duplicate source_id errors and blocked corpus.json writes; analytics counted 0 invocations against live data.~~ · Resolved 2026-04-27 by folding the fix into v1.20.0; per-turn-unique source_ids in all three runtime wrappers, `data.session_id`-based grouping in `scripts/usage_stats.py`, dedupe across subagent JSONL shadows, plus a new Copilot SQLite `session-store.db` extractor. End-to-end: 1302 invocations across 11 skills.
- [x] ~~[live-host-smoke-mjs-doc-row] `.agentera/DOCS.md` Index and README Scripts section omitted a row for `scripts/smoke_opencode_bootstrap.mjs`.~~ · Resolved 2026-04-27 by 1.20.0 release-readiness dokumentera audit; rows added to both surfaces.
- [x] ~~[copilot-marketplace] Deferred: publish or verify a canonical Agentera Copilot marketplace source before documenting `agentera@<marketplace>` as an available install path.~~ · Resolved 2026-04-27 by Cross-Runtime Parity Completion plan; capabilities research verified marketplace install path works (granular `<skill>@agentera` and umbrella `jgabor/agentera`); README updated to document granular as recommended per `copilot-cli#2390`.
- [x] ~~[codex-setup-helper] Optional: ship an idempotent helper that writes the `[shell_environment_policy] set = { AGENTERA_HOME = "<install root>" }` entry to `~/.codex/config.toml`.~~ · fixed by Codex+Copilot Completion PLAN Task 1 (commits f82a776 + eb64a60); `scripts/setup_codex.py` ships in folded 1.20.0 release metadata
- [x] ~~[copilot-setup-helper] Optional: ship an idempotent helper that appends `export AGENTERA_HOME=<install root>` to the user's shell rc.~~ · fixed by Codex+Copilot Completion PLAN Task 2 (commits 058ebc6 + 4ff31d2); `scripts/setup_copilot.py` ships in folded 1.20.0 release metadata with bash/zsh/fish branches and unsupported-shell guidance
- [x] ~~[version] Apply DOCS.md `feat = minor` policy and bump suite metadata from 1.18.1 to 1.19.0 to release the third-party SKILL.md validator entry point added in commit 121e40f.~~ · resolved by Suite Usage Analytics PLAN Task 5; one bump covers commit 121e40f (validator) plus cycles 163-166 (`scripts/usage_stats.py`)
- [x] ~~Task 7: [chore] Plan-level freshness checkpoint~~ · resolved in checkpoint commit; final state records no verified canonical marketplace source and preserves the deferred publication caveat
- [x] ~~[audit-11] Deepen corpus envelope validation for required metadata, family shape, and per-runtime consistency~~ · resolved without commit by explicit user request; Task 6 added required metadata, family status/count, and per-runtime consistency validation
- [x] ~~[audit-11] Add collector fixtures for secondary Copilot and Codex source surfaces~~ · resolved without commit by explicit user request; Task 6 added bounded Copilot instruction/plugin and Codex history/config fixtures
- [x] ~~[audit-11] Split `build_corpus()` before adding another runtime collector~~ · resolved without commit by explicit user request; corpus orchestration now uses a localized runtime collector registry and shared family runner
- [x] ~~[audit-11] Fix OpenCode hook validation path drift after documented manual install~~ · resolved without commit by explicit user request; OpenCode now resolves `~/.agents/agentera` before the legacy skills path
- [x] ~~[audit-11] Validate list-form Copilot hook paths instead of skipping them~~ · resolved without commit by explicit user request; lifecycle validation normalizes one or many hook declarations
- [x] ~~[audit-11] Add OpenCode plugin version marker to DOCS version targets or document it as derived~~ · resolved without commit by explicit user request; DOCS version_files now lists `.opencode/plugins/agentera.js`
- [x] ~~[audit-11] Add supported Copilot profilera capability metadata or narrow the README claim~~ · resolved without commit by explicit user request; Copilot description now exposes bounded profilera metadata limits
- [x] ~~[audit-11] Validate Codex profilera policy across duplicated metadata surfaces~~ · resolved without commit by explicit user request; lifecycle validation now checks aggregate and per-skill Codex metadata
- [x] ~~[audit-11] Align Section 21 record shape with SPEC or update SPEC to bless the `data` envelope~~ · resolved without commit by explicit user request; SPEC, validator, examples, and tests now require top-level provenance plus `data`
- [x] ~~Task 1: [docs] Audit runtime capabilities and refine install docs~~ · resolved without issue ID; no commits produced by explicit user request
- [x] ~~Task 2: [fix] Repair Claude Code and Copilot metadata~~ · resolved without issue ID; no commits produced by explicit user request
- [x] ~~Task 3: [fix] Repair Codex and OpenCode metadata~~ · resolved without issue ID; no commits produced by explicit user request
- [x] ~~Task 4: [feat] Add Copilot session corpus collection~~ · resolved without issue ID; no commits produced by explicit user request
- [x] ~~Task 5: [feat] Add Codex session corpus collection~~ · resolved without issue ID; no commits produced by explicit user request
- [x] ~~Task 6: [test] Integrate profilera status and validation coverage~~ · resolved without issue ID; no commits produced by explicit user request

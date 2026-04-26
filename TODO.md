# TODO

## ⇶ Critical

## ⇉ Degraded

## → Normal

- [ ] [version] Apply DOCS.md `feat = minor` policy and bump suite metadata from 1.18.1 to 1.19.0 to release the third-party SKILL.md validator entry point added in commit 121e40f.
- [ ] [copilot-marketplace] Deferred: publish or verify a canonical Agentera Copilot marketplace source before documenting `agentera@<marketplace>` as an available install path.

## ⇢ Annoying

## Resolved

- [x] ~~Task 7: [chore] Plan-level freshness checkpoint~~ · resolved in checkpoint commit; final state records no verified canonical marketplace source and preserves the deferred publication caveat
- [x] ~~[audit-11] Deferred: Copilot current-checkout plugin smoke is blocked by escaping skills path; installed Copilot skills and Codex `$hej` smoke passed~~ · fixed in Cycle 153; root `plugin.json` loads shared `skills/` through `copilot --plugin-dir`
- [x] ~~[audit-11] Deferred: live Copilot and Codex host behavior remains untested until host smoke tests are available~~ · narrowed by Cycle 152; Codex `$hej` and Copilot installed skills passed, current-checkout Copilot plugin loading remains blocked
- [x] ~~[audit-11] Refresh DOCS Plan index after the completed runtime portability plan~~ · resolved without commit by explicit user request; Task 8 set DOCS and PLAN to one current completed Audit 11 state
- [x] ~~[audit-11] Treat Audit 11 as the resolution marker for stale historical collector-unavailable wording~~ · resolved without commit by explicit user request; Task 8 records collector cleanup complete while keeping live host behavior deferred
- [x] ~~[audit-11] Deepen corpus envelope validation for required metadata, family shape, and per-runtime consistency~~ · resolved without commit by explicit user request; Task 6 added required metadata, family status/count, and per-runtime consistency validation
- [x] ~~[audit-11] Add collector fixtures for secondary Copilot and Codex source surfaces~~ · resolved without commit by explicit user request; Task 6 added bounded Copilot instruction/plugin and Codex history/config fixtures
- [x] ~~Task 2: [feat] Add native Copilot and Codex packaging metadata~~ · resolved without issue ID; Task 2 lacked a dedicated PROGRESS entry, now covered by Cycle 134 rollup
- [x] ~~Task 6: [chore] Bump native runtime support release metadata to 1.17.0~~ · resolved without issue ID; Cycle 133 added missing evidence and preserved marketplace `profilera` at `2.8.0`
- [x] ~~ISS-39: [feat] Implement optimera multi-objective support (Decision 30)~~ · fixed in bd88f63..845a387 (per-objective subdirs under .agentera/optimera/, active-objective inference, SPEC.md/SKILL.md/hooks/DOCS.md updates, version bump 1.12.0)
- [x] ~~ISS-40: [fix] Profile path mismatch after Decision 27~~ · fixed — all SKILL.md, SPEC.md, DOCS.md, DOCS template, README.md, opencode adapter doc, and 12 contract.md files updated to `$PROFILERA_PROFILE_DIR/PROFILE.md` with platform-appropriate defaults; 292 tests pass, validate_spec.py 0 errors
- [x] ~~ISS-38: [feat] Move profile path to XDG-standard agentera data directory (Decision 27)~~ · fixed in 32cd8c7..4870d80 (XDG default with platform detection, auto-migration from ~/.claude/profile/, OpenCode plugin sets PROFILERA_PROFILE_DIR at init)
- [x] ~~ISS-37: [feat] Implement Section 21 session corpus contract (Decision 26)~~ · fixed in 74e539c..277e559 (spec envelope format, multi-runtime corpus builder, self-validation, SKILL.md Steps 1-2 update, 14 new tests, version bump 1.10.0)
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
- [x] ~~[refactor] `hooks/common.py` and `hooks/validate_artifact.py` duplicated DOCS.md path resolution (Audit 9 Coupling info)~~ · fixed in 627e30c (validate_artifact now imports parse_artifact_mapping from common; 30 lines of duplicate parser dropped)
- [x] ~~[fix] `.gitignore` missing credential patterns despite cycle 118 CHANGELOG claim (Audit 9 Security info)~~ · fixed in 627e30c (four credential patterns appended)
- [x] ~~[refactor] `_format_todo_oneline` chained 6+ string transformations on same variable (Audit 9 Complexity warning)~~ · fixed in 8b92b91 (extracted 3 module-level regex constants + 3 helpers; orchestrator now 7 lines; 7 proportional tests added)
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
- [x] ~~Task 7: [chore] Version bump per DOCS.md convention~~ · resolved without issue ID; no commits produced by explicit user request
- [x] ~~Task 8: [chore] Plan-level freshness checkpoint~~ · resolved without issue ID; no commits produced by explicit user request
- [x] ~~Task 1: [docs] Document Copilot/Codex runtime support matrix, lifecycle support, and profilera limitation~~ · resolved without issue ID; freshness checkpoint recorded under Copilot and Codex Native Loading plan
- [x] ~~Task 3: [feat] Add Codex skill presentation safeguards~~ · resolved without issue ID; retry moved safeguards from aggregate metadata to documented per-skill metadata
- [x] ~~Task 4: [feat] Add hook adapter strategy and lifecycle adapter validator~~ · resolved without issue ID; Codex remains limitation-only until host hook parity exists
- [x] ~~Task 5: [test] Add runtime adapter validation coverage~~ · resolved without issue ID; covered by `tests/test_runtime_adapters.py`
- [x] ~~Task 7: [chore] Plan-level freshness checkpoint~~ · resolved without issue ID; no produced commits by explicit user request
- [x] ~~[fix] `ARTIFACT_HEADINGS["PROGRESS.md"]` regex missed `■ ## Cycle` glyph-prefixed format~~ · fixed in 1bf8c18 (regex now accepts optional `■` prefix; added glyph-prefixed structural-validation test case)
- [x] ~~[refactor] analyze_progress.py::analyze() 5-branch suggestion engine~~ · fixed in 1bf8c18 (extracted 5 per-signal helpers + 6 computation helpers; also fixed latent parser regression where header regex missed the current SPEC glyph+middle-dot format)
- [x] ~~ISS-31: [test] Build test suite + CI gating~~ · fixed in 145c637..ab4af08 (240 tests across 12 files; GitHub Actions workflow on push/PR)
- [x] ~~ISS-36: [feat] Realisera and orkestrera reality verification gate (Section 19)~~ · fixed in 1145e6d..4ac09f0 plus plan-level freshness checkpoint
- [x] ~~ISS-35: [fix] Spec-to-skill semantic drift across 12 duplication points~~ · fixed in 2b208f9..7a8f1b0
- [x] ~~ISS-32: [docs] README suite diagram understates inspirera connections~~ · fixed in 70a2fb1
- [x] ~~ISS-30: [docs] Overhaul README to properly represent profilera's role~~ · fixed in 70a2fb1
- [x] ~~ISS-28: [docs] Enforce prose formatting conventions suite-wide (Decisions 18, 19)~~ · fixed in 79b4b0d..7035ece
- [x] ~~ISS-18: [feat] Add unresolved-decision gate to realisera~~ · fixed in 73a5d26
- [x] ~~ISS-17: [feat] Scale inspektera audit depth by change magnitude~~ · fixed in 73a5d26

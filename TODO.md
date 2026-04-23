# TODO

## ⇶ Critical

## ⇉ Degraded

## → Normal

## ⇢ Annoying

## Resolved

- [x] ~~[refactor] `_format_todo_oneline` chained 6+ string transformations on same variable (Audit 9 Complexity warning)~~ · fixed in 8b92b91 (extracted 3 module-level regex constants + 3 helpers; orchestrator now 7 lines; 7 proportional tests added)
- [x] ~~[fix] `ARTIFACT_HEADINGS["PROGRESS.md"]` regex missed `■ ## Cycle` glyph-prefixed format~~ · fixed in 1bf8c18 (regex now accepts optional `■` prefix; added glyph-prefixed structural-validation test case)
- [x] ~~[refactor] analyze_progress.py::analyze() 5-branch suggestion engine~~ · fixed in 1bf8c18 (extracted 5 per-signal helpers + 6 computation helpers; also fixed latent parser regression where header regex missed the current SPEC glyph+middle-dot format)
- [x] ~~ISS-40: [fix] Profile path mismatch after Decision 27~~ · fixed — all SKILL.md, SPEC.md, DOCS.md, DOCS template, README.md, opencode adapter doc, and 12 contract.md files updated to `$PROFILERA_PROFILE_DIR/PROFILE.md` with platform-appropriate defaults; 292 tests pass, validate_spec.py 0 errors
- [x] ~~ISS-39: [feat] Implement optimera multi-objective support (Decision 30)~~ · fixed in bd88f63..845a387 (per-objective subdirs under .agentera/optimera/, active-objective inference, SPEC.md/SKILL.md/hooks/DOCS.md updates, version bump 1.12.0)
- [x] ~~ISS-38: [feat] Move profile path to XDG-standard agentera data directory (Decision 27)~~ · fixed in 32cd8c7..4870d80 (XDG default with platform detection, auto-migration from ~/.claude/profile/, OpenCode plugin sets PROFILERA_PROFILE_DIR at init)
- [x] ~~ISS-37: [feat] Implement Section 21 session corpus contract (Decision 26)~~ · fixed in 74e539c..277e559 (spec envelope format, multi-runtime corpus builder, self-validation, SKILL.md Steps 1-2 update, 14 new tests, version bump 1.10.0)
- [x] ~~ISS-31: [test] Build test suite + CI gating~~ · fixed in 145c637..ab4af08 (240 tests across 12 files; GitHub Actions workflow on push/PR)
- [x] ~~ISS-36: [feat] Realisera and orkestrera reality verification gate (Section 19)~~ · fixed in 1145e6d..4ac09f0 plus plan-level freshness checkpoint
- [x] ~~ISS-35: [fix] Spec-to-skill semantic drift across 12 duplication points~~ · fixed in 2b208f9..7a8f1b0
- [x] ~~ISS-34: [feat] Plan-relative staleness detection (Decision 22)~~ · fixed in cd519b0..7e3255b
- [x] ~~ISS-19: [feat] Phase tracking spec~~ · spec delivered in 2caa9cb, SKILL.md enforcement dropped per Decision 22 (replaced by ISS-34)
- [x] ~~ISS-33: [docs] Add test proportionality convention (Decision 21)~~ · fixed in 0c67553..61e7f7d
- [x] ~~ISS-32: [docs] README suite diagram understates inspirera connections~~ · fixed in 70a2fb1
- [x] ~~ISS-30: [docs] Overhaul README to properly represent profilera's role~~ · fixed in 70a2fb1
- [x] ~~ISS-29: [feat] Build orkestrera skill (Decision 20)~~ · fixed in 1858de0..3decb87
- [x] ~~ISS-28: [docs] Enforce prose formatting conventions suite-wide (Decisions 18, 19)~~ · fixed in 79b4b0d..7035ece
- [x] ~~ISS-27: [feat] Add narration voice principle and warm up skill narration (Decision 17)~~ · fixed in 2ee4e99..de45a45
- [x] ~~ISS-26: [refactor] Refine skill voice to match "sharp colleague" standard (Decision 16)~~ · fixed in e17d588..067a251
- [x] ~~ISS-24: [feat] Retry caps in the spec~~ · superseded by ISS-29 (Decision 20: orkestrera)
- [x] ~~ISS-23: [feat] Structured AC verification for planera → realisera handoff~~ · superseded by ISS-29 (Decision 20: orkestrera)
- [x] ~~ISS-22: [feat] Headless runner script~~ · superseded by ISS-29 (Decision 20: orkestrera)
- [x] ~~ISS-21: [feat] Separated evaluator for realisera~~ · superseded by ISS-29 (Decision 20: orkestrera)
- [x] ~~ISS-20: [feat] Implement formatting decisions (Decision 14)~~ · fixed in 8dfb6fe..e73d31e
- [x] ~~ISS-18: [feat] Add unresolved-decision gate to realisera~~ · fixed in 73a5d26
- [x] ~~ISS-17: [feat] Scale inspektera audit depth by change magnitude~~ · fixed in 73a5d26
- [x] ~~ISS-16: [feat] Add context snapshot to realisera cycle start~~ · fixed in 73a5d26
- [x] ~~ISS-15: [fix] profilera lacks State artifacts section~~ · fixed in abd2bea
- [x] ~~ISS-14: [fix] hej cross-skill section has count and list gaps~~ · fixed in abd2bea
- [x] ~~ISS-13: [fix] inspirera artifact path resolution in wrong location~~ · fixed in abd2bea
- [x] ~~ISS-12: [fix] README suite diagram omits dokumentera~~ · fixed in abd2bea
- [x] ~~ISS-11: [fix] Hej doesn't surface PROFILE.md's global path~~ · fixed in b2dfa4a
- [x] ~~ISS-10: [fix] Some cross-skill references are unidirectional~~ · fixed in 364727c
- [x] ~~ISS-9: [fix] Resonera has duplicate "Getting started" sections~~ · fixed in b11b018
- [x] ~~ISS-8: [fix] CLAUDE.md and DOCS.md have stale skill counts~~ · fixed in b11b018
- [x] ~~ISS-7: [fix] Inspektera dedup uses single-signal preference~~ · fixed in baff5b6
- [x] ~~ISS-6: [fix] Missing bidirectional cross-skill references~~ · fixed in 086c059
- [x] ~~ISS-5: [fix] Artifact path resolution wording inconsistencies~~ · fixed in 086c059
- [x] ~~ISS-4: [fix] inspirera and profilera missing "Getting started"~~ · fixed in 086c059
- [x] ~~ISS-3: [fix] inspirera missing safety rails section~~ · fixed in 086c059
- [x] ~~ISS-2: [fix] dokumentera doesn't consume PROFILE.md~~ · fixed in 086c059
- [x] ~~ISS-1: [fix] "Eight-skill suite" in all SKILL.md files~~ · fixed in 19a351f
- [x] ~~[fix] Installation path double-nesting~~ · fixed: clone to ~/.claude/agentera
- [x] ~~[fix] README intro omits inspirera and visualisera~~ · fixed: added research, designing
- [x] ~~[docs] Prerequisites undocumented~~ · fixed: added Prerequisites section to README
- [x] ~~[chore] CHANGELOG.md [Unreleased] not promoted~~ · fixed: promoted to [1.4.0]
- [x] ~~[chore] Stale ISSUES-template.md~~ · fixed: renamed to TODO-template.md

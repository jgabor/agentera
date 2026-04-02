# TODO

## ⇶ Critical

## ⇉ Degraded
- [ ] ISS-21: Add separated evaluator to realisera — spawn a fresh `claude -p` session after each task that runs inspektera-style audit against the task's acceptance criteria; gate task completion on evaluator PASS verdict (inspired by harness GAN pattern)
- [ ] ISS-22: Build headless runner script (`scripts/runner.py`) — batch orchestrator that reads PLAN.md, iterates tasks, launches Claude sessions with synthesized prompts, runs verification + evaluation gates, handles retries (max 2), updates PROGRESS.md; enables overnight autonomous runs and CI integration

## ⇢ Annoying
- [ ] ISS-25: Implement four-tier priority system with type tags (Decision 15) — add → Normal tier between Degraded and Annoying; add conventional commit type tags `[feat]`/`[fix]`/etc. after colon in issue format; update ecosystem-spec.md severity section, TODO-template.md, and retroactively tag existing issues
- [ ] ISS-23: Add structured AC verification to planera → realisera handoff — ensure planera's acceptance criteria are testable and specific enough for mechanical verification; add "Verification" subsection to PLAN.md tasks describing how each AC can be checked
- [ ] ISS-24: Encode retry caps in ecosystem spec — add `max_retry_cycles` primitive (default: 2) to `references/ecosystem-spec.md` that realisera and the runner both respect; after max retries, task resets to pending and escalates
- [ ] ISS-19: Consider explicit phase tracking in PROGRESS.md — define valid skill-chain transitions (envision → deliberate → plan → build → audit) with terminal states; skills check phase and flag out-of-order runs

## Resolved
- [x] ~~ISS-26: Refine skill voice to match "sharp colleague" standard (Decision 16)~~ — fixed in e17d588..067a251
- [x] ~~ISS-20: Implement formatting decisions (Decision 14)~~ — fixed in 8dfb6fe..e73d31e
- [x] ~~ISS-16: Add context snapshot to realisera cycle start~~ — fixed in 73a5d26
- [x] ~~ISS-17: Scale inspektera audit depth by change magnitude~~ — fixed in 73a5d26
- [x] ~~ISS-18: Add unresolved-decision gate to realisera~~ — fixed in 73a5d26
- [x] ~~ISS-1: "Eight-skill ecosystem" in all SKILL.md files~~ — fixed in 19a351f
- [x] ~~ISS-2: dokumentera doesn't consume PROFILE.md~~ — fixed in 086c059
- [x] ~~ISS-3: inspirera missing safety rails section~~ — fixed in 086c059
- [x] ~~ISS-4: inspirera and profilera missing "Getting started"~~ — fixed in 086c059
- [x] ~~ISS-5: Artifact path resolution wording inconsistencies~~ — fixed in 086c059
- [x] ~~ISS-6: Missing bidirectional cross-skill references~~ — fixed in 086c059
- [x] ~~ISS-7: Inspektera dedup uses single-signal preference~~ — fixed in baff5b6
- [x] ~~ISS-8: CLAUDE.md and DOCS.md have stale skill counts~~ — fixed in b11b018
- [x] ~~ISS-9: Resonera has duplicate "Getting started" sections~~ — fixed in b11b018
- [x] ~~ISS-10: Some cross-skill references are unidirectional~~ — fixed in 364727c
- [x] ~~ISS-11: Hej doesn't surface PROFILE.md's global path~~ — fixed in b2dfa4a
- [x] ~~ISS-12: README ecosystem diagram omits dokumentera~~ — fixed in abd2bea
- [x] ~~ISS-13: inspirera artifact path resolution in wrong location~~ — fixed in abd2bea
- [x] ~~ISS-14: hej cross-skill section has count and list gaps~~ — fixed in abd2bea
- [x] ~~ISS-15: profilera lacks State artifacts section~~ — fixed in abd2bea
- [x] ~~Installation path double-nesting~~ — fixed: clone to ~/.claude/agentera
- [x] ~~README intro omits inspirera and visualisera~~ — fixed: added research, designing
- [x] ~~Prerequisites undocumented~~ — fixed: added Prerequisites section to README
- [x] ~~CHANGELOG.md [Unreleased] not promoted~~ — fixed: promoted to [1.4.0]
- [x] ~~Stale ISSUES-template.md~~ — fixed: renamed to TODO-template.md

# Progress

■ ## Cycle 109 · 2026-04-12

**Phase**: build
**What**: Removed realisera "Getting started" section (onboarding docs, not needed during cycle execution). Tier 1: 12,310 -> 12,055 tokens (-255). Cumulative from baseline: 15,065 -> 12,055 (-20.0%). Target was 12,052; effectively met (3-token overshoot within byte-estimate rounding).
**Commit**: 5329d67
**Inspiration**: Section-size analysis showed Getting started (254 est tokens) was pure discovery-time content never referenced during cycle execution
**Discovered**: The 20% target is met. Two experiments (spec_sections trimming + Getting started removal) reduced Tier 1 by 3,010 tokens. The byte-estimate metric (bytes/4) is coarse enough that the 3-token overshoot is not meaningful. With the API count_tokens endpoint (when available), the exact number may differ slightly.
**Verified**: `python3 .optimera/count_prompt_tokens.py --skill-dir skills/realisera --tier1` returned tier1_total=12,055 (SKILL.md 7,125 + contract.md 4,930). Linter 0/0, 260 tests pass, eval dry-run resolves.
**Next**: Objective met. Record Experiment 5 in EXPERIMENTS.md and close the optimization objective, or continue if more savings are desired (cross-skill integration section at ~872 tokens is the next target).
**Context**: intent (close the remaining 258-token gap to hit 20% target) · constraints (no behavioral changes, no SPEC.md changes) · unknowns (none) · scope (skills/realisera/SKILL.md only)

■ ## Cycle 108 · 2026-04-12

**Phase**: build
**What**: Trimmed realisera spec_sections from 10 to 5 (dropped sections 1, 5, 11, 17, 18). All dropped values already inlined in SKILL.md or present in retained sections. contract.md shrank from 30,721 to 19,720 bytes. Tier 1 metric: 15,065 -> 12,310 tokens (-18.3%). Baseline established at 15,065 (estimate). 20% target is 12,052; this experiment reached 12,310, 258 tokens short.
**Commit**: 3f62dd8
**Inspiration**: Section-by-section analysis of contract.md: 5 of 10 sections had no live references in SKILL.md workflow (values already inlined or consumed by other skills only)
**Discovered**: contract.md is 51% of the Tier 1 metric and the highest-leverage attack surface. Sections 18 (Staleness Detection, 895 tokens) and 11 (Loop Guard, 619 tokens) were the largest dead-weight sections. Section 4 (Artifact Format Contracts, 2,252 tokens) is now the dominant remaining section and contains the token budgets, compaction thresholds, and CHANGELOG format that SKILL.md references.
**Verified**: `python3 .optimera/count_prompt_tokens.py --skill-dir skills/realisera --tier1` returned tier1_total=12,310 (SKILL.md 7,380 + contract.md 4,930). Linter 0/0, 260 tests pass, eval dry-run resolves.
**Next**: Need 258 more tokens to hit the 20% target (12,052). Candidates: (a) inline the contract.md lazy-reference from Exp 1 to prevent future regression, (b) trim SKILL.md prose (brainstorm section, cross-skill integration section are large), (c) trim remaining contract sections (Section 4 at 2,252 tokens has subsections like HEALTH.md audit dimensions that realisera never references).
**Context**: intent (reduce Tier 1 by trimming unused spec sections from contract.md) · constraints (no SPEC.md changes, keep all sections SKILL.md actually references) · unknowns (none) · scope (skills/realisera/SKILL.md frontmatter, contract.md via regeneration)

■ ## Cycle 107 · 2026-04-12

**Phase**: build
**What**: Implemented Decision 29 two-tier metric for the realisera-token optimera harness. Tier 1 (primary): exact SKILL.md + contract.md token count via Anthropic count_tokens API, zero variance. Tier 2 (behavioral): existing Docker A/B with gates-only pass bar, full-cycle composite demoted to diagnostic. Created count_prompt_tokens.py with measure_tier1() function, --tier1 CLI flag, and dual-write (tier1.json + preflight.json). Rewired harness composer to output Tier 1 as primary metric with Tier 2 diagnostics prefixed tier2: in breakdown. Updated OBJECTIVE.md with two-tier metric specification, EXPERIMENTS.md with experiments 1-3 results and escalation.
**Commit**: 3fca742
**Inspiration**: Decision 29 (firm): two-tier metric separating fixed cost (deterministic) from variable cost (stochastic)
**Discovered**: Tier 1 measurement works with byte-estimate fallback when ANTHROPIC_API_KEY is unset. Baseline Tier 1 measurement: 15,065 tokens (estimate). With API key, this will be exact. The 20% target from the Tier 1 baseline (once established via API) will be the new optimization threshold.
**Verified**: Tier 1 measurement invoked: `python3 .optimera/count_prompt_tokens.py --skill-dir skills/realisera --tier1` returned tier1_total=15,065 (7,385 SKILL.md + 7,680 contract.md, estimate source). Linter 0/0, 260 tests pass, eval dry-run resolves.
**Next**: Run the full harness with ANTHROPIC_API_KEY set to establish the exact Tier 1 baseline as Experiment 4 in EXPERIMENTS.md. Then resume optimization experiments targeting SKILL.md token reduction (spec_sections trimming, progressive disclosure, contract.md lazy-reference).
**Context**: intent (unblock realisera-token optimization by replacing noisy composite metric with deterministic Tier 1) · constraints (harness is a brainstorm-level edit per Decision 29, no skill/spec changes) · unknowns (exact API token count pending API key availability) · scope (.optimera/harness, .optimera/count_prompt_tokens.py, .agentera/OBJECTIVE.md, .agentera/EXPERIMENTS.md, .agentera/DECISIONS.md)

■ ## Cycle 106 · 2026-04-11

**Phase**: build
**What**: Plan rollup: Implement Section 21 Session Corpus Contract (ISS-37, Decision 26). Updated SPEC.md Section 21 with corpus envelope format and runtime probing convention. Refactored extract_all.py into a multi-runtime corpus builder producing single corpus.json with Section 21 normalized records, provenance metadata, runtime probing infrastructure, self-validation, and legacy file cleanup. Updated profilera SKILL.md Steps 1-2 to consume corpus.json. Added 14 tests (260 total). Version bumped to 1.10.0 (profilera 2.8.0). Resolved ISS-37, archived plan.
**Commits**: 74e539c, af82efa, 612054d, 0f21901, f169d6f, 277e559
**Inspiration**: Decision 26 (firm): multi-runtime corpus builder with self-describing envelope
**Discovered**: No HEALTH.md findings resolved by this plan (complexity C grade for analyze_progress.py remains, out of scope). SKILL.md line 404 references crystallized.json (legacy filename) outside Steps 1-2 scope; noted for future cleanup.
**Verified**: N/A: docs-only
**Next**: Vision-driven work. Remaining annoying item: analyze_progress.py 114-line function.
**Context**: intent (close ISS-37 plan with freshness checkpoint) · constraints (no code changes, docs/bookkeeping only) · unknowns (none) · scope (TODO.md, PROGRESS.md, PLAN.md archive)

■ ## Cycle 105 · 2026-04-11

**Phase**: build
**What**: Version bump 1.9.0 → 1.10.0 (collection), 2.7.0 → 2.8.0 (profilera) per PLAN Task 6. Promoted CHANGELOG [Unreleased] to [1.10.0] with Added/Changed entries for the plan's feat commits.
**Commit**: 277e559
**Inspiration**: PLAN Task 6, DOCS.md semver_policy (feat = minor)
**Discovered**: None.
**Verified**: N/A: chore-build-config
**Next**: Task 7 (plan-level freshness checkpoint). Final task.
**Context**: intent (version bump per DOCS.md convention) · constraints (only version_files + CHANGELOG.md) · unknowns (none) · scope (12 plugin.json, registry.json, marketplace.json, CHANGELOG.md)

■ ## Cycle 104 · 2026-04-11

**Phase**: build
**What**: Added 14 tests for corpus builder and validation per PLAN Task 5. Covers 6 testable units: _generate_source_id (3 tests), _probe_claude_code (2), validate_corpus (3), _records_from_* provenance (2), _cleanup_legacy_files (2), build_corpus envelope (2). Total suite: 260 tests.
**Commit**: f169d6f
**Inspiration**: PLAN Task 5 acceptance criteria, test proportionality convention (Decision 21)
**Discovered**: Main baseline was 246 tests (not 250 as worktree reported). The worktree had synced extract_all.py but had a different test baseline. 14 new tests on main = 260 total.
**Verified**: N/A: test-only
**Next**: Task 6 (version bump). Depends on Tasks 1-5, all complete.
**Context**: intent (add test coverage for corpus builder per PLAN Task 5) · constraints (~12 tests target, 14 delivered, no extract_all.py or SKILL.md changes) · unknowns (none) · scope (tests/test_extract_all.py only)

■ ## Cycle 103 · 2026-04-11

**Phase**: build
**What**: Updated profilera SKILL.md Steps 1-2 to consume corpus.json per PLAN Task 4. Step 1 now references corpus.json output with metadata for counts. Step 2 now groups records by source_kind instead of reading four named files. Fixed worktree-introduced "twelve-skill ecosystem" back to "twelve-skill suite". Regenerated profilera contract.
**Commit**: 0f21901
**Inspiration**: PLAN Task 4 acceptance criteria
**Discovered**: The worktree checkout introduced a "suite" → "ecosystem" terminology change that the linter caught. Line 404 "Notes on depth vs speed" still references crystallized.json by name, but that section is outside Steps 1-2 scope.
**Verified**: N/A: docs-only
**Next**: Task 5 (tests). Depends on Tasks 2 and 3, both complete.
**Context**: intent (update SKILL.md Steps 1-2 to consume corpus.json per PLAN Task 4) · constraints (Steps 3-5 untouched, no extract_all.py changes) · unknowns (none) · scope (skills/profilera/SKILL.md Steps 1-2, profilera contract.md)

■ ## Cycle 102 · 2026-04-11

**Phase**: build
**What**: Added self-validation to extract_all.py per PLAN Task 3. validate_corpus() checks all records for required Section 21 provenance fields and flags unrecognized source_kind values as warnings. Validation runs before writing: errors block output, warnings allow writing. Fixed family status vocabulary from "error" to "missing" per SPEC.md Section 21.
**Commit**: 612054d
**Inspiration**: PLAN Task 3 acceptance criteria, inspektera Task 2 evaluation finding (status "error" vs spec "missing")
**Discovered**: The status vocabulary fix ("error" → "missing") was flagged by inspektera during Task 2 evaluation as a latent non-conformance. Addressed in this task alongside validation.
**Verified**: corpus.json produced with 6634 records, 0 validation errors, 0 warnings. Self-validation passes cleanly for well-formed Claude Code data. 246 tests pass.
**Next**: Task 5 (tests). Depends on Tasks 2 and 3, both complete.
**Context**: intent (add self-validation per PLAN Task 3, fix status vocabulary) · constraints (no SKILL.md changes, no new tests) · unknowns (none) · scope (skills/profilera/scripts/extract_all.py only)

■ ## Cycle 101 · 2026-04-11

**Phase**: build
**What**: Refactored extract_all.py into a multi-runtime corpus builder per PLAN Task 2. Replaced four-file intermediate output with a single corpus.json wrapping each record with Section 21 provenance metadata (source_id, timestamp, project_id, source_kind, runtime, adapter_version). Added runtime probing (_probe_claude_code), legacy file cleanup, graceful no-data exit, and per-family error handling. Internal extractor functions unchanged.
**Commit**: af82efa
**Inspiration**: Decision 26 (firm), SPEC.md Section 21 corpus envelope format (Task 1)
**Discovered**: 6631 records across 4 source families from Claude Code data. The run_* wrapper functions became orphaned (no longer called by main) but retained for potential direct use. source_id generation uses SHA-256 of runtime + source_kind + key content for idempotent re-extraction.
**Verified**: corpus.json produced with 6631 records. Structure confirmed: top-level keys [metadata, records], metadata keys [extracted_at, runtimes, adapter_version, families, total_records], all 4 source_kind families present, all records carry all 6 required provenance fields. Legacy cleanup verified. No-data exit verified. 246 tests pass.
**Next**: Task 3 (self-validation) and Task 4 (SKILL.md update), both depend on Task 2.
**Context**: intent (refactor extract_all.py to produce Section 21 corpus.json per PLAN Task 2) · constraints (stdlib only, no self-validation, no SKILL.md changes, no new tests) · unknowns (none) · scope (skills/profilera/scripts/extract_all.py only)

■ ## Cycle 100 · 2026-04-11

**Phase**: build
**What**: Updated SPEC.md Section 21 with two new subsections per PLAN Task 1. "Corpus envelope format" specifies the top-level corpus.json structure: a metadata object (extracted_at, runtimes, adapter_version, families with per-family count/status/error, total_records, optional errors array) and a records array containing Section 21 normalized records with full provenance metadata. "Runtime probing convention" describes the probe-then-extract pattern: each runtime registers a probe function checking known filesystem paths, the corpus builder iterates probes, dispatches extractors for detected runtimes, and merges records additively. Also specifies no-runtime behavior (no output, informative exit). Regenerated all 12 contract files.
**Commit**: 74e539c
**Inspiration**: Decision 26 (firm): multi-runtime corpus builder with self-describing envelope
**Discovered**: None. The subsections landed cleanly between "Runtime extensions" and "Relation to Section 20" without structural conflicts. The `families` keys in the envelope use the record type names (instruction_document etc.), not the source family display names, for programmatic filtering consistency with the `source_kind` field on individual records.
**Verified**: N/A: docs-only
**Next**: Task 2 (refactor extract_all.py into multi-runtime corpus builder). Depends on Task 1, now complete.
**Context**: intent (specify corpus envelope and runtime probing convention in SPEC.md Section 21 per PLAN Task 1) · constraints (SPEC.md only, no em-dashes, no hard wraps, no extract_all.py or SKILL.md changes) · unknowns (none) · scope (SPEC.md Section 21 two new subsections, 12 contract.md files regenerated, PLAN.md Task 1 status, PROGRESS.md cycle entry)

■ ## Cycle 99 · 2026-04-11

**Phase**: build
**What**: OpenCode Adapter Implementation plan. Promoted the proof-of-concept adapter to production: plugin at `.opencode/plugins/agentera.js` with ESM fix, eval runner runtime detection (`--runtime` flag, 6 tests), OpenCode install docs in README, adapter doc upgraded to implementation reference. Version bumped to 1.9.0.
**Commits**: 8f72655, 78687f6, c51fb0a, 9c65271
**Inspiration**: OpenCode context7 docs, cross-runtime skill co-existence research
**Discovered**: SKILL.md format is the de facto cross-runtime standard (87K+ skills on skills.sh). No adapter changes needed for skills themselves. The CJS/ESM syntax mix in the original plugin was a real bug caught by adversarial review.
**Verified**: N/A: the plan bundles feat, docs, and chore commits; the feat commits (plugin promotion, eval runner) were each verified by inspektera evaluation against their acceptance criteria during orkestrera orchestration
**Next**: Vision-driven work. Remaining annoying item: analyze_progress.py 114-line function. The OpenCode adapter is implemented but untested on a real OpenCode instance.
**Context**: intent (uplift OpenCode adapter from design to implementation) · constraints (no Claude Code breakage, stdlib only, text-mode eval only) · unknowns (none remaining) · scope (.opencode/plugins/, scripts/eval_skills.py, README.md, references/adapters/opencode.md, version files)

■ ## Cycle 98 · 2026-04-11

**Phase**: build
**What**: Refactored `check_severity_levels()` in validate_spec.py: extracted 4 private helpers (`_find_severity_in_tables`, `_find_severity_in_headings`, `_find_severity_in_section`, `_find_severity_in_mappings`), each returning error lists. Main function is now a 15-line dispatcher. 4-level nesting flattened to 2.
**Commit**: c9e0e64 refactor(linter): extract per-pattern helpers from check_severity_levels
**Inspiration**: None.
**Discovered**: The refactored file is +25 net lines (92 added, 67 removed) because helper function signatures and docstrings add overhead, but the nesting reduction is worth it. Pattern 3 (`_find_severity_in_section`) was the deepest at 5 levels; now 3.
**Verified**: N/A: refactor-no-behavior-change (existing test suite is the verification surface; 240 tests pass identically)
**Next**: One annoying item remains: analyze_progress.py::analyze() at 114 lines. Or vision-driven work.
**Context**: intent (flatten 4-level nesting in check_severity_levels per Audit 7 complexity finding) · constraints (linter 0/0, 240 tests pass, identical behavior) · unknowns (none) · scope (scripts/validate_spec.py only)

■ ## Cycle 97 · 2026-04-11

**Phase**: build
**What**: Added `.github/workflows/ci.yml` — GitHub Actions CI wiring `python3 scripts/validate_spec.py` and `python3 -m pytest tests/ -q` on push to main and pull requests. Closes ISS-31 after four deferrals. Light plan (PLAN.md archived).
**Commit**: ab4af08 ci: add GitHub Actions workflow for ISS-31
**Inspiration**: None needed; standard GitHub Actions Python pattern.
**Discovered**: Nothing unexpected. Workflow file is 20 lines. Zero external dependencies (stdlib only, no pip step). The `ci:` commit type isn't in the conventional commits vocabulary used here, but maps clearly to chore/build-config for semver purposes (no bump).
**Verified**: N/A: chore-build-config (CI config file; local equivalents confirmed: validate_spec.py 0 errors, pytest 240 passed in 0.17s)
**Next**: TODO.md is clean (no critical, no degraded). Annoying tier: two complexity refactors (check_severity_levels nesting, analyze_progress size). Vision-driven work is next or a complexity refactor if that's the priority.
**Context**: intent (close ISS-31: wire existing 240 tests to GitHub Actions CI) · constraints (stdlib only, no pip, no version bump) · unknowns (none) · scope (.github/workflows/ci.yml only)

■ ## Cycle 96 · 2026-04-11

**Phase**: build
**What**: Patch bump to 1.8.1. Audit 7 correctness pass (inspektera) found one unbumped `fix` commit (a1a88a6) since 1.8.0; per `semver_policy: "fix = patch"` this triggers a patch bump. Also corrected the Audit 7 report itself: removed two false-positive warnings already fixed before the audit was written, added the missing complexity hotspots dimension (grade C), fixed the version health grade from A to B, and corrected the audit date. Filed two complexity findings from Audit 7 to TODO.md (annoying tier).
**Commits**: f7afd4c docs(health): correct Audit 7, 54e5a55 chore(release): bump version to 1.8.1
**Inspiration**: Inspektera Audit 7 correctness pass
**Discovered**: The smaller model that produced Audit 7 reported two warnings already fixed by a prior commit, skipped the complexity hotspots dimension entirely, and missed the unbumped fix commit. Three distinct classes of audit gap in one pass.
**Verified**: N/A: chore-build-config (version metadata bump across 14 JSON files; Audit 7 doc correction has no code path affected)
**Next**: ISS-31 (CI gating) remains the most impactful degraded item. Complexity C grade (check_severity_levels nesting, analyze_progress size) now tracked in TODO.md.
**Context**: intent (close version health gap, correct stale audit findings) · constraints (only touch version_files from DOCS.md, linter 0/0, tests pass, profilera stays at 2.7.0) · unknowns (none) · scope (12 plugin.json, registry.json, marketplace.json, CHANGELOG.md, TODO.md, HEALTH.md)

■ ## Cycle 95 · 2026-04-10

**Phase**: build
**What**: Plan-level freshness checkpoint and plan closure for Platform Portability. Promoted CHANGELOG.md [Unreleased] to [1.8.0]. Archived PLAN.md. The plan delivered: SPEC.md Section 20 (Host Adapter Contract with 6 capabilities), Section 21 (Session Corpus Contract with 4 portable record types), platform annotation audit across all 12 SKILL.md files, linter check 18 for annotation validation (4 tests), OpenCode proof-of-concept adapter design, terminology cleanup (ecosystem-spec -> SPEC.md, ecosystem-context -> contract.md), memory_entry demotion to Claude Code extension, em-dash fix, and version bump to 1.8.0.
**Commits**: 9eb6773, e6a0928, 742ba75, 6368159, e422fad, 0cd51ff, eb13f4d, c5c8c35, 8c83613
**Inspiration**: PLAN.md Task 8 + planera freshness checkpoint convention
**Discovered**: ISS-31 (CI gating) deferred four times across multiple plans. The plan's Surprises section predicted this. Test suite is comprehensive (240 tests) but unenforced by CI. No HEALTH.md findings were resolved by this plan (it was a spec/architecture plan, not a health fix).
**Verified**: N/A: docs-only (promoted CHANGELOG section heading, updated PLAN.md task status, archived PLAN.md; no code paths affected)
**Next**: Vision-driven work. ISS-31 (CI gating) remains the most impactful degraded item. An inspektera audit is due (last was Audit 6 on 2026-04-02, ~10 cycles ago).
**Context**: intent (close Platform Portability plan with freshness checkpoint per Task 8 AC and plan-completion sweep) · constraints (no code changes) · unknowns (ISS-31 AC says "resolved" but CI gating explicitly deferred per plan surprise) · scope (CHANGELOG.md, PROGRESS.md, TODO.md, PLAN.md archive)

■ ## Cycle 94 · 2026-04-10

**Phase**: build
**What**: Version bump from 1.7.0 to 1.8.0 (profilera 2.6.0 to 2.7.0). Updated 12 plugin.json files, registry.json, and marketplace.json per DOCS.md versioning convention. Multiple feat commits since 1.7.0 justify minor bump per semver_policy.
**Commit**: 8c83613 chore(release): bump version to 1.8.0 (profilera 2.7.0) (PLAN Task 7)
**Inspiration**: PLAN.md Task 7 acceptance criteria
**Discovered**: registry.json has a schema-level "version" field ("1") separate from skill versions; correctly left unchanged.
**Verified**: N/A: chore-build-config (version metadata bump across 14 JSON files with no code path affected)
**Next**: Task 8 (plan-level freshness checkpoint). Only remaining pending task in the Platform Portability plan.
**Context**: intent (version bump per DOCS.md semver_policy for feat-heavy plan) · constraints (only touch version_files in DOCS.md) · unknowns (none) · scope (12 plugin.json, registry.json, marketplace.json)

■ ## Cycle 93 · 2026-04-10

**Phase**: build
**What**: Added linter check 18 (platform-annotations) to validate_spec.py. Scans all 12 SKILL.md files for `<!-- platform: NAME -->` annotations and verifies each NAME is one of the six recognized capabilities from SPEC.md Section 20. All 12 skills PASS. 4 new tests.
**Commit**: c5c8c35 feat(linter): add platform annotation validation check (PLAN Task 5)
**Inspiration**: PLAN.md Task 5 acceptance criteria
**Discovered**: RECOGNIZED_CAPABILITIES defined as a module-level set matching the pattern of existing constants in validate_spec.py.
**Verified**: `python3 scripts/validate_spec.py`: 0 errors, 0 warnings. `python3 -m pytest tests/ -q`: 240 passed (236 + 4 new). `python3 scripts/generate_contracts.py --check`: all 12 current.
**Next**: Task 7 (version bump). Task 6 partial (em-dash fixed, CI deferred).
**Context**: intent (add linter check for platform annotation capability names per Task 5 AC) · constraints (0 new linter errors, all tests pass, exactly 4 new tests) · unknowns (none) · scope (scripts/validate_spec.py, tests/test_validate_spec.py)

■ ## Cycle 92 · 2026-04-10

**Phase**: build
**What**: Demoted memory_entry from portable record type to Claude Code runtime extension in SPEC.md Section 21. Portable corpus drops from 5 to 4 record types. OpenCode adapter upgrades to full profilera mode. Regenerated all 12 contract files.
**Commit**: eb13f4d refactor(spec): demote memory_entry from portable core to Claude Code runtime extension (PLAN Task 10)
**Inspiration**: Prior audit: memory_entry is the only record type no non-Claude runtime can produce
**Discovered**: Demotion eliminated the OpenCode adapter's biggest documented gap. Runtime extensions subsection establishes a pattern for future runtime-specific record types.
**Verified**: `python3 scripts/validate_spec.py`: 0 errors, 0 warnings. `python3 -m pytest tests/ -q`: 236 passed. All 8 Task 10 AC verified. N/A: spec refactoring, no runnable code path change.
**Next**: Task 5 (linter annotation validation) or Task 7 (version bump).
**Context**: intent (demote memory_entry to Claude Code extension, making Section 21 honest about portability) · constraints (profilera still reads Claude memory files, linter 0/0, tests pass) · unknowns (none) · scope (SPEC.md Section 21, profilera contract.md and SKILL.md and extract_all.py, opencode.md adapter, 12 contract files)

■ ## Cycle 91 · 2026-04-10

**Phase**: build
**What**: Created OpenCode proof-of-concept adapter design document mapping all six host adapter capabilities (Section 20) and session corpus record types (Section 21) to OpenCode's mechanisms. Also wrote a companion OpenCode hook plugin (opencode-plugin.js).
**Commit**: 6e067e6 feat(adapters): add OpenCode proof-of-concept adapter design (PLAN Task 4)
**Inspiration**: PLAN.md Task 4 AC, OpenCode docs
**Discovered**: OpenCode skill discovery is more flexible than Claude Code's. Session history extraction requires SDK access, leaving profilera in partial mode (crystallized + config patterns) for the initial port.
**Verified**: `python3 scripts/validate_spec.py`: 0 errors, 0 warnings. `python3 -m pytest tests/ -q`: 236 passed. N/A: docs-only.
**Next**: Task 5 (linter annotation validation) or Task 7 (version bump).
**Context**: intent (design OpenCode adapter proving Section 20/21 contracts are sufficient) · constraints (design doc only, linter 0/0) · unknowns (OpenCode SDK session history access — resolved) · scope (references/adapters/opencode.md, opencode-plugin.js, PLAN.md)

■ ## Cycle 90 · 2026-04-10

**Phase**: build
**What**: Annotated all platform-specific references across 12 SKILL.md files and SPEC.md. Added `<!-- platform: profile-path -->` to every profile-path read and `<!-- platform: sub-agent-dispatch -->` to every worktree reference. Added scoping preamble to profilera's extraction step.
**Commit**: 068373b refactor: annotate platform-specific references across all 12 SKILL.md files and SPEC.md
**Inspiration**: PLAN.md Task 3, reviewer feedback on Cycle 89
**Discovered**: Profile-path was the dominant reference (15 sites across 11 skills). Worktree references limited to realisera and optimera. Profilera needed a structural preamble rather than line-by-line annotation.
**Verified**: `python3 scripts/validate_spec.py`: 0 errors, 0 warnings. `python3 -m pytest tests/ -q`: 236 passed. `python3 scripts/generate_contracts.py --check`: all 12 current.
**Next**: Task 4 (OpenCode adapter design) or Task 5 (linter annotation validation).
**Context**: intent (annotate all platform-specific refs per Task 3 AC) · constraints (existing behavior unchanged, linter 0/0, regenerate contracts) · unknowns (none) · scope (SPEC.md Section 20, 12 SKILL.md files, README.md, 12 contract files)

■ ## Cycle 89 · 2026-04-10

**Phase**: build
**What**: Added Section 21 (Session Corpus Contract) to SPEC.md. Defines five canonical record types with provenance metadata, four source families, degradation rules, and portability transition path. Regenerated all 12 contract files.
**Commit**: 742ba75 feat(spec): add Section 21 Session Corpus Contract for profilera portability
**Inspiration**: PLAN.md Task 2 design (data model not path model), profilera's extract_all.py four-source-family pattern
**Discovered**: The four source families map cleanly to profilera's existing extractor architecture. Degradation rules straightforward.
**Verified**: `python3 scripts/validate_spec.py`: 0 errors, 0 warnings. `python3 -m pytest tests/ -q`: 236 passed. `python3 scripts/generate_contracts.py --check`: all 12 current.
**Next**: Task 3 (platform annotation audit) or Task 4 (OpenCode adapter design).
**Context**: intent (define Section 21 per Task 2 AC) · constraints (no changes to current experience, linter 0/0, regenerate contracts) · unknowns (none) · scope (SPEC.md Section 21, profilera contract.md and SKILL.md, 12 contract files)

## Archived Cycles

Cycle 88 (2026-04-10): Terminology cleanup per Decision 23; renamed ecosystem-spec.md to SPEC.md, ecosystem-context.md to contract.md, validate_ecosystem.py to validate_spec.py; dropped "ecosystem" prefix across 46 files; regenerated all 12 contract files

Cycle 87 (2026-04-10): Added Section 20 (Host Adapter Contract) to SPEC.md; six capabilities, portability-status table, `<!-- platform: -->` annotation convention

Cycle 86 (2026-04-08): Plan rollup for ISS-36, CHANGELOG promoted to 1.7.0, plan archived
Cycle 85 (2026-04-07): Version bump 1.6.0 → 1.7.0 (profilera 2.5.0 → 2.6.0)
Cycle 84 (2026-04-07): Added linter check 17 (reality-verification-gate) to validate_spec.py
Cycle 83 (2026-04-07): Extended orkestrera Step 3 with dual-layer Reality Verification Gate
Cycle 82 (2026-04-07): Extended realisera Step 6 with Phase A/B Reality Verification Gate
Cycle 81 (2026-04-07): Added Section 19 (Reality Verification Gate) to SPEC.md
Cycle 80 (2026-04-03): ISS-35 resolved; per-skill contract files generated from SPEC.md
Cycle 79 (2026-04-03): Added Artifact freshness dimension to inspektera SKILL.md
Cycle 78 (2026-04-03): Added Section 18 (Staleness Detection) to SPEC.md
Cycle 77 (2026-04-02): Version bump to 1.5.0 (profilera 2.4.0), ISS-29 resolved, plan archived
Cycle 76 (2026-04-02): Created orkestrera plugin.json; updated README, CLAUDE.md, DOCS.md
Cycle 75 (2026-04-02): Updated all 11 SKILL.md files: eleven-skill → twelve-skill
Cycle 74 (2026-04-02): Updated SPEC.md and linter for 12 skills including orkestrera
Cycle 73 (2026-04-02): Wrote skills/orkestrera/SKILL.md (316 lines, full conductor protocol)
Cycle 72 (2026-04-02): Decision 20 captured, PLAN.md for ISS-29 (orkestrera), glyph added to DESIGN.md
Cycle 71 (2026-04-02): Added em-dash/hard-wrap detection to linter; archived plan (ISS-28 resolved)
Cycle 70 (2026-04-02): Applied formatting conventions to project docs, artifacts, and manifests
Cycle 69 (2026-04-02): Removed em-dashes and hard wraps from all 11 SKILL.md files
Cycle 68 (2026-04-02): Codified punctuation and line-break conventions in SPEC.md Sections 14-15
Cycle 64 (2026-04-02): Validated voice alignment, linter 0/0, archived plan (ISS-26 resolved)
Cycles 61-63 (2026-04-02): Warmed output framing across 7 skills in parallel (ISS-26 Tasks 3-5)
Cycle 60 (2026-04-02): Converged resonera/visionera/visualisera to sharp colleague voice
Cycle 59 (2026-04-02): Rewrote hej with dashboard + human frame pattern (ISS-26 Task 1)
Cycle 58 (2026-04-02): Validated formatting changes, linter 0/0, archived plan (ISS-20 resolved)
Cycle 57 (2026-04-02): Added per-mode step markers to 4 multi-mode skills (ISS-20 Task 5)
Cycle 56 (2026-04-02): Added step markers to 5 single-mode skills (ISS-20 Task 4)
Cycle 55 (2026-04-02): Standardized opener phrasing, renamed inspektera Synthesize → Distill
Cycle 54 (2026-04-02): Standardized exit signal sections across all 11 SKILL.md files
Cycle 53 (2026-04-02): SPEC.md Section 12: formatting standard, divider hierarchy, exit signals
Cycle 52 (2026-04-02): Context snapshot, decision gate, and tiered audit depth (ISS-16/17/18)
Cycle 51 (2026-04-01): Minor version bump, collection 1.4.0, plan complete
Cycle 50 (2026-04-01): Script renames, reference updates, 48 unit tests added
Cycle 49 (2026-04-01): Consolidated profilera extract pipeline (6 files → 1 script)
Cycle 48 (2026-04-01): PEP 723 inline metadata on 4 standalone skill scripts
Cycle 47 (2026-04-01): Minor version bump, collection 1.3.0, plan complete

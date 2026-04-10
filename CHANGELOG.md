# Changelog

## [Unreleased]

### Added
- Ecosystem spec Section 20: Host Adapter Contract defining six runtime capabilities for platform portability
- Ecosystem spec Section 21: Session Corpus Contract defining normalized record types and degradation rules for profilera portability

### Changed
- Annotated all platform-specific references (`~/.claude/`, worktrees, `claude -p`) with `<!-- platform: capability-name -->` comments across all 12 SKILL.md files and SPEC.md Sections 20-21
- Profilera extraction step scoped as Claude-adapter-specific with Section 21 reference for portable contract
- README.md updated to reflect Section 21 corpus is defined rather than pending
- Terminology cleanup (Decision 23): `ecosystem-spec.md` renamed to `SPEC.md` (root), `ecosystem-context.md` renamed to `contract.md` (per skill), "ecosystem" prefix dropped from all scripts, headers, and prose
- Spec Section 20 host adapter contract: portability claims now distinguish the portable core from host-specific extensions
- Planera em-dash on line 130 fixed (last remaining em-dash in SKILL.md files)

### Fixed

## [1.7.0] · 2026-04-08

### Added
- Reality verification gate convention (the spec Section 19): runtime-agnostic definition of the `**Verified**` PROGRESS.md cycle field with enumerated N/A allowlist (`docs-only`, `refactor-no-behavior-change`, `chore-dep-bump`, `chore-build-config`, `test-only`), project-archetype taxonomy mapping entrypoint forms (CLI tool, library/SDK, web service, skill repo, design system, data pipeline), optional `verification_budget` downgrade convention, and skill-to-gate mapping table
- `**Verified**` field in PROGRESS.md cycle entry format: mandatory field recording observed output from running the primary entrypoint OR an N/A tag with one-line rationale
- New linter check `check_reality_verification_gate` in scripts/validate_spec.py (check 17): enforces that realisera and orkestrera SKILL.md each reference Section 19 and include the `**Verified**` field in their format examples; 3 tests (1 pass, 2 fails) bringing test suite from 233 to 236

### Changed
- realisera Step 6 extended with two named phases: Phase A structural verification (existing test/lint/build suite) and Phase B behavioral verification (run primary entrypoint against real project state). Phase B runs on realisera's main checkout post-merge, never inside a dispatched worktree
- orkestrera Step 3 Evaluate extended with two enforcement surfaces: conductor-side presence check on PROGRESS.md `**Verified**` field (artifact read only, conductor safety rails preserved) and inspektera dispatch prompt evidence audit that checks whether recorded evidence corresponds to task acceptance criteria
- orkestrera "Keeping the conductor lean" table now lists PROGRESS.md alongside PLAN.md and HEALTH.md in the conductor-reads column
- version bump to 1.7.0 across 14 version_files paths (profilera on its own track bumped 2.5.0 to 2.6.0)

## [1.6.0] · 2026-04-03

### Added
- Claude Code hooks infrastructure: SessionStart context preload, Stop session bookmarks, PostToolUse artifact validation (hooks/hooks.json, hooks/session_start.py, hooks/session_stop.py, hooks/validate_artifact.py, hooks/common.py)
- SESSION.md: 12th suite artifact for session-to-session continuity (Decision 23)
- Inspektera security hygiene dimension: 9th audit dimension with regex-based checks for hardcoded secrets, dangerous function calls, and injection patterns
- Selective contract loading: per-skill generated context files from SPEC.md eliminate semantic drift by construction
- Generation script (scripts/generate_contracts.py) with --check and --skill modes
- spec_sections frontmatter field in all 12 SKILL.md files declaring the spec dependencies
- Ecosystem context read instruction in all 12 SKILL.md workflows
- 3 new linter checks (spec-sections-declared, context-file-exists, context-file-current) bringing total to 16
- Staleness detection convention (the spec Section 18): skill-to-expected-artifact mapping, plan-relative detection rule, and PROGRESS.md recency fallback
- Artifact freshness audit dimension in inspektera: plan-relative staleness with PROGRESS.md recency fallback
- Test proportionality convention in the spec Section 16 and Decision 21: default 1-pass + 1-fail per testable unit with edge case and override rules
- 233-test pytest suite (53 new tests for hooks infrastructure, context generation, linter checks, eval runner, and skill scripts)

### Changed
- PostToolUse hook replaces .githooks/pre-commit for artifact validation (Decision 24): one validation path via Claude Code hooks instead of git hooks
- realisera verify step prioritizes functional verification over test suite
- orkestrera dispatch template includes anti-bias constraint for implementation tasks
- planera test acceptance criteria use negative cap framing ("must not exceed N tests per unit")

### Fixed
- ISS-35: 12 spec-to-skill semantic drifts resolved (token budgets, profile script syntax, missing profile consumption, phase tracking, content exclusion, severity classification)
- orkestrera added to eval runner trigger prompts
- README profilera and inspirera skill descriptions corrected

## [1.5.0] · 2026-04-02

### Added
- Orkestrera plugin.json, registry.json entry, and marketplace.json entry (v1.5.0); README skill table, suite diagram, and artifact consumers updated; CLAUDE.md and DOCS.md counts updated to 12 skills
- All 11 existing SKILL.md files updated to twelve-skill suite; hej routing table, cross-skill section, and count references include orkestrera
- Ecosystem-spec and linter updated for 12 skills: orkestrera in cross-skill table, autonomous-loop set, format contracts, and linter validation rules
- Orkestrera SKILL.md: full conductor protocol with plan-driven dispatch, inspektera evaluation gating, retry logic, and lean-conductor discipline
- Orkestrera skill foundation: Decision 20, PLAN.md with 7 tasks, glyph ⎈ (helm symbol) assigned in DESIGN.md and the spec
- Linter enforcement for em-dash detection (error) and hard-wrap detection (advisory warning) in validate_spec.py
- Em-dash removal, hard-wrap elimination, and heading separator migration (to middle dot ·) across all project docs, operational artifacts, and JSON manifests (Decisions 18, 19)
- Em-dash removal and hard-wrap elimination across all 11 SKILL.md files; heading format templates updated to middle dot (·)
- Punctuation conventions (Section 14) and line-break conventions (Section 15) in the spec; heading separators changed from em-dash to middle dot across all format contracts
- Narration voice principle in the spec Section 13: action narration register with riffable contrast-pair examples for mode announcements, routing transitions, and ad-hoc narration (Decision 17)
- Warm narration examples in hej, visionera, profilera, visualisera, planera, replacing mechanical mode labels and formulaic framing
- "Sharp colleague" voice across all 11 skills: human frame pattern (conversational opener before structured data), unified personality in resonera/visionera/visualisera, warm output framing in inspektera/optimera/planera/realisera/profilera/dokumentera/inspirera (Decision 16)
- Formatting standard across the suite: divider hierarchy, exit signal format, step markers with N/M progress, opener phrasing, scratchpad container (Decision 14)
- Context snapshot in realisera cycle entries (intent, constraints, unknowns, scope) for cross-cycle coherence
- Unresolved-decision gate in realisera work selection, flags exploratory DECISIONS.md entries before building on them
- Change-magnitude depth scaling in inspektera: advisory audit depth based on commit volume since last audit

## [1.4.0] · 2026-04-01

### Added
- PEP 723 inline script metadata (`requires-python = ">=3.10"`) on all Python scripts
- Consolidated profilera extract pipeline: 6 files merged into single-file extract_all.py
- 48 unit tests for critical parsing functions (pytest)
- hej trigger prompt in eval runner
- Artifact consolidation: 3 project-facing files at root (VISION.md, TODO.md, CHANGELOG.md), 8 operational files in .agentera/
- TODO.md with severity-grouped checkboxes replaces ISSUES.md
- Dual-write: realisera writes both CHANGELOG.md and .agentera/PROGRESS.md
- Visual identity system with skill glyphs and semantic tokens
- Versioning convention via DOCS.md for automated version management
- Completion status protocol and escalation discipline as suite primitives
- Token efficiency: 16.9% word reduction across all 11 SKILL.md files

### Changed
- All scripts renamed from hyphens to underscores for importability
- All SKILL.md invocations use direct `python3 scripts/X.py` instead of `python3 -m scripts.X`
- All 11 SKILL.md files updated for .agentera/ artifact paths
- Ecosystem spec Sections 2, 4, 5, 12 updated for new convention
- Linter validates .agentera/DOCS.md wording and TODO.md format contracts
- Archive directories consolidated: .planera/, .visionera/, .visualisera/ → .agentera/archive/
- Deterministic layout replaces DOCS.md-first discovery

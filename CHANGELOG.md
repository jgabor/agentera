# Changelog

## [Unreleased]

### Added
- Linter enforcement for em-dash detection (error) and hard-wrap detection (advisory warning) in validate_ecosystem.py
- Em-dash removal, hard-wrap elimination, and heading separator migration (to middle dot ·) across all project docs, operational artifacts, and JSON manifests (Decisions 18, 19)
- Em-dash removal and hard-wrap elimination across all 11 SKILL.md files; heading format templates updated to middle dot (·)
- Punctuation conventions (Section 14) and line-break conventions (Section 15) in ecosystem-spec; heading separators changed from em-dash to middle dot across all format contracts
- Narration voice principle in ecosystem-spec Section 13: action narration register with riffable contrast-pair examples for mode announcements, routing transitions, and ad-hoc narration (Decision 17)
- Warm narration examples in hej, visionera, profilera, visualisera, planera, replacing mechanical mode labels and formulaic framing
- "Sharp colleague" voice across all 11 skills: human frame pattern (conversational opener before structured data), unified personality in resonera/visionera/visualisera, warm output framing in inspektera/optimera/planera/realisera/profilera/dokumentera/inspirera (Decision 16)
- Formatting standard across ecosystem: divider hierarchy, exit signal format, step markers with N/M progress, opener phrasing, scratchpad container (Decision 14)
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
- Completion status protocol and escalation discipline as ecosystem primitives
- Token efficiency: 16.9% word reduction across all 11 SKILL.md files

### Changed
- All scripts renamed from hyphens to underscores for importability
- All SKILL.md invocations use direct `python3 scripts/X.py` instead of `python3 -m scripts.X`
- All 11 SKILL.md files updated for .agentera/ artifact paths
- Ecosystem spec Sections 2, 4, 5, 12 updated for new convention
- Linter validates .agentera/DOCS.md wording and TODO.md format contracts
- Archive directories consolidated: .planera/, .visionera/, .visualisera/ → .agentera/archive/
- Deterministic layout replaces DOCS.md-first discovery

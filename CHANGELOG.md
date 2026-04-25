# Changelog

## [Unreleased]

### Added

### Changed

- Copilot install guidance validation now rejects unverified marketplace claims, placeholder-as-source wording, and primary deprecated fallback guidance.
- Copilot install guidance now prefers marketplace-style `plugin@marketplace` installs, with direct repo installs documented as deprecated fallback paths.

### Fixed

## [1.18.1] · 2026-04-25

### Changed

- Live Copilot/Codex host smoke validation narrowed the release caveat: Codex `$hej` and installed Copilot skill discovery work, while current-checkout Copilot plugin loading remained blocked by its escaping skills path until the root plugin fix.
- Audit 11 runtime portability cleanup is freshness-complete: state artifacts now summarize the plan, mark resolved cleanup items, and preserve the live Copilot/Codex host-test caveat.
- Profilera corpus orchestration now uses a localized runtime collector registry and shared source-family runner while preserving supported runtime output.
- Audit 11 runtime portability cleanup completed: contract alignment, runtime metadata drift guards, profilera corpus hardening, and 1.18.1 release targets are now aligned.

### Fixed

- Copilot current-checkout plugin loading now uses root `plugin.json` with in-root skill and hook paths, so `copilot --plugin-dir <repo>` can discover agentera skills.
- Profilera corpus validation now rejects incomplete metadata envelopes, malformed family status/count data, and inconsistent aggregate versus per-runtime family counts.
- OpenCode artifact validation now resolves the documented manual install root, Copilot list-form hooks receive the same lifecycle checks as string hooks, and DOCS version targets include the OpenCode marker.
- Runtime metadata validation now catches Copilot profilera caveat drift and Codex profilera policy drift across local metadata surfaces.
- Copilot corpus config extraction now redacts sensitive-looking primitive values while preserving bounded non-sensitive config signals.
- Section 21 corpus records now unambiguously use top-level provenance fields plus a required `data` payload object, matching profilera extraction and validation.

## [1.18.0] · 2026-04-24

### Added

- Profilera now collects Copilot CLI corpus records from bounded `~/.copilot` runtime surfaces, with per-family status metadata and stable Section 21 provenance IDs
- Profilera now collects Codex CLI corpus records from bounded `~/.codex` history, session, and config surfaces, with per-family status metadata and stable Section 21 provenance IDs
- Profilera corpus validation now covers aggregate multi-runtime envelopes, single-runtime extraction, duplicate source IDs, and no-data envelopes
- Copilot native runtime metadata now declares partial command-handler lifecycle support with lower-camel events and per-skill portability limits
- Codex native runtime metadata now declares `$skill` invocation hints, portable implicit invocation policy, guarded profilera limits, and experimental disabled hooks
- `scripts/validate_lifecycle_adapters.py` reports unsupported lifecycle behavior in runtime metadata before it is silently configured

### Changed

- Runtime plugin installation docs now distinguish marketplace installation, direct skill-folder loading, Codex metadata limits, and lifecycle-support differences across Claude Code, Copilot, Codex, and OpenCode
- `hooks/compaction.py::_format_todo_oneline` split into three single-responsibility helpers (`_is_todo_oneline_passthrough`, `_extract_iss_id`, `_strip_todo_metadata`) plus a thin orchestrator; behavior preserved exactly
- realisera Step 5 and optimera Step 4 gain a Stale-base awareness nudge: when local HEAD is ahead of `origin/main`, skip merging the worktree branch and apply the sub-agent's diff onto HEAD directly so verification runs against current code
- `hooks/validate_artifact.py` now imports DOCS.md parsing from `hooks/common.py` instead of carrying a duplicate parser; filter to known canonical artifacts preserved

### Fixed

- Claude Code marketplace metadata now validates against current CLI schema, and Copilot metadata uses supported `skills` and `hooks` component paths instead of stale custom shapes
- Codex UI metadata now resolves from the plugin install root, including aggregate and per-skill metadata paths with guarded profilera limitations
- README and Codex metadata now describe profilera's Copilot/Codex collectors as capability-gated degradation instead of missing-collector limitations
- `analyze_progress.py` now reports the newest cycles from current newest-first PROGRESS.md files, so realisera orientation sees the live recent window
- OpenCode bootstrap versioning now tracks 1.18.0, and adapter tests compare the plugin marker against registry release metadata
- `.gitignore` gains the four credential patterns (dotenv, `*.key`, `*.pem`, `credentials*`) that the cycle 118 CHANGELOG claimed were added but never actually landed on disk

## [1.16.0] · 2026-04-23

### Added

- opencode plugin self-bootstraps 12 slash commands into the user's opencode commands dir on session start; global installs now make `/hej`, `/planera`, etc. available in any project, with collision safety via `agentera_managed: true` frontmatter marker and version-gated refresh on plugin upgrade

### Changed

- `.opencode/package.json` declares `"type": "module"` and the plugin drops 7 unused bindings; Node no longer emits the ESM reparse warning on plugin load
- `analyze_progress.py::analyze()` split into small computation and per-signal suggestion helpers; each is testable in isolation

### Fixed

- `analyze_progress.py` header regex now matches the current SPEC PROGRESS.md format (`■ ## Cycle N · YYYY-MM-DD · title`); previously returned zero cycles against real files. Legacy em-dash format still parses for back-compat
- `hooks/validate_artifact.py` no longer emits a false-positive missing-required-heading warning on every SPEC-conformant PROGRESS.md edit (the `ARTIFACT_HEADINGS` regex now accepts the optional `■` glyph prefix)

## [1.15.0] · 2026-04-23

### Added

- Deterministic artifact compaction engine (`hooks/compaction.py`, `scripts/compact_artifact.py`) with uniform 10/40/50 rule across PROGRESS, DECISIONS, HEALTH, EXPERIMENTS, and TODO Resolved

### Fixed

- Profile path references across all SKILL.md files, SPEC.md, DOCS.md, README.md, and contract files now match profilera's actual XDG write location per Decision 27

## [1.14.0] · 2026-04-20

### Added

- SPEC.md Section 23 Artifact Writing Conventions: sentence-length caps, banned vocabulary, and structural requirements for skill-generated artifacts, with linter checks
- Uniform 10/40/50 compaction thresholds across all growing artifacts (PROGRESS.md, EXPERIMENTS.md, DECISIONS.md, HEALTH.md, TODO.md Resolved, SESSION.md)
- Commit message hygiene rules in SPEC.md Section 22: prohibits task/plan/todo references in commit guidance
- Lefthook pre-commit (spec-lint, contracts, markdownlint, prettier) and pre-push (pytest) hooks

### Changed

- Skill descriptions trimmed to 1024 chars across all 12 skills
- check_pre_dispatch_commit_gate refactored: extracted `_has_section_22_ref`, `_has_scoped_staging`, and declarative `_GATE_INDICATORS` table
- check_severity_levels refactored from 98 to 36 lines with 4 named helpers

### Fixed

- CI workflow: added missing pytest install and contract freshness check
- Normalized filename references to use .md extensions across 9 SKILL.md files
- Hej glyph replaced: U+1F794 with U+2302 (terminal rendering compatibility)
- Literal `\n` in YAML frontmatter descriptions for inspektera, visionera, visualisera
- .gitignore: added defensive credential patterns (.env, *.key,*.pem)

## [1.13.0] · 2026-04-13

### Added

- SPEC.md Section 22 Pre-dispatch Commit Gate: checkpoint commit convention for skills that dispatch subagents to git worktrees, ensuring subagents see current state
- Linter Check 19 (pre-dispatch-commit-gate): enforces gate presence in realisera and optimera SKILL.md files

### Changed

- Realisera Step 5 and optimera Step 4 updated with pre-dispatch commit gate procedure
- Version bumped to 1.13.0

## [1.12.0] · 2026-04-12

### Added

- Multi-objective support for optimera: named subdirectories under `.agentera/optimera/` with active-objective inference (Decision 30, ISS-39)
- Active-objective inference in optimera SKILL.md: single dir = use it, multiple = most recent, ambiguous = ask

### Changed

- `.optimera/` consolidated under `.agentera/optimera/` (single artifact root per Decision 4)
- SPEC.md Section 4 and 18 updated for per-objective OBJECTIVE.md/EXPERIMENTS.md paths
- Hooks and DOCS.md updated: OBJECTIVE.md/EXPERIMENTS.md removed from fixed-path tracking (optimera self-manages)

## [1.11.0] · 2026-04-12

### Added

- Two-tier metric for realisera-token harness: Tier 1 exact token count via count_tokens API (zero variance), Tier 2 Docker A/B gates-only behavioral validation

### Changed

- Realisera contract.md trimmed from 10 to 5 spec sections (-35.8% contract size)
- Realisera Getting started section removed (onboarding docs, not needed during cycle execution)
- Realisera fixed token footprint reduced by 20% (15,065 -> 12,055 est tokens)

## [1.10.0] · 2026-04-11

### Added

- SPEC.md Section 21 corpus envelope format: metadata object (extracted_at, runtimes, adapter_version, families, total_records, errors) and records array with full provenance; runtime probing convention for multi-runtime extraction
- Profilera extract_all.py refactored into multi-runtime corpus builder producing single corpus.json with Section 21 normalized records, runtime probing infrastructure, and old intermediate file cleanup
- Self-validation step in corpus builder: validates required provenance fields and source_kind values before writing corpus.json
- Corpus builder and validation tests for envelope generation, self-validation, runtime probing, provenance attachment, and old file cleanup

### Changed

- Profilera SKILL.md Steps 1-2 updated to consume unified corpus.json (run extract_all.py, read corpus.json, group by source_kind)
- Version bumped to 1.10.0 (profilera 2.8.0)

## [1.9.0] · 2026-04-11

### Added

- GitHub Actions CI workflow running spec linter and pytest on every push to main and pull request (closes ISS-31)
- OpenCode adapter plugin at `.opencode/plugins/agentera.js` with lifecycle hooks for session preload, artifact validation, and session bookmarking
- Runtime detection in eval runner: `--runtime` flag supporting Claude Code and OpenCode, auto-detection via PATH probing
- OpenCode installation guide in README with global skill install, plugin install, and profile path convention

### Changed

- Refactored check_severity_levels into four pattern-specific helpers, flattening 4-level nesting to 2
- Adapter design doc upgraded from design document to implementation reference

## [1.8.1] · 2026-04-11

### Fixed

- Update CLAUDE.md layout block to reference root SPEC.md (post-Decision 23 rename)
- Add missing `<!-- platform: profile-path -->` annotations to inspektera and planera SKILL.md

## [1.8.0] · 2026-04-10

### Added

- Ecosystem spec Section 20: Host Adapter Contract defining six runtime capabilities for platform portability
- Ecosystem spec Section 21: Session Corpus Contract defining normalized record types and degradation rules for profilera portability
- OpenCode proof-of-concept adapter design mapping all six host capabilities and four portable session corpus record types to OpenCode's mechanisms
- Linter check 18 (platform-annotations): validates that `<!-- platform: NAME -->` annotations in SKILL.md files reference recognized capability names from Section 20; 4 tests

### Changed

- Demoted memory_entry from portable record type to Claude Code runtime extension in Section 21; portable corpus now has 4 record types; Claude Code memory files emitted as instruction_document with doc_type "claude_memory"
- Annotated all platform-specific references (`~/.claude/`, worktrees, `claude -p`) with `<!-- platform: capability-name -->` comments across all 12 SKILL.md files and SPEC.md Sections 20-21
- Profilera extraction step scoped as Claude-adapter-specific with Section 21 reference for portable contract
- README.md updated to reflect Section 21 corpus is defined rather than pending
- Terminology cleanup (Decision 23): `ecosystem-spec.md` renamed to `SPEC.md` (root), `ecosystem-context.md` renamed to `contract.md` (per skill), "ecosystem" prefix dropped from all scripts, headers, and prose
- Spec Section 20 host adapter contract: portability claims now distinguish the portable core from host-specific extensions
- Planera em-dash on line 130 fixed (last remaining em-dash in SKILL.md files)
- Version bumped to 1.8.0 (profilera 2.7.0)

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

# Changelog

## [Unreleased]

### Fixed

- Objective lifecycle regression coverage now guards optimera active-objective inference and duplicate closure idempotency.
- Artifact validation now recognizes per-objective optimera OBJECTIVE.md and EXPERIMENTS.md files without adding DOCS.md fixed mappings.
- Objective routing consumers now exclude closed optimera objectives before active-objective recency selection.

## [1.24.0] · 2026-04-29

### Added

- Self-Audit Protocol (SPEC.md §24): pre-write 3-check gate (verbosity drift, abstraction creep, filler accumulation) with max-3-retry bail-out for all artifact-producing skills (realisera, inspektera, resonera, planera, optimera, dokumentera, visualisera, visionera). Inspektera gains prose health as a 10th audit dimension; dokumentera enforces prose quality across indexed docs.
- Resonera decision capture now records compact win conditions inside serious alternative bullets while preserving existing DECISIONS.md reader fields.
- Fail-open guard in validate_artifact.py hook (ISS-47)
- --schema flag on generate_contracts.py producing contracts.json (ISS-46)
- scripts/self_audit.py module with verbosity, abstraction, and filler checks (ISS-45)

### Changed

- Steelman-Informed Decision Pressure is freshness-closed: resonera pressure testing, decision win conditions, adjacent effort-bias guards, compatibility validation, and 1.24.0 metadata landed together.
- Contract compatibility for the decision-workflow updates was revalidated against suite spec checks, DECISIONS.md artifact validation, and existing proportional tests.
- Planera and optimera now reset option or hypothesis selection when construction effort could bias the choice, without adding workflow surfaces.
- Resonera pressure testing now names context-specific blind spots before alternatives, argues alternatives from project context, keeps confidence explicit, and bans weak challenge phrasing.
- Unified setup bundle work is now freshness-closed: final validators, offline smoke checks, default live-host smoke, OpenCode bootstrap smoke, and the 477-test suite passed after the 1.21.0 release metadata and setup docs landed.

### Fixed

- Optimera now records objective closure when a target is already met or a kept experiment reaches target, without adding registries, symlinks, or root objective artifacts.

## [1.21.0] · 2026-04-28

### Added

- Runtime package metadata now declares the Agentera suite bundle surface for Claude Code, Codex, Copilot, and OpenCode, with validation that shared skills, scripts, hooks, manifests, and docs resolve from one install root.
- Packaged executable suite scripts now use uv script headers with stdlib-only inline metadata, and lifecycle validation catches missing shebangs, missing metadata, non-empty dependencies, and missing uv runtime guidance.
- `scripts/setup_doctor.py` now diagnoses the Agentera install root and Claude Code, OpenCode, Copilot, and Codex helper-script access without writing files, with stable JSON output for downstream tools.
- `scripts/setup_doctor.py --smoke` now runs bounded offline helper, artifact-hook, and host-binary smoke checks with human-readable and JSON evidence.
- `scripts/setup_doctor.py --install` now plans confirmed runtime-native Codex and Copilot config writes, refuses unconfirmed writes, and re-runs doctor after confirmed fixes.

### Fixed

- Doctor smoke now reports malformed runtime-host PATH candidates as failures without invoking live model CLIs.

## [1.20.1] · 2026-04-28

### Fixed

- DECISIONS.md guidance now defines next-number selection, active-section
  insertion, and unique ascending active entries; artifact validation rejects
  duplicate decision numbers or descending active entries.

## [1.20.0] · 2026-04-27

Scope refined post-research to address verified cross-runtime parity gaps; consolidates Move 1 renumber and Move 2 parity completion per explicit user direction.

Cross-runtime portability release. Standardizes AGENTERA_HOME across Claude Code, OpenCode, Codex, and Copilot; ships idempotent setup helpers for the runtimes without plugin-level env injection; verifies end-to-end inheritance plus SKILL.md compaction execution with a live-host smoke harness; closes the Codex apply_patch real-time-validation gap with a wired hook; ships Codex marketplace install plus per-skill agent stubs; refreshes README/SPEC/structured runtime metadata against current Codex/Copilot capability evidence; revives the dead Copilot session-end hook; documents orkestrera/realisera/optimera dispatch substrates per runtime.

### Added

- **AGENTERA_HOME contract** (SPEC.md Section 7): standardizes the env var that names the agentera install root, with a per-runtime mechanism table covering Claude Code (bash fallback to `CLAUDE_PLUGIN_ROOT`), OpenCode (`shell.env` plugin hook), Codex (`[shell_environment_policy].set` in `~/.codex/config.toml`), and Copilot (shell rc export).
- **OpenCode plugin** bootstraps 12 slash commands at plugin init (was previously wired to a phantom hook that never fired) and injects AGENTERA_HOME into every shell-tool subprocess via the `@opencode-ai/plugin` `shell.env` hook.
- **`scripts/setup_codex.py`**: idempotent Codex setup helper that writes `[shell_environment_policy].set.AGENTERA_HOME` to `~/.codex/config.toml`. Stdlib-only; auto-detects install root; supports `--install-root`, `--config-file`, `--dry-run`, `--force`; refuses to overwrite conflicting sibling keys without `--force`.
- **`scripts/setup_copilot.py`**: idempotent Copilot setup helper that writes a marker-commented `AGENTERA_HOME` export block to the user's shell rc. Stdlib-only; supports bash, zsh, and fish; auto-detects shell from `$SHELL`; supports `--rc-file` and `--dry-run`; preserves user-owned bare lines.
- **`scripts/smoke_setup_helpers.py`**: stdlib black-box smoke harness exercising both setup helpers across 11 sequential cases (5 Codex + 4 Copilot + 2 cross-cutting), no live CLI required.
- **`scripts/smoke_live_hosts.py`**: live-host AGENTERA_HOME inheritance and SKILL.md compaction smoke harness for Codex and Copilot. Default mode runs the profilera Codex collection audit and delegates to `scripts/smoke_setup_helpers.py` (no live CLI invocations, no cost). `--live` mode prints a one-line cost estimate and consent prompt, then issues exactly one `codex exec` and one `bash -c '...copilot -p ... --allow-all-tools'` invocation per runtime, each carrying a combined prompt that exercises both AGENTERA_HOME echo and `compact_artifact.py` execution, with snapshot + SHA256 round-trip on `~/.codex/config.toml` and shell rc files plus orphan-snapshot auto-recovery on the next run.
- **Codex `apply_patch` hook config** (`hooks/codex-hooks.json`): PreToolUse + PostToolUse `apply_patch` matchers wire `validate_artifact.py` for real-time artifact validation, parity with Claude Code PostToolUse and OpenCode `tool.execute.after`.
- **`.agents/plugins/marketplace.json`**: Codex marketplace manifest enables `codex plugin marketplace add jgabor/agentera` plus interactive `/plugins` installation of the aggregate Agentera plugin.
- **12 per-skill `agents/<name>.toml` Codex agent stubs** with explicit `model = "gpt-5-codex"`, `model_reasoning_effort`, and `developer_instructions` fields pointing at bundled SKILL.md paths.
- **`scripts/setup_codex.py --enable-agents`** flag writes `[agents.<name>]` entries to `~/.codex/config.toml` for all 12 agentera skills so orkestrera dispatch maps natively to Codex `[agents.*]`.
- **`scripts/smoke_live_hosts.py --yes` flag plus `AGENTERA_LIVE_CONSENT=1` env var**: bypass the interactive consent prompt for non-interactive realisera/orkestrera invocation; cost line still prints; explicit `auto-consented via flag` audit line emitted to stdout.
- **Codex apply_patch hook firing verification section** in `smoke_live_hosts.py`: one extra `codex exec` invocation under a tmp `CODEX_HOME` with sentinel-recording wrapper proves the `hooks/codex-hooks.json` wiring fires PreToolUse + PostToolUse end-to-end.
- **README install documentation**: runtime-specific AGENTERA_HOME setup paths (recommended `setup_codex.py` / `setup_copilot.py` plus manual snippet alternatives). Codex plugin limitations and Copilot manifest descriptions surface the requirement.
- **README "Verify Codex AGENTERA_HOME by hand" and "Verify Copilot AGENTERA_HOME by hand" subsections**: copy-pasteable bash one-liners that exercise both AGENTERA_HOME inheritance and the bash-fallback compaction-script resolution, for users without `--live` access (no auth, no API budget, behind a firewall).
- **README Scripts section** enumerates the new helpers (`setup_codex.py`, `setup_copilot.py`, `smoke_setup_helpers.py`, `smoke_live_hosts.py`) alongside the existing `validate_spec.py`, `eval_skills.py`, `usage_stats.py`, with default-mode and `--live` cost semantics named.
- **Spec validator lint rule** warns when SKILL.md prose uses bare `${CLAUDE_PLUGIN_ROOT}` (the bash-fallback form `${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}` passes).

### Changed

- **5 SKILL.md compaction-script invocations** (realisera ×2, resonera, optimera, inspektera) now use `${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}` so the script resolves under any host that adheres to the contract.
- **SPEC.md sections 7-23 renumbered to 8-24** to make room for the new Section 7 (Install Root); SKILL.md `spec_sections` frontmatter, prose Section refs, validator code, and test fixtures shifted accordingly.
- **`.codex-plugin/plugin.json` `requiredCapabilities[codex_session_corpus].status`** flipped `degraded` → `ok` after the profilera Codex collection audit verified end-to-end record extraction (252 history_prompt + 1 project_config_signal records). Mirrored across `agents/openai.yaml` and `skills/profilera/agents/openai.yaml`. Companion limitation prose now describes accurate behavior without reusing the word "degraded" as a status label.
- **`scripts/validate_lifecycle_adapters.py` and `tests/test_runtime_adapters.py`** accept `status` of either `ok` or `degraded` (back-compat preserved); explicit `status:` declaration is now required in YAML surfaces.
- **`tests/test_runtime_adapters.py`** AGENTERA_VERSION drift test reads the version from `.opencode/plugins/agentera.js` at test time instead of carrying a hardcoded literal, so future bumps require no test edits.
- **`.agentera/DOCS.md` Index** gained rows for all four new helpers and the live-host smoke runner; Audit Log block records the README and DOCS surfaces resolved.
- **README runtime support table** reflects Codex `multi_agent`/`codex_hooks` stable + default-on as of v0.124.0, `apply_patch` Write/Edit interception per `openai/codex#18391`, and verified Copilot marketplace install (granular + umbrella both functional).
- **README lifecycle hooks table** adds Supported Events column with all 6 events per runtime; names the Copilot preToolUse-blocks vs postToolUse-output-ignored asymmetry explicitly.
- **README onboarding polish** separates per-runtime quick starts from optional hook/helper setup, fixes linked navigation, corrects the OpenCode path to install skills before adding the plugin, and documents that the unified setup/doctor experience is deferred by Decision 33.
- **`.codex-plugin/plugin.json` `lifecycleHooks.status`** flipped `experimental-disabled` → `stable`; `supportedEvents` array added; `unsupportedEvents` rewritten to genuinely-unsupported Claude-Code-specific events; stale `codex.limitations[0]` removed.
- **`agents/openai.yaml` `support.lifecycle_hooks`** mirrors the new metadata story.
- **`scripts/validate_lifecycle_adapters.py` `CODEX_EVENTS` and `COPILOT_EVENTS`** populated with the genuine event lists; predicates reject stale-marker phrases.
- **README Copilot install** documents granular (`<skill>@agentera`) as the recommended path until `copilot-cli#2390` lands; umbrella retained as alternative with the bug caveat noted.
- **`.github/hooks/stop.json` → `.github/hooks/sessionEnd.json`** (was silently dead under Copilot since shipping; `stop` is not a valid Copilot hook event).
- **All 12 SKILL.md frontmatter** audited for Copilot bug `github/copilot-cli#951`: trailing `metadata:` field as the last entry no longer leaves the parser in an inconsistent state; affected skills get `license: MIT` appended as the harmless trailing field.
- **`hooks/validate_artifact.py`** Codex stdin branch handles the `apply_patch` matcher per the captured Codex hook stdin schema.
- **`skills/orkestrera/SKILL.md`, `skills/realisera/SKILL.md`, `skills/optimera/SKILL.md`** document runtime-aware dispatch substrates: Claude Code Task tool, OpenCode plugin path, Codex `[agents.*]` post-`--enable-agents` setup, Copilot user-driven `/fleet` workaround.
- **Per-turn conversation_turn corpus emission** in `skills/profilera/scripts/extract_all.py`: the Claude Code conversation extractor (`extract_conversation_turns` + `_process_conversation_turns`) emits assistant turns carrying SPEC workflow markers plus their immediate preceding user turn, gated by a cheap `─` + `·` pre-filter. Each turn lands as its own corpus record with `data.actor`, `data.content`, and `data.session_id` so `scripts/usage_stats.py` can pair intro/exit markers and classify slash-vs-natural triggers across multi-turn sessions. Cross-file dedupe by `(session_id, timestamp, actor, content_hash)` collapses parent transcripts against subagent JSONL shadows.
- **Copilot CLI conversation extractor** (`extract_copilot_conversations`): reads `~/.copilot/session-store.db` via stdlib `sqlite3` in read-only URI mode, emits two per-turn records per `turns` row (one user, one assistant) using the same per-turn `data.actor` / `data.content` / `data.session_id` schema as Claude Code. Timestamps normalize to ISO 8601 (T separator); the user-side stamp shifts 1 ms earlier so trigger classification finds the prompt that drove each invocation. Probe surfaces and the runtime collector entry for Copilot's `conversation_turn` family flip from `unsupported_reason` to a real extractor.

### Fixed

- **Codex marketplace visibility**: `.agents/plugins/marketplace.json` now points at the aggregate plugin root instead of skill folders, and `.codex-plugin/plugin.json` carries standard interface metadata so Agentera appears as an installable plugin after the marketplace cache is refreshed.
- **Copilot `preToolUse` artifact gate**: reconstructable invalid artifact edits are denied before mutation, while valid, non-artifact, malformed, or evidence-insufficient payloads remain allowed.
- **OpenCode `tool.execute.before` artifact gate**: reconstructable invalid artifact write/edit candidates are blocked before mutation while session idle bookmarks and `session.created` no-op behavior stay intact.
- **Lifecycle drift guards**: validation now requires the shipped Copilot pre-write hook, rejects unsupported Copilot hook event names and filename mismatches, and catches Copilot/OpenCode hard-gate docs drift.
- **`[claude-code-extract-duplicate-source-ids]`** (filed during Live-Host Verification Task 1, blocked corpus.json writes for any host with substantial Claude Code history): `_records_from_conversation_turns`, `_records_from_codex_conversations`, and `_records_from_copilot_conversations` now generate per-turn-unique `source_id` so the envelope uniqueness invariant in `validate_corpus_envelope` holds. The conversation grouping key moves to `data.session_id` (with `source_id` fallback for legacy fixtures); `scripts/usage_stats.py:group_by_conversation` and `_user_turns_by_conversation` route through a new `_conversation_key()` helper. End-to-end against this system's session corpus: 4370 Claude Code + 145 Copilot conversation_turn records → 1302 paired/orphan invocations across 11 skills (was 0 before the fix because the actor/content shape never matched the analytics predicate).
- **`[live-host-smoke-mjs-doc-row]`** (filed during Live-Host Verification Task 5): README Scripts section and `.agentera/DOCS.md` Index now carry rows for `scripts/smoke_opencode_bootstrap.mjs`, the existing peer of `smoke_setup_helpers.py`.
- **`[opencode-session-events]`**: OpenCode plugin now handles `session.idle` through the generic `event` hook and writes SESSION.md bookmarks for modified agentera artifacts. The old direct hook keys stay forbidden, and session-start preload remains deferred until a supported context-injection path is verified.
- **README and AGENTS.md "Section 21" Session Corpus references**: SPEC was renumbered in 1.20.0 (Session Corpus Contract is Section 22). Four occurrences across `README.md` (lines 31, 183, 381) and `AGENTS.md` (line 69, mirrored to `CLAUDE.md` via symlink) now point at Section 22.

## [1.19.0] · 2026-04-26

### Added

- `scripts/usage_stats.py` reads the Section 21 corpus and reports per-skill invocation counts, exit-status pairings, slash-vs-natural-language trigger splits, and a per-project breakdown. Default mode writes USAGE.md to the global agentera data directory (sibling of PROFILE.md, overrideable via `AGENTERA_USAGE_DIR`) and prints a brief stdout summary; `--json` emits the full payload with no markdown side effect; `--project PATH` scopes to one project.
- Spec validator accepts arbitrary SKILL.md paths via `--skill PATH` (repeatable) so third-party skill authors can validate their own SKILL.md against SPEC.md without forking the repo.

### Changed

- Copilot install guidance validation now rejects unverified marketplace claims, placeholder-as-source wording, and primary deprecated fallback guidance.
- Copilot install guidance now prefers marketplace-style `plugin@marketplace` installs only when a verified source exists; no canonical Agentera Copilot marketplace source is currently verified, so direct repo installs remain deprecated fallback paths.

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

- Profile path references across all SKILL.md files, SPEC.md, DOCS.md, README.md, and contract files now match profilera's actual XDG write location per Decision 28

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

- Multi-objective support for optimera: named subdirectories under `.agentera/optimera/` with active-objective inference (Decision 31, ISS-39)
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

- Update CLAUDE.md layout block to reference root SPEC.md (post-Decision 26 rename)
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
- Terminology cleanup (Decision 26): `ecosystem-spec.md` renamed to `SPEC.md` (root), `ecosystem-context.md` renamed to `contract.md` (per skill), "ecosystem" prefix dropped from all scripts, headers, and prose
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

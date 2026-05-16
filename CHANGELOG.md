# Changelog

## [Unreleased]

### Changed

- 2.3.12 patch release metadata now aligns package, plugin, OpenCode marker, registry, and skill frontmatter versions with the Realisera execution-context source-contract patch.
- 2.3.11 patch release metadata now aligns package, plugin, OpenCode marker, registry, and skill frontmatter versions with the Optimera benchmark-context source-contract patch; the 2.3.12 Realisera execution-context source-contract work is now closed separately.
- 2.3.10 patch release metadata now aligns package, plugin, OpenCode marker, registry, and skill frontmatter versions with the Inspektera evidence-context source-contract patch; the 2.3.12+ source-contract train remains deferred.
- 2.3.9 patch release metadata now aligns package, plugin, OpenCode marker, and skill frontmatter versions with the Dokumentera closeout-context source-contract patch; the 2.3.10+ source-contract train remains deferred.
- 2.3.6 patch release metadata now aligns package, plugin, OpenCode marker, and skill frontmatter versions with the artifact compaction enforcement patch; the 2.3.7+ source-contract train remains deferred.
- 2.3.8 patch release metadata now aligns package, plugin, OpenCode marker, and skill frontmatter versions with the Orkestrera orchestration-context source-contract patch; the 2.3.9+ source-contract train remains deferred.
- 2.3.7 patch release metadata now aligns package, plugin, OpenCode marker, and skill frontmatter versions with the decision-context source-contract patch; the 2.3.8+ source-contract train remains deferred.
- 2.3.5 patch release metadata now aligns package, plugin, OpenCode marker, and skill frontmatter versions with the install-state reliability patch; the 2.3.6+ source-contract train remains deferred.
- 2.3.4 patch release metadata now aligns package, plugin, OpenCode marker, and skill frontmatter versions with the startup state completeness and PLAN artifact source-contract scope.
- 2.3.3 patch release metadata now aligns package, plugin, OpenCode marker, and skill frontmatter versions with the Profilera corpus runtime parity scope.
- 2.3.2 patch release metadata now aligns package, plugin, OpenCode marker, and skill frontmatter versions with the plain-language recovery messaging scope.
- 2.3.1 patch release metadata now aligns package, plugin, OpenCode marker, and skill frontmatter versions with the runtime-injected stale-default recovery scope; Profilera corpus parity remains deferred beyond 2.3.1.
- 2.3.0 release state now aligns with Decisions 47, 48, and 50: app-home migration, `agentera lint`, installed schema/helper discovery, and app/runtime root diagnostics are the focused reliability scope, while Profilera corpus parity remains deferred beyond 2.3.0.

### Fixed

- `agentera lint --artifact <ARTIFACT> --file <PATH>` now checks verbosity against the artifact full-file budget while `--text` and stdin keep per-entry budgets, removing repeated false-positive PLAN.md full-plan pressure found in retained `post-audit-flagged` archive evidence.
- `agentera lint --artifact PLAN.md` now treats concrete repo-style path anchors such as `internal/runtime`, `internal/app`, and `internal/tui` as anchors, preventing false no-anchor advisories for concrete Planera plans while preserving abstraction advisories for generic unanchored prose.
- D47 app-home vocabulary cleanup now replaces obsolete current-behavior bundle/install-root wording across live docs, guidance, diagnostics, package text, and affected tests while preserving compatibility identifiers, canonical artifact labels, CLI selectors, historical records, and migration examples.
- D46 handoff wording enforcement now rejects stale standalone slash-capability examples in semantic fixtures and test helpers, requiring glyph plus canonical capability names such as `⧉ realisera` for user-facing handoff labels while preserving `/agentera <alias>` for explicit route documentation.
- Decision satisfaction state is now explicit in the decision contract and validator: automation may record provisional evidence, user-confirmed satisfaction requires explicit user-confirmation metadata, and missing legacy state remains review-needed rather than silently satisfied.
- Decisions JSON, shared compaction, Inspektera evidence context, and Dokumentera closeout context now preserve satisfaction caveats and protected-decision review pressure without inferring satisfaction from downstream references, commits, file changes, or compacted history.
- Realisera plan-driven startup now uses `agentera hej --format json --capability-context realisera` execution context before raw plan, progress, TODO, docs, health, decisions, changelog, vision, profile, or design startup reads, preserving fallbacks and caveats for missing state.
- Optimera benchmark-oriented startup now uses `agentera hej --format json --capability-context optimera` benchmark context before direct retained benchmark file reads, preserving fallback commands, caveats, and manual-refresh guidance for missing or incomplete local benchmark evidence.
- Inspektera evaluation startup now uses `agentera hej --format json --capability-context inspektera` evidence context before raw plan, progress, docs, health, TODO, or decisions state, preserving fallbacks and caveats for incomplete state.
- Dokumentera closeout synchronization now uses `agentera hej --format json --capability-context dokumentera` before raw TODO, docs, changelog, or progress reads, preserving blockers, evidence, fallback commands, caveats, and local-only no-publication boundaries.
- Artifact compaction is now enforced as a repo-level invariant through shared check/fix compaction, explicit `agentera compact` and `agentera gate` CLI surfaces, runtime hook convergence, current artifact remediation, Lefthook/CI gate wiring, and focused regressions while preserving `.agentera/docs.yaml` path resolution, CHANGELOG exemption, and session-stop bookmark compaction.
- Decision-context JSON output now exposes a source contract, outcome alias, reasoning, alternatives, confidence, explicit feeds-into references, downstream consequence references, per-entry completeness fields, compacted-entry missing-field caveats, and Resonera startup guidance without requiring raw `.agentera/decisions.yaml` reads or git-history fallback for normal deliberation.
- Orkestrera startup and evaluator handoff now use the supported `agentera hej --format json --capability-context orkestrera` context before raw plan, progress, health, TODO, decisions, docs, vision, or profile access, preserving caveats and listing routine CLI fallbacks when state is incomplete.
- Normal installed execution now treats stale inherited deprecated-default `AGENTERA_HOME` values as non-authoritative residue while preserving explicit valid custom app homes and hermetic tests.
- Valid older Agentera app files now render update-needed guidance, while missing, malformed, incomplete, or unsafe app states keep repair or blocked-state semantics in structured hej/doctor output.
- `agentera plan --format json` now declares itself complete for normal `PLAN.md`
  startup/evaluation context through a selectable `source_contract`, exposes full
  plan metadata in `summary`, and tells agents not to read `.agentera/plan.yaml`
  defensively when `complete_for_plan_artifact=true`.
- Shell startup file mutation has been removed from setup, doctor, upgrade, and repair paths; stale Agentera shell lines are reported as user-owned manual cleanup, exact deprecated-default `AGENTERA_HOME` residue can recover to the platform app directory when safe, managed runtime remnants refresh or clean up only with Agentera ownership proof, and package-manager updates remain opt-in.
- README, upgrade, skill repair, and Copilot manifest guidance now describe
  repair as app plus managed runtime surface repair, state that Agentera will not
  edit shell startup files, name stale shell lines as user-owned manual cleanup,
  and keep package-manager commands opt-in through `--update-packages`.
- Repair apply now refreshes managed OpenCode command files and stale skill
  links, including resolving Agentera-owned links that still point at an old
  existing Agentera skill, while preserving user-owned OpenCode commands, skill
  paths, and Codex config keys when managed runtime surfaces are stale.
- Whole-repair apply now rechecks pending managed runtime and cleanup surfaces
  before mutation, so preview-safe actions still apply while changed unverified
  user-owned surfaces block instead of being overwritten or removed.
- Repair preview now reports runtime surface ownership reasons, refreshes only
  stale Agentera-owned plugin/hook surfaces, blocks unproven stale runtime
  surfaces as user-owned, treats Copilot shell startup files as off-limits, and
  keeps package-manager actions skipped unless `--update-packages` is approved.
- Copilot setup, setup-doctor installer, and upgrade runtime repair paths now
  leave shell startup files byte-for-byte unchanged, report legacy Agentera rc
  lines as user-owned manual cleanup boundaries, and show per-invocation app
  context guidance instead of planning persistent shell edits.
- Packaged upgrade now treats stale or missing exact deprecated-default app-home
  environment values as legacy residue, selects the platform app directory when
  safe, blocks custom unknown app-home fallback, and preserves explicit
  `--install-root` authority through preview and apply.
- Profilera corpus extraction now reports available OpenCode and GitHub Copilot candidate stores as bounded `extractor_unimplemented` degradations instead of crashing while those runtime extractors remain deferred.
- Recovery and troubleshooting messaging now explains app repair in plain language, recommends the safe action first, uses `directory` terminology, and blocks jargon-heavy phrases from release validation.
- Runtime-injected exact deprecated-default `AGENTERA_HOME` recovery now guides upgrade toward the platform app home when no explicit `--install-root` was supplied, keeps doctor read-only, preserves explicit install-root authority, and allows safe user-data-only app homes to receive managed app code under `app/`.
- The default upgrade flow now retires a managed legacy `~/.agents/agentera` app home when the new platform data app home is selected, moving known user state before removing old managed files; artifact migration coverage now proves canonical v1 Markdown files are automated through the upgrade artifacts phase.
- Installed capability instructions now describe schema and helper discovery through `agentera describe --format json`, `agentera lint`, and the active app-home model instead of manual install-root searches.
- Public `agentera doctor --json` and `agentera hej --format json` now expose app-home fields without `installRoot` compatibility fields, and release validation blocks stale structured output.
- Bare text `hej` now has explicit cross-runtime metadata, an OpenCode exact-match `chat.message` router, and legacy `hej` bridge metadata that points only at explicit slash/package upgrade flows.
- Structured JSON state output now serializes YAML date scalars as ISO strings, preventing `agentera progress --format json` from failing on unquoted progress timestamps.

### Added

- Startup threshold analysis now includes a privacy-safe retained-artifact scan and classifier path for archived lint evidence, emitting only canonical artifact labels, warning categories, salted event labels, aggregate counts, and coverage caveats.
- `agentera decisions --format json` now exposes a clearer DECISIONS.md source contract with `complete_for_returned_full_detail`, `complete_for_normal_deliberation_context`, a decision context truth table, separate missing-full-detail, missing-artifact, filtered-result, satisfaction-review, and compacted-history boundaries, raw artifact access boundaries, and fallback policy so agents can use compacted/missing decision caveats without raw `.agentera/decisions.yaml` reads or inference.
- `agentera hej --format json --capability-context planera` now exposes `source_contract.capability_context.startup_contract`, a bounded compact Planera startup contract with planning levels, step markers, CLI-first orientation, raw plan artifact boundaries, full-plan review/self-audit requirements, handoff expectations, prose authority exceptions, seam-selection rationale, and unsupported-command boundary without adding `agentera planera` or reading `planera/prose.md` at runtime.
- `agentera plan --format json` now exposes a stronger read-only source contract with canonical artifact label, persisted artifact path, `complete_for_normal_startup_evaluation`, complete summary/entry field coverage, raw plan artifact access boundaries, and fallback policy so Planera startup can skip defensive `.agentera/plan.yaml` reads when CLI state is complete; legacy `entries`-shaped artifacts no longer overclaim complete current-plan startup coverage.
- `agentera hej` now surfaces non-confirmed decision satisfaction pressure as one bounded attention item and a structured `decision_attention` JSON payload, preserving decision satisfaction authority, read-only decision state, and existing `next_action` priority.
- `agentera usage` now exposes a supported suite usage analytics namespace over `scripts/usage_stats.py`, preserving default USAGE.md report generation, JSON pass-through, `--corpus`, `--project`, missing-corpus guidance, direct script compatibility, and isolated test write paths without adding `agentera corpus` or profile refresh behavior.
- `agentera verify` now exposes a supported smoke/eval verification namespace with `smoke` targets `installed-skills`, `live-hosts`, `setup-helpers`, and `opencode-bootstrap`, `eval` targets `skills` and `semantic`, stable text/JSON results, safe default offline/dry-run behavior, bounded diagnostics, and preserved direct smoke/eval scripts.
- `agentera validate capability` and `agentera validate artifact` now expose a supported validation namespace for capability and artifact validators, preserving existing direct validator behavior while adding stable text/JSON command results and bounded invalid-input guidance.
- Decision satisfaction tracking now exposes per-entry satisfaction state, provisional evidence, user confirmation metadata, review-needed flags, protected-overflow compaction status, and release-closeout review pressure across the CLI, hooks, audit context, closeout context, and capability guidance.
- Realisera execution context now exposes selected work, task details, acceptance criteria, constraints, verification expectations, artifact update requirements, progress logging requirements, changelog boundary, conservative scope boundary, git boundary, read-only plan-completion sweep metadata, fallbacks, caveats, and a raw-read-last-resort source contract without adding another capability-name CLI command.
- Optimera benchmark context now exposes retained startup benchmark source status, latest report summary, aggregate history, runtime coverage caveats, state-access rates, token-impact estimates, comparison status, bounded recommendation action, manual refresh guidance, privacy boundary, fallbacks, and a raw-read-last-resort source contract without adding `agentera optimera` or another capability-name CLI command.
- Inspektera evidence context now exposes evaluation target, plan criteria, progress verification, docs and health state, TODO state, protected/version boundary checks, compacted decision caveats, attributed residual risks, fallback commands, caveats, provenance, non-empty evidence flags, and a raw-read-last-resort source contract without adding `agentera inspektera` or another capability-name CLI command.
- Dokumentera closeout context now exposes artifact mappings, version policy, TODO blockers, changelog and release boundaries, progress evidence, benchmark evidence or unavailable caveat, non-empty evidence flags, fallback commands, caveats, and raw-read-last-resort policy without adding `agentera dokumentera` or another capability-name CLI command.
- `agentera hej` startup state now carries completeness/source contract behavior, full startup state coverage for plan/docs/progress/TODO/health, docs mapping and source metadata, progress verification metadata, and `--capability-context` fallback policy so capability startup can prefer CLI state before raw artifact access.
- Orkestrera capability context now includes dependency-ready tasks, blocked task reasons, selected next task, task acceptance/evidence summaries, latest progress verification, retry-state provenance, evaluator handoff inputs, fallback commands, caveats, and a raw-read-last-resort source contract.
- Manual `mage bench:startupState` startup state benchmark support now runs the Decision 51 raw-after-CLI metric only after explicit runtime/path approval, stores aggregate history under the user Agentera home, and retains only `runs.jsonl`, `latest-report.json`, and `latest-report.md`.
- Manual startup benchmark runs now use documented runtime-store defaults and `runs.jsonl` watermarks so bare `mage bench:startupState` measures records since the previous successful benchmark for the same runtime scope, while custom stores remain optional overrides.
- Decision 51 startup-overhead analysis now measures raw Agentera artifact access after CLI state calls during capability startup/state gathering, including bare capability names and natural-language handoffs instead of only slash-route startup windows.
- OpenCode corpus extraction now emits current-schema tool call records from `part.data`, allowing startup analysis to observe real `agentera <state>` calls followed by raw reads/greps/globs.
- The default live-host smoke harness now runs non-live Profilera corpus parity fixtures for Claude Code, Codex, OpenCode, and GitHub Copilot, reports absent local stores as bounded `store_absent` statuses, and keeps privacy-sensitive fixture transcript text out of smoke output.
- Profilera corpus tests now prove combined Claude Code, Codex, OpenCode, and GitHub Copilot fixture parity plus bounded missing, locked, sparse, and schema-divergent degradation coverage without transcript leakage.
- Profilera corpus extraction now reads GitHub Copilot `session-store.db` stores read-only, preserves user-before-assistant tied-turn ordering, emits decision-rich prompts, and reports `/chronicle reindex` as bounded sparse-store remediation without transcript leakage.
- Profilera corpus extraction now reads OpenCode `opencode.db` stores read-only and normalizes ordered turns plus decision-rich prompts while unavailable OpenCode storage degrades explicitly.
- Profilera corpus extraction now reports bounded per-runtime discovery status/reason metadata for available, absent, locked, sparse, skipped, and schema-divergent stores without adding a broad `agentera corpus` namespace.
- `agentera lint --artifact <ARTIFACT>` exposes the pre-write self-audit checks through the CLI with stdin/file/text input, bounded text diagnostics, JSON output, and optional `--strict` failures.
- Added an empty-project semantic fixture proving bare `hej` still uses exactly one `agentera hej` dashboard source call and does not fall back to a generic greeting.

### Verified

- D47 app-home vocabulary cleanup closeout is synchronized locally without publication, installed app refresh, profile refresh, tag, remote push, vision edit, objective edit, decision satisfaction-state change, or unsupported capability-name CLI command; independent Task 1 and Task 2 evaluations passed, focused Task 3 verification reported 346 passing tests, and Task 4 metadata validators plus `git diff --check` passed.
- 2.3.12 Realisera execution-context source-contract patch closeout is synchronized locally without publication, installed app refresh, profile refresh, tag, remote push, objective-state mutation, or unsupported capability CLI command introduction; focused CLI/contract tests passed with 181 tests, Realisera capability validation and schema self-validation passed, repository gate/compaction/artifact validation/diff-check gates passed, and PLAN lint remains failed only on the pre-existing advisory verbosity budget.
- 2.3.11 Optimera benchmark-context source-contract patch closeout is synchronized locally without publication, installed app refresh, profile refresh, tag, remote push, objective-state mutation, or real local benchmark execution; focused CLI/contract/Optimera/startup tests passed with 222 tests, Optimera capability validation and schema self-validation passed, independent evaluation found no blocking findings after privacy and runtime-caveat fixes, and the 2.3.12 Realisera execution-context source-contract work is now closed separately.
- 2.3.10 Inspektera evidence-context source-contract patch closeout is synchronized locally without publication, installed app refresh, profile refresh, tag, or remote push; version-bearing package, plugin, registry, lockfile, OpenCode marker, and skill frontmatter surfaces target 2.3.10, while the 2.3.12+ source-contract train remains open.
- 2.3.9 Dokumentera closeout-context source-contract patch closeout is synchronized locally without publication, installed app refresh, profile refresh, tag, or remote push; version-bearing package, plugin, registry, lockfile, OpenCode marker, and skill frontmatter surfaces target 2.3.9, while the 2.3.10+ source-contract train remains open.
- 2.3.6 artifact compaction enforcement patch closeout is synchronized locally without publication, installed app refresh, tag, or remote push; version-bearing package, plugin, registry, lockfile, OpenCode marker, and skill frontmatter surfaces target 2.3.6, while the 2.3.7+ source-contract train remains open.
- 2.3.8 orchestration-context source-contract patch closeout is synchronized locally without publication, installed app refresh, tag, or remote push; version-bearing package, plugin, registry, lockfile, OpenCode marker, and skill frontmatter surfaces target 2.3.8, while the 2.3.9+ source-contract train remains open.
- 2.3.7 decision-context source-contract patch closeout is synchronized locally without publication, installed app refresh, tag, or remote push; version-bearing package, plugin, registry, lockfile, OpenCode marker, and skill frontmatter surfaces target 2.3.7, while the 2.3.8+ source-contract train remains open.
- 2.3.5 install-state reliability patch closeout is synchronized locally without publication, installed app refresh, tag, or remote push; version-bearing package, plugin, registry, lockfile, OpenCode marker, and skill frontmatter surfaces target 2.3.5, while the 2.3.6+ source-contract train remains open.
- 2.3.4 patch release readiness is recorded locally without publication, installed app refresh, tag, or remote push; version-bearing package, plugin, registry, lockfile, OpenCode marker, and skill frontmatter surfaces are aligned.
- PLAN artifact fallback closeout is synchronized without a selected release target:
  focused CLI/contract tests passed with 88 selected tests, `agentera plan
  --format json --fields source_contract` reports
  `complete_for_plan_artifact=true` and `raw_artifact_reads_required=false`, the
  mixed-window benchmark recorded `245` estimated redundant tokens saved versus
  the previous row, and a clean post-fix probe produced zero raw/redundant
  artifact reads in a tiny weak-evidence window.
- Runtime schema coverage and token-impact closeout is synchronized without a selected release target: supported Claude Code and GitHub Copilot fixtures now extract as `ok / records_extracted`, live local `claude-code` and `github-copilot` stores remain separate `schema_divergent` caveats for unsupported/current schemas, durable benchmark outputs record estimator `approx_bytes_div_4_v1`, raw-after-CLI estimated tokens `621`, redundant raw estimated tokens `533`, savings null reason `previous_missing_token_estimates`, CLI behavior rates `0.4444`, 18 total state sequences, and retained recommendation `plan_cli_startup_envelope`; version-bearing files remain unchanged because no release target was selected, and any future bump remains governed by `.agentera/docs.yaml` semver policy.
- CLI startup state envelope closeout is synchronized without a selected release target: TODO, docs, progress, changelog, and plan state record that raw-after-CLI and redundant-raw sequence rates improved from `1.0` to `0.2222`, raw accesses fell from `11` to `2`, redundant raw accesses fell from `8` to `2`, remaining redundant raw access is `PLAN.md` across 2 sequences, `claude-code` and `github-copilot` remain degraded by schema divergence, `codex` and `opencode` are ok, and version-bearing files remain unchanged because no release target was selected.
- Manual startup benchmark state is synchronized without a selected release target: focused fixture tests, Python compile checks, Mage compile/refusal checks, and a temporary-home missing-store Mage run verify persistence, latest-report retention, privacy boundaries, and no repository-local benchmark outputs while the separate CLI startup state-envelope follow-up remains open.
- Manual startup benchmark incremental semantics are fixture-verified: repeated runtime-store runs append aggregate rows that advance `benchmark_watermark_at`, subsequent runs start after the previous watermark, and no-new-record reruns append zero-record rows without rereporting old sequences.
- Shell-rc removal state is synchronized without a selected release target: TODO, docs, progress, changelog, and plan state record completion, stale-remnant handling, and verification evidence while package, plugin, registry, lockfile, OpenCode marker, and skill version-bearing files remain unchanged at the pre-existing `2.3.3` metadata.
- Decision 51 state-access measurement replaces an uncommitted route/intro startup-window draft that found zero qualifying windows and would have closed the startup-envelope follow-up; direct OpenCode analysis showed repeated `CLI state -> raw artifact access` behavior, so the CLI startup state-envelope follow-up is reopened as planning work without version-bearing metadata changes.
- Profilera corpus runtime parity state is synchronized without a selected release target: TODO, docs, progress, changelog, and plan state record completion while package, plugin, registry, lockfile, and skill version-bearing files remain unchanged.
- 2.3.3 patch release readiness is recorded locally without publication, installed app refresh, or remote push; version-bearing package, plugin, registry, lockfile, OpenCode marker, and skill frontmatter surfaces are aligned.

## [2.2.3] · 2026-05-09

### Added

- `agentera hej` now detects stale Profilera profiles with a configurable `AGENTERA_PROFILERA_MAX_AGE_DAYS` threshold, emits an explicit "suggest running profilera" attention item, and exposes structured stale-profile metadata for agents.
- `scripts/smoke_live_hosts.py --live --yes` now covers Claude Code alongside Codex CLI, Copilot CLI, and OpenCode with isolated temporary runtime state and auth/network SKIP handling.
- `scripts/generate_js_install_root_contract.py` now generates and verifies the OpenCode JavaScript install-root contract from `.agentera/install_root_interface_model.yaml`.

### Fixed

- Codex live hook smoke now writes trusted temporary `hooks.state` entries so Codex 0.129.0 executes the wrapper `apply_patch` hooks instead of merely discovering `hooks.json`.
- `agentera upgrade --runtime codex` now writes trusted installed `hooks.state` entries for the copied `~/.codex/hooks.json`, so installed Codex `apply_patch` validation hooks can execute on current Codex builds.

### Verified

- Opt-in live smoke passed after explicit approval: Claude Code skipped for expected auth/subscription access, Codex AGENTERA_HOME/query passed, Codex `apply_patch` hooks fired both PreToolUse and PostToolUse, Copilot AGENTERA_HOME/query passed, and OpenCode AGENTERA_HOME/query passed with real user state restored.

## [2.2.2] · 2026-05-08

### Fixed

- Fresh-project `agentera hej` routing now preserves the first-run visionera handoff while routing saved context without a vision artifact to resonera, preventing repeated hej-to-visionera loops.
- Valid `TODO.md` writes now invoke Resolved-section compaction, preserving open severity sections and type-prefixed summaries while avoiding generated issue IDs.

### Verified

- Focused 2.2.2 evidence is recorded without publication, push, package update, installed app refresh, live install proof, vision edit, or objective edit: hej routing regressions and TODO Resolved compaction hook tests pass in the local checkout.
- Final 2.2.2 release-readiness verification passed in the local checkout: full pytest reported 811 passed, the capability schema contract self-validated, all 12 capabilities validated, changed Python entry points compiled, version surfaces aligned, and routine JSON state outputs parsed. `agentera doctor --json` reports the installed app is stale, so no installed app refresh or live install confidence is claimed.

## [2.2.1] · 2026-05-08

### Fixed

- Completed plan state now distinguishes successfully complete plans from blocked or incomplete plans, so `agentera hej` no longer surfaces stale completed-plan context as active work.
- Full `.agentera/plan.yaml` writes now fail validation when full plans skip adversarial review evidence, design, task acceptance criteria, or non-zero critic findings.
- Bare user messages exactly matching `hej` now route through the Agentera brief path instead of generic greeting behavior.
- Agentera/hej handoff guidance now avoids initial native question menus unless bounded choices are requested, and counts only meaningful non-terminal actions for mid-conversation question-tool prompts.

### Verified

- Focused 2.2.1 evidence is recorded without publication, tag, push, package update, or installed-bundle refresh: completed-plan lifecycle, full-plan validation, exact-`hej` routing, handoff gating, semantic fixtures, and version metadata checks pass in the local checkout.
- Final 2.2.1 verification passed in the local checkout: full pytest reported 806 passed, all 12 Agentera capabilities validated, the capability schema contract self-validated, changed Python entry points compiled, and no vision/objective diff or `v2.2.1` tag was present. Live install proof was not run, so no four-runtime live install confidence is claimed.

## [2.2.0] · 2026-05-07

### Changed

- Maintained diagnostics, tests, and safe label prose now use Decision 44 status, mismatch, check, and stop-condition wording while preserving stable JSON gap labels and compatibility fixtures.
- Capability and protocol instructions now use Decision 44 plain-English wording for status checks, behavioral verification, orchestration, saved context, and docs-first workflow while preserving routing and validation contracts.
- User-facing setup, routing, state, and workflow docs now use plain-English Decision 44 wording for current status, up-to-date state, saved project context, and docs-first workflow while preserving canonical capability names and Decision 43 route aliases.
- Artifact write validation now exposes explicit `RuntimeEventParser`, `ArtifactSchemaValidator`, and `HookCliAdapter` interfaces while preserving the existing hook executable path and runtime adapter behavior.
- Agentera routing and exit-vocabulary documentation now points at schema-backed routing tests and protocol-owned exit signals instead of duplicating trigger or exit values in `SKILL.md`.
- Artifact metadata ownership now routes through canonical artifact schemas plus `references/artifacts/artifact-registry-interface-model.yaml` and `scripts/artifact_registry.py`; capability-local artifact schemas use `artifact_id` plus `local_role`, while cross-capability tests and bounded CLI artifact resolution consume registry facts instead of display-name or path maps.
- Capability validation now treats `skills/agentera/capability_schema_contract.yaml` plus `scripts/capability_contract.py` as the executable schema-rule authority, with validators and tests consuming the loaded model instead of validator-local capability constants.
- Install-root identity and diagnostics now route through the shared `scripts/install_root.py` Module for Python setup, doctor, upgrade, and bundle freshness paths; RuntimeAdapter registry, package manifest registry, and optional generated cross-language contract work remain separate follow-ups.
- `agentera doctor` is now the primary Agentera CLI/install/runtime self-check command, replacing `agentera bundle-status` without a compatibility alias while leaving `agentera health` and inspektera as the artifact and codebase health surfaces.
- Routine state commands now support `--format json|yaml` for agent-ready state envelopes while preserving default human-readable output for `hej`, `plan`, `progress`, `health`, `todo`, `decisions`, `docs`, `objective`, and `experiments`.
- Routine structured state commands now support sparse `--fields FIELD[,FIELD...]` selection over the documented structured output contract, retaining `command` and `status` context and rejecting unsupported fields without partial output.
- `agentera describe --format json|yaml` now exposes runtime CLI introspection for commands, filters, formats, structured fields, Decision 43 slash-route aliases, artifact schemas, and doctor self-check categories while reporting missing discovery facts as explicit gaps.
- Agent-facing CLI inputs now reject unsafe artifact/query names, sparse field names, control-character filters, traversal/URI path values, unsafe docs.yaml artifact path overrides, and unsafe doctor/upgrade roots before reading or writing.
- Capability handoff guidance now uses glyph plus canonical capability labels, reserves `/agentera <alias>` for explicit route documentation, and defines runtime question-tool confirmation semantics for bounded next-step choices.

### Added

- Decision 45 now has an agent-ready state CLI contract at `references/cli/agent-ready-state-contract.yaml`, classifying stable state commands, Decision 43 route-alias exclusions, future `doctor`, `describe`, structured output, field selection, and input-hardening boundaries before executable CLI changes.
- Decision 44 vocabulary coverage now has an executable proof in `tests/test_decision44_vocabulary.py`, scanning current docs, capability prose, maintained tests, diagnostics, and safe labels while requiring explicit reasons for protected terms.
- Decision 44 now has a recorded vocabulary replacement boundary for the pending 2.2.0 cleanup, classifying deprecated wording, allowed uses, and protected compatibility surfaces before bulk prose edits.
- README and vocabulary docs now show exactly one plain `/agentera <alias>` route per canonical capability while keeping alias words out of the CLI state-command surface.
- Schema-backed routing tests now exercise every Decision 43 alias target, preserve canonical capability direct routes, and include a drift fixture proving alias-to-capability changes fail validation.
- Secondary request wording such as `deliberate`, `brainstorm`, `rubber duck`, `brief`, and `what's next` now routes through trigger schemas without expanding the one-primary-alias contract.
- Schema-backed routing tests now observe exact Decision 43 aliases, proving `/agentera status`, `/agentera discuss`, and `/agentera build` route directly while non-exact work phrases stay trigger-driven.
- Capability schema contract now defines the Decision 43 primary `/agentera <alias>` table while preserving Swedish capability names and the state-oriented CLI boundary.
- `agentera doctor` now diagnoses durable bundle status, including stale markers, missing `hej`, pre-argparse CLI failures, unset defaults, and unsafe `AGENTERA_HOME` roots before any write.
- Bare `/agentera` guidance now has a self-healing bundle-refresh path: preview `uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --install-root <root> --dry-run`, require approval, apply the same root with `--yes`, then retry installed `agentera hej`.

### Fixed

- Artifact validation now rejects unsupported plan top-level, header, and scope fields, applies enum checks to singleton artifact groups, and aligns plan lifecycle schema status with the shipped `complete` value.
- `agentera health` now reads the newest health audit consistently with `agentera hej`, with a newest-first regression covering Audit 20 before Audit 10.
- Bare `/agentera` dispatcher guidance now exposes the README-style Hej dashboard contract at the entry boundary, forbids raw source-field briefings, and keeps `agentera hej` as compact caller-owned source data.
- Progress cycle phases now stay within the protocol enum: recent verification-lane cycles and fixtures use `phase: build`, and artifact validation rejects invalid enum values such as `verify`.
- Skill frontmatter now matches the suite version authority from `registry.json`, avoiding stale-version ambiguity during bundle freshness checks.

### Verified

- Decision 45 final pre-closure state is synchronized for 2.2.0: Tasks 1-7 are complete, Task 8 remains pending for conductor evaluation and closure, TODO shows only unrelated follow-ups as open, docs metadata is current, progress has Task 8 verification evidence, and the plan remains active until conductor-owned inspektera PASS. No release publication, tag, push, package update, installed-bundle refresh, or version beyond 2.2.0 is claimed.
- Decision 45 Task 7 compatibility and 2.2.0 release-readiness evidence is recorded without publication or final closure: focused routing, package/runtime registry, capability/protocol, doctor, describe, structured output, field-selection, and hardening checks pass; `bundle-status` remains intentionally unavailable; release policy attaches the work to pending 2.2.0 with no version beyond 2.2.0; local/remote tag, branch push, package update, package publication, and installed-bundle refresh remain unperformed.
- Decision 45 Task 1 contract evidence is recorded without executable CLI behavior changes: the new contract regression validates stable command vocabulary, route-alias separation, doctor self-check scope, and later-task boundaries while Task 1 remains pending for conductor evaluation.
- Decision 45 Task 5 describe evidence is recorded without broad input hardening, release proof, or final state sync: focused tests cover JSON/YAML describe output, route-alias exclusion from CLI commands, schema field IDs including duplicate field names, doctor boundaries, and explicit missing-schema gaps.
- Decision 45 Task 6 input-hardening evidence is recorded without release proof or final state sync: focused tests cover invalid artifact names, field names, filters, docs.yaml path escapes, doctor roots, upgrade roots, and unchanged valid query/upgrade/doctor/describe workflows.
- Decision 45 Task 4 field-selection evidence is recorded without describe or broad input-hardening behavior: focused tests cover sparse JSON/YAML selection for routine and `hej` contract fields, invalid-field rejection, and unchanged human text defaults.
- Decision 45 Task 3 structured-output evidence is recorded without field selection or describe behavior: focused tests cover JSON/YAML parseability and explicit empty-state envelopes for routine state commands, and direct CLI checks parse every required command in both formats.
- Decision 44 plain-English vocabulary cleanup is included in the pending 2.2.0 release without a new version: package/version projections still agree on 2.2.0, vocabulary coverage remains green, the 2.2.0 tag is absent, and the installed durable bundle remains intentionally stale until an approved publication or bundle refresh.
- Decision 44 final pre-closure state is synchronized for 2.2.0: Tasks 1-7 are complete, Task 8 remains pending for conductor evaluation and closure, TODO shows only unrelated follow-ups as open, docs metadata is current, and progress has this verification evidence.
- Decision 44 TODO and evidence state are synchronized for the pending 2.2.0 release: TODO resolution, progress evidence, changelog evidence, and docs metadata now reference the vocabulary cleanup without claiming publication, while optional Claude live-smoke and install-root/generated-contract follow-ups remain open separately.
- Decision 43 alias-routing work is state-synced for 2.2.0: TODO resolution, changelog evidence, progress evidence, docs metadata, and active plan pre-closure state now agree while the installed durable bundle refresh remains an explicit separate follow-up.

## [2.1.0] · 2026-05-05

### Changed

- Agentera dispatcher, hej, realisera, and optimera guidance now prefer top-level state commands and reserve `agentera query` for advanced/custom inspection.
- README, DOCS, PLAN, and PROGRESS now freshness-close the flat State CLI surface with validation evidence.
- `agentera hej` now provides a one-command composite orientation briefing with profile status, health, issue counts, plan progress, objective state, attention items, and the next concrete action for bare `/agentera`.
- Bare `/agentera` continues to render the README-style hej dashboard; `agentera hej` is the compact data layer behind that dashboard, not a user-facing replacement.
- Advanced `agentera query` calls now support `--format json` and `--format yaml` for pipeable custom artifact access while routine state forms remain top-level only.
- Routine Agentera state access now uses top-level CLI commands such as `agentera plan`, `agentera progress`, `agentera health`, `agentera todo`, `agentera decisions`, `agentera docs`, `agentera objective`, and `agentera experiments`; `agentera query` is reserved for advanced custom artifact access.

### Added

- Semantic fixtures can now assert required, forbidden, and exact-count tool calls, including a `/agentera` fixture proving the dashboard renders from exactly one `agentera hej` state-source call without individual state commands or raw artifact reads.

### Fixed

- Artifact validation now treats advisory word budgets as non-blocking and validates progress cycles as newest-first.
- `agentera hej` now selects the newest health audit for dashboard source data and reports a derived health grade alongside worst-dimension detail.

## [2.0.3] · 2026-05-05

### Fixed

- Restored OpenCode plugin loading by exporting the Agentera plugin factory as the default export.
- Strengthened `/agentera` dispatcher guidance so capability work must query project state through the Agentera CLI and preview upgrade dry-runs before applying changes.

## [2.0.2] · 2026-05-05

### Fixed

- Kept `/hej` as the only legacy bridge and changed package refresh to remove package-managed v1 skill entries before installing `/agentera`.
- Corrected stale OpenCode install guidance to include `--skill agentera`.

## [2.0.1] · 2026-05-05

### Fixed

- Added a legacy `/hej` bridge so v1 installs refreshed through `npx skills update` can detect v1 project artifacts and hand users to the v2 `agentera upgrade` flow.
- Updated the package-refresh phase to install the active `/agentera` skill and refresh the legacy `/hej` bridge instead of only updating already-installed skills.
- OpenCode now ships a managed `/hej` bridge command while keeping `/agentera` as the active v2 entry point.

## [2.0.0] · 2026-05-05

### Added

- One bundled `/agentera` skill now exposes all 12 Agentera capabilities through a single entry point.
- Capability schema contract, shared protocol schema, and YAML schemas for project state artifacts.
- Query CLI for artifact discovery and state summaries across plan, progress, decisions, health, docs, session, todo, design, objective, and experiments.
- Idempotent `agentera upgrade` CLI for v1-to-v2 migration, runtime config wiring, stale v1 cleanup, package-update opt-in, JSON output, and setup-doctor postflight.
- Python package entry point so the Agentera CLI can be run through packaged tool installs.
- Decision 42 routing model with bare `/agentera` delegation, capability-name direct routing, trigger priorities, disambiguation, and hej fallback.
- Cross-capability graph validation, v2 semantic eval fixture support, and OpenCode live smoke coverage in the gated live-host harness.

### Changed

- Removed the 12 standalone v1 skill directories from the active distribution and collapsed runtime adapter metadata to the single `skills/agentera` bundle.
- Agent-facing project state moved from Markdown artifacts to structured `.agentera/*.yaml` files while human-facing `TODO.md`, `CHANGELOG.md`, and `DESIGN.md` remain Markdown.
- Root Python scripts and hooks now use `uv run --script` shebangs with PEP 723 metadata, and CI/Lefthook/docs invoke current v2 validators through `uv run`.
- Codex setup no longer writes v1 per-skill `[agents.<name>]` blocks; Codex UI metadata points at the single Agentera bundle.
- OpenCode setup doctor and managed command fixtures now use the single bundled `agentera` skill path instead of v1 per-skill command paths.
- README, UPGRADE, AGENTS, ROADMAP, and runtime docs now describe the v2 single-bundle model and upgrade path.
- Release validation exceeds the revised -10% static dispatch payload target: v2 now measures 315,697 bytes vs the v1 352,213-byte baseline, a 10.4% reduction.
- Claude Code live model-host smoke is excluded from the required v2.0 release harness until Claude Pro/Max or API access is available.
- Checked-in v1 migration backups were removed before release so the repository ships only active v2 state.

### Fixed

- Live smoke temporary Copilot and OpenCode install roots now include the `agentera_upgrade.py` support module required by the packaged query CLI.

### Verified

- Final v2 validation passed on 2026-05-05: full pytest, capability validators, cross-capability graph validation, offline and live smoke, token payload measurement, stale-v1 detection, OpenCode bootstrap, lifecycle metadata validation, packaged CLI smoke, and query CLI checks.

## [1.27.1] · 2026-04-30

### Fixed

- Real `npx skills` install smoke now accepts OpenCode-targeted installs that land in the universal `.agents/skills` directory.

## [1.27.0] · 2026-04-30

### Added

- Install validation now checks bundled support references and offline installed skill bundles before release.
- OpenCode self-healing now restores managed slash commands and repairs broken Agentera skill paths during plugin startup.

### Changed

- Setup doctor reporting now separates OpenCode command drift, skill-path drift, and bundled reference validation drift without mutating files.
- Semantic Skill Evaluation Surface is freshness-closed with fixture contract, offline runner, hej routing oracle, proportional tests, docs, 1.26.0 metadata, and archived plan state aligned.
- Optimera experiment analysis reliability is freshness-closed with guidance, record normalization, target parsing, frontier reporting, integration verification, and 1.25.0 metadata aligned.

## [1.26.0] · 2026-04-30

### Added

- Offline semantic skill evaluation now checks captured skill output against seeded project-state fixtures, starting with hej routing correctness while keeping runtime smoke evals crash-focused.

## [1.25.0] · 2026-04-30

### Added

- Optimera experiment analysis now has a `--frontier` Markdown report with keep rate, best metric, target status, and deterministic top-result ordering.

### Changed

- Optimera guidance now documents analyzer expectations for rich experiment records, fixed stochastic budgets, and per-objective artifact boundaries.

### Fixed

- Optimera experiment analysis now normalizes baseline, kept, discarded, and error records, extracts rich metric values, and parses objective target prose without crashing.

## [1.24.1] · 2026-04-29

### Fixed

- Optimera completed-objective archival now closes achieved objectives, excludes closed objectives from routing, validates per-objective artifacts, and documents the self-contained objective directory lifecycle.
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

Cross-runtime portability release. Standardizes AGENTERA_HOME across Claude Code, OpenCode, Codex, and Copilot; ships idempotent setup helpers for the runtimes without plugin-level env injection; verifies end-to-end inheritance plus SKILL.md compaction execution with a live-host smoke harness; closes the Codex apply_patch real-time-validation gap with a wired hook; historically shipped Codex marketplace install plus per-skill agent stubs that were later retired by the v2 single-bundle cutover; refreshes README/SPEC/structured runtime metadata against current Codex/Copilot capability evidence; revives the dead Copilot session-end hook; documents orkestrera/realisera/optimera dispatch substrates per runtime.

### Added

- **AGENTERA_HOME contract** (SPEC.md Section 7): standardized the env var that names the agentera install root, with a historical per-runtime mechanism table covering Claude Code (bash fallback to `CLAUDE_PLUGIN_ROOT`), OpenCode (`shell.env` plugin hook), Codex (`[shell_environment_policy].set` in `~/.codex/config.toml`), and Copilot shell startup guidance. Current Agentera repair guidance does not edit shell startup files; stale shell lines are user-owned manual cleanup.
- **OpenCode plugin** bootstraps 12 slash commands at plugin init (was previously wired to a phantom hook that never fired) and injects AGENTERA_HOME into every shell-tool subprocess via the `@opencode-ai/plugin` `shell.env` hook.
- **`scripts/setup_codex.py`**: idempotent Codex setup helper that writes `[shell_environment_policy].set.AGENTERA_HOME` to `~/.codex/config.toml`. Stdlib-only; auto-detects install root; supports `--install-root`, `--config-file`, `--dry-run`, `--force`; refuses to overwrite conflicting sibling keys without `--force`.
- **`scripts/setup_copilot.py`**: historically shipped an idempotent Copilot setup helper for shell startup files. Current Agentera setup and repair guidance treats shell startup files as diagnostic-only and will not edit them; stale Agentera lines are user-owned manual cleanup.
- **`scripts/smoke_setup_helpers.py`**: stdlib black-box smoke harness exercising both setup helpers across 11 sequential cases (5 Codex + 4 Copilot + 2 cross-cutting), no live CLI required.
- **`scripts/smoke_live_hosts.py`**: live-host AGENTERA_HOME inheritance and SKILL.md compaction smoke harness for Codex and Copilot. Default mode runs the profilera Codex collection audit and delegates to `scripts/smoke_setup_helpers.py` (no live CLI invocations, no cost). `--live` mode prints a one-line cost estimate and consent prompt, then issues exactly one `codex exec` and one `bash -c '...copilot -p ... --allow-all-tools'` invocation per runtime, each carrying a combined prompt that exercises both AGENTERA_HOME echo and `compact_artifact.py` execution. Current repair behavior must not edit shell startup files; any shell startup references are snapshot-only or manual-cleanup boundaries.
- **Codex `apply_patch` hook config** (`hooks/codex-hooks.json`): PreToolUse + PostToolUse `apply_patch` matchers wire `validate_artifact.py` for real-time artifact validation, parity with Claude Code PostToolUse and OpenCode `tool.execute.after`.
- **`.agents/plugins/marketplace.json`**: Codex marketplace manifest enables `codex plugin marketplace add jgabor/agentera` plus interactive `/plugins` installation of the aggregate Agentera plugin.
- **Historical v1.x Codex agent stubs**: 12 per-skill `agents/<name>.toml` stubs existed before the v2 single-bundle cutover; v2 removes this shape in favor of `skills/agentera`.
- **Historical v1.x `scripts/setup_codex.py --enable-agents`**: previously wrote `[agents.<name>]` entries. In v2 the flag is a compatibility no-op because those per-skill config files no longer exist.
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
- Codex UI metadata now resolves from the plugin install root with guarded profilera limitations
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
- .gitignore: added defensive credential patterns (.env, _.key,_.pem)

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

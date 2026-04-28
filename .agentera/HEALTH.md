# Health

## Audit 16 · 2026-04-28

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, complexity hotspots, test health, version health, artifact freshness, security hygiene, dependency health
**Findings**: 0 critical, 0 warnings, 1 info (0 filtered by confidence)
**Overall trajectory**: ⮉ improving vs Audit 15. The setup bundle plan landed the shared package-root story, read-only doctor, offline smoke evidence, confirmed installer, and 1.21.0 release metadata without breaking validators or tests. The only new risk is concentration in `setup_doctor.py`, which is acceptable until another runtime or installer path expands it.
**Grades**: Architecture [A] | Patterns [A] | Coupling [A] | Complexity [A] | Tests [A] | Version [A] | Freshness [A] | Security [A] | Deps [A]

### Architecture alignment: A

Decision 33's suite-bundle boundary is reflected in aggregate runtime metadata and lifecycle validation. Shared infrastructure lives at the bundle root; skill-local scripts remain in owning skills; single-skill core behavior is still described as independent of suite tools.

### Pattern consistency: A

Executable suite scripts now share uv script headers and empty dependency metadata. Doctor output keeps the existing pass, warn, fail, skip status vocabulary, and installer planning reuses the existing Codex and Copilot helper logic instead of inventing a parallel writer.

### Coupling health: A

Runtime package-shape checks stay centralized in `scripts/validate_lifecycle_adapters.py`, while `scripts/setup_doctor.py` depends only on stdlib code and the existing setup helpers. Tests exercise the doctor mostly through subprocess or public module functions, so internal reshaping remains possible.

### Complexity hotspots: A

#### ⇢ Setup doctor is the new setup hotspot, info (confidence: 65)

- **Location**: `scripts/setup_doctor.py:332`, `scripts/setup_doctor.py:588`, `scripts/setup_doctor.py:969`, `scripts/setup_doctor.py:1184`
- **Evidence**: One 1285-line script now owns smoke checks, four runtime diagnoses, installer planning and writes, report rendering, and CLI flow.
- **Impact**: Current shape is sectioned and tested, but the next writable runtime or live-host branch could make the file harder to change safely.
- **Suggested action**: Keep it whole for now; split doctor, smoke, and installer helpers only when another setup path lands.

### Test health: A

Coverage is proportional to the risk surface: bundle metadata has pass/fail fixtures, script hygiene has one failure per rule, and setup doctor tests cover runtime pass, classified gaps, skips, non-mutation, smoke failure visibility, denied writes, confirmed writes, and idempotent reruns. Full collection reports 477 tests across 17 files.

### Version health: A

The setup feature and fix commits are covered by the `1.21.0` bump, and no `feat` or `fix` commits landed after the bump. Version target scans found no stale `1.20.x` or local `1.22.0` residues in listed suite surfaces.

### Artifact freshness: A

PLAN, PROGRESS, TODO, CHANGELOG, and DOCS were all updated at `2026-04-28T21:55:28+02:00`, after the plan creation date. README setup guidance was updated during Task 7, and this audit updates HEALTH for the post-plan check.

### Security hygiene: A

Secret-pattern hits are limited to inspektera's own documented examples. Setup doctor and smoke subprocess calls use list-form commands with timeouts and no `shell=True`; installer writes are limited to confirmed Codex and Copilot runtime-native config targets.

> This is a lightweight surface scan. For comprehensive security analysis, use dedicated tools: semgrep, Snyk, Bandit (Python), npm audit (Node), or similar.

### Dependency health: A

No new third-party Python dependencies were introduced; executable suite scripts declare `dependencies = []`. The only external runtime dependency remains the pinned OpenCode plugin package in `.opencode/package.json`.

### Trends vs Audit 15

- **Improved**: Architecture and freshness now capture the suite-bundle setup surface rather than two separate setup helpers. Tests grew from 433 to 477 and cover doctor, smoke, installer, package-shape, and uv metadata behavior.
- **Degraded**: none.
- **Stable**: Version, security, and dependency posture remain green.
- **New findings**: `setup_doctor.py` is a large but acceptable setup hotspot.
- **Resolved**: Audit 15's "two-helper shape" note is absorbed into the bundle-owned doctor and installer surface.
- **Carried forward**: Richer live-host proof remains deferred by plan, but default doctor smoke explicitly avoids live model calls.

### Patterns Observed

- Module structure: shared suite infrastructure lives in root `scripts/`, `hooks/`, manifests, and references; behavioral scripts remain inside owning skills.
- Validation ownership: lifecycle/package-shape drift belongs to `scripts/validate_lifecycle_adapters.py`; spec and contract drift stay in `validate_spec.py` and `generate_contracts.py`.
- Testing approach: setup behavior is verified by focused subprocess smoke tests plus public-function fixtures, not by reaching through private runtime internals.
- Dependency patterns: Python remains stdlib-only; runtime-specific metadata carries host requirements rather than adding a common abstraction layer.

## Audit 15 · 2026-04-26

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, complexity hotspots, test health, version health, artifact freshness, security hygiene, dependency health
**Findings**: 0 critical, 0 warnings, 3 info (0 filtered by confidence)
**Overall trajectory**: ⮉ improving vs Audit 14. The Codex+Copilot Completion plan landed two well-factored stdlib helpers, a Python smoke harness covering 11 black-box cases, and a clean 1.21.0 release. Audit 14 finding 1 (DOCS.md staleness) is resolved; finding 3 (live-host inheritance) is narrowed to a smaller residual gap on the runtime CLI side.
**Grades**: Architecture [A] | Patterns [A] | Coupling [A] | Complexity [A] | Tests [A] | Version [A] | Freshness [A] | Security [A] | Deps [A]

### Architecture alignment: A

`scripts/setup_codex.py` and `scripts/setup_copilot.py` slot into the existing repo-level utilities surface alongside `compact_artifact.py`, `usage_stats.py`, and `smoke_opencode_bootstrap.mjs`. They close the user-side install-friction gap on runtimes that have no plugin-level env-injection API, advancing VISION.md's portable-runtime thesis without forking skill behavior.

### Pattern consistency: A

#### ⇢ Two-helper shape is a nascent setup_*.py pattern, info (confidence: 55)

- **Location**: `scripts/setup_codex.py`, `scripts/setup_copilot.py`
- **Evidence**: Both files share `verify_install_root` → `auto_detect_install_root` → `resolve_install_root` → state-classify → `plan_change` → emit-or-write, the same `--install-root` / `--dry-run` / `--force` CLI surface, and identical four-entry canonical verification (scripts/validate_spec.py, hooks/, skills/, SPEC.md).
- **Impact**: At two instances the duplication is correct per YAGNI. A third runtime helper would justify lifting the shared shape into a small shared module.
- **Suggested action**: Defer until a third helper is needed; revisit if Gemini CLI or another runtime requires the same setup pattern.

### Coupling health: A

The new helpers are stdlib-only and import nothing from `hooks/`, `skills/`, or each other. `scripts/smoke_setup_helpers.py` invokes both as black-box subprocesses, so the harness survives helper internals refactors. Test files use the standard `conftest.py` importlib pattern.

### Complexity hotspots: A

`setup_codex.py` (795 lines, 19 functions) and `setup_copilot.py` (717 lines, 16 functions) are the two largest stdlib scripts but stay well-factored: clear section banners, single-responsibility functions, linear `main()` orchestration, no nested-loop hotspots. The 541-line smoke harness uses 11 sequential numbered cases — the right shape for "the harness IS the test."

### Test health: A

#### ⇢ Codex and Copilot live-host AGENTERA_HOME inheritance still untested, info (confidence: 50)

- **Location**: `scripts/smoke_setup_helpers.py`, `tests/test_runtime_adapters.py`
- **Evidence**: 412 → 433 tests (+10 codex, +11 copilot). The smoke harness verifies the WRITE side of the AGENTERA_HOME contract (helpers correctly emit `[shell_environment_policy]` and shell-rc export blocks). Whether Codex and Copilot CLIs actually inherit AGENTERA_HOME at runtime from those files remains unverified by an automated test.
- **Impact**: Narrower than Audit 14 finding 3 (write side is now covered). Future runtime updates could still regress the read-side inheritance without the suite catching it.
- **Suggested action**: Continue treating as a deferred caveat until a live-host harness lands. No standalone action recommended.

### Version health: A

Two minor bumps today (1.19.0 → 1.20.0 → 1.21.0), both justified per `feat = minor`: 1.20.0 carried the AGENTERA_HOME contract plus OpenCode bootstrap, 1.21.0 carries the two setup helpers plus smoke harness. Splitting was correct because Audit 14 had already snapshotted 1.20.0 as a coherent unit. No unbumped commits since 9773f35.

### Artifact freshness: A

Audit 14 finding 1 resolved by T4 (commit 8e57ef4): DOCS.md Index now reads 433 tests across 17 files, the six previously-stale rows show 2026-04-26, and three new Index rows for `setup_codex.py`, `setup_copilot.py`, `smoke_setup_helpers.py` are present. PROGRESS, TODO, CHANGELOG, README, HEALTH all touched today. SPEC.md, DESIGN.md, VISION.md older than the plan, but the owning skills (visualisera, visionera) were not dispatched.

### Security hygiene: A

`setup_copilot.py` writes user shell rc files but the injection surface is well-controlled. Install-root verification rejects malicious paths before any write (a path lacking the four canonical entries fails). `_quote_for_shell` escapes `\` and `"` for bash/zsh/fish, and `_toml_basic_string` handles all TOML 1.0 basic-string escapes plus unicode-escapes control characters. Idempotency anchors on a literal marker comment, so user-written `AGENTERA_HOME` lines stay untouched. No `eval`, `exec`, `os.system`, or `shell=True`; subprocess calls are list-form with hardcoded args.

#### ⇢ PROFILERA_PROFILE_DIR and AGENTERA_HOME injection asymmetry, info (confidence: 60)

- **Location**: `.opencode/plugins/agentera.js:191`, `.opencode/plugins/agentera.js:231`, `SPEC.md` Section 7
- **Evidence**: Carry-forward from Audit 14. PROFILERA_PROFILE_DIR is set by mutating `process.env`; AGENTERA_HOME is set via the `shell.env` hook. Both correct for their consumers, surface still looks inconsistent.
- **Impact**: Same as Audit 14 — readability tax, not a defect.
- **Suggested action**: One sentence in SPEC Section 7 naming the asymmetry as principled. Defer until SPEC.md sees its next substantive edit.

> This is a lightweight surface scan. For comprehensive security analysis, use dedicated tools: semgrep, Snyk, Bandit (Python), npm audit (Node), or similar.

### Dependency health: A

No new third-party dependencies. Both helpers are stdlib-only (argparse, pathlib, re, sys, os, tomllib, NamedTuple). `tomllib` is Python 3.11+ stdlib already implicit in the project. OpenCode Node dep unchanged.

### Trends vs Audit 14

- **Improved**: Freshness B → A (Audit 14's DOCS.md Index/Coverage warning resolved by T4). Tests stay A but the live-host gap narrowed: helpers + smoke harness cover the write side, residual confidence drops 65 → 50.
- **Degraded**: none.
- **Stable**: Architecture A, Patterns A (one new info on shape duplication, advisory only), Coupling A, Complexity A, Version A, Security A, Deps A.
- **Resolved**: Audit 14 finding 1 (DOCS.md Index dates + Coverage line stale).
- **Carried forward**: Audit 14 finding 2 (PROFILERA_PROFILE_DIR vs AGENTERA_HOME asymmetry, conf 60). Audit 14 finding 3 narrowed (live-host inheritance, conf 65 → 50).
- **New findings**: Two-helper shape is a nascent pattern (info, conf 55, advisory).

### Patterns Observed

- Module structure: repo-level `scripts/` is the canonical surface for stdlib utilities. `setup_*.py` is the third archetype after `compact_artifact.py` (artifact compaction), `usage_stats.py` (corpus analytics), and the validators.
- Helper shape: `verify_install_root` → `auto_detect_install_root` → `resolve_install_root` → state-classify → `plan_change` → emit-or-write is now a duplicated-but-parallel structure across two files. Pattern in waiting.
- Idempotency pattern: literal marker comment + line-anchored read/rewrite, with byte-identity preservation of unrelated lines. Both helpers converged on this independently.
- Smoke testing: language matches the system under test (Node smoke for OpenCode JS plugin, Python smoke for Python helpers). Black-box subprocess invocation rather than internal imports.
- Release pattern: same-day double minor bumps remain acceptable when each bump represents a coherent unit; the prior audit snapshot determines the split point.

## Audit 14 · 2026-04-26

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, complexity hotspots, test health, version health, artifact freshness, security hygiene, dependency health
**Findings**: 0 critical, 1 warning, 2 info (0 filtered by confidence)
**Overall trajectory**: stable vs Audit 13. Cross-Runtime Portability landed the AGENTERA_HOME contract cleanly across SPEC, OpenCode, Codex, and Copilot, and 1.20.0 shipped coherent. One DOCS.md staleness gap surfaced because dokumentera updated only the Audit Log, not the Index.
**Grades**: Architecture [A] | Patterns [A] | Coupling [A] | Complexity [A] | Tests [A] | Version [A] | Freshness [B] | Security [A] | Deps [A]

### Architecture alignment: A

SPEC.md Section 7 formalizes AGENTERA_HOME with a per-runtime mechanism table. The 7-23 to 8-24 renumber landed atomically across SKILL.md frontmatter, prose Section refs, validator code, test fixtures, and regenerated contract.md files.

### Pattern consistency: A

#### ⇢ PROFILERA_PROFILE_DIR and AGENTERA_HOME injection asymmetry, info (confidence: 60)

- **Location**: `.opencode/plugins/agentera.js:191`, `.opencode/plugins/agentera.js:231`, `SPEC.md:367`
- **Evidence**: PROFILERA_PROFILE_DIR is set by mutating `process.env` at plugin init; AGENTERA_HOME is set via the `shell.env` hook returning an env fragment merged into shell-tool subprocesses.
- **Impact**: Both correct for their consumers (PROFILE.md is read by helpers in the plugin Node process; AGENTERA_HOME is for shell-tool subprocesses), but the surface looks inconsistent.
- **Suggested action**: One sentence in SPEC Section 6 or 7 names the asymmetry as principled so future readers do not normalize them.

### Coupling health: A

The `.codex-plugin/plugin.json` + `scripts/validate_lifecycle_adapters.py` + `tests/test_runtime_adapters.py` triplet is properly coupled around Section 22 invocationHint flow. Cycle 172 documented and synced all three atomically.

### Complexity hotspots: A

`check_no_bare_claude_plugin_root` is small, single-responsibility, code-block-aware, and unit-tested with one pass plus one fail.

### Test health: A

#### ⇢ Codex and Copilot live-host AGENTERA_HOME inheritance untested, info (confidence: 65)

- **Location**: `tests/test_runtime_adapters.py`, `scripts/smoke_opencode_bootstrap.mjs`
- **Evidence**: The OpenCode `shell.env` branch is smoke-tested. Codex `shell_environment_policy.set` and Copilot rc inheritance are documented but unverified by an automated test against a live host.
- **Impact**: Future runtime updates could regress AGENTERA_HOME propagation under Codex or Copilot without the suite catching it; same caveat pattern as Audit 11's deferred live Copilot/Codex host smoke.
- **Suggested action**: Treat as continuation of the existing live-host caveat; reconsider if a host smoke harness lands.

### Version health: A

12/12 per-skill `plugin.json`, marketplace, registry, root and `.github` Copilot manifests, `.codex-plugin/plugin.json`, and `.opencode/plugins/agentera.js` AGENTERA_VERSION all at 1.20.0. CHANGELOG records three feats, one docs, one refactor coherently.

### Artifact freshness: B

#### ⇉ DOCS.md Index dates and Coverage test count are stale, warning (confidence: 92)

- **Location**: `.agentera/DOCS.md:53-58`, `.agentera/DOCS.md:84`
- **Evidence**: Index rows for Progress, TODO, Changelog, Health, Plan, and DOCS show 2026-04-25 or 2026-04-23 but `git log -1` reports 2026-04-26 for each. Coverage line says "359 tests across 13 files"; actual is 412 tests across 14 test files.
- **Impact**: Plan-relative staleness: dokumentera was dispatched in T3 but updated only the Audit Log section; Index rows and Coverage row carried into the post-plan state. Consuming skills reading DOCS.md see stale ground truth.
- **Suggested action**: Bump six Index rows to 2026-04-26 and update Coverage to "412 tests across 14 files" in a single dokumentera or chore cycle.

### Security hygiene: A

Secret-pattern matches were limited to inspektera's own documented examples. No `eval()`, `exec()`, `os.system()`, or `subprocess shell=True` calls in agentera scripts, hooks, or the OpenCode plugin.

> This is a lightweight surface scan. For comprehensive security analysis, use dedicated tools: semgrep, Snyk, Bandit (Python), npm audit (Node), or similar.

### Dependency health: A

Python remains stdlib-only across validators, hooks, and tests. The OpenCode `@opencode-ai/plugin` Node dependency is unchanged this cycle.

### Trends vs Audit 13

- **Improved**: Cross-runtime portability surface is materially stronger: OpenCode plugin moved from broken-by-phantom-hook to actually working; Codex and Copilot users have copy-pasteable setup snippets backed by verified-source authority; spec validator gained a deterministic guard against future bare `${CLAUDE_PLUGIN_ROOT}` regressions.
- **Degraded**: One new warning under Freshness (DOCS.md Index and Coverage drift). Two new info items (PROFILERA_PROFILE_DIR vs AGENTERA_HOME injection asymmetry, Codex/Copilot live-host coverage gap).
- **Stable**: Validators, version targets, security posture, and dependency footprint held green at the post-1.20.0 baseline.
- **Resolved**: Audit 11 deferred items remained closed; the cross-runtime helper-path defect that motivated the plan is gone.

### Patterns Observed

- Module structure: SPEC primitives are now two adapter-injected env vars (PROFILERA_PROFILE_DIR for profile data, AGENTERA_HOME for install root) plus host-specific adapter manifests; SKILL.md prose stays runtime-agnostic via bash-fallback forms.
- Adapter strategy: each runtime uses its own native, documented mechanism (Claude Code bash fallback, OpenCode `shell.env`, Codex `shell_environment_policy`, Copilot rc export); no custom abstraction layer.
- Testing approach: lint rules added with one-pass + one-fail proportionality; smoke harness covers OpenCode plugin lifecycle; live-host paths for Codex and Copilot remain explicit caveats.
- Release pattern: DOCS.md `feat = minor` policy continues to drive minor bumps; CHANGELOG promotion atomic with the bump cycle.

## Audit 13 · 2026-04-25

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, complexity hotspots, test health, version health, artifact freshness, security hygiene, dependency health
**Findings**: 0 critical, 0 warnings, 0 info (0 filtered by confidence)
**Overall trajectory**: stable vs Audit 12. The completed Copilot marketplace plan preserved the evidence boundary and did not degrade validation, versioning, or artifacts.
**Grades**: Architecture [A] | Patterns [A] | Coupling [A] | Complexity [A] | Tests [A] | Version [A] | Freshness [A] | Security [A] | Deps [A]

### Architecture alignment: A

The marketplace guidance matches the portability thesis: shared skills stay canonical, runtime install surfaces are adapter-specific, and unverified Copilot marketplace availability is not claimed.

### Pattern consistency: A

README, PLAN, PROGRESS, TODO, and CHANGELOG use the same evidence-gated language. Legacy per-skill Copilot entries are observational, while aggregate `agentera` remains future verified-source guidance.

### Coupling health: A

Validation keeps Copilot install semantics in `tests/test_runtime_adapters.py` without adding runtime coupling. Host evidence remains recorded in artifacts, not encoded as unsupported install behavior.

### Complexity hotspots: A

The new marketplace guards are small and proportional: one README pass plus focused failure cases for availability claims, placeholder-as-source, and primary fallback wording.

### Test health: A

Required checks pass: Copilot packaging 7 passed, runtime adapters 26 passed, full pytest 361 passed, lifecycle validation passed, spec validation passed with 0 warnings.

### Version health: A

The active plan introduced docs, test, and chore commits only after the existing 1.18.1 release state. DOCS.md policy correctly required no new bump.

### Artifact freshness: A

PLAN is complete. PROGRESS, TODO, and CHANGELOG record the final no-verified-source outcome, and DOCS.md does not predate the plan creation date.

### Security hygiene: A

No real secret hits were found. Secret-pattern matches are only documented examples in inspektera source, and subprocess usage remains list-form or fixed-path plugin validation.

> This is a lightweight surface scan. For comprehensive security analysis, use dedicated tools: semgrep, Snyk, Bandit (Python), npm audit (Node), or similar.

### Dependency health: A

No dependencies changed during the plan. Python remains stdlib-only for validators and tests; the isolated OpenCode Node dependency surface is unchanged.

### Trends vs Audit 12

- **Improved**: Copilot marketplace guidance is now more explicit: syntax-only placeholder, verified built-in marketplaces, no `agentera` source claim.
- **Degraded**: none.
- **Stable**: Live host caveats remain explicit; validation and artifact freshness stayed green.

### Patterns Observed

- Module structure: shared skill sources remain canonical; runtime adapters expose host-specific metadata and validation guards.
- Evidence pattern: live-host observations are recorded as caveats unless a verified source exists.
- Testing approach: install guidance gets additive negative tests to reject future contradictory wording.
- Release pattern: docs/test/chore marketplace work does not bump versions without verified new install capability.

## Audit 12 · 2026-04-25

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, complexity hotspots, test health, version health, artifact freshness, security hygiene, dependency health
**Findings**: 0 critical, 0 warnings, 0 info (0 filtered by confidence)
**Overall trajectory**: ⮉ improving vs Audit 11. Audit 11 cleanup resolved the prior portability warnings without widening live-host claims.
**Grades**: Architecture [A] | Patterns [A] | Coupling [A] | Complexity [A] | Tests [A] | Version [A] | Freshness [A] | Security [A] | Deps [A]

### Architecture alignment: A

The portability direction is aligned. Section 21 now names top-level provenance plus required `data`, and runtime adapters remain thin metadata or local-validator surfaces.

### Pattern consistency: A

Copilot and Codex profilera caveats are visible through supported local metadata. Codex duplicate policy surfaces are covered by lifecycle validation.

### Coupling health: A

OpenCode path resolution now checks the documented `~/.agents/agentera` root before legacy paths. Copilot one-vs-many hook validation uses one normalized path flow.

### Complexity hotspots: A

`build_corpus()` is no longer the runtime branching hotspot. Runtime extension is localized in the collector registry and shared family runner.

### Test health: A

Full suite passes at 357 tests. Focused Audit 11 tests pass at 101 tests across profilera extraction and runtime adapters.

### Version health: A

Version targets are aligned at 1.18.1 across registry, per-skill plugins, marketplace metadata and non-profilera entries, Copilot, Codex, and OpenCode.

### Artifact freshness: A

PLAN is complete, TODO has Audit 11 items resolved, PROGRESS records the checkpoint, DOCS marks plan artifacts current, and CHANGELOG preserves the host-test caveat.

### Security hygiene: A

Copilot primitive config values with sensitive-looking keys are redacted. Secret scan only matched documented example patterns in inspektera instructions.

> This is a lightweight surface scan. For comprehensive security analysis, use dedicated tools: semgrep, Snyk, Bandit (Python), npm audit (Node), or similar.

### Dependency health: A

No new third-party dependencies were introduced. Python remains stdlib-only, with the existing isolated OpenCode Node package unchanged.

### Trends vs Audit 11

- **Improved**: All Audit 11 warnings resolved: contract shape, metadata drift, OpenCode path drift, hook validation, corpus orchestration, validation coverage, version targets, and redaction.
- **Degraded**: none.
- **Stable caveat**: Live Copilot/Codex host behavior remains untested by design and is preserved as a release caveat.

### Patterns Observed

- Module structure: shared `skills/<name>/SKILL.md` source, with runtime adapters outside the skill core.
- Adapter strategy: local validators guard metadata drift; live-host claims stay deferred until host smoke tests exist.
- Testing approach: pytest covers validators, extractor envelopes, redaction, secondary surfaces, and adapter drift guards.
- Version pattern: DOCS.md semver policy drove a patch bump after fix-scoped cleanup.

## Audit 11 · 2026-04-24

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, complexity hotspots, test health, version health, artifact freshness, security hygiene, dependency health
**Findings**: 0 critical, 9 warnings, 3 info (0 filtered by confidence)
**Overall trajectory**: stable vs Audit 10. Runtime portability moved forward, but collector validation and metadata drift guards need one cleanup pass.
**Grades**: Architecture [B] | Patterns [B] | Coupling [B] | Complexity [B] | Tests [B] | Version [B] | Freshness [B] | Security [B] | Deps [A]

### Architecture alignment: B

The plan matches VISION.md's portable-runtime direction. Shared skill sources remain intact, and runtime adapters stay thin.

#### ⇉ Section 21 record shape conflicts with SPEC, warning (confidence: 80)

- **Location**: `SPEC.md:1011`, `SPEC.md:1168`, `SPEC.md:1191`, `skills/profilera/scripts/extract_all.py:1105`
- **Evidence**: SPEC examples put domain fields at record top level. The extractor wraps them under `data`.
- **Impact**: Consumers written against SPEC may miss record fields.
- **Suggested action**: Flatten records or update SPEC and consumers to bless the `data` envelope.

### Pattern consistency: B

Adapter metadata is mostly consistent. The repeated Codex/profilera policy fields remain a drift risk.

#### ⇉ Copilot profilera gating is documented but not present in Copilot metadata, warning (confidence: 90)

- **Location**: `README.md:31`, `.github/plugin/plugin.json:1`, `.codex-plugin/plugin.json:63`
- **Evidence**: README says Copilot and Codex metadata gate profilera. Copilot metadata only exposes package-level paths.
- **Impact**: Copilot users do not see the native profilera caveat through metadata.
- **Suggested action**: Add supported Copilot metadata if available, or narrow the README claim.

#### ⇉ Codex profilera policy is duplicated across three surfaces, warning (confidence: 75)

- **Location**: `.codex-plugin/plugin.json:63`, `agents/openai.yaml:31`, `skills/profilera/agents/openai.yaml:1`
- **Evidence**: Runtime support, implicit policy, and capability limits are repeated manually.
- **Impact**: Capability wording can drift again.
- **Suggested action**: Validate these fields across all Codex metadata surfaces.

### Coupling health: B

Runtime-specific files remain isolated. Two adapter assumptions should be tightened before another runtime pass.

#### ⇉ OpenCode hook validation can no-op after documented manual install, warning (confidence: 85)

- **Location**: `README.md:64`, `README.md:98`, `.opencode/plugins/agentera.js:175`
- **Evidence**: README clones to `~/.agents/agentera`; plugin defaults to `~/.agents/skills/agentera` unless `AGENTERA_HOME` is set.
- **Impact**: Artifact validation can silently skip if the documented path is used.
- **Suggested action**: Document `AGENTERA_HOME` or align the default path.

#### ⇉ Lifecycle validator skips list-form Copilot hook paths, warning (confidence: 75)

- **Location**: `scripts/validate_lifecycle_adapters.py:65`, `scripts/validate_lifecycle_adapters.py:74`
- **Evidence**: `hooks` may be a string or list. Hook file validation returns unless it is a string.
- **Impact**: Future list-form hook metadata could bypass event and handler checks.
- **Suggested action**: Normalize to a list and validate each path.

### Complexity hotspots: B

`build_corpus()` now carries three runtimes, family status aggregation, exception handling, and validation in one function.

#### ⇉ build_corpus() is a growing orchestration hotspot, warning (confidence: 80)

- **Location**: `skills/profilera/scripts/extract_all.py:1358`
- **Evidence**: One function orchestrates Claude, Copilot, Codex, statuses, errors, and metadata assembly.
- **Impact**: New runtimes will add branch duplication and inconsistent status handling risk.
- **Suggested action**: Extract a small runtime collector abstraction before adding another runtime.

### Test health: B

The full suite passes with 337 tests. New collector tests cover core paths, but validation remains looser than the contract.

#### ⇉ Corpus envelope validation is too shallow, warning (confidence: 85)

- **Location**: `skills/profilera/scripts/extract_all.py:1300`, `tests/test_extract_all.py:690`
- **Evidence**: Validation checks counts and duplicate IDs, but not required metadata fields or family shape.
- **Impact**: Invalid Section 21 metadata can pass Task 6 validation.
- **Suggested action**: Validate `extracted_at`, `adapter_version`, `families`, statuses, and per-runtime consistency.

#### ⇢ Collector tests miss secondary Copilot/Codex paths, info (confidence: 70)

- **Location**: `skills/profilera/scripts/extract_all.py:917`, `skills/profilera/scripts/extract_all.py:1081`, `tests/test_extract_all.py:625`
- **Evidence**: Tests cover Copilot settings and Codex sessions, not Copilot instruction docs, plugin manifests, Codex history, or config redaction.
- **Impact**: Regressions in advertised secondary surfaces could pass.
- **Suggested action**: Add targeted fixtures for each advertised source family path.

### Version health: B

Version values are aligned at 1.18.0 where tests check them. The convention omits one enforced target.

#### ⇉ OpenCode version signal is test-enforced but absent from DOCS version_files, warning (confidence: 80)

- **Location**: `.agentera/DOCS.md:13`, `.opencode/plugins/agentera.js:9`, `tests/test_runtime_adapters.py:219`
- **Evidence**: Tests require `AGENTERA_VERSION` to match registry. DOCS version_files does not list the OpenCode plugin.
- **Impact**: Release instructions can miss a CI-enforced version target.
- **Suggested action**: Add `.opencode/plugins/agentera.js` to DOCS version_files or document the derived marker.

### Artifact freshness: B

Task 8 refreshed TODO, CHANGELOG, PROGRESS, and DOCS. HEALTH needed this audit to replace stale collector wording.

#### ⇉ DOCS Plan index is stale, warning (confidence: 95)

- **Location**: `.agentera/DOCS.md:54`, `.agentera/PLAN.md:3`
- **Evidence**: DOCS says plan date `2026-04-23` and completed. PLAN is `Created: 2026-04-24` and top-level `Status: active`.
- **Impact**: Orientation consumers see contradictory plan state.
- **Suggested action**: Let orkestrera finish plan status, then refresh DOCS Plan row.

#### ⇢ Historical HEALTH collector wording is stale, info (confidence: 90)

- **Location**: `.agentera/HEALTH.md:92`, `.agentera/PROGRESS.md:25`
- **Evidence**: Audit 10 says collectors do not exist. Cycles 137-140 record Copilot/Codex collectors and validation.
- **Impact**: Reading only the prior audit can mislead.
- **Suggested action**: Treat this Audit 11 entry as the resolution marker.

### Security hygiene: B

No committed secrets were found. One collector can copy sensitive local config values into generated corpus data.

#### ⇉ Copilot config extraction can copy sensitive primitive values, warning (confidence: 85)

- **Location**: `skills/profilera/scripts/extract_all.py:902`, `skills/profilera/scripts/extract_all.py:949`, `skills/profilera/scripts/extract_all.py:1066`
- **Evidence**: Copilot JSON signals include primitive values verbatim. Codex config extraction filters sensitive key names.
- **Impact**: Tokens in `~/.copilot/settings.json` could be written to `corpus.json`.
- **Suggested action**: Reuse the Codex sensitive-key filter for Copilot JSON signals and test it.

> This is a lightweight surface scan. For comprehensive security analysis, use dedicated tools: semgrep, Snyk, Bandit (Python), npm audit (Node), or similar.

### Dependency health: A

No new Python dependencies were added. Adapter validation and profilera collectors stay stdlib-only. OpenCode remains isolated behind its existing exact-pinned Node plugin package.

### Trends vs Audit 10

- **Improved**: DOCS coverage and test count are current at 337 tests. Runtime metadata validates across Claude, Copilot, Codex, and OpenCode local checks.
- **Degraded**: Tests A→B and Security A→B because new collector breadth exposed validation and redaction gaps.
- **New findings**: Copilot config redaction, Section 21 schema shape, shallow envelope validation, OpenCode version convention, DOCS Plan row.
- **Resolved**: Audit 10 DOCS coverage warning and collector-unavailable wording are resolved by this plan.

### Patterns Observed

- Module structure: shared skill sources with host adapters in `.claude-plugin/`, `.github/`, `.codex-plugin/`, `agents/`, and `.opencode/`.
- Adapter strategy: local validators catch schema drift, while Copilot/Codex live host behavior remains metadata-level.
- Testing approach: pytest validates metadata and extractor envelopes, but live host smoke tests are still unavailable.
- Collector pattern: bounded runtime probes report missing families instead of inventing records.

## Audit 10 · 2026-04-23

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, complexity hotspots, test health, version health, artifact freshness, security hygiene, dependency health
**Findings**: 0 critical, 1 warning, 2 info (0 filtered by confidence)
**Overall trajectory**: ⮉ improving vs Audit 9. Native Copilot and Codex metadata extends the portability thesis without changing skill sources. Adapter tests raise suite evidence from 299 to 320 passing. Version health improves B→A after the 1.17.0 bump. Freshness drops A→B because DOCS.md coverage still reports the pre-plan test count.
**Grades**: Architecture [A] | Patterns [A] | Coupling [A] | Complexity [A] | Tests [A] | Version [A] | Freshness [B] | Security [A] | Deps [A]

### Architecture alignment: A

The plan matches VISION.md's "any agent CLI tomorrow" direction. Copilot and Codex metadata wrap the shared `skills/<name>/SKILL.md` source rather than forking skill behavior. Codex and Copilot correctly mark `profilera` limited until runtime session corpus collectors exist.

#### ⇢ Native host behavior remains unproven, info (confidence: 85)

- **Location**: `README.md:20`, `.github/plugin/plugin.json:5`, `.codex-plugin/plugin.json:18`
- **Evidence**: Verification covered JSON/YAML structure, paths, policies, and validators. No Copilot or Codex host executed the metadata.
- **Impact**: Runtime behavior could differ from schema assumptions.
- **Suggested action**: Keep as release caveat until live host smoke tests are available.

### Pattern consistency: A

All 12 skills have per-skill Codex metadata with `interface`, `policy`, and `dependencies`. Portable skills allow implicit invocation; `profilera` disables it and names `codex_session_corpus` as unavailable. Aggregate root metadata and plugin metadata repeat the same policy without conflict.

### Coupling health: A

Host-specific surfaces stay outside the skill core: `.github/plugin/`, `.codex-plugin/`, `agents/`, and `skills/*/agents/`. `scripts/validate_lifecycle_adapters.py` is a 130-line stdlib validator and does not import hooks or skill internals. Existing Claude Code and OpenCode checks remain in `tests/test_runtime_adapters.py`.

### Complexity hotspots: A

No new complexity hotspot found. The new lifecycle validator is linear and narrow, with separate Copilot and Codex validators. Adapter tests are branch-heavy by intent but remain organized by runtime boundary.

### Test health: A

Full suite passed: `python3 -m pytest -q` -> 320 passed. New adapter coverage adds one pass and one fail per runtime package or hook unit, plus legacy Claude Code and OpenCode compatibility checks. This is proportional to the plan's branch surface.

### Version health: A

Version audit passed. `registry.json`, all 12 per-skill Claude plugin manifests, `.github/plugin/plugin.json`, `.codex-plugin/plugin.json`, and marketplace top/non-profilera entries are at 1.17.0. Marketplace `profilera` intentionally remains 2.8.0.

### Artifact freshness: B

Freshness is mostly current: PLAN tasks are complete, PROGRESS cycles 129-134 record retries and rollup evidence, TODO has resolved entries for Tasks 1-7, and CHANGELOG [Unreleased] summarizes the plan.

#### ⇉ DOCS.md coverage still reports pre-plan test count, warning (confidence: 95)

- **Location**: `.agentera/DOCS.md:70`, `.agentera/DOCS.md:79`
- **Evidence**: DOCS says `Test suite | tests/ | 2026-04-13` and `263 tests across 12 files`; current verification is `320 passed`, with `tests/test_runtime_adapters.py` present.
- **Impact**: Documentation consumers see stale coverage evidence after a test-bearing plan.
- **Suggested action**: Update DOCS.md Index and Coverage to reflect 320 tests across 13 files.

#### ⇢ PROGRESS.md remains over advisory word budget, info (confidence: 80)

- **Location**: `.agentera/PROGRESS.md`
- **Evidence**: Cycle 134 records the hook advisory: PROGRESS remains around 3114 words after compaction.
- **Impact**: Low. Structural validation passes; this only increases read cost slightly.
- **Suggested action**: Let future cycles compact naturally unless the warning persists after several entries.

### Security hygiene: A

No real secret hits. Pattern scan matched only documented secret examples in inspektera instructions. Dangerous-call scan found list-form `subprocess.run` calls in hooks, tests, and scripts, with no `shell=True`, eval, SQL concatenation, or dynamic shell execution finding.

> This is a lightweight surface scan. For comprehensive security analysis, use dedicated tools: semgrep, Snyk, Bandit (Python), npm audit (Node), or similar.

### Dependency health: A

The plan added no Python dependencies. New validation uses stdlib JSON and pathlib. Existing OpenCode Node metadata remains isolated under `.opencode/`; runtime adapter work did not expand production dependency sprawl.

### Trends vs Audit 9

- **Improved**: Version B→A after 1.17.0. Tests A→A with stronger runtime-adapter evidence. Coupling A→A with native metadata kept outside skill sources.
- **Degraded**: Freshness A→B because DOCS.md coverage was partially stale after test additions.
- **Resolved**: Audit 9 version warning is closed by 1.17.0. Audit 9 OpenCode and compaction findings were addressed before this plan and remain closed.
- **New findings**: DOCS.md coverage staleness warning; live-host runtime caveat info; PROGRESS word-budget advisory info.

### Patterns Observed

- Module structure: shared skill sources with thin host metadata adapters for Claude Code, OpenCode, Copilot, and Codex.
- Adapter strategy: claim only public host capabilities; mark unsupported lifecycle behavior explicitly.
- Testing approach: schema and metadata validation first, live runtime smoke tests still absent for Copilot and Codex.
- Version pattern: plan-level feature work now correctly drives runtime manifests and suite versions together.

## Audit 9 · 2026-04-23

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, complexity hotspots, test health, version health, artifact freshness, security hygiene, dependency health
**Findings**: 0 critical, 3 warnings, 6 info (0 filtered by confidence)
**Overall trajectory**: ⮉ improving vs Audit 8. Complexity C→B (Audit 8's 78-line gate collapsed to 30; analyze() 114→26 lines per cycle 123). Version C→B (6 unbumped down to 1 after 1.15.0 bump). Freshness B→A (HEALTH.md was the only stale artifact, resolved here). Architecture, Patterns, Coupling, Tests, Security stable at A. Dependency assessed for first time at A (Node surface entered via `.opencode/`).
**Grades**: Architecture [A] | Patterns [A] | Coupling [A] | Complexity [B] | Tests [A] | Version [B] | Freshness [A] | Security [A] | Deps [A]

### Architecture alignment: A

12/12 skills at 1.15.0 across registry.json, marketplace.json, and per-skill plugin.json. The `.opencode/` plugin directory is the first concrete exercise of VISION.md's "spec as gravity well" thesis and respects standalone+mesh: skills run with or without it. Linter: 0 errors, 16 advisory warnings.

#### ⇢ opencode plugin version bump discipline undocumented, info (confidence: 60)

- **Location**: `.opencode/plugins/agentera.js:9`, `references/adapters/opencode.md`
- **Evidence**: `AGENTERA_VERSION = "1.15.0"` hardcoded in plugin; adapter doc does not state when this constant must bump relative to `registry.json`.
- **Impact**: Hook behavior can change without a version bump, producing silent version skew between implementation and declared version.
- **Suggested action**: Add a line to `references/adapters/opencode.md` Section 20 stating the plugin version tracks registry.json on any hook-behavior change.

### Pattern consistency: A

All 12 skills pass structural checks. Audit 8's literal `\n` in inspektera/visionera/visualisera frontmatters is fixed (confidence 100). Producer skills (realisera, resonera, inspektera, optimera) all reference `scripts/compact_artifact.py` with correct subcommands per cycle 119. Profile-path annotations consistent across all consumer skills per cycle 120. 16 advisory linter warnings remain (sentence-length, banned-vocabulary in artifact example blocks) and are accepted as readability tradeoffs.

### Coupling health: A

Clean DAG. `hooks/compaction.py` introduced in cycle 119 is stdlib-only, imported by `hooks/session_stop.py` in-process, invoked as subprocess by `scripts/compact_artifact.py`. No circular dependencies. Producer/consumer boundary intact across all 12 skills.

#### ⇢ common.py and validate_artifact.py duplicate artifact path resolution, info (confidence: 95)

- **Location**: `hooks/common.py:68-80` vs `hooks/validate_artifact.py:124-183`
- **Evidence**: Both implement DOCS.md Artifact Mapping parsing independently. 91 lines in common.py, 60 in validate_artifact.py. Unchanged since Audit 7.
- **Impact**: Semantic drift risk if one is updated without the other.
- **Suggested action**: Refactor validate_artifact.py to import from common.py (both in same hooks/ boundary).

### Complexity hotspots: B

Resolved from Audit 8: `check_pre_dispatch_commit_gate()` collapsed from 78 lines to 30 (helpers extracted); `analyze_progress.py::analyze()` went from 114 lines to 26 via 6 per-signal helpers per cycle 123. `scripts/validate_spec.py` shrank from 1367 to 1346 lines. New: `hooks/compaction.py` at 722 lines is well-factored (8 formatter functions, 4 parse helpers, single-responsibility).

#### ⇉ _format_todo_oneline() chains 6+ string transformations, warning (confidence: 75)

- **Location**: `hooks/compaction.py:223-244`
- **Evidence**: 68 non-blank lines for a single formatter applying sequential regex sub, replace, strip, truncate operations on the same variable with interdependent logic.
- **Impact**: Hard to verify correctness of the transformation sequence; fragile to regex edge cases.
- **Suggested action**: Extract per-step helpers (`_strip_checkbox`, `_strip_tildes`, `_extract_summary`) or consolidate into one regex.

#### ⇢ _parse_todo_resolved() reaches nesting depth 5, info (confidence: 70)

- **Location**: `hooks/compaction.py:420-464`
- **Evidence**: Outer `while` → inner `while` → if/elif/else chain reaching depth 5. Detail-line detection spans 8 conditional paths.
- **Impact**: Harder to test individual branches (blank-then-indented cases).
- **Suggested action**: Extract detail-line collection into a helper.

### Test health: A

299 tests passing (+36 vs Audit 8's 263). Cycle 119 added 27 compaction tests; cycle 123 added 7 parser/suggestion/glyph-validator tests. Test:source LOC ≈ 1:9.3. Compaction tests proportional to source (state-machine boundary cases warrant the count).

#### ⇢ hooks/common.py has no dedicated test file, info (confidence: 80)

- **Location**: `hooks/common.py`
- **Evidence**: 4 exported functions (parse_artifact_mapping, resolve_artifact_path, load_artifact_overrides) tested indirectly through session_start/session_stop. Same gap as Audit 6/7/8.
- **Impact**: Failures in artifact path resolution would be harder to isolate.
- **Suggested action**: Add `tests/test_common.py` with targeted cases for each function.

#### ⇢ validate_skill_definition has no direct test, info (confidence: 75)

- **Location**: `hooks/validate_artifact.py:315`
- **Evidence**: Function dispatches to validate_spec.py and generate_contracts.py as subprocesses. Only the classify_file routing is tested, not the dispatch itself.
- **Impact**: Low. Orchestrator of already-tested scripts.
- **Suggested action**: Add an integration test exercising the subprocess routing.

### Version health: B

1.15.0 bumped today (cc91b00, 2026-04-23T19:17). Post-bump: 1 feat (307aa33 opencode bootstrap), 1 refactor (1bf8c18), 2 chore, 3 docs. Feat qualifies for minor bump per DOCS.md policy; refactor is not in the policy mapping and is treated as no-bump.

#### ⇉ 1 unbumped feat commit since 1.15.0, warning (confidence: 80)

- **Location**: commit `307aa33 feat(opencode): bootstrap slash commands from plugin into user config`
- **Evidence**: semver_policy says feat = minor. CHANGELOG.md [Unreleased] already populated with Added/Changed/Fixed entries covering cycles 121-123.
- **Impact**: Version files lag one feat behind actual changes. Age: hours.
- **Suggested action**: Bump to 1.16.0 when the next batch of work lands, or immediately if a release is desired today.

### Artifact freshness: A

Fallback heuristic applies (no active PLAN.md). Pre-audit, HEALTH.md (2026-04-20) was the only artifact older than the latest PROGRESS.md cycle (2026-04-23). This audit resolves it. DECISIONS.md last-modified 2026-04-19 is not stale because resonera has not been dispatched since. TODO.md, CHANGELOG.md, PROGRESS.md, DOCS.md all current.

### Security hygiene: A

No hardcoded secrets, no eval/exec/os.system, no `shell=True`, no dynamic command construction in subprocess or execSync calls. `.opencode/plugins/agentera.js` uses `execSync(\`python3 "${scriptPath}"\`)` with a non-user-derived path — no injection surface. Cycle 118 PROGRESS.md claims credential patterns were added to `.gitignore` but the on-disk file does not contain them.

#### ⇢ .gitignore missing credential patterns, info (confidence: 95)

- **Location**: `.gitignore`
- **Evidence**: Contents: `.claude`, `.opencode`, `docs/`, `__pycache__/`, `*.pyc`, `.leda`. Missing: `.env`, `*.key`, `*.pem`, `credentials*`. Audit 8 treated cycle 118 as resolving this; cycle 118's claim was not reflected on disk.
- **Impact**: Defensive gap; an accidentally created `.env` would not be blocked from staging.
- **Suggested action**: Add `.env`, `*.key`, `*.pem`, `credentials*` to `.gitignore`.

> This is a lightweight surface scan. For comprehensive security analysis, use dedicated tools: semgrep, Snyk, Bandit (Python), npm audit (Node), or similar.

### Dependency health: A

Python: stdlib only across all scripts and hooks. Node: `.opencode/package.json` (new in cycle 122) pins `@opencode-ai/plugin` at exact `1.4.6`. The `.opencode/` directory is gitignored with specific files tracked via `git add -f`.

#### ⇢ No lockfile committed for the opencode plugin dependency, info (confidence: 55)

- **Location**: `.opencode/`
- **Evidence**: `.opencode/package.json` tracked; no `package-lock.json`, `bun.lockb`, or `yarn.lock` present or tracked. Exact version pin in package.json mitigates resolution drift.
- **Impact**: Low. Transitive dep resolution can still vary across installs.
- **Suggested action**: Note in `references/adapters/opencode.md` whether the absence of a lockfile is intentional (plugin dev surface vs. runtime contract), or add one.

### Trends vs Audit 8

- **Improved**: Complexity C→B (two hotspots resolved: check_pre_dispatch_commit_gate 78→30 lines via helper extraction, analyze_progress.py::analyze() 114→26 lines). Version C→B (6 unbumped→1 unbumped after 1.15.0 bump). Freshness B→A (HEALTH.md refreshed by this audit).
- **Degraded**: none.
- **Stable**: Architecture A, Patterns A (literal `\n` resolved — internal improvement within A), Coupling A, Tests A (299 vs 263, same two gaps persist as info), Security A.
- **New dimension**: Dependency health assessed for the first time at A (Node surface entered via `.opencode/`).
- **New findings**: `_format_todo_oneline` 68-line formatter (warning), `_parse_todo_resolved` nesting depth 5 (info), opencode plugin version discipline (info), no opencode lockfile (info).
- **Resolved**: check_pre_dispatch_commit_gate 78-line warning (refactored), analyze_progress.py 114-line function (cycle 123), literal `\n` in 3 frontmatters (resolved in cycle 120 sweep).

### Patterns Observed

- **Adapter pattern emerging**: `.opencode/plugins/agentera.js` (cycle 121-122) is the first concrete implementation of the "spec as portable protocol" thesis. The plugin bootstraps slash commands into OpenCode but each skill still runs standalone — the standalone+mesh principle survived its first non-Claude-Code exercise.
- **Shared primitive for compaction**: cycle 119 extracted what was previously inline prose in producer skills into `hooks/compaction.py` + `scripts/compact_artifact.py`. All four producers (realisera, resonera, inspektera, optimera) converged on the same invocation pattern. This is the pattern of "agent-driven convention silently fails; make it a script and the linter enforces it."
- **Format-drift parser bugs are a recurring class**: cycle 123 caught two sibling regexes (analyze_progress.py header, validate_artifact.py ARTIFACT_HEADINGS) that had silently drifted from the SPEC PROGRESS.md format and returned zero matches. Test fixtures were aligned with the drifted regexes, so tests passed. Risk: other parsers may have the same latent drift. Worth a targeted sweep.
- **Helper-extraction refactor is the established remedy for long functions**: Audit 8 resolved check_severity_levels 98→36 via helpers; Audit 9 resolved check_pre_dispatch_commit_gate 78→30 the same way, and cycle 123 applied the same pattern to analyze_progress.py. The pattern works and is now habitual.
- **Coverage growth has flattened around two persistent gaps**: hooks/common.py and validate_skill_definition. Both are ecosystem-linter-adjacent and would fail loudly if truly broken, which is why they stay info rather than warning, but they've now been open across three audits (6, 7, 8, 9).

## Audit 8 · 2026-04-20

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, complexity hotspots, test health, version health, artifact freshness, security hygiene
**Findings**: 1 critical, 3 warnings, 4 info (0 filtered by confidence)
**Overall trajectory**: stable vs Audit 7. Version B→C (6 unbumped feat/fix commits). Complexity C→C (one hotspot resolved, one new). Tests A→A (263 tests). Architecture, Patterns, Coupling, Security all stable at A.
**Grades**: Architecture [A] | Patterns [A] | Coupling [A] | Complexity [C] | Tests [A] | Version [C] | Security [A] | Artifact freshness [B]

### Architecture alignment: A

Linter: 0 errors, 17 advisory warnings across 12 skills (sentence-length and banned-vocabulary from Section 23). Registry: 12/12 skills at 1.13.0. SPEC.md Sections 22-23 confirmed. Lefthook config correct. CI updated with pytest install and contract freshness check. No structural regressions.

### Pattern consistency: A

All 12 skills pass structural checks. Compaction threshold language present in all producing skills. "Twelve-skill suite" consistent. One minor anomaly:

#### ⇢ Literal `\n` in YAML frontmatter description in 3 skills, info (confidence: 90)

- **Location**: `skills/inspektera/SKILL.md:14`, `skills/visionera/SKILL.md:14`, `skills/visualisera/SKILL.md:14`
- **Evidence**: Trigger list lines end with `,\n  "next phrase"` instead of a real newline. Introduced by the `.md` extension normalization pass (`9daf4b7`).
- **Impact**: Low. The YAML `>` block scalar folds these anyway, but the literal `\n` is visible in the raw file and inconsistent with other skills.
- **Suggested action**: Replace `\n` with actual newline + indentation in the 3 files.

### Coupling health: A

Clean DAG. No circular dependencies. Hooks still use subprocess boundary. validate_spec.py constants grew to 8 (added WORKTREE_DISPATCH_SKILLS) but remain manageable. common.py duplication with validate_artifact.py unchanged (known info from Audit 7).

### Complexity hotspots: C

validate_spec.py grew from 1073 to 1367 lines (+27%). One prior warning resolved; one new warning.

#### ⇉ check_pre_dispatch_commit_gate() is 78 lines with 4 pattern checks, warning (confidence: 85)

- **Location**: `scripts/validate_spec.py:1037-1114`
- **Evidence**: Follows the same structure as check_reality_verification_gate: constant set, early return, 4 pattern checks, error accumulation. Not deeply nested but long.
- **Impact**: Maintenance burden if the gate evolves. Not urgent.
- **Suggested action**: Extract pattern-check helpers if the function grows further.

#### ⇢ validate_spec.py at 1367 lines (approaching 1400 threshold), info (confidence: 85)

- **Location**: `scripts/validate_spec.py`
- **Evidence**: Grew 27% since Audit 7. 35 functions including 22 check functions. Section 23 added 3 new check functions (banned_vocabulary, sentence_length, artifact_writing_conventions).
- **Impact**: Nearing the module-split threshold noted in Audit 7.
- **Suggested action**: No action now. If it crosses 1400, consider splitting by check category.

**Resolved**: check_severity_levels refactored from 98 lines to 36 lines with 4 named helpers (`_find_severity_in_tables`, `_find_severity_in_headings`, `_find_severity_in_section`, `_find_severity_in_mappings`). Prior warning closed.

### Test health: A

263 tests across 12 files, all passing (up from 240). 3 new tests for Check 19. Test:source ratio 1.21:1. Prior gaps unchanged: hooks/common.py has no dedicated test file, validate_skill_definition has no direct test. Neither has worsened.

### Version health: C

#### ⇶ 6 unbumped feat/fix commits since 1.13.0, critical (confidence: 100)

- **Location**: commits `4d394b5`, `c9c2a1a`, `9daf4b7`, `1a7ac34`, `3779c34`, `1dea65e` (3 feat, 3 fix since `319935d`)
- **Evidence**: semver_policy says feat = minor, fix = patch. 3 feat commits require a minor bump to 1.14.0. CHANGELOG.md [Unreleased] is empty.
- **Impact**: Version files report 1.13.0 but 6 bump-qualifying changes have shipped. All version locations are internally consistent but lag behind actual changes.
- **Suggested action**: Bump to 1.14.0, populate CHANGELOG.md [Unreleased] with the 6 changes.

### Artifact freshness: B

No active PLAN.md; using PROGRESS.md fallback. Advisory, not authoritative.

#### ⇢ PROGRESS.md, CHANGELOG.md, TODO.md, HEALTH.md older than most recent work, info (confidence: 55)

- **Location**: `.agentera/PROGRESS.md` (2026-04-13), `CHANGELOG.md` (2026-04-13), `TODO.md` (2026-04-12), `.agentera/HEALTH.md` (2026-04-11)
- **Evidence**: 11 commits landed after these artifacts' last modification dates. PROGRESS.md has no cycle entries for the post-1.13.0 work. CHANGELOG.md [Unreleased] is empty.
- **Impact**: Consuming skills reading these artifacts see a stale snapshot. HEALTH.md is being updated by this audit.
- **Suggested action**: HEALTH.md resolved by this audit. CHANGELOG.md and version bump are the priority. PROGRESS.md cycle entries for the post-plan ad-hoc work are optional.

### Security hygiene: A

Zero hardcoded secrets. Zero eval/exec. All subprocess calls list-form. Lefthook hooks are clean shell wrappers with no injection surface.

#### ⇢ .gitignore missing defensive credential patterns, info (confidence: 80)

- **Location**: `.gitignore`
- **Evidence**: No `.env`, `*.key`, `*.pem`, `credentials*` patterns. No such files exist in the repo.
- **Impact**: Purely defensive. An accidentally created .env would not be blocked from staging.
- **Suggested action**: Add `.env`, `*.key`, `*.pem` patterns to .gitignore.

> This is a lightweight surface scan. For comprehensive security analysis, use dedicated tools: semgrep, Snyk, Bandit (Python), or similar.

### Trends vs Audit 7

- **Improved**: check_severity_levels C→resolved (refactored from 98 to 36 lines with helpers)
- **Degraded**: Version B→C (1 unbumped fix → 6 unbumped feat/fix). Artifact freshness A→B (4 artifacts older than most recent work).
- **Stable**: Architecture A, Patterns A, Coupling A, Tests A (240→263), Security A, Complexity C
- **New findings**: literal `\n` in 3 SKILL.md frontmatters (info), check_pre_dispatch_commit_gate 78 lines (warning), .gitignore credential patterns (info)
- **Resolved**: check_severity_levels 98-line function (refactored)

### Patterns Observed

- Module structure: 12 skills, consistent. validate_spec.py growing as the single linter but still manageable.
- Hook architecture: unchanged. Subprocess boundary intact.
- Testing approach: 263 tests, 1.21:1 ratio. Section 23 checks have 3 tests already. Proportional.
- Version management: post-plan ad-hoc commits accumulated without a version bump. The plan-driven workflow naturally includes bump tasks; ad-hoc work does not.
- Infrastructure maturation: lefthook hooks, CI fixes, and Section 23 conventions are all infrastructure hardening that doesn't show up as cycle entries.

## Audit 7 · 2026-04-11

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, complexity hotspots, test health, version health, artifact freshness, security hygiene
**Findings**: 0 critical, 3 warnings, 5 info (0 filtered by confidence)
**Overall trajectory**: ⮉ improving vs Audit 6. Tests B→A (240 tests, 18/18 linter checks, all scripts covered). Architecture A, Patterns A, Coupling A, Security A. Version B (one unbumped fix commit since 1.8.0). Complexity C (newly assessed; 2 hotspots in data-processing scripts).
**Grades**: Architecture [A] | Patterns [A] | Coupling [A] | Complexity [C] | Tests [A] | Version [B] | Security [A] | Artifact freshness [A]

### Architecture alignment: A

README, SPEC.md, registry.json, and the 12-skill structure are fully aligned. The spec linter passes 0/0 across all 216 checks. All contract files current. No findings. (The CLAUDE.md stale path noted in an earlier draft was already fixed by `a1a88a6` before this audit was written.)

### Pattern consistency: A

All 12 skills have consistent frontmatter, cross-skill integration ("twelve-skill suite"), artifact path resolution, and safety rails sections. Platform annotations applied across all 12 skills. No findings. (The missing annotations in inspektera and planera noted in an earlier draft were already fixed by `a1a88a6` before this audit was written.)

### Coupling health: A

Clean DAG import graph. No circular dependencies. All skill scripts self-contained (stdlib only). Hooks use subprocess boundary to scripts, not imports. Two minor observations:

#### ⇢ validate_spec.py hardcodes 7+ skill-name constants, info (confidence: 80)

- **Location**: `scripts/validate_spec.py:32-112,114-122,126-183,927-929`
- **Evidence**: REQUIRED_REFS, ARTIFACT_CONTRACTS, SCRIPT_PATTERN_CONSUMERS, AUTONOMOUS_LOOP_SKILLS, REALITY_VERIFICATION_ENFORCERS, RECOGNIZED_CAPABILITIES all hardcode skill/capability names. Adding a 13th skill requires editing 4+ constants.
- **Impact**: The linter will silently pass if a new skill is added but not registered. Not a current risk (no skills being added), but a maintenance burden.
- **Suggested action**: Consider deriving REQUIRED_REFS keys from filesystem discovery in a future refactor.

#### ⇢ Duplicated artifact path resolution in common.py and validate_artifact.py, info (confidence: 75)

- **Location**: `hooks/common.py:40-92` vs `hooks/validate_artifact.py:115-174`
- **Evidence**: Both implement artifact path resolution independently with slightly different logic. session_start and session_stop import common.py; validate_artifact.py does not.
- **Impact**: Could diverge over time if resolution conventions change.
- **Suggested action**: Extract shared resolution into common.py and import from validate_artifact.py if the hook runtime's import path permits.

### Test health: A

240 tests across 12 files, all passing. 18/18 linter check functions tested. All 8 skill scripts have dedicated test files (extract_all.py gap resolved since Audit 6). Test:production LOC ratio 1.02:1 (below code-crusher 2:1 gate but proportional per Decision 21). Two minor gaps:

#### ⇢ hooks/common.py has no dedicated test file, info (confidence: 75)

- **Location**: `hooks/common.py`
- **Evidence**: 3 public functions (parse_artifact_mapping, resolve_artifact_path, load_artifact_overrides) tested indirectly through session_start (6 tests) and session_stop (5 tests) but no isolated assertions for all paths.
- **Impact**: Failures in common.py would be harder to diagnose.
- **Suggested action**: Add test_common.py for direct coverage.

#### ⇢ validate_artifact.py::validate_skill_definition has no direct test, info (confidence: 70)

- **Location**: `hooks/validate_artifact.py:265`
- **Evidence**: The function runs validate_spec.py and generate_contracts.py as subprocesses. No test exercises this routing. The 7-line validate_spec_spec wrapper is also untested.
- **Impact**: Low. The function orchestrates already-tested scripts.
- **Suggested action**: Add an integration test that exercises the subprocess routing.

### Complexity hotspots: C

Not assessed in the prior draft; added in validation pass. The codebase has several data-processing scripts with functions exceeding 50 lines. Two warrant warning-level attention; one is informational.

#### ⇉ analyze_progress.py::analyze() is 114 lines with a 5-branch suggestion engine, warning (confidence: 72)

- **Location**: `skills/realisera/scripts/analyze_progress.py:96-209`
- **Evidence**: 114-line function performs velocity, streak, inspiration-rate, and stall detection in a single body. Suggestion generation has 5 conditional branches building diagnostic messages inline. No sub-functions.
- **Impact**: Adding a new progress signal requires editing a deeply-nested conditional block. Not a current risk (the script is rarely modified), but a growth trap.
- **Suggested action**: Extract suggestion-building into a helper per signal type if a new signal is added.

#### ⇉ validate_spec.py::check_severity_levels() is 98 lines with 4-level nesting, warning (confidence: 88)

- **Location**: `scripts/validate_spec.py:342-439`
- **Evidence**: Loop structure: `for skill → for table_match → for row → for term → if match`. Four overlapping regex patterns for table rows, headings, severity sections, and mapping entries.
- **Impact**: The linter is actively maintained (most frequently edited Python file). 4-level nesting makes adding a new severity check error-prone.
- **Suggested action**: Extract per-pattern matchers into named helpers to flatten nesting to 2 levels.

#### ⇢ validate_spec.py is 1073 lines total with 40+ check functions, info (confidence: 85)

- **Location**: `scripts/validate_spec.py`
- **Evidence**: 18 check functions, many 50-80 lines. Largest single file in the project. All check functions pass currently (0 errors, 0 warnings), so this is a maintenance signal, not a defect.
- **Impact**: If the linter continues to grow (new spec sections → new checks), it will become harder to navigate and modify safely.
- **Suggested action**: No action required now. If it exceeds 1400 lines, consider splitting into modules by check category.

### Version health: B

All versions at 1.8.0 (profilera 2.7.0), consistent across 12 plugin.json, registry.json, and marketplace.json. The bump from 1.7.0 was performed in cycle 94 (8c83613). One unbumped `fix` commit since the bump:

#### ⇉ One unbumped fix commit since 1.8.0, warning (confidence: 78)

- **Location**: commit `a1a88a6 fix(docs): update CLAUDE.md spec path to root SPEC.md, add missing platform annotations`
- **Evidence**: `semver_policy: "fix = patch"`. The commit type is `fix`, qualifying for a patch bump to 1.8.1. Two other commits since the bump are `docs` type, which correctly do not trigger a bump.
- **Impact**: Version files report 1.8.0 but a patch-qualifying fix has shipped. Low severity: the fix was documentation-only with no runtime behavior change.
- **Suggested action**: Bump to 1.8.1 per DOCS.md policy, or explicitly reclassify the commit as `docs` in CHANGELOG if the team treats doc-only fixes as non-bumping.

### Artifact freshness: A

No active PLAN.md (archived in cycle 95). Using PROGRESS.md fallback: PROGRESS.md, HEALTH.md, and CHANGELOG.md all modified 2026-04-10 (current). DECISIONS.md modified 2026-04-10 (Decision 26). DESIGN.md last modified 2026-04-02, which predates the Platform Portability plan, but visualisera was not dispatched during that plan. Not stale per the fallback heuristic.

### Security hygiene: A

Zero hardcoded secrets. Zero eval/exec/os.system/shell=True. All 5 subprocess calls use list-form arguments with hardcoded values. No injection vectors. Python stdlib only; no external dependencies to audit.

> This is a lightweight surface scan. For comprehensive security analysis, use dedicated tools: semgrep, Snyk, Bandit (Python), npm audit (Node), govulncheck (Go), or similar static analysis and vulnerability scanning tools appropriate to your stack.

### Trends vs Audit 6

- **Improved**: Tests B→A (171→240 tests, 7→12 files, extract_all.py gap closed, 18/18 check functions covered).
- **Degraded**: Version A→B (one unbumped fix commit). Complexity C (newly assessed; was not tracked in prior audits).
- **New findings**: Complexity hotspots dimension added for the first time (C grade, 2 warnings). Version health downgraded from A (prior drafts missed the unbumped fix commit).
- **Resolved**: extract_all.py untested (now has test_extract_all.py with 320 LOC). DOCS.md stale references (fixed by dokumentera). CLAUDE.md spec path and annotation coverage issues both fixed by `a1a88a6` (these were reported as open in the initial Audit 7 draft but were already resolved at write time).

### Patterns Observed

- **Module structure**: 12 skills in skills/<name>/, each with SKILL.md as single source of truth. Scripts (stdlib only) in skills/<name>/scripts/. Contract files generated from SPEC.md.
- **Hook architecture**: Clean subprocess boundary between hooks and scripts. Hooks share common.py for path resolution. validate_artifact.py stands alone.
- **Testing approach**: Decision 21 proportionality (1 pass + 1 fail per unit). Synthetic markdown test data. Minimal mocking. conftest.py loads scripts via importlib.
- **Dependency management**: Zero external dependencies. All Python scripts use stdlib only. No package manager needed.
- **Version management**: Conventional commits drive semver bumps per DOCS.md policy. Linter constants are the main coupling point for skill-name registration.

## Archived Audits

### Audit 6 · 2026-04-02 (⮉ improving. Tests D→B (171 tests, all 13 linter checks...)

### Audit 5 · 2026-04-02 (⮉ improving. Architecture B (was C), Patterns A (was B),...)

### Audit 4 · 2026-04-01 (first full audit (6 dimensions vs prior 2); architecture ⮋...)

### Audit 3 · 2026-03-31 (⮉ improving vs Audit 2)

### Audit 2 · 2026-03-31 (improving vs Audit 1)

### Audit 1 · 2026-03-30 (first audit (no prior baseline))

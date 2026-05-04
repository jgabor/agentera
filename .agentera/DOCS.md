# Documentation Contract

<!-- Maintained by dokumentera. Last audit: 2026-04-30 (installation reliability checkpoint) -->

## Conventions

```
doc_root: .
style:    technical, concise, sections with tables, no badges
auto_gen:
  - none
  versioning:
  version_files:
    - plugin.json
    - .github/plugin/plugin.json
    - .codex-plugin/plugin.json
    - .claude-plugin/marketplace.json
    - .opencode/plugins/agentera.js
    - registry.json
  semver_policy: "feat = minor, fix = patch, docs/chore/test = no bump"
```

## Artifact Mapping

Skills check this table for path overrides. If an artifact has no entry or
.agentera/DOCS.md is absent, use the default layout: VISION.md, TODO.md, and
CHANGELOG.md at root; all other artifacts in .agentera/.

| Artifact | Path | Producers |
|----------|------|-----------|
| VISION.md | VISION.md | visionera, realisera |
| TODO.md | TODO.md | realisera, inspektera |
| CHANGELOG.md | CHANGELOG.md | realisera |
| DECISIONS.md | .agentera/DECISIONS.md | resonera |
| PLAN.md | .agentera/PLAN.md | planera |
| PROGRESS.md | .agentera/PROGRESS.md | realisera |
| HEALTH.md | .agentera/HEALTH.md | inspektera |
| DOCS.md | .agentera/DOCS.md | dokumentera |
| DESIGN.md | .agentera/DESIGN.md | visualisera |
| SESSION.md | .agentera/SESSION.md | session stop hook |
| PROFILE.md | $PROFILERA_PROFILE_DIR/PROFILE.md (default: $XDG_DATA_HOME/agentera/PROFILE.md) | profilera |
| USAGE.md | $AGENTERA_USAGE_DIR/USAGE.md (default: $XDG_DATA_HOME/agentera/USAGE.md, sibling of PROFILE.md) | scripts/usage_stats.py |

## Index

| Document | Path | Last Updated | Status |
|----------|------|-------------|--------|
| README | README.md | 2026-04-30 | ■ current |
| CLAUDE.md | CLAUDE.md | 2026-04-27 | ■ current |
| Decisions | .agentera/DECISIONS.md | 2026-04-28 | ■ current |
| Vision | VISION.md | 2026-03-31 | ■ current |
| Progress | .agentera/PROGRESS.md | 2026-04-30 | ■ current |
| TODO | TODO.md | 2026-04-30 | ■ current |
| Changelog | CHANGELOG.md | 2026-04-30 | ■ current |
| Health | .agentera/HEALTH.md | 2026-04-30 | ■ current |
| Plan archive | .agentera/archive/PLAN-2026-04-30-installation-reliability-self-healing.md | 2026-04-30 | ■ current |
| DOCS | .agentera/DOCS.md | 2026-04-30 | ■ current |
| Design | .agentera/DESIGN.md | 2026-04-19 | ■ current |
| Ecosystem spec | SPEC.md | 2026-04-28 | ■ current |
| Ideas | docs/IDEAS.md | 2026-03-29 | ■ current |
| Registry | registry.json | 2026-04-30 | ■ current |
| Marketplace manifest | .claude-plugin/marketplace.json | 2026-04-30 | ■ current |
| Codex marketplace manifest | .agents/plugins/marketplace.json | 2026-04-28 | ■ current |
| Copilot plugin manifest | plugin.json | 2026-04-30 | ■ current |
| Copilot repo plugin manifest | .github/plugin/plugin.json | 2026-04-30 | ■ current |
| Codex plugin manifest | .codex-plugin/plugin.json | 2026-04-30 | ■ current |
| OpenCode plugin adapter | .opencode/plugins/agentera.js | 2026-04-30 | ■ current |
| OpenCode adapter reference | references/adapters/opencode.md | 2026-04-30 | ■ current |
| Runtime parity reference | references/adapters/runtime-feature-parity.md | 2026-04-28 | ■ current |
| Codex UI metadata | skills/&lt;name&gt;/agents/openai.yaml; agents/openai.yaml | 2026-04-24 | ■ current |
| Hooks registry | hooks/hooks.json | 2026-04-03 | ■ current |
| Lifecycle adapter validator | scripts/validate_lifecycle_adapters.py | 2026-04-28 | ■ current |
| Semantic eval command | scripts/semantic_eval.py | 2026-04-30 | ■ current |
| Semantic fixture contract | scripts/semantic_fixtures.py | 2026-04-30 | ■ current |
| Semantic eval fixtures | fixtures/semantic/ | 2026-04-30 | ■ current |
| Usage analytics script | scripts/usage_stats.py | 2026-04-26 | ■ current |
| Codex setup helper | scripts/setup_codex.py | 2026-04-26 | ■ current |
| Copilot setup helper | scripts/setup_copilot.py | 2026-04-26 | ■ current |
| Setup helper smoke runner | scripts/smoke_setup_helpers.py | 2026-04-26 | ■ current |
| Setup doctor and installer | scripts/setup_doctor.py | 2026-04-28 | ■ current |
| OpenCode bootstrap smoke runner | scripts/smoke_opencode_bootstrap.mjs | 2026-04-28 | ■ current |
| Live-host smoke runner | scripts/smoke_live_hosts.py | 2026-04-26 | ■ current |
| SessionStart hook | hooks/session_start.py | 2026-04-03 | ■ current |
| Session stop hook | hooks/session_stop.py | 2026-04-03 | ■ current |
| Validation hook | hooks/validate_artifact.py | 2026-04-28 | ■ current |
| Shared hook utils | hooks/common.py | 2026-04-03 | ■ current |
| Test suite | tests/ | 2026-04-30 | ■ current |
| Lefthook config | .lefthook.yml | 2026-04-20 | ■ current |
| CI workflow | .github/workflows/ci.yml | 2026-04-11 | ■ current |

## Coverage

- **Documented**: 12/12 skills have SKILL.md (single source of truth)
- **Undocumented**: 0 skills lack documentation
- **Stale**: none
- **Tests**: 577 tests across 23 files; CI runs on push/PR via GitHub Actions

## Audit Log

### 2026-04-30 (installation reliability checkpoint)

- [freshness] Installation Reliability Self-Healing closed with plan-level PROGRESS, TODO, CHANGELOG, DOCS, and archived PLAN state aligned; active PLAN.md was removed after Tasks 1-8 reached complete · info (fixed)
- [stale] DOCS.md still pointed at an active installation reliability plan and reported 565 tests after release validation collected 577 tests across 23 files; the index and coverage now match the checkpoint state · warning (fixed)

### 2026-04-30 (install health docs)

- [stale] OpenCode quick start still used `--skill '*'`; docs now use
  `npx skills add jgabor/agentera -g -a opencode -y` and state that the plugin
  does not install skills · warning (fixed)
- [gap] Install-health docs did not distinguish package-manager freshness from
  Agentera bundle validation; README and the OpenCode adapter now define the
  separate checks and current doctor boundary · warning (fixed)
- [gap] Managed OpenCode ownership rules were only visible in plugin code and
  smoke tests; docs now name `agentera_managed: true`, `.agentera-version`,
  skipped collisions, and diagnostic-only doctor behavior · warning (fixed)

### 2026-04-30 (semantic eval docs)

- [gap] README and AGENTS.md did not document the separate offline semantic eval
  command, `fixtures/semantic/` location, or smoke-vs-semantic responsibility
  split; both docs now name the command, fixture path, and no-runtime scope ·
  warning (fixed)
- [gap] DOCS.md Index did not track `scripts/semantic_eval.py`,
  `scripts/semantic_fixtures.py`, or `fixtures/semantic/`; the index now covers
  the semantic eval surface and fixture corpus · warning (fixed)

### 2026-04-30 (post-plan coverage refresh)

- [stale] Coverage reported 523 tests after the Optimera analysis reliability
  plan raised collection to 536 tests across 19 files; Coverage and Test suite
  rows now match validation · warning (fixed)
- [freshness] Index rows now point at the 2026-04-30 progress, TODO,
  changelog, health, plan archive, release metadata, and test suite surfaces
  produced by the closed Optimera analysis reliability plan · info (fixed)

### 2026-04-30 (optimera analysis contract)

- [gap] Optimera's skill documentation did not state how rich experiment records
  should be analyzed before analyzer implementation work; it now defines expected
  status, metric, target, plateau, malformed-record, and artifact-boundary behavior · warning (fixed)
- [gap] Stochastic objective guidance did not require fixed per-experiment budgets;
  OBJECTIVE.md measurement guidance now names run count, seed policy, time limit,
  token cap, and sample size as stable budget fields · warning (fixed)

### 2026-04-29 (optimera objective docs refresh)

- [stale] README's state artifact reference listed root and operational artifacts
  but omitted `.agentera/optimera/<name>/OBJECTIVE.md` objective state and
  `.agentera/optimera/<name>/EXPERIMENTS.md` experiment history; it now names
  the self-contained objective directory and excludes root artifacts, registries,
  symlinks, and DOCS fixed mappings · warning (fixed)
- [stale] Coverage still reported 511 tests across 18 files after Task 5 added
  `tests/test_optimera_objective_lifecycle.py`; Coverage now reports 523 tests
  across 19 files and keeps the Test suite row current · warning (fixed)

### 2026-04-29 (post-steelman docs refresh)

- [stale] Coverage still reported 477 tests across 17 files after Audit 17 recorded 511 across 18; Coverage and Test suite rows now match validation · warning (fixed)
- [freshness] Steelman plan artifacts now point at 2026-04-29 progress, changelog, health, TODO, release metadata, and archived plan state · info (fixed)

### 2026-04-28 (setup bundle final verification)

- [checked] Unified setup bundle final checkpoint passed contracts, spec
  validation, lifecycle and package-shape validation, artifact validation
  coverage, setup doctor smoke, default live-host smoke, OpenCode bootstrap
  smoke, Node syntax check, and 477 pytest tests · info (fixed)
- [freshness] PROGRESS, TODO, CHANGELOG, DOCS, and PLAN now summarize the
  completed setup bundle doctor and installer plan, including the Task 4
  runtime-host smoke retry surprise · info (fixed)

### 2026-04-28 (setup bundle docs refresh)

- [stale] README still described the unified doctor and installer as future
  work after `scripts/setup_doctor.py` shipped; setup guidance now recommends
  bundle-first doctor checks, offline smoke evidence, and confirmed installer
  writes · warning (fixed)
- [gap] DOCS.md Index had no row for the setup doctor and still reported 457
  tests; it now tracks the doctor/installer script and 477 collected tests ·
  warning (fixed)
- [checked] Adapter setup notes still preserve runtime-native boundaries:
  granular Copilot installs are core-only, while suite tools require the bundle
  or clone root · info (fixed)

### 2026-04-28 (release state reconciliation)

- [stale] PLAN.md still described the v1.20 release as active and pre-tag
  after `v1.20.0` and `v1.20.1` existed remotely; it now records the pushed
  tag state and marks the plan complete · warning (fixed)
- [stale] PROGRESS.md still pointed to the old publish-next handoff; a new
  cycle records the verified remote refs and out-of-band `1.20.1` patch state ·
  warning (fixed)

### 2026-04-28 (decision numbering hygiene)

- [gap] DECISIONS.md had duplicate Decision 23 entries and mixed ordering;
  active decisions now run 23-33, references are aligned, spec and resonera
  define insertion rules, and the validator rejects duplicate or descending
  decision numbers · warning (fixed)

### 2026-04-28 (runtime onboarding polish)

- [cleanup] README still mixed runtime install, optional hooks, and clone-only
  helper commands; quick start now separates runtime entry points from
  helper-script setup, with the unified installer deferred by Decision 33 ·
  info (fixed)
- [gap] OpenCode quick start implied the plugin alone installed Agentera; it
  now installs skills with `npx skills add` before adding the plugin that
  provides commands and hooks · warning (fixed)

### 2026-04-28 (Codex marketplace visibility)

- [gap] Codex marketplace entries pointed at skill folders instead of the
  aggregate plugin root; the marketplace now exposes one installable Agentera
  plugin and adapter tests guard the path shape · warning (fixed)

### 2026-04-28 (README memory and hooks refinement)

- [cleanup] README underplayed profilera and exposed hook adapter internals in
  user-facing runtime sections; highlighted the memory layer and moved
  low-level runtime claims back to adapter references · info (fixed)

### 2026-04-28 (README feature and hook refinement)

- [cleanup] README feature list still repeated skill names and exposed runtime
  internals too early; refocused it on product capabilities, moved adapter
  details under hooks, and restored glyphs in the skill table · info (fixed)

### 2026-04-28 (README product rewrite)

- [cleanup] README led with dense install/runtime reference material; rewrote it around product promise, visual briefing, quick start, workflows, and compact runtime details · info (fixed)

### 2026-04-28 (README runtime support readability)

- [cleanup] README runtime support and lifecycle matrices were hard to scan; replaced them with per-runtime details blocks that preserve the same claims · info (fixed)

### 2026-04-28 (plan-level release readiness)

- [stale] Coverage line still reported 449 tests after Task 5 full-suite verification passed with 452 tests across 17 files · info (fixed)
- [cleanup] CHANGELOG moved the remaining Copilot/OpenCode hard-gate entries from Unreleased into the single `1.20.0` section · info (fixed)
- [handoff] Final retag and publish required explicit release authorization; authorization was granted after the readiness handoff, with no remote `v1.20*` tags found at preflight · warning (fixed)

### 2026-04-28 (runtime parity reference checkpoint)

- [gap] Release-relevant runtime parity comparison lived only in plan context; added a tracked adapter reference with explicit Claude Code, OpenCode, Copilot, and Codex behavior · warning (fixed)
- [misaligned] README overclaimed Codex lifecycle and hard-gate behavior; it now limits Codex to shipped `apply_patch` validation hooks and names missing final-content reconstruction · warning (fixed)
- [guard] Hard-gate parity language is scoped to reconstructable OpenCode and Copilot artifact candidates; Claude Code and Codex remain advisory validation surfaces · info (fixed)

### 2026-04-28 (OpenCode pre-write gate checkpoint)

- [gap] OpenCode shipped only post-write artifact validation; `tool.execute.before` now blocks invalid reconstructable artifact write/edit candidates before mutation · warning (fixed)
- [guard] OpenCode docs now name the `apply_patch` patchText limitation instead of claiming universal hard-gate parity · info (fixed)
- [verified] OpenCode smoke still proves `session.idle` bookmark writes and `session.created` no-op behavior after adding the pre-write gate · info (fixed)

### 2026-04-28 (Copilot pre-write gate checkpoint)

- [gap] README claimed broad artifact-validation parity before Copilot payload evidence supported every edit shape; docs now limit the claim to reconstructable preToolUse candidates · warning (fixed)
- [gap] Copilot shipped only postToolUse artifact validation, whose output is logging-only; preToolUse now blocks invalid reconstructable artifact edits · warning (fixed)

### 2026-04-27 (OpenCode session-events checkpoint)

- [gap] OpenCode SESSION.md bookmark wiring was absent after phantom direct `session.idle` hook keys were removed; plugin now handles `session.idle` through the generic `event` hook and smoke-tests write/no-op/created-event behavior · warning (fixed)
- [stale] README lifecycle table implied OpenCode session preload was active; it is now explicitly deferred until a supported context-injection path is verified · info (fixed)
- [stale] Coverage line said "438 tests across 17 files"; actual is 441 after OpenCode event-hook smoke and adapter validation coverage · info (fixed)

### 2026-04-27 (1.20.0 release-readiness audit)

- [stale] README.md and AGENTS.md (CLAUDE.md symlink) referenced "Section 21" for the Session Corpus Contract; SPEC.md was renumbered in 1.20.0 (Session Corpus is now Section 22). Four occurrences across README.md (lines 31, 183, 381) and AGENTS.md (line 69) · warning (fixed)
- [gap] README Scripts section omitted `scripts/smoke_opencode_bootstrap.mjs`; closes open TODO `[live-host-smoke-mjs-doc-row]`. Index gained a row for the same script · warning (fixed)
- [stale] Coverage line said "433 tests across 17 files"; actual is 438 (+3 from this session's Codex/Copilot/Claude Code per-turn extractor work; full breakdown lands under [Unreleased] in CHANGELOG when the next release is cut) · info (fixed)
- v1.20.0 scope expanded: per user direction, the Codex/Copilot/Claude Code per-turn extractor fix is folded into 1.20.0 (was previously called out as out-of-scope in the CHANGELOG Note). CHANGELOG Note replaced by a `### Fixed` section covering `[claude-code-extract-duplicate-source-ids]` and `[live-host-smoke-mjs-doc-row]`; both TODOs flipped to Resolved. Later local work superseded that tag checkpoint; final tag handoff is tracked in the 2026-04-28 plan-level readiness note.

### 2026-04-26 (Live-Host Verification Task 5)

- [gap] DOCS.md Index missing row for `scripts/smoke_live_hosts.py` (T2-T4 harness shipped without an Index entry) · warning (fixed)
- [gap] README Codex setup section had no manual verification protocol; users without `--live` access (no auth, no API budget, behind firewall) had no documented path to verify AGENTERA_HOME inheritance · warning (fixed)
- [gap] README Copilot setup section had no manual verification protocol; same untested path for non-`--live` users · warning (fixed)
- [gap] README Scripts section did not enumerate `scripts/smoke_live_hosts.py` alongside `validate_spec.py`, `eval_skills.py`, `usage_stats.py`, `setup_codex.py`, `setup_copilot.py`, and `smoke_setup_helpers.py`; default-mode and `--live` cost semantics were undocumented · warning (fixed)

### 2026-04-26 (Codex+Copilot Setup Helpers Task 4)

- [gap] DOCS.md Index missing rows for `scripts/setup_codex.py`, `scripts/setup_copilot.py`, and `scripts/smoke_setup_helpers.py` (T1+T2+T3 helpers shipped without Index entries) · warning (fixed)
- [gap] README Codex and Copilot setup sections did not surface the new helpers as the recommended path; manual snippets were the only documented option · warning (fixed)
- [gap] README Scripts section did not enumerate the new helpers alongside `validate_spec.py`, `eval_skills.py`, and `usage_stats.py` · warning (fixed)
- [stale] Audit 14 finding 1: Index dates for Progress, TODO, Changelog, Health, Plan, and DOCS reflected pre-2026-04-26 commits despite same-day commits to each artifact · warning (fixed)
- [stale] Audit 14 finding 1: Coverage line said "359 tests across 13 files"; actual is 433 across 17 (412 post-1.20.0 baseline + 10 Codex helper tests + 11 Copilot helper tests) · warning (fixed)

### 2026-04-26 (Cross-Runtime Portability Task 3)

- [gap] README.md alternative install methods lacked AGENTERA_HOME setup steps for Codex (`~/.codex/config.toml` `[shell_environment_policy]`) and Copilot (shell rc export); SPEC Section 7 mechanism table needed user-facing surface · warning (fixed)
- [gap] .codex-plugin/plugin.json `codex.limitations` array did not flag the AGENTERA_HOME setup requirement · warning (fixed)
- [gap] plugin.json (Copilot root) and .github/plugin/plugin.json descriptions did not flag the AGENTERA_HOME setup requirement · warning (fixed)

### 2026-04-26 (Suite Usage Analytics Task 4)

- [gap] DOCS.md Artifact Mapping missing USAGE.md (new global artifact, sibling of PROFILE.md, produced by `scripts/usage_stats.py`) · warning (fixed)
- [gap] DOCS.md Index missing `scripts/usage_stats.py` row · info (fixed)
- [gap] README.md had no Scripts section listing repo-level utilities (`validate_spec.py`, `eval_skills.py`, `usage_stats.py`) · warning (fixed)
- [gap] CLAUDE.md (symlink to AGENTS.md) Python scripts section did not list `scripts/usage_stats.py` · warning (fixed)

### 2026-04-25 (Copilot packaging fix)

- [gap] Current-checkout Copilot plugin loading rejected `../../skills`; root `plugin.json` now loads shared `skills/` inside plugin root · info (fixed)

### 2026-04-25 (Live Copilot/Codex smoke)

- [gap] Live host caveat narrowed: Codex `$hej` and installed Copilot skills work, but current-checkout Copilot plugin loading rejects `../../skills` · info (deferred)

### 2026-04-25 (Audit 11 freshness checkpoint)

- [stale] Audit 11 PLAN, TODO, PROGRESS, and CHANGELOG needed one current completed state after Tasks 1-7 passed · warning (fixed)
- [gap] Live Copilot/Codex host behavior remains untested and must stay explicit until smoke-tested · info (deferred)

### 2026-04-24 (Task 6 profilera integration)

- [stale] README.md and Codex metadata still described profilera as missing Copilot/Codex collectors after collectors landed · warning (fixed)
- [gap] DOCS.md Coverage test count predated Task 6 envelope validation fixtures · warning (fixed)

### 2026-04-24 (Task 1 runtime install audit)

- [stale] README.md listed non-existent `claude plugin add` flow instead of marketplace add plus plugin install · critical (fixed)
- [misaligned] README.md mixed plugin distribution paths with direct skill-folder loading for Copilot, Codex, and OpenCode · warning (fixed)
- [misaligned] README.md hook table over-specified parity for runtimes with partial or experimental lifecycle support · warning (fixed)

### 2026-04-24 (Audit 10 follow-up)

- [stale] DOCS.md Coverage test count said 263 across 12 files, actual 320 across 13 after runtime adapter tests · warning (fixed)
- [stale] DOCS.md Index dates for Progress, TODO, Changelog, Health, Plan, and Test suite predated Copilot/Codex plan updates · warning (fixed)
- [stale] DOCS.md Plan row said archived while a completed active PLAN.md exists · info (fixed)

### 2026-04-20 (Audit 8, post-1.13.0)

- [stale] CHANGELOG.md [Unreleased] empty despite 6 bump-worthy commits since 1.13.0 · warning (fixed)
- [stale] DOCS.md Coverage test count said 240 across 12 files, actual 263; CI gating note outdated · warning (fixed)
- [stale] DOCS.md Index dates for HEALTH.md, SPEC.md, Test suite showed pre-1.13.0 dates · warning (fixed)
- [gap] CLAUDE.md repo layout missing .lefthook.yml · info (fixed)
- [stale] DOCS.md last audit date said 2026-04-10 post-1.8.0 · info (fixed)
- [gap] DOCS.md Index missing .lefthook.yml row · info (fixed)

### 2026-04-10 (Audit 7, post-1.8.0)

- [stale] DOCS.md Index "Ecosystem spec" path said `references/the spec.md`, renamed to SPEC.md at repo root in Decision 26 · critical (fixed)
- [stale] DOCS.md Coverage test count said 233 across 10 files, actual is 240 across 12 files (+4 platform-annotation tests, +generate_contracts and hook tests) · warning (fixed)
- [stale] DOCS.md Index dates for 7 entries showed 2026-04-02/03, updated to 2026-04-10 for files changed by Platform Portability plan · warning (fixed)
- [stale] DOCS.md last audit date said 2026-04-03 post-1.6.0, now post-1.8.0 · info (fixed)

### 2026-04-03 (Audit 6, post-1.6.0)

- [gap] DOCS.md Artifact Mapping missing SESSION.md (12th artifact, Decision 23) · critical (fixed)
- [stale] DOCS.md Coverage said 171 tests across 7 files, actual is 233 across 10 · warning (fixed)
- [gap] DOCS.md Index missing 5 hooks files (hooks.json, session_start.py, session_stop.py, validate_artifact.py, common.py) · warning (fixed)
- [stale] README.md inspektera description says "six dimensions", now 9 · warning (fixed)
- [stale] README.md artifact reference says "eight operational files", now nine (SESSION.md) · warning (fixed)
- [gap] README.md artifact table missing SESSION.md row · warning (fixed)
- [stale] CLAUDE.md hooks/hooks.json described as "PostToolUse hook registry", registers all 3 hooks · warning (fixed)
- [gap] CLAUDE.md repository layout missing hooks/session_start.py, hooks/session_stop.py, hooks/common.py · warning (fixed)
- [stale] CLAUDE.md "eight operational files" should be nine · warning (fixed)

### 2026-04-03 (Audit 5)

- [gap] CLAUDE.md repo layout missing tests/ directory · warning (fixed)
- [stale] DOCS.md HEALTH.md row showed stale status, Audit 6 updated it · warning (fixed)
- [stale] CHANGELOG.md [Unreleased] empty despite 7 post-1.5.0 commits · warning (fixed)
- [misaligned] the spec Section 16 orkestrera row described proportionality forwarding instead of anti-bias constraint · warning (fixed)
- [misaligned] the spec line 5 comment had hyphen instead of underscore in script name · info (fixed)
- [stale] DOCS.md DTC comment referenced ISSUES.md instead of TODO.md · info (fixed)
- [gap] DOCS.md Index missing test suite row · warning (fixed)
- [stale] DOCS.md Coverage note outdated, missing test count and gaps · warning (fixed)

### 2026-04-02 (Audit 4)

- [stale] README.md line 52 referenced /loop without mentioning /orkestrera as primary autonomous execution method · warning (fixed)
- [misaligned] README.md ecosystem diagram showed orkestrera → realisera but omitted orkestrera ↔ inspektera evaluation link · warning (fixed)
- [misaligned] README.md and the spec.md VISION.md consumers missing orkestrera (reads during bootstrap) · warning (fixed)
- [stale] DOCS.md coverage notes referenced CLAUDE.md and README.md staleness already resolved by cycles 72-77 · warning (fixed)
- [stale] DOCS.md Index dates from 2026-03-31 for files updated 2026-04-02 · warning (fixed)
- [stale] DOCS.md last audit date said 2026-03-31 · info (fixed)
- [stale] DOCS.md Plan entry showed active but plan was archived · info (fixed)

### 2026-03-31 (Audit 3)

- [stale] the spec.md + all 11 SKILL.md say "ten-skill", actually eleven after hej · critical (fixed)
- [gap] DOCS.md Index listed 6 documents, missing 6 that exist (VISION, PROGRESS, ISSUES, HEALTH, DESIGN, the spec) · critical (fixed)
- [stale] marketplace.json description missing hej and visualisera activities · warning (fixed)
- [misaligned] DOCS.md version_files path had erroneous space · warning (fixed)
- [stale] ISSUES.md resolved items appeared after empty "## Open" heading · warning (fixed)
- [misaligned] registry.json inspirera said "an external link" vs plural elsewhere · warning (fixed)
- [stale] DOCS.md Index used plain text status instead of visual tokens · warning (fixed)
- [gap] CLAUDE.md Key conventions missing visual identity and versioning · info (fixed)
- [stale] HEALTH.md Audit 2 findings all resolved but artifact not re-audited · info (noted)
- [stale] DOCS.md last audit date said 2026-03-30 · info (fixed)

### 2026-03-30

- [stale] DOCS.md was flat index, upgraded to three-layer documentation contract · info (fixed)
- [stale] README DOCS.md row said "dokumentera, inspektera", now consumed by all skills · warning (fixed)

### 2026-03-29

- [stale] README.md said "Six skills", actually nine · critical (fixed)
- [stale] CLAUDE.md said "Four skills" then "eight skills", actually nine · critical (fixed)
- [stale] CLAUDE.md "What this is" named only 4 of 9 skills · critical (fixed: defers to README)
- [stale] marketplace.json description undersold the suite · critical (fixed)
- [stale] registry.json truncated descriptions for optimera, resonera, dokumentera · warning (fixed)
- [misaligned] plugin.json descriptions for inspirera/realisera/visionera diverged from canonical · warning (fixed)
- [misaligned] README.md OBJECTIVE.md listed resonera as maintainer; only optimera maintains it · warning (fixed)
- [redundant] Skill ecosystem described in both README.md and CLAUDE.md · warning (fixed: CLAUDE.md now defers to README)
- [redundant] Repository layout duplicated in both files · warning (kept: different audiences)

<!--
Status values:
  ■ current    · doc accurately reflects implementation
  ▣ stale      · code changed since doc was last updated
  □ missing    · module/feature has no documentation
  ▸ intent     · doc written before code (DTC-first), not yet implemented
  ▸ generated  · auto-generated by tooling listed in Conventions.auto_gen

Audit finding types:
  gap         · documented but not implemented
  stale       · code changed, docs not updated
  redundant   · same information in multiple places
  misaligned  · docs contradict implementation

Severity:
  critical · will cause user errors
  warning  · may cause confusion
  info     · minor issue

Sections:
  Conventions      · project-level doc config (doc_root, style, auto_gen, versioning)
  Artifact Mapping · canonical-to-path lookup for skill state files
  Index            · document registry with status tracking
  Coverage         · quantitative doc health summary
  Audit Log        · timestamped findings from dokumentera audits

DTC principle:
  If code diverges from docs, the code is wrong. File to TODO.md, don't update docs
  to match broken code. Exception: if the doc is genuinely wrong (outdated assumption),
  fix the doc explicitly.
-->

# Plan: Optimera Experiment Analysis Reliability

<!-- Level: full | Created: 2026-04-30 | Status: complete -->
<!-- Reviewed: 2026-04-30 | Critic issues: 12 found, 12 addressed, 0 dismissed -->

## What

Make optimera experiment analysis reliable on real objective artifacts. Add a frontier report for quick experiment progress review.

## Why

Inspirera found autoresearch's results ledger makes research progress inspectable. Agentera can get the same signal from EXPERIMENTS.md without adding TSV sidecars.

## Constraints

- Preserve `.agentera/optimera/<name>/` as the objective boundary.
- Do not edit locked harnesses or historical objective artifacts.
- Default analyzer output preserves existing top-level keys and value types.
- Only corrected counts, metrics, targets, and additive diagnostics may change.
- Keep helper scripts stdlib-only with no new runtime dependencies.
- Documentation work follows dokumentera and keeps DOCS coverage current.
- Test proportionality: one pass plus one fail per unit, with stated parser edge expansions.

## Scope

**In**: Optimera analysis guidance, analyzer behavior, focused tests, frontier report output, release metadata, plan freshness.
**Out**: Objective layout changes, root objective artifacts, registries, symlinks, historical artifact rewrites, live eval behavior changes.
**Deferred**: TSV sidecar export, generated progress images, broad metric schema redesign.

## Design

Document analyzer expectations first. Parser work uses fixtures derived from current realisera-token artifacts, with live artifacts as smoke evidence. Normalize experiment records separately from objective target extraction. Frontier mode is additive: `--frontier` writes Markdown to stdout, while default mode stays JSON only. Release metadata moves to `1.25.0` because this plan includes feature work.

## Tasks

### Task 1: Document Analysis Contract

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN optimera users read guidance WHEN an objective has rich experiment records THEN expected analyzer behavior is clear.
▸ GIVEN stochastic objectives are planned WHEN budget guidance is read THEN fixed per-experiment budgets and artifact boundaries are stated.
▸ GIVEN documentation coverage is checked WHEN `.agentera/DOCS.md` is read THEN touched optimera docs are indexed or covered.
▸ GIVEN skill validation runs WHEN `python3 scripts/validate_spec.py --skill skills/optimera/SKILL.md` completes THEN no new errors appear.

### Task 2: Normalize Experiment Records

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN fixture-derived records contain baseline, kept, discarded, and error outcomes WHEN analysis runs THEN statuses normalize consistently.
▸ GIVEN rich metric prose and tables exist WHEN analysis runs THEN before, after, delta, current, and trajectory values are extracted when present.
▸ GIVEN unknown or missing record fields WHEN analysis runs THEN diagnostics are additive and no traceback occurs.
▸ GIVEN focused tests run WHEN `python3 -m pytest -q tests/test_analyze_experiments.py` completes THEN status and metric units meet proportional coverage.

### Task 3: Harden Objective Target Extraction

**Depends on**: Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN fixture-derived objectives contain closed status and target prose WHEN analysis runs THEN direction and target context are extracted without crashing.
▸ GIVEN targetless or malformed objective prose WHEN analysis runs THEN target fields are absent and diagnostics explain the missing data.
▸ GIVEN live realisera-token artifacts are analyzed WHEN the documented command runs THEN it exits 0 and reports corrected history.
▸ GIVEN focused tests run WHEN objective parsing tests execute THEN target pass/fail and malformed edge cases are covered.

### Task 4: Add Frontier Report Mode

**Depends on**: Task 3
**Status**: ■ complete
**Acceptance**:
▸ GIVEN `--frontier` is requested WHEN the analyzer reads experiment history THEN stdout is Markdown and not mixed with JSON.
▸ GIVEN default mode is used WHEN the analyzer runs THEN top-level JSON keys and value types remain compatible.
▸ GIVEN metric direction is known WHEN the report ranks results THEN best metric and improvements use that direction.
▸ GIVEN equal improvements exist WHEN top results are ordered THEN ordering is deterministic.
▸ GIVEN focused tests run WHEN frontier tests execute THEN one pass and one fail cover the mode.

### Task 5: Verify Analysis Integration

**Depends on**: Task 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN optimera's documented analyze command is run WHEN real artifacts are used THEN output is useful for Step 2 history analysis.
▸ GIVEN existing eval smoke commands run WHEN analyzer changes are present THEN behavior outside frontier mode is unchanged.
▸ GIVEN validation runs WHEN spec, contract, focused-test, and full-test checks complete THEN they pass.

### Task 6: Bump Release Metadata

**Depends on**: Task 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN DOCS.md versioning policy WHEN version-bearing files are checked THEN every versioned target reports `1.25.0`.
▸ GIVEN release notes are checked WHEN CHANGELOG.md is read THEN analyzer repair, frontier report, and guidance updates are represented.
▸ GIVEN runtime manifests are checked WHEN version-bearing targets are inspected THEN every version field agrees on `1.25.0`.

### Task 7: Plan-Level Freshness Checkpoint

**Depends on**: Task 6
**Status**: ■ complete
**Acceptance**:
▸ GIVEN this plan's work has shipped WHEN CHANGELOG.md is checked THEN it records the user-facing impact of Tasks 1-6.
▸ GIVEN this plan is otherwise complete WHEN PROGRESS.md is checked THEN it has one aggregate cycle entry summarizing the plan and validation.
▸ GIVEN this plan is otherwise complete WHEN TODO.md is checked THEN no stale open item remains for analyzer reliability work.
▸ GIVEN this plan is complete WHEN archived THEN `.agentera/archive/PLAN-2026-04-30-optimera-experiment-analysis-reliability.md` records all tasks complete.
▸ GIVEN this plan is archived WHEN `.agentera/PLAN.md` is checked THEN the active plan is absent per the documented lifecycle.

## Overall Acceptance

▸ GIVEN current realisera-token optimera artifacts WHEN experiment analysis runs THEN it produces useful JSON without crashing.
▸ GIVEN experiment history contains kept and discarded work WHEN analysis runs THEN counts, metrics, and plateau signal match the artifacts.
▸ GIVEN users request a frontier view WHEN the report runs THEN keep rate, best metric, and top improvements are visible.
▸ GIVEN stochastic or fixed-budget objectives are planned WHEN optimera guidance is read THEN budget and artifact-boundary expectations are clear.
▸ GIVEN release and validation checks run WHEN the plan completes THEN validators, tests, and version metadata are current.

## Surprises

No plan-level surprises.

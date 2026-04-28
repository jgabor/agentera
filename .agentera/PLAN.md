# Plan: Unified Setup Bundle Doctor And Installer

<!-- Level: full | Created: 2026-04-28 | Status: active -->
<!-- Reviewed: 2026-04-28 | Critic issues: 3 found, 3 addressed, 0 dismissed -->
<!-- Revised: 2026-04-28 | Reason: Decision 33 bundle-first ownership refinement -->

## What

Build the post-1.20 setup surface from Decision 33 around an installable Agentera suite bundle. Define the shared package root, make shared tools available without a clone, add a non-mutating doctor, then add a confirmed-write installer.

## Why

Agentera's portable-runtime story should feel like one suite, not four fragmented setup paths. Marketplace users should not need a git clone to run shared setup tools. Trust comes first: users and future agents should inspect setup state before any tool mutates runtime configuration.

## Constraints

- Preserve runtime-native adapter surfaces for Claude Code, OpenCode, Copilot CLI, and Codex CLI.
- Keep behavioral skill scripts inside their owning skills.
- Keep suite infrastructure out of any one behavioral skill.
- Make aggregate suite installs carry shared tools without requiring a clone.
- Keep single-skill installs functional for core skill behavior.
- Keep doctor mode non-mutating by default.
- Require explicit confirmation before installer writes user config.
- Avoid live model calls by default; live host checks may skip when unavailable.
- Extend existing validator and smoke surfaces before adding new ad hoc checks.

## Scope

**In**: suite bundle/root definition, runtime package shape validation, shared tool availability, uv script metadata for packaged executable Python scripts, setup doctor, bounded no-model smoke checks, confirmed-write installer, README and DOCS updates, version bump, and tests.

**Out**: external CLI distribution, external marketplace submissions, force-pushing, live model spend by default, non-runtime-native plugin directory unification, and converting pytest files into executable scripts.

**Deferred**: richer live-host proof and standalone external CLI access can come after the bundle-first path is verified.

## Design

The plan first defines where shared tools live after marketplace install. Runtime adapters should expose or discover one installed Agentera root containing skills, shared scripts, hooks, manifests, and docs. `AGENTERA_HOME` points to that root, whether it is a clone or a runtime-installed package.

Skill-local scripts remain owned by their skills. Suite-level tools such as doctor, installer, validation, compaction, and runtime setup helpers belong to the aggregate bundle. Doctor reads this bundle and runtime state without mutation. Installer reuses doctor findings, asks for confirmation, writes only selected runtime-native changes, and re-runs doctor to prove the result.

## Tasks

### Task 1: Suite Bundle Tool Surface

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN an aggregate Agentera install WHEN its package root is inspected THEN skills, shared scripts, hooks, manifests, and docs are reachable from one root.
▸ GIVEN a single skill install WHEN the skill runs THEN core workflow behavior does not require suite-level tools.
▸ GIVEN a runtime adapter exposes install-root state WHEN tools resolve paths THEN `AGENTERA_HOME` points at the installed bundle root or documented clone root.
▸ GIVEN package metadata is validated WHEN a shared tool path is missing THEN validation fails with the owning runtime surface named.
▸ Test cap: one pass and one fail per runtime package shape.

### Task 2: Packaged Script Runtime Hygiene

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN packaged executable Python scripts WHEN their headers are inspected THEN each uses the uv script shebang and inline metadata.
▸ GIVEN stdlib-only executable scripts WHEN metadata is inspected THEN dependencies are declared as an empty list.
▸ GIVEN uv is unavailable WHEN a user-facing check runs THEN the failure gives install guidance instead of a traceback.
▸ GIVEN representative packaged scripts run through uv WHEN invoked with harmless arguments THEN current behavior is preserved.
▸ GIVEN the script convention is validated WHEN fixtures omit shebang or metadata THEN the check fails.
▸ Test cap: one pass and one fail per metadata rule; edge cases only for library-module exclusions.

### Task 3: Non-Mutating Setup Doctor

**Depends on**: Task 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN an installed bundle or local clone WHEN doctor runs THEN it reports install-root validity without writing files.
▸ GIVEN Claude Code, OpenCode, Copilot, or Codex setup is present WHEN doctor runs THEN runtime-native path shapes are classified as pass, warn, fail, or skip.
▸ GIVEN a runtime is unavailable WHEN doctor runs THEN it reports skip without failing the whole diagnosis.
▸ GIVEN helper-script access is missing WHEN doctor runs THEN it reports whether the gap is bundle packaging, runtime config, or user environment.
▸ GIVEN doctor output is requested by another tool WHEN it runs THEN a stable machine-readable summary is available.
▸ Test cap: one pass, one warn or fail, and one skip per runtime family.

### Task 4: Doctor Smoke Evidence

**Depends on**: Task 3
**Status**: □ pending
**Acceptance**:
▸ GIVEN no live model permission is supplied WHEN smoke checks run THEN no live model call is attempted.
▸ GIVEN bounded smoke checks run WHEN helper and hook surfaces are available THEN they prove artifact validation and helper reachability.
▸ GIVEN a host binary is absent WHEN doctor summarizes smoke results THEN the unavailable host is marked skip.
▸ GIVEN a smoke check fails WHEN doctor exits THEN the failure is visible in human-readable and machine-readable output.
▸ Test cap: one success and one failure branch per smoke-check category.

### Task 5: Confirmed-Write Installer

**Depends on**: Task 4
**Status**: □ pending
**Acceptance**:
▸ GIVEN doctor findings include fixable setup gaps WHEN installer plans changes THEN it shows the target runtime, target file, and reason.
▸ GIVEN confirmation is absent WHEN writes would be needed THEN installer exits without changing user config.
▸ GIVEN confirmation is present WHEN installer applies changes THEN only selected runtime-native config surfaces are changed.
▸ GIVEN installer completes WHEN doctor is re-run THEN fixed surfaces report pass or documented skip.
▸ Test cap: one dry-run, one denied write, one confirmed write, and one idempotent re-run per writable runtime.

### Task 6: Version Metadata

**Depends on**: Task 5
**Status**: □ pending
**Acceptance**:
▸ GIVEN DOCS.md version policy is applied WHEN feature metadata is updated THEN suite version targets receive the required minor bump.
▸ GIVEN version files are inspected WHEN the bump is complete THEN every listed suite version surface agrees.
▸ GIVEN CHANGELOG.md is read WHEN the bump is complete THEN unified setup work is recorded under the release section.
▸ GIVEN version validation runs WHEN metadata is checked THEN no stale pre-bump version remains.

### Task 7: Documentation Refresh

**Depends on**: Task 6
**Status**: □ pending
**Acceptance**:
▸ GIVEN README setup guidance is read WHEN the plan is complete THEN bundle-first doctor flow is the recommended path.
▸ GIVEN single-skill install guidance is read WHEN suite tools are mentioned THEN core-only behavior and bundle-enhanced behavior are distinguished.
▸ GIVEN runtime setup docs are read WHEN installer behavior is described THEN confirmed writes and no-live-default behavior are explicit.
▸ GIVEN DOCS.md is read WHEN the plan is complete THEN bundle, doctor, installer, and test rows are current.
▸ GIVEN adapter references are read WHEN setup behavior is compared THEN runtime-native boundaries remain accurate.

### Task 8: Verification And Freshness Checkpoint

**Depends on**: Task 7
**Status**: □ pending
**Acceptance**:
▸ GIVEN validators run WHEN final verification executes THEN spec, lifecycle, contracts, package-shape, and artifact checks pass.
▸ GIVEN smoke checks run WHEN final verification executes THEN setup, live-host unavailable, and OpenCode bootstrap smoke pass or skip by documented rules.
▸ GIVEN pytest runs WHEN final verification executes THEN the full suite passes.
▸ GIVEN plan work is complete WHEN artifacts are read THEN PROGRESS, TODO, CHANGELOG, DOCS, and PLAN summarize the plan-level result.
▸ GIVEN the worktree is inspected WHEN the handoff completes THEN only intended files are changed.

## Overall Acceptance

▸ GIVEN Agentera is installed as a suite bundle WHEN doctor runs THEN it finds shared tools without requiring a clone.
▸ GIVEN only one skill is installed WHEN that skill runs THEN core behavior does not depend on suite-level scripts.
▸ GIVEN fixable setup gaps exist WHEN installer runs without confirmation THEN no user config changes.
▸ GIVEN installer applies confirmed changes WHEN doctor runs again THEN configured runtimes report pass or documented skip.
▸ GIVEN release-facing docs are read WHEN the plan completes THEN setup guidance matches shipped bundle behavior.

## Surprises

[Empty; populated by realisera during execution when reality diverges from plan]

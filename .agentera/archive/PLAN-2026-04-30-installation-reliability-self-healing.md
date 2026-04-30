# Plan: Installation Reliability Self-Healing

<!-- Level: full | Created: 2026-04-30 | Status: complete -->
<!-- Reviewed: 2026-04-30 | Critic issues: 12 found, 10 addressed, 2 constrained -->

## What

Harden Agentera installation so stale skill-local references, incomplete `npx skills` installs, missing OpenCode slash commands, and broken OpenCode skill paths are detected or repaired without manual file edits.

## Why

`npx skills update -g -y` reported current installs while `profilera` still pointed at a missing bundled reference. OpenCode also lacked `/profilera` command completion and carried broken skill links. Installer success is not enough; Agentera needs install-state verification.

## Constraints

- Preserve standalone skill behavior and suite-bundle boundaries.
- Repair only Agentera-managed OpenCode surfaces.
- Preserve user-owned commands and skill directories.
- Keep default validation offline and credential-free.
- Treat docs through dokumentera.
- Keep doctor diagnostic-only; defer broad `--fix` behavior.

## Scope

**In**: install-health docs, skill-local reference validation, offline install smoke, optional real `npx skills` smoke, OpenCode command repair, OpenCode skill-path repair, doctor reporting, validation, version bump, freshness checkpoint.
**Out**: replacing `npx skills`, adding an external CLI, live marketplace tests, changing non-OpenCode runtime behavior.
**Deferred**: doctor repair mode outside OpenCode-managed surfaces.

## Design

Use a verify-and-repair chain. Docs define supported install health first. Validators block impossible bundled references before release. Smoke checks prove installed skills remain usable. The OpenCode plugin repairs managed command and skill-path drift during startup. The setup doctor reports drift without mutating files.

## Tasks

### Task 1: Document Install Health Contract

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN OpenCode setup docs are read WHEN users install Agentera THEN the supported `npx skills` command targets OpenCode without selecting every agent.
▸ GIVEN install-health docs are read WHEN users diagnose drift THEN they can distinguish installer freshness from Agentera bundle validation.
▸ GIVEN managed OpenCode surfaces are documented WHEN repair runs THEN ownership markers, skipped collisions, and diagnostic-only doctor behavior are clear.
▸ GIVEN documentation changes are written WHEN dokumentera updates the index THEN DOCS.md coverage and dates stay current.

### Task 2: Validate Bundled Support References

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a skill names a missing bundled support file WHEN validation runs THEN validation fails with the skill name and missing relative path.
▸ GIVEN a skill names existing bundled support files WHEN validation runs THEN existing spec and lifecycle checks still pass.
▸ GIVEN a skill uses suite-root-only helpers WHEN standalone validation runs THEN the diagnostic names the standalone boundary risk.
▸ GIVEN tests are added WHEN reviewed THEN coverage stays capped at one valid bundle and one dangling-reference failure, with branch cases only for path syntax.

### Task 3: Smoke-Test Installed Skill Bundles

**Depends on**: Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN an isolated home/config directory WHEN the offline install smoke runs THEN installed Agentera skills contain `SKILL.md` and bundled support directories.
▸ GIVEN installed skill prose names a missing bundled file WHEN the smoke inspects installed content THEN it fails before runtime invocation.
▸ GIVEN real `npx skills` verification is requested WHEN an opt-in flag is absent THEN default CI does not use network package resolution.
▸ GIVEN tests are added WHEN reviewed THEN they cover one healthy install shape and one stale installed-reference failure.

### Task 4: Repair OpenCode Managed Commands

**Depends on**: Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a current version marker but a managed slash command is missing WHEN the plugin initializes THEN the command is restored.
▸ GIVEN a managed command is stale WHEN the plugin initializes THEN it is refreshed to the current template.
▸ GIVEN a same-name user command lacks the managed marker WHEN the plugin initializes THEN it is preserved and the skip is reportable.
▸ GIVEN tests are added WHEN reviewed THEN missing, stale, malformed-marker, and user-owned branches are covered without live OpenCode.

### Task 5: Repair OpenCode Agentera Skill Paths

**Depends on**: Task 3
**Status**: ■ complete
**Acceptance**:
▸ GIVEN an Agentera-managed OpenCode skill path is broken WHEN the plugin initializes THEN it points to a valid installed Agentera skill.
▸ GIVEN the universal Agentera skill is missing WHEN the plugin initializes THEN the plugin reports the install command and creates no unusable path.
▸ GIVEN a user-owned OpenCode skill directory exists WHEN the plugin initializes THEN it is preserved.
▸ GIVEN tests are added WHEN reviewed THEN repaired, missing, and user-owned cases are covered without live OpenCode.

### Task 6: Report Install Drift In Doctor

**Depends on**: Tasks 4-5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN OpenCode commands are missing or stale WHEN the setup doctor runs THEN it reports affected skills with actionable warnings.
▸ GIVEN Agentera skill paths are broken WHEN the setup doctor runs THEN it reports affected skills without mutating files.
▸ GIVEN bundled references are unhealthy WHEN the setup doctor runs THEN it reports validation drift separately from installer freshness.
▸ GIVEN tests are added WHEN reviewed THEN each reported drift class has one pass and one fail case.

### Task 7: Verify And Bump Release Metadata

**Depends on**: Task 6
**Status**: ■ complete
**Acceptance**:
▸ GIVEN reliability work is complete WHEN validation runs THEN spec, contracts, lifecycle metadata, OpenCode smoke, install smoke, and pytest pass offline.
▸ GIVEN this release adds feature-level self-healing WHEN metadata is updated THEN version files advance by one minor version per DOCS.md policy.
▸ GIVEN release notes are read WHEN users scan changes THEN install validation and OpenCode self-healing are named.
▸ GIVEN metadata tests inspect runtime surfaces WHEN run THEN all version-bearing package surfaces align.

### Task 8: Plan-Level Freshness Checkpoint

**Depends on**: Task 7
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Tasks 1-7 are complete WHEN the checkpoint runs THEN required lifecycle artifacts summarize the plan-level outcome.
▸ GIVEN PLAN.md is archived WHEN the checkpoint completes THEN no active installation reliability plan remains.
▸ GIVEN artifact self-audit runs WHEN checkpoint artifacts are written THEN it passes without post-audit flags.

## Overall Acceptance

▸ GIVEN a skill references a nonexistent bundled support file WHEN release validation runs THEN the release is blocked before install.
▸ GIVEN `npx skills` reports an installed Agentera skill as current WHEN installed support files or references are stale THEN Agentera validation still reports drift.
▸ GIVEN OpenCode starts with missing commands or broken Agentera skill paths WHEN the plugin initializes THEN managed surfaces are repaired or reported.
▸ GIVEN user-owned OpenCode files collide with Agentera names WHEN repair runs THEN user content is preserved.
▸ GIVEN a fresh contributor runs the documented validation set WHEN no live host credentials exist THEN installation reliability is verified offline.

## Surprises

Empty; populated by realisera during execution when reality diverges from plan.

## Closure

Task 8 closed the plan-level freshness checkpoint. `CHANGELOG.md`, `TODO.md`, `.agentera/PROGRESS.md`, and `.agentera/DOCS.md` summarize the plan outcome, and active `.agentera/PLAN.md` was removed after Tasks 1-8 reached `■ complete`.

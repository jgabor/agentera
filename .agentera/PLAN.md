# Plan: v2.0.0 Release — Upgrade Safety and README

<!-- Level: full | Created: 2026-05-04 | Status: active -->
<!-- Reviewed: 2026-05-04 | Critic issues: 10 found, 4 addressed, 6 dismissed -->

## What

Complete the v2.0.0 release: harden migration safety with PROFILE.md protection, add upgrade guard to hej orientation, detect dead runtime artifacts in user installations, fix DOCS.md stale version_files, rewrite README for v2, and ship version 2.0.0.

## Why

The cutover deleted v1 skill dirs and collapsed configs but provides no safety net for existing users. After `npx skills update`, users may have dead symlinks, stale v1 artifacts, and stale runtime configs. PROFILE.md (irreplaceable accumulated data) has no protection guarantee. README references deleted directories and v1 concepts. The version bump to 2.0.0 must not ship until all of these are addressed.

## Constraints

- D39 (firm): no backward compat, big bang cutover
- D40 (firm): YAML artifacts, capabilities naming
- Version stays at 1.27.1 until all tasks are complete — only then bump to 2.0.0
- PROFILE.md must never be lost or corrupted
- hej is read-only by design — guard informs/routes, does not write
- Must work across 4 runtimes: Claude Code, OpenCode, Codex, Copilot
- Migration script already exists at scripts/migrate_artifacts_v1_to_v2

## Scope

**In**: migration safety hardening (backup overwrite protection, PROFILE.md explicit check), hej upgrade guard, dead runtime artifact detection script, DOCS.md version_files fix, README rewrite
**Out**: automated migration from hej (guard routes, doesn't execute), Copilot new features, setup_doctor upgrade mode, ROADMAP checkbox cleanup
**Deferred**: setup_doctor upgrade mode

## Design

The upgrade guard sits in hej's Step 0 (detect mode), between artifact detection and the welcome/briefing. It checks for v1 Markdown artifacts that lack corresponding v2 YAML equivalents. If found, the briefing includes an upgrade notice with the migration command. PROFILE.md presence is verified during the guard check.

A new script `scripts/detect_stale_v1` handles runtime-level cleanup: dead symlinks in skill directories, stale command files in OpenCode, stale agent entries in Codex config. It runs with `--dry-run` by default.

DOCS.md version_files glob `skills/*/.claude-plugin/plugin.json` resolves to nothing after v1 dir deletion. Needs updating to the v2 surfaces.

## Tasks

### Task 1: Migration Safety Hardening

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the migration script WHEN run with --dry-run THEN it reports all artifacts to be migrated without writing anything
▸ GIVEN the migration script WHEN a previous backup directory exists THEN it warns on stderr and exits non-zero unless --force is passed
▸ GIVEN the migration script WHEN PROFILE.md exists at the global path THEN the migration output explicitly confirms PROFILE.md is excluded from migration
▸ GIVEN the migration script WHEN backup creation fails THEN it exits non-zero and does not proceed with any file writes
▸ Test proportionality: 1 pass + 1 fail per safety check (existing backup, PROFILE exclusion confirmation, backup failure)

### Task 2: Upgrade Guard in Hej

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN hej orientation WHEN v1 Markdown artifacts exist in .agentera/ with no corresponding v2 YAML equivalents THEN the briefing includes an upgrade notice referencing the migration command
▸ GIVEN hej orientation WHEN v1 artifacts do not exist (fresh install or already migrated) THEN no upgrade notice appears
▸ GIVEN hej orientation WHEN PROFILE.md exists at the global path THEN no PROFILE warning appears in the briefing
▸ GIVEN hej orientation WHEN PROFILE.md is absent at the global path THEN the briefing flags this as a degraded attention item
▸ Test proportionality: 1 pass per scenario (v1 detected, already migrated, PROFILE present, PROFILE absent)

### Task 3: Runtime Artifact Detection

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a user's skill install directory WHEN dead symlinks to removed v1 skill paths exist THEN they are reported by the detection script
▸ GIVEN the OpenCode commands directory WHEN command files referencing removed v1 skill paths exist THEN they are reported
▸ GIVEN the Codex config WHEN stale v1 agent entries exist THEN they are reported (not auto-removed)
▸ GIVEN the detection script WHEN run with --dry-run THEN it reports findings without modifying any files
▸ Test proportionality: 1 pass + 1 fail per runtime surface (Claude skills, OpenCode commands, Codex config)

### Task 4: README Rewrite + DOCS.md Fix

**Depends on**: Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN README.md WHEN read THEN it describes the v2 single-bundle model with 12 capabilities under one skill, not 12 individual skills
▸ GIVEN README.md WHEN read THEN it links to UPGRADE.md for existing users
▸ GIVEN README.md WHEN read THEN all slash commands route through /agentera or the bundled skill
▸ GIVEN README.md WHEN read THEN no references to SPEC.md, validate_spec.py, or individual skill directories remain
▸ GIVEN DOCS.md WHEN version_files is checked THEN all listed globs resolve to existing files
▸ No tests required (docs-only task)

### Task 5: Version Bump to 2.0.0

**Depends on**: Task 1, Task 2, Task 3, Task 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN all prior tasks complete WHEN the 6 version surfaces are checked (registry.json, plugin.json, .github/plugin/plugin.json, .codex-plugin/plugin.json, .claude-plugin/marketplace.json metadata, .opencode/plugins/agentera.js) THEN all read 2.0.0
▸ GIVEN the version bump WHEN the runtime adapter version alignment test runs THEN it passes

### Task 6: Freshness Checkpoint

**Depends on**: Task 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN all prior tasks complete WHEN CHANGELOG.md is checked THEN it has a 2.0.0 entry covering the full release including upgrade safety
▸ GIVEN all prior tasks complete WHEN PROGRESS.md is checked THEN it has a cycle entry summarizing the patch

## Overall Acceptance

▸ GIVEN an existing v1 user WHEN they update to 2.0.0 and open a project with v1 artifacts THEN hej detects the mismatch and provides migration instructions
▸ GIVEN an existing v1 user WHEN they run the migration script THEN their PROFILE.md is explicitly confirmed as excluded from migration
▸ GIVEN a new user WHEN they install agentera 2.0.0 THEN the README accurately describes the single-bundle model

## Surprises

[Populated during execution.]

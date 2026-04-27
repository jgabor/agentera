# Plan: OpenCode Session Events

<!-- Level: full | Created: 2026-04-27 | Status: complete -->
<!-- Reviewed: 2026-04-27 | Critic issues: 5 found, 5 addressed -->

## What

Repair the OpenCode SESSION.md lifecycle wiring by using OpenCode's real generic event hook. The current adapter correctly avoids phantom direct hook keys, but it never replaced the dropped session bookmark path. This plan restores the bookmark behavior, resolves the session-start preload question with evidence, and hardens tests so the same hook-shape mistake cannot return quietly.

## Why

VISION.md says agentera's artifacts are the protocol that lets agents compound understanding over time. Decision 23 makes SESSION.md the honest home for session continuity. OpenCode currently misses that continuity because `session.idle` is an event payload value, not a top-level plugin hook key. The fix keeps the portable artifact contract intact while respecting OpenCode's actual plugin surface.

## Constraints

- Use OpenCode's generic `event` hook for session events.
- Do not reintroduce direct `"session.created"` or `"session.idle"` hook keys.
- Preserve command bootstrap, `shell.env`, and artifact validation behavior.
- Reuse the existing SESSION.md artifact contract and DOCS.md path mapping.
- Restore session-start preload only through a supported hook with test evidence.
- Keep OpenCode adapter tests proportional and black-box where practical.
- No push or remote operations.
- Apply DOCS.md semver policy: this shipped adapter fix requires a patch bump.

## Scope

**In**: OpenCode lifecycle docs, `.opencode/plugins/agentera.js`, OpenCode smoke coverage, runtime adapter validation, release metadata, CHANGELOG, TODO, PROGRESS, and active PLAN freshness.

**Out**: changing SESSION.md format, replacing the Python hook implementation wholesale, live OpenCode CLI smoke, unrelated Codex or Copilot lifecycle work, and aggregator PR TODOs.

**Deferred**: richer session summaries beyond modified-artifact bookmarks; live OpenCode host verification if the local smoke harness cannot exercise the runtime event stream directly.

## Design

OpenCode lifecycle handling becomes a two-layer adapter. Top-level plugin hooks remain only real members of the `@opencode-ai/plugin` Hooks interface. Session lifecycle work lives under the generic `event` hook and branches on `event.type`. The idle branch delegates to the existing SESSION.md bookmark behavior so artifact detection, path resolution, and compaction stay centralized. The created-session preload is handled separately: implement it only if a supported context hook can inject the digest observably; otherwise document the limitation and leave no dead preload code behind.

## Tasks

### Task 1: Ground the OpenCode event contract

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN OpenCode plugin docs and local type definitions WHEN checked THEN the cycle log cites `event` as the hook and `session.created` / `session.idle` as event types.
▸ GIVEN `references/adapters/opencode.md` WHEN read THEN it describes session lifecycle through the generic event hook, not direct session hook keys.
▸ GIVEN docs mention SessionStart or Stop for OpenCode WHEN read THEN they do not claim direct `"session.created"` or `"session.idle"` hooks exist.
▸ GIVEN this task is docs and evidence only WHEN validators run THEN current behavior remains unchanged.

### Task 2: Restore SESSION.md bookmarks on OpenCode idle

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the OpenCode plugin initializes WHEN its hook object is inspected THEN it includes `event`, `shell.env`, and `tool.execute.after`.
▸ GIVEN an OpenCode `session.idle` event in a temp git project with a modified agentera artifact WHEN the hook runs THEN SESSION.md is written using the configured artifact path.
▸ GIVEN an OpenCode `session.idle` event with no modified agentera artifacts WHEN the hook runs THEN SESSION.md is not created or changed.
▸ GIVEN an OpenCode `session.created` event WHEN the hook runs THEN bookmark writing is skipped and no exception is raised.
▸ GIVEN the plugin source WHEN scanned THEN direct `"session.created"` and `"session.idle"` hook keys are absent.
▸ GIVEN command bootstrap, `shell.env`, and artifact validation smoke cases WHEN run THEN they still pass unchanged.

### Task 3: Resolve session-start preload behavior

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN OpenCode's supported hooks WHEN session-start preload is evaluated THEN the cycle log records whether a supported injection path exists.
▸ GIVEN a supported injection path exists WHEN a new session starts with agentera artifacts present THEN the first model context includes the same digest content as the existing session-start hook.
▸ GIVEN no supported injection path exists WHEN docs are read THEN OpenCode session-start preload is explicitly documented as unsupported or deferred.
▸ GIVEN the final implementation WHEN inspected THEN there is no dead context-preload branch attached only to event payload observation.
▸ Test proportionality: one pass and one fail per chosen behavior boundary; expand only if the chosen hook has three or more branches.

### Task 4: Harden OpenCode lifecycle validation and smoke coverage

**Depends on**: Task 2, Task 3
**Status**: ■ complete
**Acceptance**:
▸ GIVEN `scripts/smoke_opencode_bootstrap.mjs` WHEN run THEN it proves idle bookmark write, idle no-op, and created-event no-bookmark behavior.
▸ GIVEN `tests/test_runtime_adapters.py` WHEN run THEN it rejects direct session hook keys and requires the generic event hook surface.
▸ GIVEN `scripts/validate_lifecycle_adapters.py` WHEN run THEN OpenCode lifecycle expectations match the real hook interface and event payload model.
▸ GIVEN malformed or incomplete event payloads WHEN tested THEN the plugin exits cleanly without writing SESSION.md.
▸ Test proportionality: one pass and one fail per behavior boundary; event branching earns edge coverage for idle, created, and malformed inputs.

### Task 5: Apply patch release metadata

**Depends on**: Task 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN DOCS.md `version_files` WHEN inspected THEN every listed surface advertises version 1.20.1.
▸ GIVEN `.opencode/plugins/agentera.js` WHEN inspected THEN its version marker matches registry release metadata.
▸ GIVEN CHANGELOG.md WHEN read THEN `[Unreleased]` is promoted to `1.20.1` with a Fixed entry for OpenCode SESSION.md event wiring.
▸ GIVEN `python3 scripts/validate_spec.py`, `python3 scripts/validate_lifecycle_adapters.py`, `node scripts/smoke_opencode_bootstrap.mjs`, `node --check .opencode/plugins/agentera.js`, and `python3 -m pytest -q` WHEN run THEN all pass.

### Task 6: Plan-level freshness checkpoint

**Depends on**: Task 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN PLAN.md WHEN read THEN Tasks 1-5 are complete and Surprises records any divergence from this plan.
▸ GIVEN TODO.md WHEN read THEN `[opencode-session-events]` is moved to Resolved with a concise resolution note.
▸ GIVEN PROGRESS.md WHEN read THEN one plan-level cycle entry summarizes the OpenCode session-events outcome and verification.
▸ GIVEN DOCS.md Index WHEN plan-touched docs or scripts changed THEN affected rows have current dates and test counts.
▸ GIVEN this checkpoint is complete WHEN `git status` runs THEN only intended plan-cycle changes remain unstaged or staged.

## Overall Acceptance

▸ GIVEN OpenCode emits `session.idle` through the generic event hook WHEN an agentera artifact changed in the project THEN SESSION.md receives a bookmark.
▸ GIVEN OpenCode emits `session.idle` without agentera artifact changes WHEN the hook runs THEN SESSION.md remains unchanged.
▸ GIVEN OpenCode emits `session.created` WHEN the plugin observes it THEN session-start preload is either proven working through a supported hook or explicitly documented as unsupported.
▸ GIVEN the OpenCode plugin source WHEN inspected THEN no phantom direct session lifecycle hook keys exist.
▸ GIVEN the repo validation suite WHEN run after the plan THEN spec validation, lifecycle validation, OpenCode smoke, Node syntax check, and pytest all pass.
▸ GIVEN release metadata WHEN inspected THEN the adapter fix is released as 1.20.1 per DOCS.md semver policy.

## Surprises

[Empty; populated by realisera during execution when reality diverges from plan]

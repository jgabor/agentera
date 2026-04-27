# Plan: Copilot Hook Event Name Validator

<!-- Level: light | Created: 2026-04-27 | Status: active -->

## What

Harden Copilot lifecycle validation so hook configurations are checked against the documented event names. The validator should accept supported Copilot events and fail fast on stale or misspelled events such as `stop`.

## Why

The previous `stop` hook typo silently disabled session-end behavior. A focused validator guard keeps runtime adapter metadata aligned with documented Copilot hooks and protects the session-continuity contract.

## Constraints

- Keep runtime behavior unchanged except validation.
- Do not broaden Copilot capability claims beyond current documentation.
- Preserve existing hook path validation and command-handler checks.
- Use the documented Copilot allowlist: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `errorOccurred`.
- Keep tests proportional: one pass and one fail for the event-name boundary, plus one file-name guard if per-event filenames are enforced.
- Follow DOCS.md semver policy if execution classifies this as a release-affecting fix.

## Acceptance Criteria

▸ GIVEN a Copilot hook config declares any documented event WHEN lifecycle validation runs THEN the event-name check accepts it.
▸ GIVEN a Copilot hook config declares an unsupported event such as `stop` WHEN lifecycle validation runs THEN validation fails and names the unsupported event.
▸ GIVEN per-event hook files are checked WHEN a file uses an unsupported event stem or mismatches its declared event THEN validation fails before the hook can ship.
▸ GIVEN existing Copilot hook command handlers and path checks WHEN lifecycle validation runs THEN their existing passes and failures remain unchanged.
▸ GIVEN focused runtime adapter tests run WHEN the change lands THEN they include the proportional pass/fail boundary for Copilot event names and pass with lifecycle validation.

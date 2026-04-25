# Plan: Copilot Plugin Packaging Fix

<!-- Level: light | Created: 2026-04-25 | Status: active -->

## What

Fix or repackage the Copilot plugin so a current checkout can load agentera skills through Copilot without the `skills path escapes plugin directory` failure.

## Why

The live smoke narrowed the remaining portability caveat. Codex `$hej` works and installed Copilot skills are discoverable, but Copilot cannot load the current `1.18.1` checkout through `--plugin-dir` because the plugin points outside its root.

## Constraints

- Preserve `skills/<name>/SKILL.md` as the source of truth.
- Keep runtime adapters thin and evidence-bounded.
- Do not add third-party dependencies.
- Do not claim Copilot current-checkout support until a live `copilot --plugin-dir` smoke passes.
- Do not remove marketplace or installed-plugin guidance that still reflects observed behavior.
- Keep tests proportional: one pass plus one fail for the packaging validator path, with a live smoke outside unit tests.

## Acceptance Criteria

▸ GIVEN Copilot loads the plugin from the current checkout WHEN `copilot --plugin-dir` runs against agentera THEN skill discovery succeeds without an escaping-path error.
▸ GIVEN Copilot package metadata is inspected WHEN local validation runs THEN every referenced skill and hook path stays inside the plugin root or is packaged in a Copilot-supported shape.
▸ GIVEN shared skill source remains authoritative WHEN packaging artifacts are checked THEN generated or mirrored Copilot surfaces do not diverge silently from `skills/<name>/SKILL.md`.
▸ GIVEN validator tests are updated WHEN this task is complete THEN coverage includes one valid package shape and one escaping-path failure.
▸ GIVEN the fix is complete WHEN artifacts are updated THEN TODO, PROGRESS, CHANGELOG, and DOCS agree on whether the Copilot current-checkout caveat is closed or narrowed.

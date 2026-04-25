# Plan: Live Copilot and Codex Host Smoke Validation

<!-- Level: light | Created: 2026-04-25 | Status: active -->

## What

Run bounded live smoke validation against the installed Copilot and Codex CLIs to decide whether agentera can remove, narrow, or preserve the current live-host caveat.

## Why

Audit 12 shows local metadata, validators, corpus extraction, and artifacts are healthy. The remaining portability risk is live host behavior, so the next useful work is evidence from the actual Copilot and Codex binaries available on this machine.

## Constraints

- Do not change adapters unless live evidence exposes a root-cause defect.
- Do not add dependencies.
- Do not expose secrets, tokens, prompts, or private host state in artifacts.
- Keep host commands read-only or metadata-oriented unless the host requires an isolated temporary fixture.
- Preserve the caveat if either runtime cannot be smoke-tested safely or authentically.
- Follow `.agentera/DOCS.md` artifact path mappings.

## Acceptance Criteria

▸ GIVEN `copilot` and `codex` binaries are installed WHEN smoke validation runs THEN each runtime has a recorded pass, fail, or blocked result with the exact command surface used.
▸ GIVEN live host metadata or skill/plugin discovery is available WHEN the smoke run inspects agentera THEN Copilot and Codex expose the expected skill or plugin surfaces without unsupported behavior claims.
▸ GIVEN host execution is possible in a safe bounded way WHEN smoke validation invokes agentera behavior THEN the observed output confirms or refutes the documented invocation guidance.
▸ GIVEN host execution is unavailable, interactive-only, unauthenticated, or unsafe WHEN validation runs THEN artifacts preserve the caveat with the concrete blocker instead of claiming support.
▸ GIVEN the smoke run completes WHEN artifacts are updated THEN TODO, PROGRESS, CHANGELOG, and DOCS agree on whether the live-host caveat is closed, narrowed, or still deferred.

# Plan: Audit 11 Runtime Portability Cleanup

<!-- Level: full | Created: 2026-04-25 | Status: complete -->
<!-- Reviewed: 2026-04-25 | Critic issues: 14 found, 14 addressed, 0 dismissed -->

## What

Resolve Audit 11's runtime portability cleanup findings after the Copilot and Codex collector work.

Align the Section 21 corpus contract with generated data, tighten runtime metadata validation, reduce profilera corpus orchestration risk, improve validation and redaction coverage, and refresh plan-level artifacts.

## Why

agentera's portability thesis depends on the spec being the stable protocol and adapters being trustworthy evidence.

Audit 11 says the previous plan moved the product forward, but left contract ambiguity, metadata drift risks, validation gaps, and one security-sensitive redaction gap around the new multi-runtime profilera corpus.

## Constraints

- Preserve the shared skill directories as the source of truth.
- Keep runtime adapters thin and evidence-bounded.
- Keep profile and corpus data under the profilera profile path contract.
- Do not add third-party dependencies without approval.
- Do not claim live Copilot or Codex host behavior until smoke-tested.
- Do not add a new runtime collector in this plan.
- Follow `.agentera/DOCS.md` artifact path mappings.
- Keep tests proportional unless a security, parsing, redaction, or multi-branch validation boundary needs explicit edge expansion.

## Scope

**In**: Section 21 corpus contract alignment, Copilot and Codex capability metadata validation, OpenCode install path drift, lifecycle hook validation, profilera corpus orchestration cleanup, corpus envelope validation, sensitive-value redaction, secondary source surface fixtures for existing collectors, version convention cleanup, artifact freshness.

**Out**: Marketplace publishing, live hosted Copilot or Codex smoke tests, new runtime adapters, new source families without documented local surfaces, broad extractor rewrites unrelated to Audit 11.

**Deferred**: Live Copilot and Codex host behavior verification remains a release caveat until host access is available.

## Design

Start with the contract decision because it determines whether generated records or SPEC wording change.

Fix security-sensitive redaction before refactoring surrounding corpus orchestration.

Then tighten runtime metadata and adapter validation so future drift is caught locally.

After the contract and safety baseline are stable, reduce the profilera corpus orchestration hotspot and deepen validation coverage.

Finish with version and freshness work so downstream orientation sees one coherent completed plan.

## Tasks

### Task 1: Resolve Section 21 corpus contract shape

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN consumers read Section 21 corpus records WHEN they compare the spec to generated corpus data THEN the chosen record shape is unambiguous and consistent.
▸ GIVEN existing supported runtimes generate corpus data WHEN extraction runs THEN valid records follow the chosen contract without losing runtime provenance.
▸ GIVEN contract examples are inspected WHEN documentation and tests are compared THEN examples and validator expectations describe the same envelope.
▸ GIVEN validation commands run WHEN the task is complete THEN `python3 scripts/validate_spec.py` and relevant profilera corpus tests pass.

### Task 2: Protect Copilot corpus data from sensitive values

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Copilot config contains sensitive-looking primitive values WHEN extraction runs THEN generated corpus data does not expose those values.
▸ GIVEN Copilot config contains non-sensitive primitive values WHEN extraction runs THEN useful non-sensitive signals remain available.
▸ GIVEN redaction tests are added WHEN this task is complete THEN edge coverage includes sensitive keys, nested data, list data, and non-sensitive false positives.
▸ GIVEN extraction entrypoint samples run WHEN redaction is active THEN checked surfaces remain bounded to documented local runtime locations.

### Task 3: Tighten runtime metadata drift guards

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Copilot users inspect local profilera capability metadata WHEN plugin metadata is read THEN documented limitation or support rules are visible through supported metadata.
▸ GIVEN Codex profilera policy appears in multiple local metadata surfaces WHEN lifecycle validation runs THEN inconsistent policy, capability, or invocation rules fail locally.
▸ GIVEN adapter validation tests are updated WHEN this task adds checks THEN use the default cap of one pass plus one fail per validator behavior.
▸ GIVEN live Copilot or Codex behavior remains untested WHEN metadata wording is inspected THEN claims stay limited to local metadata behavior.

### Task 4: Repair adapter path and hook validation drift

**Depends on**: Task 3
**Status**: ■ complete
**Acceptance**:
▸ GIVEN OpenCode users follow documented manual installation WHEN hooks initialize THEN artifact validation resolves the documented install root or documents the required override.
▸ GIVEN runtime metadata declares one or many hook handlers WHEN lifecycle validation runs THEN every declared handler receives consistent event and handler checks.
▸ GIVEN OpenCode version metadata is test-enforced WHEN release targets are documented THEN the convention includes or explicitly derives that marker.
▸ GIVEN validator tests are added WHEN this task is complete THEN edge coverage is limited to one-vs-many handler declarations and path-drift behavior.

### Task 5: Refactor profilera corpus orchestration boundary

**Depends on**: Tasks 1, 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN supported runtimes are available WHEN corpus extraction runs THEN observed output remains equivalent for single-runtime, mixed-runtime, and no-data cases.
▸ GIVEN a future runtime is considered WHEN maintainers inspect corpus orchestration THEN the extension point is localized and existing runtime behavior remains isolated.
▸ GIVEN a runtime partially fails WHEN extraction continues THEN family status and checked surfaces remain bounded and explicit.
▸ GIVEN tests change for this refactor WHEN they are added or adjusted THEN use the default cap per behavior boundary, with edge expansion only for multi-branch status aggregation.

### Task 6: Deepen corpus validation and secondary surface fixtures

**Depends on**: Tasks 1, 2, 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN corpus metadata is incomplete WHEN validation runs THEN missing required envelope fields fail with actionable errors.
▸ GIVEN family status data is malformed WHEN validation runs THEN invalid status, count, or per-runtime consistency fails.
▸ GIVEN secondary Copilot or Codex source surfaces exist WHEN extraction runs THEN fixtures cover advertised behavior without probing outside documented local runtime locations.
▸ GIVEN validation and fixture tests are added WHEN this task is complete THEN use the default cap per validator unit, with edge expansion for multi-runtime family consistency.

### Task 7: Version bump per DOCS.md convention

**Depends on**: Tasks 3, 4, 6
**Status**: ■ complete
**Acceptance**:
▸ GIVEN this plan includes fix work WHEN version targets are checked THEN the semver bump follows DOCS.md policy.
▸ GIVEN release notes are checked WHEN users read the changelog THEN contract alignment, metadata validation, redaction, and validation hardening are summarized under correct categories.
▸ GIVEN version-related metadata is checked WHEN validation runs THEN documented release targets and enforced version signals do not contradict each other.

### Task 8: Plan-level freshness checkpoint

**Depends on**: Task 7
**Status**: ■ complete
**Acceptance**:
▸ GIVEN this plan's work has shipped WHEN CHANGELOG.md is checked THEN plan-level impact is summarized under [Unreleased].
▸ GIVEN this plan is otherwise complete WHEN PROGRESS.md is checked THEN one cycle entry summarizes the plan and lists produced commits.
▸ GIVEN this plan is otherwise complete WHEN TODO.md is checked THEN Audit 11 items have resolved entries or explicit deferred caveats.
▸ GIVEN `.agentera/DOCS.md` and `.agentera/PLAN.md` are read after completion THEN orientation consumers see one current plan state.
▸ GIVEN live Copilot or Codex host behavior remains untested WHEN freshness artifacts are read THEN the caveat is still explicit.

## Overall Acceptance

▸ GIVEN generated profilera corpus data is inspected WHEN compared with SPEC THEN contract, examples, and validation agree.
▸ GIVEN runtime metadata changes across Copilot, Codex, or OpenCode WHEN local validators run THEN drift and path mismatches fail before release.
▸ GIVEN profilera extraction handles supported runtime data WHEN tests and entrypoint samples run THEN records remain bounded, redacted, and provenance-rich.
▸ GIVEN this cleanup completes WHEN hej or orkestrera reads artifacts THEN completed plan state, version state, and TODO state do not contradict each other.

## Surprises

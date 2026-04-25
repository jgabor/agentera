# Plan: Runtime Plugin Install and Profilera Portability

<!-- Level: full | Created: 2026-04-24 | Status: archived -->
<!-- Reviewed: 2026-04-24 | Critic issues: 15 found, 15 addressed, 0 dismissed -->

## What

Align runtime-native install guidance and adapter metadata with current Claude Code, GitHub Copilot CLI, OpenAI Codex CLI, and OpenCode behavior.

Keep the Skills CLI as the universal install path.

Make profilera capability-gated on Copilot and Codex by adding Section 21 corpus collectors.

## Why

This advances agentera's "any agent CLI tomorrow" direction.

The previous metadata work proved the portability shape, but current CLI docs and validators show schema drift.

Users need install instructions that match supported runtime mechanisms.

Profilera needs runtime collectors before Copilot and Codex can join the same profile-building contract.

## Constraints

- Keep `npx skills install -g jgabor/agentera` as the universal install path.
- Preserve existing Claude Code and OpenCode behavior.
- Use existing skill directories as the source of truth.
- Use public runtime docs, CLI evidence, or documented local config surfaces.
- Do not add third-party dependencies without explicit approval.
- Do not claim lifecycle hook parity where a host lacks it.
- Keep profile data under the agentera profile path contract.
- Treat custom validators as evidence backed by runtime docs or CLI output.
- Follow DOCS.md semver policy for feature and fix work.

## Scope

**In**: Runtime capability evidence, install documentation, plugin and marketplace metadata, adapter validation, Copilot and Codex Section 21 corpus collection, profilera status metadata, test coverage, version bump, plan-level artifact freshness.

**Out**: External marketplace publishing, private runtime APIs, live hosted Copilot or Codex execution guarantees, new runtime subagents, Codex hook parity for real-time edit validation.

**Deferred**: Live marketplace smoke tests if host access or credentials are unavailable.

## Design

First capture the runtime evidence that defines the install contract.

Then align each metadata surface with that runtime's public plugin and skill schema.

Keep the shared skill directories as the source of truth.

Extend profilera's corpus extraction through runtime probes that produce the existing SPEC.md Section 21 envelope.

Collectors are evidence-bounded: use documented local runtime data where available, and report missing families instead of inventing records.

Validation should reject stale custom assumptions that pass old local tests but fail current runtime evidence.

## Tasks

### Task 1: Audit runtime capabilities and refine install docs

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a user wants universal installation WHEN they read the install section THEN the Skills CLI remains first and clearly cross-runtime.
▸ GIVEN Claude Code, Copilot, Codex, or OpenCode users choose native loading WHEN they read the install section THEN install, discovery, invocation, and hook support match recorded runtime evidence.
▸ GIVEN a runtime supports both plugins and direct skill folders WHEN docs describe it THEN distribution install and local-authoring fallback are distinct.
▸ GIVEN a runtime lacks hook parity WHEN docs describe it THEN lifecycle support is marked partial, unsupported, or experimental without parity claims.

### Task 2: Repair Claude Code and Copilot metadata

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Claude Code validates plugin metadata WHEN the current CLI validator runs THEN marketplace and plugin manifests pass.
▸ GIVEN Claude Code users inspect installed skills WHEN plugin metadata is loaded THEN shared skill directories are exposed without breaking direct skill installs.
▸ GIVEN Copilot reads plugin metadata WHEN current public schema rules are applied THEN skills and hooks are exposed through supported component fields.
▸ GIVEN Copilot metadata is validated WHEN stale manifest shapes are tested THEN unsupported custom schema assumptions fail.

### Task 3: Repair Codex and OpenCode metadata

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Codex reads plugin metadata WHEN marketplace discovery is configured THEN skill paths and UI metadata resolve from documented install roots.
▸ GIVEN Codex users inspect profilera before collector work lands WHEN metadata is read THEN remaining limits are accurate and actionable.
▸ GIVEN OpenCode metadata is checked WHEN release metadata is compared THEN package and plugin version signals do not drift.
▸ GIVEN legacy OpenCode setup is validated WHEN tests run THEN existing skill and hook loading behavior still passes.

### Task 4: Add Copilot session corpus collection

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Copilot runtime data exists WHEN profilera extraction runs THEN Section 21 records include Copilot runtime IDs, provenance, source family status, and stable record identity.
▸ GIVEN Copilot lacks a source family WHEN extraction runs THEN corpus metadata reports that family as partial or missing without failing the whole run.
▸ GIVEN Copilot records are re-extracted WHEN source data is unchanged THEN stable identifiers avoid duplicate logical records.
▸ GIVEN Copilot data is unavailable or unsupported WHEN extraction runs THEN the collector reports checked runtime surfaces without reading outside known user-agent locations.

### Task 5: Add Codex session corpus collection

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Codex runtime data exists WHEN profilera extraction runs THEN Section 21 records include Codex runtime IDs, provenance, source family status, and stable record identity.
▸ GIVEN Codex lacks a source family WHEN extraction runs THEN corpus metadata reports that family as partial or missing without failing the whole run.
▸ GIVEN Codex records are re-extracted WHEN source data is unchanged THEN stable identifiers avoid duplicate logical records.
▸ GIVEN Codex data is unavailable or unsupported WHEN extraction runs THEN the collector reports checked runtime surfaces without reading outside known user-agent locations.

### Task 6: Integrate profilera status and validation coverage

**Depends on**: Tasks 2, 3, 4, 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN multiple supported runtimes are available WHEN extraction runs THEN one corpus envelope includes all contributing runtime IDs.
▸ GIVEN only one supported runtime exists WHEN extraction runs THEN profilera continues to produce a valid corpus with no new user configuration.
▸ GIVEN collector fixtures cover complete, partial, duplicate, and no-data cases WHEN tests run THEN valid envelopes pass and invalid envelopes fail.
▸ GIVEN README and runtime metadata describe profilera WHEN collectors exist THEN missing-collector limitations become capability-gated degradation rules.
▸ GIVEN validation commands run WHEN implementation is complete THEN adapter validation, spec validation, and relevant pytest suites pass.

### Task 7: Version bump per DOCS.md convention

**Depends on**: Task 6
**Status**: ■ complete
**Acceptance**:
▸ GIVEN this plan includes feature and fix work WHEN version targets are checked THEN the semver bump matches DOCS.md policy.
▸ GIVEN release notes are checked WHEN users read the changelog THEN install refinement, schema repair, and new collectors are summarized under correct categories.
▸ GIVEN profilera uses a separate version track WHEN versions are updated THEN intentional divergence is preserved or documented.

### Task 8: Plan-level freshness checkpoint

**Depends on**: Task 7
**Status**: ■ complete
**Acceptance**:
▸ GIVEN this plan's work has shipped WHEN CHANGELOG.md is checked THEN plan-level impact is summarized under [Unreleased].
▸ GIVEN this plan is otherwise complete WHEN PROGRESS.md is checked THEN one cycle entry summarizes the plan and lists produced commits.
▸ GIVEN this plan is otherwise complete WHEN TODO.md is checked THEN every task has a resolved entry or explicit no-issue-needed note.
▸ GIVEN this plan resolves prior health findings WHEN HEALTH.md or PROGRESS.md is read THEN resolved issues and residual runtime caveats are recorded.

## Overall Acceptance

▸ GIVEN a user chooses any supported runtime WHEN they read README THEN the install path matches current runtime evidence and local metadata.
▸ GIVEN runtime metadata is validated WHEN public or local validators run THEN schema drift is caught before release.
▸ GIVEN profilera runs with Copilot or Codex data WHEN extraction builds a corpus THEN Section 21 records are produced with appropriate provenance.
▸ GIVEN a runtime lacks hook parity WHEN docs or metadata are inspected THEN artifact validation is not overclaimed.
▸ GIVEN existing Claude Code or OpenCode users update agentera WHEN they use prior working paths THEN existing behavior still works.

## Surprises

Archived by planera on 2026-04-25 after all tasks were already marked complete. Audit 11 opened the follow-up cleanup plan.

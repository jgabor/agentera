# Plan: Copilot and Codex Native Loading

<!-- Level: full | Created: 2026-04-23 | Status: active -->
<!-- Reviewed: 2026-04-23 | Critic issues: 14 found, 14 addressed, 0 dismissed -->

## What

Make agentera installable and discoverable as a first-class skill suite in GitHub Copilot CLI and OpenAI Codex CLI.

Existing Claude Code and OpenCode paths stay intact.

## Why

This advances the vision direction: any agent CLI tomorrow, with stable artifact contracts underneath.

Users should see accurate install, invocation, and lifecycle support for each runtime.

## Constraints

- Preserve existing Claude Code and OpenCode behavior.
- Use existing skill directories as the source of truth.
- Avoid private runtime APIs.
- Do not add third-party dependencies without explicit approval.
- Keep non-profilera skills portable through shared artifact contracts.
- Mark profilera as limited until Copilot and Codex session corpus collectors exist.
- Do not claim hook parity where the host runtime lacks equivalent lifecycle support.
- Update normal cycle artifacts during implementation, then aggregate plan freshness at the end.
- Follow DOCS.md semver policy for feature work.

## Scope

**In**: Runtime support matrix, native packaging metadata, skill discovery metadata, invocation docs, supported hook adapters, documented hook fallbacks, validation tests, version bump, plan-level artifact updates.

**Out**: Runtime internals, external marketplace publishing, new profilera session corpus collectors.

**Deferred**: Copilot and Codex profilera collectors, MCP helper tools, runtime-specific subagents.

## Design

Keep the skill source shared. Add runtime metadata around it.

Start with a support matrix that distinguishes active, partial, and unsupported capabilities.

Use public extension mechanisms only. Do not emulate unsupported host behavior.

Validate runtime metadata, hook schemas, and legacy runtime behavior before bumping versions.

## Tasks

### Task 1: Codify runtime support matrix

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a user chooses Copilot CLI WHEN they read runtime support THEN install path, discovery command, and invocation form are clear.
▸ GIVEN a user chooses Codex CLI WHEN they read runtime support THEN install path, plugin path, and skill invocation form are clear.
▸ GIVEN lifecycle support differs by runtime WHEN hooks are described THEN active, partial, and unsupported capabilities are distinct.
▸ GIVEN profilera is described with portable skills WHEN runtime support is listed THEN its limited status is visible.

### Task 2: Add native packaging metadata

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Copilot loads agentera through public extension support WHEN skills are listed THEN all portable skills appear accurately.
▸ GIVEN Codex loads agentera through public extension support WHEN skills are listed THEN all portable skills appear accurately.
▸ GIVEN profilera appears in either runtime WHEN it is listed THEN users see its limited status before invocation.
▸ GIVEN existing package indexes are checked WHEN metadata changes THEN skill names, descriptions, and versions remain consistent.
▸ GIVEN existing Claude Code and OpenCode installs are checked WHEN metadata changes THEN their load paths still work.

### Task 3: Add Codex skill presentation safeguards

**Depends on**: Tasks 1, 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Codex displays agentera skills WHEN a user inspects them THEN names, descriptions, and invocation hints match Codex conventions.
▸ GIVEN Codex can invoke a portable skill implicitly WHEN the skill is listed THEN the invocation is allowed.
▸ GIVEN Codex can invoke profilera WHEN session corpus support is missing THEN invocation is guarded or clearly limited.
▸ GIVEN a required capability is unavailable WHEN a user inspects support details THEN the limitation is actionable.

### Task 4: Add hook adapter strategy

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Copilot supports a lifecycle event WHEN agentera advertises it THEN the event uses Copilot-compatible configuration.
▸ GIVEN Codex support is experimental or disabled WHEN agentera advertises lifecycle behavior THEN the limitation is explicit.
▸ GIVEN real-time artifact validation is unavailable WHEN a runtime lacks edit/write interception THEN agentera does not claim it.
▸ GIVEN unsupported lifecycle behavior is requested WHEN validation runs THEN the unsupported behavior is reported instead of silently configured.

### Task 5: Add adapter validation coverage

**Depends on**: Tasks 2, 3, 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN runtime packaging metadata is checked WHEN tests run THEN each supported runtime has one pass and one fail case.
▸ GIVEN hook adapter configuration is checked WHEN tests run THEN each supported runtime schema has one pass and one fail case.
▸ GIVEN legacy runtime support is checked WHEN tests run THEN Claude Code and OpenCode compatibility remains covered.
▸ GIVEN validation units gain edge cases WHEN branches exceed two paths THEN added tests state the branch reason.

### Task 6: Version bump per DOCS.md convention

**Depends on**: Task 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN native runtime support is complete WHEN version targets are checked THEN the semver bump matches DOCS.md policy.
▸ GIVEN release notes are checked WHEN users read the changelog THEN Copilot and Codex support are summarized under correct categories.
▸ GIVEN profilera uses a separate version track WHEN versions are updated THEN intentional divergence is preserved or documented.

### Task 7: Plan-level freshness checkpoint

**Depends on**: Task 6
**Status**: ■ complete
**Acceptance**:
▸ GIVEN this plan's user-facing work has shipped WHEN CHANGELOG.md is checked THEN plan-level impact is summarized under [Unreleased].
▸ GIVEN this plan is otherwise complete WHEN PROGRESS.md is checked THEN one cycle entry summarizes the plan and lists produced commits.
▸ GIVEN this plan is otherwise complete WHEN TODO.md is checked THEN every task has a resolved entry or explicit no-issue-needed note.
▸ GIVEN this plan resolved prior HEALTH.md findings WHEN HEALTH.md is read THEN the next audit or PROGRESS.md notes the resolution.

## Overall Acceptance

▸ GIVEN a user installs agentera in GitHub Copilot CLI WHEN they list skills THEN portable skills appear with accurate descriptions.
▸ GIVEN a user installs agentera in OpenAI Codex CLI WHEN they open plugin or skill discovery THEN portable skills appear with accurate descriptions.
▸ GIVEN profilera appears in either runtime WHEN a user inspects it THEN limited runtime support is clear before use.
▸ GIVEN existing Claude Code or OpenCode users update agentera WHEN they use prior install paths THEN existing behavior still works.
▸ GIVEN lifecycle support differs by runtime WHEN docs are read THEN active, partial, and unsupported capabilities are clear.

## Surprises

- Task 2 passed evaluation, but realisera did not add a Task 2-specific PROGRESS entry. The evaluator accepted direct verification evidence and flagged the missing cycle log for freshness cleanup.
- Task 3 first attempt placed Codex safeguards only in aggregate metadata. Retry moved safeguards to documented per-skill metadata and passed evaluation.
- Task 6 implementation passed acceptance, but the first evaluation failed the evidence audit because no Task 6 PROGRESS entry existed. Retry added Cycle 133 evidence and passed.

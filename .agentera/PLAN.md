# Plan: Canonical Copilot Marketplace Path

<!-- Level: full | Created: 2026-04-25 | Status: active -->
<!-- Reviewed: 2026-04-25 | Critic issues: 10 found, 10 addressed, 0 dismissed -->

## What

Establish an evidence-backed Copilot marketplace install path for agentera. If no canonical source can be verified, keep the current placeholder guidance from becoming a false availability claim.

## Why

Copilot now prefers marketplace installs, but agentera still documents generic marketplace syntax. Closing that gap improves adoption while preserving the project rule: no live-host or marketplace claims without evidence.

## Constraints

- Do not claim marketplace availability without host evidence.
- Keep deprecated direct installs secondary.
- Preserve the aggregate `agentera` plugin model.
- Preserve profilera capability caveats.
- Apply DOCS.md versioning only when user-facing install support changes.

## Scope

**In**: source evidence, install guidance, validation guards, host smoke evidence, release and freshness updates.
**Out**: skill behavior changes, hook semantics changes, unsupported lifecycle parity claims.
**Deferred**: external publication steps requiring unavailable credentials, ownership, or approval.

## Design

Use an evidence gate first. Verified marketplace evidence unlocks install-surface, validation, documentation, and release work. Missing evidence produces no availability claim and leaves later tasks limited to preserving accurate caveats.

## Tasks

### Task 1: Establish Marketplace Evidence

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a candidate Copilot marketplace source WHEN the host lists or browses it THEN the verified source identity is recorded with repeatable evidence.
▸ GIVEN no canonical source is available WHEN verification runs THEN no marketplace availability claim is added.
▸ GIVEN evidence is recorded WHEN later tasks use it THEN they distinguish verified source data from assumptions.

**Evidence**:

- Verified by host command on 2026-04-25: `copilot --version` returned `GitHub Copilot CLI 1.0.35`.
- Verified source identities: `copilot plugin marketplace list` returned built-in marketplaces `copilot-plugins` as `GitHub: github/copilot-plugins` and `awesome-copilot` as `GitHub: github/awesome-copilot`.
- Verified catalog contents: `copilot plugin marketplace browse copilot-plugins` listed `workiq`, `spark`, and `advanced-security`; `copilot plugin marketplace browse awesome-copilot` listed many plugins but no `agentera` entry.
- Assumption boundary: no canonical Agentera Copilot marketplace source was verified, so later tasks must not turn `plugin@marketplace` placeholder syntax into an availability claim.

### Task 2: Align Install Surface

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN verified marketplace evidence WHEN users follow the preferred Copilot path THEN agentera installs as the aggregate plugin.
▸ GIVEN marketplace evidence is missing WHEN install guidance is reviewed THEN existing placeholder syntax does not become an availability claim.
▸ GIVEN fallback install paths remain available WHEN guidance is reviewed THEN they are clearly secondary to verified marketplace installs.

**Evidence**:

- README Copilot guidance now states no Agentera marketplace source is currently verified.
- The Copilot marketplace command uses `<plugin>@<marketplace>` as syntax only, with aggregate `agentera` named only for the future verified-source branch.
- Direct `OWNER/REPO`, `OWNER/REPO:PATH`, Git URL, and local path installs remain documented as deprecated fallback paths.

### Task 3: Guard Marketplace Claims

**Depends on**: Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN public install guidance WHEN validation runs THEN unverified marketplace availability language is rejected.
▸ GIVEN public install guidance WHEN validation runs THEN placeholder syntax cannot masquerade as a canonical source.
▸ GIVEN fallback guidance WHEN validation runs THEN deprecated paths remain semantically secondary.
▸ Test proportionality target: 1 pass + 1 fail per guidance rule; add edge coverage only for verified versus unavailable source branches.

**Evidence**:

- Validation rejects additive unverified availability claims while no canonical Agentera Copilot marketplace source is verified.
- Validation rejects placeholder-as-source commands such as `agentera@<marketplace>`.
- Validation rejects additive primary/direct `OWNER/REPO` recommendations while preserving deprecated secondary fallback wording.
- Test budget remains proportional: one README pass plus three fail tests, one per guidance rule, with additive branches covered by existing fail tests.

### Task 4: Verify Host Behavior

**Depends on**: Task 3
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a verified marketplace path WHEN a read-only host smoke runs THEN skill discovery shows the aggregate agentera plugin.
▸ GIVEN legacy per-skill installs appear WHEN installed plugins are listed THEN verification labels them as legacy entries only.
▸ GIVEN host behavior differs from local expectations WHEN verification runs THEN the discrepancy is recorded instead of hidden.

**Evidence**:

- No verified marketplace path exists, so the marketplace install smoke branch did not run and no host source was invented.
- Read-only host evidence on 2026-04-25: `copilot --version` returned `GitHub Copilot CLI 1.0.35`; `copilot plugin marketplace list` returned only `copilot-plugins` and `awesome-copilot`; browsing both catalogs still showed no `agentera` entry.
- `copilot plugin list` showed aggregate `agentera (v1.18.1)` plus legacy per-skill entries such as `realisera@agentera (v1.16.0)` and `profilera@agentera (v2.8.0)`. Those per-skill entries are verification observations only, not the supported aggregate install model.
- Discrepancy recorded: read-only `/skills list` showed several Agentera skills from existing host state but omitted installed `hej`, `inspektera`, and `profilera`, so installed plugin entries and skill discovery do not fully agree.

### Task 5: Update User Guidance

**Depends on**: Task 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN verified host behavior WHEN users read install docs THEN the preferred Copilot command uses the canonical marketplace path.
▸ GIVEN no verified source exists WHEN users read install docs THEN docs explain the current limitation without inventing a source.
▸ GIVEN support notes mention Copilot WHEN users read them THEN lifecycle support remains described without overstating parity.

**Evidence**:

- README keeps `copilot plugin install <plugin>@<marketplace>` as Copilot marketplace syntax only and does not write a canonical Agentera source because none is verified.
- README records the verified limitation: built-in Copilot marketplaces `copilot-plugins` and `awesome-copilot` were observed with no `agentera` entry.
- README keeps the aggregate `agentera` plugin model, labels older per-skill entries as legacy metadata, and records the `/skills list` omission for installed `hej`, `inspektera`, and `profilera`.
- README lifecycle notes still describe Copilot as partial adapter metadata and explicitly avoid Claude hook parity.

### Task 6: Apply Release Convention

**Depends on**: Task 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN user-facing install support changed WHEN release metadata is checked THEN DOCS.md version policy is applied consistently.
▸ GIVEN no user-facing support changed WHEN release metadata is checked THEN no unnecessary version bump occurs.
▸ GIVEN release notes are reviewed WHEN marketplace work is summarized THEN support and caveats are represented without unsupported claims.

**Evidence**:

- DOCS.md version policy applies `feat = minor`, `fix = patch`, and `docs/chore/test = no bump` across plugin, marketplace, OpenCode, per-skill, and registry version files.
- Tasks 1-5 changed README guidance, validation tests, host-evidence artifacts, and release notes, but did not verify a new Agentera Copilot marketplace source or add user-facing install capability; no version bump was applied.
- CHANGELOG [Unreleased] now states marketplace-style Copilot installs are preferred only when a verified source exists, preserves the no-source caveat, and keeps direct repo installs as deprecated fallback paths.

### Task 7: Plan-Level Freshness Checkpoint

**Depends on**: Task 6
**Status**: □ pending
**Acceptance**:
▸ GIVEN all prior tasks are complete WHEN project state is reviewed THEN progress summarizes the plan-level outcome.
▸ GIVEN marketplace work changed open caveats WHEN TODO is reviewed THEN resolved and deferred items reflect the final state.
▸ GIVEN public history is reviewed WHEN changelog entries are checked THEN marketplace support and caveats are represented once.

## Overall Acceptance

▸ GIVEN a canonical Copilot marketplace source exists WHEN users follow the documented path THEN agentera installs as the aggregate plugin.
▸ GIVEN no canonical source can be verified WHEN the plan completes or pauses THEN no unsupported marketplace claim ships.
▸ GIVEN validation and host smoke run WHEN the plan completes THEN docs, Copilot-facing metadata, and release state agree.

## Surprises

- Task 4: No verified marketplace path exists, so the aggregate marketplace install/discovery branch could not run. Existing installed host state still shows aggregate `agentera` plus legacy per-skill entries, and `/skills list` omits some installed Agentera skills.

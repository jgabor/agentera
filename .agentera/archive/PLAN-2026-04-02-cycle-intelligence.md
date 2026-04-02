# Plan: Realisera cycle intelligence — context snapshots, decision gates, tiered audits

<!-- Level: full | Created: 2026-04-02 | Status: active -->
<!-- Reviewed: 2026-04-02 | Critic issues: 10 found, 9 addressed, 1 dismissed -->

## What
Add three improvements to realisera's cycle workflow that make autonomous runs more coherent and self-correcting: (1) a structured context snapshot capturing each cycle's intent, (2) a gate that checks for unresolved decisions before building on uncertain foundations, and (3) change-magnitude awareness that lets inspektera scale audit depth.

## Why
These address drift in multi-cycle autonomous runs. Currently realisera has a compaction-survival mechanism (listing 3-5 facts in conversation), but no durable cross-cycle intent record in artifacts. There is no mechanism to flag when realisera is about to build on an `exploratory` decision. And inspektera audits at uniform depth regardless of change volume since the last audit.

## Constraints
- Changes are SKILL.md edits, ecosystem-spec format contract, template, and script tolerance. No new files.
- Realisera and inspektera must remain fully standalone.
- The context snapshot must fit within the existing PROGRESS.md ≤500 word per-cycle budget (≤80 word sub-budget for the snapshot).
- The decision gate is a soft suggestion, not a hard block.
- Inspektera derives magnitude from commit hashes already in PROGRESS.md via `git log --stat` — no new inter-skill field.
- The existing "3-5 facts" compaction guard in conversation is preserved. The snapshot supplements it (cross-cycle state), not replaces it (within-cycle state).

## Scope
**In**: `skills/realisera/SKILL.md`, `skills/inspektera/SKILL.md`, `references/ecosystem-spec.md` (PROGRESS.md format contract), `skills/realisera/references/templates/PROGRESS-template.md`, `skills/realisera/scripts/analyze_progress.py` (tolerance check only)
**Out**: planera, other skills, registry.json, README, plugin manifests
**Deferred**: ISS-19 (explicit phase tracking in PROGRESS.md)

## Design
**Context snapshot (ISS-16)**: After Step 2 (Pick work), realisera composes a 4-field context block capturing pre-cycle intent: intent, constraints, unknowns, scope. The block is written to PROGRESS.md during Step 8 (Log) as part of the cycle entry. Four fields, not five — "task" and "outcome" merge into "intent" for budget efficiency. The "scope" field captures areas expected to be affected (pre-cycle prediction, not file list — the actual files changed are derivable from the commit hash and excluded per ecosystem-spec Section 4 content exclusion). The existing "3-5 facts" compaction guard stays — it serves within-cycle survival; the snapshot serves cross-cycle coherence.

**Decision gate (ISS-18)**: In Step 1 (Orient), realisera's DECISIONS.md reading expands from "firm and provisional only" to all confidence levels. In Step 2 (Pick work), after selecting work, realisera checks whether any `exploratory` entries relate to the selected work area. If found, it flags the situation, suggests `/resonera`, notes the risk in the cycle's Context unknowns field, but proceeds in autonomous mode (soft gate).

**Tiered audit depth (ISS-17)**: Inspektera already reads PROGRESS.md in Step 1 and has access to commit hashes. In Step 2 (Select dimensions), it derives change magnitude from `git log --stat` on recent commit hashes and cycle count since last audit. Based on magnitude, it applies advisory depth guidance: lighter for small change volumes, deeper for large or architectural changes. Thresholds are advisory, not deterministic.

## Tasks

### Task 1: Add context snapshot to realisera cycle workflow
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN realisera completes a cycle WHEN PROGRESS.md is updated in Step 8 THEN the cycle entry includes a Context block with four fields: intent, constraints, unknowns, scope
▸ GIVEN realisera's Step 1 (Orient) WHEN reading prior cycles from PROGRESS.md THEN the prior cycle's Context block is used for continuity alongside the existing "3-5 facts" compaction guard
▸ GIVEN the Context block fields WHEN the total snapshot is written THEN it fits within ≤80 words across all four fields
▸ GIVEN the ecosystem-spec PROGRESS.md format contract WHEN reviewed THEN it documents the Context block as an optional additive section
▸ GIVEN the PROGRESS-template.md WHEN reviewed THEN it includes the Context block in the entry format reference
▸ GIVEN analyze_progress.py WHEN parsing a PROGRESS.md with Context blocks THEN it does not error (existing field extraction is unaffected by additive sections)

### Task 2: Add unresolved-decision gate to realisera work selection
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN DECISIONS.md contains an exploratory entry related to the selected work area WHEN realisera picks work in Step 2 THEN the exploratory entry is flagged with a suggestion to run /resonera
▸ GIVEN autonomous operation WHEN an exploratory decision is flagged THEN realisera notes the risk in the Context unknowns field but proceeds (soft gate)
▸ GIVEN no DECISIONS.md exists or no exploratory entries relate to the work WHEN realisera picks work THEN no gate triggers and no overhead is added

### Task 3: Add change-magnitude depth scaling to inspektera
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN inspektera reads PROGRESS.md in Step 1 WHEN commit hashes are present THEN it derives change magnitude from `git log --stat` on recent commits since the last audit
▸ GIVEN inspektera's Step 2 (Select dimensions) WHEN change magnitude is derived THEN it applies advisory depth guidance (lighter for small changes, deeper for large or architectural changes)
▸ GIVEN no PROGRESS.md or no commit hashes WHEN dimensions are selected THEN default depth is used with no errors (standalone operation preserved)

## Overall Acceptance
▸ GIVEN a multi-cycle autonomous run WHEN each cycle completes THEN PROGRESS.md contains a structured context snapshot that subsequent cycles can read for continuity
▸ GIVEN realisera is about to build on an exploratory decision WHEN the decision gate triggers THEN the autonomous log captures the uncertain foundation
▸ GIVEN inspektera runs after a series of small changes WHEN it assesses dimensions THEN audit effort is lighter than after a series of large changes
▸ GIVEN either skill is installed without the other WHEN it runs THEN it operates correctly with no errors or degraded functionality

## Surprises
[Empty — populated by realisera during execution]

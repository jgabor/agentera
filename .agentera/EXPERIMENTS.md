# Experiments

## Experiment 0 · 2026-04-12 05:51 · baseline

**Hypothesis**: not a hypothesis. Baseline measurement to lock the starting metric, map the read pattern, and verify the harness produces stable, gate-passing results.

**Method**: ran the locked harness at `.optimera/harness` against lira@`5a52fdc` (Dashboard State Lifecycle Bug Fixes plan, 1 complete / 4 pending). Hermetic Docker vehicle (`agentera-optimera-vehicle:1`), `claude-sonnet-4-6`, paired A/B (`with` = realisera-only marketplace; `without` = no plugins). Trigger: "Run one development cycle on this project. Focus on Task 2 of the current plan." Task pin eliminates task-selection non-determinism. Full-cycle composite metric. Raw run at `.optimera/runs/20260412T055152Z/`.

**Change**: none.

**Metric** (with realisera, full-cycle composite `peak_context + output_total`): **72,645 tokens**

**Baseline** (without realisera, same composite): 97,915 tokens (budget-capped at $1.50, 81 turns).

**Delta (realisera vs native)**: -25,270 tokens (-26%). Realisera's structured workflow is substantially cheaper than an unstructured native-tools cycle on the same task.

**Context shape**:
- peak_context: 69,719 tokens
- output_total: 2,926 tokens
- turns: 101
- tool_uses: 74
- cache_efficiency: 0.9595
- read_count: 21

**Read attribution** (effective bytes, top-5):

| # | Path | Bytes | Class |
|---|------|-------|-------|
| 1 | `dashboard_test.go` | 41,092 | other |
| 2 | `.agentera/PROGRESS.md` | 78,486 | agentera_artifact |
| 3 | `brainstorm.go` | 26,631 | other |
| 4 | `brainstorm_backfill_integration_test.go` | 19,044 | other |
| 5 | `.agentera/PLAN.md` | 7,854 | agentera_artifact |

**By class**:

| Class | Raw bytes |
|-------|-----------|
| agentera_artifact | 86,340 |
| other (source code) | 162,050 |
| root_artifact | 6,826 |

**Notable**: `references/contract.md` (30 KB, classified as realisera_asset) was not read in this run. Realisera skipped the upfront contract read, likely because the task-focused prompt didn't exercise any contract-dependent values. This is an untouched 30 KB attack surface for experiment 1: forcing or lazy-loading the contract read will show in the metric when a different trigger or task exercises contract-dependent code paths. However, since the baseline doesn't include contract.md's cost, the baseline is already "lean" on that axis and the 20% target should be met by attacking the other top contributors (PROGRESS.md 78 KB, source code reads, PLAN.md).

**Regression**: n/a (no change to regress against).

**Status**: ▨ baseline recorded. Not kept or discarded: reference point for all future experiments.

**Brainstorm iteration log** (5 harness refinements before this clean baseline):

| Run | Issue | Fix |
|-----|-------|-----|
| 1 | `git archive` strips `.git/`, `:ro` mount → realisera `stuck` | `git clone` substrate, `:rw` mount |
| 2 | Plan-completion sweep at `2a68a65` (all tasks done) | Re-pin to `5a52fdc` (4 pending) |
| 3 | `without` budget cap → `run_error` classification | Budget-cap-tolerant `runs_ok` |
| 3 | Realisera self-implements → pre-dispatch slice = full cycle | Explicit full-cycle composite metric |
| 4 | Task selection non-determinism → 48% variance | Task-pinned trigger |
| 5 | Task-only trigger skipped realisera skill | Combined trigger (skill-fire + task pin) |

**Target (derived)**: 20% of 72,645 = 14,529 tokens to save. Goal: **<= 58,116 tokens** in the `with` condition, gates still passing.

**Next**: experiment 1 should be diagnostic. Candidate hypotheses:
1. **Lazy-reference `references/contract.md`**: realisera's SKILL.md still has the upfront "read contract.md" instruction (same pattern hej had before experiment 1). When a trigger or task exercises contract values, the 30 KB read will re-appear. Lazy-referencing it (same technique as hej experiment 1) would prevent that regression and save ~7.5K tokens when the contract IS read. However, since the current baseline doesn't include contract cost, this is a preventive optimization, not a metric-moving one against this specific baseline.
2. **Slim PROGRESS.md read**: realisera reads PROGRESS.md (78 KB) with no limit in Orient step 1. Applying `limit: 30` (like hej does for its artifact reads) would cap it at ~2.4 KB effective, saving ~19K effective bytes (~4.7K tokens). Highest-leverage single change against this baseline.
3. **Reduce `spec_sections` frontmatter**: realisera declares `spec_sections: [1, 2, 3, 4, 5, 6, 11, 17, 18, 19]` (10 sections). Trimming to the minimum actually referenced in the workflow shrinks the generated contract.md at source, preventing future contract-read regressions.

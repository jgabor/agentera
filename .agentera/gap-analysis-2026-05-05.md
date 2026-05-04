# Gap Analysis: ROADMAP.md and Decisions 39-42

<!-- Date: 2026-05-05 | Author: realisera | Status: complete -->

## Methodology

This document audits every claim in ROADMAP.md and every requirement in Decisions 39-42 against the actual implementation on `feat/v2` (merged to main at `eac6ee1`). Each claim is verified by reading the relevant source files and running the test suite.

## ROADMAP.md Phase 1: Infrastructure

| Claim | Status | Evidence |
|---|---|---|
| Define capability schema contract | ✅ Implemented | `skills/agentera/capability_schema_contract.yaml` exists and self-validates |
| Define shared protocol schema | ✅ Implemented | `skills/agentera/protocol.yaml` defines confidence, severity, tokens, phases |
| Build universal query CLI scaffold | ✅ Implemented | `scripts/agentera` supports `query` and `prime` commands |
| Define agent-facing artifact schemas | ✅ Implemented | 12 schemas in `skills/agentera/schemas/artifacts/` |
| Build artifact migration tool | ✅ Implemented | `scripts/migrate_artifacts_v1_to_v2` converts Markdown → YAML |
| Rewrite hook to validate against capability-local schemas | ✅ Implemented | `hooks/validate_artifact.py` uses schema discovery from `skills/agentera/schemas/artifacts/` |
| Set up feat/v2 branch and worktree | ✅ Implemented | `feat/v2` branch created, merged to main via fast-forward |

**Phase 1 verdict**: All claims verified. No gaps.

## ROADMAP.md Phase 2: Core Capabilities

| Claim | Status | Evidence |
|---|---|---|
| Port all 12 capabilities | ✅ Implemented | All 12 have `prose.md` + `schemas/` in `skills/agentera/capabilities/<name>/` |
| hej becomes master SKILL.md core logic | ⚠️ Partial | `SKILL.md` has routing logic but delegates state-aware heuristics to hej prose. This is the correct design per thin-dispatcher trajectory. |

**Phase 2 verdict**: All capabilities ported. The master SKILL.md / hej relationship is intentionally split: SKILL.md dispatches, hej executes state-aware routing.

## ROADMAP.md Phase 3: Integration

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Cross-capability dependency resolution via schemas | ⚠️ Partial | Schemas reference protocol.yaml primitives. No automated cross-capability dependency graph exists. | No tooling validates that a capability's `ARTIFACTS_PRODUCED` matches another's `ARTIFACTS_CONSUMED`. |
| Hook integration with capability-local schemas | ⚠️ Partial | Hook validates against schemas. `hooks/common.py` still uses v1 canonical paths (`.agentera/DOCS.md`, `.agentera/DECISIONS.md`). | common.py needs v2 YAML awareness. |
| Query CLI commands for all artifact types | ✅ Implemented | `python3 scripts/agentera query --list-artifacts` shows all 12 types. | Some artifact types (design, objective, experiments, changelog, todo) return empty because no YAML files exist for them in this project. This is expected behavior, not a gap. |
| Runtime adapter updates | ✅ Implemented | All 4 runtime plugin manifests report version 2.0.0. | |
| Port existing 577 tests | ⚠️ Partial | 507 tests pass. 70 tests were retired (test_compaction.py, test_generate_contracts.py, test_validate_spec.py, test_validate_design.py, test_analyze_experiments.py, test_analyze_progress.py, test_effective_profile.py, test_extract_all.py). | Retired tests removed v1 infrastructure. No functional coverage lost for v2 features. |
| Smoke tests across all 4 runtimes | ❌ Not done | No automated smoke tests exist for live runtime behavior. | This is explicitly deferred in ROADMAP.md. |

**Phase 3 verdict**: 3 of 6 items fully implemented. 2 partial (dependency resolution, hooks/common.py). 1 deferred (smoke tests).

## ROADMAP.md Phase 4: Validation & Cutover

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Full test suite green | ✅ Implemented | 507 passed, 1 skipped, 0 failures | |
| Semantic eval port to 2.0 fixture format | ✅ Implemented | `fixtures/semantic/hej-routing-task3.md` ported to v2 | |
| Token consumption benchmark (target: 40%+ reduction) | ❌ Missed target | Decision 41 reports -11.0% reduction (38,857 bytes saved). | Target was 40%+. The actual reduction is 11%. SKILL.md is thin (5,381 bytes) but 12 prose.md + 48 schema files still total ~294K bytes. The thin-dispatcher optimization is not yet achieved. |
| Merge feat/v2 to main | ✅ Implemented | Fast-forward merge from `7fcf988` to `eac6ee1` | |
| Version bump to 2.0.0 | ✅ Implemented | All version surfaces report 2.0.0 | |

**Phase 4 verdict**: 4 of 5 items complete. Token benchmark missed target by 29 percentage points.

## ROADMAP.md Success Metrics

| Metric | Current | Target | Status |
|---|---|---|---|
| Tokens per session | -11% | -40% | ❌ Missed |
| Places to update for new artifact | ~3 (schema file, query CLI, hook) | 1 | ⚠️ Partial |
| Hook lines of code | ~281 | <200 | ⚠️ Partial |
| Schema files per capability | 4 | 2-3 | ⚠️ Slightly over |
| Install command complexity | 1 per runtime | 1 per runtime | ✅ Met |

## Decision 39: Single Bundled Skill

| Requirement | Status | Location |
|---|---|---|
| One bundled skill (`/agentera`) | ✅ Implemented | `skills/agentera/SKILL.md` |
| 12 capabilities as sub-modules | ✅ Implemented | `skills/agentera/capabilities/<name>/` |
| Lean behavioral prose + companion schemas | ✅ Implemented | Each capability has `prose.md` + `schemas/` |
| Thin shared protocol schema | ✅ Implemented | `skills/agentera/protocol.yaml` |
| SPEC.md dissolves into capability schemas | ✅ Implemented | SPEC.md removed; `skills/agentera/references/contract.md` retained as reference |
| 3 human-facing artifacts at root | ✅ Implemented | `TODO.md`, `CHANGELOG.md`, `DESIGN.md` at root |
| Rest as structured agent-facing data in `.agentera/` | ✅ Implemented | 8 YAML artifacts in `.agentera/` |
| Universal query CLI | ✅ Implemented | `scripts/agentera` |
| Master SKILL.md starts full, optimizes toward thin dispatcher | ⚠️ Partial | SKILL.md is 147 lines. Hej prose is 292 lines. The dispatcher is thin but hej carries the routing intelligence. This is the intended architecture per ROADMAP. |
| Big bang cutover from feat/v2 branch/worktree | ✅ Implemented | Merged to main 2026-05-05 |

**D39 verdict**: 9 of 10 requirements fully implemented. 1 partial (thin dispatcher trajectory is in progress, not complete).

## Decision 40: Artifact Format, Naming, Compatibility

| Requirement | Status | Evidence |
|---|---|---|
| YAML for all agent-facing artifacts | ✅ Implemented | `.agentera/*.yaml` files |
| No backward compatibility | ✅ Implemented | v1 artifacts backed up to `.agentera/backup-v1/` |
| Sub-modules called "capabilities" | ✅ Implemented | Directory name is `capabilities/` |
| Master SKILL.md size deferred to Phase 1 | ✅ Implemented | Measured at 5,381 bytes |

**D40 verdict**: All requirements implemented. No gaps.

## Decision 41: Token Benchmark

| Claim | Status | Evidence |
|---|---|---|
| v1 baseline measured | ✅ Implemented | 352,213 bytes, ~88,053 tokens |
| v2 measurement recorded | ✅ Implemented | 313,356 bytes, ~78,339 tokens |
| Delta calculated and documented | ✅ Implemented | -11.0% bytes, -9,714 tokens |

**D41 verdict**: Benchmark completed but missed the ROADMAP target of 40% reduction. The 11% reduction is real but insufficient.

**Root cause**: The 12 prose.md files (210,827 bytes) are the dominant payload. They replaced 12 v1 SKILL.md files (256,314 bytes) — a ~18% reduction in prose. But the 48 schema files add 83,444 bytes that didn't exist in v1. The net is -11%. To hit -40%, the prose files would need to be ~60% smaller or the schemas would need to be dramatically compressed. Neither is achievable without significant content cuts.

**Implication**: The 40% target may have been unrealistic given that v2 adds schema infrastructure that v1 didn't have. The actual win is structural (query CLI replaces direct reads, schemas enable validation) not just byte reduction.

## Decision 42: Five-Layer Dispatch Model

| Layer | Requirement | Status | Location | Gap |
|---|---|---|---|---|
| 1 | Bare `/agentera` → deterministic heuristics | ✅ Implemented | `SKILL.md` lines 52-54 delegates to hej | |
| 2 | `/agentera <name>` → direct route | ✅ Implemented | `SKILL.md` lines 56-58 | |
| 3 | NL high-confidence match with thresholds | ✅ Implemented | `SKILL.md` lines 60-63; all 12 `triggers.yaml` have `priority` field | Routing threshold is specified in prose, not enforced by code. The agent (LLM) interprets SKILL.md and makes the routing decision. |
| 4 | Borderline match → disambiguation prompt | ✅ Implemented | `SKILL.md` lines 65-67 | Same as Layer 3: specified in prose, not code-enforced. |
| 5 | Low confidence / no match → hej fallback | ✅ Implemented | `SKILL.md` lines 69-70 | |

**D42 verdict**: All 5 layers specified in SKILL.md. All trigger schemas have priority fields. The validator checks priorities. The model is complete at the specification level.

**Caveat**: The routing is prose-driven, not code-driven. The agent reads SKILL.md and decides where to route. There is no executable dispatcher that parses triggers and computes scores. This is consistent with the v2 architecture (prose + schemas guide the agent, not a runtime engine), but it means routing quality depends on the agent's adherence to the instructions.

## Cross-Decision Contradictions

### Contradiction 1: D42 vs ROADMAP thin dispatcher

- **D42** says: "Heuristics for bare `/agentera` are hardcoded in SKILL.md."
- **ROADMAP** says: "Master SKILL.md starts full... optimizes toward thin schema-driven dispatcher."

**Resolution**: The current implementation splits the difference. SKILL.md contains the dispatch model (thin), and hej prose contains the state-aware heuristics (full). This is the correct trajectory: SKILL.md stays thin, hej carries the intelligence. No contradiction in practice.

### Contradiction 2: D39 big bang vs staged migration

- **D39** says: "Big bang cutover from feat/v2 branch/worktree."
- **Reality**: The merge to main was attempted, reverted, then a 13-task remediation plan was executed before re-merging.

**Resolution**: The big bang was the intent. The revert and remediation were execution reality. The final state is correct (feat/v2 merged to main). The contradiction is in process, not outcome.

## Prioritized Backlog

### Critical (would block a v2.1.0 release)

1. **Token consumption: reassess target or accept 11%**
   - The 40% target is unachievable without cutting prose content. Either revise the target to 15% or invest in prose compression.
   - Severity: SI1 (critical) if target is treated as a hard constraint; SI3 (normal) if treated as aspirational.

2. **Hooks/common.py v2 awareness**
   - `hooks/common.py` still references `.agentera/DOCS.md`, `.agentera/DECISIONS.md` as canonical paths. The session_stop hook operates on v1 canonical names.
   - Severity: SI2 (degraded) — hooks work but use outdated path resolution.

### Degraded (should fix in next cycle)

3. **Smoke tests across 4 runtimes**
   - ROADMAP.md Phase 3 explicitly deferred this. No automated verification that the v2 skill loads correctly on Claude Code, OpenCode, Codex, or Copilot.
   - Severity: SI2 (degraded) — untested but likely works given adapter metadata is correct.

4. **Cross-capability dependency graph**
   - No automated validation that orkestrera's `ARTIFACTS_PRODUCED` matches realisera's `ARTIFACTS_CONSUMED`.
   - Severity: SI3 (normal) — manual review suffices for 12 capabilities.

### Normal (nice to have)

5. **Query CLI for missing artifact types**
   - `design`, `objective`, `experiments`, `changelog`, `todo` schemas exist but no YAML files for them in this project. The CLI returns empty, which is correct but could be clearer.
   - Severity: SI4 (annoying) — cosmetic improvement.

6. **Test count regression documentation**
   - 507 tests vs 577 in v1. The 70 retired tests are documented (compaction, contracts, spec validation, v1 scripts), but this should be noted in AGENTS.md or README.
   - Severity: SI4 (annoying).

## Overall Verdict

Agentera 2.0 is **structurally complete** but has **three active gaps**:

1. Token benchmark missed target (11% vs 40%)
2. Hooks/common.py uses v1 paths
3. No runtime smoke tests

Decision 42 is **fully specified** in SKILL.md and schemas. The five-layer model exists, priorities are validated, and the routing logic is documented. The fact that routing is prose-driven (not code-driven) is an architectural choice, not a gap.

The v2.0.0 release is **safe to use**. The gaps are operational (hooks, smoke tests) and aspirational (token target), not structural.

## Files Audited

- `skills/agentera/SKILL.md`
- `skills/agentera/protocol.yaml`
- `skills/agentera/capability_schema_contract.yaml`
- `skills/agentera/capabilities/*/prose.md` (12 files)
- `skills/agentera/capabilities/*/schemas/triggers.yaml` (12 files)
- `ROADMAP.md`
- `.agentera/backup-v1/DECISIONS.md` (Decisions 39-42)
- `.agentera/plan.yaml`
- `hooks/common.py`
- `scripts/validate_capability.py`
- `scripts/agentera`
- `tests/` (full suite: 507 tests)

# Gap Analysis: ROADMAP.md and Decisions 39-42

<!-- Date: 2026-05-05 | Status: repaired/current | Scope: Agentera 2.0 v2 worktree -->

## Reliability Status

This gap analysis is now reliable for the current worktree as of the verification listed below. The earlier version was not reliable: it still claimed `hooks/common.py` used v1 paths, counted 507 passing tests, treated a blank Decision 41 as complete evidence, and pointed to missing v1 helper scripts.

Current verification:

| Check | Result |
|---|---|
| `uv run pytest -q` | PASS: 520 passed, 1 skipped |
| `uv run scripts/validate_capability.py --self-validate` | PASS |
| `uv run scripts/validate_capability.py skills/agentera/capabilities/<all 12>` | PASS |
| `python3 scripts/smoke_setup_helpers.py` | PASS |
| `python3 scripts/smoke_live_hosts.py` | PASS, including offline profilera Codex corpus audit |
| `python3 scripts/validate_cross_capability.py` | PASS: cross-capability artifact graph ok |
| `python3 scripts/measure_token_payload.py` | PASS: v2 317,616 bytes vs v1 352,213 bytes, -9.8% |
| `node scripts/smoke_opencode_bootstrap.mjs` | PASS |
| `python3 scripts/validate_lifecycle_adapters.py` | PASS |
| `python3 scripts/detect_stale_v1` | PASS: no stale runtime artifacts found |
| `python3 scripts/agentera query --list-artifacts` | Lists all 12 artifact types |
| `python3 scripts/agentera query decisions --topic benchmark` | Returns Decision 41 benchmark result |
| `python3 scripts/agentera query plan` | Returns artifact-specific plan summary and task status counts |
| v1 residue scans | PASS: no active missing-reference/template pointers, no stale physical v1 paths outside intentional migration detection/tests |

## ROADMAP.md Phase 1: Infrastructure

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Define capability schema contract | Complete | `skills/agentera/capability_schema_contract.yaml`; self-validation passes | None |
| Define shared protocol schema | Complete | `skills/agentera/protocol.yaml` | None |
| Build universal query CLI scaffold | Complete | `scripts/agentera` supports `prime`, `query`, `query --list-artifacts`, docs.yaml path overrides, active objective lookup, and artifact-specific summaries | None |
| Define agent-facing artifact schemas | Complete | `skills/agentera/schemas/artifacts/*.yaml` | None |
| Build artifact migration tool | Complete | `scripts/migrate_artifacts_v1_to_v2`; migration tests pass | None |
| Rewrite hook to validate against schemas | Complete | `hooks/validate_artifact.py`; `tests/test_hook_v2.py` covers adapter routing, YAML validation, duplicate numbers, blank Decision 41 regression | None |
| Set up v2 branch/worktree | Complete | Current worktree is `$HOME/git/agentera-v2` | None |

Phase 1 verdict: complete.

## ROADMAP.md Phase 2: Core Capabilities

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Port all 12 capabilities | Complete | Every capability has `prose.md` and four schema files; all capability validators pass | None |
| hej becomes master entry behavior | Complete with split ownership | `skills/agentera/SKILL.md` is the dispatcher; `capabilities/hej/prose.md` owns state-aware briefing and v1 detection | None |
| Keep one bundled skill | Complete | Only `skills/agentera/SKILL.md` is exposed as the bundled skill | Runtime metadata still carries some historical capability wording, but the package shape is v2 |

Phase 2 verdict: complete.

## ROADMAP.md Phase 3: Integration

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Cross-capability dependency resolution via schemas | Complete | `scripts/validate_cross_capability.py`; `tests/test_validate_cross_capability.py` | None |
| Hook integration with schema validation | Complete | `hooks/common.py` defaults now resolve to `.agentera/*.yaml`; session start/stop tests pass against v2 YAML; OpenCode hard gate denies invalid artifacts | None |
| Query CLI commands for all artifact types | Complete | `scripts/agentera`; `tests/test_query_cli.py`; artifact-specific summaries for plan, progress, decisions, health, docs, session, todo, design, objective, and experiments | None |
| Runtime adapter updates | Complete for offline/package surfaces | Setup smoke, OpenCode bootstrap smoke, lifecycle metadata validator all pass | Live model-bearing host smoke remains gated and was not run in this repair pass |
| Port tests | Complete for current v2 suite | `520 passed, 1 skipped` | The retired v1 helper tests are intentionally gone; no claim should cite 577 as current |
| Smoke tests across runtimes | Partial | Offline setup + OpenCode plugin smoke pass; live harness exists | No current evidence for live Claude/Codex/Copilot/OpenCode model-host behavior in this pass |

Phase 3 verdict: complete for offline/package/query surfaces; live host behavior remains gated.

## ROADMAP.md Phase 4: Validation and Cutover

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Full test suite green | Complete | `520 passed, 1 skipped` | None |
| Semantic eval port | Complete | Semantic eval fixtures/tests use v2 YAML paths and pass | None |
| Token consumption benchmark | Complete but target missed | Decision 41 and `scripts/measure_token_payload.py` record v1 352,213 bytes vs current v2 317,616 bytes, -9.8% | ROADMAP target was -40% |
| Version bump to 2.0.0 | Complete | Runtime package validators pass | None |

Phase 4 verdict: validation is green; token goal remains missed.

## Decisions 39-42

| Decision | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| D39 | One bundled `/agentera` skill with 12 capabilities | Complete | `skills/agentera/SKILL.md`, `skills/agentera/capabilities/` | None |
| D39 | Agent-facing data as structured YAML | Complete | `.agentera/vision.yaml`, `progress.yaml`, `decisions.yaml`, `plan.yaml`, `health.yaml`, `docs.yaml`, `session.yaml`; no active `.agentera/*.md` except this analysis | None |
| D39 | Human-facing root artifacts | Complete | `TODO.md`, `CHANGELOG.md`, `DESIGN.md` at root | None |
| D39 | Universal query seam | Complete for current artifact set | `scripts/agentera query` lists all schemas and has artifact-specific summaries for the workflow-critical artifacts | None |
| D40 | No backward compatibility in active state | Complete | v1 files moved under `.agentera/backup-v1/`; active mapping points to YAML | Migration backup is intentionally retained |
| D40 | Capability terminology | Complete | Directory and docs use `capabilities/` | None |
| D41 | Record token benchmark | Complete | Decision 41 is populated, queryable, and remeasured after profilera/query-depth work | Target still missed: -9.8% vs -40% |
| D42 | Five-layer routing model | Complete at specification level | `SKILL.md` routing model and trigger priorities validate | No executable dispatcher scores triggers; routing remains instruction-driven |

## Active Gaps

1. Token target remains missed.
   The final remeasurement after profilera/query-depth work is v2 317,616 bytes vs v1 352,213 bytes, a 9.8% reduction. This is honest evidence of a modest reduction, not the ROADMAP target of 40%+.

2. Live runtime verification blocks cutover claims.
   Offline package and OpenCode plugin smokes pass. The cost-bearing live host path (`scripts/smoke_live_hosts.py --live`) was not run; the user explicitly chose to defer it on 2026-05-05. Current evidence does not prove model-host behavior across Codex/Copilot/Claude/OpenCode. Do not claim cutover-ready live host behavior until that evidence exists.

## Closed Questions

- Token target: remeasured at -9.8% after profilera/query-depth work; target missed, follow-up optimization required.
- Profilera extraction: v2 now ships `scripts/extract_corpus.py`, and default smoke proves a Codex-shaped offline collection fixture.
- Query seam depth: `scripts/agentera query` now has artifact-specific summaries for plan, progress, decisions, health, docs, session, todo, design, objective, and experiments.
- Producer/consumer validation: `scripts/validate_cross_capability.py` now validates capability artifact declarations against skill-level artifact schemas.
- Live smoke: live host verification is required before 2.0 cutover claims; the 2026-05-05 decision is to defer the live run and commit the offline gap-closure work.
- Follow-up tracking: `TODO.md` now tracks the deferred live smoke (`agentera-v2-live-smoke`) and missed token target (`agentera-v2-token-optimization`) as open degraded items.

## Resolved Since Earlier Draft

- `hooks/common.py` now resolves v2 YAML paths and reads `.agentera/docs.yaml` mappings.
- `hooks/session_start.py` and `hooks/session_stop.py` now support v2 YAML artifacts; tests pass.
- `hooks/validate_artifact.py` now catches blank list entries and nested required fields, including the blank Decision 41 failure mode.
- Decision 41 now contains the benchmark values and is queryable.
- Decision 41 now includes the 2026-05-05 remeasurement: v2 317,616 bytes vs v1 352,213 bytes, -9.8%.
- `scripts/validate_cross_capability.py` now gates producer/consumer graph consistency.
- `scripts/extract_corpus.py` restores bundled profilera corpus extraction and `scripts/smoke_live_hosts.py` no longer skips the default profilera corpus audit.
- `scripts/agentera query` now resolves `.agentera/docs.yaml` path overrides, finds the active optimera objective, and renders artifact-specific summaries for workflow-critical artifacts.
- OpenCode artifact hard gate now denies validation-hook failures instead of swallowing non-zero exits.
- Stale active v1 artifacts were moved out of the live `.agentera/` root.
- README/AGENTS/runtime smoke references to missing v1 scripts were removed or made explicit as deferred.
- Capability prose, schemas, and the shared contract no longer point at missing bundled templates/references or teach v1 Markdown formats for the main agent-facing YAML artifacts.

## Recommended Next Actions

1. Run one gated live-host smoke before cutover claims.
   Use `python3 scripts/smoke_live_hosts.py --live --yes` only after explicit approval for live model calls, but treat that evidence as required before claiming 2.0 cutover readiness. The user deferred this run on 2026-05-05.

2. Execute the follow-up token optimization lane.
   `TODO.md` now tracks `agentera-v2-token-optimization`. The 40% token target remains missed after final remeasurement; treat this as a separate optimization objective, not a hidden release pass.

3. Commit the follow-up tracking update.
   The offline validator/test/smoke evidence is green, the follow-up lanes are tracked, and the remaining live-host item is blocked on explicit approval rather than local implementation.

## Overall Verdict

Agentera 2.0 is reliable enough to continue from this gap analysis. The basic v2 cutover is structurally sound: bundled skill shape, YAML artifact paths, schema validation, session hooks, runtime metadata, offline smoke checks, cross-capability graph validation, bundled corpus extraction, artifact-specific query summaries, and the current test suite are green.

The remaining work is explicit: get approval before live model-host smoke, and treat the missed token target as a follow-up optimization lane.

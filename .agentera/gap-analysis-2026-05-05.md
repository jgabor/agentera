# Gap Analysis: ROADMAP.md and Decisions 39-42

<!-- Date: 2026-05-05 | Status: repaired/current | Scope: Agentera 2.0 v2 worktree -->

## Reliability Status

This gap analysis is now reliable for the current worktree as of the verification listed below. The earlier version was not reliable: it still claimed `hooks/common.py` used v1 paths, counted 507 passing tests, treated a blank Decision 41 as complete evidence, and pointed to missing v1 helper scripts.

Current verification:

| Check | Result |
|---|---|
| `uv run pytest -q` | PASS: 508 passed, 1 skipped |
| `uv run scripts/validate_capability.py --self-validate` | PASS |
| `uv run scripts/validate_capability.py skills/agentera/capabilities/<all 12>` | PASS |
| `python3 scripts/smoke_setup_helpers.py` | PASS |
| `python3 scripts/smoke_live_hosts.py` | PASS, with profilera corpus audit explicitly skipped because no v2 extractor ships |
| `node scripts/smoke_opencode_bootstrap.mjs` | PASS |
| `python3 scripts/validate_lifecycle_adapters.py` | PASS |
| `python3 scripts/detect_stale_v1` | PASS: no stale runtime artifacts found |
| `python3 scripts/agentera query --list-artifacts` | Lists all 12 artifact types |
| `python3 scripts/agentera query decisions --topic benchmark` | Returns Decision 41 benchmark result |
| v1 residue scans | PASS: no active missing-reference/template pointers, no stale physical v1 paths outside intentional migration detection/tests |

## ROADMAP.md Phase 1: Infrastructure

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Define capability schema contract | Complete | `skills/agentera/capability_schema_contract.yaml`; self-validation passes | None |
| Define shared protocol schema | Complete | `skills/agentera/protocol.yaml` | None |
| Build universal query CLI scaffold | Complete | `scripts/agentera` supports `prime`, `query`, and `query --list-artifacts` | Rich queries remain shallow for several artifact types |
| Define agent-facing artifact schemas | Complete | `skills/agentera/schemas/artifacts/*.yaml` | None |
| Build artifact migration tool | Complete | `scripts/migrate_artifacts_v1_to_v2`; migration tests pass | None |
| Rewrite hook to validate against schemas | Complete | `hooks/validate_artifact.py`; `tests/test_hook_v2.py` covers adapter routing, YAML validation, duplicate numbers, blank Decision 41 regression | None |
| Set up v2 branch/worktree | Complete | Current worktree is `$HOME/git/agentera-v2` | None |

Phase 1 verdict: complete, with query depth as a post-2.0 improvement rather than a cutover blocker.

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
| Cross-capability dependency resolution via schemas | Partial | Schemas declare artifact producers/consumers | No automated producer/consumer graph validates cross-capability consistency |
| Hook integration with schema validation | Complete | `hooks/common.py` defaults now resolve to `.agentera/*.yaml`; session start/stop tests pass against v2 YAML; OpenCode hard gate denies invalid artifacts | None |
| Query CLI commands for all artifact types | Partial | CLI discovers all 12 artifact schemas | Some commands are generic summaries, not artifact-specific views |
| Runtime adapter updates | Complete for offline/package surfaces | Setup smoke, OpenCode bootstrap smoke, lifecycle metadata validator all pass | Live model-bearing host smoke remains gated and was not run in this repair pass |
| Port tests | Complete for current v2 suite | `508 passed, 1 skipped` | The retired v1 helper tests are intentionally gone; no claim should cite 577 as current |
| Smoke tests across runtimes | Partial | Offline setup + OpenCode plugin smoke pass; live harness exists | No current evidence for live Claude/Codex/Copilot/OpenCode model-host behavior in this pass |

Phase 3 verdict: mostly complete. Remaining work is integration depth, not basic cutover correctness.

## ROADMAP.md Phase 4: Validation and Cutover

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Full test suite green | Complete | `508 passed, 1 skipped` | None |
| Semantic eval port | Complete | Semantic eval fixtures/tests use v2 YAML paths and pass | None |
| Token consumption benchmark | Complete but target missed | Decision 41 records v1 352,213 bytes vs v2 313,356 bytes, -11.0% | ROADMAP target was -40% |
| Version bump to 2.0.0 | Complete | Runtime package validators pass | None |

Phase 4 verdict: validation is green; token goal remains missed.

## Decisions 39-42

| Decision | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| D39 | One bundled `/agentera` skill with 12 capabilities | Complete | `skills/agentera/SKILL.md`, `skills/agentera/capabilities/` | None |
| D39 | Agent-facing data as structured YAML | Complete | `.agentera/vision.yaml`, `progress.yaml`, `decisions.yaml`, `plan.yaml`, `health.yaml`, `docs.yaml`, `session.yaml`; no active `.agentera/*.md` except this analysis | None |
| D39 | Human-facing root artifacts | Complete | `TODO.md`, `CHANGELOG.md`, `DESIGN.md` at root | None |
| D39 | Universal query seam | Partial | `scripts/agentera query` exists and lists all schemas | Query output is not yet the full replacement for all direct artifact reads |
| D40 | No backward compatibility in active state | Complete | v1 files moved under `.agentera/backup-v1/`; active mapping points to YAML | Migration backup is intentionally retained |
| D40 | Capability terminology | Complete | Directory and docs use `capabilities/` | None |
| D41 | Record token benchmark | Complete | Decision 41 is now populated and queryable | 11% reduction accepted as interim; remeasure after 2.0 completion, including profilera implementation/refactor |
| D42 | Five-layer routing model | Complete at specification level | `SKILL.md` routing model and trigger priorities validate | No executable dispatcher scores triggers; routing remains instruction-driven |

## Active Gaps

1. Token target needs final remeasurement after 2.0 completion.
   The measured v2 payload is 313,356 bytes vs 352,213 bytes for v1, a reduction of 11.0%. That result is acceptable as the current benchmark, but it should be remeasured after 2.0 is complete, including the profilera implementation/refactor.

2. Query CLI is a scaffold, not yet the authoritative read path for every workflow.
   `scripts/agentera query --list-artifacts` works and artifact discovery is broad, but several artifact types still return generic or empty summaries. This matters because v2's token story depends on agents using the query seam instead of reading raw YAML/prose wholesale.

3. Cross-capability producer/consumer validation is missing.
   Capability schemas declare artifact relationships, but no validator checks that a producer's output contract and a consumer's input expectation agree across all 12 capabilities.

4. Profilera corpus extraction is in scope and still missing.
   v2 no longer points to `extract_all.py`, and the smoke harness now reports the missing extractor as an explicit skip. That is honest, but profilera generation from raw runtime history must be restored or rebuilt as a bundled v2 implementation/refactor.

5. Live runtime verification blocks cutover claims.
   Offline package and OpenCode plugin smokes pass. The cost-bearing live host path (`scripts/smoke_live_hosts.py --live`) was not run, so current evidence does not prove model-host behavior across Codex/Copilot/Claude/OpenCode. Do not claim cutover-ready live host behavior until that evidence exists.

## Closed Questions

- Token target: 11% reduction is acceptable as the current benchmark result; remeasure after 2.0 completion, including profilera implementation/refactor.
- Profilera extraction: v2 should ship a bundled extractor or refactor, not rely only on externally supplied corpus files.
- Live smoke: live host verification is required before 2.0 cutover claims; no live run is approved by this gap analysis alone.

## Resolved Since Earlier Draft

- `hooks/common.py` now resolves v2 YAML paths and reads `.agentera/docs.yaml` mappings.
- `hooks/session_start.py` and `hooks/session_stop.py` now support v2 YAML artifacts; tests pass.
- `hooks/validate_artifact.py` now catches blank list entries and nested required fields, including the blank Decision 41 failure mode.
- Decision 41 now contains the benchmark values and is queryable.
- OpenCode artifact hard gate now denies validation-hook failures instead of swallowing non-zero exits.
- Stale active v1 artifacts were moved out of the live `.agentera/` root.
- README/AGENTS/runtime smoke references to missing v1 scripts were removed or made explicit as deferred.
- Capability prose, schemas, and the shared contract no longer point at missing bundled templates/references or teach v1 Markdown formats for the main agent-facing YAML artifacts.

## Recommended Next Actions

1. Build the producer/consumer graph validator.
   Add a validator that reads every capability `artifacts.yaml` plus skill-level artifact schemas and checks producer/consumer path/name consistency.

2. Restore/refactor bundled profilera corpus extraction.
   Implement the v2 extractor path for raw runtime history, wire it into profilera/usage surfaces, and remove the current smoke skip.

3. Deepen `scripts/agentera query`.
   Add artifact-specific summaries for plan, progress, decisions, health, docs, session, todo, design, objective, and experiments so agents can use the query seam instead of raw reads.

4. Remeasure token consumption after 2.0 completion.
   Keep the current 11% reduction as accepted interim evidence. Re-run the benchmark after profilera and query-depth work land.

5. Run one gated live-host smoke before cutover claims.
   Use `python3 scripts/smoke_live_hosts.py --live --yes` only after explicit approval for live model calls, but treat that evidence as required before claiming 2.0 cutover readiness.

## Overall Verdict

Agentera 2.0 is reliable enough to continue from this gap analysis. The basic v2 cutover is structurally sound: bundled skill shape, YAML artifact paths, schema validation, session hooks, runtime metadata, offline smoke checks, and the current test suite are green.

The remaining work should be treated as the next implementation queue, not as proof that the current gap analysis is untrustworthy.

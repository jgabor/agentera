# D59 JSON Output Closeout Measurements

Closeout evidence for **Agentera 3.0 Prime Control Plane and JSON Budget** (Plan Task 6).
Records final validation, before/after startup payload comparison, and measured bytes plus
GPT-5 token counts for every public JSON surface.

**Measurement date:** 2026-05-23  
**Repository:** agentera reference checkout (fixture policy per `json_output_surface_manifest.yaml`)

## Validation summary

| Check | Result |
|-------|--------|
| Focused pytest (`test_measure_json_output_surfaces`, `test_measure_capability_context_payloads`, `test_decision45_cli_contract`, `test_query_cli`) | **pass** (223 tests) |
| `agentera validate capability orkestrera` | **pass** |
| `agentera validate capability-contract --format json` | **pass** (2/2 targets) |
| `agentera validate artifact --artifact PLAN.md --file .agentera/plan.yaml` | **pass** |
| `agentera gate --format json` | **pass** |
| `git diff --check` | **pass** |
| `measure_json_output_surfaces.py --token-mode skip --enforce-budgets` | **pass** (67 surfaces, 0 violations) |
| `measure_json_output_surfaces.py --token-mode exact --enforce-budgets` | **pass** (tiktoken exact, 0 violations) |
| `measure_capability_context_payloads.py --enforce-budgets` | **pass** (12 capabilities, 0 violations) |

Commands run:

```bash
uv run --with pytest pytest tests/test_measure_json_output_surfaces.py \
  tests/test_measure_capability_context_payloads.py \
  tests/test_decision45_cli_contract.py tests/test_query_cli.py -q
uv run scripts/agentera validate capability orkestrera
uv run scripts/agentera validate capability-contract --format json
uv run scripts/agentera validate artifact --artifact PLAN.md --file .agentera/plan.yaml --format json
uv run scripts/agentera gate --format json
git diff --check
uv run scripts/measure_json_output_surfaces.py --json --token-mode skip --enforce-budgets
uv run scripts/measure_json_output_surfaces.py --json --token-mode exact --enforce-budgets
uv run scripts/measure_capability_context_payloads.py --json --enforce-budgets
```

## Startup shape: removed full profile vs slim `prime --context`

At 3.0 the sole supported capability startup selector is
`agentera prime --context <capability> --format json`. Removed surfaces:

- `agentera hej --format json --capability-context <capability>` (full dashboard envelope)
- `agentera --context-profile full`

### Aggregate comparison (12 capabilities)

| Metric | Full profile (archived May 2026 baselines) | Slim `prime --context` (exact run) | Delta |
|--------|-------------------------------------------:|-----------------------------------:|------:|
| Total bytes | 433,397 | 119,017 | **−314,380 (−72.5%)** |
| Total GPT-5 tokens | 96,060 | 25,447 | **−70,613 (−73.5%)** |

Archived full-profile baselines are from
`.agentera/archive/d59-json-output-budget-proposal.md` (pre-Task-4 exact measurement of
`hej-capability-context-full:*` rows). Current slim figures are the sum of
`prime-capability-context:*` rows from the final exact manifest run.

### Per-capability comparison

| Capability | Full B (archived) | Full tok | Slim B (exact) | Slim tok | Byte budget | Token budget | Status |
|------------|------------------:|---------:|---------------:|---------:|------------:|-------------:|--------|
| hej | 28,625 | 6,400 | 3,192 | 767 | 8,000 | 2,000 | pass |
| visionera | 28,463 | 6,360 | 6,273 | 1,450 | 8,000 | 2,000 | pass |
| resonera | 28,473 | 6,362 | 5,430 | 1,261 | 8,000 | 2,000 | pass |
| inspirera | 28,046 | 6,265 | 3,387 | 821 | 8,000 | 2,000 | pass |
| profilera | 28,129 | 6,285 | 3,437 | 831 | 8,000 | 2,000 | pass |
| visualisera | 28,332 | 6,330 | 5,391 | 1,262 | 8,000 | 2,000 | pass |
| planera | 32,560 | 7,209 | 10,586 | 2,280 | 12,000 | 3,000 | pass |
| orkestrera | 52,039 | 11,291 | 12,590 | 2,692 | 16,000 | 4,000 | pass |
| optimera | 39,905 | 8,800 | 15,576 | 3,119 | 20,000 | 5,000 | pass |
| dokumentera | 43,253 | 9,734 | 16,264 | 3,466 | 20,000 | 5,000 | pass |
| realisera | 41,831 | 9,346 | 16,599 | 3,460 | 20,000 | 5,000 | pass |
| inspektera | 53,741 | 11,678 | 20,292 | 4,038 | 28,000 | 7,000 | pass |

Dedicated harness totals (`measure_capability_context_payloads.py`, exact tokens):
**121,008 bytes**, **26,142 tokens** across 12 capabilities (slightly higher per-cap
than manifest `prime --context` rows due to invocation path; both enforce the same caps).

## Public JSON surface summary (exact measurement run)

Harness: `uv run scripts/measure_json_output_surfaces.py --json --token-mode exact --enforce-budgets`

- **67** manifest surfaces (55 measured OK, 12 `removed_3_0`, 0 generation errors)
- **0** budget violations (`budget_status: pass`)
- Token counter: `<output> | npx tiktoken-cli -m gpt-5`

| Surface ID | Bytes | GPT-5 tok | Byte budget | Token budget | Tier | Status |
|------------|------:|----------:|------------:|-------------:|------|--------|
| `decisions` | 116,268 | 25,549 | 140,000 | 30,000 | enforce | pass |
| `describe` | 100,670 | 23,529 | 115,000 | 26,000 | enforce | pass |
| `usage` | 77,486 | 25,149 | 95,000 | 30,000 | enforce | pass |
| `usage-stats-helper` | 77,486 | 25,149 | — | — | exempt | pass |
| `prime-dashboard` | 25,627 | 5,789 | 35,000 | 8,000 | enforce | pass |
| `hej-dashboard` | 25,609 | 5,789 | 35,000 | 8,000 | enforce | pass |
| `health` | 20,875 | 4,656 | 28,000 | 6,500 | enforce | pass |
| `prime-capability-context:inspektera` | 20,292 | 4,038 | 28,000 | 7,000 | slim_capability | pass |
| `upgrade-dry-run` | 20,105 | 4,904 | 28,000 | 6,500 | enforce | pass |
| `hej-fields-sparse` | 18,698 | 4,009 | 28,000 | 6,500 | enforce | pass |
| `docs` | 18,036 | 4,729 | 24,000 | 6,500 | enforce | pass |
| `query-list-artifacts` | 17,505 | 4,134 | 24,000 | 6,000 | enforce | pass |
| `prime-capability-context:realisera` | 16,599 | 3,460 | 20,000 | 5,000 | slim_capability | pass |
| `prime-capability-context:dokumentera` | 16,264 | 3,466 | 20,000 | 5,000 | slim_capability | pass |
| `prime-capability-context:optimera` | 15,576 | 3,119 | 20,000 | 5,000 | slim_capability | pass |
| `plan` | 15,193 | 3,240 | 20,000 | 4,500 | enforce | pass |
| `prime-capability-context:orkestrera` | 12,590 | 2,692 | 16,000 | 4,000 | slim_capability | pass |
| `prime-capability-context:planera` | 10,586 | 2,280 | 12,000 | 3,000 | slim_capability | pass |
| `progress` | 9,152 | 2,110 | 14,000 | 3,000 | enforce | pass |
| `prime-capability-context:visionera` | 6,273 | 1,450 | 8,000 | 2,000 | slim_capability | pass |
| `prime-capability-context:resonera` | 5,430 | 1,261 | 8,000 | 2,000 | slim_capability | pass |
| `prime-capability-context:visualisera` | 5,391 | 1,262 | 8,000 | 2,000 | slim_capability | pass |
| `compact-fix` | 5,303 | 1,494 | 8,000 | 2,000 | enforce | pass |
| `gate` | 5,271 | 1,445 | 8,000 | 2,000 | enforce | pass |
| `compact-check` | 5,250 | 1,447 | 8,000 | 2,000 | enforce | pass |
| `validate-descriptors` | 4,355 | 1,344 | 8,000 | 2,000 | enforce | pass |
| `prime-capability-context:profilera` | 3,437 | 831 | 8,000 | 2,000 | slim_capability | pass |
| `prime-capability-context:inspirera` | 3,387 | 821 | 8,000 | 2,000 | slim_capability | pass |
| `prime-capability-context:hej` | 3,192 | 767 | 8,000 | 2,000 | slim_capability | pass |
| `verify-smoke-live-hosts` | 2,150 | 561 | — | — | monitor | pass |
| `verify-eval-semantic` | 1,728 | 580 | — | — | monitor | pass |
| `query-vision` | 1,603 | 336 | 4,000 | 1,000 | enforce | pass |
| `verify-eval-skills` | 1,175 | 343 | — | — | monitor | pass |
| `stats-refresh-consent` | 1,148 | 318 | 8,000 | 2,000 | enforce | pass |
| `validate-capability-contract` | 1,148 | 291 | 4,000 | 1,000 | enforce | pass |
| `doctor` | 893 | 289 | 2,000 | 500 | enforce | pass |
| `verify-smoke-opencode-bootstrap` | 844 | 256 | — | — | monitor | pass |
| `stats-refresh-dry-run` | 800 | 225 | 4,000 | 1,000 | enforce | pass |
| `verify-smoke-installed-skills` | 714 | 216 | — | — | monitor | pass |
| `verify-smoke-setup-helpers` | 663 | 202 | — | — | monitor | pass |
| `lint` | 639 | 189 | 4,000 | 1,000 | enforce | pass |
| `validate-capability` | 479 | 140 | 4,000 | 1,000 | enforce | pass |
| `validate-artifact` | 383 | 121 | 4,000 | 1,000 | enforce | pass |
| `experiments` | 358 | 116 | 2,000 | 500 | enforce | pass |
| `objective` | 334 | 104 | 2,000 | 500 | enforce | pass |
| `validate-app-home-contract` | 327 | 91 | — | — | monitor | pass |
| `validate-lifecycle-adapters` | 309 | 90 | 4,000 | 1,000 | enforce | pass |
| `validate-cross-capability` | 308 | 88 | 4,000 | 1,000 | enforce | pass |
| `query-open-todos` | 307 | 103 | 2,000 | 500 | enforce | pass |
| `stats-missing-corpus` | 298 | 89 | 4,000 | 1,000 | enforce | pass |
| `todo` | 282 | 94 | 2,000 | 500 | enforce | pass |
| `stats-ready-corpus` | 171 | 67 | 4,000 | 1,000 | enforce | pass |
| `query-last-phase` | 23 | 9 | 2,000 | 500 | enforce | pass |
| `query-changelog` | 3 | 1 | 2,000 | 500 | enforce | pass |
| `query-design` | 3 | 1 | — | — | exempt | pass |
| `hej-capability-context-full:*` (×12) | — | — | — | — | removed_3_0 | removed |

## Reference baselines

| Source | Role |
|--------|------|
| `.agentera/archive/PLAN-2026-05-22-agentera-3-0-json-output-budget.yaml` | Prior slim-context plan; superseded by prime control-plane plan |
| `.agentera/archive/d59-json-output-budget-proposal.md` | Proposed caps and archived full-profile byte/token baselines |
| `.agentera/archive/d58-json-output-surface-inventory.md` | Surface inventory and classification |
| Final exact run (this document) | Authoritative closeout measurements |

## Deferred (explicit approval required)

Per plan constraints (AC3), the following were **not** performed during Task 6 closeout:

- Version bumps, changelog promotion, release tagging
- Package refresh / installed app file updates
- Remote push or publication
- Protected vision/objective/profile state edits

## Handoff

Plan implementation and measurement gates are complete. For session closeout and
coordination of any approved release work, route through **orkestrera** (orchestrator
handles execution-cycle closeout per capability routing).

Related artifacts:

- Active plan: `.agentera/plan.yaml` (Agentera 3.0 Prime Control Plane and JSON Budget)
- Archived prior plan: `.agentera/archive/PLAN-2026-05-22-agentera-3-0-json-output-budget.yaml`
- Budget proposal (wired): `.agentera/archive/d59-json-output-budget-proposal.md`

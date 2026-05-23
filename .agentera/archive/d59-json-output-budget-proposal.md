# D59 JSON Output Budget Proposal

Proposal for Plan Task 3 (**Define and enforce JSON budgets**). This document
classifies every measured public JSON surface from
`.agentera/archive/d58-json-output-surface-inventory.md`, records stable-fixture baselines
from `scripts/measure_json_output_surfaces.py`, and proposes byte and GPT-5 token
caps or documented exemptions.

**Status:** wired into `scripts/json_output_surface_manifest.yaml` and
`scripts/measure_json_output_surfaces.py --enforce-budgets`.

## Governing decisions

- **Decision 58:** single-name protocol at 3.0; budgets apply after rewrites shrink
  duplicate identifiers, not instead of completeness contracts.
- **Decision 59:** every public `--format json` / `--json` surface is inventoried,
  measured, and gated; slim `capability_context` is the only supported startup
  shape; full-profile compatibility is removed, not re-budgeted.

## Measurement source

Baselines captured on the agentera repository with:

```bash
uv run scripts/measure_json_output_surfaces.py --json --token-mode exact
```

Fixture policy matches `scripts/json_output_surface_manifest.yaml` (repo root,
isolated compaction projects, temp `AGENTERA_HOME`, temp profile dirs). Baselines
reflect **this reference repo**, not unbounded user artifact growth.

| Metric | Value |
|--------|------:|
| Surfaces measured | 66 |
| Primary | 59 |
| Diagnostic | 7 |
| Generation errors | 0 |
| Primary total (bytes) | ~1,088,034 |
| Primary total (GPT-5 tokens) | ~260,510 |

## Budget-setting methodology

### 1. Role before number

Assign each surface a **protocol role**. Caps follow role, not a single global limit.

| Role | Surfaces | Budget intent |
|------|----------|---------------|
| **startup_capsule** | slim `capability_context` (×12) | Tightest enforced caps; highest session cost if bloated |
| **orientation_dashboard** | `hej --format json`, sparse fields | Interim caps until `prime` orientation mode (Task 4) |
| **routine_state** | `plan`, `progress`, `health`, … | Moderate; fallback reads after startup |
| **introspection_dump** | `describe`, `decisions`, `usage` | High caps; not startup-sized; may shrink after D58 rewrite |
| **advanced_query** | `query …`, `--list-artifacts` | Moderate; advanced inspection only |
| **operational** | `compact`, `gate`, `lint` | Small/moderate; hook and pre-write tooling |
| **migration** | `upgrade --json`, `doctor --json` | Bounded migration/repair payloads |
| **validation_wrapper** | `validate … --format json` | Small wrapper envelopes around text engines |
| **analytics** | `stats`, `stats refresh` | Small except corpus-ready paths |
| **diagnostic** | `verify …`, `validate app-home-contract` | Monitor only; not agent startup |
| **helper_seam** | direct helper behind canonical CLI | Exempt when canonical namespace owns the contract |
| **removed_3_0** | full-profile capability context (×12) | **Removed** in Task 4 — no post-3.0 budget |

### 2. Baseline + headroom

Proposed caps use measured bytes/tokens plus tiered headroom:

| Baseline size | Byte headroom | Token headroom | Rationale |
|---------------|---------------|----------------|-----------|
| &lt; 1 KB | +500 B min or ×1.4 | +200 tok min or ×1.4 | Avoid noise on tiny payloads |
| 1–10 KB | ×1.35 | ×1.35 | Routine state / operational growth |
| 10–50 KB | ×1.25 | ×1.25 | Dashboard and capability context |
| &gt; 50 KB | ×1.15–1.20 | ×1.20 | Introspection dumps; slow growth only |

Headroom covers **one** new caveat block, schema field, or compact summary — not
re-embedding full dashboard or duplicate artifact bodies.

### 3. Completeness is separate

A surface must pass **`source_contract.complete_for_*`** (and capability schema
tests) **before** a budget is approved. Budget tests catch accidental bloat;
contract tests catch behavioral regression.

### 4. Enforcement tiers

| Tier | Meaning | CI default |
|------|---------|------------|
| **enforce** | Byte cap in all runs; token cap in manual/exact benchmark | `--token-mode skip` bytes; release exact |
| **monitor** | Soft ceiling; report-only until a violation pattern appears | measured, not failing |
| **exempt** | Documented exemption tied to inventory class | no fail |
| **removed_3_0** | Surface must not exist after Task 4 | removal tests, not size tests |

## Summary by enforcement tier

| Tier | Count | Notes |
|------|------:|-------|
| enforce (existing slim) | 12 | Already in `measure_capability_context_payloads.py` |
| enforce (new proposal) | 34 | Routine, orientation interim, query, operational, migration, validation |
| monitor (diagnostic) | 7 | Verify/validate CI facades |
| exempt | 2 | `query design`, `usage_stats.py` helper |
| removed_3_0 | 12 | Full-profile capability context — delete, do not cap |

---

## Proposal table — startup capsules (enforce)

Slim `capability_context` is the 3.0 startup shape (`prime --context` in Task 4).
**Existing caps are retained** — they were set from May 2026 baselines with headroom
and are already enforced by `measure_capability_context_payloads.py`.

| Surface ID | Command / selector | Capability | Baseline B | Baseline tok | Proposed B | Proposed tok | Rationale |
|------------|-------------------|------------|----------:|-------------:|-----------:|-------------:|-----------|
| prime-capability-context:hej | `prime --context hej --format json` | hej | 2,194 | 548 | **8,000** | **2,000** | Existing generic cap; smallest capsule |
| prime-capability-context:visionera | slim context | visionera | 5,263 | 1,229 | **8,000** | **2,000** | Existing generic cap |
| prime-capability-context:resonera | slim context | resonera | 4,422 | 1,040 | **8,000** | **2,000** | Existing generic cap |
| prime-capability-context:inspirera | slim context | inspirera | 2,377 | 600 | **8,000** | **2,000** | Existing generic cap |
| prime-capability-context:profilera | slim context | profilera | 2,427 | 610 | **8,000** | **2,000** | Existing generic cap |
| prime-capability-context:visualisera | slim context | visualisera | 4,377 | 1,039 | **8,000** | **2,000** | Existing generic cap |
| prime-capability-context:planera | slim context | planera | 9,530 | 2,044 | **12,000** | **3,000** | Planning startup contract |
| prime-capability-context:orkestrera | slim context | orkestrera | 13,813 | 2,931 | **16,000** | **4,000** | Orchestration queue + handoff |
| prime-capability-context:optimera | slim context | optimera | 14,658 | 2,918 | **20,000** | **5,000** | Objective/experiment summaries |
| prime-capability-context:dokumentera | slim context | dokumentera | 15,139 | 3,227 | **20,000** | **5,000** | Closeout/docs context |
| prime-capability-context:realisera | slim context | realisera | 16,647 | 3,465 | **20,000** | **5,000** | Execution context |
| prime-capability-context:inspektera | slim context | inspektera | 19,512 | 3,874 | **28,000** | **7,000** | Largest legitimate startup capsule |

**Implemented (Task 4):** `agentera prime --context <capability> --format json` is the sole supported startup selector; manifest surface ids use `prime-capability-context:*`. Historical `hej-capability-context-*` ids remain in measurement reports as `removed_3_0` only.

---

## Proposal table — removed at 3.0 (no budget)

Decision 59 rejects `--context-profile full`. These surfaces are **not** candidates
for higher caps — they are removed in Task 4.

| Surface ID | Baseline B | Baseline tok | Enforcement |
|------------|----------:|-------------:|-------------|
| hej-capability-context-full:hej | 28,625 | 6,400 | **removed_3_0** |
| hej-capability-context-full:visionera | 28,463 | 6,360 | **removed_3_0** |
| hej-capability-context-full:resonera | 28,473 | 6,362 | **removed_3_0** |
| hej-capability-context-full:inspirera | 28,046 | 6,265 | **removed_3_0** |
| hej-capability-context-full:profilera | 28,129 | 6,285 | **removed_3_0** |
| hej-capability-context-full:visualisera | 28,332 | 6,330 | **removed_3_0** |
| hej-capability-context-full:planera | 32,560 | 7,209 | **removed_3_0** |
| hej-capability-context-full:optimera | 39,905 | 8,800 | **removed_3_0** |
| hej-capability-context-full:realisera | 41,831 | 9,346 | **removed_3_0** |
| hej-capability-context-full:dokumentera | 43,253 | 9,734 | **removed_3_0** |
| hej-capability-context-full:orkestrera | 52,039 | 11,291 | **removed_3_0** |
| hej-capability-context-full:inspektera | 53,741 | 11,678 | **removed_3_0** |

Token baselines are approximate from the exact measurement run (full-profile rows).

---

## Proposal table — orientation (enforce, interim)

Until Task 4 moves dashboard JSON to `prime`, hold **`hej`** orientation surfaces
to interim caps. Post-Task-4, re-baseline under `prime` and tighten if the rewrite
drops duplicate envelope fields.

| Surface ID | Command / selector | Baseline B | Baseline tok | Proposed B | Proposed tok | Rationale |
|------------|-------------------|----------:|-------------:|-----------:|-------------:|-----------|
| hej-dashboard | `agentera hej --format json` | 26,348 | 5,933 | **35,000** | **8,000** | Interim; duplicate full envelope until prime migration |
| hej-fields-sparse | `agentera hej --format json --fields plan,progress,docs` | 19,455 | 4,159 | **28,000** | **6,500** | Sparse orientation; should stay below full dashboard |

---

## Proposal table — routine state (enforce)

Fallback reads after startup. Caps assume `complete_for_*` contracts stay true.

| Surface ID | Command / selector | Baseline B | Baseline tok | Proposed B | Proposed tok | Rationale |
|------------|-------------------|----------:|-------------:|-----------:|-------------:|-----------|
| plan | `agentera plan --format json` | 15,189 | 3,240 | **20,000** | **4,500** | Active plan summary + source_contract |
| progress | `agentera progress --format json` | 9,614 | 2,194 | **14,000** | **3,000** | Recent cycle summary |
| health | `agentera health --format json` | 20,875 | 4,656 | **28,000** | **6,500** | Latest audit grades |
| docs | `agentera docs --format json` | 18,036 | 4,729 | **24,000** | **6,500** | Docs contract + mapping |
| todo | `agentera todo --format json` | 282 | 94 | **2,000** | **500** | Small summary |
| objective | `agentera objective --format json` | 334 | 104 | **2,000** | **500** | Small summary |
| experiments | `agentera experiments --format json` | 358 | 116 | **2,000** | **500** | Small summary |

---

## Proposal table — introspection dumps (enforce, high cap)

Large by role. Agents should prefer slim startup + targeted commands. Caps prevent
unbounded growth; **D58 rewrites** may lower baselines before caps tighten.

| Surface ID | Command / selector | Baseline B | Baseline tok | Proposed B | Proposed tok | Rationale |
|------------|-------------------|----------:|-------------:|-----------:|-------------:|-----------|
| decisions | `agentera decisions --format json` | 116,268 | 25,549 | **140,000** | **30,000** | Fixture-bound full log; not startup. Revisit after compaction/sparse modes |
| describe | `agentera describe --format json` | 96,243 | 22,468 | **115,000** | **26,000** | Runtime introspection dump; shrinks when D58 drops legacy labels |
| usage | `agentera usage --format json` | 77,486 | 25,149 | **95,000** | **30,000** | Section 22 analytics; corpus-dependent upper bound |

**Risk note:** if decisions or usage grow with project history, prefer **`--fields`**
sparse JSON or inventory-backed exemptions over repeatedly raising caps.

---

## Proposal table — advanced query (enforce)

| Surface ID | Command / selector | Baseline B | Baseline tok | Proposed B | Proposed tok | Rationale |
|------------|-------------------|----------:|-------------:|-----------:|-------------:|-----------|
| query-list-artifacts | `agentera query --list-artifacts --format json` | 17,505 | 4,134 | **24,000** | **6,000** | Artifact registry listing |
| query-vision | `agentera query vision --format json` | 1,603 | ~400 | **4,000** | **1,000** | Single-artifact generic query |
| query-changelog | `agentera query changelog --format json` | 3 | ~1 | **2,000** | **500** | Empty/minimal fixture baseline |
| query-last-phase | `agentera query last-phase --format json` | 23 | ~6 | **2,000** | **500** | Minimal object |
| query-open-todos | `agentera query open-todos --format json` | 307 | ~80 | **2,000** | **500** | Delegates to todo JSON |
| query-design | `agentera query design --format json` | 3 | ~1 | **exempt** | **exempt** | Inventory **defer**: parser accepts JSON; handler gap — fix or reject flag in 3.0 |

---

## Proposal table — operational (enforce)

| Surface ID | Command / selector | Baseline B | Baseline tok | Proposed B | Proposed tok | Rationale |
|------------|-------------------|----------:|-------------:|-----------:|-------------:|-----------|
| compact-check | `agentera compact --mode check --format json` | 5,250 | 1,467 | **8,000** | **2,000** | Compaction budget check |
| compact-fix | `agentera compact --mode fix --format json` | 5,303 | ~1,480 | **8,000** | **2,000** | Same payload shape as check |
| gate | `agentera gate --format json` | 5,271 | 1,455 | **8,000** | **2,000** | Reuses compaction payload |
| lint | `agentera lint --format json` | 639 | 189 | **4,000** | **1,000** | Pre-write self-audit |

---

## Proposal table — migration (enforce)

| Surface ID | Command / selector | Baseline B | Baseline tok | Proposed B | Proposed tok | Rationale |
|------------|-------------------|----------:|-------------:|-----------:|-------------:|-----------|
| upgrade-dry-run | `agentera upgrade --dry-run --json` | 20,105 | 4,904 | **28,000** | **6,500** | Migration plan JSON; phase names preserved per inventory |
| doctor | `agentera doctor --json` | 893 | 288 | **2,000** | **500** | Repair status summary |

---

## Proposal table — validation wrappers (enforce)

| Surface ID | Command / selector | Baseline B | Baseline tok | Proposed B | Proposed tok | Rationale |
|------------|-------------------|----------:|-------------:|-----------:|-------------:|-----------|
| validate-capability | `agentera validate capability hej --format json` | 479 | ~120 | **4,000** | **1,000** | Wrapper envelope |
| validate-artifact | `agentera validate artifact … --format json` | 383 | ~95 | **4,000** | **1,000** | Wrapper envelope |
| validate-descriptors | `agentera validate descriptors --format json` | 4,355 | 1,344 | **8,000** | **2,000** | Larger engine capture |
| validate-cross-capability | `agentera validate cross-capability --format json` | 308 | ~80 | **4,000** | **1,000** | Wrapper envelope |
| validate-lifecycle-adapters | `agentera validate lifecycle-adapters --format json` | 309 | ~80 | **4,000** | **1,000** | Wrapper envelope |
| validate-capability-contract | `agentera validate capability-contract --format json` | 1,148 | ~350 | **4,000** | **1,000** | Combined contract JSON |
| validate-app-home-contract | `agentera validate app-home-contract --format json` | 327 | ~90 | **monitor** | **monitor** | Diagnostic guardrail; see diagnostic table |

---

## Proposal table — analytics (enforce)

| Surface ID | Command / selector | Baseline B | Baseline tok | Proposed B | Proposed tok | Rationale |
|------------|-------------------|----------:|-------------:|-----------:|-------------:|-----------|
| stats-ready-corpus | `agentera stats --format json` (corpus ready) | 171 | ~45 | **4,000** | **1,000** | Delegates to usage_stats JSON |
| stats-missing-corpus | `agentera stats --format json` (missing) | 298 | ~80 | **4,000** | **1,000** | Native wrapper with reason/next |
| stats-refresh-dry-run | `agentera stats refresh --dry-run --format json` | 800 | ~210 | **4,000** | **1,000** | Preview only |
| stats-refresh-consent | `agentera stats refresh --consent local-history --format json` | 1,148 | ~300 | **8,000** | **2,000** | Includes bounded engine lines |
| usage-stats-helper | `scripts/usage_stats.py --json` | 77,486 | 25,149 | **exempt** | **exempt** | Inventory **preserve**: helper seam; `agentera usage` owns public contract |

---

## Proposal table — diagnostic (monitor)

Measured for drift reporting; **not** held to agent startup budgets. Optional soft
byte ceiling (×2 baseline) can log warnings without failing CI.

| Surface ID | Command / selector | Baseline B | Monitor ceiling B | Rationale |
|------------|-------------------|----------:|------------------:|-----------|
| verify-smoke-installed-skills | `agentera verify smoke installed-skills --format json` | 714 | 2,000 | CI verify facade |
| verify-smoke-setup-helpers | `agentera verify smoke setup-helpers --format json` | 663 | 2,000 | CI verify facade |
| verify-smoke-opencode-bootstrap | `agentera verify smoke opencode-bootstrap --format json` | 844 | 2,000 | CI verify facade |
| verify-smoke-live-hosts | `agentera verify smoke live-hosts --format json` | 2,150 | 5,000 | CI verify facade |
| verify-eval-skills | `agentera verify eval skills --format json` | 1,175 | 3,000 | Eval gate JSON |
| verify-eval-semantic | `agentera verify eval semantic --format json` | 1,728 | 4,000 | Eval gate JSON |
| validate-app-home-contract | `agentera validate app-home-contract --format json` | 327 | 1,000 | Terminology guardrail |

---

## Planned surfaces (Task 4 — budget after implementation)

Not measured for enforcement until JSON exists. Intended inheritance:

| Planned surface | Intended budget source |
|-----------------|------------------------|
| `agentera prime` (static priming) | text-only today; JSON only if structured priming metadata added |
| `agentera prime` dashboard/orientation mode | re-baseline; target **≤ hej-dashboard interim cap** after duplicate envelope removal |
| `agentera prime --context <capability> --format json` | **same caps as slim startup table** |
| Direct capability-name commands | defer until command map lands; likely subset of routine state or slim context |

---

## Budget change review checklist

When raising or lowering a cap:

1. Re-run exact measurement on the stable fixture.
2. Confirm **`complete_for_*`** and capability contract tests still pass.
3. Cite inventory row and role (startup vs dump vs diagnostic).
4. State whether growth is justified (new caveat, schema field) or should be rejected (duplicate envelope).
5. Update this document and `scripts/json_output_surface_manifest.yaml` together.
6. Never raise a cap to preserve **removed_3_0** or **exempt** surfaces.

## Implementation mapping (Task 3)

| Artifact | Action |
|----------|--------|
| `scripts/json_output_surface_manifest.yaml` | Add `byte_budget`, `token_budget`, `enforcement_tier` per row |
| `scripts/measure_json_output_surfaces.py` | `--enforce-budgets`; fail with command, counts, budget |
| `tests/test_measure_json_output_surfaces.py` | Bytes in CI; token skip; exact benchmark documented |
| `.agentera/archive/d58-json-output-surface-inventory.md` | Cross-link exemptions to this proposal |

## Verification commands

```bash
# CI-safe bytes + budget check (after Task 3 implementation)
uv run scripts/measure_json_output_surfaces.py --json --token-mode skip --enforce-budgets

# Release/manual GPT-5 token benchmark
uv run scripts/measure_json_output_surfaces.py --json --token-mode exact --enforce-budgets

# Slim capability caps (existing)
uv run scripts/measure_capability_context_payloads.py --json --enforce-budgets
```

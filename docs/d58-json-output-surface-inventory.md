# D58 JSON Output Surface Inventory

This inventory classifies every supported `--format json` and `--json` CLI surface
in `scripts/agentera` and related public helper scripts for Decision 58 and Decision
59 follow-up work. It follows the D47 classification pattern in
`docs/d47-app-home-vocabulary-inventory.md`: classification only; no 3.0 implementation
in this task.

## Governing decisions

- **Decision 58** (`.agentera/decisions.yaml` #58): Agentera 3.0 must eliminate duplicate
  protocol identities. Legacy Markdown artifact labels, compatibility aliases, and
  parallel display/storage names must be removed or migrated — not retained as supported
  runtime alternatives.
- **Decision 59** (`.agentera/decisions.yaml` #59): Agentera 3.0 applies the same
  clean-break principle to command and JSON output. Full and slim capability-startup
  shapes cannot both survive; `hej --capability-context` becomes `prime --context`;
  top-level commands map to capabilities with `prime` as the sole non-capability control
  plane; every public JSON surface must be inventoried, measured, and budgeted.

Byte and GPT-5 token caps (or documented exemptions) live in
`docs/d59-json-output-budget-proposal.md` and are enforced via
`scripts/json_output_surface_manifest.yaml` plus
`scripts/measure_json_output_surfaces.py --enforce-budgets`. Exempt rows cite
inventory **defer** / **preserve** classifications here rather than hiding
exemptions in test code.

## Search coverage

- **Parser inspection**: `scripts/agentera` `build_parser()` and per-command handlers
  (`cmd_*`, `_query_*`, `_emit_structured`, `_emit_state_structured`).
- **Delegated emitters**: `scripts/agentera_upgrade.py` (`cmd_upgrade`, `cmd_doctor`),
  `scripts/usage_stats.py` (via `agentera usage` / `agentera stats`).
- **Grep terms**: `--format`, `choices=["text", "json"`, `--json`, `format=json`,
  `json.dumps`, `_emit_structured`.
- **Helper scripts**: public or backward-compatible helpers that shape machine-readable
  CLI output when invoked directly or through `agentera`.
- **Out of scope for this inventory**: `--format yaml` surfaces, private script stdout
  unless it is the engine behind a documented public JSON command, and internal hook JSON
  unless exposed through the CLI.

## Classification legend

| Classification | Meaning for 3.0 rewrite |
|---|---|
| **change** | Live public JSON surface to rewrite under Decision 58/59 |
| **preserve** | Keep for compatibility, migration, or bounded diagnostic use |
| **defer** | Revisit after primary rewrite lands; not blocking 3.0 JSON budget work |
| **diagnostic** | Maintainer/CI verification output; not agent startup context |
| **historical** | Records prior benchmark or migration evidence |
| **private/excluded** | Not part of the 3.0 public-output rewrite |
| **planned/future** | Named in Decision 59 but absent or incomplete in v2 |

## Classification table

| Command / Surface | Selector | Source file | Owner | Classification | Rationale | Planned Action |
|---|---|---|---|---|---|---|
| `agentera prime` | _(none — text priming)_ | `scripts/agentera` (`cmd_prime`) | cli | preserve | Bare `prime` prints static `PRIME_BLOB` session priming; no JSON flag. | Keep text priming; add structured JSON only if a future budget requires it. |
| `agentera prime` | `--dashboard` / `--orientation` + `--format json` | `scripts/agentera` (`cmd_prime`, `_collect_orientation_state`) | cli | change | Decision 59 orientation JSON; replaces long-term `hej --format json` full dashboard envelope. | Budget orientation payload; retire `hej --format json` as dashboard owner. |
| `agentera prime --context <capability>` | `--format json` | `scripts/agentera` (`cmd_prime`, `_slim_capability_context`) | cli | change | Sole supported 3.0 capability startup JSON shape (`command`, `status`, `capability_context`). | Budget per capability; keep slim-only (no profile flag). |
| Direct capability-name commands | _(text routing guidance)_ | `scripts/agentera` (`cmd_capability_route`) | cli | preserve | Top-level capability names (`planera`, `realisera`, …) emit routing guidance to `prime --context` and skill invocation; no capability-local JSON. | Preserve guidance-only surface unless 3.0 map adds JSON beyond `prime --context`. |
| `agentera describe` | `--format json` (default) | `scripts/agentera` (`cmd_describe`, `_build_describe_payload`) | cli | change | Public runtime introspection for commands, schemas, artifact locations, and Decision 45 contract sections. Carries legacy artifact labels and compatibility metadata Decision 58 removes. | Rewrite payload to single-name protocol IDs; budget and test. |
| `agentera hej` | `--format json` | `scripts/agentera` (`cmd_hej`) | cli / hej | change | Full dashboard JSON envelope (`app_home`, `bundle`, nested state summaries, capability contexts). Decision 59 rejects keeping this alongside slim startup shape. | Move orientation JSON to `prime` dashboard mode; delete full-profile capability startup path. |
| `agentera hej` | `--format json --capability-context <capability> --context-profile full` | `scripts/agentera` (`cmd_hej`) | cli / hej | historical | Removed in 3.0 (Task 4). Full-profile capability startup duplicated dashboard plus capability contract. | **Removed** — migrate to `prime --context`. |
| `agentera hej` | `--format json --capability-context <capability> --context-profile slim` | `scripts/agentera` | cli / hej | historical | Removed in 3.0 (Task 4). Slim shape now lives only under `prime --context`. | **Removed** — use `agentera prime --context <capability> --format json`. |
| `agentera hej` / routine state | `--format json --fields FIELD[,FIELD...]` | `scripts/agentera` (`_select_structured_fields`, `_emit_state_structured`) | cli | change | Field-sparse JSON variant for routine state commands and `hej`. Decision 59 requires measured budgets on all public JSON surfaces. | Retain sparse selection only if budgeted; align field names with Decision 58 canonical IDs. |
| `agentera plan` | `--format json` | `scripts/agentera` (`_query_plan`, `cmd_state`) | cli | change | Agent-ready plan summary with `source_contract`, legacy `PLAN.md` metadata. High-traffic startup fallback surface. | Rewrite artifact IDs/paths; enforce byte/token budget. |
| `agentera progress` | `--format json` | `scripts/agentera` (`_query_progress`) | cli | change | Recent cycle summary JSON; referenced by capability startup contracts. | Same as plan. |
| `agentera health` | `--format json` | `scripts/agentera` (`_query_health`) | cli | change | Latest health audit JSON. | Same as plan. |
| `agentera todo` | `--format json` | `scripts/agentera` (`_query_todo`) | cli | change | TODO summary JSON including markdown-fallback parsing path. | Same as plan. |
| `agentera decisions` | `--format json` | `scripts/agentera` (`_query_decisions`) | cli | change | Decision log JSON with `source_contract`; explicit acceptance-criteria surface. | Same as plan; migrate `DECISIONS.md` labels to canonical artifact IDs. |
| `agentera docs` | `--format json` | `scripts/agentera` (`_query_docs`) | cli | change | Documentation contract summary JSON. | Same as plan. |
| `agentera objective` | `--format json` | `scripts/agentera` (`_query_objective`) | cli | change | Optimera objective summary JSON. | Same as plan. |
| `agentera experiments` | `--format json` | `scripts/agentera` (`_query_experiments`) | cli | change | Optimera experiments summary JSON. | Same as plan. |
| `agentera query` | `--list-artifacts --format json` | `scripts/agentera` (`cmd_query`) | cli | change | Structured artifact registry listing (`schemaVersion: agentera.query.list_artifacts.v2`). | Budget; align artifact names with Decision 58 IDs. |
| `agentera query last-phase` | `--format json` | `scripts/agentera` (`_query_last_phase`) | cli | change | Minimal JSON object `{"phase": ...}` or `null`. | Budget; consider folding into routine `progress` JSON. |
| `agentera query open-todos` | `--format json` | `scripts/agentera` (`_query_open_todos` → `_query_todo`) | cli | change | Open-TODO variant of structured `todo` JSON. | Budget; deduplicate with `agentera todo --format json` where possible. |
| `agentera query design` | `--format json` | `scripts/agentera` (`_query_design`) | cli | defer | Handler ignores `--format json` and always prints text/markers. Parser accepts JSON but emitter does not. | Either implement structured JSON or reject `json` at parse time in 3.0. |
| `agentera query <artifact>` | `--format json` for schema-backed artifacts without routine handlers (`vision`, `changelog`, custom schemas) | `scripts/agentera` (`_query_generic`) | cli | change | Emits raw filtered entry arrays (unwrapped), unlike routine state envelope. | Normalize shape or document as advanced-only; budget each schema query. |
| `agentera query <routine-artifact>` | `--format json` where artifact has a top-level command (`plan`, `progress`, …) | `scripts/agentera` (`cmd_query`) | cli | preserve | Query path returns error directing callers to `agentera <artifact> --format json`. Not a separate JSON emitter. | Preserve redirect behavior; no duplicate JSON shape. |
| `agentera compact` | `--mode check --format json` | `scripts/agentera` (`cmd_compact`, `_compaction_payload`) | cli / hooks | change | Compaction budget check JSON (`command`, `status`, `operations`). Explicit acceptance-criteria surface. | Budget; align artifact labels with Decision 58. |
| `agentera compact` | `--mode fix --format json` | `scripts/agentera` (`cmd_compact`) | cli / hooks | change | Same payload shape after fix mode. | Same as check. |
| `agentera gate` | `--format json` | `scripts/agentera` (`cmd_gate`) | cli | change | Check-only gate JSON reusing compaction payload with `gate=compaction`. | Budget. |
| `agentera lint` | `--format json` | `scripts/agentera` (`cmd_lint`, `_lint_payload`) | cli | change | Pre-write prose self-audit JSON. | Budget; align artifact selector names. |
| `agentera validate capability <name\|path>` | `--format json` | `scripts/agentera` (`cmd_validate_capability`) | cli / schemas | change | Capability validation wrapper JSON (`target_family`, `violations`, engine capture). | Budget; ensure capability IDs match Decision 58 names. |
| `agentera validate artifact` | `--format json` | `scripts/agentera` (`cmd_validate_artifact`) | cli / schemas | change | Artifact validation JSON; `--artifact` choices still use Markdown-style labels (`PLAN.md`, …). | Migrate selectors to canonical artifact IDs; budget. |
| `agentera validate descriptors` | `--format json` | `scripts/agentera` (`cmd_validate_descriptors`) | cli / runtime | change | Runtime descriptor validation JSON. | Budget. |
| `agentera validate cross-capability` | `--format json` | `scripts/agentera` (`cmd_validate_delegated_script`) | cli / schemas | change | Wrapper JSON around `scripts/validate_cross_capability.py` stdout/stderr. | Budget. |
| `agentera validate lifecycle-adapters` | `--format json` | `scripts/agentera` (`cmd_validate_delegated_script`) | cli / runtime | change | Wrapper JSON around `scripts/validate_lifecycle_adapters.py`. | Budget. |
| `agentera validate app-home-contract` | `--format json` | `scripts/agentera` (`cmd_validate_delegated_script`) | cli | diagnostic | Terminology guardrail validator; exercises live CLI JSON (`hej`, `doctor`, `upgrade`) as inputs, not primary agent context. | Preserve as diagnostic gate; exclude from startup budgets unless promoted. |
| `agentera validate capability-contract` | `--format json` | `scripts/agentera` (`cmd_validate_capability_contract`) | cli / schemas | change | Combined capability schema + protocol contract JSON. | Budget. |
| `agentera upgrade` | `--json` | `scripts/agentera_upgrade.py` (`cmd_upgrade`, `_public_plan`) | cli / install | change | Migration plan JSON; explicit acceptance-criteria surface. Uses `--json`, not `--format json`. | Budget; align phase/status field names with Decision 58; keep migration semantics. |
| `agentera doctor` | `--json` | `scripts/agentera_upgrade.py` (`cmd_doctor`, `public_doctor_status`) | cli / install | change | App/runtime repair status JSON. Uses `--json`, not `--format json`. Referenced incorrectly as `--format json` in `PRIME_BLOB` prose. | Unify flag style or document `--json` as canonical; budget; align `bundle` compatibility keys with Decision 58 policy. |
| `agentera verify smoke installed-skills` | `--format json` | `scripts/agentera` (`cmd_verify` → `scripts/smoke_installed_skills.py`) | cli / eval | diagnostic | Verify facade JSON (`verify` envelope + bounded engine diagnostics). Underlying smoke script has no public `--json`. | Preserve for CI; exclude from agent startup budgets. |
| `agentera verify smoke live-hosts` | `--format json` | `scripts/agentera` (`cmd_verify` → `scripts/smoke_live_hosts.py`) | cli / eval | diagnostic | Same verify envelope; live path requires `--live --yes`. | Preserve for CI. |
| `agentera verify smoke setup-helpers` | `--format json` | `scripts/agentera` (`cmd_verify` → `scripts/smoke_setup_helpers.py`) | cli / eval | diagnostic | Offline setup-helper smoke via verify facade. | Preserve for CI. |
| `agentera verify smoke opencode-bootstrap` | `--format json` | `scripts/agentera` (`cmd_verify` → `scripts/smoke_opencode_bootstrap.mjs`) | cli / eval | diagnostic | OpenCode bootstrap smoke via verify facade. | Preserve for CI. |
| `agentera verify eval skills` | `--format json` | `scripts/agentera` (`cmd_verify` → eval runner) | cli / eval | diagnostic | Eval gate JSON for skill behavioral verification. | Preserve for CI/release gates. |
| `agentera verify eval semantic <fixture…>` | `--format json` | `scripts/agentera` (`cmd_verify`) | cli / eval | diagnostic | Semantic eval fixture gate JSON. | Preserve for CI. |
| `agentera usage` | `--format json` | `scripts/agentera` (`cmd_usage` → `scripts/usage_stats.py --json`) | cli | change | Delegates to helper JSON document for Section 22 usage analytics. | Budget; keep `agentera usage` as canonical entry point per AGENTS.md helper classification. |
| `agentera stats` | `--format json` (corpus ready) | `scripts/agentera` (`cmd_stats` → `usage_stats.py --json`) | cli | change | Same helper JSON when corpus exists. | Budget. |
| `agentera stats` | `--format json` (corpus missing/stale) | `scripts/agentera` (`cmd_stats`) | cli | change | Native wrapper JSON with `status`, `reason`, `next`, `privacy` when corpus unavailable. | Budget. |
| `agentera stats refresh` | `--dry-run --format json` | `scripts/agentera` (`cmd_stats`, `_stats_refresh_payload`) | cli | change | Refresh preview JSON without reading local history. | Budget. |
| `agentera stats refresh` | `--consent local-history --format json` | `scripts/agentera` (`cmd_stats`) | cli | change | Refresh execution JSON including engine stdout/stderr lines. | Budget. |
| `scripts/usage_stats.py` | `--json` | `scripts/usage_stats.py` | cli (helper seam) | preserve | Backward-compatible maintainer/user helper behind `agentera usage` and `agentera stats`. Direct invocation remains supported. | Preserve direct execution; document `agentera` namespace as canonical per AGENTS.md. |
| `scripts/setup_doctor.py` | `--json` | `scripts/setup_doctor.py` | install (helper) | private/excluded | Setup/lifecycle doctor for runtime wiring; not exposed through `scripts/agentera` namespace. | Exclude from 3.0 public JSON budget; no rewrite unless promoted to `agentera` command. |
| `scripts/measure_capability_context_payloads.py` | `--json` | `scripts/measure_capability_context_payloads.py` | cli (measurement) | diagnostic | Maintainer measurement harness referenced by Decision 59 for capability-context byte/token budgets. | Extend to whole-surface inventory in follow-up task; not a public agent surface. |
| `scripts/measure_token_payload.py` | `--json` | `scripts/measure_token_payload.py` | cli (measurement) | historical | Decision 41 static dispatch byte benchmark; not wired to live CLI output. | Exclude from public-output rewrite; keep as historical evidence unless repurposed. |
| `scripts/validate_*.py` (capability, cross-capability, lifecycle, app-home) | _(no direct `--format json`)_ | `scripts/validate_*.py` | schemas / cli | private/excluded | Validators emit text; public JSON is only the `agentera validate … --format json` wrapper in `scripts/agentera`. | No direct JSON surface; wrapper rows above own the public contract. |
| `scripts/smoke_*.py` / `smoke_opencode_bootstrap.mjs` | internal `--json` calls to `agentera upgrade --json` only | `scripts/smoke_live_hosts.py`, others | eval | private/excluded | Smoke harnesses consume upgrade JSON internally; public JSON is the `agentera verify … --format json` facade. | Exclude helper-internal consumption from public inventory except via verify rows. |
| `scripts/extract_corpus.py` | _(writes corpus.json; no `--json` stdout flag)_ | `scripts/extract_corpus.py` | cli (internal) | private/excluded | Engine behind `agentera stats refresh`; structured output is stats JSON, not extract_corpus stdout. | Exclude. |

## Capability-context matrix (3.0)

All twelve capabilities in `CAPABILITY_NAMES` share one supported startup selector:

| Capability | Supported 3.0 selector | Historical (removed) |
|---|---|---|
| hej, visionera, resonera, inspirera, planera, realisera, optimera, inspektera, dokumentera, profilera, visualisera, orkestrera | `agentera prime --context <name> --format json` | `agentera hej --format json --capability-context <name> --context-profile {full\|slim}` |

Specialized nested context blocks (`orchestration_context`, `closeout_context`, `evidence_context`, `benchmark_context`, `execution_context`) live under `capability_context.context` in the prime response for applicable capabilities; budget work covers each capability separately even though the CLI selector pattern is shared.

## Notable gaps and inconsistencies

1. **Flag inconsistency**: `doctor` and `upgrade` use `--json`; most other commands use `--format json`. `PRIME_BLOB` and some prose reference `agentera doctor --format json`, which is not supported by the parser.
2. **`query design` JSON gap**: `--format json` is accepted but `_query_design` never emits JSON.
3. **Envelope inconsistency**: Routine state commands use the `_structured_state` envelope (`command`, `status`, `entries`, `source_contract`, …); `query <artifact>` generic mode emits a bare entry array; `query last-phase` emits a minimal object.
4. **`hej --capability-context` removed**: Parser rejects `--capability-context` and `--context-profile`; capability startup is `prime --context` only.
5. **Direct capability commands are routing-only**: `agentera planera`, `agentera realisera`, etc. print guidance to `prime --context` and skill routes; no capability-local JSON.
6. **Orientation JSON split**: Dashboard/orientation JSON is `prime --dashboard --format json`; capability startup is `prime --context` — not `hej`.

## High-risk JSON identifiers to preserve during rewrite

- **`bundle` compatibility object** inside `hej` / `doctor` JSON (`bundle.status`, `bundle.dryRunCommand`, `bundle.applyCommand`) until a structured migration is designed — aligns with D47 preserve list.
- **Canonical Markdown artifact labels** in `validate artifact --artifact` and lint selectors until Decision 58 artifact-ID migration lands.
- **Verify facade shape** (`command`, `status`, `family`, `target`, bounded `diagnostics`) for CI consumers.
- **Upgrade plan JSON phase names** (`bundle`, `artifacts`, `runtime`, …) as migration selectors even if user-facing prose changes.

## Surface count (approximate)

| Category | Count |
|---|---|
| Implemented public JSON command patterns in `scripts/agentera` | **~38** distinct selectors (excluding yaml-only and text-only misparsed paths) |
| Capability-context variants (`×12` capabilities, slim-only) | **12** live `prime --context` shapes; **24** historical hej full/slim profiles removed |
| Prime JSON surfaces (orientation + context) | **2** implemented (`prime --dashboard`, `prime --context`) plus text-only bare `prime` |
| Helper/diagnostic/historical `--json` scripts outside canonical namespace | **4** (`usage_stats`, `setup_doctor`, `measure_capability_context_payloads`, `measure_token_payload`) |

**Total inventoried selectors**: ~**42** live public patterns plus **2** historical hej capability-context profiles and **4** helper classifications.

## Verification method

Inventory rows were cross-checked by:

1. Reading `build_parser()` argument definitions in `scripts/agentera`.
2. Tracing each `cmd_*` / `_query_*` branch that calls `_emit_structured(..., "json")` or prints `json.dumps`.
3. Grepping `scripts/` for `add_argument("--json")` and `choices=[..., "json", ...]`.
4. Confirming Decision 58/59 scope against `.agentera/plan.yaml` Task 1 acceptance criteria and `.agentera/decisions.yaml` records #58 and #59.

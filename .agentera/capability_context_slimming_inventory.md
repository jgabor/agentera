# Capability Context Slimming Inventory

Date: 2026-05-20

## Problem

`agentera hej --format json --capability-context <capability>` currently emits the
full hej startup envelope for every capability. Most invocations repeat the same
`docs`, `progress`, `plan`, `bundle`, `attention`, `next_action`, and
`source_contract` data even when the target capability only needs a specialized
startup capsule or fallback commands.

Measured from the local checkout on 2026-05-20, the repeated base envelope is
about 20-21 KB, or about 4.9k GPT-5 tokens, before capability-specific
additions. Token counts were measured with the requested tokenizer path:

```bash
<output> | npx tiktoken-cli -m gpt-5
```

The largest repeated fields are stable across capabilities:

| Field | Approx bytes | Why it bloats capability startup |
| --- | ---: | --- |
| `docs` | 4,785 | Full docs summary repeats even when only artifact mappings or version policy are needed. |
| `progress` | 3,121 | Full recent-progress summary repeats even when only latest verification or recent context is needed. |
| `plan` | 1,953 | Full active-plan summary repeats even when a specific task capsule is enough. |
| `bundle` | 1,187 | Full installed-app repair data repeats when most capabilities only need status/caveat. |
| `decision_attention` | 1,027 | Hej dashboard pressure repeats even when the capability should use `agentera decisions --format json`. |

Current payload sizes:

| Capability | Current bytes | GPT-5 tokens | Capability-specific context bytes | Specific context |
| --- | ---: | ---: | ---: | --- |
| `hej` | 21,161 | 4,954 | 0 | none |
| `visionera` | 21,013 | 4,922 | 0 | none |
| `resonera` | 20,940 | 4,907 | 0 | none |
| `inspirera` | 20,777 | 4,870 | 0 | none |
| `planera` | 25,114 | 5,728 | 0 | `source_contract.capability_context.startup_contract` only |
| `realisera` | 34,483 | 7,913 | 10,771 | `execution_context` |
| `optimera` | 32,396 | 7,311 | 8,836 | `benchmark_context` |
| `inspektera` | 48,615 | 10,721 | 21,504 | `evidence_context` |
| `dokumentera` | 38,584 | 8,858 | 13,936 | `closeout_context` |
| `profilera` | 20,795 | 4,872 | 0 | none |
| `visualisera` | 20,891 | 4,896 | 0 | none |
| `orkestrera` | 28,933 | 6,660 | 6,720 | `orchestration_context` |

## Inventory

This inventory classifies what each capability actually needs at startup. It
separates read context from write targets because `_capability_artifact_needs`
currently treats every artifact in `schemas/artifacts.yaml` as a state need,
including produced-only outputs such as `plan_archive` and `optimera_harness`.

| Capability | Actual startup read context | Write/generated targets | Current bespoke context | Slim payload should include |
| --- | --- | --- | --- | --- |
| `hej` | App/home status, mode, profile status, health line, issue counts, plan progress, objective status, state presence, attention, decision attention, next action. | none | full hej envelope | Keep full envelope for bare `hej`; this is the dashboard source. |
| `visionera` | Existing vision status/content pointer, decisions caveats, recent progress, health constraints, recurring TODOs, design identity, docs mapping, profile status. | `vision` | none | `vision_startup_context`: vision status/path, docs mapping pointer, compact progress/health/TODO summaries, decisions fallback, design/profile caveats. |
| `resonera` | Decisions normal context, vision/objective context when the decision may affect direction or optimization, TODO context for surfaced debt, docs mapping, profile status/direct profile pointer. | `decisions`, optional `vision`, `todo`, `objective` | none | `deliberation_context`: decisions command contract, compact relevant state pointers, profile status, protected-write boundaries. |
| `inspirera` | Profile status/direct profile pointer only for persona-grounded applicability; optionally vision context when recommending direction changes. | `todo`, optional `vision` | none | `research_context`: profile status/path, optional vision status pointer, write-boundary caveats. No plan/progress/docs envelope by default. |
| `planera` | Current plan summary, docs mapping/version policy, vision direction pointer, firm decision constraints, TODO/health/progress summaries, profile status. | `plan`, `plan_archive` | `startup_contract` | `planning_context`: existing `startup_contract` plus compact `plan`, `docs.version_policy`, `health`, `todo`, `progress`, decisions fallback, profile caveat. Drop full hej dashboard fields. |
| `realisera` | Selected work item, acceptance criteria, plan constraints, scope boundary, verification expectations, docs mapping, health/TODO caveats, changelog boundary, progress logging pointer, decision fallback, profile/app caveats. | `plan`, `progress`, `todo`, `changelog`, sometimes `vision` by explicit approval | `execution_context` | `execution_context` as the primary payload plus minimal app/profile status. Drop duplicate top-level `plan`, `docs`, `progress`, `health`, `attention`, `next_action`. |
| `optimera` | Active objective, benchmark summary, experiment history status, progress failure pattern, decision fallback, docs mapping, profile status. | `objective`, `experiments`, `optimera_harness`, `todo` on failure pattern | `benchmark_context` | `optimization_context`: `benchmark_context`, active objective summary, experiments status/fallback, progress failure summary, profile caveat. Do not include full hej envelope. |
| `inspektera` | Evaluation target, plan criteria, latest progress verification, docs/version state, health state, TODO state, decision caveats, protected-state checks, profile/app caveats, residual risks. | `health`, `todo` with confirmation | `evidence_context` | `evidence_context` as the primary payload plus minimal app/profile status. Drop duplicate dashboard summaries. |
| `dokumentera` | Docs mapping/style/version policy, vision/audience pointer, latest progress evidence, decision caveats/review pressure, health doc gaps, TODO blockers, design voice, profile status, changelog boundary. | `docs`, `todo` | `closeout_context` | `closeout_context` for closeout mode plus docs style/mapping capsule for generate mode. Drop full dashboard summaries. |
| `profilera` | Existing profile status/path and decisions extraction context. | `profile` | none | `profile_context`: profile path/status/staleness, decisions fallback/source contract. No hej dashboard fields. |
| `visualisera` | Existing design status, vision identity, recent UI/design progress, design-related TODOs, docs mapping, profile status. | `design`, `todo` in audit mode | none | `design_context`: design status/path, vision identity pointer, compact progress/TODO design signals, docs mapping pointer, profile caveat. |
| `orkestrera` | Dependency-ready task queue, blocked task reasons, selected next task, task acceptance/evidence summaries, latest progress verification, retry-state provenance, health/TODO/docs/profile caveats, decision fallback. | `plan`, `todo` | `orchestration_context` | `orchestration_context` as the primary payload plus minimal app/profile status. Drop duplicate top-level `plan`, `docs`, `progress`, `health`, `attention`, `next_action` unless referenced by context. |

## Proposed Slim Contract

Change `--capability-context <capability>` from “full hej JSON plus optional
capability-specific context” to “capability startup capsule”. Keep full `hej
--format json` unchanged for dashboard rendering.

Suggested top-level shape:

```json
{
  "command": "hej",
  "status": "ok",
  "capability_context": {
    "capability": "realisera",
    "schema_version": "agentera.capabilityContext.v2",
    "mode": "returning",
    "app": {"status": "up_to_date", "caveats": []},
    "profile": {"status": "loaded", "stale": false, "caveats": []},
    "state": {
      "included": ["plan", "docs", "progress"],
      "missing": ["decisions", "vision"],
      "fallback_commands": ["agentera decisions --format json"]
    },
    "context": {
      "...": "capability-specific capsule"
    },
    "raw_artifact_read_policy": "Use included context and CLI fallbacks first; raw reads are last-resort diagnostics or write targets."
  }
}
```

Rules:

1. `hej --format json` remains the full dashboard source.
2. `hej --format json --capability-context <capability>` emits the slim capsule by default, or a transitional `--context-profile full|slim` flag can preserve compatibility.
3. The capability-specific capsule is authoritative for startup; callers should not need sibling top-level `plan`, `docs`, `progress`, `health`, `attention`, or `next_action` unless the capsule explicitly embeds a compact subset.
4. State inventory should classify artifacts by `local_role`: `consumes` and `produces_and_consumes` are read needs; `produces` are write/generated targets, not missing startup state.
5. Profile is a global persona source, not a project artifact. Most contexts should expose status/path/staleness and caveats, not profile body.
6. Decisions should usually be a fallback command and source-contract pointer, not repeated in hej context. Capabilities that need decision detail should run `agentera decisions --format json`.

## Implementation Plan

1. Replace `_capability_artifact_needs` with a role-aware inventory helper that returns `read_needs`, `write_targets`, `generated_outputs`, and `fallback_only`.
2. Add a `CAPABILITY_CONTEXT_FIELDS` or builder registry mapping each capability to the compact fields it needs.
3. Move existing `execution_context`, `benchmark_context`, `evidence_context`, `closeout_context`, and `orchestration_context` under the new `capability_context.context` field.
4. Add slim builders for `visionera`, `resonera`, `inspirera`, `profilera`, and `visualisera`; convert Planera’s startup contract into a `planning_context`.
5. Keep `source_contract.capability_context` only as compatibility metadata in full mode; in slim mode, make it the main top-level `capability_context`.
6. Add regression tests that compare payload sizes, GPT-5 token counts, and required context keys for all twelve capabilities. Measure tokens with `<output> | npx tiktoken-cli -m gpt-5` so the budget tracks context-window cost, not only bytes. A useful first budget is: generic capabilities under 8 KB and 2k tokens, Planera under 12 KB and 3k tokens, Orkestrera under 16 KB and 4k tokens, Realisera/Optimera/Dokumentera under 20 KB and 5k tokens, Inspektera under 28 KB and 7k tokens.

## Expected Effect

The slim contract should remove the repeated ~20 KB, ~4.9k-token dashboard
envelope from every capability-specific startup. Capabilities with bespoke
context keep their useful state but stop paying for duplicated sibling
summaries. Capabilities without bespoke context should fall from ~21 KB to a
small capsule containing only state presence, profile/app caveats, fallback
commands, and targeted context pointers.

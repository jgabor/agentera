# Complete CLI coverage contract

Status: implemented CLI interfaces and host-delivery boundary in this checkout.
The map below describes the delivered commands, not future command proposals.
Integrated engineering and four-host discovery qualification now pass; see the
latest Cursor qualification below. Task 12 lifecycle closeout and the targeted
audit remain coordinator-owned. Historical attempts retain their original limits.
This document is not publication evidence.

Latest qualification: **all eleven development engineering gates and all four
host discovery/retrieval checks pass**. See
[the Cursor qualification](#cursor-qualification--existing-authentication-resume-pass) and
[its durable evidence](qualification-2026-09-13-task12.json).

## Boundary and authority

The outcome is one host-visible `SKILL.md` plus the existing self-contained
Agentera CLI package. Every supported behavioral obligation must be reachable
through a purpose-owned CLI interface, without reading installation companions
or a checkout. Completeness means complete semantics, including qualifications,
constraints and required referenced guidance; it does not require preserving
retired commentary or exposing a literal file. Routine startup must not become
an unbounded contract dump.

The source authorities named below remain the **one production authority** for
their semantics. Implementations project those authorities through their owning
loaders; this map selects interfaces, not replacement values. Tests compare
against production sources and cannot become a new semantic registry. Do not
add a raw-file browser, file IDs, arbitrary path selectors, a generic contract
service, another package, or native host registrations.

No task, plan, evaluation or progress lifecycle is completed by this document.
Live-home conversion, cleanup, commits, pushes and publication remain separate
permissions. Project read/write permissions are not granted by discovery.

## Supported query forms

Commands below abbreviate the executable as `agentera`. Returned runnable
commands and public examples use `npx -y agentera@next` until stable promotion.
`C`, `A`, `V`, `OP`, `T` and `S` are placeholders filled from the preceding
response, never values the caller must derive from a filesystem path.

| Owner | Discovery chain | Content boundary |
| --- | --- | --- |
| CLI inventory | `agentera --help` → `agentera schema` | Commands, capabilities, artifacts, writer verbs, supported details, compatibility and state requirements. Existing schema fields and operation matrix remain, with exact detail actions. |
| Artifact contracts | `agentera schema` → `agentera schema --artifact A` → `agentera schema --artifact A --section S` | All governing schema sections, recursively nested definitions, descriptions, budgets, conventions, validation, lifecycle, archive and authority qualifications. Index lists every section and its classification. |
| Shared protocol | `agentera schema` → `agentera schema --protocol` → `agentera schema --protocol --section S` | All protocol groups, thresholds, transitions, operating and human-reference rules; not just selected primitive values. |
| Capability authoring | `agentera schema` → `agentera schema --capability-contract` → `agentera schema --capability-contract --section S` | Entry/group/directory requirements, primitive references, deprecation, trigger enrichment, prose conventions and authoring validation. |
| Capability execution | `agentera prime --context C` → `agentera prime --context C --detail instructions` or `--detail artifacts`, `--detail validation`, `--detail exit`, `--detail worker` | Static full instructions, complete read/write qualifications, every check and exit condition, delegated worker/evaluator inputs and outputs. `--detail` is static and never starts a capability or reads project state. Existing startup still serves complete compiled instructions and bounded state. |
| Typed operations | `agentera schema` → `agentera state A explain` → `agentera state A explain --verb V` → same query with `--section S` | Accepted input, nested fields, defaults, required/conditional rules, selectors, examples, ownership, preconditions, validation, atomic effects, replay and recovery. `--all` remains accepted; follow pagination rather than assuming one response contains every operation. |
| Routing | `agentera route --help` → `agentera route explain` → `agentera route explain --topic T` | Topics: `overview`, `phrases`, `triggers`, `receipt`, `evaluation`. Phrases/triggers may use `--capability C`; include status. No synthetic request or semantic host call is needed. |
| Reports and personal profile | `agentera report --help` → `agentera report explain` → `agentera report explain --operation OP` | Every current report operation, input/output shapes, history consent, private data boundary, coverage, refresh, candidate/review/publication bindings and recovery. Explaining never opens history, profile, review stores or project state. |
| Checks | `agentera check --help` → `agentera check explain` → `agentera check explain --operation OP` → same query with `--target T` where advertised | Operations: `validate`, `verify`, `lint`, `compact`, `durability`. Enumerate targets from existing dispatch/validator authorities, including source-only gates. Explain input, scope, effects, bounds, outputs, exit codes and correction. Never run a check as a side effect of explaining it. |
| Installation and recovery | `agentera upgrade --help` → `agentera upgrade --explain` → `agentera upgrade --explain --operation OP` | Operations: `install`, `refresh`, `migrate`, `reset`, `cleanup`. Explain current applicability and exact preview/apply grammar, ownership, explicit approval, effects/non-effects, retained data, interruption, retry and recovery. This selects guidance, not a new install executor or renamed migration flags. |
| Diagnostics | `agentera doctor --help` → `agentera doctor --explain`; `agentera app-home --help` → `agentera app-home --explain` | Signals and their scoped corrections, CLI/package/runtime-data versus host projection health, resolution precedence and supported overrides. Static explanation does not inspect those locations. Normal diagnosis remains read-only. |

### Bounded detail and failure behavior

These rules govern the **static detail** forms; existing entity retrieval
continues to use `references/artifacts/state-storage-authority.yaml`, not a
second pagination implementation with different state semantics.
Existing `schema` and `state A explain [--verb V|--all]` responses retain their
current fields and envelopes, adding exact detail/continuation actions where
needed. Their new selected-section responses use the detail envelope below;
do not wrap or rename existing JSON fields as an incidental compatibility break.

- Schema's `--artifact`, `--protocol` and `--capability-contract` selectors are
  mutually exclusive. `--section` requires a selected detail owner. Prime's
  `--detail` requires `--context` and rejects startup inputs, field filters,
  dashboard aliases and `--guidance`. Static explain forms reject operational
  input/apply/consent flags rather than ignoring them. Report operation selectors
  are the dispatched command tail as one argument (including nested actions);
  `summary` selects default analytics. Check targets likewise use the advertised
  target path as one argument. Each index returns the exact quoted command, so
  callers never guess a multi-token selector.
- Each detail response is one JSON object with
  `schemaVersion: agentera.guidanceDetail.v1`, `command`,
  `status`, `selection`, `items`, `completeness` and `next_command`. Items have
  semantic names, content and authority attribution. Attribution is provenance,
  never a required filesystem action. `selection` echoes only static selectors,
  not private input. `completeness` states returned/omitted counts for that
  selection and whether it is an index or complete detail.
- Index/detail pages are at most **32,768 UTF-8 bytes**, envelope included.
  `--limit` defaults to 20, range 1–100. `--cursor` is opaque and bound to the
  authority digest, selection, limit and stable authority order. A nonterminal
  page supplies an exact runnable `next_command`; the last page has null.
  Counts are local to the selected collection, not a false whole-contract claim.
- Every owner supports `--section S` on its selected detail query. A section is
  a returned semantic selector within that owner's contract, not a file path or
  raw-file ID. Preserve complete nested values. If a section is too large,
  return an index of its named subsections with exact commands; if a scalar
  prose body is too large, return numbered lossless parts through the same
  cursor query. Do not truncate prose or nested fields, or require a larger
  unbounded dump to recover omissions. Consumers read all required parts before
  acting. No configurable unlimited-output mode is required.
- All new static forms work outside a project and with absent, fresh, legacy,
  partially migrated or corrupt project state. Resolve packaged contracts
  without loading the installed skill, state entities, profile or history.
  Preserve supported explicit runtime-data overrides; invalid selected authority
  is reported, not silently replaced by a stale installed or unrelated source.
- New static forms exit 0 for an available index/detail, 64 for malformed,
  unknown, incompatible selectors or a stale cursor, and 1 for missing,
  incompatible or corrupt runtime authority. Errors reuse the structured error
  envelope with `class`, `message`, valid values (bounded), syntax, example and
  exact recovery/restart command. Invalid selection never falls back to another
  capability or current project. No state, cache, lock, telemetry, consent or
  installation writes; no network/model calls. No diagnostics leak personal
  definitions, history or request text.
- Existing execution/validation exit codes and payload meanings remain owned
  by those operations (for example routing receipt errors and private candidate
  reads are not normalized into a new common code). The new query grammar is
  additive. Existing aliases remain documented as compatibility aliases, not
  reintroduced as primary commands. Existing startup byte budgets and state
  availability/outcomes remain unchanged; static completeness is separate from
  state availability, execution eligibility and authorization.
- Selected output policy: operational output is JSON only; explicit
  `--format json` remains accepted and equivalent to the default. Help, version,
  and `prime --guidance` text are the only text exceptions. Operational text/YAML
  selectors are rejected with structured correction before effects, not silently
  reinterpreted. Text exceptions reject format selectors. Existing JSON keys and
  state input formats retain their meanings.

## Coverage map: the supplied 64-file inventory

The inventory is reused, not re-audited against the live installation:
**4 shared + 12 artifacts + (12 capabilities × 4 schemas) = 64**.
All paths in this section are relative to `skills/agentera/`. Rows map the
**whole source**, not just the currently projected fields. Every behavioral
nested key and behavioral source comment is included by the row's obligation;
an implementation may omit a comment only if its semantics are otherwise
served, or it is explicitly retired/nonbehavioral. New semantic descendants
inherit the same owner and must remain discoverable.

Evidence IDs below define acceptance obligations, not a pass ledger. Focused
owner tests cover the implemented interfaces; task 12 must establish final
source/generated/extracted and one-file-host qualification. No row is complete
merely because a validator accepts its source.

### Shared files (4)

| Source | Obligation / owner | Exact discovery path | Evidence |
| --- | --- | --- | --- |
| `SKILL.md` | Bootstrap, routing, handoffs, safety, state access, dashboard delegation; bootstrap/prime | `agentera --help` → `agentera prime --context status`; `agentera prime --guidance`; follow owner actions below | E1, E4, E5, E9 |
| `protocol.yaml` | All shared primitives, rules, relationships and rendering meanings; schema | `agentera schema` → `agentera schema --protocol` → `--section S` | E2, E4 |
| `capability_schema_contract.yaml` | Complete authoring contract, not only runtime validation; schema | `agentera schema` → `agentera schema --capability-contract` → `--section S` | E2, E7 |
| `route-phrases.yaml` | Full curated phrase registry, aliases, normalization, precedence and provenance; route | `agentera route explain` → `agentera route explain --topic phrases` | E5 |

### Artifact files (12)

For each row, discovery is exactly `agentera schema` →
`agentera schema --artifact A` → `agentera schema --artifact A --section S`,
with `A` as shown. This owns complete construction semantics even where no
typed writer exists. Writable operations link to `agentera state A explain`
and each supported `--verb V`; read commands and data availability remain
separate. Do not manufacture `state vision/design/changelog` writer verbs.

| Source | A | Additional whole-contract obligations | Evidence |
| --- | --- | --- | --- |
| `schemas/artifacts/changelog.yaml` | changelog | Editorial release grouping, versions, audience and validation; capability-owned singleton | E2, E3 |
| `schemas/artifacts/decisions.yaml` | decisions | Entity identity, amendment, confidence versus user satisfaction, archive/migration distinctions | E2, E3 |
| `schemas/artifacts/design.yaml` | design | Visual system structure, token references, conventions, capability-owned editing | E2, E3 |
| `schemas/artifacts/docs.yaml` | docs | Entry writer versus singleton mappings/policy, paths as data, conventions, coverage and versioning | E2, E3 |
| `schemas/artifacts/experiments.yaml` | experiments | Objective binding, publication, measurement, replay, full versus summary archive detail | E2, E3 |
| `schemas/artifacts/glossary.yaml` | glossary | Shared entry primitive and referenced meanings, personal/project distinction, Build-owned project publication | E2, E3, E6 |
| `schemas/artifacts/health.yaml` | health | Audit dimensions, grades, findings, severity, archive, typed publication | E2, E3 |
| `schemas/artifacts/objective.yaml` | objective | Immutable identity/lineage, metrics and constraints, capability ownership and replacement | E2, E3 |
| `schemas/artifacts/plan.yaml` | plan | Entity/task versus atomic-create shape, dependencies, review, readiness, evaluation, lifecycle and archive | E2, E3, E10 |
| `schemas/artifacts/progress.yaml` | progress | Conditional durable logging, required caveats/sweep, verification, writer-owned order, compaction | E2, E3 |
| `schemas/artifacts/todo.yaml` | todo | Entity transitions versus editorial file, readiness, severity, resolved retention and budgets | E2, E3 |
| `schemas/artifacts/vision.yaml` | vision | Complete nested construction/validation and owning-capability restrictions; no installed-schema lookup | E2, E3, E4 |

### Capability files (48)

Each row denotes exactly these four files beneath `capabilities/C/schemas/`:
`triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`. The command
cells give exact per-capability detail paths, each discovered from the owner's
help/index or `agentera prime --context C`. This factorization is the coverage
map, not another capability list for production code.

| C | triggers.yaml (E5) | artifacts.yaml (E4) | validation.yaml (E4, E7) | exit.yaml (E4) |
| --- | --- | --- | --- | --- |
| status | `agentera route explain --topic triggers --capability status` | `agentera prime --context status --detail artifacts` | `agentera prime --context status --detail validation` | `agentera prime --context status --detail exit` |
| vision | `agentera route explain --topic triggers --capability vision` | `agentera prime --context vision --detail artifacts` | `agentera prime --context vision --detail validation` | `agentera prime --context vision --detail exit` |
| discuss | `agentera route explain --topic triggers --capability discuss` | `agentera prime --context discuss --detail artifacts` | `agentera prime --context discuss --detail validation` | `agentera prime --context discuss --detail exit` |
| research | `agentera route explain --topic triggers --capability research` | `agentera prime --context research --detail artifacts` | `agentera prime --context research --detail validation` | `agentera prime --context research --detail exit` |
| plan | `agentera route explain --topic triggers --capability plan` | `agentera prime --context plan --detail artifacts` | `agentera prime --context plan --detail validation` | `agentera prime --context plan --detail exit` |
| build | `agentera route explain --topic triggers --capability build` | `agentera prime --context build --detail artifacts` | `agentera prime --context build --detail validation` | `agentera prime --context build --detail exit` |
| optimize | `agentera route explain --topic triggers --capability optimize` | `agentera prime --context optimize --detail artifacts` | `agentera prime --context optimize --detail validation` | `agentera prime --context optimize --detail exit` |
| audit | `agentera route explain --topic triggers --capability audit` | `agentera prime --context audit --detail artifacts` | `agentera prime --context audit --detail validation` | `agentera prime --context audit --detail exit` |
| document | `agentera route explain --topic triggers --capability document` | `agentera prime --context document --detail artifacts` | `agentera prime --context document --detail validation` | `agentera prime --context document --detail exit` |
| profile | `agentera route explain --topic triggers --capability profile` | `agentera prime --context profile --detail artifacts` | `agentera prime --context profile --detail validation` | `agentera prime --context profile --detail exit` |
| design | `agentera route explain --topic triggers --capability design` | `agentera prime --context design --detail artifacts` | `agentera prime --context design --detail validation` | `agentera prime --context design --detail exit` |
| orchestrate | `agentera route explain --topic triggers --capability orchestrate` | `agentera prime --context orchestrate --detail artifacts` | `agentera prime --context orchestrate --detail validation` | `agentera prime --context orchestrate --detail exit` |

Triggers include all descriptions, priorities, intent/disambiguation and status
fallback, not just the non-status semantic capsule. Artifacts include every
read/write role, qualification, conditional and integration requirement.
Validation includes every check, level, severity and cross-reference, not just
an instruction summary or validation result. Exit includes every condition,
signal, continuation/stop rule and handoff, not only a final status enum.

## Required referenced guidance and command families

Paths here are repository-relative provenance. Follow all required semantic
references transitively through the named owner, including primitive meanings;
a returned file path or successful validator alone is not coverage. Internal
source/maintainer references may remain paths when not required to operate a
supported workflow, but must be labeled source-only rather than a host fallback.

| Required source(s) | Obligation and exact owner discovery | Evidence |
| --- | --- | --- |
| `packages/cli/src/capabilities/<name>/instructions.ts`; `references/cli/capability-instruction-contract.yaml` | `prime --context C` → `prime --context C --detail instructions`; preserve full compiled prose, first-invocation semantics, state qualifications and shared rules. Authoring: `schema --capability-contract`. | E4, E7 |
| `references/cli/capability-instruction-contract.yaml#evaluator_handoff`; worker specifications and delegation rules in compiled capability instructions | `prime --context C --detail worker` lists applicable worker/evaluator roles and sections; `--section S` gives complete inputs, output requirements, exact evidence commands, warn/fail recovery, permissions and stop/handoff duties. A capability with no worker flow reports an explicit empty/not-applicable contract, not a fabricated executor. | E4, E5 |
| `references/cli/hybrid-route-contract.yaml`; `references/cli/routing-model.md`; `references/cli/trigger-schema-enrichment.md` | `route explain --topic overview`, `phrases`, `triggers`, `receipt`, `evaluation`; authoring via `schema --capability-contract`. Cover normalization, deterministic tiers, abstention, host judgment, ambiguity/no-match, aliases, spans, request/capsule digests, nullability and receipt authorization. Evaluation conformance is not semantic generalization. | E5, E7 |
| `references/artifacts/glossary-entry-contract.yaml`; `references/analysis/evidence-tier-authority.yaml`; Profile format in compiled instructions | `schema --artifact glossary` → `schema --artifact glossary --section entry` serves the shared primitive and exact linked details for provenance, temporal/permanence/confidence meanings, ownership and consumer rules. `prime --context profile --detail instructions` supplies Profile construction. `report explain` → `--operation OP` covers grounding, advice, candidates, decision, review, publication, refresh and evidence-tier acquisition. `state glossary explain --verb publish` owns project publication. | E2, E3, E6 |
| `references/artifacts/state-storage-authority.yaml`; `references/artifacts/artifact-registry-interface-model.yaml`; `references/artifacts/verbosity-budget-authority.yaml`; `packages/cli/src/state/write/operations.ts` and its operation implementations | `schema --artifact A` and `state A explain --verb V` cover identity, paths/overrides, nested input, defaults, preconditions, typed ownership, readiness, omission, compaction, archive and replay. `state query --list-artifacts` remains runtime location discovery, not a replacement for static contract discovery. `check explain --operation durability` owns migration/readiness diagnostics. | E2, E3, E7 |
| `packages/cli/src/cli/commands/report.ts` and report dispatch/registries; glossary and evidence-tier authorities above | `report explain` indexes **all actual dispatched operations**, including default analytics, refresh, profile-grounding, glossary-advice, private candidate reads, decision, reviews and publication. Explain coverage gaps, consent before acquisition, active versus historical sources, privacy, stale generation, expiry, replay and repair. No sample contains real personal definitions. | E6 |
| `packages/cli/src/cli/commands/validate.ts`; `references/analysis/structured-input-inventory.yaml`; `references/analysis/verification-policy.yaml`; `references/meta/retained-reference-authority.yaml`; `references/analysis/personal-glossary-evaluation-authority.yaml`; `references/analysis/personal-glossary-evaluation-corpus.yaml`; `references/analysis/personal-glossary-holdout.yaml` | `check explain --operation validate` → `--target T`, and `check explain --operation verify` → `--target T`; discover every supported target, request/output requirements, prerequisites, evidence limits and correction. Expose usage and contract semantics, not private corpus records or an unbounded fixture dump. Label checkout-only retained-reference/activation and historical qualification needs honestly. | E7 |
| `references/cli/vocabulary.md`; `references/cli/vocabulary-index.yaml`; `references/cli/app-lifecycle-vocabulary.yaml`; `references/cli/update-channels.yaml` | `schema` indexes canonical command/alias and channel compatibility; `schema --capability-contract` covers authoring meanings; `upgrade --explain` covers supported lifecycle vocabulary. Retired names are corrections or migration-only, not new current commands. | E1, E7, E8 |
| `packages/cli/src/setup/sharedSkill.ts`; `packages/cli/src/setup/hostSkillLifecycle.ts`; `packages/cli/src/setup/hostSkillConversion.ts`; `packages/cli/src/upgrade/productV1Reset.ts`; `references/adapters/product-v1-reset.yaml`; `references/adapters/runtime-lifecycle-operation-contract.yaml#shared_skill_exception`; `UPGRADE.md` | `upgrade --explain` → `--operation install`, `refresh`, `migrate`, `reset`, `cleanup`; `doctor --explain`. Ordinary `prime`/`doctor` return `shared_skill.upgrade_offer` with one Yes/No question and the complete approved command. `upgrade --shared-skill` owns fresh publication, refresh and whole dedicated-directory replacement without historical per-file proof. The CLI retains old data, checks approval and verifies one-file delivery; decline/no answer/current installs cause no update. Linux apply, the 4096-entry inventory, same-filesystem retention and unchanged native-cleanup ownership rules remain. Reset/refresh/upgrade never recreate a full-tree host link. | E8, E9 |
| `references/adapters/runtime-lifecycle-authority.yaml`; `references/adapters/runtime-lifecycle-adapters.yaml`; `references/adapters/runtime-lifecycle-operation-contract.yaml`; `references/adapters/runtime-retired-resources.yaml` | **Migration-only**: `upgrade --explain --operation migrate` and `--operation cleanup`; read-only `doctor --explain` describes retired-resource diagnostics. Retain supported selectors/ownership and explicit approval; never use these authorities to register native current integrations. | E8 |
| `references/adapters/package-registry.yaml`; `docs/packaging/v3-packaging.md`; `references/adapters/package-surface-characterization.md`; `references/analysis/bootstrap-integrity.md`; `references/analysis/toolchain-baseline.yaml` | `doctor --explain`, `app-home --explain`, `upgrade --explain --operation install` distinguish package, runtime data, overrides and host projection. Required consumer recovery must be served; source-only build/package qualification recipes remain maintainer runbooks. One package retains internal contracts; only the host projection is one-file. | E8, E9 |

No publication credential/approval service is added: publication remains the
existing separately authorized maintainer workflow. No relocation of internal
runtime data is required. Do not absorb objective/experiment path-identity TODO
`bqbsplvlfz` or unrelated global cleanup TODO `zeyfnbqdov`. Explain existing
identity and scope faithfully; only changes necessary for the one-file boundary
belong to this boundary; unrelated acceptance remains open.

## Reconciliation decisions

The canonical checkout is authoritative. The nine originally observed installed
drifts explain the reconciled meanings below, not a fresh live-home audit.
**Do not update the installed copy or its symlink target** as part of documentation
or qualification work.

| Reconciled source / boundary | Current meaning |
| --- | --- |
| Installed `SKILL.md` and `protocol.yaml` | Canonical operating rules: reuse applicable evidence, probe consequential unknowns, stop at accepted scope; host/trust gates and explicit consent remain binding. The one-file bootstrap discovers these through CLI details, not installed companions. |
| Installed artifact `plan.yaml` and capability `plan/schemas/validation.yaml` | Full plans require an actual review with truthful nonnegative counts; zero findings is valid. No fabricated minimum critic count. The canonical PV3 description and zero-allowed check agree. |
| Installed `build/schemas/exit.yaml` and `build/schemas/validation.yaml` | Scoped verification/evidence reuse; commit only when explicitly authorized; progress is conditional under the typed writer, not one record per attempt. One Build task then stop; lifecycle closeout stays with its assigned owner. |
| Installed `audit/schemas/validation.yaml` | Adequate attributed task/worker evidence may support evaluation without optional progress; an unrelated latest progress record never proves the task. Preserve caveats and mandatory gates. Serve the whole canonical validation document through capability detail. |
| Installed `orchestrate/schemas/exit.yaml` and `orchestrate/schemas/validation.yaml` | Mandatory audit evaluation remains; adequate attributed evidence does not require optional progress. Preserve canonical retry, continuation/stop, terminal-open closure and authorization rules. Do not turn installed text into a stronger commit, logging or repetition requirement. |
| Bounded schema/operation summaries versus full contracts | Selected schema and operation sections supply the nested meanings and BUDGET/COMPACTION/VALIDATION/ARCHIVE/CONVENTION(S) omitted by summaries. An operation example or flat field list is not whole-contract coverage. |
| Prime startup versus static capability detail | Full compiled prose remains at startup; static artifacts/validation/exit/worker sections expose complete obligations. State startup availability is not proof of static completeness or execution permission. Current instructions use typed entity authority. |
| Plan artifact metadata names `.agentera/plan.yaml`; historical aggregate paths appear in instructions | Entity authority and typed writer win for current reads/writes. The aggregate is atomic-create input where explicitly declared; legacy paths, composite identities and archive forms remain migration-only. Do not hide the source qualification or present legacy shapes as current writer examples. |
| Route semantic capsule versus static discovery | `route explain` includes status fallback independently of request routing. The deterministic algorithm and receipt meaning are unchanged; the bootstrap uses CLI routing guidance. |
| Vision construction and Profile primitive meanings | Vision uses `schema --artifact vision`; Profile uses glossary schema details plus its compiled instructions and report explanation. Validator success alone cannot teach construction semantics. No installed-schema lookup is required. |
| Host delivery versus runtime data | One-file publication is separate from internal data. Owned legacy conversion requires explicit matching approval and retains the old link/tree without following links. Reset does not recreate a full-tree link. Diagnosis/discovery never repairs automatically. |
| Operational output formats | JSON-only dispatch preserves explicit `--format json`, input formats and JSON meanings. Help, version and `prime --guidance` remain text exceptions. |

Historical v1/v2 material, retired instruction filenames, native descriptors and
migration aliases remain explicitly historical/migration-only according to
`references/meta/retained-reference-authority.yaml` and their existing owners.
Do not delete supported migration or teach its selectors as current writes.
Source authors may still read source files; the delivered host must not need to.

## Acceptance evidence and final qualification

Every case runs from a current local build when CLI behavior changes; final
boundary cases use the repository-constructed extracted package with an isolated
HOME and only the host `SKILL.md`. Do not mutate the actual home for evidence.
Prefer existing relevant tests, one pass and one failure per unit, expanding
only for distinct authority, privacy, replay or boundary risks.

- **E1 — Discovery reachability:** start at help/schema with no file inventory;
  every mapped owner/detail is discoverable by exact command. Unknown owner or
  selector returns structured correction and no effects. JSON default equals
  explicit JSON; test the selected format exceptions and unsupported formats.
- **E2 — Static completeness:** enumerate all artifact/protocol/authoring
  sections and follow every continuation; compare all governing nested content
  against its production authority, including skipped projection groups and
  behavioral comments/qualifications. Prove missing/corrupt project and absent
  host companions do not alter static content; malformed runtime authority
  fails honestly. Force multi-page, oversized nested and long-prose fixtures;
  reconstruct losslessly within byte bounds and reject stale cursors.
- **E3 — Write/read qualifications:** enumerate the real operation matrix;
  construct a valid request only from each explanation and exercise its existing
  validator/dry run. Invalid, stale, unauthorized and legacy-shaped requests
  preserve bytes. Confirm singleton editing is not advertised as a typed write;
  no state is acquired/mutated merely to explain an operation.
- **E4 — Twelve capability contracts:** for each capability compare full served
  instructions and artifact/validation/exit/worker details with their authorities;
  follow every required primitive and detail action. Check read/write qualifiers,
  stop and consent rules and unchanged startup bounds. Corrupt/deferred state
  must not become a claim of static absence or execution permission.
- **E5 — Routing and workers:** enumerate phrases and triggers including status,
  aliases, disambiguation, fallback and receipt requirements without fabricating
  a request. Preserve existing deterministic and receipt conformance evidence;
  invalid/stale receipt or worker evidence must not authorize execution. Build
  one delegated and one evaluator handoff from served guidance only, preserving
  exact worker inputs, output/evidence obligations, consent and failure recovery.
- **E6 — Profile/report privacy:** construct glossary primitive entries using
  served meanings, not trial-and-error validation. Exercise each dispatched
  report contract, including refresh/grounding/advice/candidate/decision/review/
  publication. Static explanation works without private stores; operational
  malformed/stale/unconsented requests fail before effects and preserve private
  content. Reuse existing generation, expiry and approval/replay tests.
- **E7 — Checks/authoring:** enumerate actual check/validator targets, derive
  valid and invalid inputs from guidance, and observe exact diagnostic recovery.
  Include lint/compact check-versus-fix and source-only/packaged applicability,
  verification evidence limits, capability authoring and primitive references.
  An unavailable source-only gate is not a packaged PASS or an install repair.
- **E8 — Lifecycle/diagnosis:** in isolated homes test fresh, owned symlink,
  copied, unowned, extras, changed preview, interrupted and repeated operations.
  Verify explicit scope/ownership/approval, retained runtime data and no-effects
  failures. Test reset, refresh and upgrade preserve the one-file host shape;
  migration-only/native cleanup stays distinct from current installation.
- **E9 — One-file delivery:** extracted package outside checkout, isolated HOME,
  no external Agentera data and only host SKILL.md; traverse all mapped workflows
  and required references through CLI. Compare source/generated/extracted
  semantics, preserve runtime overrides, and smoke each claimed supported host.
  Unavailable host evidence remains a qualification gap, not an inferred pass.
- **E10 — Critic consistency:** canonical PV3 description and checks
  both permit truthful zero findings after review; existing full-plan validation
  accepts zero and rejects malformed/unresolved review accounting. No writer
  behavior change is needed to correct the contradictory prose.

## Remaining qualification

Artifact/shared details, typed explanations, capability and worker guidance,
routing, reports/checks/recovery, the standalone bootstrap, package selection,
fresh installation/diagnosis and owned conversion are implemented. Their
authorities remain in the existing source loaders and package registry.

The attempt below adds extracted discovery/continuation evidence. Qualification
still requires a passing package owner, the required development conjunction,
and current supported-host evidence. No task, plan, evaluation or health record
is completed here. No live-home conversion or publication is authorized.

## Qualification attempt — 2026-09-13 (blocked)

Historical attempt, retained verbatim below. The package failure and runtime
uncertainty are resolved by the later resolution attempt; its remaining blockers
supersede this attempt's stopping point.

**Not READY. First unresolved owner: package.** The existing test
`packages/cli/test/packaging/packageVerification.test.ts`,
`matches selected-term startup across constructed and extracted runtimes`, fails:

```text
AssertionError: expected 35641 to be less than or equal to 32768
Test Files  1 failed (1)
Tests       1 failed | 20 passed (21)
package owner failed (exit 1)
```

The scenario invokes `prime --context plan --term-input FILE --format json`
with an isolated entity-mode project and synthetic empty personal glossary.
Constructed/extracted semantic equality, exit 0, `no_applicable_entry`, no
selected-term echo, and unchanged project file inventory pass before the byte
assertion. Startup is **2,873 bytes over** the existing limit. The test and
limit are retained unchanged; neither raising the limit nor truncating required
instructions is an accepted correction. Production diagnosis/correction belongs
to the next bounded resolve, followed by the package owner and development gate.

### Candidate binding and applicability

The successful traversal used the package owner's governed two-construction,
pack/extract fixture, not direct checkout `npm pack`, publication, or a Git copy.
Both private builds were fresh after qualification test inputs changed. The
fixture copied cached declared npm dependencies to regular directories instead
of leaving its usual checkout `node_modules` symlink during the probe.

```text
HEAD                 6248919d4216dd38bb80c1f87e95e5a54bc69624
tree                 ea84b675fb52acf4ebd9976a3021e6bbd3297382
source files         7414
workingTreeSha256    0147f8f0649bd122141975e1caca5751d71814e1d8568b4b309e747aad1f4899
identitySha256       30e556dd6a23df4fa1b22d2bfd99c0783c9774274c7e10b0819729f5766e2517
tarball SHA-256      fcd08639ad7f22fcdec42f976e364b5c12163ceee66f3aac0595a9a72ce27b43
```

These identify a **dirty candidate**, not HEAD alone or a release receipt.
This evidence text and the historical-smoke clarification in `UPGRADE.md` were
written afterward; they do not change runtime bytes or tests. Any subsequent
runtime, authority, packaging or test change requires reassessing applicability.
Temporary package roots were fixture-owned and removed; the commands, bindings,
results and proof limits here are the durable record, not temporary paths.

Launcher verification at both ends reported standalone **0.3.0** and local
**0.3.0**, pnpm **10.30.3**, Linux x64. `vp node` reported **v24.19.0**;
package-child failure diagnostics reported **v24.21.0**. Do not infer exact
child runtime-pin parity from the launcher display; that discrepancy has not
been diagnosed. No alternate launcher, dependency installation or credential
inspection was performed.

### Added traversal proof

`packages/cli/test/packaging/staticDiscoveryQualification.test.ts` uses
`test/helpers/staticDiscoveryQualification.mjs`. It starts with CLI schema and
prime help, follows returned static commands and continuations, and enumerates
the twelve contexts and five detail kinds. Each process uses an isolated HOME
whose host projection is only `SKILL.md`, with no inherited Agentera, profile,
credential or XDG locations. Only the extracted distribution may supply content.
The probe rejects `readFileSync` outside that distribution, including module
loads, rejects any `SKILL.md` content read by the runtime, and rejects synchronous
static writes. Named authorities remain provenance, not host filesystem actions.
The harness itself is a maintainer test input, not a package companion.

This is instrumented content-read/effect evidence, **not an OS sandbox or native
host discovery smoke**. It does not claim to intercept every possible filesystem
API. Source owner tests retain malformed authority, private-store denial,
lossless reconstruction and effect-preservation coverage. The existing package
test retains all declared source/runtime input byte comparisons, generated and
extracted parity, 16 cold executable queries, and missing/corrupt packaged
protocol rejection. The new traversal does not repeat every source negative
fixture against every distribution.

| Traversal partition | Query executions | Detail pages | Continuations | Largest detail bytes |
| --- | ---: | ---: | ---: | ---: |
| Schema | 1388 | 1282 | 29 | 29337 |
| Twelve capability contexts | 347 | 275 | 2 | 26721 |
| Typed state explanations | 103 | 54 | 0 | 16455 |
| Routing | 94 | 83 | 0 | 12016 |
| Report operations, partition 0 | 372 | 341 | 10 | 26108 |
| Report operations, partition 1 | 447 | 410 | 12 | 26100 |
| Report operations, partition 2 | 77 | 70 | 2 | 26048 |
| Checks | 143 | 100 | 0 | 14345 |
| Upgrade/recovery | 1230 | 1146 | 50 | 10534 |
| Doctor | 253 | 236 | 10 | 10510 |
| App-home | 2 | 1 | 0 | 2248 |
| **Total** | **4456** | **3998** | **115** | **29337** |

These are executions, not unique semantic obligations: report partitions each
read their shared discovery index. The three disjoint operation partitions keep
the existing per-test deadline; they do not raise test or package owner budgets.
Initial schema bootstrap reads used to discover each partition are additional to
the table. Every traversed guidance envelope is checked against 32,768 bytes and
returned/omitted/total counts. Each run emits the exact root command inventory,
command-set SHA-256 and semantic SHA-256 bound to the candidate above.

The successful inventories are:

- Schema: all twelve artifact names in the coverage map, protocol, capability
  contract, their returned nested sections and continuations.
- Capability: `instructions`, `artifacts`, `validation`, `exit`, `worker` for
  **status, vision, discuss, research, plan, build, optimize, audit, document,
  profile, design, orchestrate**. Real quoted selectors containing an apostrophe
  (Research worker guidance) are parsed and exercised without a shell.
- State: nine families; **29 advertised verbs**. Progress/health append;
  decisions append/update/amend; plan append/update/set-status/supersede/
  set-plan-status/record-evaluation/archive/create/replace; objective create/update;
  experiments publish; todo activate/repair/correct-owners/create/update/
  set-severity/supersede/resolve/reopen; docs create/update; glossary publish.
  Family, `--all`, verb and returned section forms remain distinct.
- Route: overview, phrases, triggers, receipt, evaluation, including complete
  returned all-capability content rather than synthetic routing requests.
- Report: summary, refresh, profile-grounding, glossary-advice, candidate list/get,
  decision, review queue/disposition/list/get and publication: **12 operations**.
- Check: validate/verify/lint/compact/durability; **33 validate targets** (eleven
  general families, twelve capabilities, ten artifact targets) and four verify
  targets (eval skills/semantic/routing/glossary). Source-only guidance availability
  is not evidence that a packaged source-only check can execute.
- Lifecycle: install/refresh/migrate/reset/cleanup plus doctor and app-home details.

### E1–E10 evidence assignment and remaining limits

Prior evidence is reused from the coordinator-accepted tasks 1–11, confirmed by
`state plan get --id lknwkijlkw`; their accepted evaluations do not constitute a
new full-source or development run. Only tests/documentation were added here.

| Assignment | Concrete proof and reuse | Current limit |
| --- | --- | --- |
| E1 | New extracted traversal reaches all nine owners; `oneFileSkill.test.ts`, `help.test.ts` and package JSON-selector parity retain discovery, correction and format tests. | No native host smoke. |
| E2 | New traversal visits every returned schema section/continuation; `schemaDetail.test.ts` owns authority reconstruction, nested/long-prose bounds, stale cursors and missing/corrupt authority. Existing package test compares declared source inputs and rejects missing/corrupt protocol. | Traversal alone is not a new semantic-authority oracle. |
| E3 | All advertised writer verbs are reached; `state/write/operationDetail.test.ts` owns returned-input validation, TODO batch parsing, plan retained-field roundtrip, glossary replay and stale/legacy rejection. Accepted task 3 correction retained. | Existing execution fixtures reused, not all writers re-executed by static traversal. |
| E4 | All 60 capability/detail pairs plus continuations; `capabilityDetail.test.ts` and `oneFileSkill.test.ts` own full prose/schema/primitive comparisons and state independence. | Selected-term plan startup byte failure remains blocking. |
| E5 | Full routing/worker detail traversal; `routeWorkerDetail.test.ts` owns receipt seam validation and delegated/evaluator handoff obligations; accepted task 5 negative evidence retained. | No model generalization or delegated execution claim. |
| E6 | All 12 report operations traversed with no private-store reads; `serviceDetail.test.ts`, operation explanation fixtures and package production-glossary workflow retain construction, consent, expiry/generation and replay evidence. | Static availability is not consent or actual acquisition. |
| E7 | All check operations/targets discovered; `checkDetail.test.ts` retains durability selectors, lint/compact result/fix semantics and failure parity. Accepted task 11 help correction retained. | Full source/typecheck/contract/compact/development gates not reached in this attempt. |
| E8 | Accepted task 9: fresh/refresh, unsafe/hardlink/symlink/foreign identity, actual SIGKILL and 16 recovery probes; `hostSkillLifecycle.test.ts` includes both runtime-data overrides. Accepted task 10: owned symlink/copied conversion, changed approval, retained target, interrupted intent/move/create, replay and project isolation, backed by `hostSkillConversion.test.ts`. | These source/lifecycle checkpoints are attributed reuse, not fresh extracted lifecycle qualification for every scenario. Package reset and cleanup parity passed in the 20 passing tests. |
| E9 | Current extracted traversal, regular dependency copies, only host SKILL, source input byte census, 16 cold parity queries and package inventory rejection. | Four claimed-host smokes below remain blockers; no claim that empty native inventory removes them. |
| E10 | `coverageContract.test.ts` compares PV3 prose/checks; existing package zero-finding/no-progress publication test passed; accepted full-plan negative validation evidence retained. | No task/plan completion or inferred user satisfaction. |

### Supported-host evidence — still blocked

`runtime-lifecycle-authority.yaml#active_runtimes` is empty and the adapters are
migration-only. That is **not** the product support list. `UPGRADE.md` explicitly
claims Codex, Cursor, OpenCode and Copilot through the shared skill and CLI.

| Claimed host | Prior documented evidence | This candidate |
| --- | --- | --- |
| Codex | Loaded skill instructions before one-file qualification. | Binary `/bin/codex` found; disposable one-file discovery smoke **not obtained**. Blocker. |
| Cursor | Loaded skill instructions before one-file qualification. | Binary `/bin/cursor` found; disposable one-file discovery smoke **not obtained**. Blocker. |
| OpenCode | Listed canonical skill before one-file qualification. | Binary `/bin/opencode` found; disposable one-file discovery smoke **not obtained**. Blocker. |
| Copilot | Listed canonical skill, intentionally disabled. | Binary `/bin/copilot` found; disposable one-file discovery/disabled-state smoke **not obtained**. Blocker; listing is not execution support. |

Only binary discovery was performed; versions, authentication and host loading
were not inferred. Native smoke work was not started after the package failure.
This records unavailable **evidence**, not unavailable executables or missing
credentials. No installation, login, authenticated service, native registration,
trust change or live `~/.agents` write was attempted. Claude and other hypothetical
hosts are not added to this explicit four-host claim; migration resources do not
establish current support. The planned four-host evidence has not been dropped.

### Command log and stopping point

All commands ran in the assigned checkout with:

```bash
export PATH=/tmp/opencode/vp-commit-6dgl38ms:$PATH
```

| Command | Result |
| --- | --- |
| `vp --version` (start/end) | Standalone and local 0.3.0; ordinary 0.1.19 launcher not used. |
| `vp exec npx -y agentera@next state tasks get --id finaltask12xpgwtqtpur` | Structured unsupported-target correction; no state changes. |
| `vp exec npx -y agentera@next state plan get --id planlknwkijlkw` | Structured bare-ten-letter-ID correction; no state changes. |
| `vp exec npx -y agentera@next state plan get --id lknwkijlkw` | Read-only confirmation of accepted predecessors and task `xpgwtqtpur` acceptance. |
| `vp node packages/cli/dist/bin/agentera.js schema` | Existing task-11 local build served schema; orientation only, not final-build evidence. |
| `vp node packages/cli/dist/bin/agentera.js prime --help` | Launcher consumed `--help`; displayed `vp env exec` help. **Not CLI help evidence.** The test invokes the extracted executable directly with managed `process.execPath` instead. |
| `command -v codex cursor agent opencode copilot claude` | Four binary paths listed above; not host smoke evidence. |
| `vp -C packages/cli run verify:package -- packages/cli/test/packaging/packageVerification.test.ts` (initial three attempts) | Each 19 passed/2 failed. New probe first mishandled URL-encoded paths, then exceeded its own 90-second monolithic traversal deadline. Existing 35,641-byte startup failure persisted. Wall times 51.301s, 140.893s, 141.295s. |
| `vp -C packages/cli run verify:package -- packages/cli/test/packaging/staticDiscoveryQualification.test.ts` (first separate attempt) | 7 passed/2 failed, 204.187s owner wall time: probe apostrophe parsing and report partition deadline. Both harness defects corrected without changing product or gate limits. |
| Same separate qualification command (final) | **11 passed/11**, 243.473s owner wall time, within unchanged 515s package budget. All eleven bound JSON evidence records emitted. |
| `vp -C packages/cli run verify:package -- packages/cli/test/packaging/packageVerification.test.ts` (final) | **20 passed/21, exit 1**, 51.074s owner wall time. Sole failure is existing selected-term plan startup byte limit. |
| `git diff --check` | Passed before and after evidence documentation. No staging or commit. |

Per verification/release authority, **do not run omitted owners after the owning
failure**. No standalone full-source, typecheck, build, full-package,
capability-contract, compact, stress/capacity/resource or `vp run
verify:development` pass is claimed here. Fresh private construction builds
passed inside the selected package owner, which is not the whole conjunction.
After the bounded correction, the required `vp run verify:development` must run;
it owns the integrated source/typecheck/build/package/contract/compact and safety
checks. Reuse this successful traversal only while applicable. Full `vp run
verify` and historical certification were not required by this routine task,
were not run, and remain unqualified rather than inferred from development
evidence. All lifecycle closeout remains with the coordinator.

## Resolution attempt — 2026-09-13 (still blocked)

Historical resolution attempt. Its repository blockers are resolved by the
engineering qualification below; Cursor's authentication boundary remains.

**NOT READY. Task 12 and the plan remain open.** The original package failure is
fixed, but the required development conjunction fails at `generated-overlap`,
and Cursor cannot complete discovery without authentication. No task, evaluation,
health, changelog, entity, index, Git ref, version or live-home mutation was made
in this resolution. Tasks 1–11 and all pre-existing work are retained.

### Startup correction and runtime diagnosis

A fresh `vp run build` reproduced the overflow before editing production code.
The disposable fixture measured 35,507 bytes (path lengths differ from the
35,641-byte package fixture): the full instruction string occupied 23,668 JSON
bytes, glossary advice only 157, and context 6,640. The old compact wrapper was
still repeating instruction-authority, orientation, permission, handoff and
historical seam prose beside the now-complete instructions; first-read loader
metadata and the host repair narrative added further duplication. This was not
an oversized selected term, advice echo, truncated pipe or stale executable.

Plan startup now retains workflow markers and full instructions, with explicit
`detail_availability`, `omitted_fields`, `read_before_reliance` and the exact
`prime --context plan --detail instructions --section startup_contract` action.
That section returns the complete existing startup contract without changed
semantics. First-read invocation/enforcement and host health/ownership facts plus
the exact home-scoped repair preview remain, following the existing Status
summary pattern. Instructions, governing glossary/caveat rules, advice fields,
receipt privacy and the 32,768-byte budget were not changed. Source tests compare
every summarized/deferred field to the full authority and preserve complete
instruction equality. This is the tested fixture budget, not an unbounded-state
or arbitrary-input-size guarantee.

The added detail import initially exposed eager command-authority lookup at
module initialization. The missing-authority subprocess test caught it: an
uncaught `state-storage-authority.yaml` ENOENT escaped the structured error
boundary. Command maps now resolve through lazy getters, using the same loader
only when selected. The 54-test rerun and full extracted traversal passed,
including read/effect guards and missing-authority behavior.

`vp --version` reports standalone/local 0.3.0 and pnpm 10.30.3. `vp env doctor`
explains the Node mismatch: root resolves `.node-version` to 24.19.0, whereas
`vp -C packages/cli env doctor` resolves that package's `engines.node` range to
24.21.0. Both doctor probes also report ordinary-shell shim warnings and missing
Corepack shim; no global repair was attempted. Root-managed
`vp exec pnpm -C packages/cli ...` retains Node 24.19.0 through the existing test
helper's `process.execPath`. The package test now emits the actual child version
and byte evidence. No version override, alternate install or pin duplication was
introduced. Use the root-managed command below, not the earlier `vp -C` recipe,
for this checkout's pinned owner execution.

### Commands and accepted scope of results

All Vite+ commands use `PATH=/tmp/opencode/vp-commit-6dgl38ms:$PATH`.

| Command | Result and scope |
| --- | --- |
| `vp run build` | Passed before correction, solely for fresh-executable diagnosis. Corrected private builds subsequently passed inside the package owner. |
| `vp exec node -p 'JSON.stringify({version:process.version,execPath:process.execPath})'` | 24.19.0 from the managed distribution. |
| `vp -C packages/cli exec node -p 'JSON.stringify({version:process.version,execPath:process.execPath})'` | 24.21.0; diagnosis, not accepted pin parity. |
| `vp exec pnpm -C packages/cli exec node -p 'JSON.stringify({version:process.version,execPath:process.execPath})'` | 24.19.0; selected owner invocation route. |
| `vp exec pnpm -C packages/cli run verify:package -- packages/cli/test/packaging/packageVerification.test.ts` | 21/21 passed, 52.896s. The original failed owner was rerun before later gates. |
| `vp exec pnpm -C packages/cli run test:source -- packages/cli/test/cli/capabilityDetail.test.ts packages/cli/test/cli/prime.test.ts` | Initial 53/54: import-time authority error above. Same command after correction: 54/54, 9.43s. |
| `vp exec pnpm -C packages/cli run verify:package` | **4 files, 41/41 tests passed**, 293.722s against unchanged 515s budget. Includes all eleven extracted traversal partitions and two fresh constructions. |
| `vp run verify:development` | **Exit 1**, 304.114s, first failure `generated-overlap`; completed `stress`, `typecheck`. No passing conjunction or release receipt. |
| `vp exec pnpm -C packages/cli exec node scripts/pack-package.mjs --output-dir /tmp/opencode/task12-host-package --json` | Governed disposable host-smoke construction, not a later verification gate or publication. Its tarball is byte-identical to the passing full package owner; used instead of a stale local build for host retrieval. |

The new static section and shared command lookup changed traversal inputs, so
all eleven partitions were rerun in the full package owner rather than blindly
reusing the previous 11 passes. The result is **4,457 queries, 3,999 detail pages,
115 continuations, nine owners, all 60 capability/detail pairs**, maximum 29,337
bytes. Only Plan's added startup-contract section adds a query/page. The selected
term fixture is now **31,148 bytes constructed / 31,088 extracted**, leaving
1,620 / 1,680 bytes under the same limit. Advice remains `no_applicable_entry`,
the term is not echoed, and the only project file remains `state-mode.yaml`.

The durable JSON record above preserves candidate identity, tarball and all
partition command/semantic hashes. These bind a dirty checkout; this later
evidence-only documentation is not included in that source digest. No production
or test inputs changed after the successful full package run. Subsequent changes
must reassess applicability, especially the pending registry/guard repair.

### Current development blocker

The actual owner is
`packages/cli/scripts/verify-generated-overlap.mjs#runGeneratedOverlap`.
`test/runtime/retiredRuntimeSurfacePolicy.test.ts:190,945` reports **498**
bootstrap-authority inventory diagnostics:

- **481 CHANGELOG diagnostics**: existing exact region classifications shifted
  after the retained new entry (missing/stale/unused classifications cascade into
  command diagnostics); no history was rewritten to evade the guard.
- **3 README diagnostics**: moved exact vocabulary classification.
- **5 dynamic-consumer diagnostics**: the existing guard rejects the executable's
  literal dynamic imports, which the static cold-loading boundary uses to avoid
  initializing unrelated operational registries.
- **8 omitted producer records**: `capabilityDetail`, `checkDetail`,
  `recoveryDetail`, `reportDetail`, `serviceDetail`, `state/explainDetail`,
  `workerDetail`, and `state/write/operationDetail`.
- **1 missing producer**: `bin/agentera.ts`, disconnected from the guard's
  static-import-only dependency graph.

Diagnosis used the existing `registryBootstrapAuthorityInventory` helper, not a
replacement oracle. Neither the guard nor its registry was relaxed in this
resolution. This is now separate unresolved integration work: preserve exact
classification content/digests when relocating them; account for inspectable
literal imports without allowing opaque dynamic imports; maintain the closed
producer census. Correct this owner and rerun `vp run verify:development`.
Do not cherry-pick omitted contract, compact, capacity/resource or activation
readers and call the conjunction complete. Full source did not pass; standalone
post-correction full-source/contract/compact success is not claimed. Full
`vp run verify` and historical certification remain unnecessary and unrun.

### Current native host probes

Current docs were consulted through Context7 for Codex/OpenCode and the official
Cursor/Copilot documentation. The native methods used are documented at
[Codex protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs),
[OpenCode skills](https://opencode.ai/docs/skills/),
[Cursor ACP](https://cursor.com/docs/cli/acp), and
[Copilot skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills).

Each native probe ran under `bwrap --die-with-parent --unshare-net --unshare-pid`
with a read-only system root, hidden `/home`, `/root` and `/tmp`, clear environment,
and a disposable work directory bound at `/tmp/work`. HOME, CODEX_HOME and all
XDG directories point there; only the reviewed managed Node distribution is
mounted at `/tmp/managed-node`. No credentials or live host configuration are
visible. The Agentera host directory contains exactly the candidate SKILL.md,
hash `c283d3265563dd423e8768f5cc5461fa72bc3b9447388835414fcec1d337a33d`.
Native built-in skills/caches can be created in the disposable home; they are
not Agentera companions. No model prompt, login, native registration, trust
override, live installation, history read or network access was permitted.

Exact native launch wrapper (ROOT is the already-created disposable fixture,
NODE_ROOT the managed 24.19.0 distribution, and COMMAND/ARGS the table row):

```bash
bwrap --die-with-parent --unshare-net --unshare-pid \
  --ro-bind / / --tmpfs /home --tmpfs /root --tmpfs /tmp \
  --bind "$ROOT" /tmp/work --ro-bind "$NODE_ROOT" /tmp/managed-node \
  --proc /proc --dev /dev --chdir /tmp/work/project --clearenv \
  --setenv HOME /tmp/work/home --setenv CODEX_HOME /tmp/work/home/.codex \
  --setenv XDG_CONFIG_HOME /tmp/work/home/.config \
  --setenv XDG_DATA_HOME /tmp/work/home/.local/share \
  --setenv XDG_CACHE_HOME /tmp/work/home/.cache \
  --setenv XDG_STATE_HOME /tmp/work/home/.local/state \
  --setenv PATH /tmp/managed-node/bin:/usr/bin:/bin \
  --setenv TERM dumb --setenv NO_COLOR 1 \
  --setenv OPENCODE_DISABLE_AUTOUPDATE true \
  --setenv OPENCODE_DISABLE_MODELS_FETCH true COMMAND ARGS
```

The CLI retrieval wrapper adds `--ro-bind "$ROOT/extracted/package" /tmp/package`
before COMMAND. Extraction uses `tar -xzf ARCHIVE -C "$ROOT/extracted"` on the
governed tarball; only its declared `yaml` and `smol-toml` dependencies are copied
as regular directories from the installed cache. No package install or `npx`
network fetch is used inside the sandbox. This harness setup is not a new public
consumer command or host installer.

| Host | Actual observation | Scope / remaining gap |
| --- | --- | --- |
| Codex 0.154.0 | `/bin/codex app-server --listen stdio://`; `initialize`, `initialized`, `skills/list` with `cwds:["/tmp/work/project"]`, `forceReload:true`. Agentera's exact isolated SKILL.md returned with `scope:user`, `enabled:true`, no skill errors. Server exited 0. | Recognition plus harness-run extracted CLI retrieval passed in the same home. Temporary-home helper-alias warning retained; not a model execution claim. |
| OpenCode 1.18.30 | `/bin/opencode debug skill`, exit 0: Agentera name, exact isolated SKILL.md location, full body returned. Auto-update/models fetch disabled; network also unavailable at OS boundary. | Recognition plus harness-run extracted CLI retrieval passed in the same home. |
| Copilot 1.0.83 | `/bin/copilot skill list --json`, exit 0: Agentera, `personal-agents`, exact isolated directory, `enabled:true`. | Recognition plus harness-run extracted CLI retrieval passed in the same home. Fresh default is enabled; historical live disabled configuration was not inspected, reproduced or changed. |
| Cursor IDE 3.20.17 / agent 2026.08.25-3e8eec8 | `/bin/cursor-agent acp` accepted `initialize` (protocol 1) and advertised `cursor_login`; `session/new` returned error `-32000`, `Authentication required`. | **Blocked before skill recognition/retrieval.** No authenticate/login/prompt was sent. Process did not exit after stdin EOF and was killed at the 20s bound. No current skill-support pass is inferred from the IDE/agent versions or successful handshake. |

For each recognized host's same disposable home, the harness—not a model—ran
the candidate's `node /tmp/package/dist/bin/agentera.js prime --context plan
--detail instructions --section instructions`. All returned exit 0, **25,589
bytes**, all **3/3 lossless parts**, zero omitted and null `next_command`.
Concatenating the parts yields the same SHA-256 as startup instructions:
`d833fbca180301f253558cab4e8a8f34bbfaae9f2490197016802c99846b029d`.
The harness initially hashed only the first item; that local probe assumption
was corrected to consume all parts, without changing the product or its bounds.
The tarball SHA-256 is exactly the full package owner's
`950db40bbf54fa5fb216570507db07198d31166a37dbeb47e24bf2588be63c9f`.
Only regular copies of the package's declared dependencies were supplied, with
the checkout and real homes hidden. This is real native recognition plus CLI
retrieval evidence, not model selection/generalization or authenticated tool-use
evidence, and not enough to erase Cursor's blocker.

Disposable logs/scripts used `/tmp/opencode/task12-{package-full,development,
host-probes,host-rpc,host-cursor,host-acp,host-construction}.log` and
`task12-host-evidence*.json`; those are convenience paths, not durable receipts.
This section and `docs/qualification-2026-09-13-task12.json` are the durable
command/result/binding record. No lifecycle completion is implied.

Final `git diff --check` passed. Final pinned `vp --version` again reported
standalone/local 0.3.0, pnpm 10.30.3 and root Node 24.19.0. No files were staged
or committed and no push, publication, version change or live-home repair was
performed. The remaining blockers above were not reclassified as passing work.

## Engineering qualification — 2026-09-13 (passed; Cursor blocked)

Historical host stopping point: the engineering evidence remains applicable;
the Cursor criterion subsequently passed in the bounded authenticated resume below.

**Engineering: PASS, audit-ready. Native host qualification: Cursor BLOCKED.**
This completes the repository-side qualification work, not task/plan lifecycle
closure. Work stops pending the user's authentication decision; no new audit
cycle, optimization, login, credential lookup or host configuration change was
started. The three previous host smoke results remain applicable as scoped below.

### Why the earlier owner failed, and the bounded corrections

The 498 bootstrap diagnostics had three causes: physical line anchors drifted
while reviewed historical prose was unchanged; a static-import-only graph could
not see literal cold-loading imports; and new detail producers lacked exact
inventory declarations. The existing scanner now relocates a classification only
when its complete normalized prose scalar and declaration are both unique in the
same named Markdown file. Category, digest and reason remain binding. Changed
text, ambiguous copies, relocation into shell fences, cross-file matches and
structured-selector guesses do not inherit a classification. Old positions are
removed before new ones are assigned, avoiding cross-wiring after insertion.
No new scalar exemptions or changed scalar digests were added.

The bounded dependency graph now follows only a single literal `import()` argument
that resolves to exactly one repository TypeScript module. Existing file/edge
limits remain. Opaque expressions, external/missing/ambiguous targets, import
options and `require()` still fail closed. Eight exact producer declarations were
added for the static detail owners; the executable is again reachable through
its literal imports. The independent immutable tuple catalog and strict census
were reconciled: **78 package identities / 316 total**, without reading mutable
registry content to manufacture the expected catalog. Tests still reject omitted,
extra, changed and re-signed evidence.

Full-source execution exposed additional incomplete seams from tasks 1–11:

- The native-retirement census now includes exactly the static recovery loaders
  and approved one-file shared-skill ownership/publication edges; native adapter
  installation remains forbidden. Plan lifecycle inventory names its static
  recovery and executable dispatch adapters. Package-lane inventory includes the
  new extracted traversal file, without changing ownership or lane composition.
- Effective capability exports are compared with the complete serving adapter,
  including the contract-access tail. Historical raw literal commentary is not
  treated as current executable guidance; retired-native-support and full
  wrong-channel/invalid-command checks remain. The raw literal decoder no longer
  consumes later transformations as part of JSON.
- Help now distinguishes FORMAT grammar from runnable command examples, explicitly
  retaining JSON as the only public value/default. Shared-skill syntax uses the
  development constructor; approval prose no longer appears as shell grouping
  after a command. Check detail grammar matches help. No accepted format or
  permission changed. Stale Bootstrap section, internal-serializer format and
  whitespace-sensitive upgrade assertions were reconciled with current public
  behavior. README/upgrade prose retains the approved app/global scope and
  no-separate-selector rule for proven OpenCode plugin retirement.
- Bare prime's fixture exceeded its unchanged 3,000-token ceiling by five tokens.
  Its shared-skill summary now defers repair details through the exact
  `prime --fields shared_skill` command instead of repeating a truncated diagnostic
  paragraph. The byte/token regression passes; instructions and privacy rules
  were not shortened, nor were budgets raised.
- The retained-reference validator's three lexical helpers moved unchanged into
  `retainedReferenceSyntax.ts`, restoring the existing 1,000-line module limit.

After source/package and the later compact/contract gates passed, final activation
re-observation exposed an actual evidence-workflow defect: startup repair commands
contained the generated-owner's disposable HOME, while the reader used another
HOME. The observer now supplies its own absent home/app/profile roots. It checks
the complete emitted repair command against the exact fixture command **before**
normalizing only that known home argument to its fixed evidence identity.
Flags, owners and other command content are not normalized away. A regression
re-observes the same package from different projects and reader homes. Final
activation evidence now matches independent re-observation; no evidence was
manually marked passing and no product trust boundary was relaxed.

### Owner execution log

All commands used `PATH=/tmp/opencode/vp-commit-6dgl38ms:$PATH`. Root `vp run`
delegates through managed pnpm; direct owner diagnostics used `vp exec pnpm -C
packages/cli`, not `vp -C packages/cli`. Node selection remains root-pinned 24.19.0.

| Command | Actual result |
| --- | --- |
| `vp node /tmp/opencode/task12-bootstrap-diagnostic.mjs` | Existing inventory helper: 498 → 1 → 0 diagnostics after exact-anchor/closure corrections. Diagnostic only, not a gate receipt. |
| `vp run verify:development` | First continuation attempt: exit 1, 304.337s, generated-overlap; retirement edge census and activation metadata failures. |
| `vp exec pnpm -C packages/cli run test:source -- packages/cli/test/cli/repositoryNativeRetirement.test.ts` | Diagnostic within failed source owner: 8/9 passed; exact twelve missing edges identified and then reconciled. |
| `AGENTERA_GENERATED_OVERLAP_ROOT=/tmp/opencode/task12-overlap-inventory vp run verify:development` | Exit 1, 306.153s. Parent owns/overrides this root and cleaned its private output; this did **not** retain logs or bypass ownership. Activation metadata and monolith failures remained. |
| `AGENTERA_GENERATED_OVERLAP_ROOT=/tmp/opencode/task12-overlap-owner vp exec pnpm -C packages/cli run verify:generated-overlap` | Owning failure diagnostic, exit 1. This direct supported owner retained `source.json`, `source.log`, `package.log` and private fixtures for diagnosis; no omitted later lanes ran. Full failure inventory exposed stale census/format/help/bootstrap expectations and the prime token overage. |
| `vp exec pnpm -C packages/cli run test:source -- packages/cli/test/runtime/retiredRuntimeSurfacePolicy.test.ts packages/cli/test/cli/primeBudget.test.ts` | Diagnostic: 202 passed, 6 failed; exact full error output used for correction. |
| `vp exec pnpm -C packages/cli run test:source -- packages/cli/test/runtime/retiredRuntimeSurfacePolicy.test.ts packages/cli/test/cli/primeBudget.test.ts packages/cli/test/cli/help.test.ts packages/cli/test/cli/activationConjunction.test.ts packages/cli/test/upgrade/oneCommandContract.test.ts packages/cli/test/validate/skillAppHomeGate.test.ts packages/cli/test/state/retrievalContractParity.test.ts packages/cli/test/state/planLifecycleContract.test.ts packages/cli/test/verification/laneOwnership.test.ts` | Diagnostic: 372 passed, 2 failed, one failed suite load; strict census constant and remaining help grammar corrected. |
| `vp run verify:development` | Exit 1, 304.742s; remaining durability grammar parity and expected census-error digest corrected. |
| `vp run verify:development` | Exit 1, 450.836s; source/package and compact/contract passed, then independent activation re-observation rejected the HOME-dependent startup record. |
| `vp run verify:development` | **Exit 0, all 11 gates PASS, 450.760s**, reconciled DAG and zero outstanding leases. |

No omitted lane was cherry-picked as qualification. The final owning command
executed broad source plus all required development gates:

| Gate | Result | Elapsed ms | Execution origin |
| --- | --- | ---: | --- |
| source | PASS | 302363 | generated-overlap |
| stress | PASS | 30586 | stress |
| performance (development resource profile) | PASS | 12762 | performance |
| capacity | PASS | 63926 | capacity |
| package | PASS | 355106 | generated-overlap |
| generated-overlap | PASS | 364758 | generated-overlap |
| typecheck | PASS | 703 | typecheck |
| build | PASS | 13643 | generated-overlap |
| compact | PASS | 1966 | compact |
| capability-contract | PASS | 347 | capability-contract |
| activation-conjunction | PASS | 9227 | activation-conjunction |

These overlap timings are not additive. The final record has 42 activation
checks, reconciled execution and zero leases. Development resource latency is
advisory; this is not full performance/historical certification or a release
receipt. No `vp run verify` was required or run.

### Final artifact binding and evidence reuse

The exact emitted gate record and identifiers are preserved in
`docs/qualification-2026-09-13-task12.json#latestEngineeringQualification`:

```text
generation          25c38fe46b609252ab502a718459987855ad3c15f4792d7353958b6e106f219b
tarball SHA-256     92250e80ffc12e1a91e07856eb83b2153a59a1de66e0ea93114f5aa64988ca90
package identity   f58e11c1412ce3d0a44e42df1f7ebf0faf5d7225d1df036d7f4da07740a252ea
activation digest  91d46c7745dfb0bbdb615be61ad240b1cf8986f88b11e7be0e4e182a43fa8541
```

The source, registry, schema and observer changes invalidated the old package
binding, so the complete package owner—including the eleven-part traversal—ran
again inside the final conjunction. Earlier detailed traversal counts remain
historical measurements; this record does not invent fresh per-partition counts
from the compact conjunction summary. The parent cleans its temporary private
build, child evidence and tarball paths. Their emitted hashes are durable here;
those paths are not advertised as retained release artifacts. This evidence-only
documentation was written afterward and does not change tested runtime semantics.

Codex, OpenCode and Copilot native recognition/retrieval evidence is reused, not
rerun: this continuation did not alter the host SKILL.md, capability instruction
modules, serving adapter, executable entry point, or selected instruction-detail
implementation. Their SKILL/instruction hashes remain the ones recorded above.
Fresh source/generated/extracted parity passes for the new package. The old
native receipts remain bound to the old tarball; this is explicit applicability
transfer for unchanged surfaces, **not** a claim that the entire new tarball is
byte-identical or that native/model execution was repeated. Help, inventory and
other changed surfaces are covered by the fresh owning checks.

Cursor still has the documented `Authentication required` result. Its absence
does not negate the engineering pass and the engineering pass does not satisfy
Cursor recognition. No credentials, inherited authentication, network model run
or live configuration was used. Qualification artifacts are ready for the next
authorized audit; task, health and plan state remain untouched and incomplete
pending the user's host-authentication decision.

Final read-only closeout checks passed: `git diff --check` and
`vp node /tmp/opencode/task12-final-evidence-check.mjs` (durable gate/identity
fields compared to the actual emitted conjunction; unchanged SKILL hash).
Pinned `vp --version` again reported standalone/local 0.3.0, pnpm 10.30.3 and
Node 24.19.0. No staging, commit, push, release action or lifecycle mutation.

## Cursor qualification — existing-authentication resume (PASS)

**Remaining Cursor host criterion: PASS. Engineering and four-host qualification
are audit-ready; task/plan lifecycle remains coordinator-owned.** The user
authorized use of existing Cursor authentication, not login, credential refresh,
account/config changes or live host-skill installation. Only this missing host
check was resumed. No broad verification, model generation, task execution or
other native host rerun was performed.

### Applicability before reuse

The retained eleven-gate development pass remains the actual **450.760s** run
above, not a new run. Its original qualified tarball
`92250e80ffc12e1a91e07856eb83b2153a59a1de66e0ea93114f5aa64988ca90`
was cleaned up by the owner. The governed package helper reconstructed a package
from current inputs for this smoke; its SHA-256 is
`32b2b5aa73ac272a254bbcb5145391fd425726bfb2bb15cef0a0e88adc7c9e15`.
These are **not** byte-identical tarballs. The new build-source identity includes
later qualification documentation and coordinator-owned task bookkeeping.

Before native execution, the filesystem inventory was compared to the retained
passing gate's completion timestamp: only the two qualification documents and
the coordinator-owned task entity were newer. No runtime, source, authority,
test or toolchain input changed. This corroborates the retained implementation
context for tasks 1–11 and the engineering correction; it is not presented as a
cryptographic proof of whole-checkout equivalence. The exact selected SKILL bytes
were compared between source and extracted host projection and against all prior
host evidence. Complete extracted Plan instructions were reassembled and checked
against the recorded instruction digest. The three prior host smokes therefore
remain applicable for their unchanged recognition/retrieval surfaces, keeping
their original artifact bindings. No old receipt is relabeled as a new-tarball run.

### Actual native evidence

The installed **Cursor Agent 2026.08.25-3e8eec8** ran as `/bin/cursor-agent acp`
inside the same disposable-home isolation pattern as the other host probes:
read-only system root, hidden live homes and temporary directories, cleared
environment, isolated HOME/XDG directories, read-only extracted package and
managed Node 24.19.0. The only additional live exposure was one existing Cursor
auth file, bound read-only at its native isolated auth-file location. No other
live Cursor config, skills, cache, sessions, keyring or credentials were exposed.
The harness never read, printed, hashed or copied credential contents. Auth file
inode, size, mode and modification time were unchanged after the check.

The first properly traced attempt kept networking disabled: `initialize`
succeeded, but `session/new` returned **-32603** before skill discovery. This was
not the former -32000 authentication-required outcome. The successful bounded
retry enabled network for native session initialization/discovery. No endpoint
override, fake authentication flag or synthetic server response was used.
Background native metadata traffic was not URL-audited; no absence-of-network
claim is made. No model prompt/generation or task/tool request was sent.

Only these two ACP requests were sent:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"agentera-qualification","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp/work/project","mcpServers":[]}}
```

Both returned success. Cursor then sent `session/update` with
`sessionUpdate: available_commands_update`: **21 commands**, including
`name: agentera` and the current skill description marked **(user skill)**.
Native `openat` tracing recorded **two successful opens** of exactly
`/tmp/work/home/.agents/skills/agentera/SKILL.md`. Its directory inventory was
exactly `["SKILL.md"]`; no Agentera companions or checkout were visible.
The trace contained paths/flags only, not read contents; it was reduced to the
exact skill-open count and removed. Native RPC/stderr stayed in memory; only
allowlisted discovery metadata was persisted. The successful run produced zero
stderr bytes. Session IDs, model/account metadata and raw payloads are not in
durable evidence.

The harness closed stdin after the discovery notification and terminated the
isolated process with SIGTERM. Native success is proved by successful RPCs and
the actual discovery notification/path opens, **not** a process exit-0 claim.
There were **zero login/authenticate requests, zero model prompts, zero tool
requests**, and no credential refresh write. Early local trace-wrapper setup
failures were corrected without touching Cursor/product behavior or auth; they
produced no successful session or qualification claim.

### Extracted CLI retrieval and command record

In that same isolated home/project, the harness—not a model—ran:

```bash
node /tmp/package/dist/bin/agentera.js prime --context plan --detail instructions --section instructions
```

Result: **exit 0, 25,589 UTF-8 bytes, 3/3 parts, zero omitted, complete true,
null next_command**. Concatenating all three parts matched:

```text
SKILL SHA-256        c283d3265563dd423e8768f5cc5461fa72bc3b9447388835414fcec1d337a33d
Instructions SHA-256 d833fbca180301f253558cab4e8a8f34bbfaae9f2490197016802c99846b029d
```

All commands used `PATH=/tmp/opencode/vp-commit-6dgl38ms:$PATH`:

| Command | Result |
| --- | --- |
| `vp --version` | Standalone/local 0.3.0; pnpm 10.30.3; root Node 24.19.0. |
| `vp exec pnpm -C packages/cli exec node /tmp/opencode/task12-cursor-package.mjs` | Governed `scripts/pack-package.mjs --output-dir DISPOSABLE_ROOT --json`, extraction and regular declared-dependency copies; exact source/extracted SKILL equality. No direct npm pack/publish or installation. |
| `vp node /tmp/opencode/task12-cursor-applicability.mjs` | No relevant implementation input newer than the passing gate; reconstructed instructions match all three recorded parts. |
| `vp node /tmp/opencode/task12-cursor-auth-smoke.mjs` | Network-disabled native attempt: initialization succeeded, session creation failed -32603. Not a host pass. |
| `vp node /tmp/opencode/task12-cursor-auth-smoke.mjs --network-discovery` | Actual native recognition plus extracted CLI retrieval PASS; bounded existing-auth exposure as above. |

The sandbox wrapper is the one documented earlier, with the single read-only
auth-file bind added and `--unshare-net` omitted only for the successful retry.
Tracing ran **inside** the sandbox as `strace -f -e trace=openat -s 256` around
the native executable. The local helper/evidence paths under `/tmp/opencode/`
are disposable conveniences, not credential stores or release receipts.
The sanitized transcript summary, command counts, artifact/source identity,
completeness and privacy limits are durable in
`docs/qualification-2026-09-13-task12.json#latestCursorQualification`.

No task/plan/health/progress mutation, staging, commit, push, publication, version
change or live-home configuration/skill write occurred. The missing criterion is
passed; targeted audit and lifecycle closeout remain with the coordinator. Stop.

Final checks passed: `vp node /tmp/opencode/task12-cursor-evidence-check.mjs`
compared durable proof to the sanitized actual native/retrieval observations,
confirmed all eleven engineering gate results remain preserved, and rejected
secret/account/session-value fields. `git diff --check` passed; final pinned
`vp --version` reported standalone/local 0.3.0, pnpm 10.30.3 and Node 24.19.0.

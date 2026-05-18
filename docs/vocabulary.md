# Agentera vocabulary

This document indexes the shared grammar Agentera uses across capability prose,
schemas, CLI output, tests, project artifacts, and human-facing docs. Use it
when writing Agentera docs, schemas, fixtures, command output, or capability
instructions.

Scope: common terms and recurring forms only. Capability-specific one-offs are
included when they shape cross-suite usage.

## Authority order

| Authority | Owns |
| --- | --- |
| `skills/agentera/protocol.yaml` | Confidence, severity, decision labels, exit signals, visual tokens, glyphs, and phases. |
| `skills/agentera/capability_schema_contract.yaml` | Capability schema structure, required groups, priorities, and primitive-reference fields. |
| `skills/agentera/schemas/artifacts/*.yaml` | Artifact field grammar, status values, path contracts, and validation rules. |
| `references/artifacts/artifact-registry-interface-model.yaml` | Artifact identity facts: `artifact_id`, display name, default path, producers, consumers, type, scope. |
| `references/cli/app-lifecycle-vocabulary.yaml` | App lifecycle canonical statuses, deprecated aliases, operation verbs, and consumer ownership boundaries. |
| `references/cli/bundle-skill-vocabulary.yaml` | Canonical concepts, compatibility boundaries, and classification rules for `bundle` and `SKILL.md` usage. |
| `references/cli/capability-instruction-contract.yaml` | Decision 57 capability instruction-file contract, future `instructions.md`, current `prose.md` compatibility, and `first_invocation_read` semantics. |
| `references/cli/routing-execution-vocabulary.yaml` | Canonical concepts, compatibility boundaries, and classification rules for routing, suggestions, delegation, worker spawning, runtime subagent mechanisms, and pre-spawn Git commits. |
| `skills/agentera/SKILL.md` | Agentera skill dispatcher, routing model, CLI-first state access, installed-app status checks, and safety rails. |
| `skills/agentera/capabilities/*/prose.md` | Capability behavior, workflow grammar, step markers, and cross-capability boundaries. |
| `scripts/agentera` and `scripts/agentera_upgrade.py` | CLI-visible command labels, upgrade output, and doctor diagnostics. |
| `README.md`, `UPGRADE.md`, `DESIGN.md`, `.agentera/*.yaml` | User-facing phrasing, design vocabulary, and current project-state examples. |

## Normalization rules

| Rule | Use | Avoid |
| --- | --- | --- |
| Internal workflows are capabilities. | `capability`, `twelve capabilities`, `capability prose`, `capability schemas` | Calling hej/realisera/etc. standalone skills, except in v1 history. |
| The runtime surface is a skill. | `Agentera skill`, `single installed Agentera app` | `twelve-skill suite` for v2 behavior. |
| `/agentera` is the main invocation. | `/agentera`, `$agentera` for Codex-specific docs | `/hej` except as a legacy bridge. |
| The CLI source and rendered dashboard are different. | `agentera hej` source data, `Hej dashboard` rendered briefing | Treating raw CLI labels as the user-facing dashboard. |
| Routine state uses flat commands. | `agentera plan`, `agentera docs`, `agentera health` | `agentera query plan` for routine state. |
| `query` is advanced access. | `agentera query --list-artifacts`, `agentera query <artifact>` | Calling it the normal state interface. |
| Canonical artifact names are identifiers. | `VISION.md` maps to `.agentera/vision.yaml` | Assuming display names are literal paths. |
| Exit signals are fixed. | `complete`, `flagged`, `stuck`, `waiting` | `blocked`, `partial`, `escalated` as exit signals. |
| Current-state language names the object. | `Agentera app files need repair`, `artifacts are current`, `plan-level current-state check` | Bare `freshness` in new docs. |
| App lifecycle state is canonical metadata. | `up_to_date`, `outdated`, `repair_needed`, `migration_needed`, `manual_review_needed`, `ready_to_apply`, `applied`, `no_changes_needed` | `fresh`, `stale`, `refresh`, `fixed`, `ready`, or `noop` as app lifecycle status values. |
| Worker safety commits are Git-only. | `pre-spawn Git commit` | Non-Git `checkpoint` or `pre-dispatch commit gate` in new docs. |
| Capability instruction files have a future contract and a current compatibility state. | Future rule: `instructions.md` plus `first_invocation_read`; current state: `prose.md` remains supported until the later rename and validator work. | Claiming `instructions.md` is already required, or adding `first_invocation_read` to docs as current CLI output. |

## Plain-language rule

Brand the worldview. Boring-name the work.

Use Agentera-specific terms when they name a protocol concept, preserve
schema-aligned precision, or teach the product worldview. Prefer plain software
terms for user-facing operations, diagnostics, setup, migration, and errors.

When both are useful, lead with the plain phrase and introduce the Agentera term
second:

| Use | Avoid |
| --- | --- |
| `final state sync, the plan-level freshness checkpoint` | Bare `freshness checkpoint` |
| `Agentera app files need repair` | `bundle freshness gap` in user-facing diagnostics |
| `v1 migration check` | Bare `upgrade guard` in onboarding or recovery text |
| `checkpoint commit` | Bare `checkpoint` |

Diagnostics should state object, state, cause, and fix. Do not make users decode
brand language before they can act.

| Layer | Vocabulary rule |
| --- | --- |
| Product identity | Branded, memorable, and opinionated. |
| Protocol internals | Precise, canonical, and schema-aligned. |
| User operations | Plain, traditional, and searchable. |
| Diagnostics and errors | Object, state, cause, fix. |
| Onboarding | Plain phrase first, Agentera term second. |

## Product grammar

| Term | Definition | Common sources |
| --- | --- | --- |
| Agentera | The open protocol for turning AI agents into engineering teams through shared project state, roles, decisions, and verification. | `README.md`, `.agentera/vision.yaml`, `skills/agentera/SKILL.md` |
| Agentera v2 | The current architecture: one Agentera skill, one `/agentera` entry point, twelve capabilities, YAML project state, and CLI-first access. | `README.md`, `UPGRADE.md`, `.agentera/decisions.yaml` |
| Agentera skill | The runtime-loaded Agentera skill at `skills/agentera/`. It contains the dispatcher and twelve capabilities. | `skills/agentera/SKILL.md` |
| Capability | A routed behavioral unit inside the Agentera skill, with `prose.md` plus `triggers.yaml`, `artifacts.yaml`, `validation.yaml`, and `exit.yaml`. | `AGENTS.md`, `skills/agentera/capabilities/*` |
| Shared protocol | The primitive vocabulary in `protocol.yaml`: confidence, severity, decision labels, exits, visual tokens, glyphs, and phases. | `skills/agentera/protocol.yaml` |
| Capability schema contract | The executable contract for capability schema groups, stable IDs, priorities, deprecations, and primitive references. | `skills/agentera/capability_schema_contract.yaml` |
| Project state | Structured files that preserve intent, decisions, plans, progress, health, docs, design, and session continuity. | `README.md`, `.agentera/docs.yaml` |
| Project history | Durable history kept in files so future agents do not reconstruct history from chat residue. | `README.md`, `.agentera/progress.yaml` |
| Saved project context | Project artifacts plus global profile data that let future sessions reuse context and preferences. | `README.md`, `profilera` prose |
| Sharp colleague | Agentera's voice: direct, opinionated, evidence-backed, warm enough to collaborate, and willing to push back. | `.agentera/vision.yaml`, `DESIGN.md`, capability prose |
| Docs-first workflow | Document intended behavior before tests and code; docs define intent, tests enforce it, code implements it. | `dokumentera`, `planera`, `realisera` prose |

## Capability grammar

| Glyph | Capability | Role |
| --- | --- | --- |
| `⌂` | hej | Orientation, routing, dashboard briefing, and next best action. |
| `⛥` | visionera | Project direction, north star, principles, identity, and strategic tensions. |
| `❈` | resonera | Structured deliberation, tradeoff pressure, and decision thinking. |
| `⬚` | inspirera | External pattern analysis and useful cross-pollination. |
| `≡` | planera | Planning with behavioral acceptance criteria; owns WHAT and WHY. |
| `⧉` | realisera | Verified autonomous development cycle; owns HOW. |
| `⎘` | optimera | Metric-driven optimization through one experiment per invocation. |
| `⛶` | inspektera | Codebase health audit, architecture review, and artifact current-state review. |
| `▤` | dokumentera | Documentation layer; owns docs-first workflow guidance. |
| `♾` | profilera | Reusable decision profile and preference extraction. |
| `◰` | visualisera | Visual identity, design tokens, and design-system language. |
| `⎈` | orkestrera | Multi-cycle orchestration; dispatches work and evaluates completion. |

Capability names use Swedish-style `-era` verb forms. The name is the action:
`planera` plans, `realisera` realizes, `optimera` optimizes.

### Capability instruction contract

The machine-readable authority is
`references/cli/capability-instruction-contract.yaml`; it owns Decision 57's
instruction-file boundary, including the future canonical `instructions.md` file,
current `prose.md` compatibility, future `first_invocation_read` values, full-read
obligations, compact-startup exceptions, and unsupported implementation states.

Use this prose as guidance only: the future default is that initial capability
invocation reads `instructions.md` in full unless an explicit compact-startup
exception is declared. Today, capability files are still `prose.md`, validators
still require `prose.md`, runtime descriptors may still point at `prose.md`, and
`agentera hej --format json --capability-context <name>` does not emit
`first_invocation_read` metadata.

Do not replace this with a parallel Markdown table of read modes or migration
surfaces. Update the YAML authority first, then keep this section as the short
human-facing boundary. The file rename, CLI/schema metadata feature,
first-invocation read behavior, descriptor rewrite, and validation/regression
sweep remain separate follow-up work.

## Invocation and routing grammar

| Term | Definition |
| --- | --- |
| CLI-first state access | Read project state through `agentera` top-level commands before raw artifact reads. |
| Top-level state commands | `hej`, `plan`, `progress`, `health`, `todo`, `decisions`, `docs`, `objective`, and `experiments`. |
| Artifact-backed briefing | Any briefing or routing decision backed by Agentera project artifacts. It must use CLI-first state access. |
| Bare `/agentera` | Invocation without a specific request. It delegates to `hej` and renders the Hej dashboard from one composite source command. |
| Hej dashboard | User-facing project briefing with logo, status, attention, next action, and `⌂ hej · <status>`. |
| `agentera hej` | Compact CLI source data for the caller-rendered dashboard. It is not the dashboard itself. |
| Direct route | A canonical capability name with optional following topic text, `/agentera <capability-name>` with optional topic text, or `/agentera <primary-alias>` routes directly to that capability and bypasses natural-language matching. |
| Canonical capability route | A Swedish capability name such as `resonera`, `planera`, or `orkestrera`, optionally followed by topic text, plus the slash form `/agentera <capability-name>` with optional topic text. Canonical names remain protocol identity. |
| Primary route alias | The one plain `/agentera <alias>` direct route for a capability, owned by `ROUTE_ALIASES.primary_aliases`. Each canonical capability has exactly one primary alias. |
| Secondary request wording | Natural-language phrases in capability trigger schemas, such as `deliberate`, `brainstorm`, `rubber duck`, `brief`, and `what's next`. They route through trigger matching and are not primary aliases. |
| Natural-language trigger | A phrase in `schemas/triggers.yaml` that maps a request to a capability. |
| Trigger priority | `high`, `medium`, or `low`; owned by the schema contract. |
| High-confidence match | A natural-language request with enough trigger evidence to route without asking. |
| Borderline match | A request with competing plausible routes. Agentera asks for disambiguation. |
| Fallback to hej | No sufficient match routes to hej for orientation. |
| Concrete next action | A route suggestion tied to an object such as `PLAN Task N`, `TODO`, `OBJECTIVE`, or `VISION refresh`. |
| Suggest, don't force | Hej recommends the next capability but waits for user confirmation. |
| Capability handoff label | A recommendation from one capability to another. Use glyph plus canonical name, such as `⧉ realisera` or `≡ planera`, not standalone slash-capability names. SG priority codes are internal protocol references and are not user-facing handoff labels. |
| Explicit route documentation | User-facing examples that teach the actual entry route. Use `/agentera <alias>` such as `/agentera build`; do not present aliases as CLI commands. |
| Runtime question tool | Host-native bounded-choice prompt. Current examples: Claude Code `AskUserQuestion`, Copilot `ask_user`, Codex `request_user_input`, and OpenCode `question`. These are guidance examples, not schema authority. |
| Question-tool gating | Use a native question tool only for at least two meaningful non-terminal next actions or consequential Proceed/Cancel; `Done` and custom/free-form answers do not count as alternatives. Initial Agentera/hej briefs stay free-form unless bounded choices were requested or the suggested next step is a state-changing Proceed/Cancel handoff. A single non-mutating suggested handoff may use a free-form prompt, but a single state-changing handoff uses native Proceed/Cancel confirmation. State-changing means the proposed next step may write artifacts, edit code, run optimization or orchestration cycles, apply migrations, refresh app/runtime state, or otherwise mutate project/runtime state. Apply the behavior rule first, with examples such as ⧉ realisera, ≡ planera when creating or updating plans, ▤ dokumentera when writing docs, ⎘ optimera when running or applying optimization cycles, and ⎈ orkestrera when dispatching cycles. This dispatcher rule governs hej and capability handoff prompts; invoked capability prose can impose stricter question-tool requirements. |
| Handoff confirmation | Clear free-form acceptance of the named single suggestion confirms invocation. Selecting a downstream capability option in a bounded prompt also confirms invocation; selecting `Done` stops without routing. Ambiguous replies get one clarifying question. |
| Route | Direct user invocation by canonical capability name, primary alias, or slash route. A route is already consent to invoke the capability and does not need an extra handoff confirmation. |
| Suggest | Recommend a downstream capability and wait for confirmation. |
| Delegate | Orkestrera assigns approved plan work to a worker capability during an explicitly orchestrated flow. |
| Spawn | Realisera or Optimera launches an isolated runtime worker through the host subagent mechanism. |
| Subagent mechanism | Runtime support for worker execution through Claude Code, OpenCode, Codex CLI, Copilot CLI, or another host-native worker surface. |
| Legacy bridge | Temporary v1 entry points, especially `/hej`, that guide users to `/agentera` and the v2 upgrade path. |

CLI-visible `agentera hej` labels are source labels. Preserve them in CLI tests
and parsing code, but transform them before presenting a user dashboard:
`mode:`, `profile:`, `health:`, `issues:`, `plan:`, `objective:`,
`attention:`, `next_action:`, and `source_contract:`.

Primary route aliases are slash-route vocabulary, not CLI command vocabulary:

| Canonical capability | Primary route alias |
| --- | --- |
| `hej` | `/agentera status` |
| `visionera` | `/agentera vision` |
| `resonera` | `/agentera discuss` |
| `inspirera` | `/agentera research` |
| `planera` | `/agentera plan` |
| `realisera` | `/agentera build` |
| `optimera` | `/agentera optimize` |
| `inspektera` | `/agentera audit` |
| `dokumentera` | `/agentera document` |
| `profilera` | `/agentera profile` |
| `visualisera` | `/agentera design` |
| `orkestrera` | `/agentera orchestrate` |

Do not teach primary aliases as CLI state commands. The CLI state surface
remains `hej`, `plan`, `progress`, `health`, `todo`, `decisions`, `docs`,
`objective`, `experiments`, and advanced `query`.

When capability prose recommends another capability, use the handoff label
grammar (`<glyph> <capability>`). Keep slash forms only when documenting the
entry route (`/agentera <alias>`) or preserving clearly historical evidence.

### Routing and execution vocabulary

The machine-readable authority is
`references/cli/routing-execution-vocabulary.yaml`; it owns classification of
routing and execution terms into canonical concepts, compatibility identifiers,
code identifiers, historical records, fixtures, path-like references, generic
plain language, and ambiguous current prose.

Use this prose as guidance only: request-to-capability routing uses `Agentera router`
or routing language, next-action recommendations `suggest`, Orkestrera
task assignment `delegate`, Realisera/Optimera worker launch `spawn`, runtime
support `subagent mechanism`, and worker safety `pre-spawn Git commit`.
Preserve shipped identifiers and concrete code/path evidence such as
`subagent_dispatch`, historical `pre-dispatch commit` records, fixture names,
and archived plans unless an explicit compatibility migration is in scope.

Do not replace this with a parallel Markdown table of preferred and forbidden
terms. Update the YAML authority first, then keep this section as the short
human-facing boundary. The broader current-prose replacement and repository-wide
ambiguous-term sweep remain separate follow-up work.

## Artifact grammar

| Term | Definition |
| --- | --- |
| Artifact | A project or agent state file owned by one or more capabilities. |
| Human-facing artifact | A root-level Markdown artifact intended for people, such as `TODO.md`, `CHANGELOG.md`, or `DESIGN.md`. |
| Agent-facing artifact | A structured YAML artifact under `.agentera/`, such as `.agentera/progress.yaml`. |
| Global artifact | A user-level artifact outside a project, such as `PROFILE.md` or `USAGE.md`. |
| Canonical artifact name | Display identifier such as `VISION.md`, `PROGRESS.md`, or `DOCS.md`; not always a literal path. |
| Resolved artifact path | The actual path after consulting `.agentera/docs.yaml` mapping or the default layout. |
| Artifact mapping | `.agentera/docs.yaml` rows that map canonical names to project-local paths and producers. |
| ArtifactRegistry | The registry interface model for artifact IDs, display names, default paths, producers, consumers, type, scope, and special cases. |
| `artifact_id` | Machine identifier such as `progress`, `health`, `docs`, or `objective`. |
| `display_name` | Human-readable canonical name, usually the v1-style Markdown name. |
| `default_path` | Registry-owned path used when no docs mapping overrides it. |
| `local_role` | Capability relationship to an artifact: `produces`, `consumes`, or `produces_and_consumes`. |
| Docs override boundary | `docs.yaml` may override paths for known display names; it must not redefine canonical identity facts. |
| Objective state | Optimera state under `.agentera/optimera/<objective-name>/`, including `objective.yaml`, `experiments.yaml`, and harness files. |

Canonical artifact IDs include `vision`, `decisions`, `plan`, `progress`,
`todo`, `health`, `docs`, `design`, `profile`, `objective`, `experiments`,
`changelog`, `session`, `plan_archive`, `optimera_harness`, and
`semantic_fixture`.

## Status, severity, confidence, and exits

### Exit signals

| Signal | Meaning | Use |
| --- | --- | --- |
| `complete` | The workflow finished successfully. | Normal completion. |
| `flagged` | Work completed with caveats the user should know. | List each concern. |
| `stuck` | The capability cannot proceed. | State blocker and attempted work. |
| `waiting` | Required information is missing. | State exactly what is needed. |

Exit marker grammar is `<glyph> <capability> · <status>`, for example
`▤ dokumentera · complete`. For `flagged`, `stuck`, and `waiting`, add `▸`
details.

### Finding severity

| Value | Meaning |
| --- | --- |
| `critical` | Broken functionality, security issue, or data-loss risk. |
| `warning` | Works but poorly, confusingly, or in a fragile way. |
| `info` | Minor, cosmetic, or low-impact improvement. |

### Issue severity

| Value | Glyph | Meaning |
| --- | --- | --- |
| `critical` | `⇶` | Blocks progress or breaks functionality. |
| `degraded` | `⇉` | Works, but poorly, slowly, or fragily. |
| `normal` | `→` | Standard work. |
| `annoying` | `⇢` | Cosmetic or minor friction. |

### Confidence language

| Value | Meaning |
| --- | --- |
| `firm` | User is committed. Treat as a hard constraint. |
| `provisional` | Best current answer. Treat as a strong default. |
| `exploratory` | Direction to try. Treat as a suggestion. |

Numeric confidence is `0-100`: `90-100` verified, `70-89` strong,
`50-69` moderate, `30-49` weak, and `0-29` speculative.

### Phase language

| Phase | Primary capabilities | Meaning |
| --- | --- | --- |
| `envision` | visionera | Define north star and direction. |
| `deliberate` | resonera | Think through tradeoffs and decisions. |
| `plan` | planera | Break intent into scoped work. |
| `build` | realisera, optimera, dokumentera, visualisera | Produce code, docs, designs, or measured improvements. |
| `audit` | inspektera | Evaluate health, risks, and state alignment. |

Use `phase` for protocol-level lifecycle state. Use `step` for capability-local
progress markers such as `── step 2/6: verify`.

## Decision 44 replacement boundary

This section is the source of truth for Decision 44 wording changes. Later tasks
must use it before editing docs, capability prose, diagnostics, tests, labels,
or active state.

Stable identifiers, enums, persisted state shapes, routing semantics, CLI exit
behavior, canonical Swedish capability names, and Decision 43 aliases are
protected compatibility surfaces. Do not rename them unless a later decision
records the migration rationale, validation path, and compatibility impact.

### Replacement terms

| Deprecated preferred wording | Preferred wording | Rationale |
| --- | --- | --- |
| `freshness` as a general protocol label | `current`, `up to date`, `out of date`, `synced`, `status`, `needs sync` | Plain state words are clearer and avoid turning several conditions into one branded abstraction. |
| `freshness checkpoint`, `plan-level freshness checkpoint` | `final state sync`, `plan-level current-state check` | Plan closure updates durable state; it is not a Git checkpoint or a special freshness concept. |
| Non-Git `checkpoint` | `state sync`, `current-state check`, `milestone`, or the specific action | `checkpoint` remains Git-only so commit synchronization is unambiguous. |
| Most `guard` wording | `check`, `status check`, `stop condition`, `safety rule`, or `pre-routing check` | The replacement says what happens instead of using security-flavored jargon. |
| `Reality Verification Gate` | `behavioral verification gate` | Keep `gate` only for hard pass/fail verification boundaries, and name the behavior being verified. |
| `Conductor protocol` | `orchestration loop` | The loop is select, dispatch, evaluate, resolve, and log; the plain phrase explains the action. |
| `memory layer` | `saved project context` | Agentera persists context in project files and profile data, not model memory. |
| `operating record` | `saved project context`, `project history`, or `progress log` | The replacement states the artifact role directly. |
| Prose/label `drift` | `mismatch`, `out of sync`, or the concrete mismatch type | `drift` is vague in user-facing vocabulary; mismatch wording states the observable problem. |
| `DTC`, `DTC-first` | `docs-first workflow`, `document intended behavior before tests and code` | Keep the working principle while removing acronym friction. |

### Allowed uses

| Term | Allowed use | Rationale |
| --- | --- | --- |
| `checkpoint` | Git commits only, such as `checkpoint commit` or `pre-dispatch checkpoint commit`. | Git users understand checkpoint as commit synchronization; non-Git lifecycle use is deprecated. |
| `gate` | Hard pass/fail boundaries, especially `behavioral verification gate` or regression pass/fail decisions. | Gate remains useful when a failed check must stop the workflow. |
| `guard` | Existing code identifiers, historical text, or conventional phrases where changing the word would imply behavior or API migration. Prefer replacement wording in current prose. | Compatibility and searchability can outweigh prose cleanup in stable surfaces. |
| `drift` | Historical entries, test fixture names, version-drift/package-drift diagnostics, and deliberate compatibility labels where `drift` is already a stable concept. Prefer `mismatch` or `out of sync` for new user-facing prose. | Some existing diagnostics and tests use drift as a compatibility signal. |
| `fresh`, `stale`, `fresh project` | Plain English state descriptions when they are natural user wording, especially `fresh project` versus returning project. Prefer `out of date` or `needs repair` for recovery prompts. | Decision 44 deprecates `freshness` as protocol jargon, not ordinary adjectives. |

### Protected compatibility

| Surface | Boundary | Rationale |
| --- | --- | --- |
| Schema fields and artifact shapes | Preserve field names, enum values, YAML structures, and validation semantics. | Persisted state and validators depend on stable shapes. |
| Stable IDs | Preserve capability IDs, artifact IDs, group IDs, route IDs, and test fixture IDs unless a migration is planned. | IDs are integration contracts, not prose. |
| CLI labels and exit behavior | Preserve current command names, parseable labels, exit codes, and source-contract labels unless an explicit CLI migration is recorded. | Shell users and tests consume these labels. |
| Canonical capability names | Preserve `hej`, `visionera`, `resonera`, `inspirera`, `planera`, `realisera`, `optimera`, `inspektera`, `dokumentera`, `profilera`, `visualisera`, and `orkestrera`. | Decision 43 kept Swedish names as protocol identity. |
| Decision 43 aliases | Preserve `/agentera status`, `vision`, `discuss`, `research`, `plan`, `build`, `optimize`, `audit`, `document`, `profile`, `design`, and `orchestrate`. | Alias routing is shipped 2.2.0 behavior. |
| Historical artifacts | Do not rewrite old progress, changelog, archived plans, or decisions solely for vocabulary cleanup. | History should remain accurate; current surfaces can explain old terms when needed. |
| Release version | Keep Decision 44 under pending 2.2.0; do not create a later version for this cleanup without policy-driven rationale. | The vocabulary cleanup belongs to the same release as Decision 43 aliases. |

## Workflow grammar

| Form | Meaning | Example |
| --- | --- | --- |
| `Each invocation = one ...` | Capability scope limit. | `Each invocation = one experiment.` |
| `─── <glyph> <capability> · <context> ───` | Capability introduction marker. | `─── ⎘ optimera · measure ───` |
| `── step N/M: verb` | Capability-local progress marker. | `── step 4/8: implement` |
| `## Safety rails` plus `<critical>` | Non-negotiable constraints. | `NEVER push to remote repos without explicit instruction.` |
| `Detect mode/context/level` | Step 0 classification before the main workflow. | Dokumentera detects create, update, audit, or first-run survey. |
| Decision gate | Explicit condition-based branch before proceeding. | Optimera keep/discard decision. |
| Exit-early stop condition | Stop condition when work is already complete or unnecessary. | Docs current, no stale work found. |
| Behavioral verification gate | Realisera check that behavior was verified against real project state. | Tests, builds, or manual verification. |
| Pre-write self-audit | Prose check for verbosity mismatch, abstraction creep, and filler accumulation. | `agentera lint --artifact <ARTIFACT>` exposes the checks through the CLI. |
| Plan-completion sweep | Realisera cleanup when plan tasks finish. | Progress rollup, changelog, TODO, health cross-reference, archive. |
| Worker spawn | Isolated implementation or measurement by a worker through the host subagent mechanism. | Realisera and optimera can use it. |
| Stale-base awareness | Prevent workers from branching from old `origin/main` or stale HEAD. | Use pre-spawn Git commits before spawning workers. |
| Orchestration loop | Orkestrera loop: select, delegate, evaluate, resolve, log. | Orkestrera delegates; it does not implement. |
| Evidence audit | Check that recorded verification actually proves acceptance criteria. | Orkestrera and inspektera use this language. |
| Loop stop condition | Stop repeated failed cycles, tasks, or experiments. | Prevents endless retries. |

For user-facing operations, prefer plain aliases when the branded phrase does
not add precision:

| Internal or branded phrase | User-facing phrase |
| --- | --- |
| Reality Verification Gate | behavioral verification gate |
| Conductor protocol | orchestration loop |
| Evidence audit | verification review |
| Memory layer | saved project context |

### Artifact-writing checks

| Term | Definition |
| --- | --- |
| Verbosity mismatch | Artifact prose exceeds the intended budget or grows without adding signal. |
| Abstraction creep | Prose lacks a concrete anchor such as a path, line number, metric, identifier, commit, or quote. |
| Filler accumulation | Prose accumulates hedges, redundant transitions, self-reference, summary preambles, or generic justification. |
| Concrete anchor | A file path, line number, commit hash, metric value, identifier, or direct quote. |
| Lead-with-conclusion | Start with the actionable conclusion, then provide evidence. |
| Compaction | Keep recent full entries, preserve older one-line archives, and drop beyond retention limits. |

## Capability-specific recurring vocabulary

| Capability | Common terms |
| --- | --- |
| hej | Orientation, dashboard, returning project, fresh project, attention, next action, concrete object, route suggestion. |
| visionera | North star, persona, principles, direction, identity, tensions, create/refine/replace/audit modes. |
| resonera | Socratic questioning, one question at a time, honest friction, steelman, tradeoffs, decision pressure. |
| inspirera | Source analysis, pattern extraction, cross-pollination, worth stealing, external practice, adaptation. |
| planera | WHAT and WHY, behavioral acceptance criteria, scope, included/excluded/deferred, task dependencies, plan-level current-state check. |
| realisera | Cycle, orient/select/research/plan/spawn/verify/commit/audit/log, HOW, progress log, worker spawn. |
| optimera | Objective, experiment, baseline, harness, locked measurement, hypothesis, metric, regression, keep/discard gate. |
| inspektera | Audit, health grade, dimensions, findings, evidence, impact, suggested action, artifact current-state review, deliberate decisions. |
| dokumentera | Intent-first docs, explore-and-generate, update-and-verify, first-run survey, evergreen docs, docs become the spec. |
| profilera | Decision profile, signal extraction, confidence, preference, validation, reusable user model. |
| visualisera | Visual identity, design tokens, semantic weight, terminal-native, glyphs, logo scarcity. |
| orkestrera | Plan execution, delegate, task-notification result, presence check, evaluate, resolve, loop stop condition. |

## Runtime, install, and release grammar

| Term | Definition |
| --- | --- |
| Agentera directory | Plain-language name for the local directory named by `AGENTERA_HOME`; user data stays at this directory root. |
| App files directory | Plain-language name for `$AGENTERA_HOME/app`, where Agentera's scripts and skill files live. Internal JSON may call this `managedAppRoot`; do not use that phrase in prompts. |
| User data directory | The `AGENTERA_HOME` root that keeps `PROFILE.md`, `USAGE.md`, history, and intermediate corpus data. |
| `AGENTERA_HOME` | Environment variable pointing at the Agentera directory. Explain this only when the user needs the exact setting. |
| Normal Agentera directory | Platform data directory for Agentera when `AGENTERA_HOME` is unset. |
| `--install-root` | Compatibility flag name for existing CLI options; surrounding text should say Agentera directory. |
| Directory with unknown files | A directory Agentera must not overwrite silently. Say this instead of unmanaged root. |
| Missing normal directory | Previewable. Agentera can show a no-write repair preview. |
| Missing chosen directory | Needs a user decision when provided through `AGENTERA_HOME` or explicit `--install-root`. |
| Package refresh | Package-manager or marketplace update. It does not prove Agentera's app files are current. |
| App repair | Normal repair flow that previews or applies Agentera app files plus managed runtime config, plugins, hooks, commands, and safe cleanup together. It must not edit shell startup files, and package-manager commands remain opt-in through `--update-packages`. |
| `--only bundle` | Compatibility selector for narrow app-file work. Do not present it as the normal repair recommendation when managed runtime surfaces may also need repair. |
| Preview | No-write mode. Required before upgrade or app repair writes; the underlying command flag is `--dry-run`. |
| `--yes` | Explicit apply flag after preview and approval. |
| Final check | Setup validation after upgrade apply. Internal code may still call this postflight doctor. |
| Package-update opt-in | External package manager changes require `--update-packages`. |
| Runtime adapter | Runtime-specific Agentera adapter support for skill loading, hooks, artifact validation, lifecycle metadata, and diagnostics. |
| Host support | What a runtime can theoretically do. Distinguish it from shipped Agentera behavior. |
| Hook lifecycle | Runtime callbacks such as `SessionStart`, `Stop`, `PreToolUse`, and `PostToolUse`. |
| Setup doctor | Diagnostic command surface for install/runtime health. |

Canonical runtime names are Claude Code, OpenCode, Copilot CLI, and Codex CLI.

### App lifecycle status vocabulary

Decision 54 makes app lifecycle state a protocol surface, not ad hoc output
copy. The machine-readable authority is
`references/cli/app-lifecycle-vocabulary.yaml`; it owns the canonical status
order, status definitions, deprecated aliases, scoped operation verbs, and
consumer ownership boundaries for doctor, hej, upgrade, docs, and tests.

Use this prose as guidance only: human-readable text can be friendlier, but it
should be derived from canonical metadata instead of inventing parallel status
words. `agentera upgrade` remains the umbrella command name. Its structured
output and plain text should still name concrete operations such as repair app
files, update app files, migrate Agentera data, or report no changes needed.
Compatibility aliases are transitional classifications in the YAML authority,
not second source-of-truth status values.

Recovery prompts must be recommendation-first and plain-language. Avoid asking a
user to choose between technical labels. Say: what happened, what the preview did
or did not change, what the recommended fix will do, and what it will not touch.
Do not expose internal directory-state labels, command-mode flags, or app-file
packaging terms in choices. Use: Agentera directory, app files, normal directory,
old directory, preview, repair, needs repair, needs a decision.

CLI-visible doctor labels to preserve: `Agentera doctor`,
`status:`, `expected version:`, `app home:`, `app home source:`,
`root status:`, `marker version:`, `missing commands:`, `dry run:`,
`apply after approval:`, `approval phrase:`, `retry:`, and `recovery:`.

CLI-visible upgrade labels to preserve: `Agentera upgrade`, `mode:`,
`status:`, `project:`, `app home:`, `managed app root:`, `user data root:`, phase lines, item lines,
`run with --yes to apply pending changes`, and `postflight doctor:`.

### Bundle and SKILL.md vocabulary

The machine-readable authority is
`references/cli/bundle-skill-vocabulary.yaml`; it owns classification of
`bundle` and `SKILL.md` usage into canonical concepts, compatibility
identifiers, package metadata, historical records, fixtures, path-like
references, generic plain language, and ambiguous current prose.

Use this prose as guidance only: current conceptual docs should say the object
they mean, such as Agentera app files, suite package, plugin-shipped hooks,
removed `bundle-status` command, Agentera skill dispatcher, skill entry file,
v1 skill entry file, or legacy hej bridge. Preserve shipped identifiers and
literal paths such as `.agentera-bundle.json`, `bundle.status`,
`activeBundleRoot`, `--only bundle`, and `skills/agentera/SKILL.md` unless an
explicit compatibility migration is in scope.

Do not replace this with a parallel Markdown table of allowed and forbidden
terms. Update the YAML authority first, then keep this section as the short
human-facing boundary.

## Evaluation and evidence grammar

| Term | Definition |
| --- | --- |
| Validation passed | Evidence that required checks completed successfully. Name the checks. |
| Focused tests | Targeted tests for the changed surface. |
| Full pytest | Repository-wide pytest run. Use exact counts when recorded. |
| Capability validator | `uv run scripts/validate_capability.py skills/agentera/capabilities/<name>`. |
| Cross-capability validation | Checks that capability schemas agree with registry, protocol, routing, and exit contracts. |
| Smoke eval | Runtime/setup check for crashes, non-zero exits, or obvious host failures. |
| Live-host smoke | Explicit opt-in model-host check against real runtime access. |
| Semantic eval | Offline fixture evaluation that checks whether captured output means the right thing. |
| Semantic fixture | Markdown fixture with prompt, seeded project state, captured output, tool trace, and expected facts. |
| Startup-overhead analysis | Local-only Decision 51 measurement surface for raw Agentera artifact access after CLI state calls during capability startup/state gathering. It replaced an uncommitted route/intro startup-window draft that found zero qualifying windows, and must report the retained `CLI state -> raw artifact access` metric before recommending a startup envelope or guidance fix. |
| Startup report | Human-readable and structured report pair that includes boundary source, runtime coverage, startup metrics, threshold rationale, recommendation, and privacy caveats without raw transcript text or raw local paths. |
| Seeded project state | Fixture-provided artifacts used as the source of truth for expected behavior. |
| Oracle | Artifact-derived expectation, such as the exact plan task hej should route to. |
| Regression | Required safety check for behavior that must not degrade. |
| Harness | Optimera measurement substrate. Once approved, it is immutable ground truth. |
| Objective | Measurable optimization charter under `.agentera/optimera/<name>/`. |
| Experiment | One falsifiable optimization attempt with hypothesis, method, metric, regression, status, and conclusion. |
| Keep/discard gate | Keep only if the metric improves and regression gates pass; discard otherwise. |

## Visual grammar

| Token family | Values |
| --- | --- |
| Status tokens | `■` complete, `▣` in progress, `□` open, `▨` blocked. |
| Severity tokens | `⇶` critical, `⇉` degraded, `→` normal, `⇢` annoying. |
| Confidence tokens | `━` firm, `─` provisional, `┄` exploratory. |
| Trend tokens | `⮉` improving, `⮋` degrading. |
| Structural tokens | `───` section divider, `▸` list item, `·` separator, `→` flow, `█▓░` progress bar. |
| Logo | Box-drawing Agentera logo. Use for the Hej dashboard, major completions, and significant artifacts. |

Visualisera owns visual identity in `DESIGN.md`. Protocol owns token meanings in
`skills/agentera/protocol.yaml`.

## Canonical phrases

| Phrase | Use |
| --- | --- |
| “The open protocol for turning AI agents into engineering teams.” | Product identity. |
| “One install, one entry point, one query interface to all project state.” | v2 app-home promise. |
| “Continuity lives in files, not memory.” | Realisera/project-state principle. |
| “The conversation preserves reasoning; the artifact preserves the plan.” | Planera boundary. |
| “Planera owns WHAT and WHY; realisera owns HOW.” | Planning/building boundary. |
| “The colleague says what they think, then shows the evidence.” | Inspektera voice. |
| “Findings contradicting deliberate decisions are not findings.” | Audit boundary. |
| “Select the concrete next action before selecting the skill.” | Hej routing discipline. |
| “A skill name without a concrete object is not a valid suggestion.” | Hej next-action rule. |
| “Suggest, don’t force.” | Hej confirmation rule. |
| “Document intended behavior before building.” | Dokumentera intent-first mode. |
| “Write as intended steady state.” | Evergreen documentation rule. |
| “Keep it DRY: reference, don’t repeat.” | Documentation maintenance rule. |
| “The harness is the immutable ground truth.” | Optimera measurement rule. |
| “Improve + pass regression = keep; everything else is discarded.” | Optimera experiment rule. |
| “The conductor dispatches; it does not implement.” | Orkestrera role boundary. |

## Ambiguous terms to qualify

Do not use these terms bare. A busy developer should be able to search the
phrase, identify the affected object, and know whether the term describes a
schema concept, runtime capability, install state, or user action.

| Ambiguous term | Why bare usage is risky | Required wording |
| --- | --- | --- |
| Skill | Confuses v1 standalone skills, the v2 Agentera skill, and internal workflows. | Use `Agentera skill` for the installed runtime surface, `v1 skill` for history, and `capability` for v2 workflows. |
| Contract | Could mean schema structure, artifact shape, protocol primitive, adapter behavior, or product promise. | Use `schema contract`, `artifact schema`, `protocol primitives`, `runtime adapter contract`, or `product promise`. |
| Status | Different surfaces use different state machines and output labels. | Use `exit status`, `task status`, `installed-app status`, `install status`, `docs status`, or `health status`. |
| Freshness | Sounds like a branded synonym for several normal states: current, stale, synced, or out of date. | Use object-specific state wording such as `artifact is current`, `Agentera app files need repair`, `docs are current`, or `plan-level current-state check`. |
| Checkpoint | In software, can mean commit, savepoint, restore point, model checkpoint, or milestone. | Use `final state sync`, `plan-level current-state check`, `checkpoint commit`, or `pre-dispatch checkpoint commit`. |
| Stale | The cause and fix differ by object. | Use `stale artifact`, `Agentera app files need repair`, `stale marker`, or `stale worktree base`. Avoid `stale` in recovery prompts when `out of date` or `needs repair` is clearer. |
| Phase | Conflicts with numbered workflow steps. | Use `phase` only for protocol lifecycle: `envision`, `deliberate`, `plan`, `build`, `audit`. Use `step` for capability-local actions. |
| Objective state | Clear only inside optimera. | First mention `optimization objective state`; then `objective state` is fine in optimera context. Do not modify outside optimera or explicit user instruction. |
| Support | Could mean theoretical host capability, shipped Agentera wiring, or verified behavior. | Use `host capability`, `Agentera adapter support`, or `tested support`. |
| Runtime support | Too broad to be actionable in compatibility docs. | Replace with `host capability`, `Agentera adapter support`, or `tested support`, whichever is true. |
| AskUserQuestion | Internal primitive leaking into human prose. | In user docs, say `ask the user`. In adapter docs, say `runtime question tool`. |
| MCP | Optional substrate, not a core Agentera requirement. | Say `optional MCP integration` only where the feature literally depends on MCP. |

High-risk diagnostic rewrites:

| Avoid in diagnostics | Use instead |
| --- | --- |
| `bundle freshness gap detected` | `Agentera app files need repair` |
| `bundle freshness guard failed` | `install status check failed` |
| `bundle refresh required` | `repair Agentera app files` |
| `app refresh required` | `Agentera app files need repair` or `Agentera app files are outdated` |
| `upgrade guard triggered` | `v1 migration check found legacy files` |
| `stale marker` | `missing or outdated version marker` |
| `artifact freshness failed` | `artifact is stale` or `artifact needs sync` |

## Source index

High-signal source surfaces for this vocabulary:

| Source | Vocabulary surface |
| --- | --- |
| `skills/agentera/SKILL.md` | Dispatcher, routing layers, CLI-first access, installed-app status check, and v1 migration check. |
| `skills/agentera/protocol.yaml` | Protocol primitives, glyphs, phases, visual tokens, exit signals. |
| `skills/agentera/capability_schema_contract.yaml` | Schema groups, priorities, stable IDs, primitive-reference fields. |
| `skills/agentera/capabilities/*/prose.md` | Workflow grammar, capability roles, safety rails, exit marker forms. |
| `skills/agentera/capabilities/*/schemas/*.yaml` | Trigger patterns, artifact roles, validation rules, exit conditions. |
| `skills/agentera/schemas/artifacts/*.yaml` | Artifact fields, status enums, validation vocabulary, and protected current-state fields. |
| `references/artifacts/artifact-registry-interface-model.yaml` | Canonical artifact registry language. |
| `references/cli/app-lifecycle-vocabulary.yaml` | App lifecycle canonical status and operation vocabulary authority. |
| `references/cli/bundle-skill-vocabulary.yaml` | Bundle and `SKILL.md` concept classification authority. |
| `references/cli/capability-instruction-contract.yaml` | Decision 57 capability instruction-file and first-invocation read contract authority. |
| `references/cli/routing-execution-vocabulary.yaml` | Routing and execution vocabulary authority. |
| `scripts/agentera` | Flat State CLI labels and `agentera hej` source contract. |
| `scripts/agentera_upgrade.py` | Upgrade and doctor output grammar. |
| `scripts/install_root.py` | Install-root classification semantics. |
| `hooks/validate_artifact.py` | Runtime artifact-write validation and hook exit codes. |
| `README.md` | Product, invocation, artifact, and user-facing capability language. |
| `UPGRADE.md` | Upgrade flow, package refresh, app-home repair, and runtime migration terms. |
| `DESIGN.md` | Visual identity, glyph, severity, confidence, and structural token language. |
| `.agentera/docs.yaml` | Current documentation registry, mapping, coverage, and audit vocabulary. |
| `.agentera/decisions.yaml` | Decision grammar, v2 architecture rationale, routing decisions. |
| `.agentera/progress.yaml` | Cycle, evidence, context, and final state-sync examples. |
| `.agentera/health.yaml` | Audit dimensions, grades, trajectories, findings, and artifact current-state review. |
| `.agentera/archive/*.md` | Historical plan-level current-state checks and staleness rationale. |
| `.agentera/optimera/*` | Objective, experiment, harness, metric, and keep/discard examples. |
| `fixtures/semantic/*.md` | Semantic eval fixture, oracle, and Hej dashboard constraints. |
| `tests/` | Regression evidence for CLI labels, installed-app status, routing, exits, and schema contracts. |

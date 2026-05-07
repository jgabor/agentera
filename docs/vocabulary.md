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
| `skills/agentera/SKILL.md` | Bundle dispatcher, routing model, CLI-first state access, freshness guards, and safety rails. |
| `skills/agentera/capabilities/*/prose.md` | Capability behavior, workflow grammar, step markers, and cross-capability boundaries. |
| `scripts/agentera` and `scripts/agentera_upgrade.py` | CLI-visible command labels, upgrade output, and bundle-status diagnostics. |
| `README.md`, `UPGRADE.md`, `DESIGN.md`, `.agentera/*.yaml` | User-facing phrasing, design vocabulary, and current project-state examples. |

## Normalization rules

| Rule | Use | Avoid |
| --- | --- | --- |
| Internal workflows are capabilities. | `capability`, `twelve capabilities`, `capability prose`, `capability schemas` | Calling hej/realisera/etc. standalone skills, except in v1 history. |
| The runtime surface is a skill. | `bundled skill`, `Agentera skill`, `single installed bundle` | `twelve-skill suite` for v2 behavior. |
| `/agentera` is the main invocation. | `/agentera`, `$agentera` for Codex-specific docs | `/hej` except as a legacy bridge. |
| The CLI source and rendered dashboard are different. | `agentera hej` source data, `Hej dashboard` rendered briefing | Treating raw CLI labels as the user-facing dashboard. |
| Routine state uses flat commands. | `agentera plan`, `agentera docs`, `agentera health` | `agentera query plan` for routine state. |
| `query` is advanced access. | `agentera query --list-artifacts`, `agentera query <artifact>` | Calling it the normal state interface. |
| Canonical artifact names are identifiers. | `VISION.md` maps to `.agentera/vision.yaml` | Assuming display names are literal paths. |
| Exit signals are fixed. | `complete`, `flagged`, `stuck`, `waiting` | `blocked`, `partial`, `escalated` as exit signals. |
| Freshness needs a qualifier. | `bundle freshness`, `artifact freshness`, `plan-level freshness checkpoint` | Bare `freshness` when the domain is ambiguous. |
| Checkpoint needs a qualifier. | `plan-level freshness checkpoint`, `pre-dispatch checkpoint commit` | Bare `checkpoint` in new docs. |

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
| `installed Agentera bundle is stale` | `bundle freshness gap` in user-facing diagnostics |
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
| Agentera v2 | The current architecture: one bundled skill, one `/agentera` entry point, twelve capabilities, YAML project state, and CLI-first access. | `README.md`, `UPGRADE.md`, `.agentera/decisions.yaml` |
| Bundled skill | The runtime-loaded Agentera skill at `skills/agentera/`. It contains the dispatcher and twelve capabilities. | `skills/agentera/SKILL.md` |
| Capability | A routed behavioral unit inside the bundle, with `prose.md` plus `triggers.yaml`, `artifacts.yaml`, `validation.yaml`, and `exit.yaml`. | `AGENTS.md`, `skills/agentera/capabilities/*` |
| Shared protocol | The primitive vocabulary in `protocol.yaml`: confidence, severity, decision labels, exits, visual tokens, glyphs, and phases. | `skills/agentera/protocol.yaml` |
| Capability schema contract | The executable contract for capability schema groups, stable IDs, priorities, deprecations, and primitive references. | `skills/agentera/capability_schema_contract.yaml` |
| Project state | Structured files that preserve intent, decisions, plans, progress, health, docs, design, and session continuity. | `README.md`, `.agentera/docs.yaml` |
| Operating record | Durable project history kept in files so future agents do not reconstruct history from chat residue. | `README.md`, `.agentera/progress.yaml` |
| Memory layer | Project artifacts plus global profile data that let future sessions reuse context and preferences. In onboarding, prefer `persisted project context`. | `README.md`, `profilera` prose |
| Sharp colleague | Agentera's voice: direct, opinionated, evidence-backed, warm enough to collaborate, and willing to push back. | `.agentera/vision.yaml`, `DESIGN.md`, capability prose |
| DTC | Document, Test, Code. Docs define intent, tests enforce it, code implements it. | `dokumentera`, `planera`, `realisera` prose |

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
| `⛶` | inspektera | Codebase health audit, architecture review, and artifact freshness review. |
| `▤` | dokumentera | Documentation layer; the D in DTC. |
| `♾` | profilera | Reusable decision profile and preference extraction. |
| `◰` | visualisera | Visual identity, design tokens, and design-system language. |
| `⎈` | orkestrera | Multi-cycle orchestration; dispatches work and evaluates completion. |

Capability names use Swedish-style `-era` verb forms. The name is the action:
`planera` plans, `realisera` realizes, `optimera` optimizes.

## Invocation and routing grammar

| Term | Definition |
| --- | --- |
| CLI-first state access | Read project state through `agentera` top-level commands before raw artifact reads. |
| Top-level state commands | `hej`, `plan`, `progress`, `health`, `todo`, `decisions`, `docs`, `objective`, and `experiments`. |
| Artifact-backed briefing | Any briefing or routing decision backed by Agentera project artifacts. It must use CLI-first state access. |
| Bare `/agentera` | Invocation without a specific request. It delegates to `hej` and renders the Hej dashboard from one composite source command. |
| Hej dashboard | User-facing project briefing with logo, status, attention, next action, and `⌂ hej · <status>`. |
| `agentera hej` | Compact CLI source data for the caller-rendered dashboard. It is not the dashboard itself. |
| Direct route | `/agentera <capability-name>` routes directly to that capability and bypasses natural-language matching. |
| Natural-language trigger | A phrase in `schemas/triggers.yaml` that maps a request to a capability. |
| Trigger priority | `high`, `medium`, or `low`; owned by the schema contract. |
| High-confidence match | A natural-language request with enough trigger evidence to route without asking. |
| Borderline match | A request with competing plausible routes. Agentera asks for disambiguation. |
| Fallback to hej | No sufficient match routes to hej for orientation. |
| Concrete next action | A route suggestion tied to an object such as `PLAN Task N`, `TODO`, `OBJECTIVE`, or `VISION refresh`. |
| Suggest, don't force | Hej recommends the next capability but waits for user confirmation. |
| Legacy bridge | Temporary v1 entry points, especially `/hej`, that guide users to `/agentera` and the v2 upgrade path. |

CLI-visible `agentera hej` labels are source labels. Preserve them in CLI tests
and parsing code, but transform them before presenting a user dashboard:
`mode:`, `profile:`, `health:`, `issues:`, `plan:`, `objective:`,
`attention:`, `next_action:`, and `source_contract:`.

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
| `audit` | inspektera | Evaluate health, risks, and freshness. |

Use `phase` for protocol-level lifecycle state. Use `step` for capability-local
progress markers such as `── step 2/6: verify`.

## Freshness and checkpoint vocabulary

| Term | Definition | Required qualifier or note |
| --- | --- | --- |
| Freshness | Whether a state surface reflects current reality. | Qualify the domain. |
| Artifact freshness | Whether expected artifacts were updated after the work that should have changed them. | Inspektera audits this dimension. |
| Artifact staleness | A dispatched capability was expected to update an artifact, but the artifact predates the plan creation date. | Without plan context, PROGRESS recency is advisory. |
| Final state sync | User-facing phrase for the plan closure action that updates durable project state before closing a plan. | Prefer this in README, onboarding, CLI guidance, and explanatory docs. |
| Plan-level freshness checkpoint | Canonical protocol phrase for the final task of every full plan. It updates aggregate artifacts and closes plan state after all implementation tasks complete. | Use in capability prose, schemas, tests, and mixed docs after `final state sync`. |
| Freshness-closed | Shorthand that plan closure aligned `CHANGELOG.md`, `.agentera/progress.yaml`, `TODO.md`, docs metadata when relevant, and archived or removed active plan state. | Use only after closure evidence exists. |
| Bundle freshness guard | Entry-boundary check that proves the durable `AGENTERA_HOME` bundle is current and usable before normal `/agentera` routing. | Distinct from artifact freshness. |
| Bundle freshness gap | Internal classification: the visible skill/package surface and durable bundle are out of sync, stale, missing, or unusable. | In user diagnostics, say `installed Agentera bundle is stale` and report root, source, expected version, and fix. |
| Bundle-status diagnostic | `agentera bundle-status`; classifies bundle state and emits dry-run, apply, approval, and retry guidance. | Prefer this over `fresh diagnostic`. |
| Fresh bundle | Managed install root with expected marker/version and required CLI commands available. | `bundle-status` exits successfully. |
| Stale bundle | Managed or default-missing bundle that can be repaired through preview plus approved same-root refresh. | Do not write without approval. |
| Blocked install root | Missing explicit `AGENTERA_HOME`, file-valued root, unmanaged directory, or invalid unsafe root. | User must fix root or request force guidance. |
| Bundle marker | `.agentera-bundle.json`, the durable bundle identity/version marker. | Marker version should match `registry.json` suite version. |
| Stale marker | Missing, unreadable, or version-mismatched bundle marker. | Not a synonym for every stale condition. |
| Upgrade guard | Internal pre-routing detector for v1 Markdown artifacts without v2 YAML counterparts. | In user-facing setup or recovery text, prefer `v1 migration check`. Requires dry-run preview and explicit approval before migration. |
| Pre-dispatch checkpoint commit | Commit made before worktree-isolated subagent dispatch so the worktree branches from current HEAD. | Commit message pattern: `chore(<skill>): checkpoint before worktree dispatch`. |

Do not use bare `freshness checkpoint` or bare `checkpoint` in new
documentation. Choose `final state sync` for user-facing plan closure,
`plan-level freshness checkpoint` for protocol/capability prose, or
`pre-dispatch checkpoint commit` for worktree synchronization. In mixed docs,
write `final state sync, the plan-level freshness checkpoint`.

## Workflow grammar

| Form | Meaning | Example |
| --- | --- | --- |
| `Each invocation = one ...` | Capability scope limit. | `Each invocation = one experiment.` |
| `─── <glyph> <capability> · <context> ───` | Capability introduction marker. | `─── ⎘ optimera · measure ───` |
| `── step N/M: verb` | Capability-local progress marker. | `── step 4/8: implement` |
| `## Safety rails` plus `<critical>` | Non-negotiable constraints. | `NEVER push to remote repos without explicit instruction.` |
| `Detect mode/context/level` | Step 0 classification before the main workflow. | Dokumentera detects create, update, audit, or first-run survey. |
| Decision gate | Explicit condition-based branch before proceeding. | Optimera keep/discard decision. |
| Exit-early guard | Stop condition when work is already complete or unnecessary. | Docs current, no stale work found. |
| Reality Verification Gate | Realisera check that behavior was verified against real project state. | Tests, builds, or manual verification. |
| Pre-write self-audit | Prose gate for verbosity drift, abstraction creep, and filler accumulation. | `scripts/self_audit.py` implements the checks. |
| Plan-completion sweep | Realisera cleanup when plan tasks finish. | Progress rollup, changelog, TODO, health cross-reference, archive. |
| Worktree dispatch | Isolated implementation by a subagent in a git worktree. | Realisera and optimera can use it. |
| Stale-base awareness | Guard against worktrees branching from old `origin/main` or stale HEAD. | Use checkpoint commits before dispatch. |
| Conductor protocol | Orkestrera loop: select, dispatch, evaluate, resolve, log. | Thin conductor; it dispatches, not implements. |
| Evidence audit | Check that recorded verification actually proves acceptance criteria. | Orkestrera and inspektera use this language. |
| Loop guard | Stop repeated failed cycles, tasks, or experiments. | Prevents endless retries. |

For user-facing operations, prefer plain aliases when the branded phrase does
not add precision:

| Internal or branded phrase | User-facing phrase |
| --- | --- |
| Reality Verification Gate | verification gate |
| Conductor protocol | orchestration loop |
| Evidence audit | verification review |
| Memory layer | persisted project context |

### Artifact-writing checks

| Term | Definition |
| --- | --- |
| Verbosity drift | Artifact prose exceeds the intended budget or grows without adding signal. |
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
| planera | WHAT and WHY, behavioral acceptance criteria, scope, included/excluded/deferred, task dependencies, plan-level freshness checkpoint. |
| realisera | Cycle, orient/select/research/plan/dispatch/verify/commit/audit/log, HOW, progress log, worktree dispatch. |
| optimera | Objective, experiment, baseline, harness, locked measurement, hypothesis, metric, regression, keep/discard gate. |
| inspektera | Audit, health grade, dimensions, findings, evidence, impact, suggested action, artifact freshness, deliberate decisions. |
| dokumentera | Intent-first docs, explore-and-generate, update-and-verify, first-run survey, evergreen docs, docs become the spec. |
| profilera | Decision profile, signal extraction, confidence, preference, validation, reusable user model. |
| visualisera | Visual identity, design tokens, semantic weight, terminal-native, glyphs, logo scarcity. |
| orkestrera | Thin conductor, plan execution, dispatch, task-notification result, presence check, evaluate, resolve, loop guard. |

## Runtime, install, and release grammar

| Term | Definition |
| --- | --- |
| Durable bundle | Internal phrase for the installed Agentera bundle root containing skills, scripts, hooks, manifests, docs, and `.agentera-bundle.json`. In user-facing text, say `installed Agentera bundle`. |
| `AGENTERA_HOME` | Environment variable pointing at the durable Agentera install root. |
| Default durable root | `$HOME/.agents/agentera` when `AGENTERA_HOME` is unset. |
| Install root | The resolved bundle root. Its classification is owned by `scripts/install_root.py`. |
| Managed root | A root Agentera owns and may refresh after preview and approval. |
| Unmanaged root | A directory Agentera must not overwrite silently. |
| Missing default root | Stale and previewable. Agentera can show a dry-run refresh. |
| Missing explicit root | Blocked when provided through `AGENTERA_HOME` or explicit `--install-root`. |
| Package refresh | Package-manager or marketplace update. It does not prove durable bundle freshness. |
| Bundle refresh | Same-root `agentera upgrade --only bundle` flow that updates the durable bundle. In user-facing text, say `update installed bundle`. |
| Dry-run | Preview mode. Required before upgrade or bundle refresh writes. |
| `--yes` | Explicit apply flag after preview and approval. |
| Postflight doctor | Setup validation after upgrade apply. |
| Package-update opt-in | External package manager changes require `--update-packages`. |
| Runtime adapter | Runtime-specific Agentera adapter support for skill loading, hooks, artifact validation, lifecycle metadata, and diagnostics. |
| Host support | What a runtime can theoretically do. Distinguish it from shipped Agentera behavior. |
| Hook lifecycle | Runtime callbacks such as `SessionStart`, `Stop`, `PreToolUse`, and `PostToolUse`. |
| Setup doctor | Diagnostic command surface for install/runtime health. |

Canonical runtime names are Claude Code, OpenCode, Copilot CLI, and Codex CLI.

CLI-visible bundle-status labels to preserve: `Agentera bundle status`,
`status:`, `expected version:`, `install root:`, `install root source:`,
`root status:`, `marker version:`, `missing commands:`, `dry run:`,
`apply after approval:`, `approval phrase:`, `retry:`, and `recovery:`.

CLI-visible upgrade labels to preserve: `Agentera upgrade`, `mode:`,
`status:`, `project:`, `install root:`, phase lines, item lines,
`run with --yes to apply pending changes`, and `postflight doctor:`.

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
| “One install, one entry point, one query interface to all project state.” | v2 bundle promise. |
| “Continuity lives in files, not memory.” | Realisera/project-state principle. |
| “The conversation preserves reasoning; the artifact preserves the plan.” | Planera boundary. |
| “Planera owns WHAT and WHY; realisera owns HOW.” | Planning/building boundary. |
| “The colleague says what they think, then shows the evidence.” | Inspektera voice. |
| “Findings contradicting deliberate decisions are not findings.” | Audit boundary. |
| “Select the concrete next action before selecting the skill.” | Hej routing discipline. |
| “A skill name without a concrete object is not a valid suggestion.” | Hej next-action rule. |
| “Suggest, don’t force.” | Hej confirmation rule. |
| “DTC-first: document what a feature SHOULD do before building.” | Dokumentera intent-first mode. |
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
| Skill | Confuses v1 standalone skills, the v2 bundled skill, and internal workflows. | Use `Agentera skill` for the installed runtime bundle, `v1 skill` for history, and `capability` for v2 workflows. |
| Contract | Could mean schema structure, artifact shape, protocol primitive, adapter behavior, or product promise. | Use `schema contract`, `artifact schema`, `protocol primitives`, `runtime adapter contract`, or `product promise`. |
| Status | Different surfaces use different state machines and output labels. | Use `exit status`, `task status`, `bundle status`, `install status`, `docs status`, or `health status`. |
| Freshness | Sounds like a branded synonym for several normal states: current, stale, synced, or out of date. | Use `artifact freshness`, `bundle freshness`, `docs freshness`, or `plan-level freshness checkpoint`. For users, prefer `up to date`, `stale`, `current`, or `needs sync`. |
| Checkpoint | In software, can mean commit, savepoint, restore point, model checkpoint, or milestone. | Use `final state sync`, `plan-level freshness checkpoint`, `checkpoint commit`, or `pre-dispatch checkpoint commit`. |
| Stale | The cause and fix differ by object. | Use `stale artifact`, `stale installed bundle`, `stale marker`, or `stale worktree base`. |
| Phase | Conflicts with numbered workflow steps. | Use `phase` only for protocol lifecycle: `envision`, `deliberate`, `plan`, `build`, `audit`. Use `step` for capability-local actions. |
| Objective state | Clear only inside optimera. | First mention `optimization objective state`; then `objective state` is fine in optimera context. Do not modify outside optimera or explicit user instruction. |
| Support | Could mean theoretical host capability, shipped Agentera wiring, or verified behavior. | Use `host capability`, `Agentera adapter support`, or `tested support`. |
| Runtime support | Too broad to be actionable in compatibility docs. | Replace with `host capability`, `Agentera adapter support`, or `tested support`, whichever is true. |
| AskUserQuestion | Internal primitive leaking into human prose. | In user docs, say `ask the user`. In adapter docs, say `runtime question tool`. |
| MCP | Optional substrate, not a core Agentera requirement. | Say `optional MCP integration` only where the feature literally depends on MCP. |

High-risk diagnostic rewrites:

| Avoid in diagnostics | Use instead |
| --- | --- |
| `bundle freshness gap detected` | `installed Agentera bundle is stale` |
| `bundle freshness guard failed` | `install status check failed` |
| `bundle refresh required` | `update installed bundle` |
| `upgrade guard triggered` | `v1 migration check found legacy files` |
| `stale marker` | `missing or outdated version marker` |
| `artifact freshness failed` | `artifact is stale` or `artifact needs sync` |

## Source index

High-signal source surfaces for this vocabulary:

| Source | Vocabulary surface |
| --- | --- |
| `skills/agentera/SKILL.md` | Dispatcher, routing layers, CLI-first access, bundle freshness guard, upgrade guard. |
| `skills/agentera/protocol.yaml` | Protocol primitives, glyphs, phases, visual tokens, exit signals. |
| `skills/agentera/capability_schema_contract.yaml` | Schema groups, priorities, stable IDs, primitive-reference fields. |
| `skills/agentera/capabilities/*/prose.md` | Workflow grammar, capability roles, safety rails, exit marker forms. |
| `skills/agentera/capabilities/*/schemas/*.yaml` | Trigger patterns, artifact roles, validation rules, exit conditions. |
| `skills/agentera/schemas/artifacts/*.yaml` | Artifact fields, status enums, validation vocabulary, freshness fields. |
| `references/artifacts/artifact-registry-interface-model.yaml` | Canonical artifact registry language. |
| `scripts/agentera` | Flat State CLI labels and `agentera hej` source contract. |
| `scripts/agentera_upgrade.py` | Upgrade and bundle-status output grammar. |
| `scripts/install_root.py` | Install-root classification semantics. |
| `hooks/validate_artifact.py` | Runtime artifact-write validation and hook exit codes. |
| `README.md` | Product, invocation, artifact, and user-facing capability language. |
| `UPGRADE.md` | Upgrade flow, package refresh, durable bundle, and runtime migration terms. |
| `DESIGN.md` | Visual identity, glyph, severity, confidence, and structural token language. |
| `.agentera/docs.yaml` | Current documentation registry, mapping, coverage, and audit vocabulary. |
| `.agentera/decisions.yaml` | Decision grammar, v2 architecture rationale, routing decisions. |
| `.agentera/progress.yaml` | Cycle, evidence, context, and freshness-closure examples. |
| `.agentera/health.yaml` | Audit dimensions, grades, trajectories, findings, and artifact freshness. |
| `.agentera/archive/*.md` | Historical plan-level freshness checkpoint and staleness rationale. |
| `.agentera/optimera/*` | Objective, experiment, harness, metric, and keep/discard examples. |
| `fixtures/semantic/*.md` | Semantic eval fixture, oracle, and Hej dashboard constraints. |
| `tests/` | Regression evidence for CLI labels, bundle freshness, routing, exits, and schema contracts. |

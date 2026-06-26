# Agentera vocabulary

This document indexes the shared grammar Agentera uses across capability prose,
schemas, CLI output, tests, project artifacts, and human-facing docs. Use it
when writing Agentera docs, schemas, fixtures, command output, or capability
instructions.

Scope: common terms and recurring forms only. Capability-specific one-offs are
included when they shape cross-suite usage.

## Authority order

| Authority                                                          | Owns                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `references/cli/vocabulary-index.yaml`                             | Authority order, normalization rules, plain-language layer rules, and Decision 44 replacement boundaries.                                                                                                                                                                                                                    |
| `skills/agentera/protocol.yaml`                                    | Confidence, severity, decision labels, exit signals, visual tokens, glyphs, and phases.                                                                                                                                                                                                                                      |
| `skills/agentera/capability_schema_contract.yaml`                  | Capability schema structure, required groups, priorities, and primitive-reference fields.                                                                                                                                                                                                                                    |
| `skills/agentera/schemas/artifacts/*.yaml`                         | Artifact field grammar, status values, path contracts, and validation rules.                                                                                                                                                                                                                                                 |
| `references/artifacts/artifact-registry-interface-model.yaml`      | Artifact identity facts: `artifact_id`, display name, default path, producers, consumers, type, scope.                                                                                                                                                                                                                       |
| `references/cli/app-lifecycle-vocabulary.yaml`                     | App lifecycle canonical statuses, deprecated aliases, operation verbs, status concepts, and consumer ownership boundaries.                                                                                                                                                                                                   |
| `references/cli/update-channels.yaml`                              | Stable and development update channels, dist-tag/git resolution, default channel, and override keys.                                                                                                                                                                                                                         |
| `references/cli/bundle-skill-vocabulary.yaml`                      | Canonical concepts, compatibility boundaries, and classification rules for `bundle` and `SKILL.md` usage.                                                                                                                                                                                                                    |
| `references/cli/capability-instruction-contract.yaml`              | Decision 57 capability instruction-file contract, current `packages/cli/src/capabilities/<name>/instructions.ts` authority, and implemented `first_invocation_read` CLI/schema discoverability (D65 collapsed the legacy `full`/`compact_startup` distinction into a single `prime_context` value with runtime enforcement). |
| `references/cli/routing-execution-vocabulary.yaml`                 | Canonical concepts, compatibility boundaries, and classification rules for routing, suggestions, delegation, worker spawning, runtime subagent mechanisms, and pre-spawn Git commits.                                                                                                                                        |
| `skills/agentera/SKILL.md`                                         | Agentera routing entry point, routing model, CLI-first state access, installed-app status checks, and safety rails.                                                                                                                                                                                                          |
| `packages/cli/src/capabilities/*/instructions.ts`                  | Capability behavior, workflow grammar, step markers, and cross-capability boundaries. Loaded as a default-exported string constant and served via `agentera prime --context <name> --format json`.                                                                                                                           |
| `the agentera CLI` and `packages/cli/src/upgrade (doctor/upgrade)` | CLI-visible command labels, upgrade output, and doctor diagnostics.                                                                                                                                                                                                                                                          |
| `README.md`, `UPGRADE.md`, `DESIGN.md`, `.agentera/*.yaml`         | User-facing phrasing, design vocabulary, and current project-state examples.                                                                                                                                                                                                                                                 |

## Normalization rules

`references/cli/vocabulary-index.yaml` owns the normalization rule table and
plain-language layer rules. Do not duplicate those rows here.

Read `vocabulary-index.yaml` `normalization_rules` and `plain_language` before
editing docs, capability prose, diagnostics, tests, or labels.

## Plain-language rule

Brand the worldview. Boring-name the work.

Use Agentera-specific terms when they name a protocol concept, preserve
schema-aligned precision, or teach the product worldview. Prefer plain software
terms for user-facing operations, diagnostics, setup, migration, and errors.

When both are useful, lead with the plain phrase and introduce the Agentera term
second. See `vocabulary-index.yaml` `plain_language.lead_with_plain_phrase` for
examples. Diagnostics should state object, state, cause, and fix.

## Product grammar

| Term                       | Definition                                                                                                                                                                                                                                                                          | Common sources                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Agentera                   | An opinionated mobile-first coding agent. One product brand across delivery surfaces — `@agentera/mobile`, `@agentera/web`, `@agentera/cli`, and editor skill/plugin runtimes. Structured `.agentera/` project state makes sessions compound.                                       | `README.md`, `.agentera/vision.yaml`                                             |
| Product surface            | Where the same fixed Agentera workflow ships: `@agentera/mobile` (primary app), `@agentera/web` (site and docs), `@agentera/cli` (agent runtime and state CLI), and editor skill/plugin runtimes (Cursor, Claude, OpenCode, Codex, Copilot). Not extension hosts — delivery shells. | `README.md`, `AGENTS.md`, `packages/*/README.md`, `.agentera/decisions.yaml`     |
| @agentera/mobile           | The flagship mobile/web app package at `packages/mobile`. SvelteKit, Cursor SDK, Cloudflare Worker.                                                                                                                                                                                 | `packages/mobile/README.md`, `packages/mobile/DESIGN.md`                         |
| Agentera skill             | Runtime-loaded skill at `skills/agentera/` — a delivery surface for the same twelve-capability workflow inside supported editors. Contains the routing entry and twelve capabilities; not user extensibility.                                                                       | `skills/agentera/SKILL.md`, `README.md` Internals                                |
| Capability                 | A routed behavioral unit inside the Agentera skill, with the prose module `packages/cli/src/capabilities/<name>/instructions.ts` plus `triggers.yaml`, `artifacts.yaml`, `validation.yaml`, and `exit.yaml`.                                                                        | `AGENTS.md`, `skills/agentera/capabilities/*`, `packages/cli/src/capabilities/*` |
| Capability canonical name (v3) | The English name binding for v3+ capability invocation, per Decision 70. Promoted from the Decision 43 alias set. Mobile UX, web docs, editor skills, and the CLI all use the same English name; the v2 stable distribution uses the legacy Swedish `-era` IDs (see `Legacy Swedish capability names`).                                                                                | `.agentera/decisions.yaml` (D43, D70), `references/cli/vocabulary-index.yaml` (protected_surfaces)                          |
| Legacy Swedish capability names (v2 stable) | The historical Swedish `-era` IDs (e.g. `hej`, `resonera`) used by the v2 stable distribution (`npx -y agentera@latest`) and preserved as historical references in archived plans, decisions, and changelogs. Out of scope for v3 surface per Decision 70. Coexistence probe surfaces per-distribution naming divergence.                                                                                | `.agentera/decisions.yaml` (D70), `references/cli/vocabulary-index.yaml` (protected_surfaces)                          |
| Shared protocol            | Internal primitive vocabulary in `protocol.yaml`: confidence, severity, decision labels, exits, visual tokens, glyphs, and phases.                                                                                                                                                  | `skills/agentera/protocol.yaml`                                                  |
| Capability schema contract | The executable contract for capability schema groups, stable IDs, priorities, deprecations, and primitive references.                                                                                                                                                               | `skills/agentera/capability_schema_contract.yaml`                                |
| Project state              | Structured files that preserve intent, decisions, plans, progress, health, docs, design, and session continuity.                                                                                                                                                                    | `README.md`, `.agentera/docs.yaml`                                               |
| Project history            | Durable history kept in files so future agents do not reconstruct history from chat residue.                                                                                                                                                                                        | `README.md`, `.agentera/progress.yaml`                                           |
| Saved project context      | Project artifacts plus global profile data that let future sessions reuse context and preferences.                                                                                                                                                                                  | `README.md`, `profile` prose                                                   |
| Sharp colleague            | Agentera's voice: direct, opinionated, evidence-backed, warm enough to collaborate, and willing to push back.                                                                                                                                                                       | `.agentera/vision.yaml`, `DESIGN.md`, capability prose                           |
| Docs-first workflow        | Document intended behavior before tests and code; docs define intent, tests enforce it, code implements it.                                                                                                                                                                         | `document`, `plan`, `build` prose                                      |

## Capability grammar

| Glyph | Capability  | Role                                                                           |
| ----- | ----------- | ------------------------------------------------------------------------------ |
| `⌂`   | status      | Orientation, routing, dashboard briefing, and next best action.                |
| `⛥`   | vision      | Project direction, north star, principles, identity, and strategic tensions.   |
| `❈`   | discuss     | Structured deliberation, tradeoff pressure, and decision thinking.             |
| `⬚`   | research    | External pattern analysis and useful cross-pollination.                        |
| `≡`   | plan        | Planning with behavioral acceptance criteria; owns WHAT and WHY.               |
| `⧉`   | build       | Verified autonomous development cycle; owns HOW.                               |
| `⎘`   | optimize    | Metric-driven optimization through one experiment per invocation.              |
| `⛶`   | audit       | Codebase health audit, architecture review, and artifact current-state review. |
| `▤`   | document    | Documentation layer; owns docs-first workflow guidance.                        |
| `♾`   | profile     | Reusable decision profile and preference extraction.                           |
| `◰`   | design      | Visual identity, design tokens, and design-system language.                    |
| `⎈`   | orchestrate | Multi-cycle orchestration; dispatches work and evaluates completion.           |

Capability names use plain English verb forms (Decision 70). The name is the action:
`plan` plans, `build` realizes, `optimize` optimizes.

### Capability instruction contract

The machine-readable authority is
`references/cli/capability-instruction-contract.yaml`; it owns Decision 57's
instruction-file boundary, including the canonical `instructions.ts` module,
legacy `prose.md` and `instructions.md` compatibility boundaries, the
implemented `first_invocation_read: prime_context` value, the
`prime --context <name> --format json` ownership statement, and the runtime
enforcement boundary promoted to `true` in D65.

Use this prose as guidance only: the default is that the first capability
invocation shells out to `agentera prime --context <name> --format json` and
reads the returned `prose` field. Today, capability directories carry the
`schemas/` files only, the prose module lives at
`packages/cli/src/capabilities/<name>/instructions.ts`, runtime descriptors
invoke the prime command, and the `agentera prime --context <name> --format
json` response emits `capability_context.prose` plus
`first_invocation_read` metadata.

Do not replace this with a parallel Markdown table of read modes or migration
surfaces. Update the YAML authority first, then keep this section as the short
human-facing boundary. The `prime_context` runtime enforcement is owned by the
CLI process; agent runtimes shell out to the prime command instead of reading
the prose module directly.

## Invocation and routing grammar

| Term                         | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI-first state access       | Read project state through `agentera` top-level commands before raw artifact reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Top-level state commands     | The canonical namespace command is `state` followed by a subcommand (`plan`, `progress`, `health`, `todo`, `decisions`, `docs`, `objective`, `experiments`, `query`). Legacy top-level aliases remain during migration; see [audience-namespace-cli-migration.yaml](references/cli/audience-namespace-cli-migration.yaml).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Artifact-backed briefing     | Any briefing or routing decision backed by Agentera project artifacts. It must use CLI-first state access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Bare `/agentera`             | Invocation without a specific request. It delegates to `status` and renders the status dashboard from one composite source command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Status dashboard                | User-facing project briefing with logo, status metrics, a narrative read inside `status`, attention, next action, and `⌂ status · <status>`. Issues summary uses `critical · degraded · annoying` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `agentera prime`               | Compact CLI source data for the caller-rendered dashboard. It is not the dashboard itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Direct route                 | A canonical capability name with optional following topic text, `/agentera <capability-name>` with optional topic text, or `/agentera <primary-alias>` routes directly to that capability and bypasses natural-language matching.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Canonical capability route   | An English capability name such as `discuss`, `plan`, or `orchestrate`, optionally followed by topic text, plus the slash form `/agentera <capability-name>` with optional topic text. Canonical names remain protocol identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Primary route alias          | The one plain `/agentera <alias>` direct route for a capability, owned by `ROUTE_ALIASES.primary_aliases`. Each canonical capability has exactly one primary alias.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Secondary request wording    | Natural-language phrases in capability trigger schemas, such as `deliberate`, `brainstorm`, `rubber duck`, `brief`, and `what's next`. They route through trigger matching and are not primary aliases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Natural-language trigger     | A phrase in `schemas/triggers.yaml` that maps a request to a capability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Trigger priority             | `high`, `medium`, or `low`; owned by the schema contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| High-confidence match        | A natural-language request with enough trigger evidence to route without asking.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Borderline match             | A request with competing plausible routes. Agentera asks for disambiguation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Fallback to status             | No sufficient match routes to status for orientation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Concrete next action         | A route suggestion tied to an object such as `PLAN Task N`, `TODO`, `OBJECTIVE`, or `VISION refresh`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Suggest, don't force         | Status recommends the next capability but waits for user confirmation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Capability handoff label     | A recommendation from one capability to another. Use glyph plus canonical name, such as `⧉ build` or `≡ plan`, not standalone slash-capability names. SG priority codes are internal protocol references and are not user-facing handoff labels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Explicit route documentation | User-facing examples that teach the actual entry route. Use `/agentera <alias>` such as `/agentera build`; do not present aliases as CLI commands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Runtime question tool        | Host-native bounded-choice prompt. Current examples: Claude Code `AskUserQuestion`, Copilot `ask_user`, Codex `request_user_input`, and OpenCode `question`. These are guidance examples, not schema authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Question-tool gating         | Use a native question tool only for at least two meaningful non-terminal next actions or consequential Proceed/Cancel; `Done` and custom/free-form answers do not count as alternatives. Initial Agentera/status briefs stay free-form unless bounded choices were requested or the suggested next step is a state-changing Proceed/Cancel handoff. A single non-mutating suggested handoff may use a free-form prompt, but a single state-changing handoff uses native Proceed/Cancel confirmation. State-changing means the proposed next step may write artifacts, edit code, run optimization or orchestration cycles, apply migrations, refresh app/runtime state, or otherwise mutate project/runtime state. Apply the behavior rule first, with examples such as ⧉ build, ≡ plan when creating or updating plans, ▤ document when writing docs, ⎘ optimize when running or applying optimization cycles, and ⎈ orchestrate when dispatching cycles. This dispatcher rule governs status and capability handoff prompts; invoked capability prose can impose stricter question-tool requirements. |
| Handoff confirmation         | Clear free-form acceptance of the named single suggestion confirms invocation. Selecting a downstream capability option in a bounded prompt also confirms invocation; selecting `Done` stops without routing. Ambiguous replies get one clarifying question.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Route                        | Direct user invocation by canonical capability name, primary alias, or slash route. A route is already consent to invoke the capability and does not need an extra handoff confirmation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Suggest                      | Recommend a downstream capability and wait for confirmation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Delegate                     | Orchestrate assigns approved plan work to a worker capability during an explicitly orchestrated flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Spawn                        | Build or Optimize launches an isolated runtime worker through the host subagent mechanism.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Subagent mechanism           | Runtime support for worker execution through Claude Code, OpenCode, Codex CLI, Copilot CLI, Cursor IDE, or another host-native worker surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Legacy bridge                | Temporary v1 entry points, especially `/hej`, that guide users to `/agentera` and the v2 upgrade path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

CLI-visible `agentera prime` labels are source labels. Preserve them in CLI tests
and parsing code, but transform them before presenting a user dashboard:
`mode:`, `profile:`, `health:`, `todo:`, `plan:`, `objective:`,
`attention:`, `next_action:`, and `source_contract:`.

Primary route aliases are slash-route vocabulary, not CLI command vocabulary:

| Canonical capability (v3) | Legacy Swedish ID (v2 stable) | Slash route              |
| ------------------------- | ----------------------------- | ------------------------ |
| `status`                  | `hej`                         | `/agentera status`       |
| `vision`                  | `visionera`                   | `/agentera vision`       |
| `discuss`                 | `resonera`                    | `/agentera discuss`      |
| `research`                | `inspirera`                   | `/agentera research`     |
| `plan`                    | `planera`                     | `/agentera plan`         |
| `build`                   | `realisera`                   | `/agentera build`        |
| `optimize`                | `optimera`                    | `/agentera optimize`     |
| `audit`                   | `inspektera`                  | `/agentera audit`        |
| `document`                | `dokumentera`                 | `/agentera document`     |
| `profile`                 | `profilera`                   | `/agentera profile`      |
| `design`                  | `visualisera`                 | `/agentera design`       |
| `orchestrate`             | `orkestrera`                  | `/agentera orchestrate`  |

Do not teach primary aliases as CLI state commands. v3 orientation is
`agentera prime` (capability ID `status` via `prime --context status`); routine
state reads use `agentera state plan`, `state progress`, `state health`,
`state todo`, `state decisions`, `state docs`, `state objective`,
`state experiments`, and advanced `state query`. The v2 stable distribution
retains `hej` and the rest of the Swedish capability surface per Decision 70.

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

| Term                    | Definition                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Artifact                | A project or agent state file owned by one or more capabilities.                                                                                                                                                                                                                                                                     |
| Human-facing artifact   | A root-level Markdown artifact intended for people, such as `TODO.md`, `CHANGELOG.md`, or `DESIGN.md`.                                                                                                                                                                                                                               |
| Severity band policy    | TODO.md severity bands (⇶ Critical, ⇉ Degraded, → Normal, ⇢ Annoying) may be header-only when they have no open work; open items use `- [ ] [type:train]` only. Authority: `skills/agentera/schemas/artifacts/todo.yaml` CONVENTION TC5; executable rule in `packages/cli/src/hooks/validateArtifact/markdown.ts` `validateMdItems`. |
| Agent-facing artifact   | A structured YAML artifact under `.agentera/`, such as `.agentera/progress.yaml`.                                                                                                                                                                                                                                                    |
| Global artifact         | A user-level artifact outside a project, such as `PROFILE.md` or `USAGE.md`.                                                                                                                                                                                                                                                         |
| Canonical artifact name | Protocol `artifact_id` such as `plan`, `progress`, or `docs`; human-facing Markdown filenames such as `TODO.md` are `display_name` values, not protocol identity.                                                                                                                                                                    |
| Resolved artifact path  | The actual path after consulting `.agentera/docs.yaml` mapping or the default layout.                                                                                                                                                                                                                                                |
| Artifact mapping        | `.agentera/docs.yaml` rows that map `artifact_id` values to project-local paths and producers.                                                                                                                                                                                                                                       |
| ArtifactRegistry        | The registry interface model for artifact IDs, display names, default paths, producers, consumers, type, scope, and special cases.                                                                                                                                                                                                   |
| `artifact_id`           | Machine identifier such as `progress`, `health`, `docs`, or `objective`.                                                                                                                                                                                                                                                             |
| `display_name`          | Human-readable filename label such as `VISION.md` or `TODO.md`; registry-owned, not protocol identity.                                                                                                                                                                                                                               |
| `default_path`          | Registry-owned path used when no docs mapping overrides it.                                                                                                                                                                                                                                                                          |
| `local_role`            | Capability relationship to an artifact: `produces`, `consumes`, or `produces_and_consumes`.                                                                                                                                                                                                                                          |
| Docs override boundary  | `docs.yaml` may override paths for known display names; it must not redefine canonical identity facts.                                                                                                                                                                                                                               |
| Objective state         | Optimize state under `.agentera/optimize/<objective-name>/`, including `objective.yaml`, `experiments.yaml`, and harness files.                                                                                                                                                                                                      |

Canonical artifact IDs include `vision`, `decisions`, `plan`, `progress`,
`todo`, `health`, `docs`, `design`, `profile`, `objective`, `experiments`,
`changelog`, `session`, `plan_archive`, `optimera_harness`, and
`semantic_fixture`.

## Status, severity, confidence, and exits

### Exit signals

| Signal     | Meaning                                           | Use                               |
| ---------- | ------------------------------------------------- | --------------------------------- |
| `complete` | The workflow finished successfully.               | Normal completion.                |
| `flagged`  | Work completed with caveats the user should know. | List each concern.                |
| `stuck`    | The capability cannot proceed.                    | State blocker and attempted work. |
| `waiting`  | Required information is missing.                  | State exactly what is needed.     |

Exit marker grammar is `<glyph> <capability> · <status>`, for example
`▤ document · complete`. For `flagged`, `stuck`, and `waiting`, add `▸`
details.

### Finding severity

| Value      | Meaning                                                  |
| ---------- | -------------------------------------------------------- |
| `critical` | Broken functionality, security issue, or data-loss risk. |
| `warning`  | Works but poorly, confusingly, or in a fragile way.      |
| `info`     | Minor, cosmetic, or low-impact improvement.              |

### Issue severity

| Value      | Glyph | Meaning                                  |
| ---------- | ----- | ---------------------------------------- |
| `critical` | `⇶`   | Blocks progress or breaks functionality. |
| `degraded` | `⇉`   | Works, but poorly, slowly, or fragily.   |
| `normal`   | `→`   | Standard work.                           |
| `annoying` | `⇢`   | Cosmetic or minor friction.              |

### Confidence language

| Value         | Meaning                                         |
| ------------- | ----------------------------------------------- |
| `firm`        | User is committed. Treat as a hard constraint.  |
| `provisional` | Best current answer. Treat as a strong default. |
| `exploratory` | Direction to try. Treat as a suggestion.        |

Numeric confidence is `0-100`: `90-100` verified, `70-89` strong,
`50-69` moderate, `30-49` weak, and `0-29` speculative.

### Phase language

| Phase        | Primary capabilities                          | Meaning                                                |
| ------------ | --------------------------------------------- | ------------------------------------------------------ |
| `envision`   | vision                                         | Define north star and direction.                       |
| `deliberate` | discuss                                      | Think through tradeoffs and decisions.                 |
| `plan`       | plan                                          | Break intent into scoped work.                         |
| `build`      | build, optimize, document, design             | Produce code, docs, designs, or measured improvements. |
| `audit`      | audit                                         | Evaluate health, risks, and state alignment.           |

Use `phase` for protocol-level lifecycle state. Use `step` for capability-local
progress markers such as `── step 2/6: verify`.

## Decision 44 replacement boundary

`references/cli/vocabulary-index.yaml` `decision_44` owns replacement terms,
allowed uses, protected surfaces, and the deprecated-term scan pattern used by
`tests/test_decision44_vocabulary.py`. Do not duplicate those tables here.

Read `vocabulary-index.yaml` before editing docs, capability prose, diagnostics,
tests, labels, or active state.

## Workflow grammar

| Form                                       | Meaning                                                                                 | Example                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Each invocation = one ...`                | Capability scope limit.                                                                 | `Each invocation = one experiment.`                                       |
| `─── <glyph> <capability> · <context> ───` | Capability introduction marker.                                                         | `─── ⎘ optimize · measure ───`                                            |
| `── step N/M: verb`                        | Capability-local progress marker.                                                       | `── step 4/8: implement`                                                  |
| `## Safety rails` plus `<critical>`        | Non-negotiable constraints.                                                             | `NEVER push to remote repos without explicit instruction.`                |
| `Detect mode/context/level`                | Step 0 classification before the main workflow.                                         | Document detects create, update, audit, or first-run survey.            |
| Decision gate                              | Explicit condition-based branch before proceeding.                                      | Optimize keep/discard decision.                                           |
| Exit-early stop condition                  | Stop condition when work is already complete or unnecessary.                            | Docs current, no stale work found.                                        |
| Behavioral verification gate               | Build check that behavior was verified against real project state.                  | Tests, builds, or manual verification.                                    |
| Pre-write self-audit                       | Prose check for verbosity mismatch, abstraction creep, and filler accumulation.         | `agentera lint --artifact <ARTIFACT>` exposes the checks through the CLI. |
| Plan-completion sweep                      | Build cleanup when plan tasks finish.                                               | Progress rollup, changelog, TODO, health cross-reference, archive.        |
| Worker spawn                               | Isolated implementation or measurement by a worker through the host subagent mechanism. | Build and optimize can use it.                                        |
| Stale-base awareness                       | Prevent workers from branching from old `origin/main` or stale HEAD.                    | Use pre-spawn Git commits before spawning workers.                        |
| Orchestration loop                         | Orchestrate loop: select, delegate, evaluate, resolve, log.                              | Orchestrate delegates; it does not implement.                              |
| Evidence audit                             | Check that recorded verification actually proves acceptance criteria.                   | Orchestrate and audit use this language.                              |
| Loop stop condition                        | Stop repeated failed cycles, tasks, or experiments.                                     | Prevents endless retries.                                                 |

For user-facing operations, prefer plain aliases when the branded phrase does
not add precision:

| Internal or branded phrase | User-facing phrase           |
| -------------------------- | ---------------------------- |
| Reality Verification Gate  | behavioral verification gate |
| Conductor protocol         | orchestration loop           |
| Evidence audit             | verification review          |
| Memory layer               | saved project context        |

### Artifact-writing checks

| Term                 | Definition                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| Verbosity mismatch   | Artifact prose exceeds the intended budget or grows without adding signal.                                    |
| Abstraction creep    | Prose lacks a concrete anchor such as a path, line number, metric, identifier, commit, or quote.              |
| Filler accumulation  | Prose accumulates hedges, redundant transitions, self-reference, summary preambles, or generic justification. |
| Concrete anchor      | A file path, line number, commit hash, metric value, identifier, or direct quote.                             |
| Lead-with-conclusion | Start with the actionable conclusion, then provide evidence.                                                  |
| Compaction           | Keep recent full entries, preserve older one-line archives, and drop beyond retention limits.                 |

## Capability-specific recurring vocabulary

| Capability  | Common terms                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| status      | Orientation, dashboard, returning project, fresh project, attention, next action, concrete object, route suggestion.                |
| vision      | North star, persona, principles, direction, identity, tensions, create/refine/replace/audit modes.                                  |
| discuss     | Socratic questioning, one question at a time, honest friction, steelman, tradeoffs, decision pressure.                              |
| research    | Source analysis, pattern extraction, cross-pollination, worth stealing, external practice, adaptation.                              |
| plan        | WHAT and WHY, behavioral acceptance criteria, scope, included/excluded/deferred, task dependencies, plan-level current-state check. |
| build       | Cycle, orient/select/research/plan/spawn/verify/commit/audit/log, HOW, progress log, worker spawn.                                  |
| optimize    | Objective, experiment, baseline, harness, locked measurement, hypothesis, metric, regression, keep/discard gate.                    |
| audit       | Audit, health grade, dimensions, findings, evidence, impact, suggested action, artifact current-state review, deliberate decisions. |
| document    | Intent-first docs, explore-and-generate, update-and-verify, first-run survey, evergreen docs, docs become the spec.                 |
| profile     | Decision profile, signal extraction, confidence, preference, validation, reusable user model.                                       |
| design      | Visual identity, design tokens, semantic weight, terminal-native, glyphs, logo scarcity.                                            |
| orchestrate | Plan execution, delegate, task-notification result, presence check, evaluate, resolve, loop stop condition.                         |

## Runtime, install, and release grammar

| Term                         | Definition                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agentera directory           | Plain-language name for the local directory named by `AGENTERA_HOME`; user data stays at this directory root.                                                                                                                                                  |
| App files directory          | Plain-language name for `$AGENTERA_HOME/app`, where Agentera's scripts and skill files live. Internal JSON may call this `managedAppRoot`; do not use that phrase in prompts.                                                                                  |
| User data directory          | The `AGENTERA_HOME` root that keeps `PROFILE.md`, `USAGE.md`, `history/`, `benchmarks/`, `intermediate/`, `sessions/`, and other preserved user-state paths.                                                                                                   |
| `AGENTERA_HOME`              | Environment variable pointing at the Agentera directory. Explain this only when the user needs the exact setting.                                                                                                                                              |
| Normal Agentera directory    | Platform data directory for Agentera when `AGENTERA_HOME` is unset.                                                                                                                                                                                            |
| `--install-root`             | Compatibility flag name for existing CLI options; surrounding text should say Agentera directory.                                                                                                                                                              |
| Directory with unknown files | A directory Agentera must not overwrite silently. Say this instead of unmanaged root.                                                                                                                                                                          |
| Missing normal directory     | Previewable. Agentera can show a no-write repair preview.                                                                                                                                                                                                      |
| Missing chosen directory     | Needs a user decision when provided through `AGENTERA_HOME` or explicit `--install-root`.                                                                                                                                                                      |
| Package refresh              | Package-manager or marketplace update. It does not prove Agentera's app files are current.                                                                                                                                                                     |
| App repair                   | Normal repair flow that previews or applies Agentera app files plus managed runtime config, plugins, hooks, commands, and safe cleanup together. It must not edit shell startup files, and package-manager commands remain opt-in through `--update-packages`. |
| `--only bundle`              | Compatibility selector for narrow app-file work. Do not present it as the normal repair recommendation when managed runtime surfaces may also need repair.                                                                                                     |
| Preview                      | No-write mode. Required before upgrade or app repair writes; the underlying command flag is `--dry-run`.                                                                                                                                                       |
| `--yes`                      | Explicit apply flag after preview and approval.                                                                                                                                                                                                                |
| Final check                  | Setup validation after upgrade apply. Uses the same app-home probe as `agentera doctor` (`build_doctor_status`), not `setup_doctor.build_report`.                                                                                                              |
| Package-update opt-in        | External package manager changes require `--update-packages`.                                                                                                                                                                                                  |
| Runtime adapter              | Runtime-specific Agentera adapter support for skill loading, hooks, artifact validation, lifecycle metadata, and diagnostics.                                                                                                                                  |
| Host support                 | What a runtime can theoretically do. Distinguish it from shipped Agentera behavior.                                                                                                                                                                            |
| Hook lifecycle               | Runtime callbacks such as `SessionStart`, `Stop`, `PreToolUse`, and `PostToolUse`.                                                                                                                                                                             |
| Setup doctor                 | Diagnostic command surface for install/runtime health.                                                                                                                                                                                                         |

Canonical runtime names are Claude Code, OpenCode, Copilot CLI, Codex CLI, Cursor IDE, and Cursor Agent CLI.

### App lifecycle status vocabulary

Decision 54 makes app lifecycle state a protocol surface, not ad hoc output
copy. The machine-readable authority is
`references/cli/app-lifecycle-vocabulary.yaml`; it owns the canonical status
order, status definitions, deprecated aliases, cross-major status concepts,
scoped operation verbs, and consumer ownership boundaries for doctor, status,
upgrade, docs, and tests.

Use this prose as guidance only: human-readable text can be friendlier, but it
should be derived from canonical metadata instead of inventing parallel status
words. `agentera upgrade` is the only repair command. When app files are
version-behind, the operation inside that command is an **update**; when files
are missing or broken, it is a **repair**; when v1 artifacts exist, it is a
**migrate**. Hej attention text should name both the operation and the command
(for example, app files outdated; run `agentera upgrade`).
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

### Update channels

Dual update channels select which published Agentera line upgrade, doctor, and
prime resolve. The machine-readable authority is
`references/cli/update-channels.yaml`; it owns channel names, default selection,
npm dist-tag and git ref resolution, override precedence, and consumer ownership
for upgrade, doctor, prime, docs, and tests.

Use this prose as guidance only: **stable** tracks the supported 2.x line on
`npx -y agentera@latest` and, for maintainers, `uvx --from git+...@main` (Python
CLI). **development** tracks 3.x alphas and release candidates on **npm only**
(`npx -y agentera@next`); feat/v3 is TypeScript-only and has no uv/git install
path. v2→v3 is a one-way upgrade through the development npm channel. Default
channel is stable. Override with `--channel`, `AGENTERA_UPDATE_CHANNEL`, or
`update.channel` in user config. Cross-major v2→v3 migration is never implied by
stable-channel `@latest` while stable tracks 2.x; it is migrate work tagged
`major_boundary_crossing` in the app lifecycle authority and requires semver
forward-major confirmation (running version behind latest on the selected channel)
after preview with --dry-run before apply with --yes. Migration from v2 always targets the
latest v3+ release on the chosen channel. Return to the v2 Python line is
permanently unsupported after crossing into v3+; only a future scoped downgrade
(for example v4→v3) may be added later.

Do not replace this with a parallel Markdown table of dist-tags, git refs, or
override keys. Update the YAML authority first, then keep this section as the
short human-facing boundary.

### Bundle and SKILL.md vocabulary

The machine-readable authority is
`references/cli/bundle-skill-vocabulary.yaml`; it owns classification of
`bundle` and `SKILL.md` usage into canonical concepts, compatibility
identifiers, package metadata, historical records, fixtures, path-like
references, generic plain language, and ambiguous current prose.

Use this prose as guidance only: current conceptual docs should say the object
they mean, such as Agentera app files, suite package, plugin-shipped hooks,
removed `bundle-status` command, Agentera routing entry point, skill entry file,
historical v1 skill entry paths (post-3.0 removed from the repo tree). Preserve shipped identifiers and
literal paths such as `.agentera-bundle.json`, `bundle.status`,
`activeBundleRoot`, `--only bundle`, and `skills/agentera/SKILL.md` unless an
explicit compatibility migration is in scope.

Do not replace this with a parallel Markdown table of allowed and forbidden
terms. Update the YAML authority first, then keep this section as the short
human-facing boundary.

## Evaluation and evidence grammar

| Term                        | Definition                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation passed           | Evidence that required checks completed successfully. Name the checks.                                                                                                                                                                                                                                                                                                      |
| Focused tests               | Targeted tests for the changed surface.                                                                                                                                                                                                                                                                                                                                     |
| Full pytest                 | Repository-wide pytest run. Use exact counts when recorded.                                                                                                                                                                                                                                                                                                                 |
| Capability validator        | `uv run agentera check validate capability skills/agentera/capabilities/<name>`.                                                                                                                                                                                                                                                                                            |
| Cross-capability validation | Checks that capability schemas agree with registry, protocol, routing, and exit contracts.                                                                                                                                                                                                                                                                                  |
| Smoke eval                  | Runtime/setup check for crashes, non-zero exits, or obvious host failures.                                                                                                                                                                                                                                                                                                  |
| Live-host smoke             | Explicit opt-in model-host check against real runtime access.                                                                                                                                                                                                                                                                                                               |
| Semantic eval               | Offline fixture evaluation that checks whether captured output means the right thing.                                                                                                                                                                                                                                                                                       |
| Semantic fixture            | Markdown fixture with prompt, seeded project state, captured output, tool trace, and expected facts.                                                                                                                                                                                                                                                                        |
| Startup-overhead analysis   | Local-only Decision 51 measurement surface for raw Agentera artifact access after CLI state calls during capability startup/state gathering. It replaced an uncommitted route/intro startup-window draft that found zero qualifying windows, and must report the retained `CLI state -> raw artifact access` metric before recommending a startup envelope or guidance fix. |
| Startup report              | Human-readable and structured report pair that includes boundary source, runtime coverage, startup metrics, threshold rationale, recommendation, and privacy caveats without raw transcript text or raw local paths.                                                                                                                                                        |
| Seeded project state        | Fixture-provided artifacts used as the source of truth for expected behavior.                                                                                                                                                                                                                                                                                               |
| Oracle                      | Artifact-derived expectation, such as the exact plan task status should route to.                                                                                                                                                                                                                                                                                              |
| Regression                  | Required safety check for behavior that must not degrade.                                                                                                                                                                                                                                                                                                                   |
| Harness                     | Optimera measurement substrate. Once approved, it is immutable ground truth.                                                                                                                                                                                                                                                                                                |
| Objective                   | Measurable optimization charter under `.agentera/optimera/<name>/`.                                                                                                                                                                                                                                                                                                         |
| Experiment                  | One falsifiable optimization attempt with hypothesis, method, metric, regression, status, and conclusion.                                                                                                                                                                                                                                                                   |
| Keep/discard gate           | Keep only if the metric improves and regression gates pass; discard otherwise.                                                                                                                                                                                                                                                                                              |

## Visual grammar

| Token family      | Values                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Status tokens     | `■` complete, `▣` in progress, `□` open, `▨` blocked.                                               |
| Severity tokens   | `⇶` critical, `⇉` degraded, `→` normal, `⇢` annoying.                                               |
| Confidence tokens | `━` firm, `─` provisional, `┄` exploratory.                                                         |
| Trend tokens      | `⮉` improving, `⮋` degrading.                                                                       |
| Structural tokens | `───` section divider, `▸` list item, `·` separator, `→` flow, `█▓░` progress bar.                  |
| Logo              | Box-drawing Agentera logo. Use for the Hej dashboard, major completions, and significant artifacts. |

Visualisera owns visual identity in `DESIGN.md`. Protocol owns token meanings in
`skills/agentera/protocol.yaml`.

## Canonical phrases

| Phrase                                                                    | Use                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------ |
| “Opinionated mobile-first coding agent.”                                  | Product identity.                                      |
| “One install, one entry point, one query interface to all project state.” | CLI state-access promise (internals/contributor docs). |
| “Continuity lives in files, not memory.”                                  | Realisera/project-state principle.                     |
| “The conversation preserves reasoning; the artifact preserves the plan.”  | Plan boundary.                                      |
| “Plan owns WHAT and WHY; build owns HOW.”                          | Planning/building boundary.                            |
| “The colleague says what they think, then shows the evidence.”            | Audit voice.                                      |
| “Findings contradicting deliberate decisions are not findings.”           | Audit boundary.                                        |
| “Select the concrete next action before selecting the skill.”             | Hej routing discipline.                                |
| “A skill name without a concrete object is not a valid suggestion.”       | Hej next-action rule.                                  |
| “Suggest, don’t force.”                                                   | Hej confirmation rule.                                 |
| “Document intended behavior before building.”                             | Dokumentera intent-first mode.                         |
| “Write as intended steady state.”                                         | Evergreen documentation rule.                          |
| “Keep it DRY: reference, don’t repeat.”                                   | Documentation maintenance rule.                        |
| “The harness is the immutable ground truth.”                              | Optimera measurement rule.                             |
| “Improve + pass regression = keep; everything else is discarded.”         | Optimera experiment rule.                              |
| “The orchestrator delegates; it does not implement.”                      | Orkestrera role boundary.                              |

## Ambiguous terms to qualify

Do not use these terms bare. A busy developer should be able to search the
phrase, identify the affected object, and know whether the term describes a
schema concept, runtime capability, install state, or user action.

| Ambiguous term  | Why bare usage is risky                                                                                | Required wording                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Skill           | Confuses v1 standalone skills, the v2 Agentera skill, and internal workflows.                          | Use `Agentera skill` for the installed runtime surface, `v1 skill` for history, and `capability` for v2 workflows.                                                                   |
| Contract        | Could mean schema structure, artifact shape, protocol primitive, adapter behavior, or product promise. | Use `schema contract`, `artifact schema`, `protocol primitives`, `runtime adapter contract`, or `product promise`.                                                                   |
| Status          | Different surfaces use different state machines and output labels.                                     | Use `exit status`, `task status`, `installed-app status`, `install status`, `docs status`, or `health status`.                                                                       |
| Freshness       | Sounds like a branded synonym for several normal states: current, stale, synced, or out of date.       | Use object-specific state wording such as `artifact is current`, `Agentera app files need repair`, `docs are current`, or `plan-level current-state check`.                          |
| Checkpoint      | In software, can mean commit, savepoint, restore point, model checkpoint, or milestone.                | Use `final state sync`, `plan-level current-state check`, `checkpoint commit`, or `pre-dispatch checkpoint commit`.                                                                  |
| Stale           | The cause and fix differ by object.                                                                    | Use `stale artifact`, `Agentera app files need repair`, `stale marker`, or `stale worktree base`. Avoid `stale` in recovery prompts when `out of date` or `needs repair` is clearer. |
| Phase           | Conflicts with numbered workflow steps.                                                                | Use `phase` only for protocol lifecycle: `envision`, `deliberate`, `plan`, `build`, `audit`. Use `step` for capability-local actions.                                                |
| Objective state | Clear only inside optimera.                                                                            | First mention `optimization objective state`; then `objective state` is fine in optimera context. Do not modify outside optimera or explicit user instruction.                       |
| Support         | Could mean theoretical host capability, shipped Agentera wiring, or verified behavior.                 | Use `host capability`, `Agentera adapter support`, or `tested support`.                                                                                                              |
| Runtime support | Too broad to be actionable in compatibility docs.                                                      | Replace with `host capability`, `Agentera adapter support`, or `tested support`, whichever is true.                                                                                  |
| AskUserQuestion | Internal primitive leaking into human prose.                                                           | In user docs, say `ask the user`. In adapter docs, say `runtime question tool`.                                                                                                      |
| MCP             | Optional substrate, not a core Agentera requirement.                                                   | Say `optional MCP integration` only where the feature literally depends on MCP.                                                                                                      |

High-risk diagnostic rewrites:

| Avoid in diagnostics            | Use instead                                                           |
| ------------------------------- | --------------------------------------------------------------------- |
| `bundle freshness gap detected` | `Agentera app files need repair`                                      |
| `bundle freshness guard failed` | `install status check failed`                                         |
| `bundle refresh required`       | `repair Agentera app files`                                           |
| `app refresh required`          | `Agentera app files need repair` or `Agentera app files are outdated` |
| `upgrade guard triggered`       | `v1 migration check found legacy files`                               |
| `stale marker`                  | `missing or outdated version marker`                                  |
| `artifact freshness failed`     | `artifact is stale` or `artifact needs sync`                          |

## Source index

High-signal source surfaces for this vocabulary:

| Source                                                        | Vocabulary surface                                                                                                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/agentera/SKILL.md`                                    | Routing entry, routing layers, CLI-first access, installed-app status check, and v1 migration check.                                                                                      |
| `skills/agentera/protocol.yaml`                               | Protocol primitives, glyphs, phases, visual tokens, exit signals.                                                                                                                         |
| `skills/agentera/capability_schema_contract.yaml`             | Schema groups, priorities, stable IDs, primitive-reference fields.                                                                                                                        |
| `packages/cli/src/capabilities/*/instructions.ts`             | Workflow grammar, capability roles, safety rails, exit marker forms. Loaded as a default-exported string constant; runtime serves it via `agentera prime --context <name> --format json`. |
| `skills/agentera/capabilities/*/schemas/*.yaml`               | Trigger patterns, artifact roles, validation rules, exit conditions.                                                                                                                      |
| `skills/agentera/schemas/artifacts/*.yaml`                    | Artifact fields, status enums, validation vocabulary, and protected current-state fields.                                                                                                 |
| `references/artifacts/artifact-registry-interface-model.yaml` | Canonical artifact registry language.                                                                                                                                                     |
| `references/cli/app-lifecycle-vocabulary.yaml`                | App lifecycle canonical status and operation vocabulary authority.                                                                                                                        |
| `references/cli/update-channels.yaml`                         | Update channel resolution and override-key authority.                                                                                                                                     |
| `references/cli/bundle-skill-vocabulary.yaml`                 | Bundle and `SKILL.md` concept classification authority.                                                                                                                                   |
| `references/cli/capability-instruction-contract.yaml`         | Decision 57 capability instruction-file and first-invocation read contract authority.                                                                                                     |
| `references/cli/routing-execution-vocabulary.yaml`            | Routing and execution vocabulary authority.                                                                                                                                               |
| `the agentera CLI`                                            | Flat State CLI labels and `agentera hej` source contract.                                                                                                                                 |
| `packages/cli/src/upgrade (doctor/upgrade)`                   | Upgrade and doctor output grammar.                                                                                                                                                        |
| `packages/cli/src/state/installRoot.ts`                       | Install-root classification semantics.                                                                                                                                                    |
| `hooks/validate_artifact.py`                                  | Runtime artifact-write validation and hook exit codes.                                                                                                                                    |
| `README.md`                                                   | Product, invocation, artifact, and user-facing capability language.                                                                                                                       |
| `UPGRADE.md`                                                  | Upgrade flow, package refresh, app-home repair, and runtime migration terms.                                                                                                              |
| `DESIGN.md`                                                   | Visual identity, glyph, severity, confidence, and structural token language.                                                                                                              |
| `.agentera/docs.yaml`                                         | Current documentation registry, mapping, coverage, and audit vocabulary.                                                                                                                  |
| `.agentera/decisions.yaml`                                    | Decision grammar, v2 architecture rationale, routing decisions.                                                                                                                           |
| `.agentera/progress.yaml`                                     | Cycle, evidence, context, and final state-sync examples.                                                                                                                                  |
| `.agentera/health.yaml`                                       | Audit dimensions, grades, trajectories, findings, and artifact current-state review.                                                                                                      |
| `.agentera/archive/*.md`                                      | Historical plan-level current-state checks and staleness rationale.                                                                                                                       |
| `.agentera/optimera/*`                                        | Objective, experiment, harness, metric, and keep/discard examples.                                                                                                                        |
| `fixtures/semantic/*.md`                                      | Semantic eval fixture, oracle, and Hej dashboard constraints.                                                                                                                             |
| `tests/`                                                      | Regression evidence for CLI labels, installed-app status, routing, exits, and schema contracts.                                                                                           |

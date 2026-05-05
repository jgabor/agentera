# Gap Analysis: ROADMAP.md and Decisions 39-42

<!-- Date: 2026-05-05 | Status: repaired/current | Scope: Agentera 2.0 main worktree plus v2.0.1 compatibility correction -->

## Reliability Status

This gap analysis is now reliable for the current worktree as of the verification listed below. The earlier version was not reliable: it still claimed `hooks/common.py` used v1 paths, counted 507 passing tests, treated a blank Decision 41 as complete evidence, and pointed to missing v1 helper scripts.

Post-release transcript review of OpenCode session `ses_2080d5c94ffeaOL51P6gQ0CwtF` found one additional v2.0.0 upgrade gap: after `npx skills update`, `/agentera` was treated as prompt text and the runtime loaded the stale v1 `/hej` skill from `~/.agents/skills/hej`. The v2.0.1 correction adds a legacy `skills/hej` bridge, an OpenCode managed `/hej` bridge command, and package-refresh commands that install both `/agentera` and the legacy bridge.

Current verification:

| Check | Result |
|---|---|
| `uv run --with pytest --with pyyaml pytest -q` | PASS: 538 passed, 1 skipped |
| `uv run scripts/validate_capability.py --self-validate` | PASS |
| `uv run scripts/validate_capability.py skills/agentera/capabilities/<all 12>` | PASS |
| `uv run scripts/smoke_setup_helpers.py` | PASS |
| `uv run scripts/smoke_live_hosts.py` | PASS, including offline profilera Codex corpus audit |
| `uv run scripts/smoke_live_hosts.py --live --yes` | PASS: Codex AGENTERA_HOME/query, Codex apply_patch hooks, Copilot AGENTERA_HOME/query, OpenCode AGENTERA_HOME/query via `opencode run --pure`; config, shell rc, and OpenCode auth snapshots restored |
| `uv run scripts/validate_cross_capability.py` | PASS: cross-capability artifact graph ok |
| `uv run scripts/measure_token_payload.py` | PASS: v2 315,974 bytes vs v1 352,213 bytes, -10.3%; revised -10% release target exceeded |
| `node scripts/smoke_opencode_bootstrap.mjs` | PASS |
| `uv run scripts/validate_lifecycle_adapters.py --check-uv-runtime` | PASS |
| `HOME=<tmp> OPENCODE_CONFIG_DIR=<tmp>/opencode uv run scripts/detect_stale_v1` | PASS: no stale runtime artifacts found in a clean temp home |
| `uv run scripts/agentera upgrade --only cleanup --dry-run --json` | PASS: current host reports 12 pending managed OpenCode v1 command removals; not applied without `--yes` |
| `uv run scripts/agentera query --list-artifacts` | Lists all 12 artifact types |
| `uv run scripts/agentera query decisions --topic benchmark` | Returns Decision 41 benchmark result |
| `uv run scripts/agentera query plan` | Returns artifact-specific plan summary and task status counts |
| `uv run scripts/agentera query last-phase` / `uv run scripts/agentera query progress --limit 1` | Returns the newest cycle from newest-first progress YAML |
| `uv run scripts/agentera upgrade --help` | Lists the v1-to-v2 upgrade subcommand and phase/runtime controls |
| `uv run scripts/agentera upgrade --only artifacts --project /tmp/agentera-upgrade-empty-project --dry-run --json` | PASS: no-op plan for a project with no v1 artifacts |
| `uv run scripts/agentera upgrade --only packages --runtime opencode --json` | PASS: external package update is skipped unless explicitly opted in |
| `uvx --from . agentera upgrade --only bundle --home <tmp> --yes --json` | PASS: built wheel installs a durable bundle at `<tmp>/.agents/agentera` from the packaged source |
| `uv run --with pytest --with pyyaml pytest -q tests/test_runtime_adapters.py tests/test_upgrade_cli.py tests/test_setup_doctor.py tests/test_smoke_installed_skills.py` | PASS: 81 passed |
| `npx skills add . --list` / `npx skills add . --list --full-depth` | PASS: repo exposes active `agentera` and legacy `hej` bridge |
| isolated `npx skills add . --skill agentera` and `--skill hej` | PASS: both install; installed `hej` keeps `legacy_bridge: true` and `agentera upgrade` guidance |
| v1 residue scans | PASS: no active missing-reference/template pointers, no stale physical v1 paths outside intentional migration detection/tests |

## ROADMAP.md Phase 1: Infrastructure

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Define capability schema contract | Complete | `skills/agentera/capability_schema_contract.yaml`; self-validation passes | None |
| Define shared protocol schema | Complete | `skills/agentera/protocol.yaml` | None |
| Build universal query CLI scaffold | Complete | `scripts/agentera` supports `prime`, `query`, `query --list-artifacts`, docs.yaml path overrides, active objective lookup, and artifact-specific summaries | None |
| Define agent-facing artifact schemas | Complete | `skills/agentera/schemas/artifacts/*.yaml` | None |
| Build artifact migration tool | Complete | `scripts/migrate_artifacts_v1_to_v2`; `scripts/agentera upgrade --only artifacts`; migration and upgrade tests pass | None |
| Rewrite hook to validate against schemas | Complete | `hooks/validate_artifact.py`; `tests/test_hook_v2.py` covers adapter routing, YAML validation, duplicate numbers, blank Decision 41 regression | None |
| Set up v2 branch/worktree | Complete | v2 work was integrated into main; current release worktree is `$HOME/git/agentera` | None |

Phase 1 verdict: complete.

## ROADMAP.md Phase 2: Core Capabilities

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Port all 12 capabilities | Complete | Every capability has `prose.md` and four schema files; all capability validators pass | None |
| hej becomes master entry behavior | Complete with split ownership | `skills/agentera/SKILL.md` is the dispatcher; `capabilities/hej/prose.md` owns state-aware briefing and v1 detection | None |
| Keep one bundled skill | Complete with legacy bridge | `registry.json` keeps only `agentera` as the active bundled skill; `skills/hej/SKILL.md` is a v1 compatibility bridge that hands users to `/agentera` and `agentera upgrade` | None |

Phase 2 verdict: complete.

## ROADMAP.md Phase 3: Integration

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Cross-capability dependency resolution via schemas | Complete | `scripts/validate_cross_capability.py`; `tests/test_validate_cross_capability.py` | None |
| Hook integration with schema validation | Complete | `hooks/common.py` defaults now resolve to `.agentera/*.yaml`; session start/stop tests pass against v2 YAML; OpenCode hard gate denies invalid artifacts | None |
| Query CLI commands for all artifact types | Complete | `scripts/agentera`; `tests/test_query_cli.py`; artifact-specific summaries for plan, progress, decisions, health, docs, session, todo, design, objective, and experiments | None |
| Runtime adapter updates | Complete for offline/package surfaces plus gated Codex/Copilot/OpenCode live smoke | Setup smoke, OpenCode bootstrap smoke, lifecycle metadata validator, and `scripts/smoke_live_hosts.py --live --yes` all pass | Claude Code live smoke is excluded from the required harness until Claude Pro/Max or API access is available |
| Clone-free upgrade path | Complete for v2.0 release-candidate validation | `pyproject.toml` exposes `agentera`; `uvx --from . agentera upgrade --only bundle --home <tmp> --yes --json` installs a durable bundle under `.agents/agentera`; SKILL/hej guidance previews before applying | PyPI publication, if desired, is a release/distribution step rather than a code gap |
| Port tests | Complete for current v2 suite | `538 passed, 1 skipped` | The retired v1 helper tests are intentionally gone; no claim should cite 577 as current |
| Smoke tests across runtimes | Complete for required live harness | Offline setup + OpenCode plugin smoke pass; gated live harness passes for Codex, Copilot, and OpenCode | Claude Code live smoke is future opt-in only because credentials are unavailable |

Phase 3 verdict: complete for offline/package/query surfaces; required live host behavior is proven for Codex, Copilot, and OpenCode. Claude Code live smoke is not a v2.0 release gate without Claude Pro/Max or API access.

## ROADMAP.md Phase 4: Validation and Cutover

| Claim | Status | Evidence | Gap |
|---|---|---|---|
| Full test suite green | Complete | `538 passed, 1 skipped` | None |
| Semantic eval port | Complete | Semantic eval fixtures/tests use v2 YAML paths and pass | None |
| Token consumption benchmark | Complete | Decision 41 and `scripts/measure_token_payload.py` record v1 352,213 bytes vs current v2 315,974 bytes, -10.3%; revised -10% release target exceeded | Further optimization deferred to future versions |
| Version bump to 2.0.x | Complete | Runtime package validators pass; v2.0.1 carries the legacy `/hej` bridge fix | None |

Phase 4 verdict: validation is green; token gate is closed under the revised release target.

## Decisions 39-42

| Decision | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| D39 | One bundled `/agentera` skill with 12 capabilities | Complete | `skills/agentera/SKILL.md`, `skills/agentera/capabilities/` | None |
| D39 | Agent-facing data as structured YAML | Complete | `.agentera/vision.yaml`, `progress.yaml`, `decisions.yaml`, `plan.yaml`, `health.yaml`, `docs.yaml`, `session.yaml`; no active `.agentera/*.md` except this analysis | None |
| D39 | Human-facing root artifacts | Complete | `TODO.md`, `CHANGELOG.md`, `DESIGN.md` at root | None |
| D39 | Universal query seam | Complete for current artifact set | `scripts/agentera query` lists all schemas and has artifact-specific summaries for the workflow-critical artifacts | None |
| D40 | No backward compatibility in active state | Complete | v1 files were removed from active state; migration tests retain fixtures; upgrade CLI can create user backups during migration | No release residue retained in repo |
| D40 | Capability terminology | Complete | Directory and docs use `capabilities/` | None |
| D41 | Record token benchmark | Complete | Decision 41 is populated, queryable, remeasured after release-residue cleanup, and updated to the revised -10% release target | Further optimization is post-v2 work |
| D42 | Five-layer routing model | Complete at specification level | `SKILL.md` routing model and trigger priorities validate | No executable dispatcher scores triggers; routing remains instruction-driven |

## Active Gaps

No release-blocking gaps remain after the 2026-05-05 scope decisions and the v2.0.1 legacy entry-point correction.

Non-blocking follow-ups remain:

1. Additional token optimization can continue in future versions.
   The final remeasurement after the v2.0.1 bridge is v2 315,974 bytes vs v1 352,213 bytes, a 10.3% reduction. The v2.0 release target is revised to -10%, and the current payload exceeds it.

2. Claude Code live smoke is future opt-in only.
   The approved `uv run scripts/smoke_live_hosts.py --live --yes` run passed on 2026-05-05 for Codex AGENTERA_HOME/query, Codex apply_patch hooks, Copilot AGENTERA_HOME/query, and OpenCode AGENTERA_HOME/query via `opencode run --pure`, with snapshots restored. Claude Code live smoke is excluded from the required release harness until Claude Pro/Max or API access is available.

3. The current host still has 12 managed OpenCode v1 command files.
   `uv run scripts/agentera upgrade --only cleanup --dry-run --json` reports only managed v1 command removals under `$HOME/.config/opencode/commands/`. This is not a release blocker because the cleanup phase detects and can remove them, but applying it to the user home still requires `--yes`.

Closed after transcript review:

- Legacy v1 `/hej` interception: OpenCode session `ses_2080d5c94ffeaOL51P6gQ0CwtF` showed `/agentera` loading old v1 `hej` after `npx skills update`. v2.0.1 adds a real `skills/hej` bridge and package-refresh commands for both `/agentera` and `/hej`.

## Closed Questions

- Token target: remeasured at -10.3% after the v2.0.1 bridge; revised -10% release target exceeded, with follow-up optimization deferred to future versions.
- Profilera extraction: v2 now ships `scripts/extract_corpus.py`, and default smoke proves a Codex-shaped offline collection fixture.
- Query seam depth: `scripts/agentera query` now has artifact-specific summaries for plan, progress, decisions, health, docs, session, todo, design, objective, and experiments.
- Producer/consumer validation: `scripts/validate_cross_capability.py` now validates capability artifact declarations against skill-level artifact schemas.
- Live smoke: approved and run on 2026-05-05. `scripts/smoke_live_hosts.py --live --yes` passed for Codex, Copilot, and OpenCode live harness checks; Claude Code live smoke is not part of the required release harness without Claude Pro/Max or API access.
- Follow-up tracking: `TODO.md` closes the v2 token and Claude live-smoke blockers; future token optimization and optional Claude live smoke are non-release-blocking.
- Clone-free upgrade: `pyproject.toml` now makes `agentera` runnable through `uvx`, and packaged upgrades install a durable bundle at `~/.agents/agentera` before wiring runtime config so runtime config does not point at uv's disposable tool cache.

## Resolved Since Earlier Draft

- `hooks/common.py` now resolves v2 YAML paths and reads `.agentera/docs.yaml` mappings.
- `hooks/session_start.py` and `hooks/session_stop.py` now support v2 YAML artifacts; tests pass.
- `hooks/validate_artifact.py` now catches blank list entries and nested required fields, including the blank Decision 41 failure mode.
- Decision 41 now contains the benchmark values and is queryable.
- Decision 41 now includes the 2026-05-05 remeasurement: v2 315,974 bytes vs v1 352,213 bytes, -10.3%, exceeding the revised -10% release target.
- `scripts/validate_cross_capability.py` now gates producer/consumer graph consistency.
- `scripts/extract_corpus.py` restores bundled profilera corpus extraction and `scripts/smoke_live_hosts.py` no longer skips the default profilera corpus audit.
- `scripts/agentera query` now resolves `.agentera/docs.yaml` path overrides, finds the active optimera objective, and renders artifact-specific summaries for workflow-critical artifacts.
- `uv run scripts/smoke_live_hosts.py --live --yes` passed on 2026-05-05 for Codex, Copilot, and OpenCode live harness checks.
- The live smoke harness now copies `agentera_upgrade.py` into temporary Copilot/OpenCode install roots, matching the query CLI's support-module dependency.
- OpenCode artifact hard gate now denies validation-hook failures instead of swallowing non-zero exits.
- Stale active v1 artifacts were removed from the live `.agentera/` root, including the checked-in `.agentera/backup-v1` migration backups.
- README/AGENTS/runtime smoke references to missing v1 scripts were removed or made explicit as deferred.
- Capability prose, schemas, and the shared contract no longer point at missing bundled templates/references or teach v1 Markdown formats for the main agent-facing YAML artifacts.
- `scripts/agentera upgrade` now provides an idempotent v1-to-v2 upgrade path covering artifact migration, runtime config wiring, stale v1 cleanup, explicit package-update opt-in, JSON output, and runtime postflight.
- `scripts/agentera upgrade` now includes a bundle phase for packaged runs, and `uvx --from . agentera upgrade --only bundle --home <tmp> --yes --json` proves the no-clone path installs a durable bundle.
- `SKILL.md` and hej's upgrade guard now instruct agents to detect v1 artifacts, preview the no-clone `uvx --from git+https://github.com/jgabor/agentera agentera upgrade` command, and ask before applying `--yes`.
- OpenCode setup doctor and checked-in managed command fixtures now validate the single `agentera` bundled skill instead of the removed 12 v1 skill commands.
- Codex setup and UI metadata no longer write or advertise removed v1 per-skill agent paths; `--enable-agents` is a compatibility no-op in v2.
- `scripts/agentera query last-phase` and `scripts/agentera query progress --limit 1` now return the newest cycle from newest-first progress YAML.

## Recommended Next Actions

1. Commit the v2.0.1 compatibility correction once final validation passes.
   The worktree now adds the legacy `/hej` bridge, refreshes runtime metadata, and records the transcript-derived gap.

2. Publish the patch release after approval.
   After integration, create and push `v2.0.1` only when explicitly requested. Do not move the existing `v2.0.0` tag.

3. Keep Claude Code live smoke as an opt-in follow-up.
   Claude Code is excluded from the required v2.0 harness until Claude Pro/Max or API credentials are available.

## Overall Verdict

Agentera 2.0 is reliable enough to continue from this gap analysis. The basic v2 cutover is structurally sound: bundled skill shape, YAML artifact paths, schema validation, session hooks, runtime metadata, no-clone upgrade bootstrap, offline smoke checks, cross-capability graph validation, bundled corpus extraction, artifact-specific query summaries, and the current test suite are green.

The final release-candidate validation passed on 2026-05-05, and the transcript-derived legacy entry-point gap is now closed in the v2.0.1 patch work. Remaining release work is procedural: commit, integrate to main, and only create/push `v2.0.1` when explicitly approved.

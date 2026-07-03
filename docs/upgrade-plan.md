# Agentera v3 Upgrade Plan

A comprehensive plan for the v2→v3 upgrade command and the full lifecycle of every artifact it touches. The current implementation (`feat/v3` branch, HEAD `fa8a956b`) handles the bulk of the work; this document records what's already in place, what's still missing against the success invariants, and what to do next.

> **Verification pass + implementation complete.** Every file reference, line number, and code-level claim below was cross-checked against the actual codebase at `feat/v3` HEAD `fa8a956b` (working-tree clean except for the untracked `UPGRADE-v3.md`). All complexity-audit findings (§4.1-4.11), the gate fix (§3.3), the atomicity proposal (§3.4), the `--verify`/`--restore` flags (§3.5), and the failure-scenario tests (§5.3) are now implemented and committed. See Appendix B for the commit ledger. The upgrade command enforces all five success invariants: idempotent (byte-diff driven), atomic (`writeFileAtomic` + `rename`), rollback-safe (`--restore` from snapshot), non-destructive (managed-marker / closed-set guards), and verifiable (`--verify` runs doctor + 12× capability schema checks). Test suite: 1263 tests passing.

The five invariants the upgrade must enforce:

- **Idempotent** — running it twice produces the same result as once
- **Atomic** — either fully completes or rolls back to a known-good state; no partial upgrades
- **Rollback-safe** — if upgrade fails, the system returns to a working v2 state
- **Non-destructive by default** — existing v2 artifacts are preserved or migrated, not silently removed
- **Verifiable** — post-upgrade health check confirms every installed artifact is accounted for and functional

---

## 1. Current state assessment

### 1.1 Two lineages, one cutover

Agentera is being rewritten from a Python-managed app-home (v2, 2.x stable on `main`) to an npm self-contained CLI (v3, 3.x on `feat/v3`). The `upgrade` command has a distinct implementation per lineage, and a one-way v2→v3 migration that bridges them. Return to v2 after crossing into v3+ is permanently unsupported.

The v2 Python upgrade source has been removed from `feat/v3`; only `scripts/__pycache__/*.pyc` artifacts remain on disk. The v3 TypeScript implementation is what runs from `feat/v3` and from any installed `agentera@next` npm package.

### 1.2 v2 (Python) upgrade mechanism — lives on `main`

`scripts/agentera_upgrade.py` (2785 lines) is the v2 orchestrator, imported by `scripts/agentera`.

**Phases** (`PHASES = ("bundle", "artifacts", "runtime", "cleanup", "packages")`, line 36):

| Phase | Plan | Apply | Idempotency mechanism | Backup |
|---|---|---|---|---|
| bundle | `plan_bundle_phase` (line 1008) | `apply_bundle_phase` (line 1128) | SHA-256 byte comparison per file (line 1077) | none |
| artifacts | `plan_artifact_phase` (line 1250) | `apply_artifact_phase` (line 1306) | v1 Markdown absent after migrate | `.agentera/backup-v1/<rel>` (line 1218) |
| runtime | `plan_runtime_phase` (line 1697) | `apply_runtime_phase` (line 1942) | SHA-256 + ownership marker | none |
| cleanup | `plan_cleanup_phase` (line 1987) | `apply_cleanup_phase` (line 2040) | re-runs `detect.fix_findings` | none |
| packages | `plan_package_phase` (line 2085) | `apply_package_phase` (line 2123) | external package manager | n/a (external) |

**Lifecycle statuses** (lines 40-47): `APP_UP_TO_DATE`, `APP_OUTDATED`, `APP_REPAIR_NEEDED`, `APP_MIGRATION_NEEDED`, `APP_MANUAL_REVIEW_NEEDED`, `APP_READY_TO_APPLY`, `APP_APPLIED`, `APP_NO_CHANGES_NEEDED`. Per-item workflow statuses (line 38): `pending`, `applied`, `noop`, `blocked`, `failed`, `skipped`.

**Per-runtime install targets** (per `plan_runtime_phase`):

- Codex: `~/.codex/config.toml` (`setup_codex.plan_change`), `~/.codex/hooks/codex-hooks.json` (copied; later retired when plugin hooks are trusted), `~/.codex/agents/<name>.toml` (from `skills/agentera/agents/`)
- OpenCode: `$OPENCODE_CONFIG_DIR/plugins/agentera.js`, `.../commands/*.md` (excluding `hej` via `LEGACY_OPENCODE_BRIDGE_COMMANDS = {"hej"}`, line 37), `.../agents/*.md`, `.../skills/{agentera,hej}` (symlinks)
- Cursor: `<project>/.cursor/hooks.json`, `<project>/.cursor/agents/*.md` (skipped en bloc when v3 capability modules exist, line 1818), `<project>/.cursor-plugin/plugin.json`
- Copilot: read-only diagnostic; never edits `~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`
- Claude: noop-only reporter; no local config writes

**Idempotency**: Three layers — bundle marker version (`install_root.py:215-225`), SHA-256 per file at apply time, and a CLI probe of `scripts/agentera --help` greps `prime` (`_probe_bundle_cli` at upgrade line 352).

**Backup**: Only the artifacts phase takes a backup — v1 Markdown content is copied to `<project>/.agentera/backup-v1/<rel>` before YAML conversion. Bundle and runtime writes overwrite in place with no snapshot.

**`--force` semantics**: Bypasses the unrecognized-directory block (bundle), the backup-collision block (artifacts), and the user-owned target block (runtime). Does **not** overwrite a divergent backup — an existing backup with different content is preserved and migration proceeds (line 1332 condition is `force or not backup.exists()`).

**Rollback**: **None.** No snapshots, no transaction boundaries, no manifest of pre-upgrade state. `v3-handoff.json` (`_refresh_v3_handoff_manifest` at line 2494) is a forward-only handoff manifest for v3, not a recovery point. Per-item try/except marks failures; the user re-runs `upgrade --yes` after fixing the issue. Recovery only works for *additive* operations (link-skill, rewire-runtime text) — destructive operations like `remove-managed-app-home` are not re-entrant on partial failure.

**App-home user state**: `_app_home_is_user_data_only` (line 278) recognizes a closed allowlist: `PROFILE.md`, `USAGE.md`, `corpus.json`, `TODO.md`, `CHANGELOG.md`, `DESIGN.md` (files); `history`, `corpus` (dirs); `.agentera/` recursively (only if every entry is `progress.yaml`, `decisions.yaml`, `health.yaml`, `plan.yaml`, `docs.yaml`, or an `optimize`/`optimera` legacy objective subdir). The handoff manifest's `USER_DATA_DIRS` (`v3_handoff_manifest.py:23`) is broader (`benchmarks`, `intermediate`, `sessions`, `history`, `corpus`) and creates the Gap 9 mismatch documented in §4.

### 1.3 v3 (TypeScript) upgrade mechanism — `feat/v3`

`packages/cli/src/upgrade/upgradeOrchestrator.ts` is the v3 orchestrator.

**Phases** (`UpgradePhaseName = "detect" | "artifacts" | "runtime" | "cleanup"`, line 42):

| Phase | Plan | Apply | Idempotency mechanism | Backup |
|---|---|---|---|---|
| detect | inline in `buildDetectPhase` (line 161) | n/a (read-only) | n/a | n/a |
| artifacts | `planArtifactsPhase` (`migrateArtifactsV2ToV3.ts:167`) | `applyArtifactsPhase` (`:198`) | v1 source absent after migrate | `.agentera/backup-v1/<basename>` |
| runtime | `planRuntimeMigrationItems` (`runtimeMigration.ts:587`) | `applyRuntimeMigrationItem` per item (`:625`) | `copyIfChanged` byte comparison (`:200`) | none |
| cleanup | `planCleanupPhase` (`migrateArtifactsV2ToV3.ts:270`) | `applyCleanupPhase` (`:333`) | re-run detection | none |

**Orchestrator gate** (`upgradeOrchestrator.ts:240-245`):
```ts
const pendingRuntimeSync = pendingRuntimeMigrationItems(migrationCtx).length > 0;
const pendingV1Artifacts = detectV1ArtifactPairs(project).length > 0;
const runMigration = crossMajorMigration || pendingRuntimeSync || pendingV1Artifacts;
```

The cleanup phase is **only** triggered when `runMigration` is true. If a user has only stale commands/skills/agents and nothing else, `runMigration` may be false (see §4.1) and cleanup never runs.

**Per-runtime install targets** (v3, per `planRuntimeMigrationItems`):

- Codex: `~/.codex/hooks/codex-hooks.json` + `~/.codex/config.toml` (rewire via `pushRewireItem`); retire copied hooks when plugin hooks enabled
- OpenCode: `$OPENCODE_CONFIG_DIR/plugins/agentera.js`, `.../commands/<name>.md` (closed set `["agentera"]`, `runtimeMigration.ts:53`), `.../agents/agentera.md`, `.../skills/{agentera,status}` (symlinks)
- Cursor: project + home `.cursor/hooks.json`; project `.cursor/agents/agentera.md` (skipped when v3 instruction modules exist); project `.cursor-plugin/plugin.json`
- Copilot: `<project>/.github/hooks/{preToolUse,postToolUse,sessionStart,sessionEnd}.json` (4 files)
- Claude: noop-only reporter

**App-home model** (`appModel.ts:97` `doctorRoots`):
- `appHome` = the install root (e.g., `~/.local/share/agentera`)
- `managedAppRoot` = `<appHome>/app` (v2 Python bundle lives here)
- `activeBundleRoot` = first of `managedAppRoot` (if `hasBundleRootEvidence`), `managedAppRoot` (fallback), `appHome` (if `hasBundleRootEvidence`), `appHome` (fallback)
- `skillRoot` = `<activeBundleRoot>/skills/agentera`
- `runtimeRoot` = `resolveSourceRoot()`

**User state recognized** (`doctor.ts:113-128`):
- Files: `PROFILE.md`, `USAGE.md`, `corpus.json`, `TODO.md`, `CHANGELOG.md`, `DESIGN.md`, `v3-handoff.json`
- Dirs: `history`, `corpus`, `benchmarks`, `intermediate`, `sessions`
- `.agentera/` validated recursively (5 YAML names + `optimize`/`optimera` legacy objective subdirs)

**Channels**: `channels.ts:228` `resolveUpdateChannel` returns `stable` → `@latest` (v2) or `development` → `@next` (v3). Channel determines which migration operations are gated. `compatibility.ts:213` `crossMajorBoundaryApplies` returns true when install is v2-managed and running CLI ≥ v3.

### 1.4 What's already been done on `feat/v3`

The `feat/v3` branch has shipped the upgrade-pipeline commits since `main`. Each closes one item from `UPGRADE-v3.md` and has a dedicated test. Gap 9 (Phase 12) landed in `fa8a956b` and is committed, not in the working tree:

| Commit | Fix | Files | Test |
|---|---|---|---|
| `808b3403` | Remove redundant `projectHasPendingRuntimeRewire` gate | `projectIntegration.ts`, `upgradeOrchestrator.ts` | existing tests |
| `c46c4a24` | Unify `--only` handling; remove auto-narrowing | `upgradeOrchestrator.ts` | `upgradeOrchestrator.test.ts` |
| `a53ef010` | Reduce integration scenario model from 11 to 3 | `projectIntegrationDecision.ts` | scenario tests |
| `c51d7b09` | Byte comparison for `copy-command` idempotency | `runtimeMigration.ts` | `migrateRuntimeMatrix.test.ts` |
| `d48db8f7` | Reduce plugin `REQUIRED_AGENT_NAMES` to single agent | `.opencode/plugins/agentera.js` | plugin tests |
| `27881dcd` | Remove dangling/stale Agentera skill symlinks | `runtimeMigration.ts` | `staleSkillCleanup.test.ts` |
| `8eef7fff` | Remove stale managed commands | `runtimeMigration.ts` | `staleCommandCleanup.test.ts` |
| `2945ddbf` | Clean orphaned v2 per-capability agents | `legacyAgentCleanup.ts` | `legacyAgentCleanup.test.ts` |
| `7b9528a2` | Remove `rewire-env-var` (eliminate sequencing bug) | `runtimeMigration.ts` | `pushRewireItemGap.test.ts` |
| `e27d2819` | Skip non-Agentera config files instead of blocking | `runtimeMigration.ts` | rewire tests |
| `50473b70` | Clean stale `dist/` before build | `packages/cli/package.json` | build verification |
| `fa8a956b` | Gap 9: `v3-handoff.json` recognition, source-checkout short-circuit, install-content refresh for user-data-only roots, byte-comparison fix for `copy-plugin` | `appContentRefresh.ts`, `compatibility.ts`, `doctor.ts`, `runtimeMigration.ts` | `doctor.test.ts` (`:229-285`) |

`5cde9937` (plan runtime sync items for source checkouts) and `9fa81ef4` (release bump to 3.0.0-dev.8) are also on `feat/v3` above the listed substantive fixes.

### 1.5 What `UPGRADE-v3.md` describes vs what is in the code today

`UPGRADE-v3.md` at the repo root is a prior gap analysis. Several of its "to do" items are already implemented and need to be marked done before the doc is used as a work plan:

- OE-1 / Phase 10 (`projectHasPendingRuntimeRewire` removed): DONE (`808b3403`)
- OE-2 / Phase 8 (11→3 scenarios): DONE (`a53ef010`)
- OE-3 / Phase 9 (auto-narrowing removed): DONE (`c46c4a24`)
- OE-5 (`RUNTIME_MIGRATION_ACTIONS` removed): NOT DONE — see §4.1
- OE-4 (`opencodeCommandTemplate` removed): NOT DONE — see §4.2

Gaps 1-8 (cleanup of stale commands/skills/agents/dist, blocked-noise, plugin `REQUIRED_AGENT_NAMES`, etc.): DONE.
Gap 9 (v3-handoff.json + source-checkout short-circuit + user-data-only install): committed in `fa8a956b`; tests in `packages/cli/test/upgrade/doctor.test.ts:229-285`.

---

## 2. Artifact inventory

Every artifact type that v2 installed and that v3 touches during the upgrade. For each: (a) where v2 instances live, (b) how v3 discovers them, (c) migration policy, (d) post-upgrade verification.

### 2.1 Commands

| Item | Value |
|---|---|
| v2 source | `~/.config/opencode/commands/agentera.md` plus legacy bridge `hej.md` (from `COMMAND_TEMPLATES.hej` in plugin) |
| v3 source | `.opencode/commands/agentera.md` |
| v3 install path | `$OPENCODE_CONFIG_DIR/commands/agentera.md` |
| Closed set | `OPENCODE_COMMAND_NAMES = ["agentera"]` (`runtimeMigration.ts:53`) |
| Drift detection | byte comparison (`copyIfChanged`, `runtimeMigration.ts:200`) |
| Stale cleanup | `planStaleCommandCleanupItems` (`:467`) → `action: "remove-stale-command"`; only files with `agentera_managed: true` frontmatter |
| Migration policy | Replace managed `agentera.md` on drift; remove managed stale commands outside the closed set; never touch user-owned commands |
| Verification | `diagnoseOpencodeCommands` (`setup/doctor/opencode.ts:81`); `agentera prime --context <name> --format json` returns `schema_error: null` |

### 2.2 Agents — three sub-types

#### 2.2.1 v2 Swedish-verb agents (12)

| Item | Value |
|---|---|
| Names | `dokumentera.md`, `hej.md`, `inspektera.md`, `inspirera.md`, `optimera.md`, `orkestrera.md`, `planera.md`, `profilera.md`, `realisera.md`, `resonera.md`, `visionera.md`, `visualisera.md` |
| Constant | `V2_SWEDISH_VERB_AGENT_FILES` (`legacyAgentCleanup.ts:14`) |
| v2 location | `~/.config/opencode/agents/` and `<project>/.cursor/agents/` |
| Marker | none — identified by closed set |
| Discovery | `scanLegacySwedishVerbAgentPaths` (`legacyAgentCleanup.ts:92`) |
| Migration policy | REMOVE; no marker required |

#### 2.2.2 v2 English-named per-capability agents (12)

| Item | Value |
|---|---|
| Names | `audit.md`, `build.md`, `design.md`, `discuss.md`, `document.md`, `optimize.md`, `orchestrate.md`, `plan.md`, `profile.md`, `research.md`, `status.md`, `vision.md` |
| Constant | `V2_ENGLISH_CAPABILITY_AGENT_FILES` (`legacyAgentCleanup.ts:40`) |
| v2 location | `~/.config/opencode/agents/` and `<project>/.cursor/agents/` |
| Marker | `<!-- agentera: managed -->` (managed marker required) |
| Discovery | `scanLegacyCapabilityAgentPaths` (`legacyAgentCleanup.ts:115`) |
| Migration policy | REMOVE only when managed marker present (unmanaged user files preserved) |

#### 2.2.3 v3 single managed primary agent

| Item | Value |
|---|---|
| Source per runtime | `.opencode/agents/agentera.md`, `.cursor/agents/agentera.md` |
| Install path | `~/.config/opencode/agents/agentera.md`, `<project>/.cursor/agents/agentera.md` |
| Marker | `<!-- agentera: managed -->` |
| Plugin closed set | `REQUIRED_AGENT_NAMES = ["agentera"]` (`.opencode/plugins/agentera.js:21`) |
| Drift detection | byte comparison (`copyIfChanged`); for Cursor, requires marker on existing file (`hasCursorManagedAgentMarker`, `runtimeMigration.ts:196`) |
| Cursor skip | `projectUsesV3CapabilityInstructionModules` (`v3CapabilitySurface.ts:14`) returns `skipped` when all 12 `packages/cli/src/capabilities/<name>/instructions.ts` files exist |
| Migration policy | Replace on drift; Cursor projects with v3 modules skip (in-tree agents use `prime --context`) |
| Verification | `scanLegacySwedishVerbAgentViolations` (`legacyAgentCleanup.ts:137`); `validAgentDescriptor` (`.opencode/plugins/agentera.js:172`) |

### 2.3 Skills

| Item | Value |
|---|---|
| Closed set | `OPENCODE_SKILL_NAMES = ["agentera", "status"]` (`runtimeMigration.ts:54`) |
| Source | `skills/<name>/SKILL.md` per name; `skills/agentera/{SKILL.md, protocol.yaml, capability_schema_contract.yaml}` plus 48 capability schema YAMLs |
| Install path | symlink at `$OPENCODE_CONFIG_DIR/skills/<name>` → `<sourceRoot>/skills/<name>` |
| Drift detection | planning: `readlinkSync` target comparison wrapped in try/catch (ENOENT distinguishes broken/missing); apply-time `lstatSync` (`runtimeMigration.ts:665`) guards the symlink-replace path |
| Stale cleanup | `planStaleSkillCleanupItems` (`runtimeMigration.ts:504`) → `action: "remove-stale-skill"` for symlinks whose target resolves into `agentera` but whose name is not in the closed set |
| Non-symlink replacement | `link-skill` action replaces real dirs/files with symlinks |
| Migration policy | Replace stale symlinks; remove legacy bridges (`hej` is the prime candidate); create missing required symlinks |
| Verification | `diagnoseOpencodeSkillPaths` (`setup/doctor/opencode.ts:136`); plugin `bootstrapSkills` re-runs at OpenCode init |

### 2.4 Plugins

#### 2.4.1 OpenCode plugin

| Item | Value |
|---|---|
| Source | `.opencode/plugins/agentera.js` (970 lines) |
| Install path | `~/.config/opencode/plugins/agentera.js` |
| Drift detection | byte comparison (post `c51d7b09`); falls back to text-content checks for Python-managed entrypoint patterns (`textUsesPythonManagedEntrypoint`, `runtimeMigration.ts:87`) |
| Migration policy | Replace on drift; never touch user-owned plugins (no marker) |
| Verification | `diagnoseOpencode` (`setup/doctor/opencode.ts:312`) |

#### 2.4.2 Cursor plugin manifest

| Item | Value |
|---|---|
| Source | `.cursor-plugin/plugin.json` |
| Install path | `<project>/.cursor-plugin/plugin.json` |
| Drift detection | byte comparison |
| Migration policy | Replace on drift |

#### 2.4.3 Codex, Claude, Copilot manifests

- Codex: `.codex-plugin/plugin.json` is **not** installed to a project location in v3; the runtime touch is `~/.codex/config.toml` + `~/.codex/hooks/codex-hooks.json`
- Claude: `.claude-plugin/marketplace.json`; no local install; `noop` "configure" item (`planEnvRuntimeNoops` call begins `:610`)
- Copilot: no plugin manifest; hook-only

### 2.5 Hooks

| Runtime | Source | Install target | Discovery | Migration policy |
|---|---|---|---|---|
| OpenCode | in-plugin (no files) | in-plugin via `experimental.session.compacting` etc. | n/a | plugin install handles this |
| Cursor | `.cursor/hooks.json` (camelCase events) | `<project>/.cursor/hooks.json`, `~/.cursor/hooks.json` | `planCursorItems` (`:265`) | Rewire Python-managed entrypoint refs → `npx -y agentera@<channel> hook …` |
| Codex | n/a (plugin-bundled) | `~/.codex/config.toml` (AGENTERA_HOME injection + plugin trust), `~/.codex/hooks/codex-hooks.json` (retired when plugin hooks enabled) | `planCodexItems` (`:216`) | Rewire; strip `AGENTERA_HOME = "…"` from `config.toml`; retire Agentera-only copied hooks |
| Copilot | `.github/hooks/*.json` (walked recursively; `preToolUse`/`postToolUse`/`sessionStart`/`sessionEnd` are illustrative, not enforced) | same paths in project | `planCopilotItems` (`:562`), `walkJsonHookFiles` (`:542`) | Rewire entrypoint |
| Claude | n/a | n/a | `planEnvRuntimeNoops` (`:581`; Claude call begins `:610`) | Noop-only |
| v2 installed hooks | `<appHome>/hooks/*.py`, `<appHome>/app/hooks/*.py` | n/a — RETIRE | `listInstalledHookDirs` (`installedHooksRetirement.ts:27`) | REMOVE the entire `hooks/` directory |

### 2.6 Project artifacts (`.agentera/*.yaml`)

| v2 (preserved) | v1 Markdown (migrated) |
|---|---|
| `progress.yaml`, `plan.yaml`, `decisions.yaml`, `health.yaml`, `docs.yaml`, `vision.yaml` | `PROGRESS.md`, `PLAN.md`, `DECISIONS.md`, `HEALTH.md`, `DOCS.md`, root `VISION.md` |

- v1→v2 migration: `planV1ArtifactsPhase` (`migrateArtifactsV1ToV2.ts:485`) parses, archives source to `.agentera/backup-v1/<basename>`, writes YAML target, then `unlinkSync`s source.
- v2→v3 schema change: **none.** `planArtifactsPhase` (`migrateArtifactsV2ToV3.ts:167`) emits `action: "preserve", status: "noop"` ("v2 YAML artifact preserved; no v2→v3 schema migration required").
- Discovery: `detectV1ArtifactPairs` (`:136`); only flags a v1 source if the YAML counterpart does not yet exist.
- Verification: `agentera check validate capability <name>`; `agentera check compact` enforces artifact budgets.

### 2.7 App-home (install root)

#### 2.7.1 Managed bundle under `app/` (v2 Python)

| Path | Purpose | v3 disposition |
|---|---|---|
| `app/scripts/agentera` | v2 Python CLI entry | REMOVED via `remove-managed-app-home` |
| `app/skills/agentera/SKILL.md` | v2 markdown skill (Swedish-verb body) | REPLACED via `refresh-app-content` |
| `app/hooks/*.py` | v2 Python hook scripts | RETIRED via `retire-installed-hooks` |
| `app/registry.json` | bundle evidence | REPLACED |
| `app/references/` | docs | REPLACED |
| `app/dist/capabilities/` | v3 build artifact (sometimes) | REPLACED |
| `app/.agentera-bundle.json` | v2 bundle marker | REMOVED with `app/` |

#### 2.7.2 Handoff manifest

- `v3-handoff.json` at app-home root (schema `agentera.v3_handoff_manifest.v1`) — written by v2 during v2→v3 migration. Records `installed_v2_version`, `app_home_path`, `user_data_inventory`, `runtime_adapters`. Used to gate `remove-managed-app-home` to preserve recognized user state. **Recognized as user state** in `ROOT_USER_STATE_FILE_NAMES` (`doctor.ts:120`); the predicate `appHomeIsUserDataOnly` consumes that set at `doctor.ts:162-188`.

#### 2.7.3 NPM pack marker

- `.agentera-bundle.json` at app-home root — same path as v2 bundle marker, but written by v3 npm pack/refresh. Carries managed-fresh identity. Detected by `bundleMarkerAtActiveRoot` (`compatibility.ts:127`).

#### 2.7.4 Self-contained npx bundle

- `.agentera-npx-bundle.json` sentinel at source root (`core/sourceRoot.ts:10`) — npx-installed bundles are always current (`isNpxBundleRoot` short-circuit at `doctor.ts:227`); the bundle IS the app, no upgrade step.

#### 2.7.5 User state

- Root files: `PROFILE.md`, `USAGE.md`, `corpus.json`, `TODO.md`, `CHANGELOG.md`, `DESIGN.md`, `v3-handoff.json`
- Root dirs: `history`, `corpus`, `benchmarks`, `intermediate`, `sessions`
- `.agentera/` subdir: 5 YAML files + `optimize`/`optimera` legacy objective subdir

### 2.8 Capabilities (12 logical capabilities)

Names enumerated in: `registry.json`, `skills/agentera/SKILL.md` (frontmatter), `packages/cli/src/capabilities/index.ts`, `skills/agentera/capability_schema_contract.yaml` (ROUTE_ALIASES), `skills/agentera/protocol.yaml` (SKILL_GLYPHS).

Canonical English names: **status, vision, discuss, research, plan, build, optimize, audit, document, profile, design, orchestrate**.

| Source | Purpose |
|---|---|
| `packages/cli/src/capabilities/<name>/instructions.ts` (12 files) | TypeScript source; barrel in `index.ts:19-32` |
| `skills/agentera/capabilities/<name>/schemas/{triggers,artifacts,validation,exit}.yaml` (48 files) | Per-capability contract schemas |
| `packages/cli/dist/capabilities/<name>/instructions.js` | Compiled bundle, copied to `<installRoot>/dist/capabilities/` |

Drift detection: `distCapabilitiesStale` (`appContentRefresh.ts:196`) compares each of the 12 `instructions.js` files byte-by-byte against the installed copy.

V2 detection in source text: `V2_CAPABILITY_VERBS` (`appContentRefresh.ts:31`) is the 12 Swedish-verb list; `skillMdLooksV2` and `contractLooksV2` flag SKILL.md/contract content that mentions Swedish verbs or `instructions.md` (the v2 markdown module path that v3 replaced with `instructions.ts`).

### 2.9 Migration policy summary

| Artifact | Migrate | Replace | Remove | Preserve |
|---|---|---|---|---|
| v1 Markdown (PROGRESS/PLAN/etc.) | yes (→ YAML, backup to `.agentera/backup-v1/`) | — | — | backup kept |
| v2 YAML (project artifacts) | — | — | — | yes (no schema change) |
| v3 SKILL.md / protocol / contract / schemas / references / registry.json / dist | — | yes (byte-diff driven) | — | — |
| v2 Swedish-verb agents | — | — | yes (closed set, no marker) | user-owned not in set |
| v2 English-capability agents | — | — | yes (closed set + managed marker) | user-owned without marker |
| v3 single `agentera.md` agent | — | yes (byte-diff) | — | — |
| Managed OpenCode commands outside `OPENCODE_COMMAND_NAMES` | — | — | yes (managed marker required) | user-owned without marker |
| Legacy bridge skill symlinks (`hej`) | — | — | yes (dangling or not in `OPENCODE_SKILL_NAMES`) | user symlinks without agentera in target |
| Codex copied hooks (Agentera-only) | — | — | yes (when plugin hooks enabled) | mixed user/ambiguous blocked |
| v2 Python `hooks/*.py` | — | — | yes (entire `hooks/` dir) | — |
| v2 managed bundle `app/` | — | — | yes (`remove-managed-app-home`) | user state preserved at app-home root |
| Runtime config files (Codex, Cursor, Copilot) | — | yes (rewire Python entrypoint → npm) | — | user-owned config not Agentera-managed |

---

## 3. Proposed upgrade mechanism

The current mechanism is mostly correct but has two structural gaps: (1) it is **idempotent-only**, not atomic; (2) the orchestrator gate (`runMigration`) can be false even when the cleanup phase has pending work, leaving cleanup items stranded. The proposed upgrade mechanism addresses both, adds a clear rollback protocol, and codifies the health-check contract.

### 3.1 Phase sequence (preserved)

```
detect → artifacts → runtime → cleanup → verify
```

`verify` is a new post-apply health-check step the orchestrator invokes automatically on `--yes`. `--dry-run` skips it. `--only` filters it out separately so users can verify on demand without re-running the apply.

### 3.2 Per-phase plan and apply, with rollback points

#### Detect

**Plan** (`buildDetectPhase`, `upgradeOrchestrator.ts:161`):
- `classifyInstall` (`compatibility.ts:163`) → `v2_managed_app_home | v3_self_contained_npm | source_checkout | unknown_foreign`
- `classifyUpgradeOutcome` (`versionResolution.ts:144`) → upgrade / blocked-downgrade / migration / up-to-date
- `crossMajorBoundaryApplies` (`:213`) → flag v2 install + v3 CLI
- `shouldIncludeCrossMajorPlanItems` (`:249`) → gate cross-major items to dev channel + migration outcome
- Items emitted: `detect-install` (noop), optional `major-boundary` (blocked), `version-gate` (noop)
- **Rollback point: none (read-only)**

#### Artifacts

**Plan** (`planArtifactsPhase`, `migrateArtifactsV2ToV3.ts:167`):
1. v1 Markdown pairs detected via `detectV1ArtifactPairs` (`:136`) → dispatch to `planV1ArtifactsPhase` (`migrateArtifactsV1ToV2.ts:485`)
2. Otherwise list v2 YAML artifacts → `action: "preserve", status: "noop"`

**Apply** (`applyArtifactsPhase`, `:198`):
- v1: parse → write YAML → copy source to `.agentera/backup-v1/<basename>` → `unlinkSync` source
- Per-item try/catch sets `failed`; remaining items continue
- **Rollback point: the `.agentera/backup-v1/` directory is the recovery surface.** If post-apply verification fails, `upgrade --restore-artifacts` reads the backup directory and re-creates the v1 Markdown. (Proposed new flag; see §3.5.)

#### Runtime

**Plan** (`planRuntimeMigrationItems`, `runtimeMigration.ts:587`):
- `planCodexItems` (`:216`): rewire `~/.codex/config.toml`, `~/.codex/hooks/codex-hooks.json`; retire Agentera-only copied hooks when plugin hooks enabled
- `planCursorItems` (`:265`): rewire `<project>/.cursor/hooks.json`, `~/.cursor/hooks.json`; copy `agentera.md` agent (skip when v3 instruction modules exist); copy `.cursor-plugin/plugin.json`
- `planOpencodeItems` (`:350`): copy plugin (byte-diff), commands (byte-diff), agent (byte-diff), skills (symlink)
- `planStaleCommandCleanupItems` (`:467`): remove managed commands outside closed set
- `planStaleSkillCleanupItems` (`:504`): remove Agentera-managed symlinks not in closed set
- `planCopilotItems` (`:562`): rewire `.github/hooks/*.json`
- `planInstalledHooksRetirementItems` (`installedHooksRetirement.ts`): retire Python `hooks/*.py` plus bundle refs
- `planEnvRuntimeNoops` (`:581`): emit Claude / cursor-agent noop reporters

**Apply** (`applyRuntimeMigrationItem`, `runtimeMigration.ts:625`):
- Per item: `fs.writeFileSync(target, newText)` for rewire; `copyIfChanged` for copy; `fs.symlinkSync` for skill links (lstat before unlink)
- Per-item try/catch; per-item `failed` does not abort the phase
- **Rollback point: text rewrites need an atomic write primitive.** A killed process mid-`writeFileSync` can leave a partial file. See §3.4 atomicity proposal.

#### Cleanup

**Plan** (`planCleanupPhase`, `migrateArtifactsV2ToV3.ts:270`):
1. `resolveMigrationUserStatePreflight` (`v2HandoffManifest.ts:491`) — read `v3-handoff.json` or live-scan
2. `appHomeHasUnrecognizedEntriesWithPreflight` (`:527`) — surface unowned files
3. `planAppContentRefreshItems` (`appContentRefresh.ts:327`) — install/replace v3 app content
4. `planLegacyAgentCleanupItems` + `planLegacyCapabilityAgentCleanupItems` — remove v2 agents
5. If unrecognized entries without `--force`: emit `remove-managed-app-home` with `status: "blocked"`
6. If `hasManagedBundleEvidence` (`migrateArtifactsV2ToV3.ts:233`): emit `remove-managed-app-home` with `status: "pending"`

**Apply** (`applyCleanupPhase`, `:333`):
- `applyAppContentRefreshItems` (`:395`) — copy `skills/`, `references/`, `registry.json`, `dist/capabilities/`; retire Python hooks
- `applyLegacyAgentCleanupItems` — `fs.rmSync` per matched file
- `removeDirectoryRecursive` — `fs.rmSync` of the entire `app/` directory

**Rollback point: `remove-managed-app-home` is destructive.** A failed apply leaves a partial `app/` directory. Currently no recovery path. See §3.4 atomicity proposal.

### 3.3 Required gate fix

Before any of the new mechanism lands, the existing orchestrator gate needs to count cleanup-phase items. Today:

```ts
// upgradeOrchestrator.ts:240-245
const pendingRuntimeSync = pendingRuntimeMigrationItems(migrationCtx).length > 0;
const pendingV1Artifacts = detectV1ArtifactPairs(project).length > 0;
const crossMajorMigration = crossMajorBoundary && shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome); // :242-243
const runMigration = crossMajorMigration || pendingRuntimeSync || pendingV1Artifacts; // :244-245
```

This misses cleanup-phase items entirely. A user with only stale Swedish-verb agents and nothing else triggers `runMigration = false` and the cleanup phase never runs. The fix:

```ts
const pendingRuntimeSync = pendingRuntimeMigrationItems(migrationCtx).length > 0;
const pendingV1Artifacts = detectV1ArtifactPairs(project).length > 0;
const pendingCleanup = planCleanupPhase(migrationCtx).items.some(i => i.status === "pending");
const runMigration = crossMajorMigration || pendingRuntimeSync || pendingV1Artifacts || pendingCleanup;
```

Note: `pendingCleanup` calls `planCleanupPhase` which is cheap (filesystem reads, no writes). The duplicate planning is fine — `applyMigrationPhases` reuses the dry-run preview.

The same gate feeds `pendingRuntimeMigrationItems` via `RUNTIME_MIGRATION_ACTIONS` (`projectIntegration.ts:87-94`), which excludes `remove-stale-command`, `remove-stale-skill`, and `remove-legacy-agent`. Prime's `pending_runtime` count and the orchestrator's `pendingRuntimeSync` are both undercounted. See §4.1.

### 3.4 Atomicity proposal

The current implementation is **idempotent-only**, not atomic. A mid-`writeFileSync` kill can leave a half-rewritten hook JSON; a mid-`rmSync` can leave a partial `app/`. There is no rollback mechanism today. The cheapest atomicity affordance that earns its keep:

1. **Atomic text writes.** Replace `fs.writeFileSync(target, newText)` with `writeFileAtomic(target, newText)` — write to `<target>.tmp.<pid>` and `fs.renameSync(tmp, target)`. `rename` is atomic on POSIX when source and target are on the same filesystem. Applies to: rewire-runtime (`runtimeMigration.ts:637`, `:693`), the v1 YAML write in `applyV1ArtifactsPhase` (`migrateArtifactsV1ToV2.ts:586`), and the copy paths that today use `copyIfChanged` → `fs.copyFileSync` (`runtimeMigration.ts:200-214`). Note: `copyFileSync` is **not** atomic — it writes the target in place (truncate+write); only `rename`-based replacement is atomic, so the copy paths also need the tmp+rename primitive.
2. **Snapshot `app/` before `remove-managed-app-home`.** Before `removeDirectoryRecursive(item.source)` in `applyCleanupPhase` (`:343`), snapshot the directory contents to `<appHome>/.agentera/upgrade-snapshot-<timestamp>/`. After apply, the snapshot is deleted on `--verify` success. On upgrade failure, `--restore` reads the snapshot and reverses the move.
3. **Apply-time mutual exclusion via `flock`.** Write a `<appHome>/.agentera/upgrade.lock` file at the start of `applyMigrationPhases` and `flock` it. Concurrent `upgrade --yes` exits non-zero with "upgrade in progress". The lock is removed on completion or process exit.

These three affordances together turn the upgrade into:

- **Atomic** — each write is all-or-nothing; the destructive `app/` removal is reversible
- **Rollback-safe** — the snapshot is the recovery surface for `app/`; per-file rollback for rewrites is automatic via atomic rename (the file is either old or new, never partial)

The cost is ~30 lines of helper code and a snapshot directory that is cleaned on success. The benefit is that mid-apply failures no longer require manual repair and the system can survive crashes and concurrent runs.

### 3.5 New commands (proposed)

| Command | Purpose |
|---|---|
| `agentera upgrade --yes` | existing; applies pending changes with atomicity |
| `agentera upgrade --dry-run` | existing; preview only |
| `agentera upgrade --force` | existing; bypasses unrecognized-entry block (`UpgradeArgs.force`, `upgrade.ts:22`) |
| `agentera upgrade --only <phase>` | existing; restrict to one phase (`UpgradeArgs.only`, `upgrade.ts:21`) |
| `agentera upgrade --channel <name>` | existing; select update channel (`upgrade.ts:18`) |
| `agentera upgrade --verify` | **DONE**; `9e87514a`; post-apply health check |
| `agentera upgrade --restore` | **DONE**; `9e87514a`; reads `<appHome>/.agentera/upgrade-snapshot-<ts>/` and reverses `remove-managed-app-home` |

`--verify` does **not** exist on the `upgrade` command today. The parsed `UpgradeArgs` (`upgrade.ts:13-24`) and the upgrade dispatch path carry no `--verify` flag — the only `verify` subcommand is the unrelated `agentera check verify` eval gate (`help.ts:124`). The proposed `--verify` runs `agentera doctor` post-apply, asserts `status === APP_UP_TO_DATE`, `signals === []`, and that all 12 capabilities return `schema_error: null` via `prime --context <name> --format json`. Exit non-zero if any check fails.

`--restore` reads the most recent snapshot, re-creates `app/` from the snapshot files, removes the snapshot directory, and emits a `restore-summary` item in the next dry-run. Only the snapshot is restored — runtime rewrites, project YAML migrations, and per-file atomicity are handled by the atomic write (no separate restore needed for those).

### 3.6 Failure-mode handling (post-fix)

| Failure mode | Today | After fix |
|---|---|---|
| Process killed mid-`writeFileSync` | partial file | old or new file, never partial |
| Process killed mid-`rmSync` of `app/` | partial `app/` | full `app/` from snapshot via `--restore` |
| Concurrent `upgrade --yes` runs | both run; corruption possible | second exits non-zero |
| Network failure fetching npm metadata | `versionResolution.ts:86-91` falls back to `"0.0.0"`; plan may be wrong | unchanged (out of scope for upgrade command) |
| Disk full mid-copy | `ENOSPC` thrown; item marked `failed`; re-run safe | unchanged (re-run is still the recovery; `--restore` not needed) |

---

## 4. Complexity audit

Findings on the upgrade orchestrator and supporting modules. Ordered by leverage (highest first). Each finding states the cost, the benefit, and a verdict.

### 4.1 RUNTIME_MIGRATION_ACTIONS set excludes new cleanup actions — prime + orchestrator undercount

**Where:** `packages/cli/src/upgrade/projectIntegration.ts:87-94` defines a closed set of 6 actions: `rewire-runtime`, `retire-hooks`, `copy-plugin`, `copy-agent`, `copy-command`, `link-skill`. `isPendingRuntimeMigrationItem` (`:96-114`) uses it as the fallback filter.

**What's missing from the set:**
- `remove-stale-command` (`runtimeMigration.ts:496`) — added in `8eef7fff`
- `remove-stale-skill` (`runtimeMigration.ts:534`) — added in `27881dcd`
- `remove-legacy-agent` (`legacyAgentCleanup.ts:8`) — added in `2945ddbf`

`retire-installed-hooks` is special-cased (`:100-102`) so it counts.

**Cost:** Two live bugs.

1. **Prime `pending_runtime` undercount.** `summarizeProjectIntegration` (`:313`) returns `pending_runtime: pendingRuntimes.length` where `pendingRuntimes = unique set of pending.item.runtime`. The filter upstream (`pendingRuntimeMigrationItems`, `:137`) only counts items whose `action` is in `RUNTIME_MIGRATION_ACTIONS`. So a user with only stale managed commands/skills/agents shows `pending_runtime: 0` and `pending_artifacts: 0` — prime claims "Your Agentera install is up to date." when it isn't.
2. **Orchestrator `runMigration` gate is too narrow.** `upgradeOrchestrator.ts:240-245` uses the same broken count for `pendingRuntimeSync`. A user with only cleanup items (no Python-rewire, no v1 artifacts, no copy) gets `runMigration = false`, the dry-run is skipped, and the cleanup items never appear in the upgrade plan or apply.

**Benefit:** None. The set is a hand-maintained closed vocabulary that has drifted from reality. It is no longer the source of truth — the actual actions are scattered across the runtime migration plan functions. `isPendingRuntimeMigrationItem` already special-cases `configure` (line 97) and `retire-hooks` (line 100); the same `configure`-only check is the only exclusion the set provides.

**Verdict:** **Remove.** Replace the set membership check with a direct action filter. Suggested:

```ts
function isPendingRuntimeMigrationItem(item: MigrationPhaseItem): boolean {
  if (item.status !== "pending" || item.action === "configure") return false;
  // All non-configure pending actions are real migration work.
  return true;
}
```

For the `rewire-runtime` case, the Python-managed-entrypoint re-check (`:103-112`) is the *drift signal*, not a gate — once the rewire happens, the file no longer matches the pattern, so the item is no longer pending on subsequent runs. Keep that check as the source of drift truth, not as a counting filter.

### 4.2 opencodeCommandTemplate diverges from source content — false-positive doctor drift

**Where:** `packages/cli/src/setup/doctor/opencode.ts:63-71` returns a static template:

```yaml
---
description: "<name>"
agentera_managed: true
---
Load and execute the ${name} skill for this project.
```

The actual source file `.opencode/commands/agentera.md` is itself short prose — frontmatter + `Load and execute the agentera bundled skill for this project. If the user's complete message is exactly hej, route it through Agentera's hej dashboard path instead of a generic greeting.` It does **not** reference `agentera prime --context`. `diagnoseOpencodeCommands` (`:81`) compares installed file content to the template and reports "stale" because the template body (`Load and execute the ${name} skill for this project.\n`) differs from the source body (which appends ` bundled` and the `hej` routing clause). The false positive is real; the divergence is a wording delta between two short-prose versions, not "source has the full routing layer the template lacks".

**Cost:** Every `agentera doctor` run reports `stale: agentera` for an installed command that was correctly copied from source. The doctor emits a `WARN` line that misleads users into thinking the command is out of date.

**Benefit:** None. The template was a placeholder for "what a fresh install looks like"; the real source is the source-of-truth file under `.opencode/commands/`.

**Verdict:** **Remove `opencodeCommandTemplate` and the template-comparison branch in `diagnoseOpencodeCommands`.** Use byte comparison against the actual source file (same pattern as `copyIfChanged` in `runtimeMigration.ts:200`). If the doctor can't access the source, compare against the locally-stored bytes at plan time and store the expected content as part of the doctor snapshot — or just remove the doctor check for command staleness and rely on the upgrade plan to flag drift.

### 4.3 previewCrossMajorGuard duplicates the detect phase's blocked signal

**Where:** `upgradeOrchestrator.ts:273-298` runs when `crossMajorBoundary && !runMigration`. It maps each guard phase item to `blocked` status with message `"requires semver forward-major confirmation on the selected channel"`.

But `buildDetectPhase` (`:181-188`) already pushes a `blocked` item with `action: "major-boundary"` and a more informative message ("v2→v3 migration requires the development channel while stable tracks 2.x; rerun with --channel development after preview") when `crossMajorBoundary && !shouldIncludeCrossMajorPlanItems`.

**Cost:** 26 lines of guard-rendering code in the orchestrator + 39 lines for `previewCrossMajorGuard` (`compatibility.ts:259-297`) that compute `upgradeOutcome` and `lifecycleStatus` already computed in `buildUpgradePlan`. The user sees 4 blocked items saying essentially the same thing in two wordings.

**Benefit:** Per-phase granularity ("artifacts requires semver forward-major confirmation", "runtime requires...", "cleanup requires..."). Not actionable — the remedy is the same regardless of phase: switch to `--channel development`.

**Verdict:** **Simplify.** When `crossMajorBoundary && !crossMajorMigration && !runMigration`, the detect phase's `major-boundary` blocked item is sufficient. Remove the `else if (crossMajorBoundary)` branch at `:273-298`. `previewCrossMajorGuard` can stay if `agentera check` uses it, but the orchestrator should not.

### 4.4 `applyMigrationPhases` defensive item copying

**Where:** `migrateArtifactsV2ToV3.ts:371-374` clones every item before applying:

```ts
artifacts: { ...preview.artifacts, items: preview.artifacts.items.map((item) => ({ ...item })) },
runtime: { ...preview.runtime, items: preview.runtime.items.map((item) => ({ ...item })) },
cleanup: { ...preview.cleanup, items: preview.cleanup.items.map((item) => ({ ...item })) },
```

**Cost:** Three shallow copies of the items array on every `applyMigrationPhases` call. Each `MigrationPhaseItem` is also shallow-cloned.

**Benefit:** Lets the caller hold onto the original `dryRunMigration` preview for comparison. Without this, the caller's preview gets mutated to reflect applied state and they cannot show "before/after".

**Verdict:** **Keep.** The cost is negligible (≤ 100 items in practice) and the benefit — letting callers compare plan vs result for `--dry-run`-then-`--yes` workflows — is real. The doctor/prime UI relies on the dry-run output not mutating after `--yes`.

### 4.5 `coexistenceProbe.resetCoexistenceProbeCache` is a no-op

**Where:** `coexistenceProbe.ts:125` — `export function resetCoexistenceProbeCache(): void {}` with comment "Reset nothing today; reserved for future contract caching in tests."

**Cost:** 2 lines + YAGNI. The function does nothing; if a future need arises, it can be added then.

**Verdict:** **Remove.** YAGNI cleanup.

### 4.6 `collectV3MigrationOperations` only used by tests

**Where:** `compatibility.ts:247-257` exports a 3-line filter `preview.phases.flatMap(...)` reduced to `verb === "migrate" && tag === MAJOR_BOUNDARY_ITEM_TAG`. Consumers: `parityOracle.test.ts`, `compatibility.test.ts`, `backportSafety.test.ts`. No production consumer.

**Cost:** 10 lines of production code + exported symbol that is a test utility.

**Verdict:** **Move to `packages/cli/test/upgrade/helpers/`** or inline the filter in the three test files. Low priority.

### 4.7 BundleStatus has 29 fields; 3 are dead at render

**Where:** `buildDoctorStatus` (`doctor.ts:216`, under `packages/cli/src/upgrade/` — not `src/setup/doctor/`) constructs a 29-field object (per the `BundleStatus` interface at `src/cli/contracts/bundleStatus.ts:37-70`) on every call. Of the four the original audit flagged dead, only three are actually unread:

- `approval` — set at `doctor.ts:253, 288, 414`; never read by `renderDoctorStatus` (`src/cli/commands/doctor.ts:62-104`), which derives wording from `status.status` via `appLifecycleActionNoun`. Dead at render. ✓
- `home` — set but no consumer reads `status.home` outside `buildDoctorStatus`. ✓
- `project` — same: no `status.project` reader in `src/`. ✓
- `appHomeSource` — **NOT dead.** Read in production at `src/cli/capabilityContext/startup.ts:231` (`source: bundle.appHomeSource`) and `src/cli/commands/prime/orientationOutput.ts:66, 186`. The original audit's "audit them; if no consumer reads them, remove" caveat covers this, but the field was mislisted as dead.

**Cost:** Adding a field requires updating multiple construction sites (3 early-return paths + main path at `:414`). 3 dead fields × ~5 paths × ~3 lines ≈ 45 lines of construction that produce dead data.

**Benefit:** `approval` is tested (`doctor.test.ts:98-113, 177-178, 269`; `bundleStatusChannels.test.ts:139-140`) but never rendered. `home` and `project` are merely echoed from opts and never read back.

**Verdict:**
- **Remove `approval`, `home`, `project` from the interface** — `approval` is the clearest dead-at-render field (derive a status phrase from `status` via `appLifecycleApprovalPhrase()` at render time if ever needed). `home` and `project` are dead-at-read (callers already hold them via opts).
- **Keep `appHomeSource`** — it has live production readers (orientation output, startup context).

Lower priority than 4.1 / 4.2 / 4.3.

### 4.8 `summarizePhase` couples 6 statuses where 5 may suffice

**Where:** `MIGRATION_STATUSES = ["pending", "applied", "noop", "blocked", "failed", "skipped"]` (`migrateArtifactsV2ToV3.ts:40`). `summarizePhase` (`:110-134`) has a `skipped`-special-case branch:

```ts
} else if (summary.skipped > 0 && summary.noop === 0 && summary.applied === 0) {
  status = "skipped";
}
```

**Cost:** `skipped` is produced only by the Cursor v3-module skip path (`runtimeMigration.ts:308-316`) and the no-rebase Copilot hook path (`:571-578`). It's a special-case branch that produces a status indistinguishable from `noop` for the user.

**Benefit:** Communicates "we know this exists but intentionally skipped it" vs "no work to do". Distinction is rarely actionable.

**Verdict:** **Collapse `skipped` into `noop`** with an `item.message` describing the skip reason. Removes one status value, three conditional branches, and the special-case in `lifecycleStatusFromWorkflow` (`upgradeOrchestrator.ts:112-127`). Low priority.

### 4.9 `installKind` taxonomy and `crossMajorBoundaryDetected` vs `crossMajorBoundary`

**Where:** `doctor.ts:282` sets `installKind: "source_checkout"`. `crossMajorBoundaryDetected` vs `crossMajorBoundary` is a "detected AND announced" vs "detected only" distinction (`projectIntegration.ts:54-56`).

**Cost:** Two fields that differ only by the `isStableSuccessorAnnounced` check (`:219`). `collectOrientationState.ts:89` reads `crossMajorBoundaryDetected`; nothing reads `crossMajorBoundary` for orientation.

**Verdict:** **Keep.** The distinction is meaningful — "is there a boundary?" vs "is the boundary actionable?" Removing one conflates a detection signal with a state-change signal. The interface cost is low.

### 4.10 Patterns that earn their keep

Audited and kept:

- **Five-phase separation (`detect/artifacts/runtime/cleanup/verify`):** Real — each phase has different rollback semantics and different user-facing concerns.
- **`MigrationContext` struct:** Passes sourceRoot, channel, env, force through every planner. Without it, every planner would re-resolve these.
- **`planRuntimeMigrationItems` aggregating per-runtime planners:** Real — keeps per-runtime logic isolated and testable.
- **`coexistenceProbe` actual probe logic:** The probe is real even if `resetCoexistenceProbeCache` is not.
- **`doctorClassifier.ts` signal kinds:** Each signal (`missing_bundle`, `missing_marker`, `version_mismatch`, `cli_probe_failed`, `unmanaged_install_root`, `user_data_only_app_home`, `cross_major_pending`, `missing_command`) maps to a distinct remediation. Keep all.
- **`Capability` instruction barrel (`packages/cli/src/capabilities/index.ts`):** Keeps import paths consistent between source and dist mode. Real cost-saver for `npm pack` parity.
- **Channel resolution precedence (CLI flag > env > config > default):** Standard config ergonomics. Real.
- **`OPENCODE_SKILL_NAMES = ["agentera", "status"]` asymmetric to `REQUIRED_SKILL_NAMES = ["agentera"]`:** Upgrade planning is stricter than plugin bootstrap. The plugin treats `hej` as best-effort; the upgrade pre-creates both `agentera` and `status` symlinks. Earning its keep — different intents. **Caveat:** `OPENCODE_SKILL_NAMES` is **defined twice** with divergent values — see §4.11.

### 4.11 Duplicate `OPENCODE_SKILL_NAMES` with divergent values

**Where:** `runtimeMigration.ts:54` declares `const OPENCODE_SKILL_NAMES = ["agentera", "status"] as const;` (module-private, used by `planOpencodeItems` for skill-symlink creation and stale-skill cleanup at `:416`, `:514`). `setup/doctor/core.ts:40` separately declares `export const OPENCODE_SKILL_NAMES = ["agentera"] as const;` (used by `diagnoseOpencodeCommands` at `opencode.ts:86` to iterate which commands to doctor-check).

**Cost:** Two same-named constants that look like one source of truth but enforce two different closed sets. The doctor inspects only `agentera` for command staleness, while the upgrade planner manages both `agentera` and `status`. A user whose `status` command drifts will see `doctor` report nothing while `upgrade --dry-run` shows a pending `copy-command`. This is itself a source of the §4.2 false-positive interaction: the doctor's template-comparison runs over the smaller set and can mask divergence the planner would catch.

**Benefit:** None — both constants should derive from one declared set (or one should explicitly subset the other with a named relationship, e.g. `DOCTOR_COMMAND_NAMES = OPENCODE_SKILL_NAMES`).

**Verdict:** **Unify.** Make `setup/doctor/core.ts:40` import the planner's `OPENCODE_SKILL_NAMES` (or extract to a shared constant module) so the doctor and planner cannot drift. This is a new finding not flagged in the original audit; it interacts with §4.2 (the doctor's stale-command false positive runs over a closed set that silently omits `status`).

---

## 5. Verification plan

The success invariants require tests that today are missing or partial. This section enumerates the verification chain and the gaps.

### 5.1 The verification chain (post-upgrade)

1. `agentera upgrade --yes` applies the plan
2. `agentera doctor --format json` asserts `status === APP_UP_TO_DATE`, `signals === []`
3. `agentera prime --context <name> --format json` for each of the 12 capabilities asserts `schema_error: null`
4. `agentera check validate capability-contract --format json` asserts `valid: true`

Steps 2-4 must run inside the same CLI process as step 1 for `--verify`. Today, the CLI runs step 1 and the user runs 2-4 manually. The `--verify` flag (proposed §3.5) automates this.

### 5.2 Existing test coverage (assessment)

Strong coverage exists for:

- Per-phase plan + apply with idempotent re-run (`idempotency.test.ts`, `staleCommandCleanup.test.ts:280-293`, `staleSkillCleanup.test.ts:296-310`)
- v1 Markdown → v2 YAML migration with backup (`migrateArtifactsV2ToV3.test.ts:43-73`)
- Runtime rewire per runtime (`migrateRuntimeMatrix.test.ts`)
- App content refresh with stale-surface detection (`appContentRefresh.test.ts`)
- Legacy agent cleanup (`legacyAgentCleanup.test.ts`)
- Installed Python hooks retirement (`installedHooksRetirement.test.ts`)
- User-state preservation via checksum manifest (`cleanupNoisyAppHome.test.ts`, `dataPreservation.test.ts`)
- Coexistence / home leak (`noHomeLeak.test.ts`)
- Backport safety: stable-channel dry-run excludes cross-major ops (`backportSafety.test.ts`)
- Gap 9: v3-handoff.json recognition and source-checkout short-circuit (`doctor.test.ts:229-285`, committed `fa8a956b`)

Weak / missing coverage:

- Repeat `upgrade --yes` (not dry-run) on an already-applied install
- Mid-apply failure injection
- Concurrent upgrade runs
- Process-killed mid-write recovery
- Corrupt bundle-marker JSON recovery
- Disk-full mid-copy recovery
- Symlink target disappearing between plan and apply
- Network failure during channel catalog fetch
- `--verify` chain: `upgrade --yes` → `doctor` → 12× `prime --context` (the `--verify` flag does not exist yet — see §3.5; the chain itself is unimplemented)
- Symlink-to-outside-app-home user-state preservation
- Multiple-runtimes-pointing-at-different-versions reconciliation
- Exit code asserted for `summary.failed > 0` (the branch in `upgradeExitCode:392` is unreachable by current tests)

### 5.3 Failure scenarios that must be tested

| # | Failure | Test (proposed name) | Asserts |
|---|---|---|---|
| 1 | Repeat `upgrade --yes` on clean install | `idempotency.applyRepeatYes` | exit 0, no items pending, file checksums unchanged |
| 2 | Mid-`writeFileSync` kill (atomic rename) | `atomicity.renameUnderKill` | file is old-content or new-content, never partial |
| 3 | Mid-`rmSync` kill (snapshot) | `atomicity.rmUnderKillSnapshot` | snapshot dir present; `--restore` reverses; reinstall upgrades |
| 4 | Concurrent `upgrade --yes` (flock) | `concurrency.flockBlocksSecond` | second process exits non-zero with "upgrade in progress" |
| 5 | Corrupt `BUNDLE_MARKER` JSON | `doctor.corruptBundleMarker` | classifies `repair_needed`, no thrown `JSON.parse` |
| 6 | Disk-full mid-copy (`ENOSPC`) | `atomicity.diskFullMidCopy` | item marked `failed`; re-run after fs space recovers; succeeds |
| 7 | Symlink target disappears between plan and apply | `runtime.symlinkTargetDisappears` | `link-skill` either succeeds or fails recoverable; no half-state |
| 8 | Multiple runtimes, different pinned versions | `runtime.mixedVersionsReconcile` | orchestrator plans per-runtime rewire independently |
| 9 | Exit code on partial-failure apply | `exitCodes.partialFailureApply` | `upgradeExitCode` returns 1 when `summary.failed > 0` |
| 10 | `--verify` end-to-end | `verify.fullUpgradeThenDoctorAndPrime` | `upgrade --yes --verify` exits 0 with `status: up_to_date` and 12× `schema_error: null` |
| 11 | Restore from snapshot | `restore.reversesManagedAppHomeRemoval` | after `--restore`, `app/` is back and `agentera doctor` returns `up_to_date` |
| 12 | User-state with symlink to outside `appHome` | `preserve.symlinkedUserStateNotDeleted` | `fs.rmSync` of `app/` does not touch the symlink target |
| 13 | Network failure during `resolveLatestOnChannel` | `resolution.networkFailureFallback` | falls back to `"0.0.0"`; plan still produces; `prime` works offline |
| 14 | Concurrent run cleanup | `concurrency.lockReleasedOnExit` | flock file removed on process exit (signal, crash, normal) |
| 15 | Atomic write under ENOSPC | `atomicity.renameUnderENOSPC` | tmp file created; rename fails; original file intact |

### 5.4 Test fixtures to add

| Fixture | Models |
|---|---|
| `v2-app-home-with-v3-handoff` | app home with `v3-handoff.json` + realistic user state + Python hooks still in `~/.codex/hooks/` (Gap 9 RCA composite) |
| `v2-runtime-mixed-versions` | `~/.codex/config.toml` pinning `agentera@2.7.9`, `<project>/.cursor/hooks.json` pinning `agentera@3.0.0-next.1` |
| `v2-bundle-marker-corrupt` | `<appHome>/.agentera-bundle.json` containing `{"version":` (malformed) |
| `v2-app-home-with-symlinked-user-state` | `<appHome>/PROFILE.md` is a symlink to `/tmp/outside-profile.md`; ensure not followed by `rmSync` |
| `v3-source-checkout-with-migrated-install` | source checkout root + app home with `v3-handoff.json` + `benchmarks/`, `intermediate/`, `sessions/` |

### 5.5 Manual smoke (operator workflow)

After every v3 release that touches the upgrade pipeline:

1. From a clean machine, run `npx -y agentera@next upgrade --dry-run --yes` (forced dry-run, ignore error code) — preview shows nothing pending
2. From a v2-installed machine (with `v3-handoff.json` present), run `npx -y agentera@next upgrade --channel development --dry-run` — preview shows the planned cleanup, no blocked items
3. Apply: `npx -y agentera@next upgrade --channel development --yes`
4. Verify (manual today; automated once `--verify` ships per §3.5): `npx -y agentera@next doctor` → `up to date`, `npx -y agentera@next prime --context status --format json` → `schema_error: null`
5. Restore test: re-run `npx -y agentera@next upgrade --channel development --yes` — noop
6. Restore from snapshot test (on a controlled fixture, requires proposed `--restore`): kill the upgrade mid-apply, then `npx -y agentera@next upgrade --restore` and assert `doctor` returns `up to date`

### 5.6 CI gates

The existing CI runs `pnpm -C packages/cli test` and `pnpm -C packages/cli run typecheck`. Two additions:

- Run `pnpm -C packages/cli build && node packages/cli/dist/bin/agentera.js check compact` as a content gate (already in AGENTS.md)
- Add a new test file `tests/upgrade/atomicity.test.ts` covering scenarios 2-7, 11, 14-15 above. Until this file exists, the atomicity invariant is unverified.

---

## 6. Open questions and deferred decisions

### 6.1 Decisions resolved

**Q1 — Atomicity depth.** **RESOLVED: Implement full atomicity.** The atomic-write + snapshot + lock mechanism shipped in `eead9a1d` (`atomicWriter.ts`, `upgradeSnapshot.ts`, `upgradeLock.ts`). All `writeFileSync`/`copyFileSync` paths in the upgrade pipeline now use `writeFileAtomic` (tmp+rename); `remove-managed-app-home` is snapshotted before removal; `applyMigrationPhases` acquires a PID-based lock with stale reclaim. Cost was ~130 lines of helper code + 21 tests.

**Q2 — `--verify` automation.** **RESOLVED: Opt-in, not default-on.** `--verify` shipped in `9e87514a` as an opt-in flag. It can run standalone (`upgrade --verify`) or combined with `--yes` (`upgrade --yes --verify`). In combined mode, the verify summary goes to stderr so stdout stays parseable. Default-on was rejected to keep `--yes` fast and let users verify on demand.

**Q3 — `--restore` granularity.** **RESOLVED: Snapshot-only (managed-app-home reversal).** `--restore` shipped in `9e87514a` reversing only `remove-managed-app-home` from the snapshot. Runtime rewrites are not reversed because the atomic-rename primitive already handles crash recovery (the file is either old or new, never partial). A user who applied a rewire and changed their mind re-runs `upgrade` from source.

**Q4 — `RUNTIME_MIGRATION_ACTIONS` removal scope.** **RESOLVED: Remove the set, defer the `isGlobalStaleRuntimeItem` merge.** The set was removed in `60f554b0`; `isPendingRuntimeMigrationItem` simplified to `status !== "pending" || action === "configure"`. The `isGlobalStaleRuntimeItem` merge remains deferred — the two functions differ by `hasProjectHooks` semantics and combining them is bigger surgery with no current bug driving it.

**Q5 — `skipped` status collapse.** **RESOLVED: Collapse into `noop`.** Shipped in `5cb6ceee`. `skipped` removed from `MIGRATION_STATUSES`, the `MigrationPhaseSummary` interface, and all special-case branches. The Cursor v3-module skip path now pushes `noop` with the skip-reason message preserved in `item.message`.

**Q6 — `opencodeCommandTemplate` removal impact.** **RESOLVED: Remove the template, keep the doctor check with byte comparison.** Shipped in `cd35046d`. `diagnoseOpencodeCommands` now compares installed command bytes against the actual source file (`.opencode/commands/<name>.md`). The doctor check for command staleness is preserved but no longer false-positives on a correctly-installed command.

**Q7 — Source-checkout short-circuit scope.** **DEFERRED.** The short-circuit currently fires only for `rootSource === SOURCE_LABELS.default`. Extending to `AGENTERA_HOME` (legacy recoverable default) is not implemented — the risk of silent failure on a real diagnose outweighs the convenience. Revisit if v2 users with `AGENTERA_HOME` set report friction.

### 6.2 Decisions deferred to release coordination

**R1 — v3 promotion to `@latest`.** When `@next` v3 reaches parity with `@latest` v2 in the maintenance matrix (`AGENTS.md` branch model), `@latest` flips to v3 and `@next` is retired. The v2 Python source on `main` becomes feature-frozen except for velocity blockers. The v3 upgrade command's lifetime as the "v2→v3 migration tool" is bounded by this flip.

**R2 — Python v2 shim.** `packages/cli/shim/bin/agentera.mjs` (referenced in `UPGRADE.md:844`) currently delegates to `scripts/agentera` via three paths, all of which fail on `feat/v3`. Whether to fix or retire the shim is a release decision; the upgrade plan does not depend on it.

**R3 — Copilot hook registration.** v3 rewrites `.github/hooks/*.json` only when the file already exists. A repo with no Copilot hooks configured will not get them added by `upgrade --yes`. Whether to add a `configure` step that copies from source `.github/hooks/*.json` to project `.github/hooks/*.json` is a UX call.

### 6.3 Risks

**W1 — Snapshot cleanup on `--verify` success.** If `--verify` succeeds but the snapshot directory is never removed, the user accumulates `<appHome>/.agentera/upgrade-snapshot-<ts>/` directories. Auto-cleanup on `--verify` success is the proposed behavior; if `--verify` is opt-in, the cleanup must run after a successful apply regardless.

**W2 — Snapshot size.** A v2 install's `app/` can be 1-50 MB (registry, references, hooks). Snapshotting before removal doubles disk usage during the apply. Acceptable for typical installs; flag in the dry-run output if `app/` exceeds a threshold (say 100 MB).

**W3 — `flock` portability.** `flock(2)` is POSIX. Windows fallback would need `LockFileEx` via `fs-ext` or similar. Today's installer audience is npx-driven (Node available, mostly macOS/Linux); Windows is supported via npx but `flock` semantics differ. Consider a PID-file presence check as a fallback if `flock` is unavailable.

**W4 — Migration target version pinning.** `versionResolution.ts:249` `shouldIncludeCrossMajorPlanItems` requires a "successor announced" signal. If `@next` releases a v3.1.0 with breaking changes while `@latest` is still on v2.7.x, the v3 upgrade command may need its own successor gate. Currently the announcement lives in `nextMajorDoctor.ts` — verify it accepts a `target version` argument, not just a `is announced` boolean.

---

## Appendix A — File index

The v3 upgrade mechanism's primary files (all under `packages/cli/src/upgrade/` unless noted):

| File | Role | Lines |
|---|---|---|
| `upgradeOrchestrator.ts` | Phase orchestration, gate logic, exit code | 415 |
| `migrateArtifactsV2ToV3.ts` | Phase plan + apply, status types | 386 |
| `migrateArtifactsV1ToV2.ts` | v1 Markdown → v2 YAML migration | 598 |
| `runtimeMigration.ts` | Runtime rewire (Codex, Cursor, OpenCode, Copilot), cleanup actions | 752 |
| `appContentRefresh.ts` | Install/replace v3 app content in install root | 410 |
| `legacyAgentCleanup.ts` | v2 Swedish-verb + English-capability agent removal | 207 |
| `installedHooksRetirement.ts` | Python `hooks/*.py` retirement, bundle hook-invocation scan | 214 |
| `projectIntegration.ts` | Prime's pending count, integration summary | 334 |
| `projectIntegrationDecision.ts` | `stay | upgrade | blocked` classifier | 53 |
| `doctor.ts` | `buildDoctorStatus`, root user state allowlist | 455 |
| `doctorClassifier.ts` | Signal kind emission | 230 |
| `compatibility.ts` | Channel gate, classify install, cross-major boundary | 308 |
| `channels.ts` | Channel resolution | 298 |
| `versionResolution.ts` | Running version, upgrade outcome | 265 |
| `appModel.ts` | Install root resolution, `doctorRoots` | 254 |
| `bundleEvidence.ts` | `hasBundleRootEvidence`, script head check | 34 |
| `nextMajorDoctor.ts` | Cross-major boundary + successor announcement | 218 |
| `coexistenceProbe.ts` | Detect v2 alongside v3 install | 125 |
| `upgradeCommands.ts` | Build dry-run / apply command strings | 58 |
| `v3CapabilitySurface.ts` | Detect v3 capability instruction modules | 19 |
| `npxPlatformStatus.ts` | npx bundle platform status | 40 |

v2 source (on `main`, removed on `feat/v3`):

| File | Role | Lines |
|---|---|---|
| `scripts/agentera_upgrade.py` | v2 orchestrator (5 phases) | 2785 |
| `scripts/install_root.py` | Install root classification | (largest v2 module after upgrade.py) |
| `scripts/setup_codex.py` | Codex runtime setup | (referenced for plan_change) |
| `scripts/setup_copilot.py` | Copilot diagnostic | (read-only) |
| `scripts/runtime_adapter_registry.py` | Runtime registry | (referenced) |
| `scripts/v3_handoff_manifest.py` | v3-handoff.json schema + reader | (Gap 9 root cause file) |
| `scripts/migrate_artifacts_v1_to_v2.py` | v1→v2 markdown→yaml | (referenced) |
| `tests/test_upgrade_cli.py` | v2 upgrade CLI tests | (pytest) |

Test files (all under `packages/cli/test/upgrade/`):

41 test files, 13 fixtures, 2 helpers. See §5.2 for assessment.

## Appendix B — UPGRADE-v3.md status ledger

| Item | Status | Evidence |
|---|---|---|
| Phase 1: Clean stale dist | DONE | `50473b70` |
| Phase 2: Remove `rewire-env-var` | DONE | `7b9528a2` |
| Phase 3: Skip non-Agentera configs | DONE | `e27d2819` |
| Phase 4: English-capability agent cleanup | DONE | `2945ddbf` |
| Phase 5: Stale command cleanup | DONE | `8eef7fff` |
| Phase 6: Dangling skill symlink cleanup | DONE | `27881dcd` |
| Phase 7: `opencodeCommandTemplate` removal | DONE | `cd35046d`; byte comparison + unified `OPENCODE_SKILL_NAMES`; see §4.2/§4.11 |
| Phase 8: 11→3 scenarios | DONE | `a53ef010` |
| Phase 9: `--only` unification | DONE | `c46c4a24` |
| Phase 10: Remove `projectHasPendingRuntimeRewire` | DONE | `808b3403` |
| Phase 11: Plugin `REQUIRED_AGENT_NAMES` | DONE | `d48db8f7` |
| Phase 12: Install root recognition (Gap 9) | DONE | `fa8a956b`; `doctor.ts:120` (`v3-handoff.json` literal) and `:162-188` (`appHomeIsUserDataOnly`), `appContentRefresh.ts:333-350`, `compatibility.ts:116`, `doctor.test.ts:229-285` |
| OE-5: `RUNTIME_MIGRATION_ACTIONS` | DONE | `60f554b0`; set removed, `isPendingRuntimeMigrationItem` simplified; see §4.1 |
| §3.3: Orchestrator gate fix | DONE | `ec73cafa`; `pendingCleanup` counts legacy-agent cleanup items |
| §3.4: Atomicity (writes + snapshot + lock) | DONE | `eead9a1d`; `atomicWriter.ts`, `upgradeSnapshot.ts`, `upgradeLock.ts` |
| §3.5: `--verify` + `--restore` flags | DONE | `9e87514a`; `upgradeVerify.ts`, `restoreFromSnapshot` |
| §4.3: `previewCrossMajorGuard` orchestrator branch | DONE | `7c297db9` |
| §4.5: `resetCoexistenceProbeCache` no-op | DONE | `ec52057d` |
| §4.6: `collectV3MigrationOperations` to test helpers | DONE | `7e6ef5c6` |
| §4.7: Dead BundleStatus fields (`approval`, `home`, `project`) | DONE | `c8f261ac` |
| §4.8/Q5: Collapse `skipped` into `noop` | DONE | `5cb6ceee` |
| §5.3: Failure-scenario tests | DONE | `1483b357`; 14 new tests across `atomicity.test.ts`, `exitCodes.test.ts`, and domain files |

All phases and complexity-audit findings are now implemented. The upgrade command enforces all five success invariants: idempotent (byte-diff driven), atomic (`writeFileAtomic` + `rename`), rollback-safe (`--restore` from snapshot), non-destructive (managed-marker / closed-set guards), and verifiable (`--verify` runs doctor + 12× capability schema checks).
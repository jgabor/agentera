# Upgrading Agentera

## Update channels

Agentera resolves which published line `upgrade`, `doctor`, and `prime` target through
**update channels**. The machine-readable authority is
[`references/cli/update-channels.yaml`](references/cli/update-channels.yaml).

| Channel | Resolves to | npm entry | Purpose |
| --- | --- | --- | --- |
| **stable** (default) | 2.x support line | `npx -y agentera@latest` | Production upgrades and repairs on the supported 2.x line |
| **development** | 3.x alphas and RCs | `npx -y agentera@next` | Early adopters testing the npm-only TypeScript 3.x CLI (no uvx/git path on feat/v3) |

**Stable `@latest` stays on 2.x** until an explicit release decision retires the 2.x
support line. Installing or upgrading with `@latest` (or the default channel) never
starts a v2→v3 migration.

Select a channel with `--channel`, `AGENTERA_UPDATE_CHANNEL`, or `update.channel` in
`~/.config/agentera/config.toml`. Precedence is CLI flag, then environment variable,
then config file, then the stable default.

Preview before apply on every upgrade path: run `--dry-run` first, review the plan,
then rerun with `--yes`. `--yes` and `--dry-run` are mutually exclusive. Cross-major
v2→v3 work additionally requires a 3.x **development**-channel CLI and explicit
preview with --dry-run, then apply with --yes on the same channel; stable-channel previews omit v3
migration operations while stable tracks 2.x. Migration from v2 always targets the
latest v3+ release on the chosen channel. Return to the v2 Python line is permanently
unsupported after crossing into v3+.

## What changed

### v1 → v2

- **12 standalone skills -> 1 bundled skill** with 12 capabilities under `skills/agentera/`
- **Artifact format**: Markdown -> YAML for agent-facing `.agentera/` files
- **Upgrade CLI**: `npx -y agentera@latest upgrade` on the stable channel, or `uv run scripts/agentera upgrade` from a clone
- **State CLI**: `npx -y agentera prime` (or `uv run scripts/agentera prime` from a clone on `main`), `agentera state plan`, and other `state` namespace commands for routine access; `/agentera` still renders the orientation dashboard from the `agentera prime` composite result, while `agentera state query <artifact-name> --format json|yaml` remains advanced custom access. On 3.x, `agentera --help` lists only canonical namespaces; legacy top-level names still forward with stderr deprecation — see [audience-namespace-cli-migration.yaml](references/cli/audience-namespace-cli-migration.yaml).

### v2 → v3 (development channel only)

Crossing from the Python 2.x support line to the npm TypeScript 3.x line uses the
**development** channel only via `npx -y agentera@next`. There is no uvx or git
install path for the 3.x CLI; v2→v3 is one-way. Stable maintainer work on Python
2.x continues through `uvx --from git+https://github.com/jgabor/agentera@main` or a
clone with `uv run scripts/agentera`.

The 3.x line replaces the Python managed app-home model with an npm self-contained
CLI bundle (`dist/bin/agentera.js` plus `bundle/`). That cross-major migration is
**never implied** by stable-channel resolution or `@latest`. Opt in only on a
development-channel 3.x CLI after preview.

After the 3.0 cutover publish, `npx -y agentera@latest` becomes the TypeScript 3.x
line; until then use `@next` for 3.x and `@latest` for 2.x stable.

**CLI shape on 3.x:** `agentera prime`, `agentera prime --context <capability> --format json`,
`agentera state <name>`, and `agentera check validate`. Legacy top-level names still
forward with stderr deprecation but no longer appear in `agentera --help`.

## Recommended upgrade (v1 → v2, stable channel)

### No local clone

Use this path if you installed Agentera through `npx skills`, the Copilot
marketplace, the Codex marketplace, or the OpenCode plugin and do not have a
local clone.

Preview first. This writes nothing and exits non-zero when pending work exists:

```bash
npx -y agentera@latest upgrade --project /path/to/project --dry-run
```

Apply local, idempotent upgrade actions without package-manager changes:

```bash
npx -y agentera@latest upgrade --project /path/to/project --yes
```

From a git checkout on the stable line (`main`), the equivalent git-resolved entry is:

```bash
uvx --from git+https://github.com/jgabor/agentera@main agentera upgrade --project /path/to/project --dry-run
uvx --from git+https://github.com/jgabor/agentera@main agentera upgrade --project /path/to/project --yes
```

Add `--update-packages` only when you explicitly want Agentera to run external
package-manager commands such as `npx skills remove` and `npx skills add`:

```bash
npx -y agentera@latest upgrade --project /path/to/project --yes --update-packages
```

This command installs or refreshes the managed Agentera app under the Agentera
app home before it wires runtime config. Runtime config should not point at uv's
disposable tool cache.

`npx skills update` alone refreshes the visible skill files but does not refresh
Agentera's local app files, migrate project artifacts, clean up the old Agentera
directory, or rewrite runtime config. The command above is the complete upgrade
path. With explicit `--update-packages`, it removes package-managed legacy
standalone skill entries and installs `/agentera`.

### App and runtime repair

`codex plugin marketplace upgrade`, `copilot plugin marketplace upgrade`, and
`npx skills update -g -y` refresh package-managed surfaces. They do not
guarantee that the app files under `AGENTERA_HOME/app` or managed runtime
surfaces have the latest Agentera wiring. Directory selection and read-only
repair checks are centralized in `scripts/install_root.py`.

Bare `/agentera` owns this recovery path. When the installed CLI is missing
`prime`, fails before command discovery, has an outdated `.agentera-bundle.json`
version, or otherwise fails the install status contract, it should show the
repair preview for the resolved Agentera directory. The preview covers app files,
managed runtime config, plugins, hooks, commands, and safe cleanup together. It
changes nothing:

```bash
npx -y agentera@latest upgrade --install-root "$AGENTERA_HOME" --dry-run
```

The durable location is still the Agentera directory, and app files are still
installed under `$AGENTERA_HOME/app`.

If the installed app gate cannot execute because `AGENTERA_HOME` names the old
`$HOME/.agents/agentera` directory and `$AGENTERA_HOME/app/scripts/agentera` is
missing, do not require a successful failed CLI invocation and do not first ask
the user to unset `AGENTERA_HOME`. Preview the normal Agentera directory repair path
without `--install-root` so upgrade can choose the normal platform directory and
preview cleanup of the old directory:

```bash
npx -y agentera@latest upgrade --dry-run
```

Only after explicit approval should it apply the same safe repair path:

```bash
npx -y agentera@latest upgrade --yes
```

Custom invalid `AGENTERA_HOME` values are different: choose a different Agentera
directory, or use `--force` only after checking that directory is safe to replace. Do
not describe the old default directory as proof of where the environment value came
from.

From a current local clone, inspect the same read-only self-check with:

```bash
uv run scripts/agentera doctor --install-root "$AGENTERA_HOME" --json
```

Only after explicit approval for that same app home should it apply:

```bash
npx -y agentera@latest upgrade --install-root "$AGENTERA_HOME" --yes
```

The apply command refreshes the managed app and managed runtime surfaces that the
preview proved Agentera owns. It does not run package updates unless
`--update-packages` is explicitly present.
Afterward, retry:

```bash
RESOLVED_AGENTERA_HOME="<app home reported by upgrade>"
uv run "$RESOLVED_AGENTERA_HOME/app/scripts/agentera" prime
```

Set `RESOLVED_AGENTERA_HOME` before running the command. Never combine the
app-home assignment with the same shell command that expands the managed app
script path; shell expansion can otherwise turn an unset `AGENTERA_HOME` into
`/app/scripts/agentera` before the assignment takes effect.

If `AGENTERA_HOME` is unset, use the shared app-home contract's default platform
data home. If it points at a missing path, a file, or a directory with unrelated
files, Agentera stops instead of guessing. Choose a different Agentera directory,
or use `--force` only after checking that directory is safe to replace.

### Local clone

Preview first. This writes nothing and exits non-zero when pending work exists:

```bash
uv run scripts/agentera upgrade --project /path/to/project --dry-run
```

Apply local, idempotent upgrade actions:

```bash
uv run scripts/agentera upgrade --project /path/to/project --yes
```

The command migrates v1 project artifacts, installs or updates Agentera app
files when needed, configures selected runtime surfaces, removes fixable outdated
v1 runtime artifacts, and runs a final check. Re-running it after a successful
apply should report that nothing else needs to change.

`agentera upgrade` is the only repair command. When app files are version-behind,
the work inside that command is an **update**; when files are missing or broken,
it is a **repair**; when v1 project artifacts exist, it is a **migrate**. There
is no separate `agentera update` subcommand.

When `AGENTERA_HOME` is unset, Agentera uses the normal data directory for your
operating system. If the old `~/.agents/agentera` directory still contains Agentera
files, the preview says it will clean up that old directory, move known user data
into the selected Agentera directory, remove old app files, and delete
`~/.agents/agentera` when it becomes empty. The artifacts phase also migrates
supported v1 Markdown project artifacts such as `.agentera/PROGRESS.md`,
`.agentera/PLAN.md`, `.agentera/DOCS.md`, and root `VISION.md` into v2 YAML with
backups under `.agentera/backup-v1/` after preview and confirmation.

External package updates are deliberately opt-in because they run `npx` and may touch global runtime installs. The package phase removes legacy v1 skill entries and installs the active `/agentera` skill:

```bash
uv run scripts/agentera upgrade --project /path/to/project --yes --update-packages
```

## Upgrading v2 to v3 (development channel, irreversible)

Use this path only when you intentionally move from a v2 managed app-home install
to the npm self-contained 3.x model. The semver and channel gate compares your
running version to the latest release on the selected channel. While stable tracks
2.x, use the development channel. Migration always targets the latest v3+ release
on that channel. Return to the v2 Python line is permanently unsupported after
crossing into v3+.

### Before you migrate

1. **Refresh the v2 handoff manifest (stable CLI).** On the 2.x line, run doctor
   or upgrade so the stable Python CLI writes or refreshes
   `{app_home}/v3-handoff.json` (for example `~/.local/share/agentera/v3-handoff.json`
   on Linux). The manifest records the installed v2 version, resolved app-home
   path, user-data inventory (`benchmarks/`, `intermediate/`, `sessions/`,
   `history/`, `corpus/`, profile files), and active runtime adapters. Schema:
   [`references/cli/v3-handoff-manifest.schema.yaml`](references/cli/v3-handoff-manifest.schema.yaml).

2. **Check coexistence.** If both lines are installed, doctor warns before you
   cross majors:
   - **v2 stable** (`npx -y agentera@latest doctor`): detects an npm `@next` /
     v3 install (npx cache and `npm ls -g agentera` when Node is available) and
     prints `v3 detected alongside v2; pick one line` with three choices:
     complete v3 migration, uninstall v3, or stay on v2 explicitly.
   - **v3 development** (`npx -y agentera@next doctor`): detects a v2 managed
     app home under the platform default path and prints the same headline and
     resolution list from
     [`references/cli/coexistence-probe.yaml`](references/cli/coexistence-probe.yaml).

3. **Preview on the development channel:**

```bash
npx -y agentera@next upgrade --channel development --project /path/to/project --dry-run
```

Review the JSON or text preview. Cross-major items are tagged
`requires_explicit_major_opt_in` in the `agentera.upgrade.v2` payload. Pending
work exits non-zero until you approve apply.

### Apply

```bash
npx -y agentera@next upgrade --channel development --project /path/to/project --yes
```

`--yes` on the stable channel is rejected for v2→v3 migration while stable tracks 2.x.
Run focused phases when you need more control (`--only artifacts`, `--only runtime`,
`--only cleanup`).

### What the v3 migration does

**Handoff manifest preflight.** During the cleanup phase, the v3 reader in
`packages/cli/src/migrate/v2HandoffManifest.ts` loads `v3-handoff.json` when
present and completes parsing within 100ms (`READER_PREFLIGHT_BUDGET_MS`). When
the manifest is missing or invalid, preflight falls back to scanning the app home
for preserved user directories and profile files.

**Phases.** Migration migrates project YAML artifacts, rewires runtime config
from the Python managed app-home entrypoint to `npx -y agentera@next`, and
removes the managed `app/` bundle while preserving user and project state
boundaries. Preserved app-home user state includes `benchmarks/`, `intermediate/`,
`sessions/`, `history/`, `corpus/`, root profile files, and project `.agentera/`
YAML. Typical installs no longer require `--force` when those directories are present.

**Cursor agent surface.** On v3 projects (in-tree
`packages/cli/src/capabilities/<name>/instructions.ts` modules), upgrade skips
copying legacy `.cursor/agents/*.md` bodies that point at
`Read …/capabilities/<name>/instructions.md`. Managed agents should use
`Run agentera prime --context <name> --format json` instead.

**Audience-namespace CLI.** After migration, use `agentera prime`, `agentera schema`,
`agentera state plan`, and `agentera check validate` as the canonical entry points.
Top-level `hej`, `describe`, `gate`, `plan`, `validate`, and related legacy names
still delegate with stderr deprecation but no longer appear in `agentera --help`.

## Runtime notes

### Claude Code

`agentera upgrade` does not require Claude access and does not run Claude smoke tests. Package refresh is skipped unless `--update-packages` is set.

### OpenCode

The upgrade command copies the current bundled plugin to the OpenCode config directory, syncs managed commands and agents, and links Agentera skills under the native OpenCode config path. The same adapter remains available as an npm-style package entry through `.opencode/package.json` `main`/`exports`, but the copied `~/.config/opencode/plugins/agentera.js` path remains preserved for project-local installs. OpenCode package refresh remains opt-in:

```bash
uv run scripts/agentera upgrade --runtime opencode --yes --update-packages
```

Use `--opencode-config-dir PATH` to target a non-default OpenCode config directory.

OpenCode compaction context is provided by `experimental.session.compacting`. The plugin appends bounded context from `agentera hej --format json` and does not read `.agentera` artifacts directly for that hook.

### Codex

The upgrade command writes `AGENTERA_HOME` into `~/.codex/config.toml` and manages Codex hook trust. When `[plugins."agentera@agentera"].enabled = true` proves the Agentera Codex plugin is installed and enabled, upgrade enables `[features].hooks`, `[features].plugin_hooks`, trusts the plugin-bundled hook metadata, and retires Agentera-owned copied `~/.codex/hooks/codex-hooks.json` files when they contain only Agentera-owned handlers. If copied hooks contain user or ambiguous entries, upgrade blocks for manual review instead of deleting them. Agentera v2 is one bundled `$agentera` skill; the old per-skill `[agents.<name>]` Codex config blocks are v1 artifacts and are not written.

When the Agentera Codex plugin is absent, disabled, or cannot be proven from `~/.codex/config.toml`, upgrade preserves the copied `~/.codex/hooks.json` compatibility fallback. Those copied hook commands use the resolved Agentera validator path, so they do not depend on hook subprocesses inheriting `[shell_environment_policy].set`.

```bash
uv run scripts/agentera upgrade --runtime codex --yes
```

### Copilot CLI

Upgrade does not edit shell startup files. Pass app context per invocation:

```bash
AGENTERA_HOME=/path/to/agentera copilot ...
```

To check for a leftover 1.x managed marker block in shell startup files, run the
diagnostic helper (read-only; changes nothing):

```bash
uv run scripts/setup_copilot.py --install-root /path/to/agentera
```

### Cursor

**Local plugin (no Marketplace listing required)**

Install from a clone or release checkout into Cursor's local plugin directory.
The plugin root must contain `.cursor-plugin/plugin.json`:

```bash
git clone https://github.com/jgabor/agentera.git ~/.cursor/plugins/local/agentera
# or: ln -s /path/to/agentera ~/.cursor/plugins/local/agentera
```

Restart Cursor or run **Developer: Reload Window**. Agentera is not published to
the Cursor Marketplace yet.

The plugin loads skills, managed capability agents, and hooks. `sessionStart`
exports `AGENTERA_HOME` from the plugin checkout when the open project is not an
Agentera install root.

**Portable skill plus project upgrade**

Install the bundled skill with `npx skills add jgabor/agentera -g -a cursor --skill agentera -y`,
then install managed project surfaces:

```bash
uv run scripts/agentera upgrade --runtime cursor --dry-run
uv run scripts/agentera upgrade --runtime cursor --yes
uv run scripts/agentera doctor --runtime cursor
```

Use the plugin path for a user-global install. Use upgrade when you need
project-committed `.cursor/hooks.json` and `.cursor/agents/` copies (team
sharing, CI doctor checks, or working without the plugin). Both paths can be
combined.

Repo-native dogfood in this repository uses committed `.cursor/hooks.json` and
`.cursor/agents/*.md`. Upgrade copies those managed surfaces into other projects
with the same ownership protections used for OpenCode and Codex. Cloud agents are
unsupported in v1. Bare text `hej` routing stays metadata-only.

For CLI automation, eval coverage uses `cursor-agent` print mode:

```bash
uv run scripts/eval_skills.py --runtime cursor-agent --dry-run
```

See [`references/adapters/cursor.md`](references/adapters/cursor.md) for adapter details.

## Focused phases

Run one phase at a time when you want more control:

```bash
npx -y agentera@latest upgrade --only artifacts --project /path/to/project --yes
npx -y agentera@latest upgrade --only runtime --runtime codex --yes
npx -y agentera@latest upgrade --only cleanup --yes
npx -y agentera@latest upgrade --only packages --runtime opencode --yes --update-packages
```

For v2→v3 on the development channel, use `--channel development` with preview with --dry-run, then apply with --yes
to the same `--only` flags after preview.

## Maintainer backports and cherry-picks

When landing dual-channel and v2→v3 guard work onto `main`, cherry-pick in this
order so stable users never see silent cross-major migration:

1. **Vocabulary and authority** — `references/cli/update-channels.yaml`,
 `references/cli/app-lifecycle-vocabulary.yaml`, and related vocabulary index or
 prose boundaries in `references/cli/vocabulary.md`.
2. **Guards and tests** — `packages/cli/src/upgrade/compatibility.ts`,
 `packages/cli/src/upgrade/channels.ts`, and `packages/cli/test/upgrade/`
 backport-safety coverage (`backportSafety.test.ts` proves stable-channel dry-run
 payloads contain zero v3 migration operations).
3. **Orchestrator and migration modules** — `upgradeOrchestrator.ts`,
 `migrateArtifactsV2ToV3.ts`, and CLI wiring. Keep these active only when the
 running CLI distribution major is 3; do not enable v3 migration apply paths on
 `main` by default.

Do **not** point stable `@latest` at 3.x or merge orchestrator apply paths that run
v2→v3 migration on `main` until an explicit release decision retires the 2.x support
line. Stable backports should pass the backport-safety gate before merge.

## What's different in v2

| Aspect | v1 | v2 |
|---|---|---|
| Entry point | 12 separate `SKILL.md` files | `skills/agentera/SKILL.md` |
| Artifact format | Markdown | YAML |
| Upgrade path | Manual helper scripts | `npx -y agentera@latest upgrade` (stable channel) or `uv run scripts/agentera upgrade` from a clone |
| State CLI | none | `npx -y agentera prime` or `uv run scripts/agentera prime` as the dashboard data source, `state` namespace commands, plus advanced `agentera state query <artifact-name> --format json` or `--format yaml` |
| Validation | per-skill | `agentera check validate capability <name-or-path>` plus `agentera check validate capability-contract` for schema self/protocol checks |
| Distribution (v3) | Python app home + uvx | npm `@next` self-contained TypeScript CLI; optional Bun single-binary via `scripts/single-binary.sh` |
| Shared primitives | `SPEC.md` | `skills/agentera/protocol.yaml` |

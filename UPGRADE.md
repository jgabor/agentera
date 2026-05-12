# Upgrading to Agentera v2

## What changed

- **12 standalone skills -> 1 bundled skill** with 12 capabilities under `skills/agentera/`
- **Artifact format**: Markdown -> YAML for agent-facing `.agentera/` files
- **Upgrade CLI**: `uvx --from git+https://github.com/jgabor/agentera agentera upgrade` or `uv run scripts/agentera upgrade` from a clone
- **State CLI**: `uv run scripts/agentera hej`, `uv run scripts/agentera plan`, and other top-level state commands for routine access; `/agentera` still renders the hej dashboard from the `agentera hej` data source, while `uv run scripts/agentera query <artifact-name> --format json|yaml` remains advanced custom access

## Recommended upgrade

### No local clone

Use this path if you installed Agentera through `npx skills`, the Copilot
marketplace, the Codex marketplace, or the OpenCode plugin and do not have a
local clone.

Preview first. This writes nothing and exits non-zero when pending work exists:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project /path/to/project --dry-run
```

Apply local, idempotent upgrade actions:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project /path/to/project --yes --update-packages
```

When the Python package is published, the shorter command is equivalent:

```bash
uvx agentera upgrade --project /path/to/project --dry-run
uvx agentera upgrade --project /path/to/project --yes --update-packages
```

This command installs or refreshes the managed Agentera app under the Agentera
app home before it wires runtime config. Runtime config should not point at uv's
disposable tool cache.

`npx skills update` alone refreshes the visible skill files but does not refresh
the managed Agentera app, migrate project artifacts, retire the old default app
home, or rewrite runtime config. Agentera v2.0.2 keeps a legacy `/hej` bridge so
old entry points can hand users to the command above, but the command above is
the complete upgrade path. With `--update-packages`, it removes package-managed
v1 skill entries and installs `/agentera`.

### Managed app refresh

`codex plugin marketplace upgrade`, `copilot plugin marketplace upgrade`, and
`npx skills update -g -y` refresh package-managed surfaces. They do not
guarantee that the managed app under `AGENTERA_HOME` has the latest
`scripts/agentera` CLI. App-home semantics are centralized in
`scripts/install_root.py`: it defines AGENTERA_HOME precedence, the default
app home, managed/stale/unmanaged states, and read-only
diagnostics.

Bare `/agentera` owns this recovery path. When the installed CLI is missing
`hej`, fails before command discovery, has an outdated `.agentera-bundle.json`
version, or otherwise fails the install status contract, it should show the
app refresh dry run for the resolved app home:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --install-root "$AGENTERA_HOME" --dry-run
```

`--only bundle` is the current compatibility selector for the managed app refresh
phase. The durable location is still the app home, and managed app code is still
installed under `$AGENTERA_HOME/app`.

If the installed app gate cannot execute because `AGENTERA_HOME` is exactly the
deprecated default `$HOME/.agents/agentera` and
`$AGENTERA_HOME/app/scripts/agentera` is missing, do not require a successful
stale CLI invocation and do not first ask the user to unset `AGENTERA_HOME`.
Preview the platform app-home recovery path without `--install-root` so upgrade
can classify the exact deprecated default as recoverable, target the platform app
home, and preview old-default retirement:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --dry-run
```

Only after explicit approval should it apply the same platform app-home recovery
path:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --yes
```

Custom invalid `AGENTERA_HOME` values are different: fix the setting, choose a
managed `--install-root`, or intentionally use force guidance. Do not describe
the exact deprecated default as proof of where the environment value came from.

From a current local clone, inspect the same read-only self-check with:

```bash
uv run scripts/agentera doctor --install-root "$AGENTERA_HOME" --json
```

Only after explicit approval for that same app home should it apply:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --install-root "$AGENTERA_HOME" --yes
```

The apply command refreshes the managed app only. It does not run package
updates, artifact migration, runtime config rewrites, or cleanup phases.
Afterward, retry:

```bash
uv run "$AGENTERA_HOME/app/scripts/agentera" hej
```

If `AGENTERA_HOME` is unset, use the shared app-home contract's default platform
data home. If it points at a missing path, a file, or an unmanaged
directory, do not overwrite it silently; fix/unset `AGENTERA_HOME`, choose a
managed app home, or intentionally use the broader upgrade flow with
force guidance.

### Local clone

Preview first. This writes nothing and exits non-zero when pending work exists:

```bash
uv run scripts/agentera upgrade --project /path/to/project --dry-run
```

Apply local, idempotent upgrade actions:

```bash
uv run scripts/agentera upgrade --project /path/to/project --yes
```

The command migrates v1 project artifacts, installs or refreshes the managed app
when needed, configures selected runtime surfaces, removes fixable outdated v1
runtime artifacts, and runs a postflight setup doctor. Re-running it after a
successful apply should report `noop`.

When `AGENTERA_HOME` is unset, the default app home is the platform data home
for Agentera. If the old default `~/.agents/agentera` still contains
Agentera-managed files, the bundle phase previews retirement of that location,
moves known user state into the selected app home, removes managed legacy files,
and deletes `~/.agents/agentera` when it becomes empty. The artifacts phase also
migrates supported v1 Markdown project artifacts such as `.agentera/PROGRESS.md`,
`.agentera/PLAN.md`, `.agentera/DOCS.md`, and root `VISION.md` into v2 YAML with
backups under `.agentera/backup-v1/` after preview and confirmation.

External package updates are deliberately opt-in because they run `npx` and may touch global runtime installs. The package phase removes legacy v1 skill entries and installs the active `/agentera` skill:

```bash
uv run scripts/agentera upgrade --project /path/to/project --yes --update-packages
```

## Runtime notes

### Claude Code

`agentera upgrade` does not require Claude access and does not run Claude smoke tests. Package refresh is skipped unless `--update-packages` is set.

### OpenCode

The upgrade command can copy the current bundled plugin to the OpenCode config directory and remove outdated v1 command files. OpenCode package refresh remains opt-in:

```bash
uv run scripts/agentera upgrade --runtime opencode --yes --update-packages
```

Use `--opencode-config-dir PATH` to target a non-default OpenCode config directory.

### Codex

The upgrade command writes `AGENTERA_HOME` into `~/.codex/config.toml`, enables trusted Codex hooks state for the installed `~/.codex/hooks.json`, and copies `hooks/codex-hooks.json` to `~/.codex/hooks.json`. Agentera v2 is one bundled `$agentera` skill; the old per-skill `[agents.<name>]` Codex config blocks are v1 artifacts and are not written.

```bash
uv run scripts/agentera upgrade --runtime codex --yes
```

### Copilot CLI

The upgrade command updates the managed `AGENTERA_HOME` shell rc block used by Copilot. Use `--copilot-rc-file PATH` to preview or target a specific rc file.

```bash
uv run scripts/agentera upgrade --runtime copilot --yes
```

## Focused phases

Run one phase at a time when you want more control:

```bash
uv run scripts/agentera upgrade --only artifacts --project /path/to/project --yes
uv run scripts/agentera upgrade --only runtime --runtime codex --yes
uv run scripts/agentera upgrade --only cleanup --yes
uv run scripts/agentera upgrade --only packages --runtime opencode --yes --update-packages
```

## What's different in v2

| Aspect | v1 | v2 |
|---|---|---|
| Entry point | 12 separate `SKILL.md` files | `skills/agentera/SKILL.md` |
| Artifact format | Markdown | YAML |
| Upgrade path | Manual helper scripts | `uvx --from git+https://github.com/jgabor/agentera agentera upgrade` or `uv run scripts/agentera upgrade` |
| State CLI | none | `uv run scripts/agentera hej` as the dashboard data source, top-level state commands, plus advanced `uv run scripts/agentera query <artifact-name> --format json` or `--format yaml` |
| Validation | per-skill | `uv run scripts/validate_capability.py skills/agentera/capabilities/<name>` |
| Shared primitives | `SPEC.md` | `skills/agentera/protocol.yaml` |

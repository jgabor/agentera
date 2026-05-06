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

This command installs or refreshes a durable Agentera bundle at
`~/.agents/agentera` before it wires runtime config. Runtime config should not
point at uv's disposable tool cache.

`npx skills update` alone refreshes skill files but does not migrate project
artifacts or runtime config. Agentera v2.0.2 keeps a legacy `/hej` bridge so old
entry points can hand users to the command above, but the command above is the
complete upgrade path. With `--update-packages`, it removes package-managed v1
skill entries and installs `/agentera`.

### Durable bundle refresh

`codex plugin marketplace upgrade`, `copilot plugin marketplace upgrade`, and
`npx skills update -g -y` refresh package-managed surfaces. They do not
guarantee that the durable suite bundle under `AGENTERA_HOME` has the latest
`scripts/agentera` CLI. Install-root semantics are centralized in
`scripts/install_root.py`: it defines AGENTERA_HOME precedence, the default
durable root, managed/stale/unmanaged classifications, and read-only diagnostics.

Bare `/agentera` owns this recovery path. When the installed CLI is missing
`hej`, fails before command discovery, has a stale `.agentera-bundle.json`
version, or otherwise fails the freshness contract, it should show the
bundle-only dry run for the resolved install root:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --install-root "$AGENTERA_HOME" --dry-run
```

Only after explicit approval for that same root should it apply:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --install-root "$AGENTERA_HOME" --yes
```

The apply command refreshes the durable bundle only. It does not run package
updates, artifact migration, runtime config rewrites, or cleanup phases.
Afterward, retry:

```bash
uv run "$AGENTERA_HOME/scripts/agentera" hej
```

If `AGENTERA_HOME` is unset, use the shared Module's default durable root
`~/.agents/agentera`. If it points at a missing path, a file, or an unmanaged
directory, do not overwrite it silently; fix/unset `AGENTERA_HOME`, choose a
managed `--install-root`, or intentionally use the broader upgrade flow with
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

The command migrates v1 project artifacts, installs or refreshes the durable
bundle when needed, configures selected runtime surfaces, removes fixable stale
v1 runtime artifacts, and runs a postflight setup doctor. Re-running it after a
successful apply should report `noop`.

External package updates are deliberately opt-in because they run `npx` and may touch global runtime installs. The package phase removes legacy v1 skill entries and installs the active `/agentera` skill:

```bash
uv run scripts/agentera upgrade --project /path/to/project --yes --update-packages
```

## Runtime notes

### Claude Code

`agentera upgrade` does not require Claude access and does not run Claude smoke tests. Package refresh is skipped unless `--update-packages` is set.

### OpenCode

The upgrade command can copy the current bundled plugin to the OpenCode config directory and remove stale v1 command files. OpenCode package refresh remains opt-in:

```bash
uv run scripts/agentera upgrade --runtime opencode --yes --update-packages
```

Use `--opencode-config-dir PATH` to target a non-default OpenCode config directory.

### Codex

The upgrade command writes `AGENTERA_HOME` into `~/.codex/config.toml` and copies `hooks/codex-hooks.json` to `~/.codex/hooks.json`. Agentera v2 is one bundled `$agentera` skill; the old per-skill `[agents.<name>]` Codex config blocks are v1 artifacts and are not written.

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

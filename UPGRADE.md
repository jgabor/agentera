# Upgrading to Agentera v2

## What changed

- **12 standalone skills -> 1 bundled skill** with 12 capabilities under `skills/agentera/`
- **Artifact format**: Markdown -> YAML for agent-facing `.agentera/` files
- **Upgrade CLI**: `uv run scripts/agentera upgrade`
- **Query CLI**: `uv run scripts/agentera query <artifact-name>`

## Recommended upgrade

Preview first. This writes nothing and exits non-zero when pending work exists:

```bash
uv run scripts/agentera upgrade --project /path/to/project --dry-run
```

Apply local, idempotent upgrade actions:

```bash
uv run scripts/agentera upgrade --project /path/to/project --yes
```

The command migrates v1 project artifacts, configures selected runtime surfaces, removes fixable stale v1 runtime artifacts, and runs a postflight setup doctor. Re-running it after a successful apply should report `noop`.

External package updates are deliberately opt-in because they run `npx` and may touch global runtime installs:

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
| Upgrade path | Manual helper scripts | `uv run scripts/agentera upgrade` |
| Query CLI | none | `uv run scripts/agentera query <artifact-name>` |
| Validation | per-skill | `uv run scripts/validate_capability.py skills/agentera/capabilities/<name>` |
| Shared primitives | `SPEC.md` | `skills/agentera/protocol.yaml` |

# Upgrading to agentera v2

## What changed

- **12 standalone skills → 1 bundled skill** with 12 capabilities under `skills/agentera/`
- **Artifact format**: Markdown → YAML for agent-facing files
- **New query CLI**: `uv run scripts/agentera query <artifact-name>`

## Upgrade steps

### Claude Code

```bash
npx skills update -g -a claude-code --skill '*' -y
```

Replaces 12 skill directories with the single bundled skill.

### OpenCode

```bash
npx skills update -g -a opencode -y
curl -o ~/.config/opencode/plugins/agentera.js https://raw.githubusercontent.com/jgabor/agentera/main/.opencode/plugins/agentera.js
```

The plugin must be re-installed manually (`npx skills` does not manage it).

### Codex

```bash
python3 scripts/setup_codex.py --enable-agents
cp hooks/codex-hooks.json ~/.codex/hooks.json
```

Re-runs setup to update `config.toml` and copies updated hooks.

### Copilot

```bash
python3 scripts/setup_copilot.py
```

Re-runs setup to update the environment variable.

## Project artifact migration

```bash
# Preview conversion (dry run)
uv run scripts/migrate_artifacts_v1_to_v2 --project /path/to/project --dry-run

# Execute conversion (backs up to .agentera/backup-v1/)
uv run scripts/migrate_artifacts_v1_to_v2 --project /path/to/project
```

## What's different in v2

| Aspect | v1 | v2 |
|---|---|---|
| Entry point | 12 separate `SKILL.md` files | `skills/agentera/SKILL.md` |
| Artifact format | Markdown | YAML |
| Query CLI | none | `uv run scripts/agentera query <artifact-name>` |
| Validation | per-skill | `uv run scripts/validate_capability.py skills/agentera/capabilities/<name>` |
| Shared primitives | `SPEC.md` | `skills/agentera/protocol.yaml` |

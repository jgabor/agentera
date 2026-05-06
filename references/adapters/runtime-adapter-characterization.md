# Runtime Adapter Characterization

Task 2 of `Deepen RuntimeAdapter Registry` records current behavior before any
registry extraction. This is a characterization artifact, not the new registry.

## Doctor Output

Current JSON envelope fields are `schemaVersion`, `ok`, `installRoot`,
`runtimes`, `summary`, and `smoke`. Each runtime result exposes `runtime`,
`status`, `available`, `binary`, and `checks`. Each check exposes `name`,
`status`, `message`, `source`, `path`, `gap`, and `details`.

Primary pass messages by runtime:

| Runtime | Primary check | Status | Message | Diagnostic label |
|---------|---------------|--------|---------|------------------|
| Claude Code | `CLAUDE_PLUGIN_ROOT` | `pass` | `runtime can reach shared Agentera helper scripts` | none |
| OpenCode | `plugin_file` | `pass` | `OpenCode plugin file is present` | none |
| Copilot CLI | `AGENTERA_HOME` | `pass` | `runtime can reach shared Agentera helper scripts` | none |
| Codex CLI | `config.AGENTERA_HOME` | `pass` | `runtime can reach shared Agentera helper scripts` | none |

Current diagnostic labels that are intentionally public are `user_environment`,
`runtime_config`, `bundle_packaging`, `command_drift`, `skill_path_drift`, and
`validation_drift`.

## Upgrade Planning

Runtime-phase items currently expose `runtime`, `action`, `target`, `status`,
and `message`; copy operations also expose `source`, and configure operations
carry private `newText` until public JSON rendering strips it.

Characterized runtime actions:

| Runtime | Action | Target | Dry-run status | Apply behavior |
|---------|--------|--------|----------------|----------------|
| Claude Code | `configure` | none | `noop` | no local config write |
| Codex CLI | `configure` | `~/.codex/config.toml` | `pending` | writes config, then reports `runtime update applied` |
| Codex CLI | `copy-hooks` | `~/.codex/hooks.json` | `pending` | copies hooks, then reports `runtime update applied` |
| Copilot CLI | `configure` | shell rc file | `pending` | writes rc configuration, then reports `runtime update applied` |
| OpenCode | `copy-plugin` | `~/.config/opencode/plugins/agentera.js` | `pending` | copies plugin, then reports `runtime update applied` |

Package-phase items currently expose `runtime`, `action`, `command`, `status`,
and `message`. Without `--update-packages`, package items are `skipped`; with it,
Claude Code and OpenCode package commands become `pending` and apply through the
external command runner. Copilot CLI and Codex CLI have no package command item in
the current upgrade phase.

## Lifecycle Validation

Current pass output from `scripts/validate_lifecycle_adapters.py` is exactly:

```text
lifecycle adapter metadata ok
```

Current failure output begins with:

```text
lifecycle adapter validation failed:
```

Representative fail messages are characterized in `tests/test_runtime_adapters.py`:
Copilot stale `lifecycleHooks`, unsupported hook event files, missing `preToolUse`
artifact validation, Codex unsupported status values, malformed event containers,
missing supported-event declarations, missing unsupported-event declarations, and
missing `codex_hooks` limitation text.

## Drift Inventory

| Drift point | Decision | Before-migration handling |
|-------------|----------|---------------------------|
| duplicated runtime order appears in doctor, upgrade, and tests | `standardize` | Later registry extraction should define one runtime order and have consumers read it. |
| upgrade package phase only manages Claude Code and OpenCode | `preserve` | This is current behavior, not a registry gap; Copilot CLI and Codex CLI package command support is separate future work. |
| Codex supports hook events but shipped config wires only apply_patch validation | `preserve` | Keep the distinction between host support and shipped Agentera wiring. |
| Claude lifecycle behavior is validated through native hook files, not lifecycle metadata | `defer` | Do not invent Claude lifecycle metadata in Task 2; decide during registry interface design. |
| OpenCode session preload observes `session.created` but has no verified context injection path | `preserve` | Keep degraded preload semantics in docs and diagnostics. |
| hard-gate docs only claim blocking for reconstructable OpenCode and Copilot candidates | `preserve` | Keep scoped claims; do not standardize to full hard-gate parity. |

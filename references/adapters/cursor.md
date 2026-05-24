# Cursor adapter reference

Agentera v1 ships Cursor as two registry identities:

| Identity | Host | Support status |
| -------- | ---- | -------------- |
| `cursor` | Cursor IDE (Composer / Agent) | supported |
| `cursor-agent` | Cursor Agent CLI (`cursor-agent`, `agent`) | degraded |

Decision 63 owns v1 scope. Cloud agents are unsupported. Bare text `hej` routing
stays metadata-only like Claude, Copilot, and Codex.

## Repo-native surfaces

This repository dogfoods committed Cursor surfaces:

- `.cursor/hooks.json` — sessionStart env export, preToolUse hard gate, postToolUse advisory validation
- `.cursor/agents/*.md` — twelve managed capability descriptors
- `.cursor-plugin/plugin.json` — marketplace submission-ready manifest

Hooks resolve helper scripts through `uv run hooks/...` from the project root.
`sessionStart` exports `AGENTERA_HOME` through Cursor hook JSON (`env`) before
subsequent hook executions run.

## AGENTERA_HOME wiring

Primary path: `hooks/cursor_session_start.py` resolves the install root from
`AGENTERA_HOME`, environment walk-up, or project checkout evidence, then returns
`{"env": {"AGENTERA_HOME": "<root>"}}` plus optional `additional_context` from
the shared session digest.

Fallback: `scripts/setup_cursor.py` reports persistent shell configuration only
when live shell-tool smoke proves session env does not propagate to CLI
subprocesses. Agentera does not write shell rc files by default.

## Artifact validation

| Surface | Behavior | Claim status |
| ------- | -------- | ------------ |
| IDE `preToolUse` (Write/Edit) | Deny invalid reconstructable artifact candidates | Verified after live preToolUse Write smoke (2026-05-24) |
| IDE `postToolUse` (Write/Edit) | Advisory validation through shared `validate_artifact.py` | Active |
| CLI | Degraded; depends on workspace hook install and env propagation | Follows IDE smoke evidence only |

Live preToolUse Write smoke passed on 2026-05-24 with invalid-block and valid-allow
cases recorded in `.agentera/smoke-cursor-pretooluse-evidence.txt`. Conditional
hard-gate claims for reconstructable IDE Write and Edit candidates are verified;
release tagging and marketplace publication remain blocked pending broader release
closeout.

## Subagent dispatch

IDE: managed descriptors under `.cursor/agents/` with `<!-- agentera: managed -->`
ownership markers. Upgrade refreshes Agentera-owned targets and preserves unknown
collisions.

CLI: host-managed `cursor-agent` print mode; no separate TOML descriptor install.
Eval coverage targets `cursor-agent` first.

## Upgrade and doctor

```bash
uv run scripts/agentera upgrade --runtime cursor --dry-run
uv run scripts/agentera doctor --runtime cursor
```

Upgrade copies managed hooks, agents, and plugin metadata into target projects
with the same ownership protections used for OpenCode and Codex.

Doctor reports helper access, hook presence, and managed agent alignment.

## Eval

```bash
uv run scripts/eval_skills.py --runtime cursor-agent --skill hej --dry-run
```

Print mode uses `cursor-agent -p --output-format json --force`. Harnesses apply
bounded timeouts because some CLI builds hang after completion.

## Unsupported in v1

- Cloud agents (no project hook or managed-agent guarantees)
- Bare `hej` prompt rewrite routing
- Session compaction injection beyond shared hook helpers
- Separate cursor-agent hook install distinct from IDE workspace surfaces

## Source of truth

RuntimeAdapter records live in
`references/adapters/runtime-adapter-registry.yaml`. Parity comparisons belong in
`references/adapters/runtime-feature-parity.md`.

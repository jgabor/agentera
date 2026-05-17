# Runtime feature parity reference

Tracks release-relevant runtime behavior for the portable agentera suite.

This reference distinguishes implemented behavior from host support. A runtime
may expose an event while agentera still lacks a shipped adapter path for it.

## Summary

| Runtime | Skill loading | Session preload | Artifact validation | Session bookmark |
|---------|---------------|-----------------|---------------------|------------------|
| Claude Code | Full: marketplace plugin and native skill paths load `skills/<name>/SKILL.md` | Active via `SessionStart` in `hooks/hooks.json` | Advisory after mutation via `PostToolUse` for `Edit` or `Write` | Active via `Stop` |
| OpenCode | Full: native `skill` tool loads `.opencode`, `.claude`, and `.agents` skill paths | Deferred: `session.created` is observable, but no model-context injection path is verified | Conditional hard gate for reconstructable `write` and `edit` candidates via `tool.execute.before`; `tool.execute.after` remains advisory | Active via generic `event` hook on `session.idle` |
| Copilot CLI | Full for portable skills through plugin or skill-folder install paths | Active via `sessionStart` | Conditional hard gate via `preToolUse` when `toolArgs` include path plus candidate content or exact replacement evidence | Active via `sessionEnd` |
| Codex CLI | Full for portable skills through plugin install, `.agents/skills`, and `$skill` invocation | Not wired by the shipped hook config | Advisory `apply_patch` path validation through shipped PreToolUse and PostToolUse hooks; final patch content is not reconstructed | Not wired by the shipped hook config |

## Bare `hej` routing

| Runtime | Bare text `hej` behavior | Evidence |
|---------|--------------------------|----------|
| OpenCode | Deterministic exact-match adapter route through `chat.message`; only a complete lowercase text message `hej` is rewritten to load `agentera` and run the `agentera hej` dashboard path, accepting OpenCode's CLI-added single trailing newline as a transport artifact. | `.opencode/plugins/agentera.js`, `scripts/smoke_opencode_bootstrap.mjs`, OpenCode `packages/plugin/src/index.ts` Hooks interface |
| Claude Code | Metadata/context only; `UserPromptSubmit` can observe or add context but is not a verified prompt rewrite router. | `skills/agentera/SKILL.md`, marketplace metadata |
| Copilot CLI | Metadata/context only; skills, prompts, hooks, and plugins expose Agentera but do not guarantee pre-model bare-prompt routing. | `plugin.json`, `.github/plugin/plugin.json`, `.github/hooks` |
| Codex CLI | Metadata/context only; `$agentera` is explicit and the legacy `$hej` bridge is not implicitly invocable. | `.codex-plugin/plugin.json`, `agents/openai.yaml` |

## Artifact validation

| Runtime | Blocking surface | Implemented gate | Evidence-insufficient paths | Verification surface |
|---------|------------------|------------------|-----------------------------|----------------------|
| Claude Code | None in shipped config; validation runs after `Edit` or `Write` | No pre-write hard gate is claimed | Any invalid artifact can already be written before the warning appears | `hooks/hooks.json`, `hooks/validate_artifact.py` |
| OpenCode | `tool.execute.before` can throw before mutation | Invalid reconstructable artifact `write` and `edit` candidates are blocked | Sparse payloads and `apply_patch` `patchText` without reconstructed full content are allowed | `.opencode/plugins/agentera.js`, `scripts/smoke_opencode_bootstrap.mjs` |
| Copilot CLI | `preToolUse` returns `permissionDecision: deny` | Invalid reconstructable artifact candidates are denied | Malformed, sparse, or non-reconstructable `toolArgs` are allowed | `.github/hooks/preToolUse.json`, `hooks/validate_artifact.py`, `tests/test_validate_artifact.py` |
| Codex CLI | `codex_hooks` can run before and after `apply_patch` | No content hard gate is claimed; the shipped hook parses touched paths and validates existing files | Add-file targets and final post-patch candidate content are not reconstructed by the adapter | `hooks/codex-hooks.json`, `hooks/validate_artifact.py`, live apply_patch hook firing smoke |

Docs may claim functional hard-gate parity only for closeable paths that are
implemented and verified. Today that means OpenCode and Copilot reconstructable
artifact candidates. Claude Code and Codex remain active validation surfaces,
but neither shipped configuration blocks every invalid artifact candidate before
mutation.

## Lifecycle notes

| Runtime | Runtime reason for degraded or blocked capability |
|---------|---------------------------------------------------|
| OpenCode preload | The `event` hook observes `session.created`, but no supported adapter path injects text into model context. |
| OpenCode `apply_patch` hard gate | The adapter receives `patchText` without reconstructing full candidate content. It allows that path rather than guessing. |
| Copilot sparse edits | Copilot `preToolUse` stdin may omit full content or unique old/new replacement evidence. The hook allows those payloads. |
| Codex preload/bookmarks | `codex_hooks` supports lifecycle events, but `hooks/codex-hooks.json` ships only `apply_patch` PreToolUse/PostToolUse wiring. |
| Codex artifact hard gate | The adapter parses patch headers for touched paths, but it does not reconstruct final candidate content for blocking validation. |

## Subagent Dispatch

| Runtime | Dispatch surface | Descriptor source | Verification surface |
|---------|------------------|-------------------|----------------------|
| Claude Code | Native Task/subagent surface | Host-managed; no Agentera descriptor files shipped for this phase | RuntimeAdapter registry |
| OpenCode | `@<capability>` descriptors under `~/.config/opencode/agents` | `.opencode/agents/*.md`, bootstrapped by `.opencode/plugins/agentera.js` | `scripts/smoke_opencode_bootstrap.mjs`, `agentera validate descriptors` |
| Copilot CLI | User-driven host action such as `/fleet` when available | Host-managed; no Agentera descriptor files shipped for this phase | RuntimeAdapter registry |
| Codex CLI | Native agent descriptors under `~/.codex/agents` or project `.codex/agents` with bounded `[agents]` settings | `skills/agentera/agents/*.toml`, installed by `scripts/setup_codex.py` and `agentera upgrade` | `agentera validate descriptors`, `tests/test_setup_codex.py`, `tests/test_upgrade_cli.py` |

Agentera v2 does not write legacy `[agents.<name>]` Codex config blocks. Capability dispatch must use runtime-native subagent descriptors or host Task surfaces, not unsupported `agentera <capability>` CLI commands.

## Copilot install notes

Recommended marketplace install:

```bash
copilot plugin marketplace add jgabor/agentera
copilot plugin install <skill>@agentera
```

Umbrella install:

```bash
copilot plugin install jgabor/agentera
```

The marketplace install path is verified working. Granular installs avoid
umbrella discovery bug `github/copilot-cli#2390`.

Granular installs provide core `SKILL.md` behavior. App-home tools such as
doctor, installer, validators, and shared setup helpers require the managed
Agentera app or a local clone with the shared `scripts/` directory.

Deprecated fallback: `copilot plugin install OWNER/REPO`, Git URLs, and local
paths still work, but Copilot warns they are deprecated.

## Source of truth

Runtime adapter facts are owned by the RuntimeAdapter registry at
`references/adapters/runtime-adapter-registry.yaml` and loaded through
`scripts/runtime_adapter_registry.py`. This reference may describe registry
claims, but changes to runtime identity, lifecycle events, artifact-validation
support, subagent dispatch, config targets, diagnostics, or documentation claims must be validated
against the registry rather than duplicated here as an independent table.

App-home classification is not runtime-specific. `scripts/install_root.py` is
the shared Module for `AGENTERA_HOME`, the normal user data root, managed app,
out-of-date app, unknown directories, and diagnostic semantics. Package metadata
registry work stays outside both the RuntimeAdapter registry and this shared
classification Module.

| Surface | Path |
|---------|------|
| Shared artifact validator | `hooks/validate_artifact.py` |
| Claude Code hook registry | `hooks/hooks.json` |
| OpenCode plugin | `.opencode/plugins/agentera.js` |
| OpenCode agent descriptors | `.opencode/agents/*.md` |
| Copilot pre-write hook | `.github/hooks/preToolUse.json` |
| Codex hook config | `hooks/codex-hooks.json` |
| Codex agent descriptors | `skills/agentera/agents/*.toml` |
| RuntimeAdapter registry | `references/adapters/runtime-adapter-registry.yaml` |
| RuntimeAdapter registry loader | `scripts/runtime_adapter_registry.py` |
| Lifecycle metadata validator | `scripts/validate_lifecycle_adapters.py` |

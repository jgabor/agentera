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

Deprecated fallback: `copilot plugin install OWNER/REPO`, Git URLs, and local
paths still work, but Copilot warns they are deprecated.

## Source of truth

| Surface | Path |
|---------|------|
| Shared artifact validator | `hooks/validate_artifact.py` |
| Claude Code hook registry | `hooks/hooks.json` |
| OpenCode plugin | `.opencode/plugins/agentera.js` |
| Copilot pre-write hook | `.github/hooks/preToolUse.json` |
| Codex hook config | `hooks/codex-hooks.json` |
| Lifecycle metadata validator | `scripts/validate_lifecycle_adapters.py` |

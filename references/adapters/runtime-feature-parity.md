# Runtime feature parity

Release-relevant behavior is governed by
`runtime-lifecycle-authority.yaml` and `runtime-lifecycle-adapters.yaml`.
Active runtime IDs are exactly `opencode`, `codex`, `cursor`, and `copilot`.

`cursor-agent` is an inactive compatibility alias and Cursor CLI source-product
name beneath the single `cursor` identity. It is never an active runtime ID.
Claude Code is a retired migration and consent-gated historical-import source,
not a supported runtime.

## Lifecycle identity and support floor

| Runtime | Required surface | Conditional surface | Canonical skill |
| --- | --- | --- | --- |
| OpenCode | host | — | `~/.agents/skills/agentera` |
| Codex | CLI | — | `~/.agents/skills/agentera` |
| Cursor | Agent CLI | IDE | `~/.agents/skills/agentera` |
| GitHub Copilot | CLI | — | `~/.agents/skills/agentera` |

The support floor requires the canonical skill, complete diagnosis, and
resolved mandatory evidence. Unknown or missing mandatory evidence and denied
trust block release. A known false installation or enablement state is
diagnosed as degraded. An unobserved conditional Cursor IDE is
`not_applicable` and does not block CLI support.

`prime` projects a bounded summary from this lifecycle snapshot. `doctor`
projects detailed evidence and exact actions from the same snapshot.

## Common adapter contract

Every active runtime reports the same eight categories:

| Category | Meaning |
| --- | --- |
| skills | Canonical and additional skill discovery locations |
| plugins | Agentera plugin package or host plugin state |
| hooks | Session and tool lifecycle wiring |
| agents | Runtime-native Agentera descriptors |
| configuration | User or project configuration evidence |
| enablement | Whether the host has enabled the integration |
| trust | Observed trust state; never inferred or approved |
| native actions | Exact user-owned host/package-manager steps |

Each runtime/surface/category claim declares capability, evidence, and
remediation. Unsupported or unverified host behavior cannot satisfy a mandatory
support floor.

## Host behavior

| Runtime | Skill/package source | Hook and validation behavior | Agent behavior |
| --- | --- | --- | --- |
| OpenCode | Portable skill plus `.opencode/plugins/agentera.js` | Conditional hard gate for reconstructable write/edit candidates; sparse or unreconstructed patches remain advisory | Single Agentera descriptor in `.opencode/agents/agentera.md` |
| Codex | `.codex-plugin/plugin.json`, shared skill, and marketplace entry | Plugin and copied-hook sources validate `apply_patch` paths before/after use; final patch content is not reconstructed | Capability TOML descriptors under `skills/agentera/agents/` |
| Cursor | One identity spanning Agent CLI and optional IDE plugin | IDE hooks provide session context and conditional hard-gate validation for reconstructable Write/Edit candidates | One IDE Agentera descriptor; CLI uses the Cursor-owned binary surface |
| GitHub Copilot | Root and repository plugin manifests | `sessionStart`, `sessionEnd`, `preToolUse`, and `postToolUse`; reconstructable candidates are denied before mutation | Host-managed dispatch; no Agentera-specific Copilot agent descriptor |

The validated hard-gate claims retain their exact scope:

- OpenCode: Conditional hard gate for reconstructable write and edit candidates. Sparse payloads and apply_patch patchText without reconstructed full content are allowed.
- GitHub Copilot: Conditional hard gate via preToolUse. Malformed, sparse, or non-reconstructable toolArgs are allowed.
- Cursor: Conditional hard gate for reconstructable Write and Edit candidates via preToolUse; verified after live preToolUse Write smoke (2026-05-24). Malformed, sparse, or non-reconstructable tool_input payloads are allowed.

Agentera never upgrades a runtime binary, runs a native marketplace/package
manager, authenticates, enables a plugin, or approves trust. Those operations
are emitted as `action_required`.

## Lifecycle repair

```bash
agentera upgrade --runtime all --dry-run
agentera upgrade --runtime all --yes
```

Preview is side-effect free. Apply is limited to declared Agentera-owned
resources with matching ownership-journal evidence. Secure automatic
publication currently requires Linux `/proc/self/fd`; other platforms receive
the same plan as explicit actions.

Outcomes are `applied`, `noop`, `failed`, `blocked_unowned`,
`skipped_dependency`, and `action_required`. Independent operations continue
after a local failure, and retries re-observe state so completed work becomes
`noop`.

## Corpus sources

| Runtime identity | Source product | Default analytics |
| --- | --- | --- |
| Codex | Codex session JSONL | included |
| OpenCode | OpenCode SQLite store | included |
| Cursor | Cursor IDE JSONL | included |
| Cursor | Cursor Agent CLI SQLite source (`cursor-agent`) | included as Cursor gap-fill |
| GitHub Copilot | Copilot session SQLite store | included |
| none | Claude Code JSONL | excluded; requires `--import-source claude` |

Claude imports use `historical_import` provenance and `active_runtime: false`.
They never add Claude to runtime inventories, readiness, or default analytics.

## Package release surface

The npm bundle contains the shared skill and contract data plus every declared
runtime source:

- OpenCode package, plugin, command, and agent files;
- Codex plugin manifest, plugin hooks, copied-hook fallback, and capability agents;
- Cursor plugin manifest, IDE hooks, and agent descriptor;
- GitHub Copilot root/repository manifests and lifecycle hook files.

`.claude-plugin/marketplace.json` is retired and must not be packaged.

## Validation boundary

`agentera check validate lifecycle-adapters` validates:

- lifecycle authority and exact four-runtime identity parity;
- all eight categories and every declared runtime surface;
- package-manifest coverage for all active runtimes;
- npm-bundle coverage for every lifecycle source and runtime manifest;
- 3.0.0 version mirrors;
- runtime-specific hook and documentation claims;
- absence of retired Claude package manifests.

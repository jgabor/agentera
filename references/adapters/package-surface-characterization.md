# Package surface characterization

Current Agentera 3.0 package behavior is owned by
`references/adapters/package-registry.yaml` and the TypeScript
`PackageRegistry` loader.

## Version matrix

`registry.json` `skills[0].version` is the persisted suite authority. These
mirrors must match it:

| Surface | Selector |
| --- | --- |
| `packages/cli/package.json` | `version` and `agentera.suiteVersion` |
| `packages/cli/package-lock.json` | `version` |
| `plugin.json` | `version` |
| `.github/plugin/plugin.json` | `version` |
| `.codex-plugin/plugin.json` | `version` |
| `.cursor-plugin/plugin.json` | `version` |
| `.opencode/plugins/agentera.js` | `AGENTERA_VERSION` |
| `skills/agentera/SKILL.md` | frontmatter `version` |

`.opencode/package.json` is a runtime package manifest but intentionally has no
suite-version field.

## Active runtime manifests

The runtime manifest set covers exactly OpenCode, Codex, Cursor, and GitHub
Copilot. Claude has no package or marketplace manifest.

| Runtime | Manifest sources |
| --- | --- |
| OpenCode | `.opencode/package.json` |
| Codex | `.codex-plugin/plugin.json` |
| Cursor | `.cursor-plugin/plugin.json` |
| GitHub Copilot | `plugin.json`, `.github/plugin/plugin.json` |

## npm bundle

The self-contained npm package ships `dist/` plus `bundle/`. Bundle data
includes the shared skill, contracts, references, release docs, and every
runtime lifecycle/package source declared by the registry:

- `.opencode/commands`, `.opencode/agents`, `.opencode/plugins`, and package manifest;
- `.codex-plugin` and both Codex hook sources under `hooks/`;
- `.cursor-plugin`, `.cursor/hooks.json`, and `.cursor/agents`;
- Copilot root/repository manifests and `.github/hooks`;
- `skills`, `references`, `registry.json`, README, upgrade guide, changelog,
  design, and license.

Packaging tests inspect `npm pack --dry-run --json --ignore-scripts` and fail if
any declared runtime source disappears. The retired Claude manifest is also a
negative assertion.

## Package-manager boundary

Lifecycle upgrade does not execute runtime-native package managers. Legacy
portable-skill cleanup and the OpenCode portable-skill install specification
remain argv-only package-registry records behind their existing update and
approval gates. Native installation, enablement, authentication, and trust are
user-owned actions.

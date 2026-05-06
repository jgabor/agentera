# Package Surface Characterization

Characterized on 2026-05-06 before the PackageManifest registry migration. This file records current behavior only; it is not the registry design.

The executable PackageManifest registry at `references/adapters/package-registry.yaml` and its loader `scripts/package_registry.py` now own the single source of truth for version surfaces, runtime package manifests, bundle surfaces, package commands, and docs targets. Validators, upgrade, and tests consume registry facts instead of duplicating constants.

## Version-Bearing Surfaces

`registry.json` is the persisted suite-version authority. The current suite version is `2.1.1` at `skills[0].version`.

The current version-bearing surfaces are:

| Surface | Kind | Current behavior |
| --- | --- | --- |
| `registry.json` | version-bearing surface | `skills[0].version` is the suite authority. |
| `pyproject.toml` | version-bearing surface | `[project].version` matches the registry suite version. |
| `plugin.json` | version-bearing surface and runtime package manifest | root Copilot manifest `version` matches the suite version. |
| `.github/plugin/plugin.json` | version-bearing surface and runtime package manifest | repository Copilot manifest `version` matches the suite version. |
| `.codex-plugin/plugin.json` | version-bearing surface and runtime package manifest | Codex manifest `version` matches the suite version. |
| `.claude-plugin/marketplace.json` | version-bearing surface and runtime package manifest | `metadata.version` and every plugin entry version, including the legacy `hej` bridge, match the suite version. |
| `.opencode/plugins/agentera.js` | version-bearing surface | `AGENTERA_VERSION` matches the registry suite version and drives the OpenCode command marker file `.agentera-version`. |

`.opencode/package.json` is intentionally not version-bearing. Its current behavior is runtime package manifest behavior only: it keeps `type: "module"`, `dependencies["@opencode-ai/plugin"] == "1.14.33"`, and an `agentera` suite-bundle metadata block, but it has no top-level `name` or `version` field.

## Package-Manager Command Surface

Upgrade package planning currently emits package-manager commands only for Claude Code and OpenCode runtime selections.

| Runtime | Action | Command argv | Skipped message | Dry-run behavior | Apply behavior with mocked command |
| --- | --- | --- | --- | --- | --- |
| `all` | `remove-legacy-skills` | `npx skills remove hej visionera resonera inspirera planera realisera inspektera optimera orkestrera visualisera dokumentera profilera -g -y` | `legacy skill removal skipped; pass --update-packages to run` | `--update-packages` without `--yes` leaves status `pending` and does not execute. | status becomes `applied`, message `package update completed`, and command result tails are recorded. |
| `claude` | `install-agentera-skill` | `npx skills add jgabor/agentera -g -a claude-code --skill agentera -y` | `external package update skipped; pass --update-packages to run` | `--update-packages` without `--yes` leaves status `pending` and does not execute. | status becomes `applied`, message `package update completed`, and command result tails are recorded. |
| `opencode` | `install-agentera-skill` | `npx skills add jgabor/agentera -g -a opencode --skill agentera -y` | `external package update skipped; pass --update-packages to run` | `--update-packages` without `--yes` leaves status `pending` and does not execute. | status becomes `applied`, message `package update completed`, and command result tails are recorded. |

Write gating is preserved: `--update-packages` changes package items from `skipped` to `pending`, but package-manager commands execute only during apply mode behind `--yes`. Focused tests mock `subprocess.run`; no live package-manager call is part of this characterization.

## Bundle And Docs Drift Inventory

| Drift point | Surface class | Decision | Current behavior to preserve before migration |
| --- | --- | --- | --- |
| `pyproject.toml` force-includes and `scripts/agentera_upgrade.py` bundle lists duplicate the same shipped bundle directories and files. | bundle metadata surface | `standardize` | Keep both lists aligned now; later PackageManifest should own the list once. |
| Lifecycle validation requires only the minimal shared runtime package paths (`skills`, `scripts`, `hooks`, `registry.json`, `plugin.json`, `pyproject.toml`, `README.md`) while pyproject and upgrade copy the larger distributable bundle. | runtime package manifest | `standardize` | Keep the validator as a minimum package-shape check now; later PackageManifest should separate minimal runtime metadata from full bundle includes. |
| Runtime manifest `agentera.sharedPaths` includes `UPGRADE.md`, but `SUITE_BUNDLE_REQUIRED_PATHS` does not require it. | runtime package manifest | `standardize` | Keep current validator leniency now; later PackageManifest should make required shared paths explicit in one place. |
| `.agentera/docs.yaml` `version_files` includes version-bearing surfaces and excludes `.opencode/package.json`. | version-bearing surface | `preserve` | Keep `.opencode/package.json` out of version checks because it is a runtime package manifest, not a suite version surface. |
| `.opencode/package.json` is force-included and bundled, but it is not in docs `version_files`. | runtime package manifest | `preserve` | Keep packaging it without treating it as version-bearing. |
| Upgrade package commands are represented as argv lists for Claude Code and OpenCode only; Codex and Copilot have runtime manifests but no package-manager command entries. | package-manager command surface | `preserve` | Keep command planning limited to currently managed package runtimes. |
| `.claude-plugin/marketplace.json` carries a `hej` legacy bridge version alongside `agentera`. | version-bearing surface | `defer` | Keep the legacy bridge version aligned until a separate legacy-bridge removal or marketplace simplification task exists. |
| Live package-manager behavior is not characterized by this task. | package-manager command surface | `defer` | Keep tests mocked; do not introduce live `npx skills` execution. |

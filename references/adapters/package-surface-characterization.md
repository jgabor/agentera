# Package surface characterization

Current Agentera 3.0 package behavior is owned by
`references/adapters/package-registry.yaml` and the TypeScript
`PackageRegistry` loader. The package has two product surfaces: the CLI and the
canonical shared skill.

## Version matrix

`registry.json` `skills[0].version` is the persisted suite authority. Tracked
suite mirrors must match it exactly. The npm package `version` may carry a
development pre-release suffix, but its `X.Y.Z` core must match the suite:

| Surface | Selector |
| --- | --- |
| `packages/cli/package.json` | `version` (development pre-release) and `agentera.suiteVersion` (suite) |
| `skills/agentera/SKILL.md` | frontmatter `version` |

`packages/cli/package.json#agentera.gitRef` identifies the last substantive
package-source commit, not a later verification-only commit. Repository-local
release validation requires that commit to exist and compares the package
contract, compiled-source inputs, scripts, and bundled-data inputs against it.
Only the package version and `gitRef`, project state, and the release validator
implementing this check are excluded, avoiding a circular source reference.

## npm bundle

Contributor construction, checkout-generation, and recovery behavior is owned
by [`docs/packaging/v3-packaging.md`](../../docs/packaging/v3-packaging.md).

The self-contained npm package ships `dist/` plus `bundle/`. Bundle data
includes the canonical `skills/` tree, required `references/`, `registry.json`,
and package guidance. Compiled commands ship in `dist/`. The shared-skill tree
includes its capability schemas, artifact schemas, and canonical
`skills/agentera/agents/*.toml` descriptors.

The package lane's isolated package fixture invokes `npm pack --json
--ignore-scripts` after governed construction and fails if the CLI or required
bundle data disappears, or if a current host-native descriptor/runtime path
enters the package. Contributors use `pnpm -C packages/cli run pack:dry-run`;
direct checkout packing remains rejected by the canonical packaging authority.

## Native package boundary

The package registry defines no host-native manifest parity, package-manager
command, runtime source tree, or native install command. Historical migration
readers and fixtures remain source-only compatibility data; they do not create a
current integration surface in the npm inventory.

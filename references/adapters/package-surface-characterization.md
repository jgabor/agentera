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
the frozen routing evaluation corpus, and package guidance. Compiled commands
ship in `dist/`. The shared-skill tree includes its capability schemas and artifact schemas.

The package lane's isolated package fixture invokes `npm pack --json
--ignore-scripts` after governed construction and fails if the CLI or required
bundle data disappears, or if a current host-native descriptor/runtime path
enters the package. Contributors use `pnpm -C packages/cli run pack:dry-run`;
direct checkout packing remains rejected by the canonical packaging authority.

`bootstrap_command_authority` closes the command-guidance inventory. Markdown,
YAML, and JSON bundle surfaces are parsed and scanned in source and extracted
package layouts. Other files need a path-specific reason. Generated files need
a source-side producer reason and are parsed after construction. Every source
module that emits a command through the pre-cutover constructor, an imported
alias, local wrapper, or re-export must appear in the emitted-producer list with
an inspectable reason. Bounded TypeScript AST discovery closes that set.
Normalized source and extracted-package records must match in path, kind,
classification, and reason; aggregate outputs are scanned separately. New,
missing, malformed, stale, mismatched, or unclassified surfaces and producers
fail package policy. This avoids a blind scan of compiled JavaScript while
still checking generated behavior.

## Publication adapters

[`package-publication.json`](./package-publication.json) owns the shared
repository publication transaction and distinguishes the development
TypeScript package from the transitional stable shim. Both require separately
prepared and committed version and `gitRef` metadata, explicit publication
authority, a clean tree, exact registry convergence, safe exact-version replay,
and bounded phase results. Development retains isolated construction and the
`next` tag; stable retains shim tests/construction and the `latest` tag. Each
adapter's only publication smoke is its non-mutating, no-project exact-version
`--version` invocation, so publication does not absorb migration coverage.

## Native package boundary

The package registry defines no host-native manifest parity, package-manager
command, runtime source tree, or native install command. Historical migration
readers and fixtures remain source-only compatibility data; they do not create a
current integration surface in the npm inventory.

## Maintenance

- Maintainer: Agentera CLI maintainers
- Source checkout root: `.`
- Working directory: `.`
- Command: `pnpm -C packages/cli run pack:dry-run`

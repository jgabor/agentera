# v3 npm packaging and verification

Agentera v3 has one distribution boundary: the self-contained `agentera` npm
package used by `npx -y agentera@next`. Native runtime packages, editor
packages, and the former Bun single-binary surface are retired.

## Package layout

`packages/cli/package.json` publishes `dist/` and `bundle/`:

```text
agentera-<version>.tgz
└── package/
    ├── package.json
    ├── dist/bin/agentera.js
    └── bundle/
        ├── .agentera-npx-bundle.json
        ├── registry.json
        ├── skills/agentera/
        └── references/
```

`packages/cli/scripts/copy-bundle.mjs` stages the registry-declared shared
skill and reference inputs. The `prepack` lifecycle compiles TypeScript and
stages those inputs before npm publication.

## Verification ownership

The two verification lanes are independent:

| Lane | Entry point | Owns |
| ---- | ----------- | ---- |
| Source | `pnpm -C packages/cli test` (`test:source`) | Detailed command behavior, failure matrices, schemas, state, migration, and source contracts. It excludes `test/packaging/**`; its transient TypeScript subprocess output lives in a temporary directory and never stages package data. |
| Package | `pnpm -C packages/cli run verify:package` | One build, focused bundle filesystem safety, tarball construction, authority-derived manifest inventory, extraction, production install, and the minimum isolated invocation and packed-upgrade conjunctions. |

`packages/cli/test/packaging/packageSetup.ts` is the canonical package fixture.
It builds once, packs with lifecycle scripts disabled to prevent a second
build, extracts once, and installs once. `packageVerification.test.ts` consumes
the fixture for complete manifest classification and isolated installed-package
conjunctions. `copyBundleSafety.test.ts` consumes it for focused staging
preflight and filesystem-side-effect failures. A failing lane labels its own
boundary and does not invoke the other lane.

Pre-commit runs the source lane only. CI runs both lanes explicitly. Release
gates may add metadata and dry-run publication checks, but must use the same
package construction path rather than adding another extracted-package matrix.

## Ownership inventory

- Detailed runtime behavior and failure coverage stays under source-owned test
  areas such as `test/cli/`, `test/state/`, and `test/upgrade/`.
- `test/packaging/packageVerification.test.ts` owns distribution observations
  and intentionally avoids command/failure matrices.
- `test/packaging/copyBundleSafety.test.ts` owns focused bundle-staging
  containment, collision, registry-shape, and fail-before-side-effect coverage.
- `test/verification/laneOwnership.test.ts` locks the lane configs, scripts,
  independent failure labels, and matrix ownership.

# v3 packaging design

> Authoritative design doc for the v3 Agentera CLI distribution surfaces. This
> file is the single source of truth for the Bun/npm/single-binary packaging
> contract; T1 of `.agentera/plan.yaml` is satisfied when this doc plus
> `packages/cli/test/packaging/prepack.test.ts` plus `scripts/single-binary.sh`
> land on `feat/v3` and the gates in the verification matrix below pass.

## Goals

The v3 CLI ships to two distinct surfaces with one shared contract:

1. **npm distribution** — `npx -y agentera@latest` (and `@next` for the preview
   channel). Self-contained: no repo checkout, no `AGENTERA_HOME`, no Python.
2. **Bun-compiled single-binary** — `./agentera-single-binary` for users who
   want a single statically linked executable (CI runners, containerized
   build agents, drop-in distros).

Both surfaces must:

- Surface the same `agentera` command surface (Decision 45/56 contract-first).
- Surface the same JSON output shapes (D56 parity-impl track pinned the six
  v3-remaining surface families).
- Match `agentera --version` to the npm `@next` package version (the
  release-metadata contract from the resolved L23 commit:
  `fix(release): pin npm @next version, suiteVersion, gitRef to a single
  release-metadata contract`).
- Pass the `npx -y agentera@next check validate capability-contract
  --format json` gate from a fresh npx cache with no repo checkout and no
  `AGENTERA_HOME`.

## Surfaces in scope

### 1. npm package layout

`packages/cli/package.json` publishes via the `next` (and eventually `latest`)
npm tag with `files: [dist, bundle]`. The package layout is:

```
agentera-<version>.tgz
└── package/
    ├── package.json          # bin: dist/bin/agentera.js
    ├── README.md             # published
    ├── dist/                 # tsc output
    │   ├── bin/agentera.js   # bin entrypoint
    │   ├── cli/...
    │   ├── capabilities/...
    │   └── ...
    └── bundle/               # prepack: node scripts/copy-bundle.mjs
        ├── .agentera-npx-bundle.json   # sentinel (kind=agentera-npx-bundle)
        ├── registry.json
        ├── skills/           # SKILL.md, protocol.yaml, capabilities/, schemas/
        └── references/       # artifact-registry interface model
```

The `prepack` script in `packages/cli/package.json` runs `tsc -p tsconfig.json
&& node scripts/copy-bundle.mjs` so that `npm pack`, `npm publish`, and the
`npx` cache resolver all observe a self-contained tarball.

### 2. Bun-compiled single-binary

```bash
bun build --compile \
  packages/cli/dist/bin/agentera.js \
  --outfile dist/agentera-single-binary
```

Bun 1.1.x+ statically links the TypeScript output and the Node-API shim into
a single ELF (Linux) / Mach-O (macOS) / PE (Windows) executable. The binary
is **not** a tarball; it embeds the compiled `dist/` content but the `bundle/`
data surfaces still need to be discovered at runtime. The v3 binary resolves
its source root through `resolveSourceRoot()` (TS side, in
`packages/cli/src/core/sourceRoot.ts`); when the executable is run in
isolation it walks:

1. `AGENTERA_BOOTSTRAP_SOURCE_ROOT` (explicit override).
2. The directory containing the executable (when not installed system-wide).
3. The platform default app home (`~/.local/share/agentera/app`,
   `%LOCALAPPDATA%\agentera\app`, `~/Library/Application Support/agentera/app`).

Because the binary embeds the dist tree but **not** the `bundle/` data
surfaces, single-binary distribution is paired with a one-time data-bootstrap
step: `agentera upgrade` recognizes a single-binary install and emits
`install.kind: v3_self_contained_binary` with a `markerVersion` matching
`packages/cli/package.json#agentera.suiteVersion`.

The `scripts/single-binary.sh` entrypoint wraps the `bun build --compile`
invocation with platform detection, version-pinning, and the
`agentera-single-binary` outfile placement under
`packages/cli/dist/bin/agentera-single-binary` so the build artifact is
discoverable by downstream packaging.

### 3. App-home migration and direct-helper compatibility

The v3 install uses two app-home models:

- **`bundled app`** (npx / single-binary): the `bundle/` directory IS the
  authoritative app home. The sentinel `.agentera-npx-bundle.json` gates
  this branch in `packages/cli/src/cli/appContext.ts#isNpxBundle` and
  `packages/cli/src/upgrade/appModel.ts#sourceRootMissing`.
- **`installed app`** (maintained install under `~/.local/share/agentera/app/`):
  the `scripts/agentera` Python shim seam remains on `main` until v2
  retirement. The TS side does not replace it on `main`; the v3 install uses
  `npx -y agentera@latest` and a separate `~/.local/share/agentera/app/`
  tree when present.

The v3 reader for the v2 handoff manifest lands in T5
(`packages/cli/src/upgrade/v3HandoffManifest.ts`) and reads
`~/.local/share/agentera/v3-handoff.json` during migration preflight. T1 does
not author the v2-side writer (T5's `→ both` branch directive puts the v2
writer on `main` after T11); T1's design reserves the seam.

## Build pipeline

| Stage | Command | Output | Gate |
| --- | --- | --- | --- |
| TypeScript compile | `pnpm -C packages/cli build` | `packages/cli/dist/` | `tsc --noEmit` clean |
| Data staging | `pnpm -C packages/cli run bundle:data` | `packages/cli/bundle/` | sentinel + `skills/` + `references/` + `registry.json` |
| Prepack | `npm pack` (in `packages/cli/`) | `agentera-<version>.tgz` | tarball contains `dist/`, `bundle/`, sentinel |
| Publish dry-run | `npm publish --tag next --dry-run` | n/a | npm reports no errors; total files > 0 |
| Single-binary | `bun build --compile dist/bin/agentera.js --outfile dist/agentera-single-binary` | `dist/agentera-single-binary` | binary executes `agentera prime` with the published JSON shape |
| Fresh-cache gate | `rm -rf ~/.npm/_npx && npx -y agentera@next check validate capability-contract --format json` | n/a | `status: "pass"` matches the in-tree CLI output |

`prepack` composes stages 1+2 atomically; `scripts/single-binary.sh` composes
stages 1+2+5. The published tarball is reproducible from a clean checkout in
under 30 seconds on the project's reference hardware.

## Verification matrix

| Gate | Command | Pass condition |
| --- | --- | --- |
| Compile | `pnpm -C packages/cli run typecheck` | zero TypeScript errors |
| Build | `pnpm -C packages/cli build` | `tsc -p tsconfig.json` exits 0 |
| Unit | `pnpm -C packages/cli test` | 85/85 files, 812/812 tests green (D56 baseline) |
| Validate | `node packages/cli/dist/bin/agentera.js check validate capability-contract --format json` | `status: "pass"`, `summary.passed: 2`, `summary.failed: 0` |
| Prime | `node packages/cli/dist/bin/agentera.js prime --format json` | `command: "prime"`, `status: "ok"`, `app_home.source` reflects resolution |
| Pack | `npm pack` in `packages/cli/` | tarball contains `dist/bin/agentera.js`, `bundle/`, `bundle/.agentera-npx-bundle.json` |
| Publish dry-run | `npm publish --tag next --dry-run` in `packages/cli/` | npm reports `+ agentera@<version>` with no errors |
| Bun smoke | `bun --version` then `bun build --compile` + execute | binary runs `agentera prime --format json` and exits 0 with the same JSON shape |
| Fresh-cache | `rm -rf ~/.npm/_npx && npx -y agentera@next check validate capability-contract --format json` | `status: "pass"` matches the in-tree CLI output |

## Release-metadata contract

The four surfaces from the resolved L23 commit
(`fix(release): pin npm @next version, suiteVersion, gitRef to a single
release-metadata contract`) stay in lockstep:

| Surface | Source | Example (T1) |
| --- | --- | --- |
| `packages/cli/package.json#version` | npm-published version | `3.0.0-dev.5` |
| `packages/cli/package.json#agentera.suiteVersion` | suite authority | `3.0.0` |
| `packages/cli/package.json#agentera.gitRef` | git commit pin | `dd3ea28813c6c787104519d41ec478c67488050e` |
| `registry.json#skills[0].version` | agentera-app registry authority | `3.0.0` |

`packages/cli/scripts/copy-bundle.mjs` reads `agentera.suiteVersion` and
embeds it in the `.agentera-npx-bundle.json` sentinel. T10's v3 cutover
publish bumps all four surfaces in lockstep; T1 does not change any of
them.

## File map

| File | Role |
| --- | --- |
| `docs/packaging/v3-packaging.md` | This file (design) |
| `packages/cli/test/packaging/prepack.test.ts` | Prepack integration test (T1 AC2) |
| `packages/cli/test/cli/npxBundle.test.ts` | Existing bundle sentinel/doctor regression (D65) |
| `scripts/single-binary.sh` | Bun single-binary build entrypoint (T1 AC3) |
| `packages/cli/scripts/copy-bundle.mjs` | `bundle/` staging for `prepack` |
| `packages/cli/package.json#prepack` | `tsc && node scripts/copy-bundle.mjs` |
| `packages/cli/src/cli/appContext.ts#isNpxBundle` | npx bundle resolution branch |
| `packages/cli/src/upgrade/appModel.ts#sourceRootMissing` | source root evidence checker with npx sentinel branch |
| `packages/cli/src/core/sourceRoot.ts` | source root resolution (env → executable dir → default) |
| `.agentera/plan.yaml#T1` | Plan task (this design satisfies the plan task) |

## Excluded scope

T1 does not author:

- The v2 handoff manifest reader (T5).
- The v2/v3 coexistence probe (T6).
- The v3 cursor agent surface regression fix (T7).
- The audience-namespace phase 3 parser removal (T8).
- The CHANGELOG 3.0.0 promotion (T9).
- The v3 cutover tag/publish (T10).
- The final state sync (T11).

T1 reserves the seams for T5–T10 and ships the packaging contract that T8
(phase 3 parser removal) and T10 (v3 publish) both depend on.

# agentera (npm)

Placeholder npm package that reserves the [`agentera`](https://www.npmjs.com/package/agentera) name for `npx agentera` ahead of the Agentera 3.0 TypeScript CLI.

**0.x** releases are a thin Node shim. **3.0.0** will ship the native Bun/npm CLI described in the main repository.

## Usage

```bash
npx agentera --version
npx agentera prime
npm install -g agentera
```

## v3 hint

While the Python CLI remains on `@latest`, every 0.x shim invocation emits a
three-line deprecation hint to **stderr** telling the user the v3 TypeScript
CLI is ready on the `@next` tag:

```
agentera 2.x (Python) is in maintenance; the v3 TypeScript CLI is ready on the @next tag:
  npx -y agentera@next prime
Set AGENTERA_NO_V3_HINT=1 to suppress this message.
```

The hint never appears on `--version`/`-V` and never touches stdout, so
`--json` and pipe consumers stay clean. `--help`/`-h` also lists the `@next`
pointer, and the install-help failure path (no backend available) leads with
the `@next` line.

Suppress the hint for non-interactive CI or scripted invocations:

```bash
AGENTERA_NO_V3_HINT=1 npx agentera prime
```

## Delegation order

When you run `agentera`, the shim forwards to the existing Python CLI using the first match:

1. **Installed app-home** — `$AGENTERA_HOME/app/scripts/agentera` via `uv run`
2. **Repository checkout** — nearest parent directory containing `scripts/agentera`, via `uv run scripts/agentera`
3. **`uvx` from GitHub** — `uvx --from git+https://github.com/jgabor/agentera@<tag> agentera` (tag pinned in `package.json` → `agentera.gitRef`)
4. **Install help** — stderr guidance and exit code 1 if nothing above applies

The shim does not bundle Python, skills, or hooks. Install paths for runtimes remain in the [main README](https://github.com/jgabor/agentera#get-started).

## Publishing (maintainers)

This section applies only to the transitional 0.x stable shim. Prepare explicit
metadata without reading npm, review and commit it, then verify one retained
package artifact before its separately approved measured publication envelope:

```bash
pnpm cli:prepare:stable -- --target-version X.Y.Z --source-commit COMMIT
# review and commit packages/cli/shim/package.json
pnpm cli:qualify:source -- --candidate-dir /secure/external/agentera-package
node packages/cli/scripts/release-qualification.mjs candidate --adapter stable --candidate-dir /secure/external/agentera-package
node packages/cli/scripts/release-qualification.mjs approval --adapter stable --candidate-dir /secure/external/agentera-package --approved-by NAME
NPM_TOKEN=... pnpm cli:publish:qualified:stable -- --candidate-dir /secure/external/agentera-package --receipt-file /secure/external/qualified-publication-receipt.json --json
```

The shared transaction requires an immutable artifact-bound approval and
`NPM_TOKEN` only in its npm mutation child. It stages the exact tarball under a
staging tag, proves registry integrity from a separate empty state, and moves
`latest` forward only after an independent exact-version consumer check.
The content-bound timing receipt must report a reconciled total below two
minutes. Matching state is a credential-free replay. Conflicts, changed
artifacts, failed smoke, and timeouts do not roll a tag back.

The stable `agentera.gitRef` must point to the last substantive shim-source
commit: `bin/`, `lib/`, `README.md`, and `LICENSE` must match that commit.
Preparation may change only the shim package `version` and `agentera.gitRef`.
An existing older SHA is not sufficient.

The v3 CLI has a separate isolated package-construction and recovery contract
in [v3 npm packaging and verification](../../../docs/packaging/v3-packaging.md);
do not apply direct checkout packing to it.

Verify from a clean directory:

```bash
npx -y agentera@<version> --version
```

## Development

```bash
node packages/cli/shim/bin/agentera.mjs --version
node packages/cli/shim/bin/agentera.mjs --help
```

Suite version pin lives in `package.json` under `agentera.suiteVersion` / `agentera.gitRef`; npm `version` stays on the `0.0.x` line until 3.0.

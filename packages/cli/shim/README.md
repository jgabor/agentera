# agentera (npm)

Placeholder npm package that reserves the [`agentera`](https://www.npmjs.com/package/agentera) name for `npx agentera` ahead of the Agentera 3.0 TypeScript CLI.

**0.x** releases are a thin Node shim. **3.0.0** will ship the native Bun/npm CLI described in the main repository.

## Usage

```bash
npx agentera --version
npx agentera prime
npm install -g agentera
```

## Delegation order

When you run `agentera`, the shim forwards to the existing Python CLI using the first match:

1. **Installed app-home** — `$AGENTERA_HOME/app/scripts/agentera` via `uv run`
2. **Repository checkout** — nearest parent directory containing `scripts/agentera`, via `uv run scripts/agentera`
3. **`uvx` from GitHub** — `uvx --from git+https://github.com/jgabor/agentera@<tag> agentera` (tag pinned in `package.json` → `agentera.gitRef`)
4. **Install help** — stderr guidance and exit code 1 if nothing above applies

The shim does not bundle Python, skills, or hooks. Install paths for runtimes remain in the [main README](https://github.com/jgabor/agentera#get-started).

## Publishing (maintainers)

From this directory after review:

```bash
npm pack
npm publish --access public
```

Verify from a clean directory:

```bash
npx agentera@0.0.0 --version
```

## Development

```bash
node packages/cli/shim/bin/agentera.mjs --version
node packages/cli/shim/bin/agentera.mjs --help
```

Suite version pin lives in `package.json` under `agentera.suiteVersion` / `agentera.gitRef`; npm `version` stays on the `0.0.x` line until 3.0.

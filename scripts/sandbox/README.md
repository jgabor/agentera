# v2→v3 sandbox upgrade harness

Isolated validation for cross-major migration. **Never** point these scripts at a real
user home or project outside a temp directory.

## Required environment (set by harness)

| Variable | Purpose |
| --- | --- |
| `HOME` | Sandbox home (`$SANDBOX/home`) |
| `XDG_CONFIG_HOME` | OpenCode and XDG paths (`$SANDBOX/xdg-config`) |
| `AGENTERA_BOOTSTRAP_SOURCE_ROOT` | Repo root for L1 repo-built CLI (optional for L2 npx) |
| `AGENTERA_UPDATE_CHANNEL` | Per-scenario channel override |
| `npm_config_cache` | Pin/offline npx cache (`$SANDBOX/npm-cache`) |
| `AGENTERA_NPM_PIN` | L2 exact package pin (e.g. `agentera@3.0.0-dev.0`) |

## Scripts

| Script | Role |
| --- | --- |
| `seed-v2-fixture.sh` | Materialize fixture or P0 scenario under `$SANDBOX` |
| `scan-python-leftovers.sh` | Fail on forbidden Python-managed references |
| `assert-v2v3-migration.sh` | Checksums, cleanup, idempotency, stable safety |
| `v2v3-upgrade-harness.sh` | End-to-end driver; emits `sandbox-report.json` |

## Teardown

Harness removes `$SANDBOX` on exit. Do not reuse a sandbox root across runs.

## P0 scenarios

See `packages/cli/test/upgrade/fixtures/README.md` for fixture catalog and scenario map.

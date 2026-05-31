# v2→v3 upgrade test fixtures

Fixtures mirror v2 managed installs. Oracle sources: `main` branch Python upgrade
tests (`tests/test_upgrade_cli.py`, `hooks/codex-hooks.json`) and existing trees here.

## P0 fixtures

| ID | Purpose | Oracle |
| --- | --- | --- |
| `v2-yaml-project` | YAML project artifacts (noop preserve) | existing |
| `v2-app-home` | Managed `app/` bundle + user state | existing |
| `v2-runtime-python` | Codex + Cursor hooks with Python paths | existing + main hooks |
| `v2-app-home-noisy` | Cleanup blocked on unrecognized root entry | derived from v2-app-home |
| `v2-app-home-realistic` | Preserved benchmarks/intermediate/sessions + managed `app/` | derived from v2-app-home |
| `v2-legacy-agents-home` | Legacy `~/.agents/agentera` bundle layout | main upgrade tests |
| `v2-runtime-codex-full` | Codex config + copied hooks + plugin path | main setup_codex |
| `v2-runtime-cursor-full` | Project + user Cursor hooks | main cursor upgrade |
| `v2-full-artifacts` | All preserved `.agentera/` YAML + optimera | doctor.ts allowlist |

## Gap / extended fixtures (expected-fail until ported)

| ID | Purpose |
| --- | --- |
| `v2-runtime-opencode` | OpenCode plugin with Python paths |
| `v2-v1-stale-surfaces` | Stale managed OpenCode command surface |

## P0 scenario → fixture composition

| Scenario | Fixtures composed |
| --- | --- |
| happy-path-clean | yaml-project + app-home + runtime-python |
| stable-safety | same as happy-path (stable channel in harness) |
| v1-md-blocked | v1-md-project + app-home |
| noisy-app-home | app-home-noisy + yaml-project |
| legacy-home-retirement | legacy-agents-home |
| codex-plugin-vs-copied | codex-full + app-home + yaml-project |
| partial-only-runtime | runtime-python + app-home + yaml-project |
| v2-python-control | happy-path (v2 CLI via uvx from main) |

## Checksum manifest

Preserved paths follow `packages/cli/src/upgrade/doctor.ts` allowlists and project
`.agentera/*.yaml`. See `test/upgrade/helpers/preservation.ts`.

| `full-runtime-matrix` | All runtimes + realistic app-home | composed P0 scenario |

# Repo-state fixtures

Pinned `.agentera/` and `TODO.md` project trees for vitest. Import
`useFixtureProject(name)` from `packages/cli/test/helpers/useFixtureProject.ts` to
copy a variant into an isolated temp directory. Live checkout artifacts stay
owned by `agentera check compact`.

| Variant | Intent |
| ------- | ------ |
| `ok` | Minimal valid project within `uniform_10_40_50` budgets; includes schema-clean `docs.yaml` (with registry-aligned `version_files`), `vision.yaml`, and `health.yaml` for artifact validation. |
| `todo-resolved-over-limit` | 46 Resolved entries (16 full + 30 oneline) — over full cap by 6. |
| `progress-at-cap` | `progress.yaml` at 50 total entries (10 cycles + 40 archive) but still within limits. |
| `progress-over-limit` | 55 progress cycles — over the 50-entry cap. |
| `invalid-progress-yaml` | Malformed `progress.yaml` for compaction YAML error classification. |

Each variant includes `TODO.md`, `.agentera/plan.yaml`, and a variant-specific
`.agentera/progress.yaml` (except `invalid-progress-yaml`, which uses broken YAML).
The `ok` variant also ships `.agentera/docs.yaml`, `.agentera/vision.yaml`, and
`.agentera/health.yaml` for validate-artifact tests.

# Runtime adapter characterization

The executable lifecycle contract is split deliberately:

- `runtime-lifecycle-authority.yaml` owns active identities, surfaces, evidence,
  support-floor rules, the Cursor alias, and retired inputs;
- `runtime-lifecycle-adapters.yaml` owns the common eight-category adapter
  claims and declared Agentera-managed resources;
- `runtime-lifecycle-operation-contract.yaml` owns operation and ownership
  semantics;
- `runtime-retired-resources.yaml` owns bounded legacy cleanup;
- `runtime-adapter-registry.yaml` retains host-event and behavioral parity facts
  and must match the lifecycle authority's four identities.

## Characterized identities

| Runtime ID | Required host surface | Additional surface | Lifecycle source highlights |
| --- | --- | --- | --- |
| `opencode` | OpenCode host | — | plugin and single Agentera agent |
| `codex` | Codex CLI | — | plugin hooks, copied hooks, capability TOML agents |
| `cursor` | Cursor Agent CLI | Cursor IDE when observed | IDE plugin, hooks, and Agentera descriptor |
| `copilot` | GitHub Copilot CLI | — | plugin manifests and lifecycle hooks |

The inactive `cursor-agent` spelling identifies the Cursor CLI binary/source
product only. Claude is absent from adapter records and can appear only in the
retired cleanup or explicit historical-import contracts.

## Diagnosis and remediation

Every adapter reports `skills`, `plugins`, `hooks`, `agents`, `configuration`,
`enablement`, `trust`, and `native_actions`. Evidence is read-only. Trust is
never inferred. Managed repair is planned through the shared operation engine;
native and user-owned work is returned as `action_required`.

Preview has no side effects. Apply requires declared destinations and matching
ownership-journal evidence, uses secure directory-relative publication on
Linux, continues independent operations after failure, and converges on retry.

## Validation

`agentera check validate lifecycle-adapters` rejects identity drift, missing
runtime/category/surface claims, unsafe destinations, unverified mandatory
skills, missing package manifests, unbundled lifecycle sources, version drift,
retired Claude manifests, and stale runtime-specific hook claims.

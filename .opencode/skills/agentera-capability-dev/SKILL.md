---
name: agentera-capability-dev
description: >-
  Add, modify, validate, or package Agentera capabilities. Use for capability
  instructions, trigger and artifact schemas, capability contracts, protocol
  primitives, routing behavior, and bundled skill surfaces.
---

# Agentera capability development

Load this skill before changing a capability, its schemas, shared primitives,
or capability routing and validation behavior.

## Capability surfaces

Each capability has two synchronized surfaces:

- Human-readable behavior:
  `packages/cli/src/capabilities/<name>/instructions.ts`
- Machine-readable schemas:
  `skills/agentera/capabilities/<name>/schemas/`

The schema directory contains `triggers.yaml`, `artifacts.yaml`,
`validation.yaml`, and `exit.yaml`. The runtime serves instructions through:

```bash
npx -y agentera@next prime --context <name> --format json
```

The primary capability list is `status`, `vision`, `discuss`, `research`,
`plan`, `build`, `optimize`, `document`, `design`, `audit`, `profile`, and
`orchestrate`.

## Add or modify a capability

1. Create or update
   `packages/cli/src/capabilities/<name>/instructions.ts`.
2. Default-export a string constant named `instructions`.
3. Create or update all four schemas under
   `skills/agentera/capabilities/<name>/schemas/`.
4. Update the capability table in `skills/agentera/SKILL.md` when membership or
   user-facing purpose changes.
5. Verify every command, path, environment variable, and contract reference
   against the v3 runtime and filesystem.
6. Validate the changed capability and the shared contract.

V2-era prose can pass lint while describing commands that no longer exist.
Check command help and runtime behavior rather than trusting copied text.

## Contract authority

`skills/agentera/capability_schema_contract.yaml` owns capability schema
structure. `packages/cli/src/registries/capabilityContract.ts` loads the model
used by validation.

Do not duplicate contract-owned groups, priority values, directory rules, or
primitive-reference mappings in tests or docs unless a validation check ties
the duplicate to the loader model.

Shared primitives and visual identity tokens belong in
`skills/agentera/protocol.yaml`, not per-capability schemas.

## Validation

Prefer the pre-cutover published development entry point for user-facing
validation:

```bash
npx -y agentera@next check validate capability <name-or-path>
npx -y agentera@next check validate capability-contract --format json
```

When modifying CLI source, build before invoking the local runtime:

```bash
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
node packages/cli/dist/bin/agentera.js check validate \
  capability-contract --format json
```

Top-level `agentera validate` is a migration alias. Prefer
`agentera check validate`. Use `agentera prime` for status and typed
`agentera state` commands for artifacts. Top-level `status`, `todo`, and `docs`
are not v3 commands.

## Bundled package boundary

The published v3 package is self-contained. It bundles the shared skill,
references, and registry under `packages/cli/bundle/`, so
`npx -y agentera@next` needs neither a checkout nor `AGENTERA_HOME`.

Do not validate only source prose. Verification must cover source, generated,
and extracted package surfaces when the change can affect bundling or runtime
parity. Load `.opencode/skills/agentera-verification/SKILL.md` for those gates.

## Helper policy

`npx -y agentera@next ...` is the documented entry point until v3 is promoted
to stable. Direct scripts under `scripts/` are maintainer-only unless they back
an `agentera` namespace command. Prefer a stable namespace for new user-facing
behavior. Otherwise document the helper as local-only with its privacy and
scope limits.

## Commit boundary

Load `.opencode/skills/agentera-state/SKILL.md` before committing. Capability
instructions, schemas, tests, changelog entries, TODO resolution, and state
updates for one change belong in the same substantive commit.

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
npx -y agentera@next prime --context <name>
```

`skills/agentera/capabilities/` holds one directory per capability.

## Add or modify a capability

1. Create or update
   `packages/cli/src/capabilities/<name>/instructions.ts`.
2. Default-export a string constant named `instructions`.
3. Create or update all four schemas under
   `skills/agentera/capabilities/<name>/schemas/`.
4. When membership or a purpose changes, update the `capabilities:`
   frontmatter list in `skills/agentera/SKILL.md` (membership only), the list
   in `AGENTS.md#product`, and the capability table in `README.md`.
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

The published `@next` CLI does not contain unpublished changes. Validate
changed capabilities, schemas, or CLI source with a current local build:

```bash
vp run typecheck
vp run build
vp node packages/cli/dist/bin/agentera.js check validate capability <name-or-path>
vp node packages/cli/dist/bin/agentera.js check validate capability-contract
```

## Bundled package boundary

The published package bundles the shared skill, references, and registry under
`packages/cli/bundle/`. Do not validate only source prose. When a change can
affect bundling or runtime parity, verification must cover source, generated,
and extracted package surfaces. Load
`.opencode/skills/agentera-verification/SKILL.md` for those gates.

The host projection contains only `SKILL.md`; source schemas are internal CLI
data, not host companions. Serve required semantics through the purpose-owned
interfaces mapped in `docs/cli-coverage-contract.md`: follow section and
continuation commands, preserve complete nested guidance, and keep provenance
paths informational. Authoring detail is `schema --capability-contract`;
capability detail is `prime --context <name> --detail KIND`. Do not add a parallel
registry or teach installed-file reads as recovery.

## Helper policy

Direct scripts under `scripts/` are maintainer-only unless they back an
`agentera` namespace command. Prefer a stable namespace for new user-facing
behavior. Otherwise document the helper as local-only with its privacy and
scope limits.

## Commit boundary

Load `.opencode/skills/agentera-state/SKILL.md` before committing. Capability
instructions, schemas, tests, changelog entries, TODO resolution, and state
updates for one change belong in the same substantive commit.

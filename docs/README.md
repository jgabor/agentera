# Local drafts

This directory is for **non-authoritative** notes only: field triage (`notes.md`),
one-off reviews, and scratch material.

Authoritative Agentera documentation lives elsewhere:

| Topic | Location |
| --- | --- |
| Terminology index | [`references/cli/vocabulary.md`](../references/cli/vocabulary.md) |
| CLI vocabulary authorities | [`references/cli/`](../references/cli/) |
| User guides | [`README.md`](../README.md), [`UPGRADE.md`](../UPGRADE.md), [`AGENTS.md`](../AGENTS.md) |

Authoritative exceptions:

- [`CLI coverage contract`](./cli-coverage-contract.md) selects the bounded,
  purpose-owned discovery interfaces for the single-file host skill. It is an
  implementation contract, not a claim that those interfaces have shipped and
  not a second authority for the semantics it maps.
- `docs/packaging/` is the design-doc home for the
  v3 packaging contract. See
  [`docs/packaging/v3-packaging.md`](./packaging/v3-packaging.md) for the v3
  npm distribution and verification-lane contract.

Nothing else under `docs/` is packaged in the Agentera app bundle.

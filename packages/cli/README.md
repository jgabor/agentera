# Agentera CLI

Native TypeScript CLI for Agentera 3.0, published as
[`agentera`](https://www.npmjs.com/package/agentera). The npm package is
self-contained: compiled commands live in `dist/`; the canonical shared skill,
its schemas, required references, and `registry.json` live in `bundle/`. It
ships no host-native plugin, hook, command, agent, descriptor, or marketplace
surface.

Until the stable dist-tag is promoted, run 3.0 through `@next`:

```bash
npx -y agentera@next prime --context status --format json
npx -y agentera@next doctor --format json
```

The first command is the one-call pre-cutover bootstrap. Clean, v2, and
partially migrated projects return bounded `blocked` output with the exact full
entity-upgrade command in `state_cutover.recovery_command`; v3 returns `ok`
unless health state makes it `degraded`. Every recovery command remains on
`@next`, and an `ok` outcome needs no fallback or second dashboard call. Served
capability instructions and bundled startup schemas use that same exact
development-channel executable. Package verification parses every registry-owned
instructional Markdown, YAML, and JSON surface, rejects duplicate keys and
unsafe aliases, reason-classifies non-guidance and generated declarations, and
closes every static constructor importer and re-exporter through conservative
TypeScript module closure. Every closure module is an explicit producer or
reasoned non-producer. Generated declaration fields and source/package records
must match exactly, and unused exemptions fail. Only the
adjacent ordered stable-v2 preview/apply pair in `UPGRADE.md` may execute
`@latest`. The second command is an independent read-only evidence probe on the
same channel.

`prime --format json` returns a bounded decision brief (at most 12000 UTF-8
bytes). Status startup returns
`capability_context.instructions` and bounded
`capability_context.context.status_context` together (at most 25000 UTF-8
bytes). Omitted detail names its authoritative recovery command. `doctor`
returns detailed read-only evidence and exact user actions. Entity-mode projects
with an absent or unsafe TODO reconciliation marker return `action_required`
instead of `ok` or `up_to_date`. A safe inactive project reports an activation
preview and its exact effect-bound apply command:

```bash
npx -y agentera@next state todo activate --dry-run --format json
npx -y agentera@next state todo activate --effect-sha256 EFFECT_SHA256 --yes --format json
```

An unsafe active project with an existing marker reports the separate repair
preview and effect-bound apply path:

```bash
npx -y agentera@next state todo repair --dry-run --format json
npx -y agentera@next state todo repair --effect-sha256 EFFECT_SHA256 --yes --format json
```

Unsafe inactive evidence (unmatched projections, duplicate public work, stale
entity status, or prospective resurrection) reports a bounded, content-private
diagnosis and an owner-correction preview. Supply a complete `id` and
one-based `source_line` mapping for every managed row, then confirm the exact
effect-bound apply command. The correction preserves Markdown-owned public
state and Agentera-owned operational fields without an intermediate activation.
`check validate state` reports the same read-only diagnosis. Healthy active TODO projections keep the existing output.

## Shared-skill integration

Agentera uses one portable integration: the Agentera CLI plus the shared skill
at `~/.agents/skills/agentera`. Normal upgrade previews and applies app/project
migration only. It has no current-runtime selector and does not create native
runtime resources.

```bash
npx -y agentera@next upgrade --channel development --project "$PWD" --dry-run
npx -y agentera@next upgrade --channel development --project "$PWD" --yes
```

Preview has no side effects. The apply path is the explicit, one-way v2-to-v3
migration described in [UPGRADE.md](../../UPGRADE.md); it does not run a native
package installer.

Agentera product v1 is unsupported. V3 does not migrate or preserve v1 state.
If product-v1 evidence is detected, ordinary commands stop without mutation and
the upgrade guide's separate `--reset-product-v1` workflow is the only
continuation. Its reviewed apply deletes all Agentera state in the listed
project, profile, installation, and runtime scopes with no backup or restore.
That reset is destructive and irreversible. It does not replace the supported
v2-to-v3 migration above. Current schema identifiers ending in `.v1` remain
valid and do not identify product v1.

Native Agentera resource cleanup is intentionally separate from host support:

```bash
npx -y agentera@next upgrade --legacy-cleanup claude.agentera-skill-link --dry-run
```

It selects declared native Agentera resources only. Each removal needs a
matching whole-resource ledger identity and fingerprint; shared Codex config
keys require unavailable key-level evidence and remain action-required.
Historical transcript import is also explicit (`agentera report refresh
--import-source claude`) and is excluded from default active-runtime analytics.

## Bounded state retrieval

The executable contract is
[`references/artifacts/state-storage-authority.yaml`](../../references/artifacts/state-storage-authority.yaml)
and is projected by `agentera schema --format json`.

```bash
agentera state plan list --format json
agentera state plan get --id PLAN_ID --format json
agentera state plan tasks list --limit 20 --format json
agentera state experiments list --objective OBJECTIVE_ID --format json
agentera state experiments get --id EXPERIMENT_ID --format json
```

Pages use opaque snapshot cursors, explicit omission fields, whole-entry output
bounds, and exact retrieval. Plan history is owned by active/archive plan files;
plan task retrieval is active-only. Experiment history is objective-scoped and
reports full, summary-only, or unavailable detail without fabricating archives.

See [UPGRADE.md](../../UPGRADE.md) for ownership, recovery, and migration
details.

## Private personal glossary candidate reads

An explicitly consented refresh is the production candidate producer:

```bash
npx -y agentera@next report refresh --consent local-history
```

After publishing bounded evidence, the same refresh mines explicit and recurring
signals and writes one private projection bound to that evidence generation.
Candidate-list summaries include fixed-key aggregate candidate and abstention
counts for each mining family. They do not expose rejected terms, sources,
anchors, projects, paths, or excerpts. If projection publication fails, the
evidence remains current and the nonzero response gives the same consented
refresh command as recovery.

The user-local candidate projection has a separate read-only surface. It does
not need a project checkout and never reads a project glossary.

```bash
npx -y agentera@next report personal-glossary-candidates list --limit 20 --format json
npx -y agentera@next report personal-glossary-candidates get \
  --candidate-id ID --candidate-revision REVISION \
  --generation GENERATION --policy-version POLICY --format json
```

List cursors bind the current generation, policy, filters, limit, order, and
expiry-aware safe-context availability snapshot. Safe context becomes
unavailable at its 30-day expiry without changing persisted projection bytes;
a cursor from an earlier availability view cannot resume. Exact reads return
opaque validated occurrence identities and a currently available safe context,
not raw source, anchor, session, project, or filesystem values. Both commands
are non-interactive and mutation-free.

## Personal glossary decisions

Submit one host semantic classification receipt through the private, read-only
decision boundary. Copy the current `candidate_projection_sha256` from the
candidate read into the receipt. The CLI validates the receipt against the
current projection and evidence, then returns an admission outcome without
writing a review, profile entry, or project state.

```bash
npx -y agentera@next report personal-glossary-decision --input receipt.json --format json
```

Only a current explicit personal definition with a complete resolved
user-authored anchor can return `automatic_admission`. Inferred candidates stay
`review_required` or `abstain`, regardless of host confidence. The command does
not read a project glossary. File and stdin requests are limited to 16,384 UTF-8
bytes. The machine schema lists the only allowed reason codes for each outcome.

## Personal glossary publication

Publish one current explicit automatic admission through the separate,
user-local mutation boundary:

```bash
npx -y agentera@next report personal-glossary-publish --input publication.json --format json
```

The bounded request contains `schema_version`, `receipt`, `decision`, and
`as_of`. It can additionally carry an opaque `review_authorization` with a
review ID and canonical review-record digest. It never accepts a profile or
project path. Immediately before an atomic replacement, Agentera revalidates the
current projection, candidate, receipt, CLI decision, evidence, scope, meaning,
revision, policy, and quality gate. An automatic publication still requires
`explicit_current_authorized`. A review-required publication additionally needs a
current stored `accept` or `correct` authorization. The command changes only the
owned `PROFILE.md` Glossary section and returns opaque bindings, not terms,
meanings, anchors, paths, or source content. Exact replay with the same date is
an `unchanged_replay`; malformed, stale, unavailable, or conflicting input leaves
profile bytes unchanged.

## Personal glossary review records

Queue a current `review_required` decision when no question channel is available.
The queue takes the same bounded host receipt shape as the decision command and
revalidates it before writing private metadata.

```bash
npx -y agentera@next report personal-glossary-reviews queue --input receipt.json --format json
npx -y agentera@next report personal-glossary-reviews disposition --input disposition.json --format json
npx -y agentera@next report personal-glossary-reviews list --status pending --limit 20 --format json
npx -y agentera@next report personal-glossary-reviews get \
  --review-id ID --candidate-id ID --candidate-revision REVISION \
  --generation GENERATION --policy-version POLICY --format json
```

Records live only under the configured user profile. Queue metadata retains opaque
candidate, receipt, decision, semantic-fingerprint, scope, policy, reason, and
lifecycle bindings. A `correct` action can retain only its authority-approved
corrected meaning in the canonical user-local review record. Records never retain
a term, excerpt, raw evidence, source, session, project, path, tool content,
signature, nonce, or host proof.

The local host writes one canonical `trusted-local-host.json` document beside the
review store. It contains the current-user subject and an Ed25519 SPKI public key.
Only a fresh `agentera.personalGlossaryReviewApproval.v1` action from
`agentera-local-host` over `agentera-local-host-ipc`, signed by that key, can
disposition a queued review. The signed receipt binds the review ID, stable term,
revision, projection, semantic fingerprint, generation, policy, disposition,
correction fields, timestamps, and nonce. Exact receipt replay is idempotent;
reusing a nonce with changed signed content fails before effects.

Canonical v1 pending review stores remain readable through `list` and `get`
without changing their bytes. Only `disposition` can migrate one valid v1 record.
It revalidates the current receipt and projection, derives the missing scope from
that receipt, preserves immutable review bindings, and atomically writes the v2
lifecycle and replay state. Invalid or ambiguous v1 input leaves the store
unchanged.

Rejected and deferred records suppress a recurrence with the same stable identity,
semantic fingerprint, scope, and policy even when only corroborating evidence,
revision, or generation changes. A meaning, scope, or policy change creates a
bounded reopened record with a visible reason. Accepted or corrected records return
an opaque authorization for the separate publish command. They do not publish
directly. List and exact reads are noninteractive, owner-restricted,
cursor-bounded, and mutation-free.

Terminal metadata expires after 90 days. The bounded receipt replay index expires
with each approval receipt. Separate authenticated owner maintenance affects only
review metadata and replay digests. It does not modify a profile entry, project
state, candidate projection, or publication result.

## Contributors

Contributors use the Node.js 24 LTS version pinned in `.node-version` and pnpm
10.30.3.

### Generated-output ownership

The canonical producer, reader, packing, and temporary-root lifecycle contract is
[v3 npm packaging and verification](../../docs/packaging/v3-packaging.md).
Generated output is disposable; source files and the package registry remain
authoritative. Routine builds update checkout `dist/` and `bundle/`, while
release verification uses a private temporary build root.

```bash
pnpm -C packages/cli test
pnpm -C packages/cli run verify:package
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
pnpm -C packages/cli run verify:generated-overlap
pnpm -C packages/cli run lint
```

Use `pnpm -C packages/cli run pack:dry-run` to inspect the exact isolated
publication surface. Do not publish from a normal development or capability
cycle.

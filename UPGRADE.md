# Upgrade and migration

Agentera 3.0 uses purpose-separated upgrade routes for shared-skill delivery,
app/project migration, and explicit retired-resource cleanup. Preview and apply
are separate operations. Agentera does not install or configure host runtimes.

Before the npm stable dist-tag promotion, select the development npm channel. The stable npm
channel remains on 2.x until that promotion; upgrade does not publish
or retag packages.

## Active integration

Agentera has one active integration contract:

```text
~/.agents/skills/agentera/SKILL.md + agentera CLI
```

Normal `prime`, `doctor`, `schema`, help, and project-integration output reports
that shared skill and CLI/app/project state. The host directory contains exactly
one regular `SKILL.md`; schemas, references and compiled capabilities remain
internal to the self-contained CLI package. Static discovery does not read host
companions or require a checkout. Normal `upgrade` has no current-runtime selector.
Declared retired resources are considered only in their selected cleanup scope,
as described below. It creates no current plugin, hook, agent,
command, descriptor, or marketplace file and does not run runtime package
managers, authentication, enablement, or trust operations.

The only automatic native-resource operation is bounded retirement of the proven
historical OpenCode plugin during approved app/global migration; no separate
cleanup selector is needed. Project-only migration never changes global resources.

Passing `--runtime` fails before mutation. Remove `--runtime`, ensure the runtime
can read `~/.agents/skills/agentera`, and invoke the CLI directly. The supported
v2 migration and native Agentera resource cleanup routes below are separate from
normal active integration.

## One-file shared-skill installation and repair

Discover the current contract without inspecting or changing an installation:

```bash
npx -y agentera@next upgrade --explain --operation install
npx -y agentera@next upgrade --explain --operation refresh
npx -y agentera@next doctor --explain
```

Follow returned section and continuation commands for applicable details.
Ordinary `prime` and `doctor` offer an update for an outdated supported install:

> Agentera’s installed skill needs an update. Update it now? Your project files will not change.

Answer **Yes** once to let the host run the exact CLI-provided
`shared_skill.upgrade_offer.apply_command`. The CLI supplies the authorization,
retains the old installation when replacement is needed, and verifies delivery.
The host does not ask about tokens, paths, journals or individual files. No,
silence, or an absent offer causes no update. A current installation has no offer.
Success requires exit 0 and JSON `status` of `success` or `noop`, not merely an
attempted command. An unrelated doctor warning does not negate a current shared
skill, and shared-skill success does not resolve unrelated app/project warnings.

A missing installation keeps the separate explicit install-preview route:

```bash
npx -y agentera@next upgrade --shared-skill --dry-run
npx -y agentera@next upgrade --shared-skill --yes
```

Without `--yes`, `--shared-skill` defaults to read-only preview. It writes only
the selected one-file host projection and its external app-home ownership state,
not project state or internal runtime contracts. Matching current content is a
no-op, including an unrecorded current installation. Replacement requires explicit
approval of the dedicated directory; it does not require historical per-file proof.

`--home HOME` selects the host home; `--install-root APP` selects the app home
holding the ownership journal. Keep both selections unchanged between preview
and apply. This route cannot be combined with project, channel, migration phase,
reset, cleanup, force or verification flags. Project write permission is not
permission to change global host content.

### Dedicated-directory replacement

The same route supports older symlinks and directories, including companions and
extra files, without a pre-existing journal. For direct CLI use rather than the
startup offer:

```bash
npx -y agentera@next upgrade --shared-skill --home HOME --install-root APP --dry-run
npx -y agentera@next upgrade --shared-skill --home HOME --install-root APP --yes --authorization TOKEN
```

Use the CLI-provided authorization unchanged. Conversion binds source selection
and bytes, host parents, scope, and a snapshot of the installation's identities
and contents. Approval covers the whole dedicated `~/.agents/skills/agentera`
directory (or its selected `--home` equivalent), not its symlink targets or other
host directories. Files need no separate approval. Technical inventory remains
in diagnostic preview; the ordinary question above is sufficient. The inventory
supports at most **4096 entries, including the root**. Hard links, unsafe paths
and changes after the offer fail closed. Other native-resource cleanup still
requires its declared marker/ledger evidence; this exception does not weaken it.

Conversion moves the old link or tree into the selected app home's
`runtime-lifecycle/host-conversion-<digest>/legacy` retention directory on the
**same filesystem**. It does not follow a symlink or delete its target. The
operation journal is created as needed outside the host payload. Successful conversion leaves
exactly one regular `SKILL.md` in the host directory; runtime contracts, old
target data, profiles and project state outside the selected scope stay intact.
There is no automatic pruning of retained content.

Host apply requires Linux with safe `/proc/self/fd` directory-relative
publication; unsupported platforms fail closed. This is an apply limitation,
not a claim that diagnostic preview or npm invocation requires Linux.

After interruption, retry the same approved command, including the same home,
app home and authorization. Completed work converges to no-op. A one-file offer
binds its source and scope and cannot silently become a whole-directory conversion.
Changed source, scope or conversion contents invalidate approval. Report the
bounded failure; do not substitute a new token under old consent, move files
manually, or fabricate historical ownership records. Preserve retained data and
the operation journal when a genuine unsafe condition prevents continuation.

### Diagnosis and bounded failures

`doctor` and `prime` never repair automatically. Shared-skill diagnostics
separate shape (`missing`, `one_file`, `extra_entries`, `legacy_symlink`,
`invalid_bootstrap`, `wrong_type`, `unsafe_path`), compatibility, freshness,
runtime authority and ownership. Package health does not prove host trust or
project readiness. Use `app-home --explain` for override/resolution semantics;
repair an invalid selected runtime authority rather than silently falling back
to a different installed copy.

An unsafe destination or invalid runtime authority has no actionable offer.
Report its diagnostic reason without claiming success or broadening approval.
Never prune through a symlink, delete its target, or erase operation evidence to
force success. Shared-skill repair does not migrate
projects, clean other runtimes, acquire history, enable trust, install native
integrations, publish packages or change dist-tags.

## Preview and apply

Preview normal app/project work:

```bash
npx -y agentera@next upgrade --dry-run --channel development
```

The preview is strictly read-only: it creates no files, directories, locks,
caches, ownership records, telemetry, or other state. Apply only after reviewing
the generated command:

```bash
npx -y agentera@next upgrade --yes --channel development
```

`prime` and `doctor` expose the same app/project classification and shared-skill
state:

```bash
npx -y agentera@next prime
npx -y agentera@next doctor
```

Before stable promotion, `prime --context status` is the one-call
bootstrap for fresh, v2, partially migrated, and v3 projects. A Git-root project
with no `.agentera` state is `fresh_uninitialized`: `prime --context plan` stays
read-only and operable, and the first `state plan create` is its sole initializer.
Recognized v2 remains on the full upgrade route; partial, corrupt, and unknown
marker-absent state stays bounded and blocked behind read-only recovery. No fresh
startup response recommends `upgrade --yes`, no recovery resolves `@latest`, and
healthy v3 needs no second dashboard call.

### Fresh Plan initialization

For a fresh Git project, use the typed Plan writer. Its dry run previews the
marker, plan, and task publication without changing the project; apply publishes
the complete plan graph and then the entity-state marker, rolling back ordinary
publication failures. Other state writers never initialize fresh state.

```bash
npx -y agentera@next prime --context plan
npx -y agentera@next state plan create --input PLAN.yaml --dry-run
npx -y agentera@next state plan create --input PLAN.yaml
```

`doctor` also reports bounded `retired_resources` candidates. A
proven Agentera-installed OpenCode plugin reports `pending_automatic_removal`
and points to normal `upgrade`; it needs no separate cleanup selector. An
unproven or uninspectable resource reports `manual_review` and a read-only,
ID-scoped doctor command. Doctor never includes resource contents, adopts a name
collision as Agentera-owned, or changes a diagnosed path. Absent resources
report `clean`.

Retries re-observe the current app/project state. Completed migration work
converges to no change; interrupted v2 migration continues through the same full
apply command.

## Native Agentera resource cleanup

Project migration without explicit `--install-root` is project-scoped: it does
not enumerate global cleanup blockers or mutate global resources. App/global
cleanup requires explicit `--install-root APP` scope, or the focused
`--legacy-cleanup RESOURCE_ID` route and its matching ownership evidence. Neither
scope authorizes shared-skill conversion; use its separate route above.

Within an explicitly selected app/global scope, full upgrade previews every
declared retired external Agentera leaf and removes each independently eligible
owned leaf after approval. Restart OpenCode after a
successful plugin removal. The shared skill plus CLI remains the supported integration.
No OpenCode gate or `hook` command replaced the retired plugin.

Cleanup is a distinct resource route, not a host selection. Codex, Cursor,
OpenCode, and Copilot remain supported through the canonical shared skill and
CLI. Prior accepted smoke evidence records that Codex and Cursor loaded Agentera's
skill instructions, OpenCode listed the canonical skill, and Copilot's listed
canonical skill is intentionally disabled. Those observations predate the final
one-file-host qualification; they are not current-candidate host smoke evidence.
The four-host evidence gaps remain explicit in
[the qualification record](docs/cli-coverage-contract.md#supported-host-evidence--still-blocked).

Use the development package's separate preview and apply commands below with
one declared native Agentera resource ID.
The cleanup option pair is `--legacy-cleanup RESOURCE_ID --dry-run|--yes`.

```bash
npx -y agentera@next upgrade --legacy-cleanup claude.agentera-skill-link --dry-run
npx -y agentera@next upgrade --legacy-cleanup claude.agentera-skill-link --yes
```

The retirement contract gives historical plugins, commands, primary and
capability agents, stale skill links, installed hooks, and registrations one
vocabulary and gives every leaf a focused cleanup preview. The cleanup route
also recognizes the historical `codex.agents.NAME` descriptor identity as
`codex.agent-descriptor.NAME`, including the twelve Swedish-era descriptor names.
For the three marker-managed classes—Codex descriptors, OpenCode agents, and
OpenCode commands—the exact declared regular file and its expected marker mean
Agentera owns the whole file. The accepted forms are the first-line
`# agentera_managed: true` Codex marker, first-line
OpenCode managed HTML-comment agent marker, or boolean
`agentera_managed: true` OpenCode command frontmatter. They prove ownership even
if lifecycle ledger evidence is missing or stale. Remove the
marker to opt the file out. Markers in undeclared files, plugins, templates,
hooks, or shared configuration do not qualify. Other ledger-backed files still
need a matching whole-resource ledger identity and fingerprint. Codex
descriptor previews report each shared configuration key as `action_required`
without adding it to the selected resource's apply work. Agentera has no durable
key-level ownership proof, so matching values, markers, names, or whole file
contents never authorize a shared `config.toml` mutation. Preview is read-only;
approved apply is idempotent and preserves ambiguous or unowned resources. An
explicit cleanup preview contains only its selected resource's lifecycle plan,
bounded configuration report, and ownership blockers; it does not include
app/project migration phases. During v2 cleanup, a preserved user-owned legacy
agent collision remains manual-review work but does not stop independently
proven legacy-agent removals. The collision still leaves the cleanup non-success
until it is resolved outside Agentera. Empty declared legacy directories are
removed deepest-first with non-recursive removal; non-empty and symlinked paths
are preserved with visible outcomes. Package-internal paths and host-root
namespaces are not cleanup candidates.

V2 hook retirement never rewrites a native hook to another Agentera command.
Upgrade removes a whole hook resource only when its complete content proves
Agentera v2 ownership and its path identity and fingerprint still match the
preview. Mixed or otherwise unproven resources remain unchanged with manual
review guidance. The complete v2-only deletion set is machine-readable in
`references/adapters/runtime-retired-resources.yaml` under
`cutover_deletion_inventory`; it remains until an approved stable cutover.

Historical transcript import is independent of cleanup. Default extraction and
analytics do not read Claude history. Import requires explicit local consent:

```bash
npx -y agentera@next report refresh --import-source claude
```

Imported records carry `historical_import` provenance, have no active runtime
ID, and remain excluded from default active-source analytics.

## Stable v2 line

The stable `@latest` channel remains on the supported 2.x line. Preview before
applying an in-line upgrade:

```bash
npx -y agentera@latest upgrade --dry-run
npx -y agentera@latest upgrade --yes
```

Use the v3 development migration below only when you explicitly intend to leave
the stable line.

## Upgrading v2 to v3 development channel

Recognized marker-absent v2 aggregate state has one supported forward route:

```bash
npx -y agentera@next upgrade --channel development --project "$PWD" --dry-run
npx -y agentera@next upgrade --channel development --project "$PWD" --yes
```

The optional preview is read-only. Before apply, commit or restore the complete
v2 migration source: every input must be a regular file tracked by Git and
unchanged at `HEAD`. Apply performs the full project rewiring and entity-state
cutover, then validates state and representative `prime` startup. Rewiring may
update recognized v2 project files; it does not install current native resources.

Forward migration is one-way. Returning to the Python 2.x line is unsupported,
and cross-major apply has no rollback, restore, non-Git, or partial workflow.
If apply is interrupted, rerun the same full apply command.

### Compacted v2 summaries

Entity-cutover publication for valid v2 compaction output is implemented for
`progress`, `decisions`, and `health`. Each valid summary becomes one immutable,
read-only canonical
`progress_summary`, `decision_summary`, or `health_summary` entity. The entity
requires `summary`, preserves every source-retained field except forbidden
identity aliases, and records the source path plus source-record SHA-256.

Ordinary summary readers and startup projection are implemented. Reads report
`detail_availability: summary`, `compatibility: degraded`, record-level source
provenance, and applicable caveats; startup presents summary-only history as
degraded history rather than current detail. Full records retain their existing
temporal order; the degraded-summary segment follows in deterministic canonical-ID
order and makes no chronology claim. Retained decision-summary satisfaction is
inline and read-only, may be absent, and never creates a standalone satisfaction
 target. Preview reports independent source roots separately from generated
 relationship dependents: `root_blockers + dependent_blockers = blockers`, and
 each dependent names its stable `root_source_identity`. A Git-backed regression
 copies the supported `progress`, `decisions`, and `health` sources from pinned
 v2.7.11 compaction output; its protected experiment evidence remains unchanged
 and excluded. It verifies preview bindings and target hashes, marker-last
 publication and interrupted exact-target retry, canonical validation, ordinary
 list/get reads for retained full and summary entries, human/JSON prime, and
 repeated no-change upgrade behavior while aggregate source hashes remain stable.
Inherited full-decision `high`, `medium`, and `low` confidence remains readable
with a legacy caveat; newly supplied or amended confidence remains strict.

Protected objective experiments, runtime-local session state, and compacted TODO
rows that already satisfy the canonical TODO shape are outside this summary
scope. This contract does not reconstruct Git history, normalize source records,
create dual authority, or add a repair or import command.

## Unsupported legacy state

Agentera product v1 is unsupported. V3 does not migrate, convert, import, back
up, restore, or retain v1 state. Current schema identifiers that end in `.v1`
are not product-v1 evidence and remain supported.

When v3 detects product-v1 evidence, ordinary commands stop without mutation.
The only continuation is a fresh-v3 reset. Preview the exact bounded project,
profile, installation, and runtime effects first:

```bash
npx -y agentera@next upgrade --reset-product-v1 --dry-run
```

To apply after review, rerun the same scoped command and replace `--dry-run`
with `--yes --authorization TOKEN`, using the unchanged authorization digest.

This reset is destructive and irreversible. It deletes all Agentera state in
the listed scopes, retains no backup, and initializes fresh v3 installation
state. Review `irreversible_loss`, every deletion, and every recreation in the
preview before applying it. Do not use the reset for v2 projects. Supported v2
state continues to use the one-way v2-to-v3 preview and apply commands above.

Reset approval binds the selected one-file bootstrap source and any listed host
removal/recreation. It unlinks an approved host symlink without traversing its
target, or removes approved one-file leaves non-recursively, then publishes the
one-file projection. Full copied host trees or unowned extras require separately
approved conversion or manual recovery first. Reset does not recreate a
full-tree link; unlisted targets remain outside its destructive scope.

Partial, corrupt, and unknown marker-absent state is not an automatic mutation
input. `state migrate`, `state backfill`, projection repair, v1 conversion,
restore, and downgrade are unsupported.

## Verification and recovery

After apply:

```bash
npx -y agentera@next doctor
npx -y agentera@next prime
```

`upgrade --verify` without `--yes` is a read-only doctor and capability-context
verification. With `--yes`, it runs those checks after approved migration.
Explicit native Agentera resource cleanup with `--verify` requires `--yes`.

`--force` applies only where the owning migration contract explicitly permits
replacement. It never adopts user-owned resources.

## Maintainer verification

Use the pinned Vite+ contributor setup in [AGENTS.md](./AGENTS.md#common-commands)
and the [verification skill](./.opencode/skills/agentera-verification/SKILL.md).
Checks use a current local build, not the published package:

```bash
vp run typecheck
vp run build
vp node packages/cli/dist/bin/agentera.js check validate capability-contract
```

Reuse a current build until relevant inputs change. Run targeted checks before
the broader owners appropriate to the change. Package and release qualification
belong to the [packaging guide](./docs/packaging/v3-packaging.md); neither checks
nor preparation authorize a version bump, live-home mutation, commit, push,
publication or tag change.

## Mutation ownership

Upgrade apply holds the required project lock before migration begins. Explicit
native Agentera resource cleanup additionally uses its ownership journal and
shared lock. Lock creation is atomic, and release succeeds only for the matching
ownership token.
A stale or malformed lock stops the operation; inspect the named lock file,
remove only that file after confirming no operation owns it, then rerun.

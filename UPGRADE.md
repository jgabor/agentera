# Upgrade and migration

Agentera 3.0 uses one upgrade command for app/project migration and explicit
native Agentera resource cleanup. Preview and apply are separate operations.
Current runtime installation and repair are not upgrade operations.

Before the npm stable dist-tag promotion, use `agentera@next`. The stable 2.x
channel remains `agentera@latest` until that promotion; upgrade does not publish
or retag packages.

## Active integration

Agentera has one active integration contract:

```text
~/.agents/skills/agentera + agentera CLI
```

Normal `prime`, `doctor`, `schema`, help, and project-integration output reports
that shared skill and CLI/app/project state. Normal `upgrade` has no
current-runtime selector or native-resource operation set. It creates no current
plugin, hook, agent, command, descriptor, or marketplace file and does not run
runtime package managers, authentication, enablement, or trust operations.

Passing `--runtime` fails before mutation. Remove `--runtime`, ensure the runtime
can read `~/.agents/skills/agentera`, and invoke the CLI directly. The supported
v2 migration and native Agentera resource cleanup routes below are separate from
normal active integration.

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
npx -y agentera@next prime --format json
npx -y agentera@next doctor --format json
```

Retries re-observe the current app/project state. Completed migration work
converges to no change; interrupted v2 migration continues through the same full
apply command.

## Native Agentera resource cleanup

Cleanup is a distinct resource route, not a host selection. Codex, Cursor,
OpenCode, and Copilot remain supported through the canonical shared skill and
CLI. Accepted smoke evidence records that Codex and Cursor loaded Agentera's
skill instructions, OpenCode listed the canonical skill, and Copilot's listed
canonical skill is intentionally disabled.

Use `agentera upgrade --legacy-cleanup RESOURCE_ID --dry-run|--yes` with one
declared native Agentera resource ID.

```bash
npx -y agentera@next upgrade --legacy-cleanup claude.agentera-skill-link --dry-run
npx -y agentera@next upgrade --legacy-cleanup claude.agentera-skill-link --yes
```

The contract also inventories retired Codex descriptor files. Each file needs a
matching whole-resource ledger identity and fingerprint before it can be
removed. Codex descriptor previews report each shared configuration key as
`action_required` without adding it to the selected resource's apply work.
Agentera has no durable key-level ownership proof, so matching values, markers,
names, or whole file contents never authorize a shared `config.toml` mutation.
Preview is read-only; approved apply is idempotent and preserves ambiguous or
unowned resources.

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

Pending v1 Markdown state and unknown marker-absent state are not automatic
mutation inputs. `state migrate`, `state backfill`, projection repair, v1
conversion, restore, and downgrade are unsupported. The read-only
`state migrate entities --dry-run` diagnostic may inventory cutover input but
cannot publish it.

## Verification and recovery

After apply:

```bash
npx -y agentera@next doctor --format json
npx -y agentera@next prime --format json
```

`upgrade --verify` without `--yes` is a read-only doctor and capability-context
verification. With `--yes`, it runs those checks after approved migration.
Explicit native Agentera resource cleanup with `--verify` requires `--yes`.

`--force` applies only where the owning migration contract explicitly permits
replacement. It never adopts user-owned resources.

## Maintainer verification

Release preparation does not publish, tag, or push:

```bash
pnpm -C packages/cli test
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
node packages/cli/dist/bin/agentera.js check validate capability-contract --format json
node packages/cli/dist/bin/agentera.js check validate release-metadata
```

## Mutation ownership

Upgrade apply holds the required project lock before migration begins. Explicit
native Agentera resource cleanup additionally uses its ownership journal and
shared lock. Lock creation is atomic, and release succeeds only for the matching
ownership token.
A stale or malformed lock stops the operation; inspect the named lock file,
remove only that file after confirming no operation owns it, then rerun.

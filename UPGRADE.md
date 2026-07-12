# Upgrade and runtime lifecycle

Agentera 3.0 uses one upgrade command for project/app migration and explicitly
selected runtime lifecycle work. Preview and apply are separate operations.

Before the npm stable dist-tag promotion, use `agentera@next`. The stable 2.x
channel remains `agentera@latest` until that promotion; this repository does
not publish or retag as part of an upgrade run.

## Start with a preview

```bash
npx -y agentera@next upgrade --dry-run --channel development
```

On the v3 development channel, a dry-run without `--runtime` also observes all
active runtimes so blocked app or channel phases do not hide lifecycle findings.
The preview remains read-only. Runtime apply is explicit:

```bash
npx -y agentera@next upgrade --runtime all --dry-run
npx -y agentera@next upgrade --runtime cursor --dry-run
```

The active runtimes are OpenCode, Codex, Cursor, and GitHub Copilot. Selectors
are `all`, `opencode`, `codex`, `cursor`, and `copilot`.
`cursor-agent` is not a selector: Cursor Agent CLI and Cursor IDE are surfaces
of the one `cursor` identity. CLI is required; IDE is conditional.

The preview is strictly read-only. It creates no files, directories, locks,
caches, ownership journals, telemetry, or other state changes. Its output
includes:

- observed runtime and surface evidence;
- skill, plugin, hook, agent, configuration, enablement, trust, and native-action state;
- planned operations and dependencies;
- current ownership evidence and blocked reasons;
- exact manual or host-native actions;
- required support-floor gaps.

`prime` exposes a bounded projection of the same snapshot. `doctor` exposes the
detailed read-only diagnosis:

```bash
npx -y agentera@next prime --format json
npx -y agentera@next doctor --format json
```

Status and project-integration recommendations use the same lifecycle identity,
counts, blockers, and retry guidance as `prime` and `doctor`.

## Apply approved Agentera-owned work

After reviewing an all-runtime preview, use its generated command or rerun the
selection explicitly with `--runtime all --yes`:

```bash
npx -y agentera@next upgrade --runtime all --yes
```

An apply invoked without `--runtime` retains the existing app-only behavior.
Named selectors such as `--runtime cursor` limit runtime-specific writes to that
identity. Stable-channel v2 behavior remains app-only.

Apply can write only resources declared by the lifecycle contract and proven
Agentera-owned by the append-only ownership journal. Matching names or bytes do
not establish ownership. User-owned, ambiguous, shadowed, or malformed targets
remain blocked.

For every blocked collision, the exact remediation is: “The destination is not
ledger-owned; review the collision manually. Agentera will not adopt it by name
or equality.” The destination remains unchanged until authoritative ownership is
available.

The operation outcomes are:

- `applied` — the declared change was published;
- `noop` — desired state was already exact;
- `failed` — this operation failed; independent operations may continue;
- `blocked_unowned` — ownership was not proven;
- `skipped_dependency` — a prerequisite did not complete;
- `action_required` — the user or host must perform the step.

Retries are designed to converge. Completed work becomes `noop`; failed or
pending work is re-observed and retried. Corrupt, forked, disconnected, or
non-contiguous ownership journals fail closed.

Secure automatic filesystem publication currently requires Linux
`/proc/self/fd`. On macOS, Windows, or a Linux environment without that secure
primitive, preview and diagnosis still work but mutation is returned as
`action_required`.

## Ownership and trust boundary

The canonical skill is:

```text
~/.agents/skills/agentera
```

Agentera can maintain declared Agentera-owned skill, plugin, hook, and agent
resources. It does not run native runtime package managers or approve:

- runtime installation or self-update;
- authentication;
- plugin or hook enablement;
- trust prompts or organizational policy;
- user-owned configuration collisions.

Those steps are reported with exact remediation and remain user-owned.

## Cursor lifecycle

Cursor is one runtime identity with two surfaces:

| Surface | Support-floor role | Typical source |
| --- | --- | --- |
| Agent CLI | required | Cursor CLI binary and canonical shared skill |
| IDE | conditional | `.cursor-plugin/plugin.json`, `.cursor/hooks.json`, `.cursor/agents/` |

An absent IDE does not block a CLI-only installation. Once IDE evidence is
present, its incomplete or denied mandatory evidence is reported beneath the
same Cursor identity.

## Retired Claude cleanup

Claude Code is not an active Agentera runtime and cannot be passed to
`--runtime`. Its legacy cleanup is a separate explicit selection:

```bash
npx -y agentera@next upgrade --legacy-cleanup claude --dry-run
npx -y agentera@next upgrade --legacy-cleanup claude --yes
```

Cleanup is limited to the exact Agentera-owned legacy skill link recorded by
the ownership ledger. It never removes Claude projects, transcripts, settings,
credentials, caches, or other user data. Ambiguous or unowned resources remain
blocked.

Historical transcript import is independent of cleanup. Default extraction and
analytics do not read Claude history. Import requires explicit local consent:

```bash
npx -y agentera@next report refresh --import-source claude
```

Imported records carry `historical_import` provenance, have no active runtime
ID, and remain excluded from default active-runtime analytics.

## v2 to v3 project migration

Use the development channel explicitly while 3.0 is on `@next`:

```bash
npx -y agentera@next upgrade --channel development --project "$PWD" --dry-run
npx -y agentera@next upgrade --channel development --project "$PWD" --yes
```

The preview reports artifact migration, app migration, legacy cleanup, and any
explicitly selected runtime work as separate phases. It does not cross the
major boundary or mutate the project without `--yes`.

Useful phase filters are repeatable:

```bash
npx -y agentera@next upgrade --only artifacts --dry-run
npx -y agentera@next upgrade --only runtime --dry-run
npx -y agentera@next upgrade --only cleanup --dry-run
```

## Verification and recovery

After apply:

```bash
npx -y agentera@next doctor --format json
npx -y agentera@next prime --format json
```

`upgrade --verify` adds doctor and capability-schema checks to an upgrade run.
`upgrade --restore` restores the latest supported app-migration snapshot; it
does not bypass lifecycle ownership or trust checks. For lifecycle partial
failure, rerun the same preview and apply selection. Do not delete or hand-edit
the ownership journal to force adoption.

`--force` applies only where the owning migration contract explicitly permits
replacement. It does not convert user-owned resources into Agentera-owned
resources and does not approve native or trust actions.

## Maintainer verification

Release preparation does not publish, tag, or push:

```bash
pnpm -C packages/cli test
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
node packages/cli/dist/bin/agentera.js check validate lifecycle-adapters
node packages/cli/dist/bin/agentera.js check validate release-metadata
pnpm -C packages/cli run bundle:data
npm pack --dry-run --json --ignore-scripts
```

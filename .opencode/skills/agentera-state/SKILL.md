---
name: agentera-state
description: >-
  Read or mutate Agentera project state and prepare repository commits. Use for
  plans, tasks, progress, decisions, health, TODO, changelog, commit scopes,
  state closeout, and same-commit artifact requirements.
---

# Agentera state and commits

Load this skill before mutating project state or creating a commit. State
updates must preserve writer authority and land with the substantive change.

## Read authority

Read project state through the CLI before reading artifacts directly:

```bash
npx -y agentera@next prime
npx -y agentera@next state todo list
npx -y agentera@next state plan list --status open
npx -y agentera@next state query --list-artifacts
```

Canonical names such as `DOCS.md` can map to YAML paths. Use CLI inventory and
`.agentera/docs.yaml` mappings as the source of truth.

Use exact `get --id ID` forms for entity detail. Do not infer identity,
predecessor, successor, or ownership from list order.

## Writer authority

Progress, decisions, plans, tasks, and health records are writer-owned entities.
Never edit `.agentera/entities/` directly. Discover each mutation contract
before constructing a write:

```bash
npx -y agentera@next state decisions explain
npx -y agentera@next state decisions explain --verb update
npx -y agentera@next state progress explain --verb append
npx -y agentera@next state plan explain --verb create
npx -y agentera@next state health explain --verb append
```

Use returned examples and field definitions. Add `--dry-run` when a preview is
appropriate. `npx -y agentera@next schema` exposes the complete
writer operation matrix.

Bounded retrieval is governed by
`references/artifacts/state-storage-authority.yaml`. Do not duplicate its
identity, cursor, omission, compatibility, archive, or output-bound rules.

Artifacts outside typed writer families remain governed by their owning
capability. Never modify `.agentera/vision.yaml` outside a vision capability or
an explicit vision task.

## Commit format

Use Conventional Commits:

```text
type(scope): imperative summary
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `chore`, and `test`.
Describe the engineering outcome, not plan IDs, agent activity, or
implementation chronology.

## Scope vocabulary

Use one dominant scope or omit it. Do not use `agentera` as a scope and do not
use comma-separated scopes.

| Scope | Area |
| --- | --- |
| `cli` | CLI behavior, output, and tests |
| `hooks` | Hooks and artifact validation |
| `schemas` | Protocol, schemas, and schema contracts |
| `eval` | Semantic evaluation fixtures and harnesses |
| `install` | App home, setup, upgrade, and doctor behavior |
| `package` | Package manifests, registry, lockfiles, version surfaces |
| `runtime` | Shared cross-runtime behavior and adapters |
| `opencode` | OpenCode runtime and packaging |
| `claude` | Retired Claude migration and historical import only |
| `codex` | Codex runtime and packaging |
| `copilot` | Copilot runtime and packaging |
| `cursor` | Cursor runtime, hooks, agents, and packaging |
| `release` | Release readiness, publication, and version cuts |
| `agents` | `AGENTS.md` and runtime-neutral operating guidance |
| Capability name | Behavior, prose, schemas, or tests for that capability |

Capability scopes are `status`, `vision`, `discuss`, `research`, `plan`,
`build`, `optimize`, `audit`, `document`, `profile`, `design`, and
`orchestrate`. New scopes are closed by default. Add a new scope to the
repository vocabulary in the same commit or omit it.

## Same-commit state rule

When a task changes code, tests, or user-facing docs, fold related state into
that same commit:

- Plan and task updates through the typed plan writer.
- Any durable progress record authorized or required by the current `state
  progress explain --verb append` guidance, through the typed progress writer.
- `TODO.md` open-item resolution or newly discovered work.
- Health findings through the typed health writer.
- Decision updates through the typed decisions writer.
- User-facing `CHANGELOG.md` entries when behavior changes.

Do not leave state closeout for a standalone bookkeeping commit. If the product
commit already shipped, fold state into the next substantive commit on the same
task. Do not hash-backfill `resolved @ <sha>`; a date or release version in the
implementation commit is sufficient.

Standalone commits are limited to release cuts and npm registry alignment when
no product code accompanies the tag. Do not create standalone `chore:` commits
for plan archive, TODO closeout, progress, health, or decision bookkeeping.

## Refactor sequencing

When work naturally separates behavior-preserving structure from behavior:

1. Commit the verified refactor first.
2. Commit the minimal behavior change and tests second.

If the user requests one squashed delivery, one commit is acceptable. Do not
hide a discovered refactor inside a behavior commit merely because both were
found in one session.

## Changelog

`CHANGELOG.md` follows Keep a Changelog. Write for a cold reader: what shipped,
what changed, and what broke. Use `## [X.Y.Z] · YYYY-MM-DD` for released
versions and retain unreleased work under `## [Unreleased]`.

For meaningful minor or major releases, add `### Key highlights` before the
categorized sections. Patch releases can omit highlights when the diff is
small. In highlights, use a short bold label followed by a factual summary. In
`Fixed`, begin each bullet with `Fixed`.

Include concrete commands, flags, environment variables, defaults, and
before/after measurements when they help a reader act. Exclude internal plan
IDs, state evidence, receipt paths, archive workpapers, registry sync notes,
hype, and unshipped scaffolding.

Fold changelog updates into the implementation or release commit. Do not create
standalone changelog bookkeeping commits.

## Comment boundary

Code comments explain why the current code has its shape. They do not narrate
development history, rejected alternatives, or improvements over prior code.
That history belongs in commit messages or design records.

## Git safety

- Never push during capability execution.
- Never amend unless the user explicitly requests it.
- Never force-push or use destructive Git operations unless the user explicitly
  requests the applicable action.
- Never skip hooks as a routine shortcut. Use `LEFTHOOK=0` only when hook
  configuration is broken or a failure is already tracked for CI.
- Preserve unrelated user changes and stage only intended files.

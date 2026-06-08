# Upstream issue draft: `wt merge --remove` can poison `core.bare` on the main checkout

**Status:** Local draft only — do not file automatically.

**Project:** [worktrunk](https://github.com/max-sixty/worktrunk)  
**Observed version:** `wt v0.56.0`  
**Reporter context:** agentera monorepo realisera fix-merge workflow

## Summary

After a successful `wt merge main` from a sibling worktree, background worktree cleanup left the **primary** repository with `core.bare = true` in the shared `.git/config`. Git then refused normal working-tree operations (`fatal: this operation must be run in a work tree`). Reflog, refs, and working-tree files were intact; recovery was `git config core.bare false`.

## Impact

- Silent footgun: any agent or human repeating `wt switch --create` + `wt merge --remove` can brick the main checkout until config is repaired.
- No data loss observed, but the main repo becomes unusable for worktree-based workflows until manual recovery.

## Environment

- `wt` v0.56.0 (Go binary; strings include `core.bare`, `core.worktree`, `worktrunk::git::repository`)
- Default worktree path template: `{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}` (sibling directories)
- Main repo: normal non-bare layout (`~/git/agentera` with `~/git/agentera/.git/` directory)

## Observed sequence

1. From main repo on branch `feat/v3`: `wt switch --create fix/foo --base origin/main`  
   Worktree created at sibling `~/git/agentera.fix-foo` (not under `.git/worktrees/`).
2. `git -C <worktree> rebase main`
3. `wt merge main` from the feature worktree
4. **Warning during merge:**  
   `Branch-worktree mismatch: fix/foo @ ~/git/agentera.fix-foo, expected @ ~/git/agentera/.git.fix-foo ⚑`
5. Merge succeeded: `✓ Merged to main (1 commit, …)`
6. Background cleanup: `◎ Removing fix/foo worktree & branch in background (same commit as main, _)`
7. After cleanup, from main repo: `git worktree list` showed `/home/jgabor/git/agentera (bare)` and shared `.git/config` contained `core.bare = true`.
8. Recovery: `git config core.bare false`

## Root-cause analysis (code-level)

### 1. Branch-worktree mismatch proves bare-layout classification at merge time

The mismatch warning is emitted when `path_mismatch()` finds the worktree path differs from `compute_worktree_path()` (`src/commands/worktree/resolve.rs:140-148`).

The **expected** path `~/git/agentera/.git.fix-foo` only arises when:

- `is_bare()` is true (`resolve.rs:86-91`), so `repo_path()` resolves to the git common dir (`agentera/.git`) per `src/git/repository/mod.rs:1079-1080`, and
- the default template expands with `repo` = `.git` (the basename of that path).

Meanwhile the **actual** path `~/git/agentera.fix-foo` is what `wt switch --create` produces for a **normal** repo with the default sibling template.

So merge-time removal ran while worktrunk classified the repo as bare-at-`.git` even though the worktree was created at the normal sibling path — a hybrid state.

### 2. Bare-at-`.git` + `extensions.worktreeConfig` is a first-class layout in worktrunk

Worktrunk documents the trio (`src/git/repository/mod.rs:764-778`, `src/git/repository/tests.rs:842-906`):

- Shared `.git/config`: `core.bare = false`, `extensions.worktreeConfig = true`
- Main worktree per-worktree file `.git/config.worktree`: `[core] bare = true`
- Worktrees as siblings of the hidden `.git` directory

`is_bare()` reads `core.bare` from the bulk config map (`mod.rs:1182-1183`). With `worktreeConfig`, that value may come from `config.worktree` depending on which worktree runs the read — see issue #2779 and the prewarm skip at `mod.rs:774-778`.

### 3. Background removal rewrites git metadata from `main_path`

`wt merge --remove` finishes via `finish_after_merge` → `handle_remove_output` → `spawn_background_removal` (`src/commands/worktree/finish.rs:137-156`, `src/output/handlers.rs:110-134`).

The fast path runs `stage_worktree_removal` + `prune_worktrees`; the fallback runs detached `git worktree remove`, which worktrunk notes can rewrite `.git/config` (`handlers.rs:145`).

`main_path` is the merge **destination** (`finish.rs:138`), i.e. the primary checkout. Post-switch messaging in bare-layout repros shows `Switched to worktree for main @ <project>/.git` (bare git dir) rather than the linked main worktree directory — suggesting destination resolution is wrong for bare-at-`.git` layouts during merge cleanup.

### 4. worktrunk does not intentionally set `core.bare` in Rust

No production Rust path calls `set_config("core.bare", "true")`. The poison likely comes from **git worktree prune/remove** interacting with inconsistent bare/normal metadata when the branch-worktree mismatch is present.

## Minimal repro (partial)

Reproduced the **mismatch warning class** and bare-layout post-switch behavior; **did not** flip shared `core.bare` on a clean normal repo in throwaway tests.

See `docs/upstream/worktrunk-core-bare-repro.transcript`.

## Suggested fix (upstream)

1. **Never classify a checkout as bare** unless shared config or the main-worktree `config.worktree` consistently says so — and never mix bare `repo_path` with worktrees created under the normal sibling template.
2. **Post-merge destination** for bare-at-`.git` layouts must be the primary linked worktree (`myproject/main`), not the bare git directory (`myproject/.git`).
3. **After background removal**, assert `core.bare` in shared config is still `false` for non-bare-primary layouts; abort or auto-repair before exit.
4. Add an integration test: bare-at-`.git` + sibling worktree at default template path + `wt merge --remove` must not leave shared `core.bare=true`.

## Workaround (downstream)

After any `wt merge` that removes a worktree, verify:

```bash
git config --bool core.bare   # must be false
```

Recovery:

```bash
git config core.bare false
```

agentera ships `hooks/post-merge-check-bare.sh` via lefthook `post-merge` to auto-repair.

## Issue title (if filing)

`wt merge --remove` can set `core.bare=true` on primary checkout when branch-worktree path mismatches bare-at-.git layout

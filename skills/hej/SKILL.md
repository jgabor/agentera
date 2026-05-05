---
name: hej
description: >
  Legacy Agentera v1 entry-point bridge. Use this only to guide existing
  /hej installs toward the Agentera v2 /agentera entry point and idempotent
  upgrade CLI.
version: "2.1.0"
legacy_bridge: true
---

# hej legacy bridge

This skill exists only for users who still have the Agentera v1 `/hej`
entry point installed. Agentera v2 uses `/agentera` as the single active
entry point.

Do not run the old HEJ orientation workflow from v1. Do not produce the v1
dashboard. This bridge is an upgrade handoff.

## When Loaded

1. Explain briefly that this is a legacy Agentera v1 entry point and that
   Agentera v2 starts from `/agentera` (`$agentera` in Codex).
2. Check the current project for v1 Markdown artifacts that do not yet have
   v2 YAML counterparts:
   - `.agentera/PROGRESS.md` without `.agentera/progress.yaml`
   - `.agentera/PLAN.md` without `.agentera/plan.yaml`
   - `.agentera/DECISIONS.md` without `.agentera/decisions.yaml`
   - `.agentera/HEALTH.md` without `.agentera/health.yaml`
   - `.agentera/SESSION.md` without `.agentera/session.yaml`
   - `.agentera/DOCS.md` without `.agentera/docs.yaml`
   - root `VISION.md` without `.agentera/vision.yaml`
3. If any v1 state is present, show the affected files and run or offer this
   preview command:

   ```bash
   uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run
   ```

4. Ask before applying changes. After explicit confirmation, use the package
   refresh path so `/agentera` is installed alongside the migrated project
   state:

   ```bash
   uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --yes --update-packages
   ```

5. If no v1 project state is present, offer the package-only refresh when
   `/agentera` is not available:

   ```bash
   uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only packages --yes --update-packages
   ```

6. End by telling the user to invoke `/agentera` (`$agentera` in Codex).

## Safety

- Never mutate project artifacts or runtime installs without explicit
  confirmation from the user.
- Prefer `uvx --from git+https://github.com/jgabor/agentera` because legacy
  users may not have cloned the repository.
- If running from a local Agentera checkout with `scripts/agentera`, the local
  equivalent is `uv run scripts/agentera upgrade ...`.

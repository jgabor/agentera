---
name: hej
description: >
  Legacy Agentera v1 explicit /hej bridge. Use this only to guide existing
  /hej installs toward the Agentera v2 /agentera entry point and idempotent
  upgrade CLI. Do not use this skill for bare text `hej`; route that through
  the bundled agentera skill and the agentera hej dashboard path.
version: "2.7.8"
legacy_bridge: true
---

# hej legacy bridge

This skill exists only for users who still have the Agentera v1 `/hej`
entry point installed. Agentera v2 uses `/agentera` as the single active
entry point. A bare text message exactly `hej` is not this legacy bridge; it
belongs to the bundled `agentera` skill and its `agentera hej` dashboard path.

Do not run the old HEJ orientation workflow from v1. Do not produce the v1
dashboard. This bridge is an upgrade handoff.

## When Loaded

1. Explain briefly in plain language: `This is the old /hej entry point.
   Agentera now starts from /agentera` (`$agentera` in Codex).
2. Check the current project for v1 Markdown artifacts that do not yet have
   v2 YAML counterparts:
   - `.agentera/PROGRESS.md` without `.agentera/progress.yaml`
   - `.agentera/PLAN.md` without `.agentera/plan.yaml`
   - `.agentera/DECISIONS.md` without `.agentera/decisions.yaml`
   - `.agentera/HEALTH.md` without `.agentera/health.yaml`
   - `.agentera/DOCS.md` without `.agentera/docs.yaml`
   - root `VISION.md` without `.agentera/vision.yaml`
3. If any old project state is present, show the affected files and run or offer
   this preview command. Say clearly that the preview changes nothing:

   ```bash
   uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run
   ```

4. Ask before applying changes. Explain the apply step plainly: it installs or
   repairs Agentera's local app, updates managed runtime surfaces, and converts
   old Agentera project notes to the new format with backups. It will not edit
   shell startup files. After explicit confirmation, use:

   ```bash
   uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --yes
   ```

   Add `--update-packages` only when the user explicitly approves package-manager
   commands such as `npx skills remove` or `npx skills add`.

5. If no v1 project state is present, offer the package-only update only when
   `/agentera` is not available and the user explicitly approves package-manager
   commands:

   ```bash
   uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only packages --yes --update-packages
   ```

6. End by telling the user to invoke `/agentera` (`$agentera` in Codex).

## Safety

- Never mutate project artifacts or runtime installs without explicit
  confirmation from the user.
- Never ask Agentera to edit shell startup files. Leftover 1.x managed marker
  blocks reported by doctor or `setup_copilot.py` are user-owned manual cleanup.
  Upgrade does not scan shell startup files.
- Prefer `uvx --from git+https://github.com/jgabor/agentera` because legacy
  users may not have cloned the repository.
- If running from a local Agentera checkout with `scripts/agentera`, the local
  equivalent is `uv run scripts/agentera upgrade ...`.

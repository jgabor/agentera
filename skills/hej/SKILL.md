---
name: hej
description: >
  Legacy Agentera v1 explicit /hej bridge. Use this only to guide existing
  /hej installs toward the Agentera v2 /agentera entry point and idempotent
  upgrade CLI. Do not use this skill for bare text `hej`; route that through
  the bundled agentera skill and the agentera hej dashboard path.
version: "2.7.7"
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
   npx -y agentera@latest doctor
   ```

4. Ask before applying changes. Explain the apply step plainly: it installs or
   repairs Agentera's local app, updates managed runtime surfaces, and converts
   old Agentera project notes to the new format with backups. It will not edit
   shell startup files. After explicit confirmation, use:

   ```bash
   npx -y agentera@latest prime
   ```

   agentera ships as a self-contained npm package: running the latest version
   uses the newest bundled app data directly. There is no separate local app
   install to copy or repair.

5. To refresh the version a runtime invokes, point its command at
   `npx -y agentera@latest` (or a pinned `agentera@<version>`).

6. End by telling the user to invoke `/agentera` (`$agentera` in Codex).

## Safety

- Never mutate project artifacts or runtime installs without explicit
  confirmation from the user.
- Never ask Agentera to edit shell startup files. Leftover 1.x managed marker
  blocks reported by doctor are user-owned manual cleanup.
  Upgrade does not scan shell startup files.
- Prefer `npx -y agentera@latest` so the newest published self-contained package
  is used without a separate install step.
- From a local Agentera checkout, the equivalent is
  `node packages/cli/dist/bin/agentera.js …` after `pnpm -C packages/cli build`.

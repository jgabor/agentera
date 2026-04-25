# Plan: Copilot Marketplace-First Install Guidance

<!-- Level: light | Created: 2026-04-25 | Status: active -->

## What

Update Copilot plugin guidance so marketplace-style installs are the preferred path, while direct `OWNER/REPO` installs remain documented only as a deprecated fallback.

## Why

Copilot now warns that direct plugin installs are deprecated. Agentera's current metadata is valid, but README guidance still leads with the path Copilot says will stop working.

## Constraints

- Do not claim a specific marketplace source unless it is verified.
- Preserve direct install guidance as a temporary fallback.
- Keep Copilot hook support described as partial.
- Do not change runtime adapter behavior unless validation requires it.
- Keep validation proportional: one pass and one fail for the documentation or metadata guard.

## Acceptance Criteria

▸ GIVEN users read Copilot install docs WHEN they choose an install path THEN marketplace-style `plugin@marketplace` is presented as preferred.
▸ GIVEN users still need direct installs WHEN they read fallback docs THEN `OWNER/REPO` is clearly marked deprecated by Copilot.
▸ GIVEN Copilot runtime support is described WHEN docs mention hooks THEN lifecycle support remains partial and evidence-bounded.
▸ GIVEN installed plugin state includes older per-skill entries WHEN docs explain verification THEN users can distinguish aggregate `agentera` from legacy skill entries.
▸ GIVEN validation runs WHEN marketplace-first guidance regresses THEN a focused test or validator check fails.

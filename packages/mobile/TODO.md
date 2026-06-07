# TODO

Plan and migration checklist: [`docs/consolidation/monorepo-plan.md`](../../docs/consolidation/monorepo-plan.md).

Open decisions (CLI integration, publish identity, skill horizon): [`docs/consolidation/mobile-open-decisions.md`](../../docs/consolidation/mobile-open-decisions.md).

## ⇉ Degraded

- [docs] Add logo, badges, and screenshot to README
- [docs] Add tiered model table (glyph, tier, default model, assignments) to README
- [feat] Scaffold SvelteKit app with Cursor SDK integration
- [feat] Implement smart bar and sidebar control center
- [feat] Implement chat queue, paste collapse, and rewind affordances

## → Normal

- [docs] Publish mobile product page on packages/web Starlight site
- [chore] Wire CI for packages/mobile when app source lands (lefthook pre-commit already configured)
- [chore] Remove temporary `vite.config.ts` hook plumbing when SvelteKit scaffold replaces it

## ⇢ Annoying

- [docs] Improve chat interface section prose once UI is implemented

## ✓ Resolved

- ~~[chore] Merge repository into jgabor/agentera as packages/mobile (@agentera/mobile)~~ · docs stub landed 2026-06-05
- ~~[chore] Wire lefthook pre-commit for packages/mobile~~ · `.lefthook.yml` mobile hook added 2026-06-05

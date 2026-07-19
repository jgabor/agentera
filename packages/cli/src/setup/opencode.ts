/**
 * OpenCode runtime adapter setup and diagnostics.
 *
 * OpenCode hook surfaces (event, shell.env, tool.execute.before/after,
 * experimental.session.compacting) ship in `.opencode/plugins/agentera.js` and are
 * validated by `validate/lifecycleAdapters.ts`. Managed commands, agents, and
 * the canonical shared skill is diagnosed here and managed only through an
 * explicitly selected lifecycle upgrade.
 *
 * Implementations currently live in `doctor.ts` (slice-2/3 extraction); this module
 * is the canonical import surface for OpenCode-specific setup helpers.
 */
export {
  opencodeConfigDir,
  hasManagedMarker,
  diagnoseOpencodeCommands,
  diagnoseCanonicalSkill,
  diagnoseOpencode,
} from "./doctor.js";

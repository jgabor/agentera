/**
 * OpenCode runtime adapter setup and diagnostics.
 *
 * OpenCode hook surfaces (event, shell.env, chat.message, tool.execute.before/after,
 * experimental.session.compacting) ship in `.opencode/plugins/agentera.js` and are
 * validated by `validate/lifecycleAdapters.ts`. Managed commands, agents, and
 * skill paths are diagnosed here and installed by `upgrade/runtimeMigration.ts`.
 *
 * Implementations currently live in `doctor.ts` (slice-2/3 extraction); this module
 * is the canonical import surface for OpenCode-specific setup helpers.
 */
export {
  opencodeConfigDir,
  opencodeCommandTemplate,
  hasManagedMarker,
  diagnoseOpencodeCommands,
  diagnoseOpencodeSkillPaths,
  diagnoseOpencode,
} from "./doctor.js";

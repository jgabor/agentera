import fs from "node:fs";
import path from "node:path";

import { resolveInvokedUpdateChannel } from "../../../upgrade/channels.js";
import { buildUpgradeCommands } from "../../../upgrade/upgradeCommands.js";
import type { V1MigrationSummary } from "../../contracts/orientationState.js";
import type { Env } from "./types.js";

export function isLocalCheckout(root: string): boolean {
  return ["skills/agentera/SKILL.md", "registry.json"].every((rel) =>
    fs.existsSync(path.join(root, rel)),
  );
}

export function v1MigrationSummary(
  v1Artifacts: string[],
  opts: { sourceRoot: string; home: string; env: Env },
): V1MigrationSummary {
  const detected = v1Artifacts.length > 0;
  const channel = resolveInvokedUpdateChannel({
    channel: null,
    sourceRoot: opts.sourceRoot,
    home: opts.home,
    env: opts.env,
  });
  const cmds = detected
    ? buildUpgradeCommands({
        project: process.cwd(),
        installRoot: null,
        channel,
        only: ["artifacts"],
        cwdDefault: true,
      })
    : null;
  const summary: V1MigrationSummary = {
    detected,
    affected_files: v1Artifacts,
    dry_run_command: cmds?.dryRunCommand ?? null,
    apply_command: cmds?.applyCommand ?? null,
    requires_confirmation: detected,
    update_channel: channel.channel,
  };
  if (detected && isLocalCheckout(process.cwd())) {
    summary.local_dry_run_command = cmds?.dryRunCommand ?? null;
    summary.local_apply_command = cmds?.applyCommand ?? null;
  }
  return summary;
}

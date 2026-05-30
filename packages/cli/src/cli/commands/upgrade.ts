import os from "node:os";

import { expanduser, resolvePath } from "../../core/paths.js";
import { isNpxBundleRoot } from "../../core/sourceRoot.js";
import {
  resolveDoctorInstallRoot,
  resolveSourceRootStrict,
} from "../../upgrade/appModel.js";
import { buildDoctorStatus, EXPECTED_STATE_COMMANDS } from "../../upgrade/doctor.js";

type Io = { out?: (t: string) => void; err?: (t: string) => void };

export interface UpgradeArgs {
  installRoot?: string | null;
  home?: string | null;
  project?: string | null;
  expectedVersion?: string | null;
  yes?: boolean;
  dryRun?: boolean;
  format?: string;
}

/** Canonical update entry point for the self-contained npm package. */
export const UPGRADE_COMMAND = "npx -y agentera@latest";

interface UpgradePayload {
  command: "upgrade";
  schemaVersion: "agentera.upgrade.v1";
  mode: "self_contained" | "source_checkout";
  status: string;
  appHome: string;
  appHomeSource: string;
  expectedVersion: string;
  currentVersion: string | null;
  updateCommand: string;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function renderUpgrade(payload: UpgradePayload): string {
  const lines = [
    "Agentera upgrade",
    `mode: ${payload.mode === "self_contained" ? "self-contained package" : "source checkout"}`,
    `status: ${String(payload.status).replace(/_/g, " ")}`,
    `current version: ${payload.currentVersion ?? "-"}`,
    `expected version: ${payload.expectedVersion}`,
    `app: ${payload.appHome}`,
    "",
    "This agentera is a self-contained package; there is no separate app install",
    "to copy or repair. To update, run a newer published version:",
    `  ${payload.updateCommand} <command>`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * agentera upgrade — fully self-contained model.
 *
 * agentera ships as a self-contained npm package, so there is no separate app
 * install to copy or repair. "Upgrading" means running a newer published
 * version (`npx -y agentera@latest`). This command reports the current app
 * status and the update path rather than mutating an installed app home.
 */
export function cmdUpgrade(args: UpgradeArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));

  if (args.yes && args.dryRun) {
    err("upgrade error: --yes and --dry-run are mutually exclusive\n");
    return 2;
  }

  let sourceRoot: string;
  try {
    sourceRoot = resolveSourceRootStrict();
  } catch (exc) {
    err(`upgrade error: ${(exc as Error).message}\n`);
    return 2;
  }
  const home = resolvePath(expanduser(args.home ?? os.homedir()));
  const [installRoot, rootSource] = resolveDoctorInstallRoot(args.installRoot ?? null, { home, sourceRoot });
  const status = buildDoctorStatus(installRoot, {
    rootSource,
    sourceRoot,
    home,
    project: resolvePath(expanduser(args.project ?? process.cwd())),
    expectedVersion: args.expectedVersion ?? null,
    expectedCommands: [...EXPECTED_STATE_COMMANDS],
    probeCli: false,
  });

  const payload: UpgradePayload = {
    command: "upgrade",
    schemaVersion: "agentera.upgrade.v1",
    mode: isNpxBundleRoot(sourceRoot) ? "self_contained" : "source_checkout",
    status: String(status.status),
    appHome: String(status.appHome),
    appHomeSource: String(status.appHomeSource),
    expectedVersion: String(status.expectedVersion),
    currentVersion: status.markerVersion ? String(status.markerVersion) : null,
    updateCommand: UPGRADE_COMMAND,
  };

  if ((args.format ?? "text") === "json") {
    out(JSON.stringify(sortKeysDeep(payload), null, 2) + "\n");
  } else {
    out(renderUpgrade(payload));
  }
  // Self-contained packages are always coherent; there is nothing to fail.
  return 0;
}

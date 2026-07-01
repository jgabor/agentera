import os from "node:os";

import { expanduser, resolvePath } from "../../core/paths.js";
import { pyJsonIndentSorted } from "../../core/pyjson.js";
import {
  resolveDoctorInstallRoot,
  resolveSourceRootStrict,
} from "../../upgrade/appModel.js";
import { runNpmSmokeChecks } from "../../setup/smokeChecks.js";
import type { JsonObject } from "../../core/jsonValue.js";
import type { BundleStatus } from "../contracts/bundleStatus.js";
import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_MIGRATION_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
  appLifecycleActionNoun,
  buildDoctorStatus,
  EXPECTED_STATE_COMMANDS,
  doctorParityJsonEnvelope,
} from "../../upgrade/doctor.js";
import { classifyInstall } from "../../upgrade/compatibility.js";
import type { UpdateChannelName } from "../../upgrade/channels.js";
import {
  prependCoexistenceDoctorSection,
  resolveCoexistenceDoctorLines,
} from "../../upgrade/coexistenceProbe.js";
import {
  prependNextMajorDoctorSection,
  resolveNextMajorDoctorLines,
} from "../../upgrade/nextMajorDoctor.js";
import { emitStructured } from "../structured.js";

/**
 * `agentera doctor` — app/runtime status. Port of agentera_upgrade.cmd_doctor +
 * render_doctor_status. build_doctor_status is reused (upgrade/doctor.ts). The
 * upgrade/retry command strings use the TS invocation form (npx/node), which
 * is the intended runtime form rather than Python's `uv run`.
 */

type Io = { out?: (t: string) => void; err?: (t: string) => void };

const PLAIN_STATUS: Record<string, string> = {
  pending: "ready to fix",
  applied: "fixed",
  noop: "already OK",
  blocked: "needs a decision",
  failed: "failed",
  skipped: "skipped",
  [APP_UP_TO_DATE]: "up to date",
  [APP_REPAIR_NEEDED]: "needs repair",
  [APP_OUTDATED]: "outdated",
  [APP_MIGRATION_NEEDED]: "needs migration",
  [APP_MANUAL_REVIEW_NEEDED]: "needs manual review",
};

function plainStatus(value: string): string {
  return PLAIN_STATUS[value] ?? value.replace(/_/g, " ").replace(/-/g, " ");
}

export function renderDoctorStatus(status: BundleStatus): string {
  const actionNoun = appLifecycleActionNoun(String(status.status));
  const lines = [
    "Agentera doctor",
    `status: ${plainStatus(status.status)}`,
    `expected version: ${status.expectedVersion}`,
    `Agentera directory: ${status.appHome}`,
    `App files directory: ${status.managedAppRoot}`,
    `Your Agentera data directory: ${status.userDataRoot}`,
  ];
  if (status.signals && status.signals.length > 0) {
    lines.push("");
    lines.push("What needs attention:");
    for (const signal of status.signals) {
      lines.push(`  - ${plainStatus(signal.status)}: ${signal.message}`);
      if (signal.missingCommands && signal.missingCommands.length > 0) {
        lines.push(`    Missing command: ${signal.missingCommands.join(", ")}`);
      }
    }
  }
  if (status.status === APP_UP_TO_DATE) {
    lines.push("");
    lines.push("No action needed: Agentera app files are up to date.");
  } else if (status.dryRunCommand) {
    lines.push("");
    lines.push("Next:");
    lines.push(`  1. Preview the ${actionNoun}: ${status.dryRunCommand}`);
    lines.push(`  2. If the preview looks right, apply the ${actionNoun}: ${status.applyCommand}`);
    if (status.retryCommand) {
      lines.push(`  3. Then retry Agentera: ${status.retryCommand}`);
    } else {
      lines.push(
        "  3. Then retry Agentera once a retry command is available.",
      );
    }
  } else {
    lines.push("");
    lines.push(
      "Next: choose a safer Agentera directory, or use `--force` only after checking the directory is safe to replace.",
    );
  }
  return lines.join("\n");
}

export interface DoctorArgs {
  installRoot?: string | null;
  home?: string | null;
  project?: string | null;
  expectedVersion?: string | null;
  expectCommand?: string[] | null;
  smoke?: boolean;
  allowLiveModel?: boolean;
  format?: string;
}

function renderDoctorSmoke(smoke: JsonObject): string {
  const lines = [
    "",
    "Smoke checks:",
    `  enabled: ${smoke.enabled ? "yes" : "no"}`,
    `  model calls attempted: ${smoke.modelCallsAttempted ? "yes" : "no"}`,
  ];
  for (const check of (smoke.checks ?? []) as JsonObject[]) {
    lines.push(`  - ${check.name}: ${check.status} - ${check.message}`);
  }
  return lines.join("\n");
}

export function cmdDoctor(args: DoctorArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  let sourceRoot: string;
  try {
    sourceRoot = resolveSourceRootStrict();
  } catch (exc) {
    err(`doctor error: ${(exc as Error).message}\n`);
    return 2;
  }
  const home = resolvePath(expanduser(args.home ?? os.homedir()));
  const [installRoot, rootSource] = resolveDoctorInstallRoot(args.installRoot ?? null, { home, sourceRoot });
  const expectedCommands = args.expectCommand && args.expectCommand.length > 0 ? args.expectCommand : [...EXPECTED_STATE_COMMANDS];
  const status = buildDoctorStatus(installRoot, {
    rootSource,
    sourceRoot,
    home,
    project: resolvePath(expanduser(args.project ?? process.cwd())),
    expectedVersion: args.expectedVersion ?? null,
    expectedCommands,
  });
  let smokeReport: JsonObject | null = null;
  if (args.smoke) {
    smokeReport = runNpmSmokeChecks(sourceRoot, process.env, {
      liveModelAllowed: Boolean(args.allowLiveModel),
    }) as JsonObject;
  }
  if ((args.format ?? "text") === "json") {
    const payload = doctorParityJsonEnvelope(status);
    if (smokeReport) payload.smoke = smokeReport;
    out(pyJsonIndentSorted(payload) + "\n");
  } else {
    const install = classifyInstall({ appHome: installRoot, sourceRoot });
    const coexistenceLines = resolveCoexistenceDoctorLines({
      home,
      sourceRoot,
      env: { ...process.env, HOME: home },
    });
    const nextMajorLines = resolveNextMajorDoctorLines({
      sourceRoot,
      home,
      channel: (status.updateChannel as UpdateChannelName | undefined) ?? null,
      install,
      env: process.env,
    });
    const body =
      prependCoexistenceDoctorSection(
        prependNextMajorDoctorSection(renderDoctorStatus(status), nextMajorLines),
        coexistenceLines,
      ) + (smokeReport ? renderDoctorSmoke(smokeReport) : "");
    out(body + "\n");
  }
  if (args.smoke) {
    const failCount = Number((smokeReport?.summary as JsonObject | undefined)?.fail ?? 0);
    if (failCount > 0) return 1;
  }
  return status.status === APP_UP_TO_DATE ? 0 : 1;
}

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
import { diagnoseCanonicalSkill } from "../../setup/doctor.js";
import type { RuntimeLifecycleSnapshot } from "../../runtime/lifecycleSnapshot.js";

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

export function renderRuntimeLifecycleDiagnosis(snapshot: RuntimeLifecycleSnapshot): string {
  const lines = [
    "",
    "Runtime lifecycle diagnosis:",
    `  snapshot: ${snapshot.schemaVersion}`,
    `  status vocabulary: ${snapshot.statusVocabularyVersion}`,
    `  release blocked: ${snapshot.releaseBlocked ? "yes" : "no"}`,
  ];
  for (const runtime of snapshot.runtimes) {
    lines.push(`${runtime.runtimeId}: ${runtime.status}`);
    lines.push(
      `  support floor: ${runtime.supportFloor.met ? "met" : "unmet"}; ` +
        `blockers=${runtime.blockers.length}; actions=${runtime.actionCount}`,
    );
    for (const blocker of runtime.blockers) {
      const evidence = blocker.evidence
        ? `; evidence=${blocker.evidence.field}:${String(blocker.evidence.observed)}`
        : "";
      lines.push(`  blocker: ${blocker.code} - ${blocker.detail}${evidence}`);
    }
    lines.push(`  canonical skill: ${String(runtime.canonicalSkill.detected)} at ${runtime.canonicalSkill.path}`);
    for (const surface of runtime.surfaces) {
      lines.push(
        `  surface ${surface.id}: ${surface.status}; expected=${surface.expected ? "yes" : "no"}; ` +
          `installed=${String(surface.evidence.installed ?? "unknown")}; ` +
          `enabled=${String(surface.evidence.enabled ?? "unknown")}; ` +
          `trusted=${String(surface.evidence.trusted ?? "unknown")}`,
      );
      for (const category of surface.categories) {
        lines.push(
          `    ${category.category}: ${category.state}; capability=${category.capability}; source=${category.source}`,
        );
        for (const evidence of category.evidence) {
          lines.push(
            `      evidence: ${evidence.state} - ${evidence.detail}` +
              (evidence.path ? ` (${evidence.path})` : ""),
          );
        }
        if (category.precedence) {
          const winner = category.precedence.winner?.path ?? "none";
          const shadowing = category.precedence.shadowing.map((entry) => entry.path).join(", ") || "none";
          lines.push(`      precedence: winner=${winner}; shadowing=${shadowing}`);
        }
        if (category.remediation.kind !== "none") {
          lines.push(`      action: ${category.remediation.kind} - ${category.remediation.summary}`);
          for (const action of category.remediation.nativeActions) {
            const command = Array.isArray(action.command) ? action.command.join(" ") : action.command;
            lines.push(`      native step: ${command} - ${action.instruction}`);
          }
        }
      }
    }
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
  const project = resolvePath(expanduser(args.project ?? process.cwd()));
  const [installRoot, rootSource] = resolveDoctorInstallRoot(args.installRoot ?? null, { home, sourceRoot });
  const expectedCommands = args.expectCommand && args.expectCommand.length > 0 ? args.expectCommand : [...EXPECTED_STATE_COMMANDS];
  const status = buildDoctorStatus(installRoot, {
    rootSource,
    sourceRoot,
    home,
    project,
    expectedVersion: args.expectedVersion ?? null,
    expectedCommands,
  });
  const sharedSkill = diagnoseCanonicalSkill(home);
  let smokeReport: JsonObject | null = null;
  if (args.smoke) {
    smokeReport = runNpmSmokeChecks(sourceRoot, process.env, {
      liveModelAllowed: Boolean(args.allowLiveModel),
    }) as JsonObject;
  }
  if ((args.format ?? "text") === "json") {
    const payload = doctorParityJsonEnvelope(status);
    payload.shared_skill = sharedSkill;
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
      ) + `\nShared skill\n  ${String(sharedSkill.status)}: ${String(sharedSkill.message)}\n  path: ${String(sharedSkill.path)}\n` + (smokeReport ? renderDoctorSmoke(smokeReport) : "");
    out(body + "\n");
  }
  if (args.smoke) {
    const failCount = Number((smokeReport?.summary as JsonObject | undefined)?.fail ?? 0);
    if (failCount > 0) return 1;
  }
  return status.status === APP_UP_TO_DATE && sharedSkill.status === "pass" ? 0 : 1;
}

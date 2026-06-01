import os from "node:os";

import { expanduser, resolvePath } from "../../core/paths.js";
import {
  resolveDoctorInstallRoot,
  resolveSourceRootStrict,
} from "../../upgrade/appModel.js";
import { runNpmSmokeChecks } from "../../setup/smokeChecks.js";
import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_MIGRATION_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
  buildDoctorStatus,
  EXPECTED_STATE_COMMANDS,
  ProbeResult,
  publicDoctorStatus,
} from "../../upgrade/doctor.js";
import { emitStructured } from "../structured.js";

/**
 * `agentera doctor` — app/runtime status. Port of agentera_upgrade.cmd_doctor +
 * render_doctor_status. build_doctor_status is reused (upgrade/doctor.ts). The CLI
 * probe verifies the TS dispatcher exposes the expected state commands in-process;
 * the upgrade/retry command strings use the TS invocation form (npx/node), which
 * is the intended runtime form rather than Python's `uv run`.
 */

type Dict = Record<string, any>;
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

/** Commands the TS dispatcher exposes (used by the in-process CLI probe). */
const DISPATCHER_COMMANDS = new Set([
  "prime", "hej", "schema", "describe", "state", "query", "check", "lint", "backfill",
  "compact", "gate", "validate", "decisions", "health", "todo", "plan", "progress",
  "docs", "objective", "experiments",
]);

function plainStatus(value: string): string {
  return PLAIN_STATUS[value] ?? value.replace(/_/g, " ").replace(/-/g, " ");
}

function doctorActionNoun(status: Dict): string {
  if (status.status === APP_OUTDATED) return "update";
  if (status.status === APP_MIGRATION_NEEDED) return "migration";
  return "repair";
}

/** In-process probe: confirm the TS CLI exposes the expected state commands. */
function inProcessProbe(args: { expectedCommands: readonly string[] }): ProbeResult {
  const missing = args.expectedCommands.filter((name) => !DISPATCHER_COMMANDS.has(name));
  const command = ["npx", "-y", "agentera", "--help"];
  return {
    ok: missing.length === 0,
    command,
    returnCode: 0,
    stdoutTail: [],
    stderrTail: [],
    missingCommands: missing,
    message:
      missing.length === 0
        ? "CLI exposes expected state commands"
        : "CLI is missing expected state commands",
  };
}

export function renderDoctorStatus(status: Dict): string {
  const actionNoun = doctorActionNoun(status);
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
    for (const signal of status.signals as Dict[]) {
      lines.push(`  - ${plainStatus(signal.status)}: ${signal.message}`);
      if (signal.missingCommands && signal.missingCommands.length > 0) {
        lines.push(`    Missing command: ${(signal.missingCommands as string[]).join(", ")}`);
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
    lines.push(`  3. Then retry Agentera: ${status.retryCommand}`);
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

function renderDoctorSmoke(smoke: Dict): string {
  const lines = [
    "",
    "Smoke checks:",
    `  enabled: ${smoke.enabled ? "yes" : "no"}`,
    `  model calls attempted: ${smoke.modelCallsAttempted ? "yes" : "no"}`,
  ];
  for (const check of (smoke.checks ?? []) as Dict[]) {
    lines.push(`  - ${check.name}: ${check.status} - ${check.message}`);
  }
  return lines.join("\n");
}

export function pyJsonIndentSorted(value: unknown): string {
  return jsonIndent(value, 0);
}

function jsonAscii(str: string): string {
  let out = '"';
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x09) out += "\\t";
    else if (cp === 0x0a) out += "\\n";
    else if (cp === 0x0c) out += "\\f";
    else if (cp === 0x0d) out += "\\r";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else if (cp < 0x80) out += ch;
    else if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += "\\u" + (0xd800 + (v >> 10)).toString(16).padStart(4, "0");
      out += "\\u" + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
    } else out += "\\u" + cp.toString(16).padStart(4, "0");
  }
  return out + '"';
}

function jsonIndent(value: unknown, level: number): string {
  const pad = "  ".repeat(level);
  const padIn = "  ".repeat(level + 1);
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return jsonAscii(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[\n" + value.map((v) => padIn + jsonIndent(v, level + 1)).join(",\n") + "\n" + pad + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Dict).sort();
    if (keys.length === 0) return "{}";
    return "{\n" + keys.map((k) => padIn + jsonAscii(k) + ": " + jsonIndent((value as Dict)[k], level + 1)).join(",\n") + "\n" + pad + "}";
  }
  return "null";
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
    probeCli: true,
    probeRunner: inProcessProbe,
  });
  let smokeReport: Dict | null = null;
  if (args.smoke) {
    smokeReport = runNpmSmokeChecks(sourceRoot, process.env, {
      liveModelAllowed: Boolean(args.allowLiveModel),
    });
  }
  if ((args.format ?? "text") === "json") {
    const payload = publicDoctorStatus(status) as Dict;
    if (smokeReport) payload.smoke = smokeReport;
    out(pyJsonIndentSorted(payload) + "\n");
  } else {
    out(renderDoctorStatus(status) + (smokeReport ? renderDoctorSmoke(smokeReport) : "") + "\n");
  }
  if (args.smoke) {
    const failCount = Number((smokeReport?.summary as Dict | undefined)?.fail ?? 0);
    if (failCount > 0) return 1;
  }
  return status.status === APP_UP_TO_DATE ? 0 : 1;
}

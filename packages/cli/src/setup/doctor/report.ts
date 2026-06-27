import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expanduser, pathExists, resolvePath } from "../../core/paths.js";
import { pyJsonIndentSorted } from "../../core/pyjson.js";
import { planChange as codexPlanChange } from "../codex.js";
import type { Outcome } from "../codex/state.js";
import { resolveSourceRootStrict } from "../../upgrade/appModel.js";
import { runNpmSmokeChecks } from "../smokeChecks.js";
import type { JsonObject } from "../../core/jsonValue.js";
import {
  SCHEMA_VERSION,
  STATUSES,
  RUNTIMES,
  INSTALLER_SCHEMA_VERSION,
  INSTALLER_FIXABLE_GAPS,
  WARN_STATUSES,
  FAIL_STATUSES,
  mkCheck,
  summarizeStatuses,
  classifyInstallRoot,
  runtimeResult,
} from "./core.js";
import { smokeCheck } from "./opencode.js";
import { CODEX_HOME_CHECK, CODEX_RUNTIME_CONFIG_GAP, DIAGNOSTICS } from "./diagnostics.js";

type Env = Record<string, string | undefined>;

export function pyJsonIndent(value: unknown, level = 0): string {
  return pyJsonIndentSorted(value, 2, level);
}

function summarize(runtimes: Record<string, JsonObject>): Record<string, number> {
  return summarizeStatuses(runtimes);
}

export interface BuildReportOptions {
  installRoot?: string | null;
  home?: string | null;
  env?: Env | null;
  runtimes?: string[];
  runSmoke?: boolean;
  liveModelAllowed?: boolean;
}

export function buildReport(opts: BuildReportOptions = {}): JsonObject {
  const runtimes = opts.runtimes ?? RUNTIMES;
  const liveModelAllowed = opts.liveModelAllowed ?? false;
  const sourceEnv: Env = { ...(opts.env ?? process.env) };
  const rootReport = classifyInstallRoot(opts.installRoot ?? null, sourceEnv);
  const rootPath = rootReport.path ? (rootReport.path as string) : null;
  const homePath = resolvePath(expanduser(opts.home ?? os.homedir()));

  const runtimeReports: Record<string, JsonObject> = {};
  if (rootPath === null || rootReport.status === "fail") {
    for (const runtime of runtimes) {
      runtimeReports[runtime] = runtimeResult(runtime, sourceEnv, [
        mkCheck("install_root", "fail", "runtime diagnosis requires a valid Agentera install root", {
          gap: rootReport.gap as string | null,
          details: rootReport.missing as string[] | null,
        }),
      ]);
    }
  } else {
    for (const runtime of runtimes) {
      runtimeReports[runtime] = DIAGNOSTICS[runtime](rootPath, homePath, sourceEnv);
    }
  }

  const summaryCounts = summarize(runtimeReports);
  const emptySummary: Record<string, number> = {};
  for (const status of STATUSES) emptySummary[status] = 0;
  let smokeReport: JsonObject = {
    enabled: false,
    liveModelAllowed,
    modelCallsAttempted: false,
    summary: emptySummary,
    checks: [],
  };
  if (opts.runSmoke) {
    try {
      const sourceRoot = resolveSourceRootStrict(sourceEnv);
      smokeReport = runNpmSmokeChecks(sourceRoot, sourceEnv, {
        liveModelAllowed,
        runtimes,
      });
    } catch (exc) {
      smokeReport = {
        enabled: true,
        liveModelAllowed,
        modelCallsAttempted: false,
        summary: { ...emptySummary, fail: 1 },
        checks: [
          smokeCheck("source_root", "helper", "fail", (exc as Error).message, {
            details: ["resolveSourceRootStrict"],
          }),
        ],
      };
    }
  }

  const ok = rootReport.status !== "fail" && summaryCounts.fail === 0 && (smokeReport.summary as JsonObject).fail === 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    ok,
    installRoot: rootReport,
    runtimes: runtimeReports,
    summary: summaryCounts,
    smoke: smokeReport,
  };
}

export function renderHuman(report: JsonObject): string {
  const installRoot = report.installRoot as JsonObject;
  const lines = [
    "Agentera setup doctor",
    `install root: ${installRoot.status} - ${installRoot.message}`,
  ];
  if (installRoot.path) lines.push(`  path: ${installRoot.path}`);
  const missing = installRoot.missing as string[] | null;
  if (missing && missing.length > 0) {
    lines.push("  missing: " + missing.join(", "));
  }
  for (const [runtime, result] of Object.entries(report.runtimes as Record<string, JsonObject>)) {
    lines.push(`${runtime}: ${result.status}`);
    for (const check of result.checks as JsonObject[]) {
      const suffix = check.gap ? ` [${check.gap}]` : "";
      lines.push(`  - ${check.name}: ${check.status} - ${check.message}${suffix}`);
      if (check.path) lines.push(`    path: ${check.path}`);
      const details = check.details as string[];
      if (details && details.length > 0) lines.push("    details: " + details.join(", "));
    }
  }
  const smoke = (report.smoke ?? {}) as JsonObject;
  if (smoke.enabled) {
    lines.push("smoke: enabled");
    lines.push(`  model calls attempted: ${pyBool(smoke.modelCallsAttempted)}`);
    for (const check of (smoke.checks ?? []) as JsonObject[]) {
      lines.push(`  - ${check.name}: ${check.status} - ${check.message} [${check.category}]`);
      if (check.path) lines.push(`    path: ${check.path}`);
      const details = check.details as string[];
      if (details && details.length > 0) lines.push("    details: " + details.join(", "));
    }
  }
  return lines.join("\n");
}

function pyBool(value: unknown): string {
  return value ? "True" : "False";
}

export function renderInstaller(installer: JsonObject): string {
  const lines = ["Agentera setup installer", `status: ${installer.message}`];
  if (!installer.changes || (installer.changes as JsonObject[]).length === 0) return lines.join("\n");
  for (const change of installer.changes as JsonObject[]) {
    lines.push(`${change.runtime}: ${change.status}`);
    lines.push(`  target: ${change.target || "(none)"}`);
    lines.push(`  reason: ${change.reason}`);
    lines.push(`  action: ${change.action} - ${change.message}`);
  }
  if (installer.afterDoctor !== null && installer.afterDoctor !== undefined) {
    const after = installer.afterDoctor as JsonObject;
    lines.push(
      `doctor after install: ${after.ok ? "pass" : "fail"} (summary: ${pyJsonObject(after.summary as Record<string, unknown>)})`,
    );
  } else if ((installer.summary as JsonObject).pending && !installer.dryRun) {
    lines.push("confirmation required: re-run with --yes to apply these changes");
  }
  return lines.join("\n");
}

/** Python str(dict) repr for the summary line. */
function pyJsonObject(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(([k, v]) => `'${k}': ${typeof v === "string" ? `'${v}'` : v}`);
  return "{" + parts.join(", ") + "}";
}

export function publicInstaller(installer: JsonObject | null): JsonObject | null {
  if (installer === null) return null;
  const pub: JsonObject = { ...installer };
  pub.changes = (installer.changes as JsonObject[]).map((change) => {
    const c: JsonObject = {};
    for (const [key, value] of Object.entries(change)) {
      if (key !== "newText" && key !== "diff") c[key] = value;
    }
    return c;
  });
  return pub;
}

// ── installer ───────────────────────────────────────────────────────

function installerChange(opts: {
  runtime: string;
  target: string | null;
  reason: string;
  status: string;
  action: string;
  message: string;
  newText?: string;
  diff?: string;
}): JsonObject {
  return {
    runtime: opts.runtime,
    target: opts.target,
    reason: opts.reason,
    status: opts.status,
    action: opts.action,
    message: opts.message,
    newText: opts.newText ?? "",
    diff: opts.diff ?? "",
  };
}

function fixableReason(runtimeReport: JsonObject, checkName: string, gaps: string[] | null = null): string | null {
  if (!runtimeReport.available) return null;
  const runtime = String(runtimeReport.runtime ?? "");
  const fixableGaps = gaps ?? INSTALLER_FIXABLE_GAPS[runtime] ?? [];
  for (const check of (runtimeReport.checks ?? []) as JsonObject[]) {
    if (check.name !== checkName) continue;
    if (check.status !== WARN_STATUSES[runtime] && check.status !== FAIL_STATUSES[runtime]) continue;
    if (!fixableGaps.includes(check.gap as string)) continue;
    return String(check.message || "doctor found a fixable setup gap");
  }
  return null;
}

function planCodexInstallerChange(installRoot: string, home: string, runtimeReport: JsonObject): JsonObject | null {
  const reason = fixableReason(runtimeReport, CODEX_HOME_CHECK, [CODEX_RUNTIME_CONFIG_GAP]);
  if (reason === null) return null;
  const target = path.join(home, ".codex", "config.toml");
  let outcome: Outcome;
  try {
    const currentText = pathExists(target) ? fs.readFileSync(target, "utf8") : null;
    outcome = codexPlanChange(currentText, installRoot, { force: false });
  } catch (exc) {
    return installerChange({
      runtime: "codex",
      target,
      reason,
      status: "blocked",
      action: "blocked",
      message: `cannot safely plan Codex config change: ${(exc as Error).message}`,
    });
  }
  if (outcome.action === "noop") {
    return installerChange({ runtime: "codex", target, reason, status: "noop", action: outcome.action, message: outcome.message });
  }
  if (outcome.action === "conflict") {
    return installerChange({
      runtime: "codex",
      target,
      reason,
      status: "blocked",
      action: outcome.action,
      message: outcome.message,
      diff: outcome.diff,
    });
  }
  return installerChange({
    runtime: "codex",
    target,
    reason,
    status: "pending",
    action: outcome.action,
    message: outcome.message,
    newText: outcome.newText,
    diff: outcome.diff,
  });
}

function planCopilotInstallerChange(): JsonObject | null {
  return null;
}

function summarizeInstaller(changes: JsonObject[]): Record<string, number> {
  const statuses = ["pending", "applied", "noop", "blocked", "failed"];
  const summary: Record<string, number> = {};
  for (const status of statuses) summary[status] = 0;
  for (const change of changes) summary[change.status as string] += 1;
  return summary;
}

export function buildInstallerPlan(
  report: JsonObject,
  opts: { home: string; env: Env; runtimes: string[]; confirmed: boolean; dryRun: boolean },
): JsonObject {
  const changes: JsonObject[] = [];
  const installRootJsonObject = report.installRoot as JsonObject | null;
  const rootPath = installRootJsonObject?.path as string | null | undefined;
  if (!rootPath || installRootJsonObject?.status === "fail") {
    return {
      schemaVersion: INSTALLER_SCHEMA_VERSION,
      confirmed: opts.confirmed,
      dryRun: opts.dryRun,
      changes,
      summary: summarizeInstaller(changes),
      afterDoctor: null,
      message: "installer requires a valid Agentera install root",
    };
  }
  const installRoot = rootPath as string;
  for (const runtime of opts.runtimes) {
    const runtimeReport = (report.runtimes as JsonObject)[runtime] as JsonObject;
    let change: JsonObject | null = null;
    if (runtime === "codex") change = planCodexInstallerChange(installRoot, opts.home, runtimeReport);
    else if (runtime === "copilot") change = planCopilotInstallerChange();
    if (change !== null) changes.push(change);
  }
  return {
    schemaVersion: INSTALLER_SCHEMA_VERSION,
    confirmed: opts.confirmed,
    dryRun: opts.dryRun,
    changes,
    summary: summarizeInstaller(changes),
    afterDoctor: null,
    message: changes.length === 0 ? "no installer changes needed" : "installer changes planned",
  };
}

export function applyInstallerPlan(plan: JsonObject): void {
  for (const change of plan.changes as JsonObject[]) {
    if (change.status !== "pending") continue;
    const target = change.target as string;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, change.newText as string, "utf8");
    } catch (exc) {
      change.status = "failed";
      change.message = `error writing ${target}: ${(exc as Error).message}`;
      continue;
    }
    change.status = "applied";
    change.message = `wrote ${target}: ${String(change.message).replaceAll("would ", "")}`;
  }
  plan.summary = summarizeInstaller(plan.changes as JsonObject[]);
}

// ── CLI ─────────────────────────────────────────────────────────────

export interface DoctorCliIo {
  out?: (text: string) => void;
  err?: (text: string) => void;
  env?: Env;
}

export function doctorMain(argv: string[] = [], io: DoctorCliIo = {}): number {
  const writeOut = io.out ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.err ?? ((text: string) => process.stderr.write(text));
  const out = (line: string) => writeOut(line + "\n");
  const env = io.env ?? process.env;

  const args = {
    installRoot: null as string | null,
    home: null as string | null,
    runtime: [] as string[],
    smoke: false,
    install: false,
    yes: false,
    dryRun: false,
    allowLiveModel: false,
    json: false,
  };

  const valueFlag = (a: string, name: string): string | null => {
    if (a === name) return "__NEXT__";
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null;
    if ((v = valueFlag(a, "--install-root")) !== null) args.installRoot = v === "__NEXT__" ? argv[++i] : v;
    else if ((v = valueFlag(a, "--home")) !== null) args.home = v === "__NEXT__" ? argv[++i] : v;
    else if ((v = valueFlag(a, "--runtime")) !== null) {
      const rt = v === "__NEXT__" ? argv[++i] : v;
      if (!RUNTIMES.includes(rt)) {
        writeErr(`setup_doctor: error: argument --runtime: invalid choice: '${rt}'\n`);
        return 2;
      }
      args.runtime.push(rt);
    } else if (a === "--smoke") args.smoke = true;
    else if (a === "--install") args.install = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--allow-live-model") args.allowLiveModel = true;
    else if (a === "--json") args.json = true;
    else {
      writeErr(`setup_doctor: error: unrecognized arguments: ${a}\n`);
      return 2;
    }
  }

  if (args.yes && !args.install) {
    writeErr("setup_doctor: error: --yes requires --install\n");
    return 2;
  }
  if (args.dryRun && !args.install) {
    writeErr("setup_doctor: error: --dry-run requires --install\n");
    return 2;
  }

  const runtimes = args.runtime.length > 0 ? args.runtime : RUNTIMES;
  const sourceEnv: Env = { ...env };
  const home = resolvePath(expanduser(args.home ?? os.homedir()));
  const report = buildReport({
    installRoot: args.installRoot,
    home,
    env: sourceEnv,
    runtimes,
    runSmoke: args.smoke,
    liveModelAllowed: args.allowLiveModel,
  });

  let installer: JsonObject | null = null;
  if (args.install) {
    installer = buildInstallerPlan(report, {
      home,
      env: sourceEnv,
      runtimes,
      confirmed: args.yes,
      dryRun: args.dryRun,
    });
    if (args.yes) {
      applyInstallerPlan(installer);
      installer.afterDoctor = buildReport({
        installRoot: args.installRoot,
        home,
        env: sourceEnv,
        runtimes,
        runSmoke: args.smoke,
        liveModelAllowed: args.allowLiveModel,
      });
    }
  }

  if (args.json) {
    const payload = installer !== null ? { doctor: report, installer: publicInstaller(installer) } : report;
    out(pyJsonIndent(payload));
  } else {
    out(renderHuman(report));
    if (installer !== null) {
      out("");
      out(renderInstaller(installer));
    }
  }

  if (installer === null) return report.ok ? 0 : 1;
  const summary = installer.summary as JsonObject;
  if (summary.failed || summary.blocked) return 1;
  if (summary.pending && !args.dryRun && !args.yes) return 1;
  const afterDoctor = installer.afterDoctor as JsonObject | null;
  if (afterDoctor !== null && afterDoctor !== undefined && !afterDoctor.ok) return 1;
  if (!report.ok && !(summary.pending || summary.applied)) return 1;
  return 0;
}

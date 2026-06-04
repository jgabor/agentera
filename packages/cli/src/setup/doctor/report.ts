import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expanduser, pathExists, resolvePath } from "../../core/paths.js";
import { planChange as codexPlanChange } from "../codex.js";
import { resolveSourceRootStrict } from "../../upgrade/appModel.js";
import { runNpmSmokeChecks } from "../smokeChecks.js";
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

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

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

export function pyJsonIndent(value: unknown, level = 0): string {
  const pad = "  ".repeat(level);
  const padIn = "  ".repeat(level + 1);
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === "string") return jsonAscii(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => padIn + pyJsonIndent(v, level + 1));
    return "[\n" + items.join(",\n") + "\n" + pad + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Dict).sort();
    if (keys.length === 0) return "{}";
    const items = keys.map((k) => padIn + jsonAscii(k) + ": " + pyJsonIndent((value as Dict)[k], level + 1));
    return "{\n" + items.join(",\n") + "\n" + pad + "}";
  }
  return "null";
}

function summarize(runtimes: Record<string, Dict>): Record<string, number> {
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

export function buildReport(opts: BuildReportOptions = {}): Dict {
  const runtimes = opts.runtimes ?? RUNTIMES;
  const liveModelAllowed = opts.liveModelAllowed ?? false;
  const sourceEnv: Env = { ...(opts.env ?? process.env) };
  const rootReport = classifyInstallRoot(opts.installRoot ?? null, sourceEnv);
  const rootPath = rootReport.path ? (rootReport.path as string) : null;
  const homePath = resolvePath(expanduser(opts.home ?? os.homedir()));

  const runtimeReports: Record<string, Dict> = {};
  if (rootPath === null || rootReport.status === "fail") {
    for (const runtime of runtimes) {
      runtimeReports[runtime] = runtimeResult(runtime, sourceEnv, [
        mkCheck("install_root", "fail", "runtime diagnosis requires a valid Agentera install root", {
          gap: rootReport.gap,
          details: rootReport.missing,
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
  let smokeReport: Dict = {
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

  const ok = rootReport.status !== "fail" && summaryCounts.fail === 0 && (smokeReport.summary as Dict).fail === 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    ok,
    installRoot: rootReport,
    runtimes: runtimeReports,
    summary: summaryCounts,
    smoke: smokeReport,
  };
}

export function renderHuman(report: Dict): string {
  const lines = [
    "Agentera setup doctor",
    `install root: ${report.installRoot.status} - ${report.installRoot.message}`,
  ];
  if (report.installRoot.path) lines.push(`  path: ${report.installRoot.path}`);
  if (report.installRoot.missing && report.installRoot.missing.length > 0) {
    lines.push("  missing: " + report.installRoot.missing.join(", "));
  }
  for (const [runtime, result] of Object.entries(report.runtimes as Record<string, Dict>)) {
    lines.push(`${runtime}: ${result.status}`);
    for (const check of result.checks as Dict[]) {
      const suffix = check.gap ? ` [${check.gap}]` : "";
      lines.push(`  - ${check.name}: ${check.status} - ${check.message}${suffix}`);
      if (check.path) lines.push(`    path: ${check.path}`);
      if (check.details && check.details.length > 0) lines.push("    details: " + check.details.join(", "));
    }
  }
  const smoke = report.smoke ?? {};
  if (smoke.enabled) {
    lines.push("smoke: enabled");
    lines.push(`  model calls attempted: ${pyBool(smoke.modelCallsAttempted)}`);
    for (const check of (smoke.checks ?? []) as Dict[]) {
      lines.push(`  - ${check.name}: ${check.status} - ${check.message} [${check.category}]`);
      if (check.path) lines.push(`    path: ${check.path}`);
      if (check.details && check.details.length > 0) lines.push("    details: " + check.details.join(", "));
    }
  }
  return lines.join("\n");
}

function pyBool(value: unknown): string {
  return value ? "True" : "False";
}

export function renderInstaller(installer: Dict): string {
  const lines = ["Agentera setup installer", `status: ${installer.message}`];
  if (!installer.changes || installer.changes.length === 0) return lines.join("\n");
  for (const change of installer.changes as Dict[]) {
    lines.push(`${change.runtime}: ${change.status}`);
    lines.push(`  target: ${change.target || "(none)"}`);
    lines.push(`  reason: ${change.reason}`);
    lines.push(`  action: ${change.action} - ${change.message}`);
  }
  if (installer.afterDoctor !== null && installer.afterDoctor !== undefined) {
    const after = installer.afterDoctor;
    lines.push(
      `doctor after install: ${after.ok ? "pass" : "fail"} (summary: ${pyDict(after.summary)})`,
    );
  } else if (installer.summary.pending && !installer.dryRun) {
    lines.push("confirmation required: re-run with --yes to apply these changes");
  }
  return lines.join("\n");
}

/** Python str(dict) repr for the summary line. */
function pyDict(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(([k, v]) => `'${k}': ${typeof v === "string" ? `'${v}'` : v}`);
  return "{" + parts.join(", ") + "}";
}

export function publicInstaller(installer: Dict | null): Dict | null {
  if (installer === null) return null;
  const pub: Dict = { ...installer };
  pub.changes = (installer.changes as Dict[]).map((change) => {
    const c: Dict = {};
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
}): Dict {
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

function fixableReason(runtimeReport: Dict, checkName: string, gaps: string[] | null = null): string | null {
  if (!runtimeReport.available) return null;
  const runtime = String(runtimeReport.runtime ?? "");
  const fixableGaps = gaps ?? INSTALLER_FIXABLE_GAPS[runtime] ?? [];
  for (const check of (runtimeReport.checks ?? []) as Dict[]) {
    if (check.name !== checkName) continue;
    if (check.status !== WARN_STATUSES[runtime] && check.status !== FAIL_STATUSES[runtime]) continue;
    if (!fixableGaps.includes(check.gap)) continue;
    return String(check.message || "doctor found a fixable setup gap");
  }
  return null;
}

function planCodexInstallerChange(installRoot: string, home: string, runtimeReport: Dict): Dict | null {
  const reason = fixableReason(runtimeReport, CODEX_HOME_CHECK, [CODEX_RUNTIME_CONFIG_GAP]);
  if (reason === null) return null;
  const target = path.join(home, ".codex", "config.toml");
  let outcome: Dict;
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

function planCopilotInstallerChange(): Dict | null {
  return null;
}

function summarizeInstaller(changes: Dict[]): Record<string, number> {
  const statuses = ["pending", "applied", "noop", "blocked", "failed"];
  const summary: Record<string, number> = {};
  for (const status of statuses) summary[status] = 0;
  for (const change of changes) summary[change.status] += 1;
  return summary;
}

export function buildInstallerPlan(
  report: Dict,
  opts: { home: string; env: Env; runtimes: string[]; confirmed: boolean; dryRun: boolean },
): Dict {
  const changes: Dict[] = [];
  const rootPath = report.installRoot?.path;
  if (!rootPath || report.installRoot?.status === "fail") {
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
    const runtimeReport = (report.runtimes as Dict)[runtime];
    let change: Dict | null = null;
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

export function applyInstallerPlan(plan: Dict): void {
  for (const change of plan.changes as Dict[]) {
    if (change.status !== "pending") continue;
    const target = change.target as string;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, change.newText, "utf8");
    } catch (exc) {
      change.status = "failed";
      change.message = `error writing ${target}: ${(exc as Error).message}`;
      continue;
    }
    change.status = "applied";
    change.message = `wrote ${target}: ${String(change.message).replaceAll("would ", "")}`;
  }
  plan.summary = summarizeInstaller(plan.changes as Dict[]);
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

  let installer: Dict | null = null;
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
  if (installer.summary.failed || installer.summary.blocked) return 1;
  if (installer.summary.pending && !args.dryRun && !args.yes) return 1;
  if (installer.afterDoctor !== null && installer.afterDoctor !== undefined && !installer.afterDoctor.ok) return 1;
  if (!report.ok && !(installer.summary.pending || installer.summary.applied)) return 1;
  return 0;
}

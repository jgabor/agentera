import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PRIME_BLOB } from "../prime-blob.js";
import { buildDoctorStatus, publicDoctorStatus } from "../../upgrade/doctor.js";
import { loadSuiteVersion, resolveDoctorInstallRoot, resolveSourceRootStrict } from "../../upgrade/appModel.js";
import { discoverSchemasDir, loadSchemas, SchemaInfo } from "../appContext.js";
import {
  activeObjectiveSummary,
  checkProfileraStaleness,
  decisionFollowUp,
  decisionReviewAttention,
  docsSummary,
  formatNextAction,
  healthSummary,
  issueCounts,
  loadTodoItems,
  planSummary,
  progressSummary,
  registryArtifactPath,
  selectHejNextAction,
  statePresence,
} from "../orientation.js";
import { firstPresent } from "../stateQuery.js";

/**
 * prime / hej orientation command. Port of scripts/agentera cmd_prime / cmd_hej.
 * The text briefing (default) and --guidance are wired; the JSON/dashboard/
 * context paths depend on the 5 bespoke capability contexts (pending slice).
 */

type Dict = Record<string, any>;
type Io = { out?: (t: string) => void; err?: (t: string) => void };
type Env = Record<string, string | undefined>;

const STARTUP_COMPLETENESS_MISSING_STATE: string[] = [];
const STARTUP_AVAILABLE_STATE_FIELDS = [
  "app_home", "mode", "profile", "v1_migration", "health", "issues", "plan", "docs", "progress",
  "objective", "state_presence", "attention", "decision_attention", "next_action",
  "orchestration_context", "closeout_context", "evidence_context", "benchmark_context", "execution_context",
];
const STARTUP_COMPLETENESS_CONFIDENCE_CAVEATS = [
  "representative benchmark evidence exists, but claude-code and github-copilot coverage is degraded by schema divergence",
  "Inspektera evidence context uses existing hej, plan, progress, docs, health, TODO, and decisions state outputs",
];
const STARTUP_COMPLETENESS_CLI_FALLBACK = [
  "agentera plan --format json",
  "agentera docs --format json",
  "agentera progress --format json",
];

const V1_ARTIFACT_PAIRS: Array<[string, string]> = [
  [".agentera/PROGRESS.md", ".agentera/progress.yaml"],
  [".agentera/PLAN.md", ".agentera/plan.yaml"],
  [".agentera/DECISIONS.md", ".agentera/decisions.yaml"],
  [".agentera/HEALTH.md", ".agentera/health.yaml"],
  [".agentera/DOCS.md", ".agentera/docs.yaml"],
  ["VISION.md", ".agentera/vision.yaml"],
];

function startupCompletenessContract(): Dict {
  const complete = STARTUP_COMPLETENESS_MISSING_STATE.length === 0;
  return {
    complete_for_capability_startup: complete,
    raw_artifact_reads_required: false,
    raw_artifact_read_policy:
      "Do not read raw artifacts when complete_for_capability_startup is true. " +
      "When incomplete, try cli_fallback first; raw artifact reads are only a last-resort fallback.",
    available_state: STARTUP_AVAILABLE_STATE_FIELDS,
    missing_state: STARTUP_COMPLETENESS_MISSING_STATE,
    confidence_caveats: STARTUP_COMPLETENESS_CONFIDENCE_CAVEATS,
    cli_fallback: STARTUP_COMPLETENESS_CLI_FALLBACK,
  };
}

function isLocalCheckout(root: string): boolean {
  return ["scripts/agentera", "skills/agentera/SKILL.md", "registry.json"].every((rel) =>
    fs.existsSync(path.join(root, rel)),
  );
}

function detectV1Artifacts(): string[] {
  const root = process.cwd();
  const found: string[] = [];
  for (const [md, yaml] of V1_ARTIFACT_PAIRS) {
    if (fs.existsSync(path.join(root, md)) && !fs.existsSync(path.join(root, yaml))) found.push(md);
  }
  return found;
}

function v1MigrationSummary(v1Artifacts: string[]): Dict {
  const dryRun = 'uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run';
  const apply = 'uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --yes';
  const detected = v1Artifacts.length > 0;
  const summary: Dict = {
    detected,
    affected_files: v1Artifacts,
    dry_run_command: detected ? dryRun : null,
    apply_command: detected ? apply : null,
    requires_confirmation: detected,
  };
  if (detected && isLocalCheckout(process.cwd())) {
    summary.local_dry_run_command = 'uv run scripts/agentera upgrade --project "$PWD" --dry-run';
    summary.local_apply_command = 'uv run scripts/agentera upgrade --project "$PWD" --yes';
  }
  return summary;
}

function frontmatterVersion(p: string): string | null {
  let lines: string[];
  try {
    if (!fs.statSync(p).isFile()) return null;
    lines = fs.readFileSync(p, "utf8").split(/\r\n|\r|\n/);
  } catch {
    return null;
  }
  if (lines.length === 0 || lines[0].trim() !== "---") return null;
  for (const line of lines.slice(1)) {
    const stripped = line.trim();
    if (stripped === "---") return null;
    if (stripped.startsWith("version:")) {
      const version = stripped.split(":", 2)[1].trim().replace(/^["']|["']$/g, "");
      return version || null;
    }
  }
  return null;
}

function versionKey(version: string | null): number[] {
  if (!version) return [];
  const parts: number[] = [];
  for (const item of version.split(/[.+_-]/)) {
    if (/^\d+$/.test(item)) parts.push(parseInt(item, 10));
    else break;
  }
  return parts;
}

function versionKeyGe(a: number[], b: number[]): boolean {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return true;
}

function visibleSkillVersion(home: string, env: Env): [string | null, string | null] {
  const candidates: string[] = [];
  if (env.AGENTERA_VISIBLE_SKILL_ROOT) candidates.push(env.AGENTERA_VISIBLE_SKILL_ROOT);
  candidates.push(path.join(home, ".agents", "skills", "agentera"));
  candidates.push(path.join(home, ".config", "opencode", "skills", "agentera"));
  const versions: Array<[number[], string, string]> = [];
  for (const root of candidates) {
    const version = frontmatterVersion(path.join(root, "SKILL.md"));
    if (version) versions.push([versionKey(version), version, root]);
  }
  if (versions.length === 0) return [null, null];
  versions.sort((a, b) => (versionKeyGe(a[0], b[0]) ? -1 : 1));
  return [versions[0][1], versions[0][2]];
}

function hejExpectedVersion(opts: PrimeOpts, sourceRoot: string, home: string, env: Env): [string | null, string] {
  if (opts.expectedVersion) return [opts.expectedVersion, "--expected-version"];
  if (env.AGENTERA_EXPECTED_VERSION) return [env.AGENTERA_EXPECTED_VERSION, "AGENTERA_EXPECTED_VERSION"];
  const sourceVersion = loadSuiteVersion(sourceRoot);
  const [visibleVersion, visibleSource] = visibleSkillVersion(home, env);
  if (visibleVersion && versionKeyGe(versionKey(visibleVersion), versionKey(sourceVersion))) {
    return [visibleVersion, visibleSource || "visible skill"];
  }
  return [sourceVersion, "source registry"];
}

interface PrimeOpts {
  home?: string | null;
  installRoot?: string | null;
  expectedVersion?: string | null;
  env?: Env;
}

function hejBundleStatus(opts: PrimeOpts): Dict {
  const env = opts.env ?? process.env;
  const home = opts.home ? opts.home : os.homedir();
  const sourceRoot = resolveSourceRootStrict(env);
  const [installRoot, rootSource] = resolveDoctorInstallRoot(opts.installRoot ?? null, {
    home,
    env,
    sourceRoot,
  });
  const [expected, expectedSource] = hejExpectedVersion(opts, sourceRoot, home, env);
  const status = buildDoctorStatus(installRoot, {
    rootSource,
    sourceRoot,
    home,
    project: process.cwd(),
    expectedVersion: expected,
    expectedCommands: ["prime"],
    probeCli: false,
  });
  status.expectedVersionSource = expectedSource;
  return status;
}

function appStatusAttention(bundle: Dict): string {
  if (bundle.status === "outdated") {
    return (
      `normal: app files outdated; run agentera upgrade (preview: ` +
      `\`${bundle.dryRunCommand}\`); app_home=${bundle.appHome}`
    );
  }
  if (bundle.dryRunCommand) {
    const label = String(bundle.status).replace(/_/g, " ");
    return `degraded: app ${label}; preview \`${bundle.dryRunCommand}\`; app_home=${bundle.appHome}`;
  }
  return (
    `critical: app ${String(bundle.status).replace(/_/g, " ")}; fix AGENTERA_HOME or choose a managed app home; ` +
    `app_home=${bundle.appHome}`
  );
}

const TODO_SEVERITY_ORDER: Record<string, number> = {
  critical: 0, degraded: 1, warning: 1, normal: 2, info: 3, annoying: 3,
};

export function collectOrientationState(opts: PrimeOpts): Dict {
  const env = opts.env ?? process.env;
  const schemasDir = discoverSchemasDir();
  const schemas = loadSchemas(schemasDir);
  const bundle = hejBundleStatus(opts);
  let savedContext = false;
  try {
    savedContext = fs.readdirSync(path.join(process.cwd(), ".agentera")).some((f) => f.endsWith(".yaml"));
  } catch {
    savedContext = false;
  }
  const mode = savedContext ? "returning" : "fresh";
  const profile = registryArtifactPath("profile", schemasDir);
  const profileExists = fs.existsSync(profile);
  const profileStatus = profileExists ? "loaded" : "not found";
  const profileStaleness = profileExists ? checkProfileraStaleness(profile, env) : null;
  const profileDict: Dict = { status: profileStatus, path: profile };
  if (profileStatus === "not found") profileDict.suggested_action = "Run profilera to generate PROFILE.md";
  if (profileStaleness !== null) {
    const [isStale, daysSince, staleDays] = profileStaleness;
    profileDict.days_since_generated = daysSince;
    profileDict.stale = isStale;
    profileDict.stale_threshold_days = staleDays;
    if (isStale) profileDict.suggested_action = "Run profilera to refresh PROFILE.md";
  }
  const v1Artifacts = detectV1Artifacts();
  const v1Migration = v1MigrationSummary(v1Artifacts);
  const plan = planSummary(schemas);
  const docs = docsSummary(schemas);
  const progress = progressSummary(schemas);
  const health = healthSummary(schemas, env);
  const objective = activeObjectiveSummary();
  const presence = statePresence(plan, docs, progress, health, objective);
  const todoItems = loadTodoItems(schemas);
  const counts = issueCounts(todoItems);
  const decision = decisionFollowUp(schemas);
  const decisionAttention = decisionReviewAttention(schemas);
  const nextAction = selectHejNextAction(plan, health, objective, todoItems, decision, savedContext);

  const attention: string[] = [];
  if (bundle.status !== "up_to_date") attention.push(appStatusAttention(bundle));
  if (v1Migration.detected) {
    attention.push(
      `degraded: v1 artifacts detected; preview \`${v1Migration.dry_run_command}\`; files=${v1Artifacts.join(", ")}`,
    );
  }
  if (profileStatus === "not found") {
    attention.push(
      `degraded: PROFILE.md not found at ${profile}; suggest running profilera to generate PROFILE.md`,
    );
  } else if (profileStaleness !== null && profileStaleness[0]) {
    const [, daysSince, staleDays] = profileStaleness;
    attention.push(
      `normal: profilera profile stale (${daysSince} days since generated; ` +
        `threshold=${staleDays}); suggest running profilera to refresh PROFILE.md`,
    );
  }
  if (health.stale) {
    const auditNumber = health.number ?? "?";
    const daysSince = health.days_since_audit ?? "?";
    const thresholdDays = health.stale_threshold_days ?? "?";
    const thresholdCycles = health.stale_threshold_cycles ?? "?";
    let attentionText =
      `normal: inspektera audit stale (${daysSince} days since Audit ${auditNumber}; ` +
      `threshold days=${thresholdDays}, cycles=${thresholdCycles}`;
    const cyclesSince = health.cycles_since_audit;
    if (cyclesSince !== null && cyclesSince !== undefined) attentionText += `; ${cyclesSince} cycles since audit`;
    attention.push(`${attentionText}); suggest running inspektera`);
  }
  if (health.degrading) {
    const worst = health.worst;
    attention.push(
      worst ? `critical: health needs attention (${worst[0]}:${worst[1]})` : "critical: health is degrading",
    );
  }
  const pending = plan.first_pending;
  if (pending && typeof pending === "object" && !Array.isArray(pending)) {
    const title = firstPresent(pending, ["name", "title"], "pending task");
    attention.push(`normal: PLAN Task ${pending.number ?? "?"}: ${title}`);
  }
  if (decisionAttention !== null) attention.push(String(decisionAttention.attention));
  if (!(pending && typeof pending === "object" && !Array.isArray(pending)) && todoItems.length > 0) {
    const firstTodo = [...todoItems].sort(
      (a, b) => (TODO_SEVERITY_ORDER[a.severity] ?? 2) - (TODO_SEVERITY_ORDER[b.severity] ?? 2),
    )[0];
    attention.push(`${firstTodo.severity}: TODO: ${firstTodo.text}`);
  }

  return {
    schemas_dir: schemasDir,
    schemas,
    bundle,
    mode,
    profile_dict: profileDict,
    profile_status: profileStatus,
    profile,
    v1_migration: v1Migration,
    plan,
    docs,
    progress,
    health,
    objective,
    state_presence: presence,
    todo_items: todoItems,
    counts,
    decision_attention: decisionAttention,
    next_action: nextAction,
    attention,
  };
}

function printOrientationTextBriefing(state: Dict, command: string, out: (t: string) => void): void {
  const bundle = state.bundle;
  const mode = state.mode;
  const profileStatus = state.profile_status;
  const profile = state.profile;
  const health = state.health;
  const counts = state.counts;
  const plan = state.plan;
  const objective = state.objective;
  const presence = state.state_presence;
  const attention = state.attention as string[];
  const nextAction = state.next_action;
  const dashboardLabel = command === "prime" ? "prime orientation dashboard" : "hej dashboard";

  out(`agentera ${command}\n`);
  out(
    `app_home: status=${bundle.status} | home=${bundle.appHome} | ` +
      `source=${bundle.appHomeSource} | managed_app=${bundle.managedAppRoot} | user_data=${bundle.userDataRoot} | expected=${bundle.expectedVersion} | ` +
      `expected_source=${bundle.expectedVersionSource ?? "-"} | current=${bundle.markerVersion || "-"}\n`,
  );
  out(`mode: ${mode}\n`);
  out(`profile: ${profileStatus} | path=${profile}\n`);
  if (health.exists) {
    const worst = health.worst;
    const worstText = worst ? `${worst[0]}:${worst[1]}` : "none";
    out(
      `health: audit=${health.number} | grade=${health.grade || "unknown"} | ` +
        `trajectory=${health.trajectory || "unknown"} | worst=${worstText}\n`,
    );
  }
  out(`issues: critical=${counts.critical} | degraded=${counts.degraded} | normal=${counts.normal} | annoying=${counts.annoying}\n`);
  if (!presence.any_active) {
    const missing = Object.keys(presence.absence).sort().join(", ") || "none";
    out(`state: no active plan or objective | missing=${missing}\n`);
  }
  if (plan.exists && !plan.complete_plan) {
    out(`plan: status=${plan.status || "unknown"} | progress=${plan.complete ?? 0}/${plan.total ?? 0}\n`);
  }
  if (objective.active) {
    const target = objective.target ? ` | target=${objective.target}` : "";
    out(`objective: active | name=${objective.name} | metric=${objective.metric}${target}\n`);
  } else if (objective.exists) {
    out(`objective: none active | closed=${objective.closed_count ?? 0}\n`);
  } else {
    out("objective: none active\n");
  }
  if (attention.length > 0) {
    out("attention:\n");
    for (const item of attention.slice(0, 6)) out(`- ${item}\n`);
  }
  out("next_action:\n");
  out(`- ${formatNextAction(nextAction)}\n`);
  out("source_contract:\n");
  out(
    "- fields=app_home,mode,profile,v1_migration,health,issues,plan,docs,progress,objective,state_presence,attention,decision_attention,next_action,orchestration_context,closeout_context,evidence_context,benchmark_context,execution_context\n",
  );
  out(`- render=caller-owned README-style ${dashboardLabel}\n`);
  out("- access=single installed CLI call; app/v1/profile safety included; no preflight glob/read/import/doctor calls\n");
  const startup = startupCompletenessContract();
  out(`- capability_startup_complete=${String(startup.complete_for_capability_startup).toLowerCase()}\n`);
  out(
    `- raw_artifact_reads_required=${String(startup.raw_artifact_reads_required).toLowerCase()}; policy=${startup.raw_artifact_read_policy}\n`,
  );
  const missingState = (startup.missing_state as string[]).join("; ") || "none";
  out(`- missing_state=${missingState}\n`);
  out(`- confidence_caveats=${(startup.confidence_caveats as string[]).join("; ")}\n`);
  out(`- cli_fallback=${(startup.cli_fallback as string[]).join("; ")}\n`);
}

export interface PrimeArgs {
  command?: string;
  guidance?: boolean;
  context?: string | null;
  dashboard?: boolean;
  orientation?: boolean;
  format?: string;
  home?: string | null;
  installRoot?: string | null;
  expectedVersion?: string | null;
}

export function cmdPrime(args: PrimeArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const command = args.command ?? "prime";
  const capability = args.context ?? null;
  const dashboard = Boolean(args.dashboard || args.orientation);
  const guidance = Boolean(args.guidance);
  if (capability !== null && dashboard) {
    err("Error: prime --context and prime --dashboard/--orientation are mutually exclusive\n");
    return 2;
  }
  if (capability !== null && guidance) {
    err("Error: prime --context and prime --guidance are mutually exclusive\n");
    return 2;
  }
  if (dashboard && guidance) {
    err("Error: prime --dashboard/--orientation and prime --guidance are mutually exclusive\n");
    return 2;
  }
  if (guidance) {
    out(PRIME_BLOB);
    return 0;
  }
  const format = args.format ?? "text";
  if (capability !== null || dashboard || format !== "text") {
    err(
      "agentera: prime JSON/dashboard/context paths are not yet ported (pending the bespoke capability contexts)\n",
    );
    return 1;
  }
  const state = collectOrientationState({
    home: args.home,
    installRoot: args.installRoot,
    expectedVersion: args.expectedVersion,
  });
  printOrientationTextBriefing(state, command, out);
  return 0;
}

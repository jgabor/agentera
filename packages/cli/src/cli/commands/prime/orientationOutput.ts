import { publicDoctorStatus } from "../../../upgrade/doctor.js";
import { projectInstallTrack } from "../../../upgrade/compatibility.js";
import { formatNextAction } from "../../orientation.js";
import { requestedFields, REQUIRED_SPARSE_CONTEXT_FIELDS } from "../../stateQuery.js";
import { emitStructured } from "../../structured.js";
import type { JsonObject } from "../../../core/jsonValue.js";
import type { BundleStatus } from "../../contracts/bundleStatus.js";
import type { OrientationState } from "../../contracts/orientationState.js";
import { startupCompletenessContract } from "../../startupCompletenessContract.js";

export { startupCompletenessContract } from "../../startupCompletenessContract.js";

const HEJ_STRUCTURED_FIELDS = [
  "command", "status", "app_home", "app", "mode", "profile", "v1_migration", "health",
  "issues", "plan", "docs", "progress", "objective", "state_presence", "project_integration", "attention",
  "decision_attention", "next_action", "orchestration_context", "closeout_context",
  "evidence_context", "benchmark_context", "execution_context", "source", "source_contract",
];

function orientationAppHome(bundle: BundleStatus): JsonObject {
  return {
    install_track: projectInstallTrack(bundle.installKind),
    status: bundle.status,
    home: bundle.appHome,
    source: bundle.appHomeSource,
    managed_app_root: bundle.managedAppRoot,
    user_data_root: bundle.userDataRoot,
  };
}

export function buildOrientationJsonPayload(
  state: OrientationState,
  command: string,
): Record<string, unknown> {
  const bundle = state.app;
  const schemasDir = state.schemas_dir;
  const bundlePublic = publicDoctorStatus(bundle);
  const appHome = orientationAppHome(bundle);
  const bespoke: JsonObject = {
    orchestration_context: null,
    closeout_context: null,
    evidence_context: null,
    benchmark_context: null,
    execution_context: null,
  };
  const render =
    command === "hej"
      ? "caller-owned README-style prime orientation dashboard"
      : "caller-owned README-style prime orientation dashboard";
  const access =
    command === "hej"
      ? "single installed CLI call; app/v1/profile safety included; no preflight glob/read/import/doctor calls during normal prime"
      : "single installed CLI call; app/v1/profile safety included; no preflight glob/read/import/doctor calls during normal prime";
  return {
    command,
    status: "ok",
    app_home: appHome,
    app: bundlePublic,
    mode: state.mode,
    profile: state.profile_dict,
    v1_migration: state.v1_migration,
    project_integration: state.project_integration,
    health: state.health,
    issues: state.counts,
    plan: state.plan,
    docs: state.docs,
    progress: state.progress,
    objective: state.objective,
    state_presence: state.state_presence,
    attention: state.attention.slice(0, 6),
    decision_attention: state.decision_attention,
    next_action: state.next_action,
    orchestration_context: bespoke.orchestration_context,
    closeout_context: bespoke.closeout_context,
    evidence_context: bespoke.evidence_context,
    benchmark_context: bespoke.benchmark_context,
    execution_context: bespoke.execution_context,
    source: {
      schemas_dir: schemasDir,
      project: process.cwd(),
      artifacts_present: state.mode === "returning",
    },
    source_contract: {
      fields: HEJ_STRUCTURED_FIELDS,
      render,
      access,
      empty_state: "fresh mode with missing artifact summaries and zero issue counts",
      capability_startup: startupCompletenessContract(),
      capability_context: null,
    },
  };
}

function availablePrimeFields(command: string): string[] {
  if (command === "prime") return [...HEJ_STRUCTURED_FIELDS, "capability_context"];
  return HEJ_STRUCTURED_FIELDS;
}

export function emitPrime(
  command: string,
  payload: Record<string, unknown>,
  format: string,
  fieldsArg: string | null | undefined,
  out: (t: string) => void,
  err: (t: string) => void,
): number {
  const requested = requestedFields(fieldsArg);
  if (requested.length === 0) {
    emitStructured(payload, format, out);
    return 0;
  }
  const available = availablePrimeFields(command);
  const unsupported = requested.filter((f) => !available.includes(f));
  if (unsupported.length > 0) {
    err(`Error: unsupported field '${unsupported[0]}' for ${command}. Available fields: ${available.join(", ")}\n`);
    return 1;
  }
  const selected: Record<string, unknown> = {};
  for (const field of [...REQUIRED_SPARSE_CONTEXT_FIELDS, ...requested]) {
    if (field in payload && !(field in selected)) selected[field] = payload[field];
  }
  emitStructured(selected, format, out);
  return 0;
}

export function printOrientationTextBriefing(state: OrientationState, command: string, out: (t: string) => void): void {
  const bundle = state.app;
  const mode = state.mode;
  const profileStatus = state.profile_status;
  const profile = state.profile;
  const health = state.health;
  const counts = state.counts;
  const plan = state.plan;
  const objective = state.objective;
  const presence = state.state_presence;
  const attention = state.attention;
  const nextAction = state.next_action;
  const dashboardLabel = command === "prime" ? "prime orientation dashboard" : "prime orientation dashboard";

  out(`agentera ${command}\n`);
  out(
    `app_home: install_track=${projectInstallTrack(bundle.installKind)} | status=${bundle.status} | home=${bundle.appHome} | ` +
      `source=${bundle.appHomeSource} | managed_app=${bundle.managedAppRoot} | user_data=${bundle.userDataRoot} | expected=${bundle.expectedVersion} | ` +
      `expected_source=${bundle.expectedVersionSource ?? "-"} | current=${bundle.markerVersion || "-"}\n`,
  );
  out(`mode: ${mode}\n`);
  const projectIntegration = state.project_integration;
  out(
    `project_integration: recommendation=${projectIntegration.recommendation} | ` +
      `channel=${projectIntegration.update_channel} | pending_runtime=${projectIntegration.pending_runtime}\n`,
  );
  if (projectIntegration.recommendation === "upgrade" && projectIntegration.message) {
    out(`project_integration_message: ${projectIntegration.message}\n`);
  }
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
    "- fields=app_home,mode,profile,v1_migration,project_integration,health,issues,plan,docs,progress,objective,state_presence,attention,decision_attention,next_action,orchestration_context,closeout_context,evidence_context,benchmark_context,execution_context\n",
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

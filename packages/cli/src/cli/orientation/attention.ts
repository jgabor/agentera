import { projectIntegrationAttention } from "../../upgrade/projectIntegration.js";
import { isV2ManagedInstallAtAppHome } from "../../upgrade/coexistenceProbe.js";
import type { OrientationState } from "../contracts/orientationState.js";
import { corpusCoverageAttention } from "./corpusCoverage.js";
import { firstPresent } from "../stateQuery.js";
import { TODO_SEVERITY_ORDER } from "../todoSeverity.js";
import type { LifecycleActionClass } from "../../runtime/lifecycleAuthority.js";
import type {
  LifecycleProjectedAction,
  RuntimeLifecycleSnapshot,
} from "../../runtime/lifecycleSnapshot.js";

const MAX_LIFECYCLE_ATTENTION_ROWS = 2;
const MAX_LIFECYCLE_RUNTIME_NAMES = 3;
const MAX_MANUAL_PROCEDURE_WORDS = 12;
const DOCTOR_DIAGNOSTICS_COMMAND = "agentera doctor --format json";

function lifecycleRuntimeNames(
  snapshot: RuntimeLifecycleSnapshot,
  actions: LifecycleProjectedAction[],
): string {
  const namesById = new Map(snapshot.runtimes.map((runtime) => [runtime.runtimeId, runtime.displayName]));
  const runtimeIds = [...new Set(actions.flatMap((action) => action.runtimeIds))];
  const names = runtimeIds.map((runtimeId) => namesById.get(runtimeId) ?? runtimeId);
  const visible = names.slice(0, MAX_LIFECYCLE_RUNTIME_NAMES);
  const omitted = names.length - visible.length;
  return omitted > 0 ? `${visible.join(", ")}, +${omitted} more runtimes` : visible.join(", ");
}

function actionClassSummary(actions: LifecycleProjectedAction[]): string {
  const counts = new Map<LifecycleActionClass, number>();
  for (const action of actions) counts.set(action.actionClass, (counts.get(action.actionClass) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([actionClass, count]) => `${count} ${actionClass}`)
    .join(", ");
}

function boundProcedure(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= MAX_MANUAL_PROCEDURE_WORDS) return words.join(" ");
  return `${words.slice(0, MAX_MANUAL_PROCEDURE_WORDS - 1).join(" ")}…`;
}

function firstManualProcedure(actions: LifecycleProjectedAction[]): string | null {
  const procedures = [
    ...new Set(
      actions
        .filter((action) => action.actionClass === "manual_verification")
        .sort((left, right) => {
          const leftHasCommand = left.manual?.command !== null && left.manual?.command !== undefined;
          const rightHasCommand = right.manual?.command !== null && right.manual?.command !== undefined;
          return Number(rightHasCommand) - Number(leftHasCommand);
        })
        .map((action) => {
          const manual = action.manual;
          if (!manual) return boundProcedure(action.reason);
          const command = Array.isArray(manual.command) ? manual.command.join(" ") : manual.command;
          const instruction = boundProcedure(manual.instruction);
          return command ? `${command}: ${instruction}` : instruction;
        })
        .filter((procedure) => procedure.trim().length > 0),
    ),
  ];
  return procedures[0] ?? null;
}

function combinedLifecycleAttentionRow(
  state: OrientationState,
  snapshot: RuntimeLifecycleSnapshot,
  repairable: LifecycleProjectedAction[],
  blockers: LifecycleProjectedAction[],
): string {
  const actions = [...repairable, ...blockers];
  const classes = [
    ...(repairable.length > 0 ? ["repairable_owned"] : []),
    ...[...new Set(blockers.map((action) => action.actionClass))].sort(),
  ].join("+");
  const preview = repairable.length > 0 && state.project_integration.dry_run_command
    ? ` | preview=\`${state.project_integration.dry_run_command}\``
    : "";
  const procedure = firstManualProcedure(blockers);
  const procedureText = procedure ? ` | procedure=${procedure}` : "";
  const doctorText = blockers.some((action) => action.actionClass === "unobservable_gap")
    ? ` | doctor=\`${DOCTOR_DIAGNOSTICS_COMMAND}\``
    : "";
  return (
    `${blockers.length > 0 ? "degraded" : "normal"}: lifecycle action_class=${classes} | ` +
    `runtimes=${lifecycleRuntimeNames(snapshot, actions)} | actions=${actionClassSummary(actions)}` +
    `${preview}${procedureText}${doctorText}`
  );
}

function lifecycleAttentionRows(state: OrientationState, maxRows = MAX_LIFECYCLE_ATTENTION_ROWS): string[] {
  const snapshot = state.runtime_lifecycle_snapshot;
  if (!snapshot || snapshot.actions.length === 0) return [];

  const repairable = snapshot.actions.filter((action) => action.actionClass === "repairable_owned");
  const blockers = snapshot.actions.filter((action) => action.actionClass !== "repairable_owned");
  const rows: string[] = [];

  if (maxRows === 1) {
    return [combinedLifecycleAttentionRow(state, snapshot, repairable, blockers)];
  }

  if (repairable.length > 0) {
    const preview = state.project_integration.dry_run_command;
    rows.push(
      `normal: lifecycle action_class=repairable_owned | runtimes=${lifecycleRuntimeNames(snapshot, repairable)} | ` +
        `actions=${repairable.length} | preview=${preview ? `\`${preview}\`` : "unavailable"}`,
    );
  }

  if (blockers.length > 0 && rows.length < MAX_LIFECYCLE_ATTENTION_ROWS) {
    const classes = [...new Set(blockers.map((action) => action.actionClass))].sort().join("+");
    const procedure = firstManualProcedure(blockers);
    const procedureText = procedure ? ` | procedure=${procedure}` : "";
    const doctorText = blockers.some((action) => action.actionClass === "unobservable_gap")
      ? ` | doctor=\`${DOCTOR_DIAGNOSTICS_COMMAND}\``
      : "";
    rows.push(
      `degraded: lifecycle action_class=${classes} | runtimes=${lifecycleRuntimeNames(snapshot, blockers)} | ` +
        `actions=${actionClassSummary(blockers)}${procedureText}${doctorText}`,
    );
  }

  return rows.slice(0, maxRows);
}

export function buildOrientationAttention(state: OrientationState): string[] {
  const {
    profile_status: profileStatus,
    profile,
    profile_dict: profileDict,
    v1_migration: v1Migration,
    project_integration: projectIntegration,
    health,
    plan,
    decision_attention: decisionAttention,
    corpus_coverage: corpusCoverage,
    todo_items: todoItems,
  } = state;

  const attention: string[] = [];
  if (isV2ManagedInstallAtAppHome(state.app.appHome)) {
    attention.push(
      `normal: v2/v3 coexistence at ${state.app.appHome}; pick one line: complete v3 migration, uninstall v3, or stay on v2`,
    );
  }
  const skillDivergenceSignals = (state.app.signals ?? []).filter(
    (s) => s.kind === "skill_root_divergence",
  );
  for (const signal of skillDivergenceSignals) {
    attention.push(
      `degraded: skill-root divergence — ${signal.message ?? "a recognized skill root is below expected"}; run \`npx -y agentera@next upgrade --dry-run --channel development\` to preview repair (D78)`,
    );
  }
  const integrationAttention = projectIntegrationAttention(projectIntegration);
  const lifecycleActions = state.runtime_lifecycle_snapshot?.actions ?? [];
  const hasLifecycleActions = lifecycleActions.length > 0;
  const hasAppIntegration = (projectIntegration.phases?.app.counts.total ?? 0) > 0;
  const includeIntegrationAttention = Boolean(
    integrationAttention && (!hasLifecycleActions || hasAppIntegration),
  );
  if (includeIntegrationAttention && integrationAttention) {
    attention.push(integrationAttention);
  }
  attention.push(
    ...lifecycleAttentionRows(state, includeIntegrationAttention ? 1 : MAX_LIFECYCLE_ATTENTION_ROWS),
  );
  const coverageAttention = corpusCoverageAttention(corpusCoverage);
  if (coverageAttention) {
    attention.push(coverageAttention);
  }
  if (v1Migration.detected && projectIntegration.recommendation !== "upgrade") {
    attention.push(
      `degraded: v1 artifacts detected; preview \`${v1Migration.dry_run_command}\`; files=${v1Migration.affected_files.join(", ")}`,
    );
  }
  if (profileStatus === "not found") {
    attention.push(
      `degraded: PROFILE.md not found at ${profile}; suggest running profile to generate PROFILE.md`,
    );
  } else if (profileDict.stale) {
    const daysSince = profileDict.days_since_generated ?? "?";
    const staleDays = profileDict.stale_threshold_days ?? "?";
    attention.push(
      `normal: profile stale (${daysSince} days since last refresh; ` +
        `threshold=${staleDays}); suggest running profile to refresh PROFILE.md`,
    );
  }
  if (health.stale) {
    const auditNumber = health.number ?? "?";
    const daysSince = health.days_since_audit ?? "?";
    const thresholdDays = health.stale_threshold_days ?? "?";
    const thresholdCycles = health.stale_threshold_cycles ?? "?";
    let attentionText =
      `normal: audit stale (${daysSince} days since Audit ${auditNumber}; ` +
      `threshold days=${thresholdDays}, cycles=${thresholdCycles}`;
    const cyclesSince = health.cycles_since_audit;
    if (cyclesSince !== null && cyclesSince !== undefined) attentionText += `; ${cyclesSince} cycles since audit`;
    attention.push(`${attentionText}); suggest running audit`);
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
  return attention;
}

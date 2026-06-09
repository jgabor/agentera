import { projectIntegrationAttention } from "../../upgrade/projectIntegration.js";
import type { OrientationState } from "../contracts/orientationState.js";
import { firstPresent } from "../stateQuery.js";
import { TODO_SEVERITY_ORDER } from "../todoSeverity.js";

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
    todo_items: todoItems,
  } = state;

  const attention: string[] = [];
  const integrationAttention = projectIntegrationAttention(projectIntegration);
  if (integrationAttention) {
    attention.push(integrationAttention);
  }
  if (v1Migration.detected && projectIntegration.recommendation !== "upgrade") {
    attention.push(
      `degraded: v1 artifacts detected; preview \`${v1Migration.dry_run_command}\`; files=${v1Migration.affected_files.join(", ")}`,
    );
  }
  if (profileStatus === "not found") {
    attention.push(
      `degraded: PROFILE.md not found at ${profile}; suggest running profilera to generate PROFILE.md`,
    );
  } else if (profileDict.stale) {
    const daysSince = profileDict.days_since_generated ?? "?";
    const staleDays = profileDict.stale_threshold_days ?? "?";
    attention.push(
      `normal: profilera profile stale (${daysSince} days since last refresh; ` +
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
  return attention;
}

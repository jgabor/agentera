import { projectIntegrationAttention } from "../../upgrade/projectIntegration.js";
import type { OrientationState } from "../contracts/orientationState.js";
import { corpusCoverageAttention } from "./corpusCoverage.js";
import { firstPresent } from "../stateQuery.js";
import { TODO_SEVERITY_ORDER } from "../todoSeverity.js";

export function buildOrientationAttention(state: OrientationState): string[] {
  const {
    v1_migration: v1Migration,
    project_integration: projectIntegration,
    health,
    plan,
    decision_attention: decisionAttention,
    glossary_caveat_attention: glossaryCaveatAttention,
    corpus_coverage: corpusCoverage,
    todo_items: todoItems,
    todo_reconciliation: todoReconciliation,
  } = state;

  const attention: string[] = [];
  if (todoReconciliation?.status === "action_required") {
    const label = todoReconciliation.state === "inactive" ? "inactive" : todoReconciliation.state === "unsafe_inactive" ? "unsafe inactive" : todoReconciliation.state === "unsafe_active" ? "unsafe active" : "invalid lifecycle";
    attention.push(todoReconciliation.state === "unsafe_inactive"
      ? `action-required: TODO reconciliation is ${label}; ${todoReconciliation.recovery_command}`
      : `action-required: TODO reconciliation is ${label}; preview \`${todoReconciliation.preview_command ?? "n/a"}\`; apply \`${todoReconciliation.apply_command ?? "n/a"}\``);
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
  const hasAppIntegration = (projectIntegration.phases?.app.counts.total ?? 0) > 0;
  const includeIntegrationAttention = Boolean(integrationAttention && hasAppIntegration);
  if (includeIntegrationAttention && integrationAttention) {
    attention.push(integrationAttention);
  }
  const coverageAttention = corpusCoverageAttention(corpusCoverage);
  if (coverageAttention) {
    attention.push(coverageAttention);
  }
  if (v1Migration.detected && projectIntegration.recommendation !== "upgrade") {
    attention.push(
      `degraded: v1 artifacts detected; preview \`${v1Migration.dry_run_command}\`; files=${v1Migration.affected_files.join(", ")}`,
    );
  }
  if (health.stale) {
    const auditId = health.id ?? "unknown";
    const daysSince = health.days_since_audit ?? "?";
    const thresholdDays = health.stale_threshold_days ?? "?";
    const thresholdCycles = health.stale_threshold_cycles ?? "?";
    let attentionText =
      `normal: audit stale (${daysSince} days since health audit ${auditId}; ` +
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
  if (glossaryCaveatAttention) attention.push(glossaryCaveatAttention);
  const pending = plan.first_pending;
  if (pending && typeof pending === "object" && !Array.isArray(pending)) {
    const title = firstPresent(pending, ["name", "title"], "pending task");
    attention.push(`normal: PLAN Task ${pending.number ?? "?"}: ${title}`);
  }
  if (decisionAttention !== null) attention.push(String(decisionAttention.attention));
  if (!(pending && typeof pending === "object" && !Array.isArray(pending)) && todoItems.length > 0) {
    const firstTodo = [...todoItems].sort(
      (a, b) => (TODO_SEVERITY_ORDER[String(a.severity)] ?? 2) - (TODO_SEVERITY_ORDER[String(b.severity)] ?? 2),
    )[0];
    attention.push(`${String(firstTodo.severity)}: TODO: ${String(firstTodo.text)}`);
  }
  return attention;
}

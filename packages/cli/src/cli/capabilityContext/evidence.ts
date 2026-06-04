import fs from "node:fs";
import type { SchemaInfo } from "../appContext.js";
import { artifactPath } from "../appContext.js";
import { asList } from "../stateQuery.js";
import { decisionContextEntry, decisionSourceContract, extractDecisionEntries } from "../commands/state/index.js";
import { capabilityContext } from "./contract.js";
import { docsConventions, entryStatus, sourceProvenance, uniqueList, hasRecordedValue } from "./shared.js";
import { loadNamedArtifact } from "../orientation.js";
import { sourceMetadata } from "../stateQuery.js";
import { selectEvidenceTarget } from "./planState.js";
import { progressVerificationSummary, retryState } from "./progress.js";
import type { Dict } from "./types.js";

export function dateFromIsoUtc(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(utc);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
  return utc;
}
export function todayUtcMs(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

export function currentStateStatus(value: unknown, label: string, staleAfterDays = 30): [string, string | null] {
  if (typeof value !== "string" || !value.trim()) return ["unknown", null];
  const observed = dateFromIsoUtc(value.trim().slice(0, 10));
  if (observed === null) return ["unknown", `${label} current-state date is not ISO-parseable in CLI state.`];
  const ageDays = Math.round((todayUtcMs() - observed) / 86400000);
  if (ageDays > staleAfterDays) return ["stale", `${label} evidence is stale (${ageDays} days old; threshold=${staleAfterDays}).`];
  return ["current", null];
}

export function evidenceDocsState(docs: Dict): Dict {
  const available = Boolean(docs.exists);
  const nonEmptyFields = ["mapping_entries", "indexed_documents", "last_audit"].filter((f) => hasRecordedValue(docs[f]));
  const [currentState, currentStateCaveat] = currentStateStatus(docs.last_audit, "Docs");
  return {
    status: available ? "available" : "unavailable",
    source_provenance: sourceProvenance("docs", "agentera docs --format json"),
    mapping_entries: docs.mapping_entries ?? 0,
    indexed_documents: docs.indexed_documents ?? 0,
    last_audit: docs.last_audit ?? null,
    current_state: currentState,
    non_empty_evidence_present: nonEmptyFields.length > 0,
    non_empty_evidence_fields: nonEmptyFields,
    caveats: [
      ...(available ? [] : ["Docs state is unavailable in CLI docs state."]),
      ...(available && currentStateCaveat ? [currentStateCaveat] : []),
    ],
  };
}

export function evidenceHealthState(health: Dict): Dict {
  const available = Boolean(health.exists);
  const merged: Dict = { audit_number: health.number, ...health };
  const nonEmptyFields = ["audit_number", "trajectory", "grade"].filter((f) => hasRecordedValue(merged[f]));
  const auditDate = health.date ?? health.timestamp ?? null;
  const [currentState, currentStateCaveat] = currentStateStatus(auditDate, "Health");
  return {
    status: available ? "available" : "unavailable",
    source_provenance: sourceProvenance("health", "agentera health --format json"),
    audit_number: health.number ?? null,
    date: auditDate,
    timestamp: auditDate,
    trajectory: health.trajectory ?? null,
    grade: health.grade ?? null,
    degrading: Boolean(health.degrading),
    current_state: currentState,
    non_empty_evidence_present: nonEmptyFields.length > 0,
    non_empty_evidence_fields: nonEmptyFields,
    caveats: [
      ...(available ? [] : ["Health state is unavailable in CLI health state."]),
      ...(available && currentStateCaveat ? [currentStateCaveat] : []),
    ],
  };
}

export function evidenceTodoState(schemas: Record<string, SchemaInfo>, todoItems: Array<Record<string, string>>): Dict {
  const info: SchemaInfo = schemas.todo ?? { path: "TODO.md", record: undefined, schema: {}, fields: {} };
  const exists = fs.existsSync(artifactPath(info, "todo"));
  return {
    status: exists ? "available" : "unavailable",
    source_provenance: sourceProvenance("todo", "agentera todo --format json"),
    open_count: todoItems.length,
    items: todoItems,
    non_empty_evidence_present: todoItems.length > 0,
    non_empty_evidence_fields: todoItems.length > 0 ? ["items"] : [],
    caveats: exists ? [] : ["TODO state is unavailable in CLI TODO state."],
  };
}

export function evidenceProtectedStateChecks(): Dict {
  const source = sourceProvenance("evidence_context", "agentera prime --context inspektera --format json", "protected_state_checks");
  return {
    status: "not_checked_by_design",
    allowed_status_values: ["verified_local", "not_checked_by_design", "requires_manual_check", "unavailable"],
    source_provenance: source,
    checks: [
      {
        name: "vision_state",
        status: "not_checked_by_design",
        protected: true,
        checked: false,
        source_provenance: source,
        caveats: ["Vision state is protected during execution cycles and was not read or modified."],
      },
      {
        name: "objective_state",
        status: "not_checked_by_design",
        protected: true,
        checked: false,
        source_provenance: source,
        caveats: ["Objective state is protected during execution cycles and was not read or modified."],
      },
    ],
    caveats: ["Protected-state boundaries are reported without reading or modifying vision or objective state."],
  };
}

export function evidenceVersionChecks(docs: Dict): Dict {
  const conventions = docsConventions(docs);
  const versionFiles = asList(conventions.version_files);
  const semverPolicy = conventions.semver_policy && typeof conventions.semver_policy === "object" && !Array.isArray(conventions.semver_policy) ? conventions.semver_policy : {};
  const source = sourceProvenance("docs", "agentera docs --format json", "summary.conventions");
  const ec = (field: string) => sourceProvenance("evidence_context", "agentera prime --context inspektera --format json", field);
  const checks: Dict[] = [
    {
      name: "docs_version_policy",
      status: Object.keys(semverPolicy).length > 0 ? "verified_local" : "unavailable",
      source_provenance: source,
      evidence: { semver_policy: semverPolicy },
      caveats: Object.keys(semverPolicy).length > 0 ? [] : ["Docs semver policy is unavailable in CLI docs state."],
    },
    {
      name: "version_files",
      status: versionFiles.length > 0 ? "verified_local" : "unavailable",
      source_provenance: source,
      evidence: { version_files: versionFiles },
      caveats: versionFiles.length > 0 ? [] : ["Docs version files are unavailable in CLI docs state."],
    },
    {
      name: "publication_evidence",
      status: "requires_manual_check",
      source_provenance: ec("version_checks.publication_evidence"),
      remote_checks_performed: false,
      registry_checks_performed: false,
      caveats: ["Publication and registry evidence is not recorded in CLI evidence context and requires manual verification if needed."],
    },
    {
      name: "remote_push_evidence",
      status: "requires_manual_check",
      source_provenance: ec("version_checks.remote_push_evidence"),
      remote_checks_performed: false,
      caveats: ["Remote push evidence is not recorded in CLI evidence context and requires manual verification if needed."],
    },
    {
      name: "installed_app_refresh",
      status: "not_checked_by_design",
      source_provenance: ec("version_checks.installed_app_refresh"),
      refresh_performed: false,
      caveats: ["Installed app refresh state is deliberately not checked or changed by evidence context."],
    },
  ];
  let status: string;
  if (checks.some((c) => c.status === "requires_manual_check")) status = "requires_manual_check";
  else if (checks.some((c) => c.status === "unavailable")) status = "unavailable";
  else status = "verified_local";
  return {
    status,
    allowed_status_values: ["verified_local", "not_checked_by_design", "requires_manual_check", "unavailable"],
    source_provenance: source,
    checks,
    caveats: checks.flatMap((c) => (c.caveats ?? []) as string[]),
  };
}

export function evidencePlanCriteria(plan: Dict, target: Dict): Dict {
  const taskRefObj = target.task && typeof target.task === "object" && !Array.isArray(target.task) ? target.task : null;
  let selected: Dict | null = null;
  if (taskRefObj) {
    const tasks = asList(plan.tasks).filter((t) => t && typeof t === "object" && !Array.isArray(t));
    selected = tasks.find((t) => t.number === taskRefObj.number) ?? null;
  }
  const criteria = selected && typeof selected === "object" ? asList(selected.acceptance) : [];
  return {
    status: criteria.length > 0 ? "available" : "incomplete",
    source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.acceptance"),
    target: taskRefObj,
    criteria,
    criteria_count: criteria.length,
    non_empty_evidence_present: criteria.length > 0,
    non_empty_evidence_fields: criteria.length > 0 ? ["criteria"] : [],
    caveats: criteria.length > 0 ? [] : ["Selected evaluation target has no acceptance criteria in CLI plan state."],
  };
}

export function residualRiskEntry(category: string, status: string, message: string, sp: Dict): Dict {
  return { category, status, message, source_provenance: sp };
}

export function decisionContextRisk(schemas: Record<string, SchemaInfo>): Dict {
  const info: SchemaInfo = schemas.decisions ?? { path: ".agentera/decisions.yaml", record: undefined, schema: {}, fields: {} };
  const p = artifactPath(info, "decisions");
  const source = sourceMetadata("decisions", p);
  const data = loadNamedArtifact(schemas, "decisions");
  const entries = extractDecisionEntries(data).map((e) => decisionContextEntry(e));
  if (!source.exists) {
    return {
      status: "unavailable",
      source_provenance: sourceProvenance("decisions", "agentera decisions --format json"),
      summary: null,
      caveats: ["Decision state is unavailable in CLI evidence context."],
    };
  }
  const contract = decisionSourceContract(source, entries, {});
  const compacted = contract.completeness.compacted_entries;
  const missing = contract.completeness.entries_with_missing_fields;
  const caveats = compacted || missing ? (contract.caveats ?? []) : [];
  return {
    status: caveats.length > 0 ? "caveated" : "available",
    source_provenance: sourceProvenance("decisions", "agentera decisions --format json"),
    summary: contract.completeness,
    caveats,
  };
}

export function parseDecisionReviewDate(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return dateFromIsoUtc(value.trim().slice(0, 10));
}

export function decisionReviewDue(entry: Dict): [string | null, number | null] {
  const satisfaction = entry.satisfaction && typeof entry.satisfaction === "object" && !Array.isArray(entry.satisfaction) ? entry.satisfaction : {};
  const candidates: Array<[string, unknown]> = [
    ["review_date", entry.review_date],
    ["review_by", entry.review_by],
    ["satisfaction.review_date", satisfaction.review_date],
    ["satisfaction.review_by", satisfaction.review_by],
    ["satisfaction.review_due", satisfaction.review_due],
  ];
  for (const [field, value] of candidates) {
    const parsed = parseDecisionReviewDate(value);
    if (parsed !== null) return [field, parsed];
  }
  return [null, null];
}

export function decisionLabel(entry: Dict): string {
  const number = entry.number;
  if (number !== null && number !== undefined && number !== "") return `Decision ${number}`;
  const summary = entry.summary;
  if (typeof summary === "string" && summary.trim()) return summary.trim().split(":", 1)[0];
  return "Decision entry";
}

export function isoFromUtcMs(utc: number): string {
  const d = new Date(utc);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function decisionReviewPressure(schemas: Record<string, SchemaInfo>): Dict {
  const info: SchemaInfo = schemas.decisions ?? { path: ".agentera/decisions.yaml", record: undefined, schema: {}, fields: {} };
  const p = artifactPath(info, "decisions");
  const source = sourceMetadata("decisions", p);
  const sp = sourceProvenance("decisions", "agentera decisions --format json");
  if (!source.exists) {
    return { status: "unavailable", source_provenance: sp, summary: null, stale_protected_decisions: [], caveats: [] };
  }
  const data = loadNamedArtifact(schemas, "decisions");
  const dd = data && typeof data === "object" && !Array.isArray(data) ? (data as Dict) : {};
  const active = Array.isArray(dd.decisions) ? dd.decisions : [];
  const archive = Array.isArray(dd.archive) ? dd.archive : [];
  const activeEntries = active.filter((e: unknown) => e && typeof e === "object" && !Array.isArray(e)).map((e: Dict) => decisionContextEntry(e));
  const archiveEntries = archive.filter((e: unknown) => e && typeof e === "object" && !Array.isArray(e)).map((e: Dict) => decisionContextEntry(e));
  const protectedActive = activeEntries.filter((e: Dict) => e.satisfaction && typeof e.satisfaction === "object" && e.satisfaction.review_needed);
  const protectedArchive = archiveEntries.filter((e: Dict) => e.satisfaction && typeof e.satisfaction === "object" && e.satisfaction.review_needed);
  const today = todayUtcMs();
  const stale: Dict[] = [];
  let caveats: string[] = [];
  for (const [collection, entries] of [["decisions", protectedActive], ["archive", protectedArchive]] as Array<[string, Dict[]]>) {
    for (const entry of entries) {
      const [field, reviewDate] = decisionReviewDue(entry);
      if (reviewDate === null || reviewDate > today) continue;
      const label = decisionLabel(entry);
      const message = `${label} requires protected decision review because ${field} elapsed on ${isoFromUtcMs(reviewDate)}.`;
      stale.push({ label, collection, reason: "review_date_elapsed", review_date: isoFromUtcMs(reviewDate), source_field: field, message });
      caveats.push(message);
    }
  }
  const protectedOverflowCount = Math.max(
    protectedActive.length - 10,
    protectedArchive.length - 40,
    protectedActive.length + protectedArchive.length - 50,
    0,
  );
  if (protectedOverflowCount) {
    const message =
      "Protected decisions exceed the 10/40/50 compaction budget; " +
      `${protectedOverflowCount} protected decision(s) require review before compaction can complete.`;
    stale.push({ label: "decisions", collection: "decisions/archive", reason: "protected_compaction_budget_pressure", protected_overflow_count: protectedOverflowCount, message });
    caveats.push(message);
  }
  caveats = uniqueList(caveats);
  return {
    status: caveats.length > 0 ? "review_required" : "available",
    source_provenance: sp,
    summary: {
      protected_active_decisions: protectedActive.length,
      protected_archive_decisions: protectedArchive.length,
      protected_overflow_count: protectedOverflowCount,
      stale_protected_decisions: stale.length,
    },
    stale_protected_decisions: stale,
    caveats,
  };
}

export function inspekteraEvidenceContext(
  capability: string | null,
  schemas: Record<string, SchemaInfo>,
  plan: Dict,
  progress: Dict,
  health: Dict,
  todoItems: Array<Record<string, string>>,
  docs: Dict,
  profile: Dict,
  bundle: Dict,
): Dict | null {
  if (capability !== "inspektera") return null;
  const capabilityContract = capabilityContext(capability) ?? {};
  const evaluationTarget = selectEvidenceTarget(plan);
  const planCriteria = evidencePlanCriteria(plan, evaluationTarget);
  const progressVerification = progressVerificationSummary(progress);
  const docsState = evidenceDocsState(docs);
  const healthState = evidenceHealthState(health);
  const todoState = evidenceTodoState(schemas, todoItems);
  const protectedStateChecks = evidenceProtectedStateChecks();
  const versionChecks = evidenceVersionChecks(docs);
  const decisionRisk = decisionContextRisk(schemas);
  const reviewPressure = decisionReviewPressure(schemas);

  let stateCaveats: string[] = [];
  const attributedRisks: Dict[] = [];
  for (const family of (capabilityContract.missing_state_families ?? []) as string[]) {
    const message = `${family} state is not included in prime --context startup context.`;
    stateCaveats.push(message);
    attributedRisks.push(residualRiskEntry("missing_state_family", "caveated", message, sourceProvenance("prime", "agentera prime --context inspektera --format json", "source_contract.capability_context.missing_state_families")));
  }
  if (bundle.status !== "up_to_date") {
    const message = "Agentera app files are not up to date; this is a caveat, not approval to repair or update app files.";
    stateCaveats.push(message);
    attributedRisks.push(residualRiskEntry("installed_app_state", "caveated", message, sourceProvenance("hej", "agentera hej --format json", "bundle.status")));
  }
  if (profile.status !== "loaded") {
    const message = "profile-derived state is unavailable in prime --context response.";
    stateCaveats.push(message);
    attributedRisks.push(residualRiskEntry("profile_state", "unavailable", message, sourceProvenance("hej", "agentera hej --format json", "profile.status")));
  } else if (profile.stale === true) {
    const message = "profile-derived state is stale; this is a caveat, not approval to refresh profile state.";
    stateCaveats.push(message);
    attributedRisks.push(residualRiskEntry("profile_state", "caveated", message, sourceProvenance("hej", "agentera hej --format json", "profile.stale")));
  }
  for (const component of [evaluationTarget, planCriteria, progressVerification, docsState, healthState, todoState, protectedStateChecks, versionChecks]) {
    for (const caveat of (component.caveats ?? []) as string[]) {
      stateCaveats.push(caveat);
      attributedRisks.push(residualRiskEntry("evidence_family", "caveated", caveat, component.source_provenance ?? sourceProvenance("evidence_context", "agentera prime --context inspektera --format json")));
    }
  }
  for (const caveat of (decisionRisk.caveats ?? []) as string[]) {
    stateCaveats.push(caveat);
    attributedRisks.push(residualRiskEntry("decisions_context", decisionRisk.status, caveat, decisionRisk.source_provenance));
  }
  for (const caveat of (reviewPressure.caveats ?? []) as string[]) {
    stateCaveats.push(caveat);
    attributedRisks.push(residualRiskEntry("decision_review_pressure", reviewPressure.status, caveat, reviewPressure.source_provenance));
  }
  const retry = retryState();
  for (const caveat of (retry.caveats ?? []) as string[]) {
    stateCaveats.push(caveat);
    attributedRisks.push(residualRiskEntry("retry_state", retry.status, caveat, retry.source_provenance));
  }
  stateCaveats = uniqueList(stateCaveats);
  const dedupedRisks: Dict[] = [];
  const seen = new Set<string>();
  for (const risk of attributedRisks) {
    const key = `${risk.category}\u0000${risk.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedRisks.push(risk);
    }
  }
  const requiredState: Record<string, boolean> = {
    evaluation_target: evaluationTarget.status === "selected",
    plan_criteria: planCriteria.status === "available",
    progress_verification: progressVerification.status === "available",
    docs_state: docsState.status === "available",
    health_state: healthState.status === "available",
    todo_state: todoState.status === "available",
    source_contract: true,
  };
  const missingRequired = Object.entries(requiredState).filter(([, present]) => !present).map(([name]) => name);
  const fallbackCommands = uniqueList([
    "agentera plan --format json",
    "agentera progress --format json",
    "agentera docs --format json",
    "agentera health --format json",
    "agentera todo --format json",
    "agentera query --list-artifacts --format json",
    ...((capabilityContract.cli_fallback ?? []) as string[]),
  ]);
  return {
    capability: "inspektera",
    evaluation_target: evaluationTarget,
    plan_criteria: planCriteria,
    progress_verification: progressVerification,
    docs_state: docsState,
    health_state: healthState,
    todo_state: todoState,
    protected_state_checks: protectedStateChecks,
    version_checks: versionChecks,
    decision_context: decisionRisk,
    decision_review_pressure: reviewPressure,
    residual_risks: {
      status: dedupedRisks.length > 0 ? "caveated" : "none_recorded",
      items: stateCaveats,
      attributed_items: dedupedRisks,
      caveats: [],
    },
    state_family_caveats: stateCaveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_evidence_context: missingRequired.length === 0,
      caveated: stateCaveats.length > 0,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy:
        "Use this evidence_context and included hej state first. Run listed routine/query CLI fallback commands " +
        "for missing or incomplete evidence state; raw artifact reads are last-resort diagnostics, not normal evaluation startup behavior.",
      included_state_families: capabilityContract.included_state_families ?? [],
      missing_state_families: capabilityContract.missing_state_families ?? [],
      required_evidence_state: requiredState,
      missing_required_evidence_state: missingRequired,
      fallback_commands: fallbackCommands,
      caveats: stateCaveats,
      owns: [
        "evaluation target",
        "plan criteria",
        "progress verification",
        "docs state",
        "health state",
        "TODO state",
        "protected-state placeholder checks",
        "version boundary checks",
        "compacted decision caveats",
        "protected decision review pressure",
        "attributed residual risks",
        "fallback commands",
        "raw-read policy",
        "truthful completeness metadata",
      ],
      deferred: [],
    },
  };
}

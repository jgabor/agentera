/**
 * `state decisions` query (decisions.yaml + archive) plus the
 * decision context enrichment utilities consumed by prime/hej.
 *
 * The contract for decision context: never infer satisfaction from
 * downstream references, commits, or compacted history. Only
 * `state == user_confirmed_satisfied` with explicit
 * `user_confirmation` metadata is reported as user-confirmed
 * satisfied; everything else carries a `review_needed` flag and
 * a `caveats` array.
 */

import {
  emitStateStructured,
  extractEntries,
  loadArtifact,
  missingSchemaError,
  sourceMetadata,
  stringFieldNames,
  structuredState,
} from "../../stateQuery.js";
import { SchemaInfo, artifactPath } from "../../appContext.js";
import { out, err, StateArgs, Io } from "./shared.js";

type Dict = Record<string, any>;

const DECISION_CONTEXT_FIELDS = [
  "number",
  "date",
  "question",
  "context",
  "alternatives",
  "choice",
  "reasoning",
  "confidence",
  "feeds_into",
  "satisfaction",
];

const PRIORITY_FIELDS = [
  "number", "name", "title", "date", "timestamp", "status",
  "phase", "choice", "grade", "type", "label", "trajectory", "confidence",
];

const DECISION_ARCHIVE_RE = /Decision\s+(?<number>\d+)(?:\s+\((?<date>\d{4}-\d{2}-\d{2})\))?:\s*(?<summary>.*)/;

export function displayFields(fields: Dict, limit = 6): string[] {
  const ordered = PRIORITY_FIELDS.filter((p) => p in fields);
  for (const fn of Object.keys(fields)) {
    if (!ordered.includes(fn)) ordered.push(fn);
  }
  return ordered.slice(0, limit);
}

function isEmptyValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v as Dict).length === 0)
  );
}

function decisionArchiveEntry(entry: unknown): Dict {
  const archiveEntry: Dict =
    entry && typeof entry === "object" && !Array.isArray(entry) ? { ...(entry as Dict) } : { summary: String(entry) };
  archiveEntry.compacted = true;
  const summary = String(archiveEntry.summary ?? "");
  const match = DECISION_ARCHIVE_RE.exec(summary);
  if (match && match.groups) {
    if (!("number" in archiveEntry)) archiveEntry.number = parseInt(match.groups.number, 10);
    if (match.groups.date && !("date" in archiveEntry)) archiveEntry.date = match.groups.date;
  }
  return archiveEntry;
}

export function extractDecisionEntries(data: unknown): Dict[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return extractEntries(data);
  const d = data as Dict;
  const decisions = d.decisions ?? [];
  const archive = d.archive ?? [];
  const entries: Dict[] = Array.isArray(decisions)
    ? decisions.filter((e) => e && typeof e === "object" && !Array.isArray(e))
    : [];
  if (Array.isArray(archive)) {
    for (const entry of archive) entries.push(decisionArchiveEntry(entry));
  }
  return entries;
}

function filterDecisionsByTopic(entries: Dict[], topic: string, fields: Dict): Dict[] {
  const t = topic.toLowerCase();
  const fnames = [...stringFieldNames(fields), "summary", "outcome"];
  return entries.filter((entry) => fnames.some((f) => String(entry[f] ?? "").toLowerCase().includes(t)));
}

function decisionFieldMissing(entry: Dict, field: string): boolean {
  return isEmptyValue(entry[field]);
}

function decisionDownstreamReferences(entry: Dict): Array<Record<string, string>> | null {
  const value = entry.feeds_into;
  if (value === null || value === undefined || value === "") return null;
  let refs: string[];
  if (Array.isArray(value)) {
    refs = value.map((item) => String(item).trim()).filter((s) => s);
  } else {
    refs = String(value)
      .split(",")
      .map((part) => part.trim())
      .filter((s) => s);
  }
  if (refs.length === 0) return null;
  return refs.map((ref) => ({ source_field: "feeds_into", reference: ref }));
}

export function decisionSatisfactionContext(entry: Dict): Dict {
  const satisfaction = entry.satisfaction;
  if (!satisfaction || typeof satisfaction !== "object" || Array.isArray(satisfaction)) {
    return {
      state: null,
      evidence: null,
      user_confirmation: null,
      review_needed: true,
      source: "missing_legacy_state",
      caveats: ["Missing legacy satisfaction state is not treated as satisfied."],
    };
  }
  const sat = satisfaction as Dict;
  const state = sat.state;
  const evidence = sat.evidence ?? null;
  const userConfirmation = sat.user_confirmation ?? null;
  const explicitReviewNeeded = sat.review_needed === true;
  let caveats: string[] = [];
  let reviewNeeded = true;
  if (state === "user_confirmed_satisfied") {
    reviewNeeded =
      !(userConfirmation && typeof userConfirmation === "object" && !Array.isArray(userConfirmation)) ||
      Object.keys(userConfirmation as Dict).length === 0;
    if (reviewNeeded) caveats.push("User-confirmed satisfaction is missing explicit user confirmation metadata.");
  } else if (state === "provisionally_satisfied") {
    if (isEmptyValue(evidence)) caveats.push("Provisional satisfaction is missing concrete evidence.");
    caveats.push("Provisional satisfaction still requires user confirmation.");
  } else if (state === "open") {
    caveats.push("Satisfaction state is open and requires review.");
  } else {
    caveats.push("Satisfaction state is missing or unrecognized and requires review.");
  }
  if (explicitReviewNeeded) {
    reviewNeeded = true;
    caveats.push("Decision satisfaction is explicitly marked review_needed.");
  }
  const originalCaveats = sat.caveats;
  if (Array.isArray(originalCaveats)) caveats = [...originalCaveats.map((c) => String(c)), ...caveats];
  else if (typeof originalCaveats === "string") caveats = [originalCaveats, ...caveats];
  const enriched: Dict = { ...sat };
  if (!("evidence" in enriched)) enriched.evidence = evidence;
  if (!("user_confirmation" in enriched)) enriched.user_confirmation = userConfirmation;
  enriched.review_needed = reviewNeeded;
  enriched.source = "decision.satisfaction";
  enriched.caveats = caveats;
  return enriched;
}

export function decisionContextEntry(entry: Dict): Dict {
  const enriched: Dict = { ...entry };
  if ((enriched.outcome === null || enriched.outcome === undefined || enriched.outcome === "") &&
      enriched.choice !== null && enriched.choice !== undefined && enriched.choice !== "") {
    enriched.outcome = enriched.choice;
  }
  const compacted =
    Boolean(enriched.compacted) ||
    ("summary" in enriched &&
      ["question", "reasoning", "confidence"].some((field) => decisionFieldMissing(enriched, field)));
  const missingFields = DECISION_CONTEXT_FIELDS.filter((field) => decisionFieldMissing(enriched, field));
  if (decisionFieldMissing(enriched, "choice") && decisionFieldMissing(enriched, "outcome")) {
    missingFields.push("outcome");
  }
  const downstreamReferences = decisionDownstreamReferences(enriched);
  const caveats: string[] = [];
  if (compacted) caveats.push("Decision entry is compacted; full decision context is not available in this CLI result.");
  if (missingFields.length > 0) caveats.push("Decision entry is missing one or more full-detail context fields.");
  if (downstreamReferences === null) {
    caveats.push("No explicit downstream consequence references were present; none were inferred.");
  }
  const satisfaction = decisionSatisfactionContext(enriched);
  if (satisfaction.review_needed) {
    caveats.push("Decision satisfaction requires user review; missing legacy state is not treated as satisfied.");
  }
  enriched.satisfaction = satisfaction;
  enriched.downstream_consequence_references = downstreamReferences;
  enriched.context_complete =
    !compacted && missingFields.length === 0 && downstreamReferences !== null && !satisfaction.review_needed;
  enriched.missing_fields = missingFields;
  enriched.compacted = compacted;
  enriched.caveats = caveats;
  return enriched;
}

export function decisionSourceContract(source: Dict, entries: Dict[], filters: Dict): Dict {
  const sourceExists = Boolean(source.exists);
  const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== null && v !== undefined));
  const filteredNoMatch = sourceExists && Object.keys(activeFilters).length > 0 && entries.length === 0;
  const compactedEntries = entries.filter((e) => e.compacted).length;
  const entriesWithMissingFields = entries.filter((e) => e.missing_fields && e.missing_fields.length > 0).length;
  const entriesWithoutDownstream = entries.filter((e) => e.downstream_consequence_references === null).length;
  const entriesRequiringSatisfactionReview = entries.filter(
    (e) => e.satisfaction && typeof e.satisfaction === "object" && e.satisfaction.review_needed,
  ).length;
  const userConfirmedSatisfied = entries.filter(
    (e) =>
      e.satisfaction &&
      typeof e.satisfaction === "object" &&
      e.satisfaction.state === "user_confirmed_satisfied" &&
      !e.satisfaction.review_needed,
  ).length;
  const completeForReturned = sourceExists && entries.every((e) => e.context_complete === true);
  const completeForNormalDeliberation = sourceExists;
  const caveats = [
    "Downstream consequence references are derived only from explicit structured feeds_into values; no references are inferred.",
    "Compacted archive decisions are not expanded by this command and are not complete full-detail decision context.",
  ];
  if (!sourceExists) caveats.push("Decision artifact is missing or unavailable; no decision context is available from this command result.");
  if (filteredNoMatch) caveats.push("Filtered result is empty; no returned decisions match the filter, but the decision artifact was available.");
  if (entriesWithMissingFields) caveats.push("One or more returned decisions are missing full-detail context fields.");
  if (entriesWithoutDownstream) caveats.push("One or more returned decisions lack explicit downstream consequence references.");
  if (entriesRequiringSatisfactionReview) caveats.push("One or more returned decisions require satisfaction review; satisfaction is never inferred from downstream references.");
  return {
    artifact: "decisions",
    canonical_artifact_label: "decisions",
    path: source.path,
    complete_for_returned_decisions: completeForReturned,
    complete_for_decision_context: completeForReturned,
    complete_for_returned_full_detail: completeForReturned,
    complete_for_normal_deliberation_context: completeForNormalDeliberation,
    completeness: {
      returned_decisions: entries.length,
      context_complete: completeForReturned,
      returned_full_detail_complete: completeForReturned,
      normal_deliberation_context: completeForNormalDeliberation,
      filtered_no_match: filteredNoMatch,
      source_exists: sourceExists,
      compacted_entries: compactedEntries,
      entries_with_missing_fields: entriesWithMissingFields,
      entries_without_downstream_references: entriesWithoutDownstream,
      entries_requiring_satisfaction_review: entriesRequiringSatisfactionReview,
      user_confirmed_satisfied_entries: userConfirmedSatisfied,
    },
    included_fields: [
      ...DECISION_CONTEXT_FIELDS,
      "outcome",
      "downstream_consequence_references",
      "context_complete",
      "missing_fields",
      "compacted",
      "caveats",
    ],
    satisfaction_context: {
      owner: "decision entry",
      state_field: "satisfaction.state",
      evidence_field: "satisfaction.evidence",
      confirmation_field: "satisfaction.user_confirmation",
      review_needed_field: "satisfaction.review_needed",
      confirmation_policy:
        "Only satisfaction.state=user_confirmed_satisfied with explicit user_confirmation metadata is reported as user-confirmed satisfied.",
      non_inference_policy:
        "Do not infer satisfaction from feeds_into, commits, downstream files, generated references, or compacted history.",
    },
    normal_deliberation_context: {
      use_complete_for_normal_deliberation_context: true,
      legacy_full_detail_signal: "complete_for_decision_context",
      guidance:
        "For normal deliberation, use returned entries plus missing_fields, compacted, caveats, " +
        "and satisfaction review state. Do not use the legacy full-detail completeness flag " +
        "as a reason to reread the raw decision artifact.",
    },
    decision_context_truth_table: {
      full_detail_entries: {
        full_detail_complete: true,
        normal_deliberation_context_complete: true,
        raw_artifact_read_required: false,
      },
      compacted_archive_entries: {
        full_detail_complete: false,
        normal_deliberation_context_complete: true,
        raw_artifact_read_required: false,
        carry_forward: ["missing_fields", "compacted", "caveats"],
      },
      entries_with_missing_full_detail_fields: {
        full_detail_complete: false,
        normal_deliberation_context_complete: true,
        raw_artifact_read_required: false,
        carry_forward: ["missing_fields", "caveats"],
      },
      satisfaction_review_needed: {
        full_detail_complete: false,
        normal_deliberation_context_complete: true,
        raw_artifact_read_required: false,
        carry_forward: ["satisfaction.review_needed", "caveats"],
      },
      filtered_no_match: {
        full_detail_complete: true,
        normal_deliberation_context_complete: true,
        raw_artifact_read_required: false,
        meaning: "The artifact exists, but no returned decisions matched the filter.",
      },
      missing_or_unavailable_artifact: {
        full_detail_complete: false,
        normal_deliberation_context_complete: false,
        raw_artifact_read_required: false,
        meaning:
          "No decision state is available from the CLI result; use CLI fallback or diagnostics before raw artifact repair.",
      },
    },
    missing_full_detail_boundary: {
      applies_when: "returned decisions have missing_fields or context_complete=false",
      normal_behavior: "Use present structured fields only and preserve missing_fields/caveats downstream.",
      raw_artifact_read_required: false,
      do_not: "Do not infer absent reasoning, alternatives, confidence, feeds_into, outcome, or downstream references.",
    },
    missing_artifact_boundary: {
      applies_when: "source.exists=false",
      normal_behavior: "Treat decision context as unavailable from this result; do not infer historical decisions.",
      raw_artifact_read_required: false,
      diagnostic_boundary: "Raw artifact access is reserved for explicit artifact repair/corruption or CLI-defect investigation.",
    },
    filtered_result_boundary: {
      applies_when: "filters are present and entries=[] while source.exists=true",
      normal_behavior: "Treat the result as no matching returned decisions, not as missing decision state.",
      raw_artifact_read_required: false,
    },
    satisfaction_review_boundary: {
      applies_when: "one or more entries have satisfaction.review_needed=true",
      normal_behavior:
        "Carry satisfaction review pressure forward; only user confirmation can make a decision user-confirmed satisfied.",
      raw_artifact_read_required: false,
      do_not: "Do not infer satisfaction from downstream references, commits, generated files, or compacted history.",
    },
    compacted_history_boundary: {
      applies_when: "returned entries have compacted=true",
      normal_behavior:
        "Use the compact summary and retained fields; preserve compacted/missing_fields/caveats downstream.",
      raw_artifact_read_required: false,
      do_not: "Do not expand archive decisions or reconstruct missing context from git history.",
    },
    raw_artifact_access_boundary: {
      normal_deliberation:
        "skip raw `.agentera/decisions.yaml` reads when complete_for_normal_deliberation_context=true",
      allowed_raw_artifact_uses: [
        "Resonera-owned decision writes or repairs",
        "artifact corruption diagnostics",
        "CLI defect investigation",
      ],
    },
    raw_artifact_reads_required: false,
    raw_artifact_read_policy:
      "Use `agentera decisions --format json` for normal deliberation context and key normal use off " +
      "complete_for_normal_deliberation_context. " +
      "Do not read `.agentera/decisions.yaml` unless investigating artifact corruption or CLI defects; " +
      "historical compacted gaps are exposed through missing_fields and caveats.",
    caveats,
    fallback_behavior: {
      normal:
        "Use this command's entries and source_contract; no raw decision artifact read is required for returned full-detail or compacted decision entries.",
      filtered_result:
        "The same per-decision guarantees apply after filters; an empty filtered result means no matching returned decisions.",
      missing_or_incomplete:
        "If a required field is missing, treat only the present structured fields as authoritative and do not infer absent context.",
      satisfaction:
        "Use only each entry's satisfaction object for satisfaction state. Missing, open, provisional, or unconfirmed satisfaction requires review and must not be reported as user-confirmed satisfied.",
      compacted_history:
        "Compacted archive decisions are included with explicit missing_fields and caveats; treat absent historical context as unavailable during normal deliberation.",
    },
    fallback_policy:
      "If the decision artifact is missing or CLI state appears defective, use CLI fallback/diagnostic paths before raw artifact repair; do not raw-read merely because returned decisions are compacted or incomplete.",
    filters: activeFilters,
  };
}

export function queryDecisions(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.decisions;
  if (!info) {
    e(missingSchemaError("decisions") + "\n");
    return 1;
  }
  const p = artifactPath(info, "decisions");
  const data = loadArtifact(p);
  let entries = extractDecisionEntries(data);
  const topic = args.topic ?? null;
  if (topic) entries = filterDecisionsByTopic(entries, topic, info.fields);
  const format = args.format ?? "text";
  if (format !== "text") {
    const enriched = entries.map((entry) => decisionContextEntry(entry));
    const source = sourceMetadata("decisions", p);
    const filters = { topic };
    return emitStateStructured(
      "decisions",
      structuredState("decisions", enriched, source, {
        filters,
        sourceContract: decisionSourceContract(source, enriched, filters),
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  if (entries.length === 0) return 0;
  const disp = displayFields(info.fields);
  for (const entry of entries) {
    const parts: string[] = [];
    for (const fn of disp) {
      const v = entry[fn];
      if (v !== null && v !== undefined && v !== "" && !Array.isArray(v) && typeof v !== "object") {
        parts.push(`${fn}=${v}`);
      }
    }
    if (parts.length > 0) o(parts.join(" | ") + "\n");
  }
  return 0;
}

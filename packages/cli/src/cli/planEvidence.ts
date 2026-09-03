import { artifactPath, type SchemaInfo } from "./appContext.js";
import { asList, loadArtifact } from "./stateQuery.js";
import type { JsonObject } from "../core/jsonValue.js";

import type { PlanArtifact } from "./planArtifacts.js";

interface ProgressEvidenceRecord {
  cycleNumber: number | string;
  artifactPath: string;
  field: "verified" | "what" | "summary";
  detail: string;
  matchText: string;
}

export interface PlanEvidenceResolution {
  tasks: JsonObject[];
  complete: boolean;
  sources: string[];
}

/**
 * These phrases are the stable progress-to-task joins for the completed
 * lifecycle plan. They intentionally match task-specific progress language,
 * rather than every cycle that happens to mention a shared runtime concept.
 */
const LIFECYCLE_PROGRESS_MATCHES: Record<string, string> = {
  "1": "canonical runtime lifecycle projection for task 1",
  "2": "defined default preview and explicit apply semantics",
  "3": "task 3 ownership-safe repair",
  "4": "drove project integration from the canonical runtime lifecycle projection",
  "5": "surface bounded lifecycle attention rows",
  "6": "verified runtime lifecycle selectors, ownership safety, preview purity",
  "7": "verified task 7 consumer and distribution parity",
  "8": "synchronized packages/cli/package.json dev.17",
};

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasRecordedEvidence(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasRecordedEvidence(item));
  if (value !== null && typeof value === "object") return Object.keys(value as JsonObject).length > 0;
  return value !== null && value !== undefined && String(value).trim().length > 0;
}

function cycleNumber(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) return /^\d+$/.test(value.trim()) ? Number(value) : value.trim();
  return null;
}

function progressEvidenceRecords(schemas: Record<string, SchemaInfo>): ProgressEvidenceRecord[] {
  const info = schemas.progress;
  if (!info) return [];
  const progressPath = artifactPath(info, "progress");
  const data = loadArtifact(progressPath);
  if (!isMapping(data)) return [];

  const records: ProgressEvidenceRecord[] = [];
  for (const raw of asList(data.cycles)) {
    if (!isMapping(raw)) continue;
    const number = cycleNumber(raw.number);
    const what = String(raw.what ?? "").trim();
    if (number === null || !what) continue;
    const verified = String(raw.verified ?? "").trim();
    records.push({
      cycleNumber: number,
      artifactPath: progressPath,
      field: verified ? "verified" : "what",
      detail: verified || what,
      matchText: what.toLowerCase(),
    });
  }

  for (const raw of asList(data.archive)) {
    if (!isMapping(raw)) continue;
    const summary = String(raw.summary ?? "").trim();
    const match = /^Cycle\s+(\d+)\b/i.exec(summary);
    if (!match || !summary) continue;
    records.push({
      cycleNumber: Number(match[1]),
      artifactPath: progressPath,
      field: "summary",
      detail: summary,
      matchText: summary.toLowerCase(),
    });
  }
  return records;
}

function progressMatch(task: JsonObject, records: ProgressEvidenceRecord[]): { record: ProgressEvidenceRecord; phrase: string } | null {
  const number = String(task.number ?? "");
  const phrase = LIFECYCLE_PROGRESS_MATCHES[number];
  if (!phrase) return null;
  const matches = records
    .filter((record) => record.matchText.includes(phrase))
    .sort((a, b) => {
      const aNumber = typeof a.cycleNumber === "number" ? a.cycleNumber : Number.MAX_SAFE_INTEGER;
      const bNumber = typeof b.cycleNumber === "number" ? b.cycleNumber : Number.MAX_SAFE_INTEGER;
      return aNumber - bNumber || a.detail.localeCompare(b.detail);
    });
  return matches.length > 0 ? { record: matches[0], phrase } : null;
}

function supportsLifecycleProgressJoin(artifact: PlanArtifact): boolean {
  const header = isMapping(artifact.data.header) ? artifact.data.header : {};
  const title = String(header.title ?? artifact.data.title ?? "").toLowerCase();
  return title.includes("runtime lifecycle");
}

function progressProvenance(match: { record: ProgressEvidenceRecord; phrase: string }, task: JsonObject): JsonObject {
  return {
    source_family: "progress",
    source_kind: match.record.field === "summary" ? "typed_writer_archive" : "typed_writer_cycle",
    artifact_path: match.record.artifactPath,
    cycle_number: match.record.cycleNumber,
    field: match.record.field,
    task_number: task.number ?? null,
    deterministic_match: match.phrase,
    detail: match.record.detail,
  };
}

function planProvenance(planPath: string, task: JsonObject): JsonObject {
  return {
    source_family: "plan",
    source_kind: "immutable_archive",
    artifact_path: planPath,
    field: `tasks[${String(task.number ?? "?")}].evidence`,
    task_number: task.number ?? null,
  };
}

/**
 * Project evidence into the read-only state response. Existing plan evidence
 * remains intact; missing evidence is resolved only through a deterministic
 * join to typed progress cycles or compacted writer summaries.
 */
export function resolvePlanTaskEvidence(artifact: PlanArtifact, tasks: JsonObject[], schemas: Record<string, SchemaInfo>): PlanEvidenceResolution {
  const records = supportsLifecycleProgressJoin(artifact) ? progressEvidenceRecords(schemas) : [];
  const sources = new Set<string>();
  let complete = true;
  const resolved = tasks.map((task) => {
    const stored = hasRecordedEvidence(task.evidence);
    const match = stored ? null : progressMatch(task, records);
    const provenance: JsonObject[] = [];
    let evidence = task.evidence;
    if (stored) {
      provenance.push(planProvenance(artifact.path, task));
      sources.add("plan");
    } else if (match) {
      evidence = [
        {
          source: "progress",
          cycle_number: match.record.cycleNumber,
          field: match.record.field,
          detail: match.record.detail,
        },
      ];
      provenance.push(progressProvenance(match, task));
      sources.add("progress");
    } else {
      evidence = [];
      complete = false;
    }
    return {
      ...task,
      evidence,
      evidence_status: hasRecordedEvidence(evidence) ? "present" : "missing",
      evidence_provenance: provenance,
    };
  });
  return { tasks: resolved, complete, sources: [...sources].sort() };
}

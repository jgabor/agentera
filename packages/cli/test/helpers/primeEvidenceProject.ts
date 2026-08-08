import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { todoReconciliationActivationBytes } from "../../src/state/todoReconciliationActivation.js";

export interface PrimeEvidenceFixture {
  planId: string;
  selectedTaskId: string;
  selectedDependencyId: string;
  fullDecisionId: string;
  summaryIds: Record<"progress" | "decisions" | "health", string>;
}

function alphaId(index: number): string {
  let value = index;
  return Array.from({ length: 10 }, () => {
    const character = String.fromCharCode(97 + value % 26);
    value = Math.floor(value / 26);
    return character;
  }).reverse().join("");
}

function writeEntity(
  root: string,
  artifact: string,
  boundary: string,
  id: string,
  record: Record<string, unknown>,
): void {
  const directory = path.join(root, ".agentera/entities", artifact, boundary);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.yaml`), dumpYamlMapping({ id, artifact, record }));
}

function writeSummary(
  root: string,
  artifact: "progress" | "decisions" | "health",
  id: string,
  physical: Record<string, unknown>,
): void {
  const sourcePath = `.agentera/${artifact}.yaml`;
  const collection = artifact === "progress" ? "cycles" : artifact === "decisions" ? "decisions" : "audits";
  fs.writeFileSync(path.join(root, sourcePath), dumpYamlMapping({ [collection]: [physical] }));
  const boundary = artifact === "progress" ? "progress_summary" : artifact === "decisions" ? "decision_summary" : "health_summary";
  const { number: _number, ...retained } = physical;
  writeEntity(root, artifact, boundary, id, {
    ...retained,
    migration_provenance: {
      source_path: sourcePath,
      source_record_sha256: createHash("sha256").update(canonicalRecordJson(physical)).digest("hex"),
    },
  });
}

/** Host-real startup fixture: 21 tasks plus full and compacted canonical histories. */
export function seedPrimeEvidenceProject(root: string): PrimeEvidenceFixture {
  const agentera = path.join(root, ".agentera");
  fs.mkdirSync(agentera, { recursive: true });
  fs.writeFileSync(path.join(agentera, "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  fs.writeFileSync(path.join(agentera, "todo-reconciliation-activation.json"), todoReconciliationActivationBytes([]));

  const planId = "zzzzzzzzzz";
  const taskIds = Array.from({ length: 21 }, (_, index) => alphaId(index + 200));
  const selectedTaskId = taskIds.at(-1)!;
  const selectedDependencyId = taskIds[0];
  writeEntity(root, "plan", "plan", planId, {
    header: { level: "full", created: "2026-08-02", status: "open", title: "Host-real bounded prime evidence" },
    what: "Preserve executable routing while startup evidence is compacted.",
    why: "Agents must retain one dependency-ready task under the public byte gate.",
    scope: { included: ["prime routing", "history evidence"], excluded: ["lifecycle closeout"] },
  });
  for (const [index, id] of taskIds.entries()) {
    const selected = id === selectedTaskId;
    writeEntity(root, "plan", "plan_task", id, {
      plan: planId,
      name: selected
        ? "Execute the selected host-real routing task"
        : `Completed host-real task ${index + 1}: ${"optional startup detail ".repeat(20).trim()}`,
      status: selected ? "pending" : "complete",
      depends_on: selected ? [selectedDependencyId] : [],
      acceptance: selected
        ? [
            "The bounded plan names this task and its completed dependency.",
            "The executable next action points to exact task retrieval.",
          ]
        : ["Historical task detail is optional at startup."],
    });
  }

  writeEntity(root, "progress", "progress_cycle", "yyyyyyyyyy", {
    timestamp: "2026-08-02 09:00",
    type: "fix",
    phase: "build",
    what: "Full progress evidence",
    context: { intent: "Retain current history counts" },
    publication_order: 1,
  });
  const fullDecisionId = "xxxxxxxxxx";
  writeEntity(root, "decisions", "decision", fullDecisionId, {
    date: "2026-08-02",
    question: "Keep explicit decision state?",
    context: "Prime must not infer satisfaction.",
    alternatives: [{ name: "yes", status: "chosen" }],
    choice: "yes",
    reasoning: "Exact recovery retains full evidence.",
    confidence: "firm",
  });
  writeEntity(root, "decisions", "decision_satisfaction", "wwwwwwwwww", {
    decision: fullDecisionId,
    state: "provisionally_satisfied",
    evidence: "Package and source fixtures retain this explicit state.",
  });
  writeEntity(root, "health", "health_audit", "vvvvvvvvvv", {
    date: "2026-08-02",
    dimensions: ["architecture_alignment"],
    findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
    trajectory: "stable",
    grades: { architecture_alignment: "A" },
    appended_at: "2026-08-02T09:00:00.000Z",
  });

  const summaryIds = { progress: "uuuuuuuuuu", decisions: "ssssssssss", health: "rrrrrrrrrr" };
  writeSummary(root, "progress", summaryIds.progress, { number: 1, summary: "Compacted progress evidence" });
  writeSummary(root, "decisions", summaryIds.decisions, {
    number: 1,
    summary: "Compacted decision evidence",
    satisfaction: { state: "open", review_needed: true, evidence: "Requires exact review" },
  });
  writeSummary(root, "health", summaryIds.health, { number: 1, summary: "Compacted health evidence" });

  return { planId, selectedTaskId, selectedDependencyId, fullDecisionId, summaryIds };
}

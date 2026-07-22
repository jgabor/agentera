import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";

function entityId(index: number): string {
  let value = index;
  const letters = Array.from({ length: 10 }, () => {
    const letter = String.fromCharCode(97 + (value % 26));
    value = Math.floor(value / 26);
    return letter;
  });
  return letters.reverse().join("");
}

type FixtureEntity = {
  id: string;
  artifact: string;
  boundary: string;
  record: Record<string, any>;
};

export function createEntityAuthorityFixture(
  project: string,
  count: number,
  contract: Record<string, any>,
): {
  exactId: string;
  progressCount: number;
  boundaryCounts: Record<string, number>;
  relationshipEdges: string[];
} {
  fs.rmSync(path.join(project, ".agentera"), { recursive: true, force: true });
  fs.mkdirSync(path.join(project, ".agentera"));
  fs.writeFileSync(
    path.join(project, ".agentera", "state-mode.yaml"),
    "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
  );
  const entities: FixtureEntity[] = [];
  const add = (artifact: string, boundary: string, record: Record<string, any>): string => {
    const id = entityId(entities.length);
    const directory = path.join(project, ".agentera", "entities", artifact, boundary);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}.yaml`), dumpYamlMapping({ id, artifact, record }));
    entities.push({ id, artifact, boundary, record });
    return id;
  };
  const progress = (index: number): string =>
    add("progress", "progress_cycle", {
      timestamp: `2026-07-${String((index % 28) + 1).padStart(2, "0")} 00:00`,
      type: "test",
      phase: "audit",
      what: `Fixture ${index}`,
      context: { intent: "Measure" },
    });
  const summary = (
    artifact: "progress" | "decisions" | "health",
    boundary: "progress_summary" | "decision_summary" | "health_summary",
    collection: "cycles" | "decisions" | "audits",
  ): string => {
    const physical = { number: 1, summary: `${artifact} retained summary` };
    const sourcePath = `.agentera/${artifact}.yaml`;
    fs.writeFileSync(path.join(project, sourcePath), dumpYamlMapping({ [collection]: [physical] }));
    return add(artifact, boundary, {
      summary: physical.summary,
      migration_provenance: {
        source_path: sourcePath,
        source_record_sha256: createHash("sha256").update(canonicalRecordJson(physical)).digest("hex"),
      },
    });
  };

  const decisionRecord = {
    date: "2026-07-19",
    question: "Decision 0?",
    context: "Budget graph",
    alternatives: [{ name: "E", status: "chosen" }],
    choice: "E",
    reasoning: "R",
    confidence: "firm",
  };
  const decision = add("decisions", "decision", decisionRecord);
  add("decisions", "decision_satisfaction", {
    decision,
    state: "user_confirmed_satisfied",
    user_confirmation: { confirmed_by: "user", confirmed_at: "2026-07-19T00:00:00Z" },
  });
  add("decisions", "decision_revision", {
    decision,
    date: "2026-07-19",
    provenance: "historical_revision",
    base_sha256: createHash("sha256").update(canonicalRecordJson(decisionRecord)).digest("hex"),
    changes: { choice: "E0" },
  });
  const plan = add("plan", "plan", {
    header: { title: "Plan 0", created: "2026-07-19", status: "complete" },
    what: "W",
    why: "Y",
    scope: { included: ["T"], excluded: [] },
  });
  const dependency = add("plan", "plan_task", {
    plan,
    name: "A",
    status: "complete",
    depends_on: [],
    acceptance: ["V"],
  });
  add("plan", "plan_task", {
    plan,
    name: "B",
    status: "superseded",
    depends_on: [dependency],
    acceptance: ["V"],
    superseded_by: [dependency],
    superseded_reason: "Fixture replacement",
  });
  const objective = add("objective", "objective", {
    header: { title: "Objective 0", status: "complete", created: "2026-07-19" },
    objective: { description: "D", measurement: "M" },
    metric: {},
    baseline: {},
    scope: {},
  });
  add("experiments", "experiment", {
    objective,
    date: "2026-07-19 00:00",
    label: "Experiment 0",
    hypothesis: "H",
    method: "M",
    change: "C",
    metric: {},
    regression: "R",
    status: "baseline",
    conclusion: "C",
  });
  let exactId = progress(0);
  add("health", "health_audit", {
    date: "2026-07-19",
    dimensions: ["test_health"],
    findings_summary: { critical: 0, warning: 0, info: 0 },
    trajectory: "S",
    grades: { test_health: "A" },
  });
  add("todo", "todo_item", { severity: "normal", status: "resolved", description: "TODO 0" });
  add("docs", "documentation_inventory_entry", {
    document: "Doc 0",
    path: "docs/0.md",
    last_updated: "2026-07-19",
    status: "current",
  });
  summary("progress", "progress_summary", "cycles");
  summary("decisions", "decision_summary", "decisions");
  summary("health", "health_summary", "audits");
  while (entities.length < count) {
    const id = progress(entities.length);
    exactId ||= id;
  }
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const relationshipEdges = (
    contract.entity_target.relationships.declarations as Array<Record<string, string>>
  )
    .filter((declaration) =>
      entities.some((entity) => {
        if (entity.boundary !== declaration.source) return false;
        const values = Array.isArray(entity.record[declaration.field])
          ? entity.record[declaration.field]
          : [entity.record[declaration.field]];
        return values.some((id) => byId.get(id)?.boundary === declaration.target);
      }),
    )
    .map((declaration) => `${declaration.source}.${declaration.field}->${declaration.target}`);
  const boundaryCounts = Object.fromEntries(
    (contract.entity_target.entities as Array<Record<string, string>>).map(({ boundary }) => [
      boundary,
      entities.filter((entity) => entity.boundary === boundary).length,
    ]),
  );
  return {
    exactId,
    progressCount: boundaryCounts.progress_cycle + boundaryCounts.progress_summary,
    boundaryCounts,
    relationshipEdges,
  };
}

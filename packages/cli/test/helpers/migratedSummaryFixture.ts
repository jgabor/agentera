import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dumpYamlMapping } from "../../src/core/yaml.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";

export function writeMigratedDecisionAndProgressSummaries(root: string): {
  decisionSource: string;
  progressSource: string;
} {
  const fixtures = [
    {
      artifact: "decisions",
      boundary: "decision_summary",
      id: "aaaaaaaaaa",
      physical: { number: 1, summary: "retained decision evidence", satisfaction: { state: "user_confirmed_satisfied" } },
    },
    {
      artifact: "progress",
      boundary: "progress_summary",
      id: "bbbbbbbbbb",
      physical: { number: 1, summary: "retained progress evidence" },
    },
  ] as const;
  const sources = new Map<string, string>();
  for (const fixture of fixtures) {
    const sourcePath = path.join(root, `.agentera/${fixture.artifact}.yaml`);
    fs.writeFileSync(sourcePath, dumpYamlMapping({ archive: [fixture.physical] }));
    const entityPath = path.join(root, `.agentera/entities/${fixture.artifact}/${fixture.boundary}/${fixture.id}.yaml`);
    fs.mkdirSync(path.dirname(entityPath), { recursive: true });
    fs.writeFileSync(entityPath, dumpYamlMapping({
      id: fixture.id,
      artifact: fixture.artifact,
      record: {
        summary: fixture.physical.summary,
        ...(fixture.artifact === "decisions" ? { satisfaction: fixture.physical.satisfaction } : {}),
        migration_provenance: {
          source_path: `.agentera/${fixture.artifact}.yaml`,
          source_record_sha256: createHash("sha256").update(canonicalRecordJson(fixture.physical)).digest("hex"),
        },
      },
    }));
    sources.set(fixture.artifact, sourcePath);
  }
  return { decisionSource: sources.get("decisions")!, progressSource: sources.get("progress")! };
}

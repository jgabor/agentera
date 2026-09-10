import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dumpYamlMapping } from "../../src/core/yaml.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";

// Read-workload setup only; archivePublication.test.ts guards publisher byte parity.
export function createArchivePerformanceFixture(project: string, entries: number): void {
  const directory = path.join(project, ".agentera", "archive", "progress");
  fs.mkdirSync(directory, { recursive: true });
  for (let number = 1; number <= entries; number += 1) {
    const record = {
      number,
      timestamp: "2026-07-13 16:00",
      type: "test",
      phase: "build",
      what: `Archive fixture ${number}`,
      context: { intent: "Measure archive enumeration" },
    };
    fs.writeFileSync(
      path.join(directory, `${number}.yaml`),
      dumpYamlMapping({
        schemaVersion: "agentera.stateArchiveEntry.v1",
        artifact_id: "progress",
        entry_number: number,
        record,
        record_sha256: createHash("sha256").update(canonicalRecordJson(record), "utf8").digest("hex"),
      }),
    );
  }
}

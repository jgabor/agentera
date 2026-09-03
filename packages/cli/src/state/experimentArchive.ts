import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { dumpYamlMapping } from "../core/yaml.js";
import { assertRealpathBoundary } from "../registries/artifactRegistry.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { reject } from "./write/errors.js";

const AUTHORITY = "references/artifacts/state-storage-authority.yaml";

export interface ExperimentArchivePublication {
  target: string;
  directoryDurabilityRoot: string;
  bytes: string;
  stableId: string;
  recordSha256: string;
  provenance: JsonObject;
}

export function prepareExperimentArchive(projectRoot: string, objectivePath: string, objectiveId: string, experimentNumber: number, record: JsonObject): ExperimentArchivePublication {
  if (record.number !== experimentNumber) throw new Error(`experiment archive record number must equal ${experimentNumber}`);
  const stableId = `${objectiveId}/experiment:${experimentNumber}`;
  const target = path.join(path.dirname(objectivePath), "archive", "experiments", `${experimentNumber}.yaml`);
  assertRealpathBoundary(projectRoot, target, "experiment archive");
  const canonical = canonicalRecordJson(record);
  const recordSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  const provenance: JsonObject = {
    authority: AUTHORITY,
    objective_id: objectiveId,
    experiment_id: stableId,
    storage_scope: "objective_directory",
    publication_order: "archive_before_projection",
  };
  const envelope: JsonObject = {
    schemaVersion: "agentera.experimentArchive.v1",
    stable_id: stableId,
    objective_id: objectiveId,
    experiment_number: experimentNumber,
    record,
    record_sha256: recordSha256,
    provenance,
  };
  return {
    target,
    directoryDurabilityRoot: path.dirname(objectivePath),
    bytes: dumpYamlMapping(envelope),
    stableId,
    recordSha256,
    provenance,
  };
}

export function assertExperimentArchiveReplay(publication: ExperimentArchivePublication): void {
  let existing: Buffer;
  try {
    existing = fs.readFileSync(publication.target);
  } catch {
    reject({
      class: "conflict",
      message: `immutable experiment archive '${publication.target}' could not be read; existing state was preserved`,
      violations: [`immutable archive identity: ${publication.stableId}`],
      recovery: "Repair the unreadable archive record before retrying publication.",
    });
  }
  if (existing.equals(Buffer.from(publication.bytes, "utf8"))) return;
  reject({
    class: "conflict",
    message: `immutable experiment archive '${publication.target}' already exists with different bytes; existing archive and projection were preserved`,
    violations: [`immutable archive identity: ${publication.stableId}`],
    recovery: "Retry only with the byte-equivalent experiment record for this stable identity.",
  });
}

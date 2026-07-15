import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { splitLinesKeepEnds, unifiedDiff } from "../../core/difflib.js";
import { dumpYamlMapping, loadYamlMapping } from "../../core/yaml.js";
import { compactYamlFile, type CompactResult } from "../../hooks/compaction/index.js";
import { assertRealpathBoundary } from "../../registries/artifactRegistry.js";
import {
  assertExperimentArchiveReplay,
  prepareExperimentArchive,
  type ExperimentArchivePublication,
} from "../experimentArchive.js";
import {
  ExperimentIdentityError,
  discoverObjectiveArtifacts,
  inspectExperimentIdentities,
  validateExperimentPublicationIdentity,
} from "../experimentIdentity.js";
import type { JsonObject } from "../../core/jsonValue.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./transaction.js";
import type { StateMutationTransaction } from "./mutation.js";
import { reject } from "./errors.js";
import { schemaViolation } from "./helpers.js";
import { validateArtifactBytes } from "./validate.js";

function array(doc: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return Array.isArray(doc[key])
    ? (doc[key] as unknown[]).filter((value): value is Record<string, unknown> =>
        Boolean(value && typeof value === "object" && !Array.isArray(value)))
    : [];
}

function readExisting(target: string): { doc: Record<string, unknown>; bytes: string } {
  if (!fs.existsSync(target)) return { doc: {}, bytes: "" };
  const bytes = fs.readFileSync(target, "utf8");
  try {
    return { doc: loadYamlMapping(bytes), bytes };
  } catch (error) {
    throw new Error(
      `cannot parse existing artifact '${target}': ${(error as Error).message}; run agentera check validate artifact before retrying`,
    );
  }
}

function diffText(before: string, after: string, target: string): string {
  return unifiedDiff(splitLinesKeepEnds(before), splitLinesKeepEnds(after), target, target).join("");
}

function rejectIdentity(error: ExperimentIdentityError): never {
  reject({
    class: error.className === "invalid_request"
      ? "invalid_request"
      : error.className === "not_found"
        ? "unsupported_target"
        : "conflict",
    message: error.message,
    syntax: "agentera state experiments publish --objective OBJECTIVE_ID --number N --input EXPERIMENT.yaml --format json",
    example: "agentera state experiments publish --objective objective:123e4567-e89b-42d3-a456-426614174000 --number 0 --input experiment.yaml --format json",
    recovery: "Correct the objective or experiment identity and retry; no state was changed.",
  });
}

function envelope(
  req: StateWriteRequest,
  target: string,
  doc: Record<string, unknown>,
  written: Record<string, unknown>,
  assigned: Record<string, unknown>,
  replay: boolean,
  compaction: CompactResult | null,
  archive?: ExperimentArchivePublication & { replay: boolean },
  preview?: { diff: string; before: Record<string, unknown>; after: Record<string, unknown> },
): StateWriteEnvelope {
  return {
    schemaVersion: "agentera.stateWrite.v1",
    command: "state experiments publish",
    status: "pass",
    artifact: "experiments",
    path: target,
    operation: { verb: "publish", dry_run: req.dryRun, idempotent_replay: replay, forced: false },
    assigned,
    written,
    state: {
      active_count: array(doc, "experiments").length,
      archive_count: array(doc, "archive").length,
    },
    validation: { status: "pass", violations: [] },
    compaction,
    ...(archive ? {
      archive: {
        path: archive.target,
        stable_id: archive.stableId,
        record_sha256: archive.recordSha256,
        provenance: archive.provenance,
        idempotent_replay: archive.replay,
      },
    } : {}),
    ...(preview ?? {}),
  };
}

export function executeExperimentPublication(
  req: StateWriteRequest,
  transaction?: StateMutationTransaction,
): StateWriteEnvelope {
  const objectiveId = String(req.values.objective ?? "");
  const number = Number(req.values.number);
  const input = structuredClone(req.input ?? {});
  if ("number" in input)
    reject({
      class: "schema_violation",
      message: "experiments publish assigns number; remove 'number' from the input document",
      violations: ["CLI-owned field: number"],
    });

  const discovery = discoverObjectiveArtifacts(req.projectRoot);
  const objective = discovery.objectives.find((candidate) => candidate.stableId === objectiveId);
  try {
    validateExperimentPublicationIdentity(discovery, { objectiveId, entries: [], caveats: [] }, objectiveId, number);
  } catch (error) {
    if (error instanceof ExperimentIdentityError) rejectIdentity(error);
    throw error;
  }
  const canonicalPaths = objective?.paths.filter((candidate) =>
    candidate.includes(`${path.sep}.agentera${path.sep}optimize${path.sep}`)) ?? [];
  const objectivePath = objective?.paths.length === 1
    ? objective.paths[0]
    : canonicalPaths.length === 1
      ? canonicalPaths[0]
      : null;
  if (!objectivePath)
    reject({
      class: "conflict",
      message: `objective identity ${objectiveId} does not resolve to one publication target; no effects are allowed`,
      recovery: `Resolve the objective path collision (${(objective?.paths ?? []).join(", ") || "no candidates"}) and retry; no state was changed.`,
    });
  const target = path.join(path.dirname(objectivePath), "experiments.yaml");
  assertRealpathBoundary(req.projectRoot, target, "experiments");
  const existing = readExisting(target);
  if (existing.bytes) {
    const violations = validateArtifactBytes("experiments", existing.bytes);
    if (violations.length)
      throw new Error(`existing artifact '${target}' is schema-invalid: ${violations.join("; ")}; repair it before retrying`);
  }

  const projection = inspectExperimentIdentities(objectiveId, existing.doc as JsonObject);
  const written = { number, ...input };
  const stableId = `${objectiveId}/experiment:${number}`;
  const assigned = { objective: objectiveId, number, stable_id: stableId };
  const retained = projection.entries.filter((entry) => entry.stableId === stableId);
  if (retained.length === 1 && retained[0].addressable && isDeepStrictEqual(retained[0].data, written)) {
    const archive = prepareExperimentArchive(
      req.projectRoot,
      objectivePath,
      objectiveId,
      number,
      written as JsonObject,
    );
    const archiveExists = fs.existsSync(archive.target);
    let archiveReplay = archiveExists;
    if (archiveExists) {
      assertExperimentArchiveReplay(archive);
    } else if (!req.dryRun) {
      const published = transaction?.publishExperimentArchive(
        archive,
        () => assertExperimentArchiveReplay(archive),
      );
      if (published === undefined) throw new Error("state mutation transaction is unavailable");
      archiveReplay = !published;
    }
    const preview = req.dryRun ? { diff: "", before: existing.doc, after: existing.doc } : undefined;
    return envelope(
      req,
      target,
      existing.doc,
      written,
      assigned,
      true,
      null,
      { ...archive, replay: archiveReplay },
      preview,
    );
  }
  try {
    validateExperimentPublicationIdentity(discovery, projection, objectiveId, number);
  } catch (error) {
    if (error instanceof ExperimentIdentityError) rejectIdentity(error);
    throw error;
  }

  const inputViolations = validateArtifactBytes("experiments", dumpYamlMapping({ experiments: [written] }));
  if (inputViolations.length) schemaViolation(inputViolations);
  const candidate = structuredClone(existing.doc);
  candidate.experiments = [...array(candidate, "experiments"), written];
  const candidateBytes = dumpYamlMapping(candidate);
  const candidateViolations = validateArtifactBytes("experiments", candidateBytes);
  if (candidateViolations.length) schemaViolation(candidateViolations);
  const archive = prepareExperimentArchive(
    req.projectRoot,
    objectivePath,
    objectiveId,
    number,
    written as JsonObject,
  );

  const stage = req.dryRun
    ? path.join(path.dirname(target), `.${path.basename(target)}.writer.${process.pid}.${Date.now()}.tmp`)
    : transaction?.stageProjection(target, candidateBytes);
  if (!stage) throw new Error("state mutation transaction is unavailable");
  let compaction: CompactResult | null = null;
  try {
    if (req.dryRun) fs.writeFileSync(stage, candidateBytes);
    if (req.spec.compacts) compaction = compactYamlFile(stage, "experiments", req.projectRoot);
    const finalBytes = fs.readFileSync(stage, "utf8");
    const finalViolations = validateArtifactBytes("experiments", finalBytes);
    if (finalViolations.length)
      throw new Error(`writer/compactor invariant failure: ${finalViolations.join("; ")}`);
    const finalDoc = loadYamlMapping(finalBytes);
    const preview = req.dryRun
      ? { diff: diffText(existing.bytes, finalBytes, target), before: existing.doc, after: finalDoc }
      : undefined;
    if (!req.dryRun) {
      transaction?.syncStaged(stage);
      const published = transaction?.publishExperimentArchive(
        archive,
        () => assertExperimentArchiveReplay(archive),
      );
      if (published === undefined) throw new Error("state mutation transaction is unavailable");
      transaction?.publishProjection(stage, target, existing.bytes);
      return envelope(
        req,
        target,
        finalDoc,
        written,
        assigned,
        false,
        compaction,
        { ...archive, replay: !published },
        preview,
      );
    }
    return envelope(
      req,
      target,
      finalDoc,
      written,
      assigned,
      false,
      compaction,
      { ...archive, replay: false },
      preview,
    );
  } finally {
    try {
      if (req.dryRun) fs.unlinkSync(stage);
      else transaction?.removeStage(stage);
    } catch {
      /* stage published or absent */
    }
  }
}

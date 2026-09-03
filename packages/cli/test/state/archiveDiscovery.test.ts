import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { discoverPlanArtifacts } from "../../src/cli/planArtifacts.js";
import type { JsonObject, JsonValue } from "../../src/core/jsonValue.js";
import { discoverNumberedArchives } from "../../src/state/archiveDiscovery.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-archive-discovery-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function record(artifact: "progress" | "decisions" | "health", number: number): JsonObject {
  if (artifact === "progress") {
    return {
      number,
      timestamp: "2026-07-13 12:00",
      type: "test",
      phase: "build",
      what: "Validate numbered archive discovery",
      context: { intent: "Prove archive validation", constraints: "Keep plan archives unchanged" },
    };
  }
  if (artifact === "decisions") {
    return {
      number,
      date: "2026-07-13",
      question: "Where should immutable records live?",
      context: "The project needs lossless local history.",
      alternatives: [
        { name: "Project archive", status: "chosen" },
        { name: "External database", status: "rejected" },
      ],
      choice: "Use the project archive.",
      reasoning: "It keeps state local and inspectable.",
      confidence: "firm",
    };
  }
  return {
    number,
    date: "2026-07-13",
    dimensions: ["test_health"],
    findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
    trajectory: "stable",
    grades: { test_health: "A" },
  };
}

function envelope(artifact: "progress" | "decisions" | "health", number: number): JsonObject {
  const entry = record(artifact, number);
  return {
    schemaVersion: "agentera.stateArchiveEntry.v1",
    artifact_id: artifact,
    entry_number: number,
    record: entry,
    record_sha256: createHash("sha256").update(canonicalJson(entry), "utf8").digest("hex"),
  };
}

function writeEnvelope(root: string, artifact: "progress" | "decisions" | "health", filename: string, value: JsonObject | string): string {
  const target = path.join(root, ".agentera", "archive", artifact, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  return target;
}

function writeEntry(root: string, artifact: "progress" | "decisions" | "health", number: number, filename = `${number}.yaml`): string {
  return writeEnvelope(root, artifact, filename, envelope(artifact, number));
}

describe("numbered archive discovery", () => {
  it.each([
    ["progress", 12],
    ["decisions", 11],
    ["health", 10],
  ] as const)("accepts a valid %s record fixture", (artifact, number) => {
    const root = project();
    const archivePath = writeEntry(root, artifact, number);

    const discovered = discoverNumberedArchives(root, { sourceRoot: REPO_ROOT });

    expect(discovered.rejected).toEqual([]);
    expect(discovered.entries).toHaveLength(1);
    expect(discovered.entries[0]).toMatchObject({
      path: archivePath,
      stableId: `${artifact}:${number}`,
      artifactId: artifact,
      entryNumber: number,
      record: record(artifact, number),
    });
  });

  it.each(["progress", "decisions", "health"] as const)("rejects a malformed %s filename fixture", (artifact) => {
    const root = project();
    const malformedPath = writeEntry(root, artifact, 1, "not-a-number.yaml");

    const discovered = discoverNumberedArchives(root, { sourceRoot: REPO_ROOT });

    expect(discovered.entries).toEqual([]);
    expect(discovered.rejected).toContainEqual(
      expect.objectContaining({
        path: malformedPath,
        reason: "malformed_name",
        class: "corrupt",
      }),
    );
  });

  it("orders accepted records numerically and attributes each record to one supported artifact", () => {
    const root = project();
    writeEntry(root, "progress", 10);
    writeEntry(root, "progress", 2);
    writeEntry(root, "decisions", 2);
    writeEntry(root, "health", 1);

    const discovered = discoverNumberedArchives(root, { sourceRoot: REPO_ROOT });

    expect(discovered.entries.map((entry) => entry.stableId)).toEqual(["progress:10", "decisions:2", "progress:2", "health:1"]);
    expect(new Set(discovered.entries.map((entry) => entry.artifactId))).toEqual(new Set(["progress", "decisions", "health"]));
  });

  it("rejects malformed envelopes, hashes, record identities, and duplicate IDs", () => {
    const root = project();
    const missingSchema = envelope("progress", 3);
    delete missingSchema.schemaVersion;
    const missingSchemaPath = writeEnvelope(root, "progress", "3.yaml", missingSchema);

    const badHash = envelope("decisions", 4);
    badHash.record_sha256 = "0".repeat(64);
    const badHashPath = writeEnvelope(root, "decisions", "4.yaml", badHash);

    const wrongRecordNumber = envelope("health", 5);
    (wrongRecordNumber.record as JsonObject).number = 6;
    const wrongRecordNumberPath = writeEnvelope(root, "health", "5.yaml", wrongRecordNumber);

    const invalidRecord = envelope("progress", 7);
    invalidRecord.record = { number: 7 };
    invalidRecord.record_sha256 = createHash("sha256").update(canonicalJson(invalidRecord.record), "utf8").digest("hex");
    const invalidRecordPath = writeEnvelope(root, "progress", "7.yaml", invalidRecord);

    writeEntry(root, "progress", 1);
    const duplicatePath = writeEntry(root, "progress", 1, "01.yaml");
    const malformedYamlPath = writeEnvelope(root, "health", "6.yaml", "record: [broken\n");

    const discovered = discoverNumberedArchives(root, { sourceRoot: REPO_ROOT });

    expect(discovered.entries.map((entry) => entry.stableId)).toEqual(["progress:1"]);
    expect(discovered.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: missingSchemaPath, reason: "invalid_envelope" }),
        expect.objectContaining({ path: badHashPath, reason: "hash_mismatch" }),
        expect.objectContaining({ path: wrongRecordNumberPath, reason: "invalid_envelope" }),
        expect.objectContaining({ path: invalidRecordPath, reason: "record_schema" }),
        expect.objectContaining({ path: duplicatePath, reason: "duplicate_identity" }),
        expect.objectContaining({ path: malformedYamlPath, reason: "invalid_envelope" }),
      ]),
    );
  });

  it("rejects unsafe paths and symlinked archive records without following them", () => {
    const root = project();
    const outside = path.join(project(), "outside.yaml");
    fs.writeFileSync(outside, JSON.stringify(envelope("progress", 1)));
    const symlinkPath = path.join(root, ".agentera", "archive", "progress", "1.yaml");
    fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
    fs.symlinkSync(outside, symlinkPath);

    const discovered = discoverNumberedArchives(root, { sourceRoot: REPO_ROOT });

    expect(discovered.entries).toEqual([]);
    expect(discovered.rejected).toContainEqual(
      expect.objectContaining({
        path: symlinkPath,
        reason: "symlink",
      }),
    );
  });

  it("rejects an archive root symlink that escapes the project boundary", () => {
    const root = project();
    const outsideArchive = path.join(project(), "archive");
    fs.mkdirSync(outsideArchive, { recursive: true });
    const archiveRoot = path.join(root, ".agentera", "archive");
    fs.mkdirSync(path.dirname(archiveRoot), { recursive: true });
    fs.symlinkSync(outsideArchive, archiveRoot, "dir");

    const discovered = discoverNumberedArchives(root, { sourceRoot: REPO_ROOT });

    expect(discovered.entries).toEqual([]);
    expect(discovered.rejected).toContainEqual(
      expect.objectContaining({
        path: archiveRoot,
        reason: "symlink",
      }),
    );
  });

  it("ignores unrelated root archives and leaves plan archive catalog behavior unchanged", () => {
    const root = project();
    const archiveRoot = path.join(root, ".agentera", "archive");
    fs.mkdirSync(archiveRoot, { recursive: true });
    const planPath = path.join(archiveRoot, "PLAN-2026-07-13-history.yaml");
    fs.writeFileSync(planPath, ["header:", "  title: Historical plan", "  status: complete", "  created: '2026-07-13'", "tasks:", "  - number: 1", "    name: Preserve archive", "    status: complete", ""].join("\n"));
    const visionPath = path.join(archiveRoot, "vision-2026-07-13.yaml");
    fs.writeFileSync(visionPath, "identity:\n  voice: direct\n");
    const unrelatedPath = path.join(archiveRoot, "notes.yaml");
    fs.writeFileSync(unrelatedPath, "notes: unrelated\n");
    writeEntry(root, "progress", 1);

    const discovered = discoverNumberedArchives(root, { sourceRoot: REPO_ROOT });
    const planCatalog = discoverPlanArtifacts(path.join(root, ".agentera", "plan.yaml"));

    expect(discovered.entries.map((entry) => entry.stableId)).toEqual(["progress:1"]);
    expect(discovered.ignored).toEqual(expect.arrayContaining([planPath, visionPath, unrelatedPath]));
    expect(planCatalog.archived.map((archive) => archive.path)).toEqual([planPath]);
    expect(planCatalog.archived[0]?.data.header).toMatchObject({
      title: "Historical plan",
      status: "complete",
    });
  });

  it("rejects an unsupported numbered artifact directory", () => {
    const root = project();
    const unsupportedPath = path.join(root, ".agentera", "archive", "experiments", "1.yaml");
    fs.mkdirSync(path.dirname(unsupportedPath), { recursive: true });
    fs.writeFileSync(unsupportedPath, "record: unsupported\n");

    const discovered = discoverNumberedArchives(root, { sourceRoot: REPO_ROOT });

    expect(discovered.rejected).toContainEqual(
      expect.objectContaining({
        path: path.dirname(unsupportedPath),
        class: "unsupported_artifact",
        reason: "unsupported_artifact",
      }),
    );
  });
});

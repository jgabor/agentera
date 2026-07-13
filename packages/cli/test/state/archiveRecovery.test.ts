import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { checkCompaction, compactYamlBytes } from "../../src/hooks/compaction/index.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import {
  gateProjectionEntries,
  verifyArchiveForProjection,
} from "../../src/state/archiveRecovery.js";

const roots: string[] = [];
const sourceRoot = path.resolve(import.meta.dirname, "../../../..");

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-archive-recovery-"));
  roots.push(root);
  return root;
}

function progressEntry(number: number): Record<string, unknown> {
  return {
    number,
    timestamp: `2026-07-${String(number).padStart(2, "0")} 10:00`,
    type: "feat",
    phase: "build",
    what: `Cycle ${number}`,
    context: { intent: "Test archive recovery gating" },
  };
}

function overLimitBytes(entry: Record<string, unknown>): string {
  return YAML.stringify({
    cycles: [entry, ...Array.from({ length: 10 }, (_, index) => progressEntry(index + 2))],
    archive: [],
  });
}

function expectFailureReason(
  recovery: ReturnType<typeof verifyArchiveForProjection>,
  reason: string,
): void {
  expect(recovery.reason).toBe(reason);
  expect(recovery.source).toBe("current_projection");
  expect(recovery.detail_availability).toBe("full");
  expect(recovery.error).toMatchObject({
    schemaVersion: "agentera.stateFailure.v1",
    class: reason,
    syntax: "agentera check compact --mode fix --format json",
    example: "agentera check compact --mode fix --format json",
  });
  expect(recovery.error?.recovery).toBeTruthy();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("projection archive recovery gate", () => {
  it("allows a full entry to become a summary only after record and hash verification", () => {
    const root = project();
    const entry = progressEntry(1);
    publishNumberedArchive(root, "progress", 1, entry, { sourceRoot });

    const recovery = verifyArchiveForProjection(root, "progress", entry, { sourceRoot });
    expect(recovery).toMatchObject({
      stable_id: "progress:1",
      status: "complete",
      reason: "verified",
      detail_availability: "full",
      source: "archive",
    });

    const result = compactYamlBytes(overLimitBytes(entry), "progress", root);
    expect(result.result).toMatchObject({ full_after: 10, oneline_after: 1 });
    expect(result.result.recovery).toMatchObject({
      status: "complete",
      attempted: 1,
      verified: 1,
      retained_full: 0,
      refused_count: 0,
    });
    expect((YAML.parse(result.bytes) as { cycles: unknown[] }).cycles).toHaveLength(10);
  });

  it("retains the full entry and reports not_found when its archive is absent", () => {
    const root = project();
    const entry = progressEntry(1);
    const result = compactYamlBytes(overLimitBytes(entry), "progress", root);

    expectFailureReason(verifyArchiveForProjection(root, "progress", entry, { sourceRoot }), "not_found");
    expect(result.result.recovery).toMatchObject({ status: "degraded", retained_full: 1, refused_count: 1 });
    const projected = YAML.parse(result.bytes) as { cycles: Array<Record<string, unknown>>; archive: unknown[] };
    expect(projected.cycles).toHaveLength(11);
    expect(projected.cycles.find((candidate) => candidate.number === 1)?.what).toBe("Cycle 1");
    expect(projected.archive).toHaveLength(0);
  });

  it("reports a safe refusal from the read-only compaction gate instead of hiding the missing archive", () => {
    const root = project();
    const entry = progressEntry(1);
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera", "progress.yaml"), overLimitBytes(entry));
    const refused = checkCompaction(root).find((candidate) => candidate.status.artifact === "progress");
    expect(refused?.action).toBe("refused");
    expect(refused?.status.projection_recovery).toMatchObject({
      status: "degraded",
      retained_full: 1,
      refused_count: 1,
    });
  });

  it("retains the full entry and reports corrupt when its archive hash is invalid", () => {
    const root = project();
    const entry = progressEntry(1);
    publishNumberedArchive(root, "progress", 1, entry, { sourceRoot });
    const archivePath = path.join(root, ".agentera", "archive", "progress", "1.yaml");
    fs.writeFileSync(
      archivePath,
      fs.readFileSync(archivePath, "utf8").replace(/record_sha256: [0-9a-f]{64}/, `record_sha256: ${"0".repeat(64)}`),
    );

    const result = compactYamlBytes(overLimitBytes(entry), "progress", root);
    expectFailureReason(verifyArchiveForProjection(root, "progress", entry, { sourceRoot }), "corrupt");
    expect(result.result.recovery).toMatchObject({ status: "blocked", retained_full: 1, refused_count: 1 });
    expect((YAML.parse(result.bytes) as { cycles: Array<Record<string, unknown>> }).cycles).toHaveLength(11);
  });

  it("retains the full entry and reports immutable_conflict for a different valid record", () => {
    const root = project();
    const entry = progressEntry(1);
    publishNumberedArchive(root, "progress", 1, { ...entry, what: "Different immutable record" }, { sourceRoot });

    const result = compactYamlBytes(overLimitBytes(entry), "progress", root);
    expectFailureReason(
      verifyArchiveForProjection(root, "progress", entry, { sourceRoot }),
      "immutable_conflict",
    );
    expect(result.result.recovery).toMatchObject({ status: "blocked", retained_full: 1, refused_count: 1 });
    expect((YAML.parse(result.bytes) as { cycles: Array<Record<string, unknown>> }).cycles).toHaveLength(11);
  });

  it("retains the full entry and reports unsupported_state for an archive schema it cannot read", () => {
    const root = project();
    const entry = progressEntry(1);
    publishNumberedArchive(root, "progress", 1, entry, { sourceRoot });
    const archivePath = path.join(root, ".agentera", "archive", "progress", "1.yaml");
    fs.writeFileSync(
      archivePath,
      fs.readFileSync(archivePath, "utf8").replace(
        "schemaVersion: agentera.stateArchiveEntry.v1",
        "schemaVersion: agentera.stateArchiveEntry.v2",
      ),
    );

    const result = compactYamlBytes(overLimitBytes(entry), "progress", root);
    expectFailureReason(
      verifyArchiveForProjection(root, "progress", entry, { sourceRoot }),
      "unsupported_state",
    );
    expect(result.result.recovery).toMatchObject({ status: "unsupported", retained_full: 1, refused_count: 1 });
    expect((YAML.parse(result.bytes) as { cycles: Array<Record<string, unknown>> }).cycles).toHaveLength(11);
  });

  it("refuses an unsupported artifact state with the same structured gate contract", () => {
    const root = project();
    const entry = progressEntry(1);
    const gate = gateProjectionEntries(root, "vision", [entry], { sourceRoot });

    expect(gate.verified).toEqual([]);
    expect(gate.refused).toHaveLength(1);
    expectFailureReason(gate.refused[0].recovery, "unsupported_state");
    expect(gate.recovery).toMatchObject({ status: "unsupported", retained_full: 1, refused_count: 1 });
  });
});

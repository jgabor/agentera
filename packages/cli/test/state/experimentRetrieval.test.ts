import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { prepareExperimentArchive } from "../../src/state/experimentArchive.js";
import { resolveObjectiveIdentity } from "../../src/state/experimentIdentity.js";

const roots: string[] = [];
const objectiveId = "objective:123e4567-e89b-42d3-a456-426614174000";
const otherObjectiveId = "objective:223e4567-e89b-42d3-a456-426614174000";

function objective(id: string | undefined = objectiveId, description = "Reduce latency") {
  return {
    header: { ...(id ? { id } : {}), title: "Latency", status: "open" },
    objective: { description, measurement: "p95", constraints: [] },
    metric: { direction: "minimize", unit: "ms" },
    baseline: { description: "100 ms" },
    gates: {},
    scope: { included: ["CLI"], excluded: [] },
  };
}

function experiment(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    date: `2026-07-${String((number % 28) + 1).padStart(2, "0")} 09:00`,
    label: `Experiment ${number}`,
    hypothesis: "Stable keys reduce lookup time",
    method: "Run the locked benchmark",
    change: "Use stable cache keys",
    metric: { primary_value: `${100 - number} ms`, delta_vs_baseline: `-${number} ms` },
    regression: "pnpm test passed",
    status: number % 2 ? "failed" : "kept",
    conclusion: `Experiment ${number} completed`,
    ...extra,
  };
}

function project(id = objectiveId, rootName: "optimize" | "optimera" = "optimize", slug = "latency") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-experiment-retrieval-"));
  roots.push(root);
  const directory = path.join(root, ".agentera", rootName, slug);
  fs.mkdirSync(directory, { recursive: true });
  const objectivePath = path.join(directory, "objective.yaml");
  fs.writeFileSync(objectivePath, dumpYamlMapping(objective(id)));
  return { root, directory, objectivePath, experimentsPath: path.join(directory, "experiments.yaml") };
}

function writeArchive(root: string, objectivePath: string, id: string, record: Record<string, unknown>): string {
  const publication = prepareExperimentArchive(root, objectivePath, id, Number(record.number), record);
  fs.mkdirSync(path.dirname(publication.target), { recursive: true });
  fs.writeFileSync(publication.target, publication.bytes);
  return publication.target;
}

function writeProjection(experimentsPath: string, records: Record<string, unknown>[]): void {
  fs.writeFileSync(experimentsPath, dumpYamlMapping({
    experiments: records.slice(-10),
    archive: records.slice(-50, -10).map((record) => ({ number: record.number, summary: record.conclusion })),
  }));
}

function capture(root: string, args: string[]) {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", "state", "experiments", ...args], {
      out: (text) => { out += text; },
      err: (text) => { err += text; },
    });
    return { rc, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
  } finally {
    process.chdir(previous);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("objective-scoped experiment list and get", () => {
  it("pages newest-first without duplicate or skipped identities across projection and archive", () => {
    const fixture = project();
    const records = Array.from({ length: 24 }, (_, number) => experiment(number));
    fs.writeFileSync(fixture.experimentsPath, dumpYamlMapping({
      experiments: records.slice(14),
      archive: records.slice(0, 14).map((record) => ({ number: record.number, summary: record.conclusion })),
    }));
    for (const record of records.slice(0, 18)) writeArchive(fixture.root, fixture.objectivePath, objectiveId, record);

    const identities: string[] = [];
    let cursor: string | undefined;
    do {
      const result = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", "5", ...(cursor ? ["--cursor", cursor] : []), "--format", "json"]);
      expect(result.rc).toBe(0);
      expect(result.json.entries).toHaveLength(Math.min(5, 24 - identities.length));
      identities.push(...result.json.entries.map((entry: any) => entry.stable_id));
      cursor = result.json.next_cursor;
      if (cursor) expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    } while (cursor);

    expect(identities).toEqual(Array.from({ length: 24 }, (_, index) => `${objectiveId}/experiment:${23 - index}`));
    expect(new Set(identities).size).toBe(24);
  });

  it("binds cursors to an immutable objective snapshot while excluding later publication", () => {
    const fixture = project();
    fs.writeFileSync(fixture.experimentsPath, dumpYamlMapping({ experiments: [experiment(0), experiment(1), experiment(2)] }));
    const first = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", "1", "--format", "json"]).json;
    expect(first.entries[0].experiment_number).toBe(2);
    expect(first.omitted).toBe(true);

    fs.writeFileSync(fixture.experimentsPath, dumpYamlMapping({ experiments: [experiment(0), experiment(1), experiment(2), experiment(3)] }));
    const second = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", "10", "--cursor", first.next_cursor, "--format", "json"]);
    expect(second.rc).toBe(0);
    expect(second.json.entries.map((entry: any) => entry.experiment_number)).toEqual([1, 0]);

    fs.writeFileSync(fixture.experimentsPath, dumpYamlMapping({ experiments: [experiment(0), experiment(1, { label: "changed" }), experiment(2), experiment(3)] }));
    const stale = capture(fixture.root, ["list", "--objective", objectiveId, "--cursor", first.next_cursor, "--format", "json"]);
    expect(stale.rc).toBe(1);
    expect(stale.json.error.class).toBe("cursor_snapshot_unavailable");
  });

  it("continues across append-driven full-to-summary rollover when archives prove original detail", () => {
    const fixture = project();
    const original = Array.from({ length: 10 }, (_, number) => experiment(number));
    writeProjection(fixture.experimentsPath, original);
    for (const record of original) writeArchive(fixture.root, fixture.objectivePath, objectiveId, record);

    const first = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", "1", "--format", "json"]).json;
    expect(first.entries.map((entry: any) => entry.experiment_number)).toEqual([9]);

    const appended = [...original, experiment(10)];
    writeProjection(fixture.experimentsPath, appended);
    writeArchive(fixture.root, fixture.objectivePath, objectiveId, appended[10]);
    const continued = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", "20", "--cursor", first.next_cursor, "--format", "json"]);

    expect(continued.rc).toBe(0);
    expect(continued.json.entries.map((entry: any) => entry.experiment_number)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(continued.json.entries.some((entry: any) => entry.experiment_number === 10)).toBe(false);
    expect(continued.json.entries.at(-1)).toMatchObject({ experiment_number: 0, detail_availability: "full", source: "archive_and_projection" });
  });

  it("continues across summary-to-drop rollover and traverses the original snapshot exactly once", () => {
    const fixture = project();
    const original = Array.from({ length: 50 }, (_, number) => experiment(number));
    writeProjection(fixture.experimentsPath, original);
    for (const record of original) writeArchive(fixture.root, fixture.objectivePath, objectiveId, record);

    const seen: number[] = [];
    let page = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", "7", "--format", "json"]).json;
    seen.push(...page.entries.map((entry: any) => entry.experiment_number));

    const appended = [...original, experiment(50)];
    writeProjection(fixture.experimentsPath, appended);
    writeArchive(fixture.root, fixture.objectivePath, objectiveId, appended[50]);
    while (page.next_cursor) {
      const result = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", "7", "--cursor", page.next_cursor, "--format", "json"]);
      expect(result.rc).toBe(0);
      page = result.json;
      seen.push(...page.entries.map((entry: any) => entry.experiment_number));
    }

    expect(seen).toEqual(Array.from({ length: 50 }, (_, index) => 49 - index));
    expect(new Set(seen).size).toBe(50);
    expect(seen).not.toContain(50);
  });

  it("rejects rollover without archive proof plus mutation, archive corruption, and deletion", () => {
    const withoutArchive = project();
    const original = Array.from({ length: 10 }, (_, number) => experiment(number));
    writeProjection(withoutArchive.experimentsPath, original);
    const unsupported = capture(withoutArchive.root, ["list", "--objective", objectiveId, "--limit", "1", "--format", "json"]).json;
    writeProjection(withoutArchive.experimentsPath, [...original, experiment(10)]);
    const unsubstantiated = capture(withoutArchive.root, ["list", "--objective", objectiveId, "--cursor", unsupported.next_cursor, "--format", "json"]);
    expect(unsubstantiated.rc).toBe(1);
    expect(unsubstantiated.json.error.class).toBe("cursor_snapshot_unavailable");

    const droppedSummary = project();
    const fifty = Array.from({ length: 50 }, (_, number) => experiment(number));
    writeProjection(droppedSummary.experimentsPath, fifty);
    const dropCursor = capture(droppedSummary.root, ["list", "--objective", objectiveId, "--limit", "1", "--format", "json"]).json.next_cursor;
    writeProjection(droppedSummary.experimentsPath, [...fifty, experiment(50)]);
    const unprovableDrop = capture(droppedSummary.root, ["list", "--objective", objectiveId, "--cursor", dropCursor, "--format", "json"]);
    expect(unprovableDrop.rc).toBe(1);
    expect(unprovableDrop.json.error.class).toBe("cursor_snapshot_unavailable");

    const mutated = project();
    writeProjection(mutated.experimentsPath, original);
    for (const record of original) writeArchive(mutated.root, mutated.objectivePath, objectiveId, record);
    const mutationCursor = capture(mutated.root, ["list", "--objective", objectiveId, "--limit", "1", "--format", "json"]).json.next_cursor;
    writeProjection(mutated.experimentsPath, original.map((record) => record.number === 5 ? experiment(5, { label: "mutated" }) : record));
    const mutation = capture(mutated.root, ["list", "--objective", objectiveId, "--cursor", mutationCursor, "--format", "json"]);
    expect(mutation.rc).toBe(1);
    expect(mutation.json.error.class).toBe("cursor_snapshot_unavailable");

    const corrupted = project();
    writeProjection(corrupted.experimentsPath, original);
    for (const record of original) writeArchive(corrupted.root, corrupted.objectivePath, objectiveId, record);
    const corruptionCursor = capture(corrupted.root, ["list", "--objective", objectiveId, "--limit", "1", "--format", "json"]).json.next_cursor;
    fs.writeFileSync(path.join(corrupted.directory, "archive", "experiments", "0.yaml"), "schemaVersion: wrong\n");
    const corruption = capture(corrupted.root, ["list", "--objective", objectiveId, "--cursor", corruptionCursor, "--format", "json"]);
    expect(corruption.rc).toBe(1);
    expect(corruption.json.error.class).toBe("cursor_snapshot_unavailable");

    const deleted = project();
    writeProjection(deleted.experimentsPath, original);
    for (const record of original) writeArchive(deleted.root, deleted.objectivePath, objectiveId, record);
    const deletionCursor = capture(deleted.root, ["list", "--objective", objectiveId, "--limit", "1", "--format", "json"]).json.next_cursor;
    writeProjection(deleted.experimentsPath, original.slice(1));
    fs.rmSync(path.join(deleted.directory, "archive", "experiments", "0.yaml"));
    const deletion = capture(deleted.root, ["list", "--objective", objectiveId, "--cursor", deletionCursor, "--format", "json"]);
    expect(deletion.rc).toBe(1);
    expect(deletion.json.error.class).toBe("cursor_snapshot_unavailable");
  });

  it("prefers verified immutable archive detail and exposes retained and summary-only compatibility", () => {
    const fixture = project();
    fs.writeFileSync(fixture.experimentsPath, dumpYamlMapping({
      experiments: [experiment(0), experiment(2)],
      archive: [{ number: 1, summary: "Legacy summary only" }, { number: 3 }],
    }));
    writeArchive(fixture.root, fixture.objectivePath, objectiveId, experiment(0));

    const archived = capture(fixture.root, ["get", "--objective", objectiveId, "--number", "0", "--format", "json"]);
    expect(archived.rc).toBe(0);
    expect(archived.json.entry).toMatchObject({ experiment_number: 0, detail_availability: "full", source: "archive_and_projection" });
    expect(archived.json.source).toMatchObject({ selected: "immutable_archive", archive_verified: true, projection_verified_against_archive: true });
    expect(archived.json.record.label).toBe("Experiment 0");

    const retained = capture(fixture.root, ["get", "--objective", objectiveId, "--number", "2", "--format", "json"]);
    expect(retained.rc).toBe(0);
    expect(retained.json.entry).toMatchObject({ detail_availability: "full", compatibility: "legacy_full_without_archive" });
    expect(retained.json.source.selected).toBe("retained_projection");

    const summary = capture(fixture.root, ["get", "--objective", objectiveId, "--number", "1", "--format", "json"]);
    expect(summary.rc).toBe(0);
    expect(summary.json).toMatchObject({ status: "degraded", record: { number: 1, summary: "Legacy summary only" } });
    expect(summary.json.entry).toMatchObject({ detail_availability: "summary", compatibility: "legacy_summary_only" });
    expect(summary.json.source_contract.compatibility_truth).toBe("summary_only_legacy_detail_is_not_reconstructed");

    const unavailable = capture(fixture.root, ["get", "--objective", objectiveId, "--number", "3", "--format", "json"]);
    expect(unavailable.rc).toBe(1);
    expect(unavailable.json.error).toMatchObject({ class: "incomplete", stable_id: `${objectiveId}/experiment:3`, entry_number: 3 });
  });

  it("returns structured malformed, wrong-objective, missing, ambiguity, and immutable-conflict failures", () => {
    const fixture = project();
    fs.writeFileSync(fixture.experimentsPath, dumpYamlMapping({ experiments: [experiment(0)] }));
    writeArchive(fixture.root, fixture.objectivePath, objectiveId, experiment(0, { label: "conflict" }));

    const malformedCursor = capture(fixture.root, ["list", "--objective", objectiveId, "--cursor", "not.a.cursor", "--format", "json"]);
    expect(malformedCursor.rc).toBe(2);
    expect(malformedCursor.json.error.class).toBe("cursor_invalid");

    const missing = capture(fixture.root, ["get", "--objective", objectiveId, "--number", "9", "--format", "json"]);
    expect(missing.rc).toBe(1);
    expect(missing.json.error).toMatchObject({ class: "not_found", stable_id: `${objectiveId}/experiment:9`, entry_number: 9 });

    const otherDirectory = path.join(fixture.root, ".agentera", "optimize", "throughput");
    fs.mkdirSync(otherDirectory, { recursive: true });
    fs.writeFileSync(path.join(otherDirectory, "objective.yaml"), dumpYamlMapping(objective(otherObjectiveId, "Increase throughput")));
    const wrongObjective = capture(fixture.root, ["get", "--objective", otherObjectiveId, "--number", "0", "--format", "json"]);
    expect(wrongObjective.rc).toBe(1);
    expect(wrongObjective.json.error.class).toBe("not_found");

    const malformedArchive = path.join(fixture.directory, "archive", "experiments", "4.yaml");
    fs.mkdirSync(path.dirname(malformedArchive), { recursive: true });
    fs.writeFileSync(malformedArchive, "schemaVersion: wrong\n");
    const corrupt = capture(fixture.root, ["get", "--objective", objectiveId, "--number", "4", "--format", "json"]);
    expect(corrupt.rc).toBe(1);
    expect(corrupt.json.error.class).toBe("corrupt");

    const conflict = capture(fixture.root, ["get", "--objective", objectiveId, "--number", "0", "--format", "json"]);
    expect(conflict.rc).toBe(1);
    expect(conflict.json.error.class).toBe("immutable_conflict");

    const legacyRoot = path.join(fixture.root, ".agentera", "optimera", "latency");
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "objective.yaml"), dumpYamlMapping(objective(objectiveId, "Different objective")));
    const ambiguous = capture(fixture.root, ["list", "--objective", objectiveId, "--format", "json"]);
    expect(ambiguous.rc).toBe(1);
    expect(ambiguous.json.error.class).toBe("ambiguous");
  });

  it("supports legacy-derived objective selection and visible unaddressable records", () => {
    const fixture = project(undefined, "optimera");
    const document = objective(undefined);
    fs.writeFileSync(fixture.objectivePath, dumpYamlMapping(document));
    const legacyId = resolveObjectiveIdentity(document).stableId;
    fs.writeFileSync(fixture.experimentsPath, dumpYamlMapping({ experiments: [{ label: "No historical number" }, experiment(0)] }));

    const listed = capture(fixture.root, ["list", "--objective", legacyId, "--format", "json"]);
    expect(listed.rc).toBe(0);
    expect(listed.json.status).toBe("degraded");
    expect(listed.json.entries.map((entry: any) => entry.experiment_number)).toEqual([0, null]);
    expect(listed.json.entries[1]).toMatchObject({ stable_id: null, addressable: false, detail_availability: "full" });
  });

  it("enforces count and serialized-byte bounds with explicit advancing recovery", () => {
    const fixture = project();
    const records = Array.from({ length: 100 }, (_, number) => experiment(number, { conclusion: `${number}:${"x".repeat(1200)}` }));
    fs.writeFileSync(fixture.experimentsPath, dumpYamlMapping({ experiments: records }));

    const result = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", "100", "--format", "json"]);
    expect(result.rc).toBe(0);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(32_768);
    expect(result.json.omitted).toBe(true);
    expect(result.json.omission_reason).toBe("serialized_output_byte_budget");
    expect(result.json.omitted_count).toBeGreaterThan(0);
    expect(result.json.next_cursor).toBeTruthy();
    expect(result.json.retrieval.continue).toContain(result.json.next_cursor);
  });

  it.each(["yaml", "text"] as const)("keeps bounded %s omission explicit and recoverable", (format) => {
    const fixture = project();
    const records = Array.from({ length: 100 }, (_, number) => experiment(number, { conclusion: `${number}:${"x".repeat(1200)}` }));
    fs.writeFileSync(fixture.experimentsPath, dumpYamlMapping({ experiments: records }));
    const result = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", format === "text" ? "20" : "100", "--format", format]);
    expect(result.rc).toBe(0);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(32_768);
    if (format === "yaml") {
      const payload = YAML.parse(result.out);
      expect(payload.omitted).toBe(true);
      expect(payload.omitted_count).toBeGreaterThan(0);
      expect(payload.omission_reason).toBe("serialized_output_byte_budget");
      expect(payload.retrieval.continue).toContain(payload.next_cursor);
    } else {
      expect(result.out).toContain("Omitted:");
      expect(result.out).toContain("reason=page_limit");
      expect(result.out).toContain("Continue: agentera state experiments list");
      expect(result.out).toContain("Get one: agentera state experiments get");
    }
  });

  it("rejects a cursor reused with a different objective filter", () => {
    const first = project(objectiveId, "optimize", "first");
    const secondDirectory = path.join(first.root, ".agentera", "optimize", "second");
    fs.mkdirSync(secondDirectory, { recursive: true });
    fs.writeFileSync(path.join(secondDirectory, "objective.yaml"), dumpYamlMapping(objective(otherObjectiveId, "Other")));
    fs.writeFileSync(first.experimentsPath, dumpYamlMapping({ experiments: [experiment(0), experiment(1)] }));
    fs.writeFileSync(path.join(secondDirectory, "experiments.yaml"), dumpYamlMapping({ experiments: [experiment(0), experiment(1)] }));
    const cursor = capture(first.root, ["list", "--objective", objectiveId, "--limit", "1", "--format", "json"]).json.next_cursor;
    const wrongFilter = capture(first.root, ["list", "--objective", otherObjectiveId, "--cursor", cursor, "--format", "json"]);
    expect(wrongFilter.rc).toBe(2);
    expect(wrongFilter.json.error.class).toBe("cursor_invalid");
  });

  it("keeps byte-limited traversal snapshot-bound across retention rollover", () => {
    const fixture = project();
    const original = Array.from({ length: 50 }, (_, number) => experiment(number, { conclusion: `${number}:${"x".repeat(1200)}` }));
    writeProjection(fixture.experimentsPath, original);
    for (const record of original) writeArchive(fixture.root, fixture.objectivePath, objectiveId, record);

    const seen: number[] = [];
    let page = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", "100", "--format", "json"]);
    expect(page.rc).toBe(0);
    expect(Buffer.byteLength(page.out, "utf8")).toBeLessThanOrEqual(32_768);
    expect(page.json.omission_reason).toBe("serialized_output_byte_budget");
    seen.push(...page.json.entries.map((entry: any) => entry.experiment_number));

    const appended = [...original, experiment(50, { conclusion: `50:${"x".repeat(1200)}` })];
    writeProjection(fixture.experimentsPath, appended);
    writeArchive(fixture.root, fixture.objectivePath, objectiveId, appended[50]);
    while (page.json.next_cursor) {
      page = capture(fixture.root, ["list", "--objective", objectiveId, "--limit", "100", "--cursor", page.json.next_cursor, "--format", "json"]);
      expect(page.rc).toBe(0);
      expect(Buffer.byteLength(page.out, "utf8")).toBeLessThanOrEqual(32_768);
      seen.push(...page.json.entries.map((entry: any) => entry.experiment_number));
    }

    expect(seen).toEqual(Array.from({ length: 50 }, (_, index) => 49 - index));
    expect(new Set(seen).size).toBe(50);
  });
});

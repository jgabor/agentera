import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import {
  boundStateList,
  listStateEntries,
  renderStateListText,
  type StateListResponse,
} from "../../src/state/listRetrieval.js";

const sourceRoot = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-state-list-"));
  roots.push(root);
  return root;
}

function cycle(number: number, what = `Cycle ${number}`): Record<string, unknown> {
  return {
    number,
    timestamp: "2026-07-13 16:00",
    type: "feat",
    phase: "build",
    what,
    context: { intent: "Exercise bounded state listing" },
  };
}

function decision(number: number): Record<string, unknown> {
  return {
    number,
    date: "2026-07-13",
    question: `Question ${number}`,
    context: "List provenance test",
    alternatives: [{ name: "State list", status: "chosen" }],
    choice: "State list",
    reasoning: "It preserves current review metadata.",
    confidence: "firm",
    satisfaction: { state: "open" },
  };
}

function writeProjection(root: string, cycles: Array<Record<string, unknown>>, archive: unknown[] = []): void {
  const target = path.join(root, ".agentera", "progress.yaml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, YAML.stringify({ cycles, archive }));
}

function archive(root: string, number: number, what?: string): void {
  publishNumberedArchive(root, "progress", number, cycle(number, what), { sourceRoot });
}

function archiveDecision(root: string, number: number): void {
  publishNumberedArchive(root, "decisions", number, decision(number), { sourceRoot });
}

function directList(root: string, limit: number, cursor?: string): StateListResponse {
  return listStateEntries(root, "progress", limit, {}, cursor, { sourceRoot });
}

function captureCli(root: string, args: string[]): { rc: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", "state", "progress", "list", ...args], {
      out: (text) => (out += text),
      err: (text) => (err += text),
    });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
  }
}

function writeArchiveFixture(root: string, number: number): void {
  const record = cycle(number);
  const recordSha256 = createHash("sha256").update(canonicalRecordJson(record), "utf8").digest("hex");
  const target = path.join(root, ".agentera", "archive", "progress", `${number}.yaml`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    YAML.stringify({
      schemaVersion: "agentera.stateArchiveEntry.v1",
      artifact_id: "progress",
      entry_number: number,
      record,
      record_sha256: recordSha256,
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("snapshot-stable state listing", () => {
  it("traverses pages in numeric order without duplicate or omitted identities", () => {
    const root = project();
    for (let number = 1; number <= 7; number += 1) archive(root, number);

    const page1 = directList(root, 3);
    const page2 = directList(root, 3, page1.next_cursor);
    const page3 = directList(root, 3, page2.next_cursor);
    const ids = [...page1.entries, ...page2.entries, ...page3.entries].map((entry) => (entry as Record<string, unknown>).stable_id);

    expect(ids).toEqual([
      "progress:7",
      "progress:6",
      "progress:5",
      "progress:4",
      "progress:3",
      "progress:2",
      "progress:1",
    ]);
    expect(new Set(ids).size).toBe(7);
    expect(page3.next_cursor).toBeUndefined();
    expect(page1.snapshot.order).toBe("entry_number_desc");
  });

  it("excludes deterministic appends from an established snapshot", () => {
    const root = project();
    for (let number = 1; number <= 5; number += 1) archive(root, number);

    const first = directList(root, 2);
    archive(root, 6);
    const continued = directList(root, 2, first.next_cursor);
    const fresh = directList(root, 2);

    expect(continued.entries.map((entry) => (entry as Record<string, unknown>).stable_id)).toEqual([
      "progress:3",
      "progress:2",
    ]);
    expect(fresh.entries.map((entry) => (entry as Record<string, unknown>).stable_id)).toEqual([
      "progress:6",
      "progress:5",
    ]);
  });

  it("rejects invalid, tampered, filter-bound, and stale cursors with recovery guidance", () => {
    const root = project();
    for (let number = 1; number <= 3; number += 1) archive(root, number);
    const first = directList(root, 1);
    const token = first.next_cursor as string;

    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(() => directList(root, 1, tampered)).toThrow(/cursor signature is invalid|cursor is not a valid/);
    expect(() => listStateEntries(root, "progress", 1, { status: "feat" }, token, { sourceRoot })).toThrow(/bound to a different list/);

    fs.rmSync(path.join(root, ".agentera", "archive", "progress", "1.yaml"));
    try {
      directList(root, 1, token);
      throw new Error("expected stale cursor failure");
    } catch (error) {
      expect((error as Error).message).toContain("no longer available");
    }

    const invalid = captureCli(root, ["--cursor", "not-a-cursor", "--format", "json"]);
    expect(invalid.rc).toBe(2);
    expect(JSON.parse(invalid.out)).toMatchObject({
      error: {
        class: "cursor_invalid",
        syntax: "agentera state progress list [--limit N] [--cursor TOKEN] --format json",
        example: "agentera state progress list --limit 20 --cursor TOKEN --format json",
      },
    });
  });

  it("distinguishes active, summary, and archive-only rows with provenance", () => {
    const root = project();
    writeProjection(root, [cycle(1)], ["Cycle 2 (2026-07-13): summary only"]);
    archive(root, 3);

    const response = directList(root, 10);
    expect(response.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stable_id: "progress:1",
          current_status: "active",
          detail_availability: "full",
          source: "legacy_full",
          compatibility: "degraded",
        }),
        expect.objectContaining({
          stable_id: "progress:2",
          current_status: "summary",
          detail_availability: "summary",
          source: "legacy_summary",
          compatibility: "degraded",
        }),
        expect.objectContaining({
          stable_id: "progress:3",
          current_status: "archive_only",
          detail_availability: "full",
          source: "archive",
          compatibility: "complete",
        }),
      ]),
    );
    const archiveOnly = response.entries.find((entry) => (entry as Record<string, unknown>).stable_id === "progress:3") as Record<string, any>;
    expect(archiveOnly.provenance).toMatchObject({
      archive: { available: true, verified: true },
      current_projection: { present: false, representation: "missing" },
    });
  });

  it("binds decision overlay status and revision into list provenance", () => {
    const root = project();
    archiveDecision(root, 1);
    const overlay = path.join(root, ".agentera", "overlays", "decisions.yaml");
    fs.mkdirSync(path.dirname(overlay), { recursive: true });
    fs.writeFileSync(overlay, YAML.stringify({ "decisions:1": { satisfaction: { state: "provisionally_satisfied", evidence: "listed" } } }));

    const response = listStateEntries(root, "decisions", 10, {}, undefined, { sourceRoot });
    expect(response.entries[0]).toMatchObject({
      stable_id: "decisions:1",
      current_status: "archive_only",
      record_status: "provisionally_satisfied",
      overlay_applied: true,
      provenance: { overlay: { applied: true, fields: ["satisfaction.state", "satisfaction.evidence"] } },
    });
    expect(String(response.source_contract.cursor)).toContain("overlay revision");
  });

  it("keeps JSON, YAML, and text list output within the authority byte budget", () => {
    const root = project();
    writeProjection(root, [cycle(1, "🙂漢字".repeat(20_000))]);
    const response = directList(root, 1);
    const json = JSON.stringify(boundStateList(response, "json", sourceRoot), null, 2) + "\n";
    const yaml = YAML.stringify(boundStateList(response, "yaml", sourceRoot));
    const text = renderStateListText(boundStateList(response, "text", sourceRoot, root));
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(32768);
    expect(Buffer.byteLength(yaml, "utf8")).toBeLessThanOrEqual(32768);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32768);
    expect(boundStateList(response, "json", sourceRoot).entries[0]).not.toHaveProperty("summary");
  });

  it("publishes the CLI list contract and exact limit diagnostics", () => {
    const root = project();
    archive(root, 1);
    const json = captureCli(root, ["--limit", "1", "--format", "json"]);
    const yaml = captureCli(root, ["--limit", "1", "--format", "yaml"]);
    const invalid = captureCli(root, ["--limit", "101", "--format", "json"]);

    expect(json.rc).toBe(0);
    expect(yaml.rc).toBe(0);
    expect(JSON.parse(json.out)).toEqual(YAML.parse(yaml.out));
    expect(JSON.parse(json.out)).toMatchObject({
      command: "state progress list",
      status: "ok",
      counts: { total: 1, returned: 1 },
      snapshot: { first_page: true, has_more: false },
    });
    expect(invalid.rc).toBe(2);
    expect(JSON.parse(invalid.out)).toMatchObject({
      error: {
        class: "invalid_request",
        syntax: "agentera state progress list [--limit N] [--cursor TOKEN] --format json",
        example: "agentera state progress list --limit 20 --format json",
      },
    });
  });

  it("measures archive enumeration at small and large authority fixtures without an index", () => {
    const authority = YAML.parse(fs.readFileSync(path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml"), "utf8")) as Record<string, any>;
    const benchmark = authority.budgets.list.benchmark;
    const sizes = [100, 1000];
    const measurements: Array<{ entries: number; latencyMs: number; heapDeltaBytes: number; responseBytes: number }> = [];
    for (const size of sizes) {
      const root = project();
      for (let number = 1; number <= size; number += 1) writeArchiveFixture(root, number);
      const beforeHeap = process.memoryUsage().heapUsed;
      const started = performance.now();
      const response = boundStateList(listStateEntries(root, "progress", 20, {}, undefined, { sourceRoot }), "json", sourceRoot, root);
      const latencyMs = performance.now() - started;
      const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - beforeHeap);
      const responseBytes = Buffer.byteLength(JSON.stringify(response, null, 2) + "\n", "utf8");
      measurements.push({ entries: size, latencyMs, heapDeltaBytes, responseBytes });
      expect(responseBytes).toBeLessThanOrEqual(benchmark.response_max_utf8_bytes);
    }
    expect(measurements[0].entries).toBe(benchmark.small.entries);
    expect(measurements[1].entries).toBe(benchmark.large.entries);
    expect(measurements[0].latencyMs).toBeLessThan(benchmark.small.max_latency_ms);
    expect(measurements[1].latencyMs).toBeLessThan(benchmark.large.max_latency_ms);
    expect(measurements[0].heapDeltaBytes).toBeLessThan(benchmark.small.max_heap_delta_bytes);
    expect(measurements[1].heapDeltaBytes).toBeLessThan(benchmark.large.max_heap_delta_bytes);
    expect(authority.budgets.list.index_decision.decision).toBe("no_index");
    if (process.env.AGENTERA_BENCHMARK_REPORT === "1") process.stdout.write(`state-list benchmark: ${JSON.stringify(measurements)}\n`);
  }, 30_000);
});

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import { retrieveStateEntry, StateRetrievalFailure } from "../../src/state/directRetrieval.js";
import {
  boundStateList,
  listStateEntries,
  renderStateListText,
  type StateListResponse,
} from "../../src/state/listRetrieval.js";
import { measureColdStateList } from "../helpers/coldCliMeasurement.js";

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

function writeArtifactProjection(root: string, artifact: "decisions" | "health", entries: unknown[], archive: unknown[] = []): void {
  const target = path.join(root, ".agentera", `${artifact}.yaml`);
  const collection = artifact === "decisions" ? "decisions" : "audits";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, YAML.stringify({ [collection]: entries, archive }));
}

function writeSummaryProjection(root: string, count: number): void {
  writeProjection(
    root,
    [],
    Array.from({ length: count }, (_, index) => ({
      summary: `Cycle ${index + 1} (2026-07-13): compact legacy summary`,
      compacted: true,
    })),
  );
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

function captureMigrationFixture(root: string, args: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  try {
    let limit = 20;
    let cursor: string | undefined;
    let format: "text" | "json" | "yaml" = "text";
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (flag === "--limit") limit = Number(value);
      else if (flag === "--cursor") cursor = value;
      else if (flag === "--format") format = value as typeof format;
    }
    const response = boundStateList(
      listStateEntries(root, "progress", limit, {}, cursor, { sourceRoot }),
      format,
      sourceRoot,
      root,
    );
    out = format === "json" ? JSON.stringify(response, null, 2) + "\n" : format === "yaml" ? YAML.stringify(response) : renderStateListText(response);
    return { rc: 0, out, err };
  } catch (error) {
    if (!(error instanceof StateRetrievalFailure)) throw error;
    const format = args[args.indexOf("--format") + 1] ?? "text";
    if (format === "json") out = JSON.stringify(error.body, null, 2) + "\n";
    else if (format === "yaml") out = YAML.stringify(error.body);
    else err = `${error.body.error.message}\n`;
    return { rc: error.exitCode, out, err };
  }
}

function migrationFixturePage(
  root: string,
  format: "json" | "yaml" | "text",
  limit: number,
  cursor?: string,
): { ids: string[]; nextCursor?: string } {
  const result = captureMigrationFixture(root, ["--limit", String(limit), ...(cursor ? ["--cursor", cursor] : []), "--format", format]);
  expect(result.rc).toBe(0);
  if (format === "json" || format === "yaml") {
    const response = (format === "json" ? JSON.parse(result.out) : YAML.parse(result.out)) as Record<string, unknown>;
    return {
      ids: ((response.entries as Array<Record<string, unknown>>) ?? []).map((entry) => String(entry.stable_id)),
      ...(typeof response.next_cursor === "string" ? { nextCursor: response.next_cursor } : {}),
    };
  }
  const ids = [...result.out.matchAll(/^- ([^ ]+) /gm)].map((match) => match[1]);
  const nextCursor = /^next_cursor: (.+)$/m.exec(result.out)?.[1];
  return { ids, ...(nextCursor ? { nextCursor } : {}) };
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

describe("read-only migration fixture state listing", () => {
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

  it.each(["json", "yaml", "text"] as const)(
    "exhaustively follows every bounded %s cursor without repeating a page boundary",
    (format) => {
      for (const size of [0, 1, 2, 5, 9]) {
        const root = project();
        for (let number = 1; number <= size; number += 1) writeArchiveFixture(root, number);
        for (let limit = 1; limit <= 5; limit += 1) {
          const ids: string[] = [];
          const cursors = new Set<string>();
          let cursor: string | undefined;
          for (let pageNumber = 0; pageNumber <= size + 1; pageNumber += 1) {
            const page = migrationFixturePage(root, format, limit, cursor);
            ids.push(...page.ids);
            if (!page.nextCursor) break;
            expect(cursors.has(page.nextCursor)).toBe(false);
            cursors.add(page.nextCursor);
            cursor = page.nextCursor;
            if (pageNumber === size + 1) throw new Error("cursor traversal did not terminate");
          }

          expect(ids).toEqual(Array.from({ length: size }, (_, index) => `progress:${size - index}`));
          expect(new Set(ids).size).toBe(size);
        }
      }
    },
  );

  it.each(["json", "yaml", "text"] as const)("returns the same bounded page for a repeated %s cursor", (format) => {
    const root = project();
    for (let number = 1; number <= 7; number += 1) writeArchiveFixture(root, number);
    const first = migrationFixturePage(root, format, 2);
    const repeated = migrationFixturePage(root, format, 2, first.nextCursor);
    expect(repeated).toEqual(migrationFixturePage(root, format, 2, first.nextCursor));
  });

  it("keeps an appended row out of an established bounded CLI snapshot", () => {
    const root = project();
    for (let number = 1; number <= 5; number += 1) writeArchiveFixture(root, number);

    const first = migrationFixturePage(root, "json", 2);
    writeArchiveFixture(root, 6);
    const continuedIds: string[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = migrationFixturePage(root, "json", 2, cursor);
      continuedIds.push(...page.ids);
      cursor = page.nextCursor;
    }

    expect(continuedIds).toEqual(["progress:3", "progress:2", "progress:1"]);
    expect(continuedIds).not.toContain("progress:6");
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
    const tamperedCli = captureMigrationFixture(root, ["--limit", "1", "--cursor", tampered, "--format", "json"]);
    expect(tamperedCli.rc).toBe(2);
    expect(JSON.parse(tamperedCli.out)).toMatchObject({ error: { class: "cursor_invalid" } });

    fs.rmSync(path.join(root, ".agentera", "archive", "progress", "1.yaml"));
    try {
      directList(root, 1, token);
      throw new Error("expected stale cursor failure");
    } catch (error) {
      expect((error as Error).message).toContain("no longer available");
    }

    const invalid = captureMigrationFixture(root, ["--cursor", "not-a-cursor", "--format", "json"]);
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

  it("includes live-style legacy summary mappings in authoritative counts", () => {
    const root = project();
    writeSummaryProjection(root, 4);

    const response = directList(root, 10);
    expect(response.counts).toMatchObject({ total: 4, returned: 4, summary: 4 });
    expect(response.entries.map((entry) => (entry as Record<string, unknown>).stable_id)).toEqual([
      "progress:4",
      "progress:3",
      "progress:2",
      "progress:1",
    ]);
    expect(response.entries.every((entry) => (entry as Record<string, unknown>).source === "legacy_summary")).toBe(true);
    expect(response.entries.every((entry) => (entry as Record<string, unknown>).detail_availability === "summary")).toBe(true);
  });

  it("keeps explicit Dnn shorthand addressable and staging rows list-only", () => {
    const root = project();
    writeArtifactProjection(root, "decisions", [], [
      "D76 (feeds into D75 and D77): explicit decision shorthand",
      "D3+D4 (2026-06-05): merged staging material",
      "Staging D3+D4 (2026-06-05): merged staging material",
      "staging note without an identity",
    ]);

    const response = listStateEntries(root, "decisions", 10, {}, undefined, { sourceRoot });
    expect(response.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stable_id: "decisions:76",
          entry_number: 76,
          addressable: true,
          identity: "explicit_decision_shorthand",
          classification: "canonical",
        }),
        expect.objectContaining({
          stable_id: null,
          entry_number: null,
          addressable: false,
          identity: "ambiguous",
          classification: "ambiguous",
        }),
        expect.objectContaining({
          stable_id: null,
          entry_number: null,
          addressable: false,
          identity: "unaddressable",
          classification: "unaddressable",
        }),
        expect.objectContaining({
          stable_id: null,
          entry_number: null,
          addressable: false,
          identity: "unaddressable",
          classification: "unaddressable",
        }),
      ]),
    );
    expect(response.counts).toMatchObject({
      physical: 4,
      addressable: 1,
      addressable_ids: 1,
      unaddressable: 2,
      ambiguous: 1,
      omitted: 0,
    });

    const page1 = listStateEntries(root, "decisions", 1, {}, undefined, { sourceRoot });
    const page2 = listStateEntries(root, "decisions", 1, {}, page1.next_cursor, { sourceRoot });
    const page3 = listStateEntries(root, "decisions", 1, {}, page2.next_cursor, { sourceRoot });
    const page4 = listStateEntries(root, "decisions", 1, {}, page3.next_cursor, { sourceRoot });
    expect([...page1.entries, ...page2.entries, ...page3.entries, ...page4.entries].map((entry) => (entry as Record<string, unknown>).stable_id)).toEqual([
      "decisions:76",
      null,
      null,
      null,
    ]);
    expect(page4.next_cursor).toBeUndefined();

    const listed = response.entries.find((entry) => (entry as Record<string, unknown>).stable_id === "decisions:76") as Record<string, unknown>;
    const retrieved = retrieveStateEntry(root, "decisions", 76, { sourceRoot });
    expect(retrieved.entry).toMatchObject({
      stable_id: "decisions:76",
      entry_number: 76,
      source: "legacy_summary",
      detail_availability: "summary",
      compatibility: "degraded",
      provenance: { current_projection: { representation: "summary" } },
    });
    expect(retrieved.entry.record).toEqual({ summary: listed.summary });
  });

  it("classifies exact mirrors, duplicate rows, and conflicting versions without selecting one", () => {
    const root = project();
    const mirrored = cycle(5);
    archive(root, 5);
    writeProjection(root, [mirrored, mirrored, cycle(6, "conflicting current row")]);
    archive(root, 6, "archive version");

    const response = listStateEntries(root, "progress", 10, {}, undefined, { sourceRoot });
    expect(response.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stable_id: "progress:5", classification: "duplicate", physical_count: 3 }),
        expect.objectContaining({ stable_id: "progress:6", classification: "conflict", physical_count: 2 }),
      ]),
    );
    expect(response.counts).toMatchObject({
      physical: 5,
      addressable: 5,
      addressable_ids: 2,
      canonical: 2,
      mirrored: 1,
      duplicate: 1,
      conflict: 1,
      unaddressable: 0,
      ambiguous: 0,
      omitted: 0,
    });
    expect(response.entries.find((entry) => (entry as Record<string, unknown>).stable_id === "progress:6")).toMatchObject({
      retrieval: { available: false },
      compatibility: "blocked",
    });
  });

  it("ignores unrelated archive directories when listing one artifact", () => {
    const root = project();
    archive(root, 1);
    const unrelated = path.join(root, ".agentera", "archive", "unrelated");
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, "1.yaml"), "not: an archive envelope\n");
    const unrelatedSupported = path.join(root, ".agentera", "archive", "decisions");
    fs.mkdirSync(unrelatedSupported, { recursive: true });
    fs.writeFileSync(path.join(unrelatedSupported, "1.yaml"), "not: an archive envelope\n");

    const response = directList(root, 10);
    expect(response.status).toBe("ok");
    expect(response.source.archive).toMatchObject({ rejected_count: 0 });
    expect(response.entries).toHaveLength(1);
  });

  it.each(["json", "yaml", "text"] as const)("fails rather than promising a repeated %s cursor when no row fits the required budget", (format) => {
    const root = project();
    for (let number = 1; number <= 100; number += 1) writeArchiveFixture(root, number);
    const response = directList(root, 100);
    for (const raw of response.entries) {
      const entry = raw as Record<string, any>;
      entry.provenance.archive.path = "archive-path-".repeat(2000);
      entry.provenance.current_projection.path = "projection-path-".repeat(2000);
    }

    expect(() => boundStateList(response, format, sourceRoot, root)).toThrow(
      /cannot emit an advancing row page/,
    );
  });

  it("trims an over-budget page only to an advancing row boundary", () => {
    const root = project();
    for (let number = 1; number <= 100; number += 1) writeArchiveFixture(root, number);
    const response = directList(root, 100);
    for (const raw of response.entries) {
      const entry = raw as Record<string, any>;
      entry.provenance.archive.path = "archive-path-".repeat(300);
      entry.provenance.current_projection.path = "projection-path-".repeat(300);
    }

    const bounded = boundStateList(response, "json", sourceRoot, root);
    expect(bounded.entries.length).toBeGreaterThan(0);
    expect(bounded.entries.length).toBeLessThan(100);
    expect(bounded.next_cursor).toEqual(expect.any(String));
    const lastEmitted = String((bounded.entries.at(-1) as Record<string, unknown>).stable_id);
    const continued = directList(root, 100, bounded.next_cursor);
    expect(continued.entries[0]).not.toMatchObject({ stable_id: lastEmitted });
  });

  it("bounds the requested YAML serialization rather than only the JSON estimate", () => {
    const entries = [{
      stable_id: "progress:1",
      artifact_id: "progress",
      entry_number: 1,
      current_status: "summary",
      detail_availability: "summary",
      source: "legacy_summary",
      compatibility: "degraded",
      summary: ("x\n").repeat(9000),
      provenance: {
        archive: { path: "x", available: false, verified: false },
        current_projection: { path: "x", present: true, representation: "summary" },
      },
    }];
    const response = {
      command: "state progress list",
      status: "ok" as const,
      entries,
      counts: { total: entries.length, returned: entries.length, remaining: 0, active: 0, summary: entries.length, archive_only: 0 },
      source: { artifact: "progress", current_projection: { path: "x", exists: true }, archive: { root: "x", validated_entries: 0, rejected_count: 0 } },
      filters: { topic: null, status: null },
      snapshot: { id: "a".repeat(64), first_page: true, order: "entry_number_desc", has_more: false, candidate_count: entries.length, candidate_max: entries.length, page_start: entries.length + 1 },
      source_contract: { authority: "references/artifacts/state-storage-authority.yaml", compatibility: "degraded", detail: "summary", retrieval: "agentera state progress get --number N --format json", cursor: "opaque" },
    };
    const rawJsonBytes = Buffer.byteLength(JSON.stringify(response, null, 2) + "\n", "utf8");
    const rawYamlBytes = Buffer.byteLength(YAML.stringify(response), "utf8");
    expect(rawJsonBytes).toBeLessThanOrEqual(32768);
    expect(rawYamlBytes).toBeGreaterThan(32768);

    const bounded = boundStateList(response, "yaml", sourceRoot, project());
    const yamlBytes = Buffer.byteLength(YAML.stringify(bounded), "utf8");
    expect(yamlBytes).toBeLessThanOrEqual(32768);
    expect(bounded).toMatchObject({ status: "degraded", omitted: true });
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
    writeProjection(root, [cycle(1, "\u{10400}\u20ac\u2030".repeat(20_000))]);
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
    const json = captureMigrationFixture(root, ["--limit", "1", "--format", "json"]);
    const yaml = captureMigrationFixture(root, ["--limit", "1", "--format", "yaml"]);
    const invalid = captureMigrationFixture(root, ["--limit", "101", "--format", "json"]);

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

  it("measures archive enumeration at small and large authority fixtures without an index", async () => {
    const authority = YAML.parse(fs.readFileSync(path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml"), "utf8")) as Record<string, any>;
    const benchmark = authority.budgets.list.benchmark;
    const sizes = [100, 1000];
    const measurements: Array<{ entries: number; latencyMs: number; heapDeltaBytes: number; responseBytes: number }> = [];
    for (const size of sizes) {
      const root = project();
      for (let number = 1; number <= size; number += 1) writeArchiveFixture(root, number);
      const measured = await measureColdStateList({ project: root, repoRoot: sourceRoot });
      const responseBytes = Buffer.byteLength(measured.stdout, "utf8");
      measurements.push({ entries: size, latencyMs: measured.elapsedMs, heapDeltaBytes: measured.heapDeltaBytes, responseBytes });
      expect(responseBytes).toBeLessThanOrEqual(benchmark.response_max_utf8_bytes);
    }
    const diagnostic = JSON.stringify(measurements);
    expect(measurements[0].entries).toBe(benchmark.small.entries);
    expect(measurements[1].entries).toBe(benchmark.large.entries);
    expect(measurements[0].latencyMs, diagnostic).toBeLessThan(benchmark.small.max_latency_ms);
    expect(measurements[1].latencyMs, diagnostic).toBeLessThan(benchmark.large.max_latency_ms);
    expect(measurements[0].heapDeltaBytes, diagnostic).toBeLessThan(benchmark.small.max_heap_delta_bytes);
    expect(measurements[1].heapDeltaBytes, diagnostic).toBeLessThan(benchmark.large.max_heap_delta_bytes);
    expect(authority.budgets.list.index_decision.decision).toBe("no_index");
    if (process.env.AGENTERA_BENCHMARK_REPORT === "1") process.stdout.write(`state-list benchmark: ${JSON.stringify(measurements)}\n`);
  }, 30_000);
});

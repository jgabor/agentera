import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  boundStructuredProjection,
  loadProjectionPolicy,
  serializedProjectionBytes,
} from "../../src/state/projectionPolicy.js";
import { checkCompaction, compactYamlFile } from "../../src/hooks/compaction/index.js";
import { discoverNumberedArchives } from "../../src/state/archiveDiscovery.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import { queryProgress } from "../../src/cli/commands/state/progress.js";

const roots: string[] = [];
const sourceRoot = path.resolve(import.meta.dirname, "../../../..");

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-projection-policy-"));
  roots.push(root);
  return root;
}

function cycle(number: number, detail = `Cycle ${number}`): Record<string, unknown> {
  return {
    number,
    timestamp: `2026-07-${String((number % 28) + 1).padStart(2, "0")} 10:00`,
    type: "feat",
    phase: "build",
    what: detail,
    context: { intent: "projection policy test" },
  };
}

function seedProgress(root: string, count: number): string {
  const entries = Array.from({ length: count }, (_, index) => cycle(index + 1));
  const target = path.join(root, ".agentera", "progress.yaml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, YAML.stringify({ cycles: entries, archive: [] }));
  for (const entry of entries) publishNumberedArchive(root, "progress", Number(entry.number), entry, { sourceRoot });
  return target;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("lossless projection policy", () => {
  it("loads authority-owned projection defaults and byte budget", () => {
    expect(loadProjectionPolicy()).toEqual({
      activeEntries: 10,
      summaryEntries: 40,
      totalEntries: 50,
      maxUtf8Bytes: 32768,
    });
  });

  it.each([
    [9, "within_defaults"],
    [10, "within_defaults"],
    [50, "within_defaults"],
  ] as const)("reports %s entries without retention failure", (count, state) => {
    const root = project();
    const target = seedProgress(root, count);
    if (count === 50) compactYamlFile(target, "progress", root);
    const operation = checkCompaction(root).find((item) => item.status.artifact === "progress");
    expect(operation?.action).toBe("ok");
    expect(operation?.status.projection_state).toBe(state);
    expect(operation?.status.over_limit_count).toBe(0);
  });

  it("projects above the default without deleting numbered archive records", () => {
    const root = project();
    const target = seedProgress(root, 55);
    const result = compactYamlFile(target, "progress", root);
    const current = YAML.parse(fs.readFileSync(target, "utf8")) as Record<string, any>;
    const discovery = discoverNumberedArchives(root, { sourceRoot });

    expect(result.dropped).toBe(0);
    expect(result.omitted_count).toBe(5);
    expect(current.cycles).toHaveLength(10);
    expect(current.archive).toHaveLength(40);
    expect(current.omitted).toBe(true);
    expect(current.omitted_count).toBe(5);
    expect(discovery.entries.filter((entry) => entry.artifactId === "progress")).toHaveLength(55);
  });

  it("bounds legacy inline summaries without presenting them as verified archives", () => {
    const root = project();
    const target = path.join(root, ".agentera", "progress.yaml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      YAML.stringify({
        cycles: Array.from({ length: 10 }, (_, index) => cycle(index + 46)),
        archive: Array.from({ length: 45 }, (_, index) => ({
          summary: `Cycle ${index + 1}: legacy summary ${index + 1}`,
        })),
      }),
    );

    const result = compactYamlFile(target, "progress", root);
    const current = YAML.parse(fs.readFileSync(target, "utf8")) as Record<string, any>;
    const provenance = current.omission_provenance as Array<Record<string, unknown>>;

    expect(result.dropped).toBe(0);
    expect(result.omitted_count).toBe(5);
    expect(current.archive).toHaveLength(40);
    expect(provenance).toEqual([
      {
        source: "legacy_summary",
        detail_availability: "unavailable",
        compatibility: "degraded",
        archive_verified: false,
        omitted_count: 5,
      },
    ]);
    expect(discoverNumberedArchives(root, { sourceRoot }).entries).toEqual([]);
  });

  it("keeps unresolved decision pressure writable beyond active capacity", () => {
    const root = project();
    const target = path.join(root, ".agentera", "decisions.yaml");
    const decisions = Array.from({ length: 51 }, (_, index) => ({
      number: index + 1,
      date: "2026-07-13",
      question: `Question ${index + 1}?`,
      context: "Context",
      alternatives: [{ name: "yes", status: "chosen" }],
      choice: "yes",
      reasoning: "Reasoning",
      confidence: "firm",
    }));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, YAML.stringify({ decisions }));

    const result = compactYamlFile(target, "decisions", root);
    const current = YAML.parse(fs.readFileSync(target, "utf8")) as Record<string, any>;
    expect(result.dropped).toBe(0);
    expect(current.decisions).toHaveLength(51);
    expect(checkCompaction(root).find((item) => item.status.artifact === "decisions")?.action).toBe("projection");
  });

  it("omits complete detail deterministically rather than truncating Unicode", () => {
    const unicodeSample = "\u{10400}\u20ac\u2030\u20ac\u2030\u2042";
    const entries = Array.from({ length: 40 }, (_, index) => ({
      number: index + 1,
      detail: unicodeSample.repeat(1200),
    }));
    const value = {
      command: "progress",
      status: "ok",
      entries,
      counts: { entries: entries.length },
      source: { artifact: "progress", exists: true },
      filters: {},
      summary: {},
    };
    const bounded = boundStructuredProjection(value, "progress", "json");

    expect(serializedProjectionBytes(bounded, "json")).toBeLessThanOrEqual(32768);
    expect(bounded.omitted).toBe(true);
    expect(bounded.omitted_count).toBeGreaterThan(0);
    expect(bounded.omission_reason).toBe("projection_byte_budget");
    expect((bounded.retrieval as Record<string, unknown>).command).toBe(
      "agentera state progress list",
    );
    expect((bounded.retrieval as Record<string, unknown>).get).toBe("agentera state progress get --id ID");
    const returned = bounded.entries as Array<Record<string, unknown>>;
    expect(returned.every((entry) => typeof entry.detail === "string" && !String(entry.detail).endsWith("..."))).toBe(true);
    expect(returned.map((entry) => entry.number)).toEqual(
      [...returned.map((entry) => entry.number)].sort((left, right) => Number(left) - Number(right)),
    );
  });

  it.each(["json", "yaml"] as const)("replaces oversized required fields with a measured fallback (%s)", (format) => {
    const value = {
      command: "progress",
      status: "ok",
      entries: [],
      counts: { entries: 0 },
      source: { artifact: "progress", path: "source-".repeat(20000), exists: true },
      filters: {},
      summary: {},
    };
    const bounded = boundStructuredProjection(value, "progress", format);

    expect(serializedProjectionBytes(bounded, format)).toBeLessThanOrEqual(32768);
    expect(bounded.omitted).toBe(true);
    expect(bounded.omission_reason).toBe("projection_required_fields_exceed_budget");
    expect(bounded.error).toMatchObject({ class: "projection_output_budget" });
    expect((bounded.source as Record<string, unknown>).path).toBeUndefined();
  });

  it("does not emit a ghost get pointer for unnumbered TODO output", () => {
    const nonBmpLetter = "\u{10400}";
    const value = {
      command: "todo",
      status: "ok",
      entries: Array.from({ length: 20 }, (_, index) => ({
        number: index + 1,
        detail: `TODO${nonBmpLetter}`.repeat(3000),
      })),
      counts: { entries: 20 },
      source: { artifact: "todo", exists: true },
      filters: {},
      summary: {},
    };
    const bounded = boundStructuredProjection(value, "todo", "json");
    const retrieval = bounded.retrieval as Record<string, unknown>;

    expect(serializedProjectionBytes(bounded, "json")).toBeLessThanOrEqual(32768);
    expect(bounded.omitted).toBe(true);
    expect(retrieval.available).toBe(false);
    expect(retrieval.command).toBeUndefined();
    expect(retrieval.reason).toBe("unsupported_numbered_retrieval");
  });

  it("enforces the same budget at the state progress response surface", () => {
    const root = project();
    const unicodeSample = "\u00e9\u{10400}\u20ac\u2030";
    const directory = path.join(root, ".agentera/entities/progress/progress_cycle");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    for (let index = 0; index < 12; index += 1) {
      const id = `${"a".repeat(9)}${String.fromCharCode(97 + index)}`;
      fs.writeFileSync(path.join(directory, `${id}.yaml`), YAML.stringify({
        id,
        artifact: "progress",
        record: { timestamp: `2026-07-${String(index + 1).padStart(2, "0")} 10:00`, type: "test", phase: "build", what: unicodeSample.repeat(500), context: { intent: "budget" } },
      }));
    }
    let output = "";
    const previous = process.cwd();
    process.chdir(root);
    let rc: number;
    try {
      rc = queryProgress({ command: "progress", format: "json", limit: 12 }, {}, { out: (text) => (output += text), err: () => {} });
    } finally {
      process.chdir(previous);
    }
    const payload = JSON.parse(output) as Record<string, any>;
    expect(rc).toBe(0);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(32768);
    expect(payload).toMatchObject({
      status: "degraded",
      counts: { candidate: 12, returned: 12, omitted: 0, continuation: 0 },
      projection: { detail: "summary", cardinality: "requested_rows" },
      degradation: { reason: "optional_detail_byte_budget", detail_omitted_count: 12 },
    });
  });
});

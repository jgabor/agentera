import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/core/jsonValue.js";
import { ENTITY_LIST_RUNTIME_REGISTRY, type EntityListRuntimeFamilyKey } from "../../src/state/entityListRuntimeRegistry.js";
import { entityListSelectorKey, projectEntityList, resolveEntityListSelector, type EntityListProjectionOptions, type EntityListSelectorInput } from "../../src/state/entityListProjection.js";

function entries(count: number, detail = "small"): JsonObject[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `${String.fromCharCode(97 + Math.floor(index / 26)).repeat(9)}${String.fromCharCode(97 + (index % 26))}`;
    return {
      id,
      artifact: "plan",
      record: { name: `${index}-${detail}`, status: "pending", nested: { value: index } },
      provenance: { path: `${id}.yaml` },
    };
  });
}

function response(rows: JsonObject[], remaining = 0): JsonObject {
  return {
    schemaVersion: "agentera.stateList.v1",
    command: "state plan tasks list",
    status: remaining ? "degraded" : "ok",
    entries: rows,
    counts: { total: rows.length + remaining, returned: rows.length, remaining },
    filters: { plan: "abcdefghij" },
    snapshot: { id: "snapshot", candidate_count: rows.length + remaining, has_more: remaining > 0 },
    retrieval: { get: "agentera state plan tasks get --id ID" },
  };
}

function options(selector?: EntityListSelectorInput, maxUtf8Bytes = 32_768): EntityListProjectionOptions {
  return {
    family: "plan_tasks",
    artifact: "plan",
    boundary: "plan_task",
    format: "json",
    maxUtf8Bytes,
    selector,
  };
}

function todoEntries(count: number): JsonObject[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `${String.fromCharCode(97 + Math.floor(index / 26)).repeat(9)}${String.fromCharCode(97 + (index % 26))}`;
    return {
      id,
      artifact: "todo",
      record: { title: `${index}-${"x".repeat(500)}`, status: "open" },
      public_order: index + 1,
      readiness: { state: "open", reason: "r".repeat(400) },
      actionability: { outcome: "actionable", eligible: true },
      queue_rank: index + 1,
      reconciliation: { status: "clean", drifted: false },
      provenance: { path: `${id}.yaml` },
    };
  });
}

function todoOptions(selector?: EntityListSelectorInput, maxUtf8Bytes = 32_768): EntityListProjectionOptions {
  return {
    family: "todo",
    artifact: "todo",
    boundary: "todo_item",
    format: "json",
    maxUtf8Bytes,
    selector,
  };
}

describe("bounded entity list projection", () => {
  // Source paths mirror records exercised by the existing family writer/read tests.
  const inventory = {
    progress: {
      record: { what: "Restore readable lists", phase: "build" },
      text: "Restore readable lists",
      source: "what",
      metadata: { phase: "build" },
    },
    decisions: {
      record: {
        question: "Where should authority live?",
        choice: "Canonical entities",
        confidence: "firm",
        satisfaction: { state: "open" },
      },
      text: "Where should authority live?",
      source: "question",
      metadata: { confidence: "firm", satisfaction: { state: "open" } },
    },
    health: {
      record: { dimensions: ["architecture_alignment"], trajectory: "stable" },
      text: "architecture_alignment",
      source: "dimensions",
      metadata: { trajectory: "stable" },
    },
    plans: {
      record: { header: { title: "Readable references", status: "open" } },
      text: "Readable references",
      source: "header.title",
      metadata: { header: { status: "open" } },
    },
    plan_tasks: {
      record: { name: "Restore readable listings", status: "in_progress" },
      text: "Restore readable listings",
      source: "name",
      metadata: { status: "in_progress" },
    },
    objective: {
      record: {
        header: { title: "Reduce latency", status: "open" },
        objective: { description: "Reduce CLI latency" },
      },
      text: "Reduce latency",
      source: "header.title",
      metadata: { header: { status: "open" } },
    },
    experiments: {
      record: { label: "Cache keys", status: "kept" },
      text: "Cache keys",
      source: "label",
      metadata: { status: "kept" },
    },
    todo: {
      record: { title: "Emit typed bootstrap failures", status: "open", severity: "critical" },
      text: "Emit typed bootstrap failures",
      source: "title",
      metadata: { status: "open", severity: "critical" },
    },
    docs: {
      record: { document: "Packaging guide", status: "current" },
      text: "Packaging guide",
      source: "document",
      metadata: { status: "current" },
    },
  } satisfies Record<EntityListRuntimeFamilyKey, { record: JsonObject; text: string; source: string; metadata: JsonObject }>;

  for (const key of Object.keys(inventory) as EntityListRuntimeFamilyKey[]) {
    const sample = inventory[key];
    const family = ENTITY_LIST_RUNTIME_REGISTRY[key];
    const config = {
      ...options(),
      family: key,
      artifact: family.artifact,
      boundary: family.boundary,
    };
    it(`${key}: preserves source-backed descriptions, metadata and duplicate identities in full and summary defaults`, () => {
      for (const pressure of [false, true]) {
        const rows = entries(2).map((entry) => ({
          ...entry,
          artifact: family.artifact,
          record: { ...sample.record, details: pressure ? "x".repeat(40_000) : "small" },
          queue_rank: 1,
        }));
        const result = projectEntityList(response(rows, 1), resolveEntityListSelector(undefined, rows, config), config);
        expect(result).toMatchObject({
          projection: { detail: pressure ? "summary" : "full" },
          counts: { returned: 2, remaining: 1 },
        });
        const projected = result.entries as JsonObject[];
        expect(projected.map((row) => row.id)).toEqual(rows.map((row) => row.id));
        for (const row of projected) {
          expect(row).toMatchObject({
            readable: {
              text: sample.text,
              source: `record.${sample.source}`,
              availability: "included",
              metadata: sample.metadata,
            },
          });
          expect((row.retrieval as JsonObject).get).toContain(`get --id ${row.id}`);
          if (pressure) expect(row.record).toBeUndefined();
          else expect(row.record).toMatchObject(sample.record);
        }
        if (pressure) expect((result.degradation as JsonObject).omitted_fields).toContain("record");
      }
    });

    it(`${key}: missing descriptions are unavailable, without a fabricated value or description recovery`, () => {
      const rows = [{ id: "abcdefghij", artifact: family.artifact, record: { details: "x".repeat(40_000) } }];
      const result = projectEntityList(response(rows), resolveEntityListSelector(undefined, rows, config), config);
      expect((result.entries as JsonObject[])[0]).toEqual({
        id: "abcdefghij",
        artifact: family.artifact,
        readable: {
          text: null,
          source: null,
          availability: "unavailable",
          metadata: {},
          detail_availability: null,
        },
        retrieval: {
          get: family.projection.get.replace("npx -y agentera@next", "agentera").replace("ID", "abcdefghij"),
        },
      });
    });
  }

  it.each([false, true])("uses TODO description after title with summary pressure=%s without changing selectors", (pressure) => {
    const description = "[refactor:3.0.0] Refactor plan levels from skip/light/full to light/normal/full.";
    const rows = [undefined, " ", "Preferred title"].map((title, index) => ({
      id: String.fromCharCode(97 + index).repeat(10),
      artifact: "todo",
      record: {
        ...(title === undefined ? {} : { title }),
        description,
        status: "open",
        details: pressure ? "x".repeat(40_000) : "small",
      },
    }));
    const config = todoOptions();
    const result = projectEntityList(response(rows), resolveEntityListSelector(undefined, rows, config), config);
    expect(result).toMatchObject({
      projection: { detail: pressure ? "summary" : "full" },
      counts: { returned: 3 },
    });
    expect((result.entries as JsonObject[]).map((row) => row.readable)).toEqual([
      ...Array.from({ length: 2 }, () =>
        expect.objectContaining({
          text: description,
          source: "record.description",
          availability: "included",
        }),
      ),
      expect.objectContaining({
        text: "Preferred title",
        source: "record.title",
        availability: "included",
      }),
    ]);
    for (const selector of [{ fields: "description,status" }, { idsOnly: true }]) {
      const selectedConfig = todoOptions(selector);
      const selected = projectEntityList(response(rows), resolveEntityListSelector(selector, rows, selectedConfig), selectedConfig);
      expect((selected.entries as JsonObject[]).map((row) => row.id)).toEqual(rows.map((row) => row.id));
      for (const row of selected.entries as JsonObject[]) {
        expect(row.readable).toBeUndefined();
        if (selector.fields) expect(row.record).toEqual({ description, status: "open" });
        else expect(row.record).toBeUndefined();
      }
    }
  });

  it("labels bounded Unicode excerpts without changing exact or explicitly selected machine values", () => {
    const name = "🧭".repeat(161);
    const rows = [{ id: "abcdefghij", artifact: "plan", record: { name, status: "pending" } }];
    const config = options();
    const result = projectEntityList(response(rows), resolveEntityListSelector(undefined, rows, config), config);
    expect((result.entries as JsonObject[])[0]).toMatchObject({
      record: { name },
      readable: { text: "🧭".repeat(160), source: "record.name", availability: "excerpt" },
    });
    const selectedConfig = options({ fields: "name" });
    const selected = projectEntityList(response(rows), resolveEntityListSelector(selectedConfig.selector, rows, selectedConfig), selectedConfig);
    expect((selected.entries as JsonObject[])[0]).toEqual({
      id: "abcdefghij",
      artifact: "plan",
      record: { name },
      retrieval: { get: "agentera state plan tasks get --id abcdefghij" },
    });
    expect(rows[0].record.name).toBe(name);
  });

  it("keeps compacted source availability when only a saved summary exists", () => {
    for (const key of ["decisions", "progress", "health"] as const) {
      const config = { ...options(), family: key, artifact: key };
      const rows = [
        {
          id: "abcdefghij",
          artifact: key,
          detail_availability: "summary",
          record: {
            summary: "Saved summary",
            migration_provenance: { evidence: "x".repeat(40_000) },
          },
        },
      ];
      const result = projectEntityList(response(rows), resolveEntityListSelector(undefined, rows, config), config);
      expect((result.entries as JsonObject[])[0]).toMatchObject({
        readable: {
          text: "Saved summary",
          source: "record.summary",
          availability: "included",
          detail_availability: "summary",
        },
      });
      expect(JSON.stringify(result)).not.toContain("full detail");
    }
  });

  it("keeps all 100 summary rows when optional full detail exceeds the byte budget", () => {
    const rows = entries(100, "x".repeat(1_000));
    const config = options();
    const selector = resolveEntityListSelector(undefined, rows, config);
    const projected = projectEntityList(response(rows), selector, config);

    expect(projected).toMatchObject({
      status: "degraded",
      counts: { candidate: 100, returned: 100, omitted: 0, continuation: 0 },
      projection: { selector: "default", detail: "minimum", cardinality: "requested_rows" },
      degradation: { reason: "optional_detail_byte_budget", detail_omitted_count: 100 },
    });
    expect(projected.entries as JsonObject[]).toHaveLength(100);
    expect((projected.entries as JsonObject[]).every((entry) => !entry.record && (entry.retrieval as JsonObject).get === `agentera state plan tasks get --id ${entry.id}`)).toBe(true);
  });

  it("returns deterministic IDs-only and selected-field rows and rejects bounded selector pressure", () => {
    const rows = entries(2);
    const idsConfig = options({ idsOnly: true });
    const ids = resolveEntityListSelector(idsConfig.selector, rows, idsConfig);
    expect(projectEntityList(response(rows), ids, idsConfig)).toMatchObject({
      entries: [
        {
          id: rows[0].id,
          artifact: "plan",
          retrieval: { get: `agentera state plan tasks get --id ${rows[0].id}` },
        },
        {
          id: rows[1].id,
          artifact: "plan",
          retrieval: { get: `agentera state plan tasks get --id ${rows[1].id}` },
        },
      ],
      counts: { candidate: 2, returned: 2, omitted: 0 },
      projection: { selector: "ids_only", detail: "identity" },
    });

    const fieldsConfig = options({ fields: "status,nested.value" });
    const fields = resolveEntityListSelector(fieldsConfig.selector, rows, fieldsConfig);
    expect(fields.fields).toEqual(["nested.value", "status"]);
    expect(entityListSelectorKey(fields)).toBe(entityListSelectorKey(resolveEntityListSelector({ fields: "nested.value,status" }, rows, fieldsConfig)));
    expect(projectEntityList(response(rows), fields, fieldsConfig)).toMatchObject({
      entries: [{ record: { nested: { value: 0 }, status: "pending" } }, { record: { nested: { value: 1 }, status: "pending" } }],
      projection: {
        selector: "fields",
        detail: "selected_fields",
        fields: ["nested.value", "status"],
      },
    });
    expect(() => projectEntityList(response(rows), ids, options({ idsOnly: true }, 100))).toThrow(/IDs-only rows cannot fit/);
    expect(() => projectEntityList(response(rows), fields, options({ fields: "status,nested.value" }, 100))).toThrow(/selected fields cannot fit/);
  });

  it.each(["title", "description"])("keeps TODO %s IDs-only minimal and deterministically sheds optional summary fields before rows", (field) => {
    const rows = todoEntries(100).map((row) => ({
      ...row,
      record: { [field]: (row.record as JsonObject).title, status: "open" },
    }));
    const idsConfig = todoOptions({ idsOnly: true });
    const ids = resolveEntityListSelector(idsConfig.selector, rows, idsConfig);
    const identity = projectEntityList(response(rows), ids, idsConfig);
    expect(identity.entries as JsonObject[]).toHaveLength(100);
    expect((identity.entries as JsonObject[]).every((entry) => Object.keys(entry).sort().join(",") === "artifact,id,queue_rank,retrieval" && (entry.retrieval as JsonObject).get === `agentera state todo get --id ${entry.id}`)).toBe(true);

    const defaultConfig = todoOptions();
    const projected = projectEntityList(response(rows), resolveEntityListSelector(undefined, rows, defaultConfig), defaultConfig);
    expect(projected).toMatchObject({
      status: "degraded",
      counts: { candidate: 100, returned: 100, omitted: 0, continuation: 0 },
      projection: { selector: "default", detail: "minimum", cardinality: "requested_rows" },
      degradation: {
        reason: "optional_detail_byte_budget",
        detail_omitted_count: 100,
        omitted_fields: ["actionability", "provenance", "public_order", "readable", "readiness", "reconciliation", "record"],
      },
    });
    expect(projected.entries as JsonObject[]).toEqual(identity.entries);

    const selectedConfig = todoOptions({ fields: field });
    const selected = resolveEntityListSelector(selectedConfig.selector, rows, selectedConfig);
    expect(() => projectEntityList(response(rows), selected, selectedConfig)).toThrow(/selected fields cannot fit/);
  });

  it("rejects malformed, duplicate, absent, and combined selectors without partial output", () => {
    const rows = entries(1);
    for (const selector of [{ fields: "missing" }, { fields: "status,status" }, { fields: "Status" }, { idsOnly: true, fields: "status" }]) {
      const config = options(selector);
      expect(() => resolveEntityListSelector(selector, rows, config)).toThrow();
    }
  });
});

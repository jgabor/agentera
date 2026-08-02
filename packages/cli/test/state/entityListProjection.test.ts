import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/core/jsonValue.js";
import {
  entityListSelectorKey,
  projectEntityList,
  resolveEntityListSelector,
  type EntityListProjectionOptions,
  type EntityListSelectorInput,
} from "../../src/state/entityListProjection.js";

function entries(count: number, detail = "small"): JsonObject[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `${String.fromCharCode(97 + Math.floor(index / 26)).repeat(9)}${String.fromCharCode(97 + index % 26)}`;
    return { id, artifact: "plan", record: { name: `${index}-${detail}`, status: "pending", nested: { value: index } }, provenance: { path: `${id}.yaml` } };
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
    retrieval: { get: "agentera state plan tasks get --id ID --format json" },
  };
}

function options(selector?: EntityListSelectorInput, maxUtf8Bytes = 32_768): EntityListProjectionOptions {
  return {
    artifact: "plan",
    boundary: "plan_task",
    format: "json",
    maxUtf8Bytes,
    getCommand: "agentera state plan tasks get --id ID --format json",
    syntax: "agentera state plan tasks list [--limit N] [--cursor TOKEN] [--ids-only|--fields FIELDS] --format json",
    selector,
  };
}

describe("bounded entity list projection", () => {
  it("keeps all 100 summary rows when optional full detail exceeds the byte budget", () => {
    const rows = entries(100, "x".repeat(1_000));
    const config = options();
    const selector = resolveEntityListSelector(undefined, rows, config);
    const projected = projectEntityList(response(rows), selector, config);

    expect(projected).toMatchObject({
      status: "degraded",
      counts: { candidate: 100, returned: 100, omitted: 0, continuation: 0 },
      projection: { selector: "default", detail: "summary", cardinality: "requested_rows" },
      degradation: { reason: "optional_detail_byte_budget", detail_omitted_count: 100 },
    });
    expect((projected.entries as JsonObject[])).toHaveLength(100);
    expect((projected.entries as JsonObject[]).every((entry) => !entry.record && (entry.retrieval as JsonObject).get === `agentera state plan tasks get --id ${entry.id} --format json`)).toBe(true);
  });

  it("returns deterministic IDs-only and selected-field rows and rejects bounded selector pressure", () => {
    const rows = entries(2);
    const idsConfig = options({ idsOnly: true });
    const ids = resolveEntityListSelector(idsConfig.selector, rows, idsConfig);
    expect(projectEntityList(response(rows), ids, idsConfig)).toMatchObject({
      entries: [
        { id: rows[0].id, artifact: "plan", retrieval: { get: `agentera state plan tasks get --id ${rows[0].id} --format json` } },
        { id: rows[1].id, artifact: "plan", retrieval: { get: `agentera state plan tasks get --id ${rows[1].id} --format json` } },
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
      projection: { selector: "fields", detail: "selected_fields", fields: ["nested.value", "status"] },
    });
    expect(() => projectEntityList(response(rows), ids, options({ idsOnly: true }, 100))).toThrow(/IDs-only rows cannot fit/);
    expect(() => projectEntityList(response(rows), fields, options({ fields: "status,nested.value" }, 100))).toThrow(/selected fields cannot fit/);
  });

  it("rejects malformed, duplicate, absent, and combined selectors without partial output", () => {
    const rows = entries(1);
    for (const selector of [{ fields: "missing" }, { fields: "status,status" }, { fields: "Status" }, { idsOnly: true, fields: "status" }]) {
      const config = options(selector);
      expect(() => resolveEntityListSelector(selector, rows, config)).toThrow();
    }
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  activeStructuredInputRouteIds,
  activeStructuredInputSources,
  computeSyntheticMetrics,
  validateStructuredInputInventory,
} from "../../src/registries/structuredInputInventory.js";

const INVENTORY = path.resolve(__dirname, "../../../../references/analysis/structured-input-inventory.yaml");

describe("structured input inventory", () => {
  it("covers every active route once and records the reproducible synthetic-only baseline", () => {
    expect(validateStructuredInputInventory(INVENTORY)).toEqual([]);
    expect(computeSyntheticMetrics(1024, [
      { wrapper: true, contentBearing: true },
      { wrapper: false, contentBearing: true },
    ])).toEqual({ child_process_count: 2, wrapper_count: 1, duplicate_content_bytes: 1024 });
    const inventory = YAML.parse(fs.readFileSync(INVENTORY, "utf8"));
    expect(inventory.synthetic_baseline).toMatchObject({
      route_identity: "synthetic.fixed-content.transport",
      content_bytes: 1024,
      deltas: { child_process_count: -1, wrapper_count: -1, duplicate_content_bytes: -1024 },
    });
    expect(inventory.closure_evidence).toMatchObject({
      simplify_remove_rows: 0,
      command_trace_proof: "not_applicable_zero_simplify_remove_rows",
    });
  });

  it.each([
    ["unsupported schema", (value: any) => { value.schema_version = "agentera.structuredInputInventory.v0"; }, "unsupported structured input inventory schema_version"],
    ["wrong scope", (value: any) => { value.scope = "all_routes"; }, "structured input inventory has invalid scope"],
    ["included historical policy", (value: any) => { value.historical_surfaces = "included"; }, "structured input inventory must exclude historical surfaces"],
    ["anonymous route", (value: any) => { value.routes[0].id = ""; }, "route id must be a nonempty string: row 1"],
    ["mismatched route owner", (value: any) => { value.routes[0].owner = "report"; }, "route owner does not match namespace: writer.progress.append.input"],
    ["active route count", (value: any) => { value.closure_evidence.active_registry_routes = 28; }, "active registry route count does not match active routes"],
    ["classified route count", (value: any) => { value.closure_evidence.classified_active_routes = 28; }, "classified active route count does not match inventory routes"],
    ["historical closure policy", (value: any) => { value.closure_evidence.historical_only_routes = 1; }, "closure evidence must exclude historical routes"],
    ["unresolved route count", (value: any) => { value.closure_evidence.unresolved_rows = 1; }, "unresolved row count does not match route dispositions"],
    ["simplify/remove route count", (value: any) => { value.closure_evidence.simplify_remove_rows = 1; }, "simplify/remove row count does not match route dispositions"],
  ])("rejects %s", (_name, mutate, expected) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "structured-input-inventory-"));
    try {
      const changedInventoryPath = path.join(directory, "inventory.yaml");
      const inventory = YAML.parse(fs.readFileSync(INVENTORY, "utf8"));
      mutate(inventory);
      fs.writeFileSync(changedInventoryPath, YAML.stringify(inventory));
      expect(validateStructuredInputInventory(changedInventoryPath)).toContain(expected);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["malformed YAML", "routes: [", "structured input inventory contains malformed YAML"],
    ["sequence root", "- route", "structured input inventory root must be a mapping"],
    ["scalar root", "route", "structured input inventory root must be a mapping"],
    ["non-list routes", "schema_version: agentera.structuredInputInventory.v1\nscope: active_structured_input_routes_only\nhistorical_surfaces: excluded\nroutes: {}\n", "structured input inventory routes must be a list of mappings"],
    ["non-mapping route", "schema_version: agentera.structuredInputInventory.v1\nscope: active_structured_input_routes_only\nhistorical_surfaces: excluded\nroutes: [route]\n", "structured input inventory routes must be a list of mappings"],
  ])("returns a bounded diagnostic for %s", (_name, source, expected) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "structured-input-inventory-"));
    try {
      const inventoryPath = path.join(directory, "inventory.yaml");
      fs.writeFileSync(inventoryPath, source);
      expect(validateStructuredInputInventory(inventoryPath)).toEqual([expected]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a content-safe diagnostic for an unreadable file", () => {
    expect(validateStructuredInputInventory("/not/a/real/inventory/caller-secret.yaml"))
      .toEqual(["structured input inventory is unreadable"]);
  });

  it("records compact glossary closure without changing retained route dispositions", () => {
    const inventory = YAML.parse(fs.readFileSync(INVENTORY, "utf8")) as {
      closure_evidence: {
        behavior_changed: boolean;
        writer_preflight: Record<string, string | number>;
        approved_compact_routes: string[];
        retained_structured_glossary_routes: string[];
        compound_approval: {
          disposition: string;
          hidden_state: string;
          guidance: string;
          routes: Array<Record<string, string>>;
        };
        changed_route_test_requirement: string;
      };
      routes: Array<{ id: string; disposition: string }>;
    };
    expect(inventory.closure_evidence).toMatchObject({
      behavior_changed: false,
      writer_preflight: {
        active_payload_routes: 29,
        payload_disposition: "retain_all",
        normal_publication: "one_serialization_one_typed_writer_call",
        explicit_preview: "dry_run_then_apply_same_unchanged_input",
        routine_lint_dry_run_create_regeneration: "forbidden",
        effect_confirmation: "retain_evidence_bound_second_phase",
        removal_eligibility: "preserve_all_caller_fields_owned_field_exclusion_hash_binding_stale_input_rejection_and_idempotent_replay",
      },
      approved_compact_routes: [
        "report.glossary-advice.term-input",
        "startup.build.term-input",
        "startup.discuss.term-input",
        "startup.plan.term-input",
      ],
      retained_structured_glossary_routes: [
        "report.glossary-advice.input",
        "report.personal-glossary-reviews.disposition.input",
        "report.personal-glossary-reviews.queue.input",
      ],
      compound_approval: {
        disposition: "retain_all",
        hidden_state: "forbidden",
        routes: [
          expect.objectContaining({ id: "report.personal-glossary-decision.input" }),
          expect.objectContaining({ id: "report.personal-glossary-publish.input" }),
          expect.objectContaining({ id: "report.personal-glossary-reviews.queue.input" }),
          expect.objectContaining({ id: "report.personal-glossary-reviews.disposition.input" }),
        ],
      },
      changed_route_test_requirement: "not_applicable",
    });
    for (const route of inventory.closure_evidence.compound_approval.routes) {
      expect(route).toMatchObject({
        explicit_confirmation: "required",
        stale_or_mismatch: "reject_before_effects",
      });
      expect(["unchanged", "unchanged_replay"]).toContain(route.exact_replay);
      expect(inventory.routes.find(({ id }) => id === route.id)?.disposition).toBe("retain");
    }
    expect(inventory.routes).toHaveLength(inventory.closure_evidence.writer_preflight.active_payload_routes);
    for (const id of [
      ...inventory.closure_evidence.approved_compact_routes,
      ...inventory.closure_evidence.retained_structured_glossary_routes,
    ]) {
      expect(inventory.routes.find((route) => route.id === id)?.disposition).toBe("retain");
    }
  });

  it("fails when active report or startup command specifications drift", () => {
    const reportChanged = activeStructuredInputSources();
    reportChanged.reviewSpecs = [...reportChanged.reviewSpecs, { action: "new", option: "--input" }];
    expect(validateStructuredInputInventory(INVENTORY, activeStructuredInputRouteIds(reportChanged)))
      .toEqual([
        "missing active route: report.personal-glossary-reviews.new.input",
        "active registry route count does not match active routes",
      ]);

    const startupChanged = activeStructuredInputSources();
    startupChanged.startupSpecs = startupChanged.startupSpecs.slice(1);
    expect(validateStructuredInputInventory(INVENTORY, activeStructuredInputRouteIds(startupChanged)))
      .toEqual([
        "extra route: startup.build.input",
        "active registry route count does not match active routes",
      ]);
  });

  it("fails on writer registry, duplicate identity, and unowned identity drift", () => {
    const writerChanged = activeStructuredInputSources();
    writerChanged.writerOperations = writerChanged.writerOperations
      .filter(({ artifact, verb }) => artifact !== "progress" || verb !== "append");
    expect(validateStructuredInputInventory(INVENTORY, activeStructuredInputRouteIds(writerChanged)))
      .toEqual([
        "extra route: writer.progress.append.input",
        "active registry route count does not match active routes",
      ]);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "structured-input-inventory-"));
    const changedInventoryPath = path.join(directory, "inventory.yaml");
    try {
      const inventory = YAML.parse(fs.readFileSync(INVENTORY, "utf8")) as {
        routes: Array<{ id: string; owner?: string; disposition?: string }>;
        exceptions?: Array<{ route_id: string; owner?: string }>;
      };
      const writerRoute = inventory.routes.find(({ id }) => id === "writer.progress.append.input")!;

      inventory.routes.push({ ...writerRoute });
      fs.writeFileSync(changedInventoryPath, YAML.stringify(inventory));
      expect(validateStructuredInputInventory(changedInventoryPath))
        .toEqual([
          "duplicate route: writer.progress.append.input",
          "classified active route count does not match inventory routes",
        ]);

      inventory.routes.pop();
      delete writerRoute.owner;
      fs.writeFileSync(changedInventoryPath, YAML.stringify(inventory));
      expect(validateStructuredInputInventory(changedInventoryPath))
        .toEqual(["unowned route: writer.progress.append.input"]);

      writerRoute.owner = "writer";
      delete writerRoute.disposition;
      inventory.exceptions = [{ route_id: "writer.progress.append.input" }];
      fs.writeFileSync(changedInventoryPath, YAML.stringify(inventory));
      expect(validateStructuredInputInventory(changedInventoryPath)).toEqual([
        "invalid disposition: writer.progress.append.input",
        "unowned exception: writer.progress.append.input",
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

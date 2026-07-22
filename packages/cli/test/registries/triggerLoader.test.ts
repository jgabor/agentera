import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCapabilitySchemaContract } from "../../src/registries/capabilityContract.js";
import {
  TriggerLoaderError,
  capabilitiesBaseDir,
  loadTriggerModel,
  triggersYamlPath,
} from "../../src/registries/triggerLoader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CONTRACT_PATH = path.join(REPO_ROOT, "skills", "agentera", "capability_schema_contract.yaml");

const CAPABILITY_IDS = [
  "status",
  "vision",
  "discuss",
  "research",
  "plan",
  "build",
  "optimize",
  "audit",
  "document",
  "profile",
  "design",
  "orchestrate",
] as const;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-loader-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("trigger schema loader — live repo fixtures", () => {
  const contract = loadCapabilitySchemaContract(CONTRACT_PATH);

  function checkedInEntries(capability: string): Record<string, unknown>[] {
    const source = fs.readFileSync(triggersYamlPath(capability, REPO_ROOT), "utf8");
    const schema = YAML.parse(source) as { TRIGGERS: Record<string, Record<string, unknown>> };
    return Object.values(schema.TRIGGERS);
  }

  it("loads all twelve capabilities from the checked-in triggers.yaml files", () => {
    const model = loadTriggerModel(contract, { sourceRoot: REPO_ROOT });
    expect(model.capabilities.size).toBe(12);
    for (const id of CAPABILITY_IDS) {
      expect(model.capabilities.has(id), `expected ${id} in model`).toBe(true);
      const entry = model.capabilities.get(id)!;
      expect(entry.capability).toBe(id);
      expect(entry.triggers.length).toBeGreaterThan(0);
    }
  });

  it("uses checked-in triggers as LLM intent metadata rather than legacy matcher inputs", () => {
    const model = loadTriggerModel(contract, { sourceRoot: REPO_ROOT });
    const inertCompatibilityFields = [
      "patterns",
      ...Object.keys(contract.triggerEnrichment.fields).filter((field) => field !== "disambiguates_against"),
    ];

    for (const capability of CAPABILITY_IDS) {
      const entries = checkedInEntries(capability);
      for (const entry of entries) {
        expect(entry.description, `${capability} trigger description`).toEqual(expect.any(String));
        expect(entry.priority, `${capability} trigger priority`).toBeOneOf(
          contract.triggerPriorityRules.allowedValues,
        );
        for (const field of inertCompatibilityFields) {
          expect(entry, `${capability} ${String(entry.id)} must not present inert ${field}`).not.toHaveProperty(field);
        }
      }
      for (const entry of model.capabilities.get(capability)!.triggers) {
        expect(entry).not.toHaveProperty("patterns");
        expect(entry).not.toHaveProperty("patternsRegex");
      }
    }

    expect(checkedInEntries("status").find((entry) => entry.id === "T5")!.fallback).toBe(true);
    expect(checkedInEntries("status").find((entry) => entry.id === "T5")!.priority).toBe("low");
    expect(checkedInEntries("build").find((entry) => entry.id === "T4")!.description).not.toContain("vision");
  });

  it("resolves every disambiguates_against reference to a capability present in the model", () => {
    const model = loadTriggerModel(contract, { sourceRoot: REPO_ROOT });
    for (const { capability, triggers } of model.capabilities.values()) {
      for (const entry of triggers) {
        for (const ref of entry.disambiguatesAgainst) {
          const referenced = model.capabilities.get(ref.capability);
          expect(referenced, `${capability} ${entry.id} → ${ref.capability}`).toBeDefined();
          expect(referenced!.triggers.length).toBeGreaterThan(0);
        }
      }
    }
    // Spot check: vision T3 distinguishes direction from implementation.
    const visionT3 = model.capabilities.get("vision")!.triggers.find((t) => t.id === "T3")!;
    const buildRef = visionT3.disambiguatesAgainst.find((d) => d.capability === "build");
    expect(buildRef).toBeDefined();
    expect(buildRef!.hint.length).toBeGreaterThan(0);
    expect(model.capabilities.get(buildRef!.capability)!.capability).toBe("build");
  });

});

describe("trigger schema loader — temp fixture", () => {
  function writeTriggersFixture(rootDir: string, capability: string, body: object): string {
    const capDir = path.join(rootDir, "skills", "agentera", "capabilities", capability, "schemas");
    fs.mkdirSync(capDir, { recursive: true });
    const file = path.join(capDir, "triggers.yaml");
    fs.writeFileSync(file, YAML.stringify(body));
    return file;
  }

  it("accepts legacy matcher fields without carrying them into semantic intent", () => {
    const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
    // Build a minimal legacy triggers.yaml that omits every enriched field for
    // the twelve capabilities. `patterns` remains accepted for compatibility.
    for (const id of CAPABILITY_IDS) {
      writeTriggersFixture(tmp, id, {
        TRIGGERS: {
          1: {
            id: "T1",
            description: `minimal trigger for ${id}`,
            priority: "medium",
            patterns: [id],
          },
        },
      });
    }
    const model = loadTriggerModel(contract, { sourceRoot: tmp });

    for (const id of CAPABILITY_IDS) {
      const entry = model.capabilities.get(id)!.triggers[0]!;
      expect(entry, id).not.toHaveProperty("patterns");
      expect(entry, id).not.toHaveProperty("patternsRegex");
      expect(entry, id).not.toHaveProperty("confidenceThreshold");
      expect(entry, id).not.toHaveProperty("borderlineBand");
      expect(entry.disambiguatesAgainst, id).toEqual([]);
      expect(entry.fallback).toBe(false);
    }
  });

  it("discards legacy enriched fields without letting them influence the loaded intent", () => {
    const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
    writeTriggersFixture(tmp, "status", {
      TRIGGERS: {
        1: {
          id: "T1",
          description: "regex-bearing trigger",
          priority: "high",
          patterns: ["status"],
          patterns_regex: ["\\brefine\\s+the\\s+vision\\b"],
          confidence_threshold: 72,
          borderline_band: 8,
        },
      },
    });
    // Only status is materialized; the loader collects per-capability errors.
    expect(() => loadTriggerModel(contract, { sourceRoot: tmp })).toThrow(TriggerLoaderError);

    // To isolate success, provide minimal triggers.yaml for the other eleven.
    for (const id of CAPABILITY_IDS) {
      if (id === "status") continue;
      writeTriggersFixture(tmp, id, {
        TRIGGERS: {
          1: {
            id: "T1",
            description: `minimal trigger for ${id}`,
            priority: "medium",
            patterns: [id],
          },
        },
      });
    }
    const model = loadTriggerModel(contract, { sourceRoot: tmp });
    const statusT1 = model.capabilities.get("status")!.triggers[0]!;
    expect(statusT1).toEqual({
      id: "T1",
      description: "regex-bearing trigger",
      priority: "high",
      disambiguatesAgainst: [],
      fallback: false,
    });

    writeTriggersFixture(tmp, "status", {
      TRIGGERS: {
        1: {
          id: "T1",
          description: "regex-bearing trigger",
          priority: "high",
          patterns: ["status"],
          patterns_regex: ["\\brefine\\s+the\\s+vision\\b"],
          confidence_threshold: 0,
          borderline_band: 100,
        },
      },
    });
    expect(loadTriggerModel(contract, { sourceRoot: tmp }).capabilities.get("status")!.triggers[0]!).toEqual(statusT1);

    // Now corrupt the regex and verify the loader surfaces a TriggerLoaderError.
    writeTriggersFixture(tmp, "status", {
      TRIGGERS: {
        1: {
          id: "T1",
          description: "bad regex trigger",
          priority: "high",
          patterns: ["status"],
          patterns_regex: ["(unclosed"],
        },
      },
    });
    expect(() => loadTriggerModel(contract, { sourceRoot: tmp })).toThrow(TriggerLoaderError);
  });

  it("rejects a disambiguates_against capability that is not canonical", () => {
    const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
    for (const id of CAPABILITY_IDS) {
      const body: Record<string, unknown> = {
        TRIGGERS: {
          1: {
            id: "T1",
            description: `minimal trigger for ${id}`,
            priority: "medium",
            patterns: [id],
          },
        },
      };
      if (id === "vision") {
        (body.TRIGGERS as Record<string, unknown>)[1] = {
          id: "T1",
          description: "vision with bad disambiguation",
          priority: "high",
          patterns: ["vision"],
          disambiguates_against: [{ capability: "nonexistent", hint: "should fail" }],
        };
      }
      writeTriggersFixture(tmp, id, body);
    }
    let caught: TriggerLoaderError | null = null;
    try {
      loadTriggerModel(contract, { sourceRoot: tmp });
    } catch (err) {
      caught = err as TriggerLoaderError;
    }
    expect(caught).toBeInstanceOf(TriggerLoaderError);
    expect(caught!.errors.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  it("rejects a missing triggers.yaml file", () => {
    const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
    // Leave tmp empty: no triggers.yaml for any capability.
    let caught: TriggerLoaderError | null = null;
    try {
      loadTriggerModel(contract, { sourceRoot: tmp });
    } catch (err) {
      caught = err as TriggerLoaderError;
    }
    expect(caught).toBeInstanceOf(TriggerLoaderError);
    expect(caught!.errors.some((e) => e.includes("triggers.yaml not found"))).toBe(true);
  });
});

describe("trigger schema loader — path helpers", () => {
  it("capabilitiesBaseDir joins the canonical skills path", () => {
    expect(capabilitiesBaseDir("/repo")).toBe(
      path.join("/repo", "skills", "agentera", "capabilities"),
    );
  });

  it("triggersYamlPath targets the canonical schema file", () => {
    expect(triggersYamlPath("status", "/repo")).toBe(
      path.join("/repo", "skills", "agentera", "capabilities", "status", "schemas", "triggers.yaml"),
    );
  });
});

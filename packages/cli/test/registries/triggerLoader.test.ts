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

  it("compiles patterns_regex entries into usable RegExp objects", () => {
    const model = loadTriggerModel(contract, { sourceRoot: REPO_ROOT });
    const vision = model.capabilities.get("vision")!;
    const t3 = vision.triggers.find((t) => t.id === "T3")!;
    expect(t3.patternsRegex.length).toBeGreaterThan(0);
    const sample = t3.patternsRegex[0];
    expect(sample).toBeInstanceOf(RegExp);
    // The vision T3 entry documents "refine the vision" as a regex pattern.
    expect(t3.patternsRegex.some((re) => re.test("I want to refine the vision now"))).toBe(true);
    // Compiled regexes are case-insensitive per the enrichment spec (§1.3).
    expect(t3.patternsRegex.some((re) => re.test("REFINE THE VISION"))).toBe(true);
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
    // Spot check: vision T3 declares a disambiguation against build.
    const visionT3 = model.capabilities.get("vision")!.triggers.find((t) => t.id === "T3")!;
    const buildRef = visionT3.disambiguatesAgainst.find((d) => d.capability === "build");
    expect(buildRef).toBeDefined();
    expect(buildRef!.hint.length).toBeGreaterThan(0);
    expect(model.capabilities.get(buildRef!.capability)!.capability).toBe("build");
  });

  it("applies contract defaults for enriched fields that are absent", () => {
    const model = loadTriggerModel(contract, { sourceRoot: REPO_ROOT });
    // status T2 omits borderline_band; it must receive the contract default (15).
    const statusT2 = model.capabilities.get("status")!.triggers.find((t) => t.id === "T2")!;
    expect(statusT2.borderlineBand).toBe(contract.triggerEnrichment.contractDefaults.borderlineBand);
    expect(statusT2.confidenceThreshold).toBe(40); // status T2 sets confidence_threshold: 40

    // discuss T1 sets both fields; they must be honored, not defaulted.
    const discussT1 = model.capabilities.get("discuss")!.triggers.find((t) => t.id === "T1")!;
    expect(discussT1.confidenceThreshold).toBe(60);
    expect(discussT1.borderlineBand).toBe(10);

    // status T5 is the fallback marker entry.
    const statusT5 = model.capabilities.get("status")!.triggers.find((t) => t.id === "T5")!;
    expect(statusT5.fallback).toBe(true);
    expect(statusT5.priority).toBe("low");
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

  it("applies contract defaults for every enriched field when omitted", () => {
    const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
    // Build a minimal triggers.yaml that omits every enriched field for the
    // twelve capabilities. Only id/description/priority/patterns are set.
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
      expect(entry.confidenceThreshold, id).toBe(
        contract.triggerEnrichment.contractDefaults.confidenceThreshold,
      );
      expect(entry.borderlineBand, id).toBe(
        contract.triggerEnrichment.contractDefaults.borderlineBand,
      );
      expect(entry.patternsRegex, id).toEqual([]);
      expect(entry.disambiguatesAgainst, id).toEqual([]);
      expect(entry.fallback).toBe(false);
    }
  });

  it("compiles a declared regex pattern and rejects an invalid one", () => {
    const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
    writeTriggersFixture(tmp, "status", {
      TRIGGERS: {
        1: {
          id: "T1",
          description: "regex-bearing trigger",
          priority: "high",
          patterns: ["status"],
          patterns_regex: ["\\brefine\\s+the\\s+vision\\b"],
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
    expect(statusT1.patternsRegex.length).toBe(1);
    expect(statusT1.patternsRegex[0]).toBeInstanceOf(RegExp);
    expect(statusT1.patternsRegex[0]!.test("please refine the vision now")).toBe(true);

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

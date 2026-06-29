import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadCapabilitySchemaContract } from "../../src/registries/capabilityContract.js";
import { loadTriggerModel } from "../../src/registries/triggerLoader.js";
import {
  ROUTE_FALLBACK_CAPABILITY,
  routeInput,
} from "../../src/routing/routeEngine.js";
import {
  CORPUS,
  DISAMBIGUATION_INPUTS,
  FALLBACK_INPUTS,
} from "./routeCorpus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "skills",
  "agentera",
  "capability_schema_contract.yaml",
);

const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
const model = loadTriggerModel(contract, { sourceRoot: REPO_ROOT });

describe("routeInput — pure function", () => {
  it("returns structurally identical results for the same input on repeated calls", () => {
    const a = routeInput("plan the next feature", model);
    const b = routeInput("plan the next feature", model);
    expect(a).toEqual(b);
  });

  it("does not mutate the input model or expose side effects", () => {
    const before = model.capabilities.size;
    routeInput("audit the codebase", model);
    routeInput("xyzzy nonsense", model);
    expect(model.capabilities.size).toBe(before);
  });
});

describe("routeInput — corpus accuracy (>=31 of 36 required)", () => {
  const results = CORPUS.map((e) => ({
    input: e.input,
    expected: e.expected,
    actual: routeInput(e.input, model),
  }));

  const correct = results.filter(
    (r) =>
      r.actual.capability === r.expected &&
      !r.actual.fallback &&
      r.actual.confidence > 0,
  ).length;

  it(`routes ${correct} of ${CORPUS.length} corpus inputs correctly (>= 31 required)`, () => {
    expect(correct).toBeGreaterThanOrEqual(31);
  });

  it("does not return fallback for any corpus input that should match", () => {
    const fallbacks = results.filter((r) => r.actual.fallback);
    if (fallbacks.length > 0) {
      throw new Error(
        `unexpected fallback for inputs: ${fallbacks.map((f) => JSON.stringify(f.input)).join(", ")}`,
      );
    }
  });

  // Per-input reporting so failures are easy to diagnose.
  for (const r of results) {
    it(`routes ${JSON.stringify(r.input)} -> ${r.expected}`, () => {
      expect(r.actual.capability).toBe(r.expected);
      expect(r.actual.fallback).toBe(false);
    });
  }
});

describe("routeInput — adversarial disambiguation", () => {
  for (const input of DISAMBIGUATION_INPUTS) {
    it(`returns 2+ candidates for ${JSON.stringify(input)}`, () => {
      const result = routeInput(input, model);
      expect(result.fallback).toBe(false);
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
      expect(result.confidence).toBeGreaterThan(0);
      // Each candidate carries its own non-zero confidence.
      for (const c of result.candidates) {
        expect(c.confidence).toBeGreaterThan(0);
      }
    });
  }
});

describe("routeInput — adversarial fallback", () => {
  for (const input of FALLBACK_INPUTS) {
    it(`falls back to status for ${JSON.stringify(input)}`, () => {
      const result = routeInput(input, model);
      expect(result.fallback).toBe(true);
      expect(result.capability).toBe(ROUTE_FALLBACK_CAPABILITY);
      expect(result.confidence).toBe(0);
      expect(result.candidates).toEqual([]);
    });
  }
});

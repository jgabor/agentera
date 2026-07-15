import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inspectArtifactVerbosityBudget,
  resolveVerbosityBudgetOwner,
  validateVerbosityBudgetContract,
  VerbosityBudgetContractError,
} from "../../src/registries/verbosityBudgetContract.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PRODUCTION_CONTRACT = path.join(REPO_ROOT, "references", "artifacts", "verbosity-budget-authority.yaml");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verbosity-budget-"));
  fs.mkdirSync(path.join(tmp, "schemas"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeFixture(
  artifacts: Array<{ artifact_id: string; schema: string }>,
  schemas: Record<string, unknown>,
): string {
  for (const [name, schema] of Object.entries(schemas)) {
    fs.writeFileSync(path.join(tmp, "schemas", name), YAML.stringify(schema));
  }
  const contractPath = path.join(tmp, "authority.yaml");
  fs.writeFileSync(contractPath, YAML.stringify({
    schema_version: "agentera.verbosityBudgetAuthority.v1",
    authority: { schema_directory: "schemas" },
    scope: { supported_artifacts: artifacts },
  }));
  return contractPath;
}

describe("verbosity budget authority classifications", () => {
  it("classifies numeric, no-limit, and non-word declarations", () => {
    const contract = writeFixture(
      [
        { artifact_id: "progress", schema: "progress.yaml" },
        { artifact_id: "decisions", schema: "decisions.yaml" },
        { artifact_id: "design", schema: "design.yaml" },
      ],
      {
        "progress.yaml": { BUDGET: { 1: { id: "PB1", scope: "full_file", max_words: 3000 } } },
        "decisions.yaml": { BUDGET: { 1: { id: "DB1", scope: "full_file", max_words: null } } },
        "design.yaml": { BUDGET: { 1: { id: "DS1", scope: "full_file", token_budget: 2000 } } },
      },
    );
    expect(inspectArtifactVerbosityBudget("progress", contract).dimensions[0].classification).toBe("numeric_limit");
    expect(inspectArtifactVerbosityBudget("decisions", contract).dimensions[0].classification).toBe("explicit_no_limit");
    expect(inspectArtifactVerbosityBudget("design", contract).dimensions[0].classification).toBe("non_word_unit");
    expect(validateVerbosityBudgetContract(contract)).toEqual([]);
  });

  it("classifies malformed and ambiguous declarations as invalid", () => {
    const contract = writeFixture(
      [{ artifact_id: "progress", schema: "progress.yaml" }],
      {
        "progress.yaml": {
          BUDGET: {
            1: { id: "PB1", scope: "full_file", max_words: 3000, token_budget: 2000 },
            2: { id: "PB2", scope: "full_file", max_words: 100 },
          },
        },
      },
    );
    const inspected = inspectArtifactVerbosityBudget("progress", contract);
    expect(inspected.dimensions.every((dimension) => dimension.classification === "invalid_declaration")).toBe(true);
    expect(validateVerbosityBudgetContract(contract)).toEqual([
      "progress:full_file: duplicate budget scope full_file",
      "progress:full_file: duplicate budget scope full_file",
    ]);
  });
});

describe("verbosity budget authority failures", () => {
  it("validates the checked-in owner inventory without fallback values", () => {
    expect(validateVerbosityBudgetContract(PRODUCTION_CONTRACT)).toEqual([]);
  });

  it("fails validation for malformed authority YAML", () => {
    const contract = path.join(tmp, "broken.yaml");
    fs.writeFileSync(contract, "scope: [");
    expect(validateVerbosityBudgetContract(contract)[0]).toContain("unreadable or malformed");
  });

  it("fails validation when an owning schema is unreadable", () => {
    const contract = writeFixture([{ artifact_id: "progress", schema: "missing.yaml" }], {});
    expect(validateVerbosityBudgetContract(contract)[0]).toContain("is unreadable or malformed");
  });

  it("fails validation when authority ownership is ambiguous", () => {
    const contract = writeFixture(
      [
        { artifact_id: "progress", schema: "one.yaml" },
        { artifact_id: "progress", schema: "two.yaml" },
      ],
      { "one.yaml": { BUDGET: {} }, "two.yaml": { BUDGET: {} } },
    );
    expect(validateVerbosityBudgetContract(contract)[0]).toContain("ambiguous owners for progress");
  });
});

describe("verbosity budget owner resolution", () => {
  it("resolves equivalent identifiers to one owning authority", () => {
    const canonical = resolveVerbosityBudgetOwner("plan", PRODUCTION_CONTRACT);
    const label = resolveVerbosityBudgetOwner("PLAN.md", PRODUCTION_CONTRACT);
    const storagePath = resolveVerbosityBudgetOwner(".agentera/plan.yaml", PRODUCTION_CONTRACT);
    expect(label).toEqual(canonical);
    expect(storagePath).toEqual(canonical);
  });

  it("rejects unsupported identifiers instead of selecting a generic owner", () => {
    expect(() => resolveVerbosityBudgetOwner("notes.md", PRODUCTION_CONTRACT)).toThrowError(
      VerbosityBudgetContractError,
    );
    expect(() => resolveVerbosityBudgetOwner("notes.md", PRODUCTION_CONTRACT)).toThrow("unsupported artifact");
  });
});

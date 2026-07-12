import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "skills/agentera/schemas/artifacts/plan.yaml");

function lifecycleContract(): Record<string, any> {
  const schema = YAML.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as Record<string, any>;
  return schema.LIFECYCLE_CONTRACT;
}

describe("plan lifecycle contract", () => {
  it("separates persisted lifecycle from positional activity", () => {
    const contract = lifecycleContract();

    expect(contract.authority).toBe("this schema");
    expect(contract.canonical.persisted_status.values).toEqual(["open", "complete"]);
    expect(contract.canonical.position.persisted).toBe(false);
    expect(contract.canonical.execution.archived).toContain("non-executable");
    expect(contract.canonical.forced_archive.unfinished_status).toBe("open");
  });

  it("bounds legacy reads and classifies every contract surface family", () => {
    const contract = lifecycleContract();
    const window = contract.compatibility.legacy_read_window;

    expect(window.scope).toContain("Read-only normalization");
    expect(window.removal_condition).toContain("regression tests prove");
    expect(window.test_boundary).toHaveLength(4);
    expect(contract.compatibility.external_consumers.commitment).toContain(
      "No compatibility window",
    );
    expect(Object.keys(contract.inventory).sort()).toEqual(
      [
        "adapters",
        "documented_external_commitments",
        "fixtures",
        "migrators",
        "readers",
        "schemas",
        "writers",
      ].sort(),
    );
    for (const surfaces of Object.values(contract.inventory)) {
      expect(surfaces).toBeInstanceOf(Array);
      expect(surfaces.length).toBeGreaterThan(0);
    }
  });
});

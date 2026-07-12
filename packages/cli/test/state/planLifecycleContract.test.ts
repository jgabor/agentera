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

function filesUnder(
  target: string,
  exclusions: string[],
  excludedDirectoryNames: string[],
): string[] {
  const normalized = target === "." ? target : target.replace(/^\.\//, "");
  if (normalized !== "." && matchesAny(normalized, exclusions)) return [];
  const absolute = path.join(REPO_ROOT, target);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [target];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = target === "." ? entry.name : path.posix.join(target, entry.name);
    if (matchesAny(child, exclusions)) return [];
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory() && excludedDirectoryNames.includes(entry.name)) return [];
    return entry.isDirectory()
      ? filesUnder(child, exclusions, excludedDirectoryNames)
      : [child];
  });
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => path.matchesGlob(file, pattern));
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

  it("bounds legacy reads and classifies every lifecycle-bearing repository surface", () => {
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
        "method",
        "migrators",
        "readers",
        "scan",
        "schemas",
        "writers",
      ].sort(),
    );
    for (const surfaces of Object.values(contract.inventory)) {
      if (Array.isArray(surfaces)) expect(surfaces.length).toBeGreaterThan(0);
    }

    const inventory = contract.inventory;
    const families = [
      "readers",
      "writers",
      "migrators",
      "schemas",
      "adapters",
      "fixtures",
      "documented_external_commitments",
    ];
    const classifiedPatterns = families.flatMap((family) => inventory[family]);
    const exclusions = inventory.scan.exclusions.flatMap(
      (entry: { patterns: string[] }) => entry.patterns,
    );
    expect(inventory.scan.roots).toEqual(["."]);
    expect(inventory.scan.symlinks).toContain("leave the repository boundary");
    const excludedDirectoryNames = inventory.scan.excluded_directory_names.names;
    expect(inventory.scan.excluded_directory_names.reason).toContain("any repository depth");
    expect(excludedDirectoryNames).toEqual(
      expect.arrayContaining([".git", "node_modules", "dist", "__pycache__", ".snapshots"]),
    );
    for (const exclusion of inventory.scan.exclusions) {
      expect(exclusion.patterns.length).toBeGreaterThan(0);
      expect(exclusion.reason.length).toBeGreaterThan(20);
    }
    const candidates = inventory.scan.roots
      .flatMap((root: string) => filesUnder(root, exclusions, excludedDirectoryNames))
      .filter((file: string) => {
        const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
        return inventory.scan.markers.some((marker: string) => text.includes(marker));
      });
    const unclassified = candidates.filter(
      (file: string) => !matchesAny(file, classifiedPatterns),
    );

    expect(candidates.length).toBeGreaterThan(100);
    expect(unclassified).toEqual([]);
    expect(matchesAny("packages/cli/src/cli/planEvidence.ts", inventory.readers)).toBe(true);
    expect(matchesAny("packages/cli/src/cli/commands/state/write.ts", inventory.writers)).toBe(
      true,
    );
    expect(
      matchesAny("packages/cli/src/cli/capabilityContext/orchestration.ts", inventory.readers),
    ).toBe(true);
    expect(
      matchesAny("packages/cli/src/hooks/validateArtifact/violations.ts", inventory.adapters),
    ).toBe(true);
    expect(
      matchesAny("packages/cli/src/upgrade/upgradeOrchestrator.ts", inventory.migrators),
    ).toBe(true);
    expect(matchesAny("fixtures/semantic/status-cli-budget.md", inventory.fixtures)).toBe(true);
    expect(matchesAny("fixtures/semantic/status-bare-message.md", inventory.fixtures)).toBe(true);
    expect(matchesAny(".agentera/docs.yaml", inventory.adapters)).toBe(true);
    expect(matchesAny("scripts/schemas/contracts.json", inventory.adapters)).toBe(true);
    expect(matchesAny("scripts/json_output_surface_manifest.yaml", inventory.adapters)).toBe(true);
    expect(candidates).toEqual(
      expect.arrayContaining([
        "fixtures/semantic/status-cli-budget.md",
        "fixtures/semantic/status-bare-message.md",
        ".agentera/docs.yaml",
        "scripts/schemas/contracts.json",
        "scripts/json_output_surface_manifest.yaml",
      ]),
    );
    expect(filesUnder("node_modules", exclusions, excludedDirectoryNames)).toEqual([]);
    expect(filesUnder(".git", exclusions, excludedDirectoryNames)).toEqual([]);
  });
});

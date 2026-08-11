import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "skills/agentera/schemas/artifacts/plan.yaml");

function lifecycleContract(): Record<string, any> {
  const schema = YAML.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as Record<string, any>;
  return schema.LIFECYCLE_CONTRACT;
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => path.matchesGlob(file, pattern));
}

function scanOptions(contract = lifecycleContract()) {
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
  return {
    inventory,
    classifiedPatterns: families.flatMap((family) => inventory[family]),
    exclusions: inventory.scan.exclusions.flatMap(
      (entry: { patterns: string[] }) => entry.patterns,
    ),
    excludedDirectoryNames: inventory.scan.excluded_directory_names.names as string[],
  };
}

function repositoryFiles(root: string, inventory: Record<string, any>): string[] {
  const { exclusions, excludedDirectoryNames } = scanOptions({ inventory });
  const output = execFileSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "-z", "--", ...inventory.scan.roots],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.split("/").some((part) => excludedDirectoryNames.includes(part)))
    .filter((file) => !matchesAny(file, exclusions))
    .filter((file) => {
      try {
        return fs.lstatSync(path.join(root, file)).isFile();
      } catch {
        return false;
      }
    });
}

function classifyFiles(root: string, inventory: Record<string, any>) {
  const { classifiedPatterns } = scanOptions({ inventory });
  const scanned = repositoryFiles(root, inventory);
  const candidates = scanned.filter((file: string) => {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    return inventory.scan.markers.some((marker: string) => text.includes(marker));
  });
  return {
    scanned,
    candidates,
    unclassified: candidates.filter((file: string) => !matchesAny(file, classifiedPatterns)),
  };
}

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "plan-lifecycle-contract-"));
}

function writeFixtureFile(root: string, file: string, content = ""): string {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
  return destination;
}

function removeFixtureDirectory(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

describe("plan lifecycle contract", () => {
  it("separates persisted lifecycle from positional activity", () => {
    const contract = lifecycleContract();

    expect(contract.authority).toBe("this schema");
    expect(contract.canonical.persisted_status.values).toEqual(["open", "complete", "archived"]);
    expect(contract.canonical.position.persisted).toBe(true);
    expect(contract.canonical.execution.archived).toContain("non-executable");
    expect(contract.canonical.forced_archive.unfinished_status).toBe("archived");
    expect(contract.canonical.lineage).toMatchObject({
      field: "previous_plan_archived",
      representation: "bare predecessor plan entity ID",
      replacement_input_identity: {
        field: "replacement_input_sha256",
      },
    });
    expect(contract.canonical.forced_create).toMatchObject({
      one_open_predecessor: expect.stringContaining("previous_plan_archived"),
      multiple_open_predecessors: expect.stringContaining("Reject before effects"),
    });
    expect(contract.canonical.targeted_replacement).toMatchObject({
      command: expect.stringContaining("--predecessor PREDECESSOR"),
      existing_successor: expect.stringContaining("previous_plan_archived"),
      create_successor: expect.stringContaining("complete plan document"),
      replay: expect.stringContaining("exact input identity"),
      atomicity: expect.stringContaining(
        "complete predecessor, successor, and created-task target set",
      ),
    });
  });

  it("requires prospective replacement PASS evidence without invalidating historical state", () => {
    const contract = lifecycleContract();
    const transition = contract.canonical.replacement_evidence_transition;
    const historical = contract.compatibility.historical_replacement_evidence;

    expect(transition.predicate).toContain("complete");
    expect(transition.predicate).toContain("last_verdict is pass");
    expect(transition.supersession).toContain("before a new supersession");
    expect(transition.completion).toContain("before an open plan becomes complete");
    expect(transition.replay).toContain("idempotent no-ops");
    expect(historical.readable).toContain("remain readable");
    expect(historical.readable).toContain("not rewritten or invalidated");
    expect(historical.recovery).toContain("first PASS");
    expect(historical.scope).toContain("does not permit new supersession");
  });

  it("bounds legacy reads and classifies every lifecycle-bearing repository surface", () => {
    const contract = lifecycleContract();
    const window = contract.compatibility.legacy_read_window;

    expect(window.scope).toContain("typed-writer canonicalization");
    expect(window.removal_condition).toContain("regression tests prove");
    expect(window.test_boundary).toHaveLength(5);
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

    const { inventory, exclusions, excludedDirectoryNames } = scanOptions(contract);
    expect(inventory.scan.roots).toEqual(["."]);
    expect(inventory.scan.symlinks).toContain("leave the repository boundary");
    expect(inventory.scan.excluded_directory_names.reason).toContain("any repository depth");
    expect(excludedDirectoryNames).toEqual(
      expect.arrayContaining([
        ".git",
        "node_modules",
        "dist",
        "__pycache__",
        ".snapshots",
        ".wrangler",
        ".playwright-cli",
        ".agentera-generated",
      ]),
    );
    expect(inventory.scan.markers).toEqual(expect.arrayContaining(["plan.yaml", "state.plan."]));
    expect(exclusions).toContain("**/*.tgz");
    expect(exclusions).toContain(".playwright-cli/**");
    expect(exclusions).toContain("packages/cli/.agentera-generated/**");
    for (const exclusion of inventory.scan.exclusions) {
      expect(exclusion.patterns.length).toBeGreaterThan(0);
      expect(exclusion.reason.length).toBeGreaterThan(20);
    }
    const { scanned, candidates, unclassified } = classifyFiles(REPO_ROOT, inventory);

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
    expect(matchesAny("packages/cli/src/upgrade/upgradeOrchestrator.ts", inventory.migrators)).toBe(
      true,
    );
    expect(matchesAny("fixtures/semantic/status-cli-budget.md", inventory.fixtures)).toBe(true);
    expect(matchesAny("fixtures/semantic/status-bare-message.md", inventory.fixtures)).toBe(true);
    expect(matchesAny("skills/agentera/schemas/artifacts/plan.yaml", inventory.schemas)).toBe(true);
    expect(matchesAny(".agentera/docs.yaml", inventory.adapters)).toBe(true);
    expect(matchesAny("scripts/schemas/contracts.json", inventory.adapters)).toBe(true);
    expect(matchesAny("scripts/json_output_surface_manifest.yaml", inventory.adapters)).toBe(true);
    expect(candidates).toEqual(
      expect.arrayContaining([
        "fixtures/semantic/status-cli-budget.md",
        "fixtures/semantic/status-bare-message.md",
        "skills/agentera/schemas/artifacts/plan.yaml",
        ".agentera/docs.yaml",
        "scripts/schemas/contracts.json",
        "scripts/json_output_surface_manifest.yaml",
      ]),
    );
    expect(scanned.some((file: string) => file === ".git" || file.startsWith(".git/"))).toBe(false);
    expect(scanned.some((file: string) => file.split("/").includes("node_modules"))).toBe(false);
    expect(scanned.some((file: string) => file.split("/").includes(".wrangler"))).toBe(false);
    expect(scanned.some((file: string) => file.endsWith(".tgz"))).toBe(false);
  });

  it("reports an ignored unclassified candidate without reading excluded surfaces", async () => {
    // Unix socket paths are short; qualification deliberately nests TMPDIR.
    const root = fs.mkdtempSync(path.join("/tmp", "agentera-plan-socket-"));
    const outside = temporaryDirectory();
    const socketPath = path.join(root, "scanner.sock");
    const server = process.platform === "win32" ? undefined : net.createServer();
    let listening = false;
    let readFileSync: ReturnType<typeof vi.spyOn> | undefined;
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      writeFixtureFile(root, ".gitignore", "ignored-contract.txt\n");
      writeFixtureFile(root, "ignored-contract.txt", "plan.yaml");
      writeFixtureFile(root, "packages/cli/src/cli/planReader.ts", "plan.yaml");
      writeFixtureFile(root, "dist/generated.txt", "plan.yaml");
      writeFixtureFile(root, ".env.local", "plan.yaml");
      const excludedPaths = ["dist/generated.txt", ".env.local"];

      if (server) {
        const outsideFile = writeFixtureFile(outside, "outside-marker.txt", "plan.yaml");
        fs.symlinkSync(outsideFile, path.join(root, "linked-marker.txt"));
        excludedPaths.push("linked-marker.txt", "scanner.sock");
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => {
            listening = true;
            resolve();
          });
        });
        expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      }

      expect(
        execFileSync("git", ["-C", root, "check-ignore", "ignored-contract.txt"], {
          encoding: "utf8",
        }).trim(),
      ).toBe("ignored-contract.txt");

      const { inventory } = scanOptions();
      readFileSync = vi.spyOn(fs, "readFileSync");
      const { scanned, candidates, unclassified } = classifyFiles(root, inventory);
      const readPaths = readFileSync.mock.calls.map(([file]) => String(file));

      expect(candidates).toEqual(["ignored-contract.txt", "packages/cli/src/cli/planReader.ts"]);
      expect(unclassified).toEqual(["ignored-contract.txt"]);
      expect(scanned).not.toEqual(expect.arrayContaining(excludedPaths));
      expect(readPaths).not.toEqual(
        expect.arrayContaining(excludedPaths.map((file) => path.join(root, file))),
      );
    } finally {
      readFileSync?.mockRestore();
      if (server && listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      removeFixtureDirectory(root);
      removeFixtureDirectory(outside);
    }
  });
});

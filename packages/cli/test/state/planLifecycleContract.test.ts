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

function filesUnder(
  root: string,
  target: string,
  exclusions: string[],
  excludedDirectoryNames: string[],
): string[] {
  const resolvedRoot = path.resolve(root);
  const normalized = target === "." ? "" : target.replace(/^\.\//, "");
  if (normalized && matchesAny(normalized, exclusions)) return [];
  const absolute = path.resolve(resolvedRoot, normalized || ".");
  if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}${path.sep}`)) return [];

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch {
    return [];
  }
  if (stats.isSymbolicLink()) return [];
  if (stats.isFile()) return [normalized];
  if (!stats.isDirectory()) return [];

  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = normalized ? path.posix.join(normalized, entry.name) : entry.name;
    if (entry.isDirectory() && /^\.agentera\/migrations\/entities\/\.[a-f0-9]{20}\.prepare-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(child)) return [];
    if (matchesAny(child, exclusions)) return [];
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory() && excludedDirectoryNames.includes(entry.name)) return [];
    if (entry.isDirectory()) return filesUnder(resolvedRoot, child, exclusions, excludedDirectoryNames);
    return entry.isFile() ? [child] : [];
  });
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
    exclusions: inventory.scan.exclusions.flatMap((entry: { patterns: string[] }) => entry.patterns),
    excludedDirectoryNames: inventory.scan.excluded_directory_names.names as string[],
  };
}

function classifyFiles(root: string, inventory: Record<string, any>) {
  const { classifiedPatterns, exclusions, excludedDirectoryNames } = scanOptions({ inventory });
  const scanned = inventory.scan.roots.flatMap((scanRoot: string) =>
    filesUnder(root, scanRoot, exclusions, excludedDirectoryNames),
  );
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

const posixIt = process.platform === "win32" ? it.skip : it;

describe("plan lifecycle contract", () => {
  it("separates persisted lifecycle from positional activity", () => {
    const contract = lifecycleContract();

    expect(contract.authority).toBe("this schema");
    expect(contract.canonical.persisted_status.values).toEqual(["open", "complete", "archived"]);
    expect(contract.canonical.position.persisted).toBe(true);
    expect(contract.canonical.execution.archived).toContain("non-executable");
    expect(contract.canonical.forced_archive.unfinished_status).toBe("archived");
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

    const { inventory, classifiedPatterns, exclusions, excludedDirectoryNames } = scanOptions(contract);
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
      ]),
    );
    expect(inventory.scan.markers).toEqual(expect.arrayContaining(["plan.yaml", "state.plan."]));
    expect(exclusions).toContain("**/*.tgz");
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
    expect(filesUnder(REPO_ROOT, "node_modules", exclusions, excludedDirectoryNames)).toEqual([]);
    expect(filesUnder(REPO_ROOT, ".git", exclusions, excludedDirectoryNames)).toEqual([]);
    expect(
      filesUnder(
        REPO_ROOT,
        "packages/cli/agentera-3.0.0-dev.1.tgz",
        exclusions,
        excludedDirectoryNames,
      ),
    ).toEqual([]);
    expect(scanned.some((file: string) => file.split("/").includes(".wrangler"))).toBe(false);
    expect(scanned.some((file: string) => file.endsWith(".tgz"))).toBe(false);
  });

  it("does not traverse symbolic links", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    try {
      writeFixtureFile(outside, "outside-marker.txt", "plan.yaml");
      fs.symlinkSync(
        outside,
        path.join(root, "outside-link"),
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(filesUnder(root, ".", [], [])).not.toContain("outside-link/outside-marker.txt");
      expect(filesUnder(root, "outside-link", [], [])).toEqual([]);
    } finally {
      removeFixtureDirectory(root);
      removeFixtureDirectory(outside);
    }
  });

  it("prunes cache directories at any depth", () => {
    const root = temporaryDirectory();
    try {
      writeFixtureFile(root, "nested/.cache/cache-marker.txt", "plan.yaml");
      const { exclusions, excludedDirectoryNames } = scanOptions();

      expect(filesUnder(root, ".", exclusions, excludedDirectoryNames)).not.toContain(
        "nested/.cache/cache-marker.txt",
      );
    } finally {
      removeFixtureDirectory(root);
    }
  });

  it("prunes snapshot directories at any depth", () => {
    const root = temporaryDirectory();
    try {
      writeFixtureFile(root, "nested/.snapshots/snapshot-marker.txt", "plan.yaml");
      const { exclusions, excludedDirectoryNames } = scanOptions();

      expect(filesUnder(root, ".", exclusions, excludedDirectoryNames)).not.toContain(
        "nested/.snapshots/snapshot-marker.txt",
      );
    } finally {
      removeFixtureDirectory(root);
    }
  });

  it("excludes local-secret patterns before reading their contents", () => {
    const root = temporaryDirectory();
    try {
      const secretFiles = [".env", ".env.local", "nested/.env.production", "keys/identity.pem", "keys/signing.key"];
      for (const file of secretFiles) writeFixtureFile(root, file);
      writeFixtureFile(root, "visible.txt", "plan.yaml");
      const readFileSync = vi.spyOn(fs, "readFileSync");

      try {
        const { inventory } = scanOptions();
        const { scanned, candidates } = classifyFiles(root, inventory);
        const readPaths = readFileSync.mock.calls.map(([file]) => String(file));

        expect(scanned).not.toEqual(expect.arrayContaining(secretFiles));
        expect(candidates).toEqual(["visible.txt"]);
        expect(readPaths).not.toEqual(
          expect.arrayContaining(secretFiles.map((file) => path.join(root, file))),
        );
      } finally {
        readFileSync.mockRestore();
      }
    } finally {
      removeFixtureDirectory(root);
    }
  });

  posixIt("skips nonregular filesystem entries", async () => {
    const root = temporaryDirectory();
    const socketPath = path.join(root, "scanner.sock");
    const server = net.createServer();
    let listening = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          listening = true;
          resolve();
        });
      });

      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(filesUnder(root, ".", [], [])).not.toContain("scanner.sock");
    } finally {
      if (listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      removeFixtureDirectory(root);
    }
  });

  it("rejects paths outside the scan root", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    try {
      const outsideFile = writeFixtureFile(outside, "outside-marker.txt", "plan.yaml");
      const { exclusions, excludedDirectoryNames } = scanOptions();

      expect(
        filesUnder(root, path.relative(root, outsideFile), exclusions, excludedDirectoryNames),
      ).toEqual([]);
      expect(filesUnder(root, outsideFile, exclusions, excludedDirectoryNames)).toEqual([]);
    } finally {
      removeFixtureDirectory(root);
      removeFixtureDirectory(outside);
    }
  });
});

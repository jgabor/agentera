import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import { cmdValidateCapabilityContract } from "../../src/cli/commands/validate.js";
import { BOOTSTRAP_SOURCE_ROOT_ENV } from "../../src/core/sourceRoot.js";
import {
  contractLooksV2,
  detectStaleAppContentSurfaces,
} from "../../src/upgrade/appContentRefresh.js";
import {
  applyMigrationPhases,
  dryRunMigration,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REPO_CONTRACT = path.join(REPO_ROOT, "skills", "agentera", "capability_schema_contract.yaml");
const V2_CONTRACT_FIXTURE = path.join(FIXTURES, "v2-capability_schema_contract.yaml");
const V3_INSTRUCTION_MODULE_PATH = "packages/cli/src/capabilities/<name>/instructions.ts";

const SWEDISH_CAPABILITY_IDS = new Set([
  "hej",
  "visionera",
  "resonera",
  "inspirera",
  "planera",
  "realisera",
  "optimera",
  "inspektera",
  "dokumentera",
  "profilera",
  "visualisera",
  "orkestrera",
]);

let tmp: string;
let home: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

function seedV2Contract(appBundleRoot: string): void {
  const contractPath = path.join(appBundleRoot, "skills", "agentera", "capability_schema_contract.yaml");
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.copyFileSync(V2_CONTRACT_FIXTURE, contractPath);
}

function readInstalledContract(appHome: string): { text: string; data: Record<string, unknown> } {
  const contractPath = path.join(appHome, "skills", "agentera", "capability_schema_contract.yaml");
  const text = fs.readFileSync(contractPath, "utf8");
  return { text, data: YAML.parse(text) as Record<string, unknown> };
}

function assertInstalledContractIsV3(contract: { text: string; data: Record<string, unknown> }): void {
  const directoryRequirements = contract.data.DIRECTORY_REQUIREMENTS as Record<string, unknown>;
  const instructionModule = directoryRequirements.instruction_module as { path: string };
  expect(instructionModule.path).toBe(V3_INSTRUCTION_MODULE_PATH);
  expect(directoryRequirements).not.toHaveProperty("instruction_file");
  expect(contractLooksV2(contract.text)).toBe(false);

  const routeAliases = contract.data.ROUTE_ALIASES as {
    primary_aliases: Array<{ alias: string; capability: string }>;
    legacy_aliases?: Array<{ legacy: string; canonical: string }>;
  };
  for (const entry of routeAliases.primary_aliases) {
    expect(SWEDISH_CAPABILITY_IDS.has(entry.capability)).toBe(false);
    expect(entry.alias).toBe(entry.capability);
  }
  expect(routeAliases.legacy_aliases?.length ?? 0).toBeGreaterThan(0);
  for (const entry of routeAliases.legacy_aliases ?? []) {
    expect(SWEDISH_CAPABILITY_IDS.has(entry.legacy) || entry.legacy === "hej").toBe(true);
    expect(SWEDISH_CAPABILITY_IDS.has(entry.canonical)).toBe(false);
  }
}

function captureCapabilityContractValidation(appHome: string): { rc: number; payload: Record<string, unknown> } {
  const saved = process.env[BOOTSTRAP_SOURCE_ROOT_ENV];
  process.env[BOOTSTRAP_SOURCE_ROOT_ENV] = appHome;
  let out = "";
  try {
    const rc = cmdValidateCapabilityContract({ format: "json" }, {
      out: (chunk: string) => {
        out += chunk;
      },
      err: () => {},
    });
    return { rc, payload: JSON.parse(out) as Record<string, unknown> };
  } finally {
    if (saved === undefined) {
      delete process.env[BOOTSTRAP_SOURCE_ROOT_ENV];
    } else {
      process.env[BOOTSTRAP_SOURCE_ROOT_ENV] = saved;
    }
  }
}

beforeAll(() => {
  const result = spawnSync("pnpm", ["-C", "packages/cli", "build"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`pre-test cli build failed: ${result.stderr ?? result.stdout}`);
  }
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "installed-contract-v3-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
});

afterEach(() => {
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  delete process.env.AGENTERA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("repo capability_schema_contract.yaml (B6-3 verify)", () => {
  it("already references instructions.ts and English ROUTE_ALIASES.primary_aliases", () => {
    const repoContract = readInstalledContract(REPO_ROOT);
    expect(repoContract.text).toBe(fs.readFileSync(REPO_CONTRACT, "utf8"));
    assertInstalledContractIsV3(repoContract);
  });
});

describe("installed contract after upgrade refresh (B6-3, #13)", () => {
  it("detects a v2-seeded contract as stale", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "detect"));
    seedV2Contract(path.join(appHome, "app"));
    const seeded = readInstalledContract(path.join(appHome, "app"));
    expect(contractLooksV2(seeded.text)).toBe(true);
    expect(seeded.data.DIRECTORY_REQUIREMENTS).toHaveProperty("instruction_file");

    const stale = detectStaleAppContentSurfaces(appHome, REPO_ROOT);
    expect(stale).toContain("capability_schema_contract.yaml");
  });

  it("refreshes a v2-seeded contract to v3 and validates green against the app home", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "apply"));
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project"));
    seedV2Contract(path.join(appHome, "app"));

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);
    const applied = applyMigrationPhases(ctx, preview);
    expect(
      applied.cleanup.items.some(
        (item) => item.action === "refresh-app-content" && item.status === "applied",
      ),
    ).toBe(true);

    const installed = readInstalledContract(appHome);
    expect(installed.text).toBe(fs.readFileSync(REPO_CONTRACT, "utf8"));
    assertInstalledContractIsV3(installed);

    const { rc, payload } = captureCapabilityContractValidation(appHome);
    expect(rc).toBe(0);
    expect(payload.status).toBe("pass");
    expect(payload.target_family).toBe("capability-contract");
    expect(installed.text).not.toMatch(/^\s*instruction_file:\s*$/m);
    expect(installed.text).not.toMatch(/path:\s*instructions\.md\s*$/m);
  });
});

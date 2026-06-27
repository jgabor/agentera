import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { startupCompletenessContract } from "../../src/cli/startupCompletenessContract.js";
import {
  APP_CONTENT_REFRESH_ACTION,
  APP_CONTENT_SURFACE_LABELS,
  detectStaleAppContentSurfaces,
  skillMdLooksV2,
} from "../../src/upgrade/appContentRefresh.js";
import {
  applyMigrationPhases,
  dryRunMigration,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { buildUpgradePlan as buildOrchestratorPlan } from "../../src/upgrade/upgradeOrchestrator.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import { migrationCtx, sandboxMigrationEnv } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
let home: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

function seedV2SkillMd(appBundleRoot: string): void {
  const skillPath = path.join(appBundleRoot, "skills", "agentera", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(
    skillPath,
    [
      "---",
      "name: agentera",
      "capabilities:",
      "  - planera",
      "  - inspektera",
      "---",
      "",
      "# hej",
      "",
      "Route /agentera planera to the planera capability.",
      "Read capabilities/plan/instructions.md for prose.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function capturePrime(context: string, env: Record<string, string>): Record<string, unknown> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  let out = "";
  try {
    const rc = cmdPrime(
      { command: "prime", context, format: "json" },
      { out: (chunk: string) => {
        out += chunk;
      }, err: () => {} },
    );
    expect(rc).toBe(0);
    expect(out.trim().length).toBeGreaterThan(0);
    return JSON.parse(out) as Record<string, unknown>;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "app-content-refresh-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  setSuccessorAnnouncedOverrideForTests(null);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  delete process.env.AGENTERA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("detectStaleAppContentSurfaces", () => {
  it("flags v2 Swedish SKILL.md and every listed surface on a managed v2 app home", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "detect"));
    seedV2SkillMd(path.join(appHome, "app"));
    const stale = detectStaleAppContentSurfaces(appHome, REPO_ROOT);
    expect(stale).toContain("SKILL.md");
    expect(stale).toContain("protocol.yaml");
    expect(stale).toContain("capability_schema_contract.yaml");
    expect(stale).toContain("capabilities/*/schemas/*");
    expect(stale).toContain("references/");
    expect(stale).toContain("registry.json");
    expect(stale).toContain("dist/capabilities");
    for (const label of APP_CONTENT_SURFACE_LABELS) {
      expect(stale).toContain(label);
    }
    expect(skillMdLooksV2(fs.readFileSync(path.join(appHome, "app", "skills", "agentera", "SKILL.md"), "utf8"))).toBe(
      true,
    );
  });
});

describe("upgrade planner integration", () => {
  it("surfaces refresh-app-content items on dry-run for a v2-seeded app home", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "dry-run"));
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project"));
    seedV2SkillMd(path.join(appHome, "app"));

    const preview = dryRunMigration(migrationCtx(appHome, project, home, REPO_ROOT));
    const refreshItems = preview.cleanup.items.filter((item) => item.action === APP_CONTENT_REFRESH_ACTION);
    expect(refreshItems.length).toBeGreaterThan(0);
    expect(refreshItems.every((item) => item.status === "pending")).toBe(true);
    expect(refreshItems.map((item) => item.message).join("\n")).toMatch(/SKILL\.md/);
    expect(refreshItems.map((item) => item.message).join("\n")).toMatch(/dist\/capabilities/);

    const plan = buildOrchestratorPlan({
      installRoot: appHome,
      home,
      project,
      channel: "development",
      dryRun: true,
    });
    const orchestratorRefresh = plan.phases
      .flatMap((phase) => phase.items)
      .filter((item) => item.action === APP_CONTENT_REFRESH_ACTION);
    expect(orchestratorRefresh.length).toBeGreaterThan(0);
  });

  it("refreshes a v2-seeded app home to v3 content on apply", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "apply"));
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project-apply"));
    seedV2SkillMd(path.join(appHome, "app"));

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);
    const applied = applyMigrationPhases(ctx, preview);

    expect(applied.cleanup.items.some((item) => item.action === APP_CONTENT_REFRESH_ACTION && item.status === "applied")).toBe(
      true,
    );
    expect(fs.existsSync(path.join(appHome, "app"))).toBe(false);

    const installedSkill = path.join(appHome, "skills", "agentera", "SKILL.md");
    const sourceSkill = path.join(REPO_ROOT, "skills", "agentera", "SKILL.md");
    expect(fs.existsSync(installedSkill)).toBe(true);
    expect(fs.readFileSync(installedSkill, "utf8")).toBe(fs.readFileSync(sourceSkill, "utf8"));
    expect(skillMdLooksV2(fs.readFileSync(installedSkill, "utf8"))).toBe(false);

    expect(fs.existsSync(path.join(appHome, "references"))).toBe(true);
    expect(fs.existsSync(path.join(appHome, "registry.json"))).toBe(true);
    expect(fs.existsSync(path.join(appHome, "dist", "capabilities", "audit", "instructions.js"))).toBe(true);

    const appEnv = {
      ...sandboxMigrationEnv(home, appHome),
      AGENTERA_HOME: appHome,
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: appHome,
    };
    const payload = capturePrime("audit", appEnv);
    const capabilityContext = payload.capability_context as Record<string, unknown>;
    const state = capabilityContext.state as Record<string, unknown>;
    expect(state.schema_error).toBeNull();
    expect(startupCompletenessContract({ schemaError: null }).complete_for_capability_startup).toBe(true);
  });
});

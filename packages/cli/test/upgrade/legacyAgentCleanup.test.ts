import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { opencodeConfigDir } from "../../src/setup/opencode.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import {
  REMOVE_LEGACY_AGENT_ACTION,
  V2_SWEDISH_VERB_AGENT_FILES,
  applyLegacyAgentCleanupItems,
  planLegacyAgentCleanupItems,
  scanLegacySwedishVerbAgentViolations,
} from "../../src/upgrade/legacyAgentCleanup.js";
import {
  applyCleanupPhase,
  dryRunMigration,
  planCleanupPhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { migrationCtx, sandboxMigrationEnv } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(__dirname, "fixtures");

let tmp: string;
let home: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

function managedV2(appHome: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] }),
  );
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" }),
  );
}

function writeLegacyAgent(dir: string, name: string, body = "Read instructions.md\n"): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, "utf8");
}

function seedSwedishVerbAgents(agentsDir: string): void {
  for (const name of V2_SWEDISH_VERB_AGENT_FILES) {
    writeLegacyAgent(agentsDir, name);
  }
}

function seedPreservedAgents(agentsDir: string): void {
  writeLegacyAgent(agentsDir, "agentera.md", "<!-- agentera: managed -->\nprime --context\n");
  writeLegacyAgent(agentsDir, "custom-agent.md", "# user custom agent\n");
  writeLegacyAgent(agentsDir, "agentera.md.bak", "# user backup\n");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-agent-cleanup-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, "xdg");
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  setSuccessorAnnouncedOverrideForTests(null);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("legacy Swedish-verb agent cleanup (#20)", () => {
  it("pass: scan reports no violations on a clean tree", () => {
    const root = path.join(tmp, "clean");
    fs.mkdirSync(path.join(root, ".cursor", "agents"), { recursive: true });
    writeLegacyAgent(path.join(root, ".cursor", "agents"), "agentera.md");
    expect(scanLegacySwedishVerbAgentViolations(root)).toEqual([]);
  });

  it("fail: scan flags reintroduced Swedish-verb agents under .cursor/agents", () => {
    const root = path.join(tmp, "cursor-violation");
    seedSwedishVerbAgents(path.join(root, ".cursor", "agents"));
    const violations = scanLegacySwedishVerbAgentViolations(root);
    expect(violations).toContain(".cursor/agents/hej.md");
    expect(violations.length).toBe(V2_SWEDISH_VERB_AGENT_FILES.length);
  });

  it("pass: scan reports no violations when only opencode has managed agentera.md", () => {
    const root = path.join(tmp, "opencode-clean");
    writeLegacyAgent(path.join(root, ".opencode", "agents"), "agentera.md");
    expect(scanLegacySwedishVerbAgentViolations(root)).toEqual([]);
  });

  it("fail: scan flags reintroduced Swedish-verb agents under .opencode/agents", () => {
    const root = path.join(tmp, "opencode-violation");
    seedSwedishVerbAgents(path.join(root, ".opencode", "agents"));
    const violations = scanLegacySwedishVerbAgentViolations(root);
    expect(violations).toContain(".opencode/agents/planera.md");
    expect(violations.length).toBe(V2_SWEDISH_VERB_AGENT_FILES.length);
  });

  it("plans pending remove-legacy-agent items for each Swedish-verb file in cursor and opencode", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project"));
    const cursorAgents = path.join(project, ".cursor", "agents");
    seedSwedishVerbAgents(cursorAgents);
    seedPreservedAgents(cursorAgents);

    const opencodeAgents = path.join(opencodeConfigDir(home, sandboxMigrationEnv(home, REPO_ROOT)), "agents");
    seedSwedishVerbAgents(opencodeAgents);
    seedPreservedAgents(opencodeAgents);

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planLegacyAgentCleanupItems(ctx);
    expect(items).toHaveLength(V2_SWEDISH_VERB_AGENT_FILES.length * 2);
    expect(items.every((item) => item.action === REMOVE_LEGACY_AGENT_ACTION && item.status === "pending")).toBe(
      true,
    );
    for (const name of V2_SWEDISH_VERB_AGENT_FILES) {
      expect(items.some((item) => item.source?.endsWith(path.join(".cursor", "agents", name)))).toBe(true);
      expect(items.some((item) => item.source?.endsWith(path.join("agents", name)))).toBe(true);
    }
  });

  it("apply removes exactly the closed set and preserves agentera.md, custom, and .bak agents", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project-apply"));
    const cursorAgents = path.join(project, ".cursor", "agents");
    seedSwedishVerbAgents(cursorAgents);
    seedPreservedAgents(cursorAgents);

    const opencodeAgents = path.join(opencodeConfigDir(home, sandboxMigrationEnv(home, REPO_ROOT)), "agents");
    seedSwedishVerbAgents(opencodeAgents);
    seedPreservedAgents(opencodeAgents);

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const preview = planCleanupPhase(ctx);
    applyCleanupPhase(preview, ctx);

    for (const name of V2_SWEDISH_VERB_AGENT_FILES) {
      expect(fs.existsSync(path.join(cursorAgents, name))).toBe(false);
      expect(fs.existsSync(path.join(opencodeAgents, name))).toBe(false);
    }
    expect(fs.existsSync(path.join(cursorAgents, "agentera.md"))).toBe(true);
    expect(fs.existsSync(path.join(cursorAgents, "custom-agent.md"))).toBe(true);
    expect(fs.existsSync(path.join(cursorAgents, "agentera.md.bak"))).toBe(true);
    expect(fs.existsSync(path.join(opencodeAgents, "agentera.md"))).toBe(true);
    expect(fs.existsSync(path.join(opencodeAgents, "custom-agent.md"))).toBe(true);
    expect(fs.existsSync(path.join(opencodeAgents, "agentera.md.bak"))).toBe(true);

    const legacyItems = preview.items.filter((item) => item.action === REMOVE_LEGACY_AGENT_ACTION);
    expect(legacyItems.every((item) => item.status === "applied")).toBe(true);
  });

  it("is a no-op when no Swedish-verb agents are present", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project-noop"));
    const cursorAgents = path.join(project, ".cursor", "agents");
    seedPreservedAgents(cursorAgents);

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planLegacyAgentCleanupItems(ctx);
    expect(items).toEqual([]);

    const preview = dryRunMigration(ctx);
    const legacyItems = preview.cleanup.items.filter((item) => item.action === REMOVE_LEGACY_AGENT_ACTION);
    expect(legacyItems).toEqual([]);
  });
});

describe("cmdUpgrade legacy agent cleanup integration", () => {
  it("upgrade --dry-run lists each Swedish-verb agent as pending remove-legacy-agent", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "cli-project"));
    seedSwedishVerbAgents(path.join(project, ".cursor", "agents"));
    seedPreservedAgents(path.join(project, ".cursor", "agents"));

    const opencodeAgents = path.join(opencodeConfigDir(home, sandboxMigrationEnv(home, REPO_ROOT)), "agents");
    seedSwedishVerbAgents(opencodeAgents);

    let stdout = "";
    const code = cmdUpgrade(
      {
        installRoot: appHome,
        home,
        project,
        dryRun: true,
        format: "json",
        channel: "development",
      },
      { out: (t) => { stdout += t; }, err: () => {} },
    );

    expect(code).toBe(1);
    const payload = JSON.parse(stdout);
    const cleanupItems = payload.phases.find((phase: { name: string }) => phase.name === "cleanup")?.items ?? [];
    const legacyItems = cleanupItems.filter(
      (item: { action: string }) => item.action === REMOVE_LEGACY_AGENT_ACTION,
    );
    expect(legacyItems).toHaveLength(V2_SWEDISH_VERB_AGENT_FILES.length * 2);
    expect(legacyItems.every((item: { status: string; source?: string }) => item.status === "pending" && item.source))
      .toBe(true);
  });

  it("upgrade --yes removes exactly the closed set and preserves non-listed agents", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "cli-yes"));
    const cursorAgents = path.join(project, ".cursor", "agents");
    seedSwedishVerbAgents(cursorAgents);
    seedPreservedAgents(cursorAgents);

    const opencodeAgents = path.join(opencodeConfigDir(home, sandboxMigrationEnv(home, REPO_ROOT)), "agents");
    seedSwedishVerbAgents(opencodeAgents);
    seedPreservedAgents(opencodeAgents);

    const code = cmdUpgrade(
      {
        installRoot: appHome,
        home,
        project,
        yes: true,
        format: "json",
        channel: "development",
      },
      { out: () => {}, err: () => {} },
    );

    expect(code).toBe(0);
    for (const name of V2_SWEDISH_VERB_AGENT_FILES) {
      expect(fs.existsSync(path.join(cursorAgents, name))).toBe(false);
      expect(fs.existsSync(path.join(opencodeAgents, name))).toBe(false);
    }
    expect(fs.existsSync(path.join(cursorAgents, "agentera.md"))).toBe(true);
    expect(fs.existsSync(path.join(cursorAgents, "custom-agent.md"))).toBe(true);
    expect(fs.existsSync(path.join(opencodeAgents, "agentera.md"))).toBe(true);
  });
});

describe("applyLegacyAgentCleanupItems safety", () => {
  it("does not remove files outside the closed set", () => {
    const agentsDir = path.join(tmp, "safety");
    seedPreservedAgents(agentsDir);
    const items = [
      {
        status: "pending" as const,
        action: REMOVE_LEGACY_AGENT_ACTION,
        source: path.join(agentsDir, "custom-agent.md"),
        message: "should noop",
      },
    ];
    applyLegacyAgentCleanupItems(items);
    expect(items[0]?.status).toBe("noop");
    expect(fs.existsSync(path.join(agentsDir, "custom-agent.md"))).toBe(true);
  });
});

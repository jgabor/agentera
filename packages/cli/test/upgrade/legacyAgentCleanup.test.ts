import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { opencodeConfigDir } from "../../src/setup/opencode.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import {
  REMOVE_LEGACY_AGENT_ACTION,
  V2_ENGLISH_CAPABILITY_AGENT_FILES,
  V2_SWEDISH_VERB_AGENT_FILES,
  applyLegacyAgentCleanupItems,
  planLegacyAgentCleanupItems,
  planLegacyCapabilityAgentCleanupItems,
  scanLegacyCapabilityAgentPaths,
  scanLegacySwedishVerbAgentViolations,
} from "../../src/upgrade/legacyAgentCleanup.js";
import {
  applyCleanupPhase,
  dryRunMigration,
  planCleanupPhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { migrationCtx, sandboxMigrationEnv } from "./helpers/migrationCtx.js";
import { gitCommitArgs } from "../helpers/git.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(__dirname, "fixtures");

let tmp: string;
let home: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

function initializeGit(root: string): void {
  const run = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(String(result.stderr));
  };
  run("init", "--quiet");
  run("add", ".");
  run(...gitCommitArgs("--quiet", "-m", "v2 state"));
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
    writeLegacyAgent(agentsDir, name, "<!-- agentera: managed -->\nRead instructions.md\n");
  }
}

function seedPreservedAgents(agentsDir: string): void {
  writeLegacyAgent(agentsDir, "agentera.md", "<!-- agentera: managed -->\nprime --context\n");
  writeLegacyAgent(agentsDir, "custom-agent.md", "# user custom agent\n");
  writeLegacyAgent(agentsDir, "agentera.md.bak", "# user backup\n");
}

function seedManagedCapabilityAgent(agentsDir: string, name: string): void {
  writeLegacyAgent(agentsDir, name, `<!-- agentera: managed -->\nContext capability ${name}\n`);
}

function seedUnmanagedCapabilityAgent(agentsDir: string, name: string): void {
  writeLegacyAgent(agentsDir, name, `# user-authored ${name}\n`);
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

  it("preserves markerless filename collisions with actionable handoff", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "markerless"));
    const source = path.join(project, ".cursor", "agents", "hej.md");
    writeLegacyAgent(path.dirname(source), path.basename(source), "# user-owned hej\n");

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planLegacyAgentCleanupItems(ctx);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "blocked", source });
    expect(items[0]?.message).toContain("filename does not prove");
    applyLegacyAgentCleanupItems(items, ctx);
    expect(fs.readFileSync(source, "utf8")).toBe("# user-owned hej\n");
  });

  it("preserves unsafe legacy-name symlinks with actionable handoff", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "unsafe-link"));
    const agentsDir = path.join(project, ".cursor", "agents");
    const source = path.join(agentsDir, "hej.md");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.symlinkSync(path.join(tmp, "user-agent.md"), source);

    const items = planLegacyAgentCleanupItems(migrationCtx(appHome, project, home, REPO_ROOT));

    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("blocked");
    expect(items[0]?.message).toContain("unsafe resource");
    expect(fs.lstatSync(source).isSymbolicLink()).toBe(true);
  });

  it("replans only unfinished cleanup while preserving a user-owned collision", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "retry"));
    const agentsDir = path.join(project, ".cursor", "agents");
    seedManagedCapabilityAgent(agentsDir, "audit.md");
    seedManagedCapabilityAgent(agentsDir, "build.md");
    seedUnmanagedCapabilityAgent(agentsDir, "design.md");
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const first = planLegacyCapabilityAgentCleanupItems(ctx);
    const audit = first.find((item) => item.source?.endsWith("audit.md"))!;
    applyLegacyAgentCleanupItems([audit], ctx);

    const retry = planLegacyCapabilityAgentCleanupItems(ctx);

    expect(retry.some((item) => item.source?.endsWith("audit.md"))).toBe(false);
    expect(retry.find((item) => item.source?.endsWith("build.md"))?.status).toBe("pending");
    expect(retry.find((item) => item.source?.endsWith("design.md"))?.status).toBe("blocked");
    expect(fs.readFileSync(path.join(agentsDir, "design.md"), "utf8")).toContain("user-authored");
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
    initializeGit(project);

    const opencodeAgents = path.join(opencodeConfigDir(home, sandboxMigrationEnv(home, REPO_ROOT)), "agents");
    seedSwedishVerbAgents(opencodeAgents);
    seedPreservedAgents(opencodeAgents);

    let output = "";
    let errors = "";
    const code = cmdUpgrade(
      {
        installRoot: appHome,
        home,
        project,
        yes: true,
        format: "json",
        channel: "development",
      },
      { out: (text) => { output += text; }, err: (text) => { errors += text; } },
    );

    expect({ code, output, errors }).toMatchObject({ code: 0, errors: "" });
    for (const name of V2_SWEDISH_VERB_AGENT_FILES) {
      expect(fs.existsSync(path.join(cursorAgents, name))).toBe(false);
      expect(fs.existsSync(path.join(opencodeAgents, name))).toBe(false);
    }
    expect(fs.existsSync(path.join(cursorAgents, "agentera.md"))).toBe(true);
    expect(fs.existsSync(path.join(cursorAgents, "custom-agent.md"))).toBe(true);
    expect(fs.existsSync(path.join(opencodeAgents, "agentera.md"))).toBe(true);
  });

  it("applies owned cleanup beside a preserved collision and replays without deleting it", () => {
    const project = path.join(tmp, "cli-collision");
    const appHome = path.join(home, "app");
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    fs.mkdirSync(appHome, { recursive: true });
    fs.writeFileSync(path.join(project, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const opencodeAgents = path.join(opencodeConfigDir(home, sandboxMigrationEnv(home, REPO_ROOT)), "agents");
    writeLegacyAgent(opencodeAgents, "hej.md", "<!-- agentera: managed -->\nlegacy\n");
    seedUnmanagedCapabilityAgent(opencodeAgents, "audit.md");

    let firstOutput = "";
    const firstCode = cmdUpgrade(
      { installRoot: appHome, home, project, yes: true, format: "json", channel: "development" },
      { out: (text) => { firstOutput += text; }, err: () => {} },
    );

    expect(firstCode).toBe(1);
    expect(fs.existsSync(path.join(opencodeAgents, "hej.md"))).toBe(false);
    expect(fs.existsSync(path.join(opencodeAgents, "audit.md"))).toBe(true);
    const cleanupItems = JSON.parse(firstOutput).phases.find(
      (phase: { name: string }) => phase.name === "cleanup",
    )?.items ?? [];
    expect(cleanupItems.find((item: { source?: string }) => item.source?.endsWith("hej.md"))?.status).toBe("applied");
    expect(cleanupItems.find((item: { source?: string }) => item.source?.endsWith("audit.md"))?.status).toBe("blocked");

    let replayOutput = "";
    const replayCode = cmdUpgrade(
      { installRoot: appHome, home, project, yes: true, format: "json", channel: "development" },
      { out: (text) => { replayOutput += text; }, err: () => {} },
    );

    expect(replayCode).toBe(1);
    expect(fs.existsSync(path.join(opencodeAgents, "audit.md"))).toBe(true);
    const replayCleanupItems = JSON.parse(replayOutput).phases.find(
      (phase: { name: string }) => phase.name === "cleanup",
    )?.items ?? [];
    expect(replayCleanupItems.find((item: { source?: string }) => item.source?.endsWith("audit.md"))?.status).toBe("blocked");
  });
});

describe("applyLegacyAgentCleanupItems safety", () => {
  it("does not remove files outside the closed set", () => {
    const agentsDir = path.join(tmp, "safety");
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    seedPreservedAgents(agentsDir);
    const items = [
      {
        status: "pending" as const,
        action: REMOVE_LEGACY_AGENT_ACTION,
        source: path.join(agentsDir, "custom-agent.md"),
        message: "should noop",
      },
    ];
    applyLegacyAgentCleanupItems(items, ctx);
    expect(items[0]?.status).toBe("blocked");
    expect(items[0]?.message).toContain("outside the legacy agent cleanup allowlist");
    expect(fs.existsSync(path.join(agentsDir, "custom-agent.md"))).toBe(true);
  });

  it("preserves a managed agent modified after preview", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "modified"));
    const source = path.join(project, ".cursor", "agents", "hej.md");
    writeLegacyAgent(path.dirname(source), path.basename(source), "<!-- agentera: managed -->\noriginal\n");
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planLegacyAgentCleanupItems(ctx);
    fs.writeFileSync(source, "<!-- agentera: managed -->\nuser modification\n");

    applyLegacyAgentCleanupItems(items, ctx);

    expect(items[0]?.status).toBe("blocked");
    expect(items[0]?.message).toContain("fingerprint changed");
    expect(fs.readFileSync(source, "utf8")).toContain("user modification");
  });

  it("preserves an allowlisted agent after its parent is swapped for a symlink", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "parent-swap"));
    const agentsDir = path.join(project, ".cursor", "agents");
    const source = path.join(agentsDir, "hej.md");
    writeLegacyAgent(agentsDir, "hej.md", "<!-- agentera: managed -->\nowned\n");
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planLegacyAgentCleanupItems(ctx);
    const outside = path.join(tmp, "moved-agents");
    fs.renameSync(agentsDir, outside);
    fs.symlinkSync(outside, agentsDir);

    applyLegacyAgentCleanupItems(items, ctx);

    expect(items[0]?.status).toBe("blocked");
    expect(fs.readFileSync(path.join(outside, "hej.md"), "utf8")).toContain("owned");
    expect(fs.lstatSync(agentsDir).isSymbolicLink()).toBe(true);
    expect(source).toBe(path.join(agentsDir, "hej.md"));
  });
});

describe("legacy English per-capability agent cleanup", () => {
  it("scanLegacyCapabilityAgentPaths targets managed English-named agents", () => {
    const agentsDir = path.join(tmp, "scan-managed");
    seedManagedCapabilityAgent(agentsDir, "audit.md");
    seedManagedCapabilityAgent(agentsDir, "build.md");
    const hits = scanLegacyCapabilityAgentPaths(agentsDir);
    expect(hits).toHaveLength(2);
    expect(hits.some((p) => p.endsWith("audit.md"))).toBe(true);
    expect(hits.some((p) => p.endsWith("build.md"))).toBe(true);
  });

  it("scanLegacyCapabilityAgentPaths skips unmanaged English-named agents", () => {
    const agentsDir = path.join(tmp, "scan-unmanaged");
    seedManagedCapabilityAgent(agentsDir, "audit.md");
    seedUnmanagedCapabilityAgent(agentsDir, "build.md");
    const hits = scanLegacyCapabilityAgentPaths(agentsDir);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/audit\.md$/);
    expect(fs.existsSync(path.join(agentsDir, "build.md"))).toBe(true);
  });

  it("scanLegacyCapabilityAgentPaths does not target agentera.md", () => {
    const agentsDir = path.join(tmp, "scan-agentera");
    seedPreservedAgents(agentsDir);
    expect(scanLegacyCapabilityAgentPaths(agentsDir)).toEqual([]);
  });

  it("planLegacyCapabilityAgentCleanupItems returns a pending item for each managed English file", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "cap-project"));
    const cursorAgents = path.join(project, ".cursor", "agents");
    for (const name of V2_ENGLISH_CAPABILITY_AGENT_FILES) {
      seedManagedCapabilityAgent(cursorAgents, name);
    }
    seedPreservedAgents(cursorAgents);

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planLegacyCapabilityAgentCleanupItems(ctx);
    expect(items).toHaveLength(V2_ENGLISH_CAPABILITY_AGENT_FILES.length);
    expect(items.every((item) => item.action === REMOVE_LEGACY_AGENT_ACTION && item.status === "pending")).toBe(
      true,
    );
    for (const name of V2_ENGLISH_CAPABILITY_AGENT_FILES) {
      expect(items.some((item) => item.source?.endsWith(path.join(".cursor", "agents", name)))).toBe(true);
    }
    expect(items.some((item) => item.source?.endsWith("agentera.md"))).toBe(false);
  });

  it("planLegacyCapabilityAgentCleanupItems blocks unmanaged English collisions", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "cap-unmanaged"));
    const cursorAgents = path.join(project, ".cursor", "agents");
    seedUnmanagedCapabilityAgent(cursorAgents, "build.md");
    seedUnmanagedCapabilityAgent(cursorAgents, "design.md");

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planLegacyCapabilityAgentCleanupItems(ctx);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.status === "blocked" && item.message.includes("filename does not prove"))).toBe(true);
  });

  it("does not target agentera.md (primary v3 agent is preserved)", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "cap-primary"));
    const cursorAgents = path.join(project, ".cursor", "agents");
    seedPreservedAgents(cursorAgents);
    seedManagedCapabilityAgent(cursorAgents, "audit.md");

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planLegacyCapabilityAgentCleanupItems(ctx);
    expect(items).toHaveLength(1);
    expect(items[0]?.source).toMatch(/audit\.md$/);
    expect(fs.existsSync(path.join(cursorAgents, "agentera.md"))).toBe(true);
  });

  it("apply removes the managed English file and marks it applied", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "cap-apply"));
    const cursorAgents = path.join(project, ".cursor", "agents");
    seedManagedCapabilityAgent(cursorAgents, "audit.md");
    seedPreservedAgents(cursorAgents);
    seedUnmanagedCapabilityAgent(cursorAgents, "build.md");

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const preview = planCleanupPhase(ctx);
    applyCleanupPhase(preview, ctx);

    expect(fs.existsSync(path.join(cursorAgents, "audit.md"))).toBe(false);
    expect(fs.existsSync(path.join(cursorAgents, "build.md"))).toBe(true);
    expect(fs.existsSync(path.join(cursorAgents, "agentera.md"))).toBe(true);
    expect(fs.existsSync(path.join(cursorAgents, "custom-agent.md"))).toBe(true);

    const legacyItems = preview.items.filter((item) => item.action === REMOVE_LEGACY_AGENT_ACTION);
    expect(legacyItems.find((item) => item.source?.endsWith("audit.md"))?.status).toBe("applied");
    expect(legacyItems.find((item) => item.source?.endsWith("build.md"))?.status).toBe("blocked");
  });

  it("combine: Swedish-verb and English capability items both appear in planCleanupPhase", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "cap-combined"));
    const cursorAgents = path.join(project, ".cursor", "agents");
    seedSwedishVerbAgents(cursorAgents);
    for (const name of V2_ENGLISH_CAPABILITY_AGENT_FILES) {
      seedManagedCapabilityAgent(cursorAgents, name);
    }
    seedPreservedAgents(cursorAgents);

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const preview = planCleanupPhase(ctx);
    const legacyItems = preview.items.filter((item) => item.action === REMOVE_LEGACY_AGENT_ACTION);
    expect(legacyItems).toHaveLength(
      V2_SWEDISH_VERB_AGENT_FILES.length + V2_ENGLISH_CAPABILITY_AGENT_FILES.length,
    );
    expect(legacyItems.some((item) => item.source?.endsWith("agentera.md"))).toBe(false);
  });
});

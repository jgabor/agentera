import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  applyRuntimeRewirePhase,
  planRuntimeRewirePhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { projectUsesV3CapabilityInstructionModules } from "../../src/upgrade/v3CapabilitySurface.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(__dirname, "fixtures");
const AGENTS_DIR = path.join(REPO_ROOT, ".cursor", "agents");
const MANAGED_AGENT_FILE = path.join(AGENTS_DIR, "agentera.md");
const LEGACY_AGENT_SUBSTRING = /Read .*capabilities\/[^/]+\/instructions\.md/;
const D65_PRIME_CONTEXT = /run `agentera prime --context [a-z]+ --format json`/i;

describe("v3 cursor agent surface (T7)", () => {
  it("detects the agentera repo as a v3 capability-surface project", () => {
    expect(projectUsesV3CapabilityInstructionModules(REPO_ROOT)).toBe(true);
  });

  it("does not treat v2-yaml-project fixture as v3", () => {
    expect(projectUsesV3CapabilityInstructionModules(path.join(FIXTURES, "v2-yaml-project"))).toBe(false);
  });

  it("skips in-tree cursor copy-agent items when upgrading a v3 project", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "t7-home-"));
    try {
      const appHome = path.join(home, "agentera");
      fs.mkdirSync(appHome, { recursive: true });
      const ctx = migrationCtx(appHome, REPO_ROOT, home, REPO_ROOT);
      const phase = planRuntimeRewirePhase(ctx);
      const cursorAgentItems = phase.items.filter(
        (item) => item.runtime === "cursor" && item.action === "copy-agent",
      );
      expect(cursorAgentItems.length).toBeGreaterThan(0);
      expect(cursorAgentItems.every((item) => item.status === "skipped")).toBe(true);
      expect(
        cursorAgentItems.every((item) =>
          item.message?.includes("v3 capability instruction modules present"),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("still plans cursor copy-agent for non-v3 projects", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "t7-v2-"));
    try {
      const home = path.join(sandbox, "home");
      const project = path.join(sandbox, "project");
      fs.cpSync(path.join(FIXTURES, "v2-yaml-project"), project, { recursive: true });
      const appHome = path.join(home, "agentera");
      fs.mkdirSync(appHome, { recursive: true });
      const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
      const phase = planRuntimeRewirePhase(ctx);
      const pendingCopy = phase.items.filter(
        (item) => item.runtime === "cursor" && item.action === "copy-agent" && item.status === "pending",
      );
      expect(pendingCopy.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("does not regress in-tree agentera.md when runtime upgrade applies against a legacy bundle", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "t7-apply-"));
    try {
      const before = fs.readFileSync(MANAGED_AGENT_FILE, "utf8");
      const appHome = path.join(home, "agentera");
      const legacyAgents = path.join(appHome, ".cursor", "agents");
      fs.mkdirSync(legacyAgents, { recursive: true });
      fs.writeFileSync(
        path.join(legacyAgents, "agentera.md"),
        "<!-- agentera: managed -->\nRead ${AGENTERA_HOME}/app/skills/agentera/capabilities/build/instructions.md\n",
        "utf8",
      );
      const ctx = migrationCtx(appHome, REPO_ROOT, home, REPO_ROOT);
      const phase = planRuntimeRewirePhase(ctx);
      applyRuntimeRewirePhase(phase, ctx);
      const after = fs.readFileSync(MANAGED_AGENT_FILE, "utf8");
      expect(after).toBe(before);
      expect(after).not.toMatch(LEGACY_AGENT_SUBSTRING);
      expect(after).toMatch(D65_PRIME_CONTEXT);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("in-tree agentera.md uses D65 prime --context dispatch form", () => {
    const body = fs.readFileSync(MANAGED_AGENT_FILE, "utf8");
    expect(body).toMatch(D65_PRIME_CONTEXT);
    expect(body).not.toMatch(LEGACY_AGENT_SUBSTRING);
  });

  it("rejects legacy instructions.md reference in agentera.md fixture body", () => {
    const legacy = "Read ${AGENTERA_HOME}/app/skills/agentera/capabilities/build/instructions.md";
    expect(legacy).toMatch(LEGACY_AGENT_SUBSTRING);
    const d65 = "Run `agentera prime --context build --format json`";
    expect(d65).toMatch(D65_PRIME_CONTEXT);
    expect(d65).not.toMatch(LEGACY_AGENT_SUBSTRING);
  });
});

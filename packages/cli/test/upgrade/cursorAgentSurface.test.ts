import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
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
const LEGACY_AGENT_SUBSTRING = /Read .*capabilities\/[^/]+\/instructions\.md/;
const D65_PRIME_CONTEXT = /Run `agentera prime --context [a-z]+ --format json`/;

const CAPABILITY_NAMES = Object.keys(CAPABILITY_INSTRUCTIONS);

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

  it("does not regress in-tree agents when runtime upgrade applies against a legacy bundle", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "t7-apply-"));
    try {
      const before = new Map<string, string>();
      for (const name of CAPABILITY_NAMES) {
        const file = path.join(AGENTS_DIR, `${name}.md`);
        before.set(name, fs.readFileSync(file, "utf8"));
      }
      const appHome = path.join(home, "agentera");
      const legacyAgents = path.join(appHome, ".cursor", "agents");
      fs.mkdirSync(legacyAgents, { recursive: true });
      for (const name of CAPABILITY_NAMES) {
        fs.writeFileSync(
          path.join(legacyAgents, `${name}.md`),
          `<!-- agentera: managed -->\nRead \${AGENTERA_HOME}/app/skills/agentera/capabilities/${name}/instructions.md\n`,
          "utf8",
        );
      }
      const ctx = migrationCtx(appHome, REPO_ROOT, home, REPO_ROOT);
      const phase = planRuntimeRewirePhase(ctx);
      applyRuntimeRewirePhase(phase, ctx);
      for (const name of CAPABILITY_NAMES) {
        const file = path.join(AGENTS_DIR, `${name}.md`);
        expect(fs.readFileSync(file, "utf8")).toBe(before.get(name));
        expect(fs.readFileSync(file, "utf8")).not.toMatch(LEGACY_AGENT_SUBSTRING);
        expect(fs.readFileSync(file, "utf8")).toMatch(D65_PRIME_CONTEXT);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(CAPABILITY_NAMES)("in-tree %s agent uses D65 prime --context form", (name) => {
    const body = fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), "utf8");
    expect(body).toMatch(new RegExp(`Run \`agentera prime --context ${name} --format json\``));
    expect(body).not.toMatch(LEGACY_AGENT_SUBSTRING);
  });

  it.each(CAPABILITY_NAMES)("rejects legacy instructions.md reference in %s fixture body", (name) => {
    const legacy = `Read \${AGENTERA_HOME}/app/skills/agentera/capabilities/${name}/instructions.md`;
    expect(legacy).toMatch(LEGACY_AGENT_SUBSTRING);
    const d65 = `Run \`agentera prime --context ${name} --format json\``;
    expect(d65).toMatch(D65_PRIME_CONTEXT);
    expect(d65).not.toMatch(LEGACY_AGENT_SUBSTRING);
  });
});

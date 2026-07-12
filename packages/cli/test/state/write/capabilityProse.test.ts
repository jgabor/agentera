import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import auditInstructions from "../../../src/capabilities/audit/instructions.js";
import buildInstructions from "../../../src/capabilities/build/instructions.js";
import discussInstructions from "../../../src/capabilities/discuss/instructions.js";
import orchestrateInstructions from "../../../src/capabilities/orchestrate/instructions.js";
import planInstructions from "../../../src/capabilities/plan/instructions.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("producer capability writer integration", () => {
  it("routes every writable capability artifact through the state writer", () => {
    expect(buildInstructions).toContain("agentera state progress append");
    expect(buildInstructions).toContain(
      "agentera state plan set-status --task N --status complete",
    );
    expect(discussInstructions).toContain("agentera state decisions append");
    expect(discussInstructions).toContain("agentera state decisions update --number N");
    expect(planInstructions).toContain("agentera state plan create --input PATH");
    expect(planInstructions).toContain("agentera state plan archive --format json");
    expect(orchestrateInstructions).toContain("agentera state plan set-status");
    expect(orchestrateInstructions).toContain("agentera state plan record-evaluation");
    expect(auditInstructions).toContain("agentera state health append --input PATH");
  });

  it("keeps cold-start agent and public documentation surfaces discoverable", () => {
    const skill = fs.readFileSync(path.join(REPO_ROOT, "skills/agentera/SKILL.md"), "utf8");
    const agents = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    const publicReference = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "packages/web/src/content/docs/docs/reference/state-writer.mdx",
      ),
      "utf8",
    );

    for (const surface of [skill, agents, publicReference]) {
      expect(surface).toContain("agentera state decisions explain");
      expect(surface).toContain("--dry-run");
    }
    expect(skill).toContain("Do not hand-edit those artifacts");
    expect(agents).toContain("instead of hand-editing their YAML");
    expect(publicReference).toContain("agentera schema --format json");
  });
});

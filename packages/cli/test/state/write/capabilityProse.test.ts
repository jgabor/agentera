import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import auditInstructions from "../../../src/capabilities/audit/instructions.js";
import buildInstructions from "../../../src/capabilities/build/instructions.js";
import { main } from "../../../src/cli/dispatch.js";
import discussInstructions from "../../../src/capabilities/discuss/instructions.js";
import orchestrateInstructions from "../../../src/capabilities/orchestrate/instructions.js";
import planInstructions from "../../../src/capabilities/plan/instructions.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

function planCreate(root: string, input: string): { rc: number; output: string } {
  let output = "";
  const rc = main(
    [
      "node",
      "agentera",
      "state",
      "plan",
      "create",
      "--input",
      input,
      "--format",
      "json",
      "--project",
      root,
    ],
    {
      out: (text) => {
        output += text;
      },
      err: (text) => {
        output += text;
      },
      stdin: () => "",
    },
  );
  return { rc, output };
}

function documentedFullPlan(): string {
  const match = planInstructions.match(/#### Full plan format[\s\S]*?```yaml\n([\s\S]*?)\n```/);
  expect(match, "PLAN instructions must include a full YAML example").not.toBeNull();
  return match![1];
}

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

  it("uses the writer as the final plan publication gate", () => {
    const vocabulary = fs.readFileSync(
      path.join(REPO_ROOT, "references/cli/vocabulary.md"),
      "utf8",
    );

    expect(planInstructions).toContain("### Step 4: Validate and publish");
    expect(planInstructions).toContain("Optionally run `agentera check lint");
    expect(planInstructions).toContain("sole publication gate");
    expect(planInstructions).not.toContain("Pre-write self-audit");
    expect(vocabulary).toContain("Draft lint preview");
    expect(vocabulary).toContain("the typed writer validates final bytes when publishing");
  });

  it("uses lifecycle coherence instead of a fixed full-plan task count", () => {
    const validation = YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "skills/agentera/capabilities/plan/schemas/validation.yaml"),
        "utf8",
      ),
    ) as Record<string, any>;
    const rule = validation.VALIDATION[2] as Record<string, any>;

    expect(rule.rule).toBe("coherent_lifecycle_scope");
    expect(rule.description).toContain("real lifecycle or coherence boundary");
    expect(planInstructions).toContain("coherent lifecycle boundary");
    expect(planInstructions).toContain("real lifecycle or coherence boundary");
    expect(planInstructions).not.toMatch(/\*\*Task decomposition\*\*:\s*\d/);
    expect(planInstructions).not.toMatch(/more than \d+ tasks/i);
  });

  it("keeps source and bundled plan capability instructions identical", async () => {
    const compiled = await import(
      pathToFileURL(
        path.join(REPO_ROOT, "packages/cli/dist/capabilities/plan/instructions.js"),
      ).href,
    );
    const compiledIndex = await import(
      pathToFileURL(path.join(REPO_ROOT, "packages/cli/dist/capabilities/index.js")).href,
    );

    expect(compiled.default).toBe(planInstructions);
    expect(compiledIndex.CAPABILITY_INSTRUCTIONS.plan).toBe(planInstructions);
  });

  it("publishes the documented full plan YAML through the typed writer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-plan-example-"));
    const omittedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-plan-example-"));
    try {
      const example = documentedFullPlan();
      const parsed = YAML.parse(example) as Record<string, any>;
      expect(parsed.overall_acceptance).toEqual(expect.any(String));
      expect(parsed.tasks[1].depends_on).toEqual(["1"]);
      expect(parsed.rejected).toEqual([
        expect.objectContaining({ issue: expect.any(String), rationale: expect.any(String) }),
      ]);

      const input = path.join(root, "plan.yaml");
      fs.writeFileSync(input, example);
      const published = planCreate(root, input);
      expect(published.rc, published.output).toBe(0);

      delete parsed.rejected;
      const withoutRejections = path.join(omittedRoot, "without-rejections.yaml");
      fs.writeFileSync(withoutRejections, YAML.stringify(parsed));
      const omitted = planCreate(omittedRoot, withoutRejections);
      expect(omitted.rc, omitted.output).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(omittedRoot, { recursive: true, force: true });
    }
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

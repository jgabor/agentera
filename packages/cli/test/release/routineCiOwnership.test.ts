import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const workflow = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/verify-changes.yml"), "utf8"));
const developmentPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"));
const publicationContract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "references/adapters/package-publication.json"), "utf8"));
const verificationPolicy = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml"), "utf8"));

const RELEASE_COMMAND = "pnpm -C packages/cli run verify:release";
const PARITY_TEST = "packages/cli/test/scripts/pyTsParity.test.ts";
const REMOVED_DUPLICATES = [
  {
    owner: "source",
    gate: "source",
    command: "pnpm -C packages/cli run test:source",
    forbidden: ["pnpm -C packages/cli test", "pnpm -C packages/cli run test:source"],
  },
  {
    owner: "package",
    gate: "package",
    command: "pnpm -C packages/cli run verify:package",
    forbidden: ["pnpm -C packages/cli run verify:package"],
  },
  {
    owner: "build",
    gate: "build",
    command: "pnpm -C packages/cli build",
    forbidden: ["pnpm -C packages/cli build"],
  },
] as const;

function runLines(candidate: any): string[] {
  return candidate.jobs.cli.steps.flatMap((step: { run?: string }) =>
    typeof step.run === "string"
      ? step.run
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
      : [],
  );
}

function invokes(line: string, command: string): boolean {
  return line === command || line.startsWith(`${command} `);
}

function validateRoutineCiOwnership(candidate: any): void {
  const lines = runLines(candidate);
  if (lines.filter((line) => invokes(line, RELEASE_COMMAND)).length !== 1) {
    throw new Error("routine CI must invoke the check-only release verification exactly once");
  }
  for (const entry of REMOVED_DUPLICATES) {
    if (entry.forbidden.some((command) => lines.some((line) => invokes(line, command)))) {
      throw new Error(`routine CI must not invoke ${entry.owner} outside generated overlap`);
    }
  }
}

describe("routine CI owner DAG", () => {
  it("runs the canonical check-only conjunction once on the authoritative performance runner", () => {
    expect(() => validateRoutineCiOwnership(workflow)).not.toThrow();
    expect(workflow.jobs.cli["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.jobs.cli).not.toHaveProperty("if");
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.jobs["source-migration"].name).toBe("v2→v3 migration (source build)");
    expect(workflow.jobs["source-migration"].if).toBe("github.ref == 'refs/heads/feat/v3' || github.event_name == 'pull_request'");
    const migrationSteps = workflow.jobs["source-migration"].steps;
    const scenarioStep = migrationSteps.find((step: { name?: string }) => step.name === "Run v2→v3 migration scenarios");
    expect(scenarioStep).toMatchObject({ env: expect.any(Object), run: expect.any(String) });
    const reportStep = migrationSteps.find((step: { name?: string }) => step.name === "Upload sandbox reports");
    expect(reportStep).toMatchObject({
      if: "always()",
      uses: "actions/upload-artifact@v4",
      with: { name: "source-migration-reports" },
    });
    expect(developmentPackage.scripts["verify:release"]).toBe("node scripts/release-qualification.mjs verify --json");
    const step = workflow.jobs.cli.steps.find((candidate: { run?: string }) => candidate.run === RELEASE_COMMAND);
    expect(step).toMatchObject({
      env: {
        AGENTERA_VITEST_RUNNER_POLICY: "unmeasured",
        AGENTERA_PERFORMANCE_RUNNER_CLASS: "github-hosted-ubuntu-24.04",
        AGENTERA_PERFORMANCE_RUNNER_IDENTITY: "${{ runner.name }}",
      },
    });
    expect(step).not.toHaveProperty("continue-on-error");
  });

  it.each(REMOVED_DUPLICATES)("retains positive $owner coverage through generated overlap", ({ owner, gate, command }) => {
    const source = publicationContract.qualification.source;
    expect(source.dag.generatedOverlapOrigins).toContain(owner);
    expect(source.gates.find((entry: { name: string }) => entry.name === gate)?.command.join(" ")).toBe(command);
  });

  it.each(REMOVED_DUPLICATES)("rejects a forbidden standalone $owner invocation", ({ owner, forbidden }) => {
    const candidate = structuredClone(workflow);
    candidate.jobs.cli.steps.push({ name: `Forbidden ${owner}`, run: forbidden[0] });
    expect(() => validateRoutineCiOwnership(candidate)).toThrow(`routine CI must not invoke ${owner} outside generated overlap`);
  });

  it("retains typecheck, parity, compact, stress, performance, and capacity coverage", () => {
    const source = publicationContract.qualification.source;
    const gateNames = source.gates.map((entry: { name: string }) => entry.name);
    expect(gateNames).toEqual(expect.arrayContaining(["typecheck", "compact", "stress", "performance", "capacity"]));
    expect(verificationPolicy.policies.release).toEqual(["source", "stress", "performance", "capacity", "package"]);
    expect(verificationPolicy.inventory.default_owner).toBe("source");
    expect(verificationPolicy.inventory.rules.some((rule: { path?: string; prefix?: string }) => rule.path === PARITY_TEST || PARITY_TEST.startsWith(rule.prefix ?? "never/"))).toBe(false);
    expect(verificationPolicy.owners.performance.execution.authoritative_runner.runs_on).toBe("ubuntu-24.04");

    const lines = runLines(workflow);
    const fetchIndex = lines.indexOf("git fetch origin main --depth=1");
    const conjunctionIndex = lines.indexOf(RELEASE_COMMAND);
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeLessThan(conjunctionIndex);
    expect(lines).not.toContain("bash packages/cli/scripts/py_ts_parity.sh --check --json");
    for (const gate of source.gates) {
      expect(lines.some((line) => invokes(line, gate.command.join(" ")))).toBe(false);
    }
  });
});

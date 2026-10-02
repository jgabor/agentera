import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "../../../..");
const bytes = fs.readFileSync(path.join(root, ".github/workflows/vite-plus-toolchain.yml"), "utf8");
const workflow = YAML.parse(bytes);

describe("nonpublishing toolchain experiment", () => {
  it("runs only branch pushes with read-only permissions and independent serialization", () => {
    expect(workflow.on).toEqual({ push: { branches: ["vite-plus-1-toolchain"] } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "vite-plus-toolchain-experiment",
      queue: "max",
      "cancel-in-progress": false,
    });
    expect(Object.keys(workflow.jobs)).toEqual(["baseline", "candidate"]);
    expect(workflow.jobs.baseline).not.toHaveProperty("needs");
    expect(workflow.jobs.candidate.needs).toBe("baseline");
    expect(workflow.jobs.candidate.if).toBe("always() && !cancelled()");
    expect(workflow.jobs.baseline.steps[0].with.ref).toBe("1b964ee320832100b8715503a8a7747b0d0fc591");
    expect(workflow.jobs.candidate.steps[0].with.ref).toBe("${{ github.sha }}");
  });

  it.each(["baseline", "candidate"])("keeps %s cold, revision-owned, pinned and nonpublishing", (name) => {
    const job = workflow.jobs[name];
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(45);
    expect(job).not.toHaveProperty("permissions");
    expect(job).not.toHaveProperty("environment");
    expect(job).not.toHaveProperty("continue-on-error");
    expect(job.env).toEqual({
      AGENTERA_VITEST_RUNNER_POLICY: "unmeasured",
      AGENTERA_GENERATED_OVERLAP_SOURCE_WORKERS: name === "baseline" ? "2" : "1",
      VITEST_TEST_TIMEOUT_MS: "120000",
      AGENTERA_PERFORMANCE_RUNNER_CLASS: "github-hosted-ubuntu-24.04",
      VP_GIT_HOOKS: "0",
    });
    // Runner expressions are unavailable in job.env, but valid in step.env.
    expect(JSON.stringify(job.env)).not.toContain("runner.");
    expect(job.steps).toHaveLength(7);
    expect(job.steps[0]).toMatchObject({
      uses: "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
      with: { "fetch-depth": 0, "persist-credentials": false },
    });
    expect(job.steps[1]).toEqual({
      uses: "actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f",
      with: { "node-version": "24.19.0", "package-manager-cache": false },
    });
    expect(job.steps[2].env).toEqual({
      AGENTERA_PERFORMANCE_RUNNER_IDENTITY: "${{ runner.name }}",
      AGENTERA_QUALIFICATION_DIAGNOSTICS: "${{ runner.temp }}/toolchain-diagnostics",
    });
    const commands = job.steps.flatMap((step: { run?: string }) => (step.run ? [step.run] : [])).join("\n");
    expect(commands).toContain('test "$(uname -sm)" = "Linux x86_64"');
    expect(commands).toContain("sourceWorkers:Number(process.env.AGENTERA_GENERATED_OVERLAP_SOURCE_WORKERS)");
    for (const file of ["node_modules", "packages/cli/dist", "packages/cli/bundle", "node_modules/.vite", "packages/cli/node_modules/.vite"]) expect(commands).toContain(`test ! -e ${file}`);
    expect(commands).toContain('process.version!=="v24.19.0"');
    expect(commands).toContain('test "$(vp exec pnpm --version)" = "10.30.3"');
    expect(commands).toContain("node packages/cli/scripts/bootstrap-integrity.mjs --ignore-scripts");
    expect(commands).toContain('"AGENTERA_PERFORMANCE_RUNNER_IDENTITY=$AGENTERA_PERFORMANCE_RUNNER_IDENTITY"');
    expect(commands).toContain('"AGENTERA_QUALIFICATION_DIAGNOSTICS=$AGENTERA_QUALIFICATION_DIAGNOSTICS" >> "$GITHUB_ENV"');
    expect(job.steps[5]["timeout-minutes"]).toBe(30);
    expect(commands.match(/vp exec vp run verify:development/g)).toHaveLength(1);
    for (const step of job.steps) {
      expect(step).not.toHaveProperty("continue-on-error");
      if (step.run) expect(step.run).toMatch(/^set -euo pipefail\n/);
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
    expect(job.steps[6]).toMatchObject({
      if: "always() && !cancelled()",
      uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      with: { path: "${{ runner.temp }}/toolchain-diagnostics" },
    });
  });

  it("has no mutation credentials, publication, deployment, verdict reuse or migrated control", () => {
    expect(bytes).not.toMatch(/secrets\.|id-token|NPM_TOKEN|NODE_AUTH_TOKEN|npm_config|ACTIONS_ID_TOKEN|publish-agentera|workflow_dispatch|pull_request|actions\/cache|--cache\b|release:(?:prepare|ready|stage|promote|publish|qualify)|npm (?:publish|pack|dist-tag)|git (?:push|checkout|switch|reset)|deploy/i);
    expect(workflow.jobs.baseline.steps.slice(1)).toEqual(workflow.jobs.candidate.steps.slice(1));
  });
});

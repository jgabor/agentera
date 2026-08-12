import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  canonicalJson,
  sha256,
  validateCandidateRunBinding,
  validateQualificationWorkflowRun,
} from "../../scripts/release-qualification.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const ciYaml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const qualificationYaml = fs.readFileSync(
  path.join(REPO_ROOT, ".github/workflows/qualify-candidate.yml"),
  "utf8",
);
const publicationYaml = fs.readFileSync(
  path.join(REPO_ROOT, ".github/workflows/publish-qualified-candidate.yml"),
  "utf8",
);
const benchmarkYaml = fs.readFileSync(
  path.join(REPO_ROOT, ".github/workflows/qualification-benchmark.yml"),
  "utf8",
);
const rootPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const developmentPackage = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"),
);
const stablePackage = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "packages/cli/shim/package.json"), "utf8"),
);
const publicationContract = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "references/adapters/package-publication.json"), "utf8"),
);
const verificationPolicy = YAML.parse(
  fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml"), "utf8"),
);
const benchmarkWorkflow = YAML.parse(benchmarkYaml);

describe("candidate publication orchestration", () => {
  it("routes preparation, qualification, approval, staging, and promotion through explicit scripts", () => {
    expect(rootPackage.scripts).toMatchObject({
      "cli:prepare:dev": "pnpm -C packages/cli run release:prepare",
      "cli:prepare:dev-push": "pnpm -C packages/cli run release:prepare:push",
      "cli:validate:dev-push": "pnpm -C packages/cli run release:validate:push",
      "cli:qualify:source": "pnpm -C packages/cli run release:qualify:source",
      "cli:ready:dev": "pnpm -C packages/cli run release:ready",
      "cli:qualify:dev": "pnpm -C packages/cli run release:qualify:candidate",
      "cli:benchmark:qualification": "pnpm -C packages/cli run release:benchmark:qualification",
      "cli:publish:qualified:dev": "pnpm -C packages/cli run release:publish:qualified",
      "cli:approve:dev": "pnpm -C packages/cli run release:approve",
      "cli:stage:dev": "pnpm -C packages/cli run release:stage",
      "cli:promote:dev": "pnpm -C packages/cli run release:promote",
    });
    expect(developmentPackage.scripts["release:prepare"]).toContain(
      "publication-transaction.mjs prepare development",
    );
    expect(developmentPackage.scripts["release:ready"]).toBe(
      "node scripts/release-readiness.mjs development",
    );
    expect(developmentPackage.scripts["release:stage"]).toContain(
      "publication-transaction.mjs stage development --approve",
    );
    expect(developmentPackage.scripts["release:promote"]).toContain(
      "publication-transaction.mjs promote development --approve",
    );
    expect(developmentPackage.scripts["release:benchmark:qualification"])
      .toContain("release-benchmark.mjs qualification");
    expect(developmentPackage.scripts["release:publish:qualified"])
      .toContain("release-benchmark.mjs publication --adapter development");
    expect(stablePackage.scripts["release:stage"]).toContain(
      "publication-transaction.mjs stage stable --approve",
    );
    expect(stablePackage.scripts["release:publish:qualified"]).toContain(
      "release-benchmark.mjs publication --adapter stable",
    );
    expect(developmentPackage.scripts).not.toHaveProperty("publish:dev");
    expect(stablePackage.scripts).not.toHaveProperty("publish:stable");
  });

  it("separates local integration allocation from receipt-bound manual preparation", () => {
    expect(publicationContract.invariants.preparation).toContain(
      "Serialized feat/v3 integration preparation requires a clean committed source tree",
    );
    expect(publicationContract.invariants.preparation).toContain(
      "manual readiness preparation path first validates a current normalized source receipt",
    );
    expect(publicationContract.qualification.source.reuseCheck.scope).toContain(
      "Manual readiness preparation uses the check as a source-readiness prerequisite",
    );
    expect(publicationContract.invariants.preparation).toContain(
      "Stable preparation retains its separate source-provenance contract",
    );
  });

  it("keeps readiness resumable and hard-paused before approval or registry work", () => {
    expect(publicationContract.qualification.readiness).toMatchObject({
      schemaVersion: "agentera.releaseReadiness.v1",
      adapter: "development",
      phases: ["source-readiness", "metadata-review", "candidate-readiness"],
      receipts: { source: "source-receipt.json", candidate: "candidate-receipt.json" },
      outcomes: ["paused", "ready", "rejected"],
      exitCodes: { paused: 0, ready: 0, rejected: 1 },
    });
    expect(publicationContract.qualification.readiness.metadataReview).toContain(
      "never prepares metadata, changes a version, commits, approves",
    );
    expect(publicationContract.qualification.readiness.reuse).toContain(
      "validated instead of invoking candidate qualification",
    );
  });

  it("keeps credentials out of package scripts and ordinary CI pushes", () => {
    expect(JSON.stringify(developmentPackage.scripts)).not.toContain(".env");
    expect(JSON.stringify(stablePackage.scripts)).not.toContain(".env");
    expect(ciYaml).not.toContain("NPM_TOKEN");
    expect(ciYaml).not.toContain("publish-next");
    expect(ciYaml).not.toContain("publish-latest");
    expect(ciYaml).not.toContain("npm publish");
    expect(ciYaml).toMatch(/push:\n\s+branches:\n\s+- main\n\s+- feat\/v3/);
  });

  it("retains a candidate and CI attestation before any separate approved mutation run", () => {
    expect(qualificationYaml).toMatch(/push:\n\s+branches:\n\s+- feat\/v3/);
    expect(qualificationYaml).toContain("workflow_dispatch");
    expect(qualificationYaml).toContain("cancel-in-progress: false");
    expect(qualificationYaml).toContain("pnpm cli:validate:dev-push");
    expect(qualificationYaml).toContain("github.event.before");
    expect(qualificationYaml).toContain("github.sha");
    expect(qualificationYaml).toContain("pnpm cli:qualify:source");
    expect(qualificationYaml).toContain("pnpm cli:qualify:dev");
    expect(qualificationYaml).toContain("release-qualification.mjs attest");
    expect(qualificationYaml).toContain("release-candidate-${{ github.run_id }}");
    expect(qualificationYaml).toContain("retention-days: 30");
    expect(qualificationYaml).toContain(`runs-on: ${verificationPolicy.owners.performance.execution.authoritative_runner.runs_on}`);
    expect(qualificationYaml).toContain("AGENTERA_PERFORMANCE_RUNNER_CLASS: github-hosted-ubuntu-24.04");
    expect(qualificationYaml).toContain("AGENTERA_PERFORMANCE_RUNNER_IDENTITY: ${{ runner.name }}");
    expect(qualificationYaml.match(/COREPACK_HOME: \$\{\{ runner\.temp \}\}\/corepack/g)).toHaveLength(2);
    expect(qualificationYaml).toContain('VITEST_MAX_WORKERS: "1"');
    expect(qualificationYaml).toContain('VITEST_TEST_TIMEOUT_MS: "120000"');
    expect(qualificationYaml).toContain('AGENTERA_GENERATED_OVERLAP_SOURCE_WORKERS: "2"');
    expect(qualificationYaml).not.toContain("github.run_number");
    expect(qualificationYaml.match(/node-version: 22\.23\.2/g)).toHaveLength(2);
  });

  it("publishes the exact push candidate to next without a review environment", () => {
    const autoPublish = qualificationYaml.slice(qualificationYaml.indexOf("  publish-development:"));
    expect(autoPublish).toContain("github.ref == 'refs/heads/feat/v3'");
    expect(autoPublish).toContain("github.event_name == 'workflow_dispatch' && inputs.adapter == 'development'");
    expect(autoPublish).toContain("needs: qualify");
    expect(autoPublish).toContain("release-candidate-${{ github.run_id }}");
    expect(autoPublish).toContain("github-actions/feat-v3");
    expect(autoPublish).toContain("--source-run-id \"${{ github.run_id }}\"");
    expect(autoPublish).toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(autoPublish).toContain("release-benchmark.mjs publication --adapter development");
    expect(autoPublish).toContain('chmod 0444 "${RUNNER_TEMP}"/agentera-candidate/*.tgz');
    expect(autoPublish).not.toContain("environment:");
    expect(autoPublish.indexOf("release-qualification.mjs approval"))
      .toBeLessThan(autoPublish.indexOf("release-benchmark.mjs publication"));
  });

  it("validates API provenance before approval, then runs one bounded forward-only envelope", () => {
    expect(publicationYaml).toContain("environment: npm-publish");
    expect(publicationYaml).toContain("candidate_receipt_sha256");
    expect(publicationYaml).toContain("actions/download-artifact@v4");
    expect(publicationYaml).toContain("actions/github-script@v7");
    expect(publicationYaml).toContain("packages/cli/scripts/release-qualification.mjs");
    expect(publicationContract.ci.qualificationWorkflow).toEqual({
      name: "Qualify release candidate",
      path: ".github/workflows/qualify-candidate.yml",
      ref: "refs/heads/feat/v3",
    });
    expect(publicationContract.ci.publicationRunBinding.beforeArtifactDownload).toContain("run.head_branch");
    expect(publicationContract.ci.publicationRunBinding.beforeEnvironmentApproval).toContain("run.head_sha");
    expect(publicationYaml).toContain("validateQualificationWorkflowRun(run, runId)");
    expect(publicationYaml).toContain("validateCandidateRunBinding");
    expect(publicationYaml.match(/validateCandidateReceipt\(\{/g)).toHaveLength(2);
    expect(publicationYaml).toContain("git checkout --detach");
    expect(publicationYaml).toContain("run-id: ${{ inputs.source_run_id }}");
    expect(publicationYaml).toContain("release-qualification.mjs approval");
    expect(publicationYaml).toContain("--source-run-id");
    expect(publicationYaml).toContain("release-benchmark.mjs publication");
    expect(publicationYaml).toContain("coordinator enforces <120s");
    expect(publicationYaml).toContain("timeout-minutes: 3");
    expect(publicationYaml).toContain("qualified-publication-receipt.json");
    expect(publicationYaml).toContain('chmod 0444 "${RUNNER_TEMP}"/agentera-candidate/*.tgz');
    expect(publicationYaml.indexOf("validateQualificationWorkflowRun(run, runId)"))
      .toBeLessThan(publicationYaml.indexOf("Checkout qualified source head"));
    expect(publicationYaml.indexOf("Checkout qualified source head"))
      .toBeLessThan(publicationYaml.indexOf("Download exact qualification artifact"));
    expect(publicationYaml.indexOf("Bind candidate receipt to API-backed run head"))
      .toBeLessThan(publicationYaml.indexOf("environment: npm-publish"));
    expect(publicationYaml.indexOf("Recheck transferred candidate binding"))
      .toBeLessThan(publicationYaml.indexOf("NPM_TOKEN"));
    expect(publicationYaml.indexOf("Restore governed candidate artifact mode after transfer"))
      .toBeLessThan(publicationYaml.indexOf("Recheck transferred candidate binding"));
    expect(publicationYaml.indexOf("release-qualification.mjs approval"))
      .toBeLessThan(publicationYaml.indexOf("release-benchmark.mjs publication"));
    expect(publicationYaml).not.toContain("release-benchmark.mjs qualification --adapter");
    expect(publicationYaml).toContain("node-version: 22.23.2");
  });

  it("keeps qualification benchmarking manual, credential-free, and bound to feat/v3", () => {
    expect(benchmarkWorkflow.on).toEqual({ workflow_dispatch: null });
    expect(benchmarkWorkflow).not.toHaveProperty("schedule");
    expect(benchmarkWorkflow.permissions).toEqual({ contents: "read" });
    expect(benchmarkWorkflow.jobs["qualification-benchmark"]["runs-on"]).toBe("ubuntu-24.04");
    expect(publicationContract.benchmark.workflow).toMatchObject({
      path: ".github/workflows/qualification-benchmark.yml",
      trigger: "workflow_dispatch only until default-branch scheduling is explicitly authorized",
      checkoutRef: "refs/heads/feat/v3",
      command: "pnpm cli:benchmark:qualification -- --adapter development --candidate-root DIR --json",
    });
    expect(publicationContract.benchmark.workflow.credentials).toContain("No npm token");
    const steps = benchmarkWorkflow.jobs["qualification-benchmark"].steps;
    expect(steps.find((step: { uses?: string }) => step.uses === "actions/checkout@v4")).toMatchObject({
      with: { ref: "feat/v3", "fetch-depth": 0 },
    });
    const benchmarkStep = steps.find((step: { name?: string }) => step.name === "Run on-demand qualification benchmark");
    expect(benchmarkStep.run).toContain("pnpm cli:benchmark:qualification");
    expect(benchmarkStep.run).toContain("--candidate-root");
    expect(benchmarkStep.run).toContain("qualification-benchmark.json");
    expect(JSON.stringify(benchmarkWorkflow)).not.toMatch(/NPM_TOKEN|npm publish|release-benchmark\.mjs publication|cli:publish|cli:stage|cli:promote|approval/i);
  });

  it("rejects a successful qualification run from the wrong contracted ref", () => {
    const run = {
      id: 123,
      repository: { full_name: "jgabor/agentera" },
      head_repository: { full_name: "jgabor/agentera" },
      name: "Qualify release candidate",
      path: ".github/workflows/qualify-candidate.yml@feat/v3",
      head_branch: "feat/v3",
      head_sha: "a".repeat(40),
      event: "workflow_dispatch",
      conclusion: "success",
    };

    expect(validateQualificationWorkflowRun(run, 123)).toMatchObject({
      headSha: "a".repeat(40),
      ref: "refs/heads/feat/v3",
    });
    expect(() => validateQualificationWorkflowRun({
      ...run,
      head_branch: "main",
    }, 123)).toThrow("configured repository, workflow, and branch");
  });

  it("rejects a candidate receipt whose metadata commit differs from the API run head", () => {
    const receipt: Record<string, unknown> = {
      schemaVersion: "agentera.releaseQualification.v1",
      kind: "candidate",
      metadataCommit: "b".repeat(40),
    };
    receipt.receiptSha256 = sha256(canonicalJson(receipt));

    expect(() => validateCandidateRunBinding(receipt, receipt.receiptSha256 as string, "c".repeat(40)))
      .toThrow("API-backed qualification run head SHA");
  });
});

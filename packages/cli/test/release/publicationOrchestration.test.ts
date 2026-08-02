import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

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

describe("candidate publication orchestration", () => {
  it("routes preparation, qualification, approval, staging, and promotion through explicit scripts", () => {
    expect(rootPackage.scripts).toMatchObject({
      "cli:prepare:dev": "pnpm -C packages/cli run release:prepare",
      "cli:qualify:source": "pnpm -C packages/cli run release:qualify:source",
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
    expect(qualificationYaml).toContain("workflow_dispatch");
    expect(qualificationYaml).toContain("pnpm cli:qualify:source");
    expect(qualificationYaml).toContain("pnpm cli:qualify:dev");
    expect(qualificationYaml).toContain("release-qualification.mjs attest");
    expect(qualificationYaml).toContain("release-candidate-${{ github.run_id }}");
    expect(qualificationYaml).toContain("retention-days: 30");
    expect(qualificationYaml).not.toContain("NPM_TOKEN");
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
    expect(publicationYaml).toContain("run-id: ${{ inputs.source_run_id }}");
    expect(publicationYaml).toContain("release-qualification.mjs approval");
    expect(publicationYaml).toContain("--source-run-id");
    expect(publicationYaml).toContain("release-benchmark.mjs publication");
    expect(publicationYaml).toContain("coordinator enforces <120s");
    expect(publicationYaml).toContain("timeout-minutes: 3");
    expect(publicationYaml).toContain("qualified-publication-receipt.json");
    expect(publicationYaml.indexOf("validateQualificationWorkflowRun(run, runId)"))
      .toBeLessThan(publicationYaml.indexOf("Download exact qualification artifact"));
    expect(publicationYaml.indexOf("Bind candidate receipt to API-backed run head"))
      .toBeLessThan(publicationYaml.indexOf("environment: npm-publish"));
    expect(publicationYaml.indexOf("release-qualification.mjs approval"))
      .toBeLessThan(publicationYaml.indexOf("release-benchmark.mjs publication"));
    expect(publicationYaml).not.toContain("release-benchmark.mjs qualification --adapter");
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

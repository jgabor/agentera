import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

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

describe("candidate publication orchestration", () => {
  it("routes preparation, qualification, approval, staging, and promotion through explicit scripts", () => {
    expect(rootPackage.scripts).toMatchObject({
      "cli:prepare:dev": "pnpm -C packages/cli run release:prepare",
      "cli:qualify:source": "pnpm -C packages/cli run release:qualify:source",
      "cli:qualify:dev": "pnpm -C packages/cli run release:qualify:candidate",
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
    expect(stablePackage.scripts["release:stage"]).toContain(
      "publication-transaction.mjs stage stable --approve",
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

  it("requires explicit candidate digest approval, exact artifact transfer, L2, then forward-only promotion", () => {
    expect(publicationYaml).toContain("environment: npm-publish");
    expect(publicationYaml).toContain("candidate_receipt_sha256");
    expect(publicationYaml).toContain("actions/download-artifact@v4");
    expect(publicationYaml).toContain("run-id: ${{ inputs.source_run_id }}");
    expect(publicationYaml).toContain("release-qualification.mjs approval");
    expect(publicationYaml).toContain("publication-transaction.mjs stage");
    expect(publicationYaml).toContain("AGENTERA_SANDBOX_TIER: L2");
    expect(publicationYaml).toContain("publication-transaction.mjs promote");
    expect(publicationYaml.indexOf("publication-transaction.mjs stage"))
      .toBeLessThan(publicationYaml.indexOf("AGENTERA_SANDBOX_TIER: L2"));
    expect(publicationYaml.indexOf("AGENTERA_SANDBOX_TIER: L2"))
      .toBeLessThan(publicationYaml.indexOf("publication-transaction.mjs promote"));
  });
});

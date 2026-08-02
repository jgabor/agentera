// The exact-version L2 scenario is a candidate barrier, not an ordinary push effect.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const workflow = fs.readFileSync(
  path.join(REPO_ROOT, ".github/workflows/publish-qualified-candidate.yml"),
  "utf8",
);

describe("candidate L2 npm pin contract", () => {
  it("derives the exact package pin only after staging", () => {
    expect(workflow).not.toMatch(/AGENTERA_NPM_PIN:\s*agentera@/);
    expect(workflow).toContain("packages/cli/package.json");
    expect(workflow).toMatch(/AGENTERA_NPM_PIN="agentera@\$\{CLI_VERSION\}"/);
    expect(workflow.indexOf("publication-transaction.mjs stage"))
      .toBeLessThan(workflow.indexOf("AGENTERA_NPM_PIN"));
  });

  it("keeps the public tag unchanged until exact-version L2 succeeds", () => {
    expect(workflow.indexOf("AGENTERA_NPM_PIN"))
      .toBeLessThan(workflow.indexOf("publication-transaction.mjs promote"));
    expect(workflow).toContain("candidate_receipt_sha256");
    expect(workflow).toContain("environment: npm-publish");
  });
});

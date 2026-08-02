// The exact-version L2 scenario is a candidate barrier, not an ordinary push effect.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const workflow = fs.readFileSync(
  path.join(REPO_ROOT, ".github/workflows/publish-qualified-candidate.yml"),
  "utf8",
);
const benchmark = fs.readFileSync(
  path.join(REPO_ROOT, "packages/cli/scripts/release-benchmark.mjs"),
  "utf8",
);
const harness = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/sandbox/v2v3-upgrade-harness.sh"),
  "utf8",
);

describe("candidate L2 npm pin contract", () => {
  it("derives the exact package pin only after staging", () => {
    expect(workflow).not.toMatch(/AGENTERA_NPM_PIN:\s*agentera@/);
    expect(benchmark).toContain("AGENTERA_NPM_PIN: `${candidate.package}@${candidate.version}`");
    expect(benchmark).toMatch(/transaction\("stage", "stage"\),\s+exactVersionL2,\s+transaction\("promote", "promote"\)/);
  });

  it("keeps the public tag unchanged until exact-version L2 succeeds", () => {
    expect(workflow).toContain("release-benchmark.mjs publication");
    expect(benchmark).toContain("AGENTERA_SANDBOX_TIER: \"L2\"");
    expect(workflow).toContain("candidate_receipt_sha256");
    expect(workflow).toContain("environment: npm-publish");
  });

  it("gives L2 npx sandbox-owned user and global npm configuration", () => {
    expect(benchmark).toContain('isolatedNpmState("agentera-qualified-l2-"');
    expect(benchmark).toContain("registryInGlobalConfig: true");
    expect(harness).toContain('NPM_CONFIG_USERCONFIG="$SANDBOX/npm-user.npmrc"');
    expect(harness).toContain('NPM_CONFIG_GLOBALCONFIG="$SANDBOX/npm-global.npmrc"');
    expect(harness).toContain("unset NPM_TOKEN NODE_AUTH_TOKEN");
    expect(harness.match(/registry=https:\/\/registry\.npmjs\.org\//g)).toHaveLength(2);
  });
});

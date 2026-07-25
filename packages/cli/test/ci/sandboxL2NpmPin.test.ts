// The bootstrap-owned L2 sandbox consumes, rather than gates, publication.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const CI_YML = path.join(REPO_ROOT, ".github/workflows/ci.yml");

function sandboxL2Section(ciYaml: string): string {
  const start = ciYaml.indexOf("  sandbox-l2:");
  expect(start).toBeGreaterThanOrEqual(0);
  const nextJob = ciYaml.slice(start + 1).match(/\n  [a-zA-Z0-9_-]+:/);
  const end = nextJob?.index === undefined ? -1 : start + 1 + nextJob.index;
  return end === -1 ? ciYaml.slice(start) : ciYaml.slice(start, end);
}

describe("CI sandbox-l2 npm pin contract (B5-6, #44, G6)", () => {
  const ciYaml = fs.readFileSync(CI_YML, "utf8");
  const l2 = sandboxL2Section(ciYaml);

  it("does not hardcode AGENTERA_NPM_PIN env with agentera@<version>", () => {
    expect(l2).not.toMatch(/AGENTERA_NPM_PIN:\s*agentera@/);
    expect(ciYaml).not.toMatch(/agentera@3\.0\.0-next\.\d+/);
  });

  it("derives pin from packages/cli/package.json at workflow runtime", () => {
    expect(l2).toContain("packages/cli/package.json");
    expect(l2).toMatch(/AGENTERA_NPM_PIN="agentera@\$\{CLI_VERSION\}"/);
    expect(l2).toContain('npm view "${AGENTERA_NPM_PIN}"');
  });

  it("runs only after the development publication transaction", () => {
    expect(l2).toContain("needs: [publish-next]");
    expect(l2).toContain("TODO vptlelnadp owns the full exact-version bootstrap matrix");
  });

  it("fails non-zero with a clear message when the computed pin is unpublished", () => {
    expect(l2).not.toMatch(/skip:.*not published/);
    expect(l2).not.toMatch(/exit\s+0/);
    expect(l2).toMatch(/exit\s+1/);
    expect(l2).toMatch(/not published on npm after the publication transaction/i);
    expect(l2).toMatch(/\$\{AGENTERA_NPM_PIN\}/);
  });
});

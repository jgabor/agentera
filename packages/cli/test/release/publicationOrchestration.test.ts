import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const ciYaml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const rootPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const developmentPackage = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"),
);
const stablePackage = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "packages/cli/shim/package.json"), "utf8"),
);

function job(name: string): string {
  const start = ciYaml.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = ciYaml.slice(start + 1).match(/\n  [a-zA-Z0-9_-]+:/);
  return next?.index === undefined ? ciYaml.slice(start) : ciYaml.slice(start, start + 1 + next.index);
}

describe("publication orchestration", () => {
  const development = job("publish-next");
  const stable = job("publish-latest");

  it("routes local and CI development and stable commands through the same adapters", () => {
    expect(rootPackage.scripts).toMatchObject({
      "cli:prepare:dev": "pnpm -C packages/cli run release:prepare",
      "cli:prepare:stable": "pnpm -C packages/cli/shim run release:prepare",
      "cli:publish:dev": "pnpm -C packages/cli run publish:dev",
      "cli:publish:stable": "pnpm -C packages/cli/shim run publish:stable",
    });
    expect(developmentPackage.scripts["release:prepare"]).toContain(
      "publication-transaction.mjs prepare development",
    );
    expect(developmentPackage.scripts["publish:dev"]).toContain(
      "publication-transaction.mjs publish development --authorize",
    );
    expect(stablePackage.scripts["release:prepare"]).toContain(
      "publication-transaction.mjs prepare stable",
    );
    expect(stablePackage.scripts["publish:stable"]).toContain(
      "publication-transaction.mjs publish stable --authorize",
    );
    expect(development).toContain("run: pnpm cli:publish:dev");
    expect(stable).toContain("run: pnpm cli:publish:stable");
    expect(ciYaml).not.toContain("publication-transaction.mjs");
  });

  it("lets the transaction replay unchanged versions and fail missing mutation credentials", () => {
    expect(development).not.toContain("version-check");
    expect(stable).not.toContain("version-check");
    expect(development).not.toMatch(/NPM_TOKEN.*(?:skip|exit 0)/s);
    expect(stable).not.toMatch(/NPM_TOKEN.*(?:skip|exit 0)/s);
    expect(development).toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(stable).toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
  });

  it("mutates npm only for matching branch pushes after required gates", () => {
    expect(development).toContain("needs: [cli, sandbox-l1]");
    expect(development).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/feat/v3'",
    );
    expect(stable).toContain("needs: [cli]");
    expect(stable).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(ciYaml).toMatch(/push:\n\s+branches:\n\s+- main\n\s+- feat\/v3/);
    expect(ciYaml).not.toMatch(/\bnpm publish\b/);
  });

  it("publishes development before bootstrap-owned exact-version L2", () => {
    const l2 = job("sandbox-l2");
    expect(development).not.toContain("sandbox-l2");
    expect(l2).toContain("needs: [publish-next]");
    expect(l2).toContain("TODO vptlelnadp owns the full exact-version bootstrap matrix");
  });
});

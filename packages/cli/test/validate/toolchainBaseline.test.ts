import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const baseline = YAML.parse(fs.readFileSync(path.join(ROOT, "references/analysis/toolchain-baseline.yaml"), "utf8"));
const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const workspace = YAML.parse(fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8"));
const publicationWorkflow = YAML.parse(fs.readFileSync(path.join(ROOT, ".github/workflows/publish.yml"), "utf8"));
const cliPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/cli/package.json"), "utf8"));
const rootViteConfig = fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");

const setupVpReleases = [
  ["1.0.0", "4a524139920f87f9f7080d3b8545acac019e1852"],
  ["1.1.0", "e1609b468742ba9232ce5e12b3a77bdf14495277"],
  ["1.2.0", "fd19e0626188613eec92a77e875180c6445b56ba"],
  ["1.2.1", "906b5821fc79472a80264736a266e06643cca1fc"],
  ["1.3.0", "20553a7a7429c429a74894104a2835d7fed28a72"],
  ["1.4.0", "624fe22ccfe9204a526ac8139186d34297453722"],
  ["1.5.0", "e34774bccb4e7d7f2e23514ca980177a71425e43"],
  ["1.6.0", "8ecb39174989ce55af90f45cf55b02738599831d"],
  ["1.7.0", "379dedaa971cd3b6841bd2470708ed0d64013020"],
  ["1.8.0", "4f5aa3e38c781f1b01e78fb9255527cee8a6efa6"],
  ["1.9.0", "56918a6d0c629c55ae8b88826a7d47fda85769ee"],
  ["1.10.0", "ca1c46663915d6c1042ae23bd39ab85718bfb0fa"],
  ["1.11.0", "329490fff19dd4ecd8ff2a74d7c45bee0448f3a6"],
  ["1.12.0", "2dec1e33f4ab2c6d5bce1b0c4607961bb1a3f7a1"],
  ["1.13.0", "35171c92dd08b67d5a9d3f2a4327800e58396f2a"],
  ["1.14.0", "13e7afb99c66525824db54e107d667216e795d37"],
  ["1.15.0", "250f29ce396baf5e8f24498e17c0dfdebabc26eb"],
  ["1.16.0", "c9c4510a7d35d8bb0afdbe4092bae2676c893c8f"],
  ["1.16.1", "143f5f385f39b1b753ffed1a01ad443811855c8b"],
  ["1.17.0", "313600b80b104eadebb9111787d37a2e83e014ca"],
  ["1.18.0", "1b32467adbe183473499fd9d5d372c3ed9641754"],
];
const SETUP_NODE = "actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f";
const BOOTSTRAP = "node packages/cli/scripts/bootstrap-integrity.mjs";

function validateSetupJobs(workflows: any[]): void {
  const jobs = workflows.flatMap((workflow) => Object.entries(workflow.jobs as Record<string, any>).map(([name, job]) => ({ name, job })));
  expect(
    jobs
      .filter(({ job }) => job.steps.some((step: { run?: string }) => /bootstrap-integrity\.mjs|vp run build|pack-package\.mjs/u.test(step.run ?? "")))
      .map(({ name }) => name)
      .sort(),
  ).toEqual(["build-development", "verify-development"]);
  const setupJobs = jobs.filter(({ job }) => job.steps.some((step: { uses?: string }) => step.uses?.startsWith("actions/setup-node@")));
  expect(setupJobs.map(({ name }) => name).sort()).toEqual(["build-development", "verify-development"]);
  for (const { job } of setupJobs) {
    const setupIndex = job.steps.findIndex((step: { uses?: string }) => step.uses?.startsWith("actions/setup-node@"));
    const setup = job.steps[setupIndex];
    expect(setup.uses).toBe(SETUP_NODE);
    expect(setup.with).toEqual({
      "node-version-file": ".node-version",
      "package-manager-cache": false,
    });
    expect(job.steps[setupIndex + 1].run).toBe(`${BOOTSTRAP} --ignore-scripts`);
    expect(JSON.stringify(job)).not.toContain("setup-vp");
    expect(job.permissions?.["id-token"]).toBeUndefined();
  }
}

describe("toolchain baseline", () => {
  it("retains the setup-vp inventory without treating its old waiver as integrity acceptance", () => {
    expect(baseline.status).toBe("bootstrap_rollout_pending_hosted_acceptance");
    expect(Object.entries(baseline.selection.setup_vp.release_inventory)).toEqual(setupVpReleases);
    expect(Object.values(baseline.selection.setup_vp.implementations)).toSatisfy((implementations: any[]) => implementations.every((implementation) => implementation.integrity_verified === false && implementation.fail_closed === false));
    expect(baseline.selection.setup_vp.selected).toEqual({
      version: "1.18.0",
      action_commit: "1b32467adbe183473499fd9d5d372c3ed9641754",
      classification: "replaced_pending_hosted_acceptance",
      boundary: "non_oidc_install_or_build_jobs_only",
      compatibility: "requests the exact Vite+ 0.3.0 release before fallback",
    });
    expect(baseline.selection.setup_vp.upstream_head.commit).toBe("5af416ede120848958d85c9720e61b921ac7bca6");
  });

  it("keeps setup actions out of the OIDC publisher", () => {
    const publisher = publicationWorkflow.jobs["publish-development"];
    expect(publisher.permissions["id-token"]).toBe("write");
    expect(publisher.steps.every((step: { uses?: string }) => step.uses === undefined)).toBe(true);
    expect(JSON.stringify(publisher)).not.toContain("setup-vp");
  });

  it("pins Node provisioning and the verified bootstrap variant with no dependency cache in every setup job", () => {
    expect(() => validateSetupJobs([publicationWorkflow])).not.toThrow();
    const mutable = structuredClone(publicationWorkflow);
    mutable.jobs["verify-development"].steps.find((step: { uses?: string }) => step.uses === SETUP_NODE).uses = "actions/setup-node@v6";
    expect(() => validateSetupJobs([mutable])).toThrow();

    const cached = structuredClone(publicationWorkflow);
    cached.jobs["verify-development"].steps.find((step: { uses?: string }) => step.uses === SETUP_NODE).with["package-manager-cache"] = true;
    expect(() => validateSetupJobs([cached])).toThrow();
    const lifecycle = structuredClone(publicationWorkflow);
    lifecycle.jobs["build-development"].steps.find((step: { run?: string }) => step.run?.startsWith(BOOTSTRAP)).run = BOOTSTRAP;
    expect(() => validateSetupJobs([lifecycle])).toThrow();
  });

  it("binds the executable integration proof to live project policy", () => {
    expect(baseline.executable_proof.command).toBe("vp -C packages/cli run test:toolchain-baseline");
    expect(baseline.selection.vite_plus.version).toBe("0.3.0");
    expect(rootPackage.packageManager).toBe("pnpm@10.30.3");
    expect(workspace.catalog).toEqual({
      lefthook: "2.1.12",
      "markdownlint-cli": "0.48.0",
      "@typescript/typescript6": "6.0.2",
      oxfmt: "0.64.0",
      oxlint: "1.79.0",
      vite: "8.2.2",
      "vite-plus": "0.3.0",
      vitest: "4.1.11",
    });
    expect(Object.values(rootPackage.devDependencies)).toSatisfy((versions: unknown[]) => versions.every((version) => version === "catalog:"));
    expect(cliPackage.devDependencies).toMatchObject({
      "@typescript/typescript6": "catalog:",
      vite: "catalog:",
      "vite-plus": "catalog:",
      vitest: "catalog:",
    });
    expect(rootViteConfig).toContain("maxWarnings: 8");
    expect(rootViteConfig).not.toContain("typeCheck: true");
    expect(rootViteConfig).not.toContain("tasks:");
    expect(rootPackage.scripts).toMatchObject({
      bootstrap: "vp install --frozen-lockfile",
      test: "pnpm -C packages/cli test",
      build: "pnpm -C packages/cli build",
      verify: "pnpm -C packages/cli run verify:release",
      typecheck: "pnpm -C packages/cli run typecheck",
    });
    expect(workspace.onlyBuiltDependencies).toEqual(["esbuild"]);
    expect(cliPackage.scripts["test:toolchain-baseline"]).toBe("node scripts/verify-toolchain-baseline.mjs");
  });
});

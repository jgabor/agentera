import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { canonicalJson, issueCiAttestation, publicationWorkflowIdentity, sha256 } from "../../scripts/release-qualification.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const ciYaml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/verify-changes.yml"), "utf8");
const qualificationYaml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/publish.yml"), "utf8");
const rootPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const developmentPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"));
const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "registry.json"), "utf8"));
const skill = fs.readFileSync(path.join(REPO_ROOT, "skills/agentera/SKILL.md"), "utf8");
const stablePackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/shim/package.json"), "utf8"));
const publicationContract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "references/adapters/package-publication.json"), "utf8"));
const packagingGuide = fs.readFileSync(path.join(REPO_ROOT, "docs/packaging/v3-packaging.md"), "utf8");
const releaseSkill = fs.readFileSync(path.join(REPO_ROOT, ".opencode/skills/agentera-release/SKILL.md"), "utf8");
const verificationSkill = fs.readFileSync(path.join(REPO_ROOT, ".opencode/skills/agentera-verification/SKILL.md"), "utf8");
const agentsGuide = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
const require = createRequire(import.meta.url);
const npm1117GithubProvenance = require("../fixtures/release/npm-11.17-github-provenance.cjs");

const githubProvenance = {
  GITHUB_WORKFLOW_REF: "jgabor/agentera/.github/workflows/publish.yml@refs/heads/feat/v3",
  GITHUB_REPOSITORY: "jgabor/agentera",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REF: "refs/heads/feat/v3",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_EVENT_NAME: "push",
  GITHUB_REPOSITORY_ID: "123456789",
  GITHUB_REPOSITORY_OWNER_ID: "987654321",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_RUN_ID: "33746838768",
  GITHUB_RUN_ATTEMPT: "1",
};

const reviewedOidcPublicationSteps = [
  {
    name: "Select fixed runner toolchain",
    "timeout-minutes": 1,
    run: "sha256:b42037a540db7481cbe7f5089a688a84e898adcdb24574078c98b475a476451f",
  },
  {
    name: "Download and validate current-run candidate",
    "timeout-minutes": 1,
    env: {
      GH_TOKEN: "${{ github.token }}",
      API_URL_VALUE: "${{ github.api_url }}",
      REPOSITORY_VALUE: "${{ github.repository }}",
      RUN_ID_VALUE: "${{ github.run_id }}",
      RUNNER_TEMP_VALUE: "${{ runner.temp }}",
      EXPECTED_VERSION_VALUE: "${{ needs.build-development.outputs.version }}",
      EXPECTED_GIT_REF_VALUE: "${{ github.sha }}",
      EXPECTED_OUTCOME_VALUE: "${{ needs.build-development.outputs.outcome }}",
    },
    run: "sha256:216d65323f86b2a9422ba4beeda4bb08eed4a09430918e1e9f15779306f3452f",
  },
  {
    name: "Write fixed registry guard",
    "timeout-minutes": 1,
    env: { RUNNER_TEMP_VALUE: "${{ runner.temp }}" },
    run: "sha256:5453a66d3f3d54b196ff167e46c296bef362e5b2fd9e9709c28a56fc62f307df",
  },
  {
    name: "Recheck exact candidate and registry without OIDC",
    id: "registry-guard",
    "timeout-minutes": 1,
    env: {
      RUNNER_TEMP_VALUE: "${{ runner.temp }}",
      EXPECTED_VERSION_VALUE: "${{ needs.build-development.outputs.version }}",
      EXPECTED_GIT_REF_VALUE: "${{ github.sha }}",
      EXPECTED_OUTCOME_VALUE: "${{ needs.build-development.outputs.outcome }}",
    },
    run: "sha256:fc39f6122768ad6895b5cbca8844102e7e95eabc8c39e2fe15305300afa08ceb",
  },
  {
    name: "Publish exact tarball with Trusted Publishing",
    if: "steps.registry-guard.outputs.outcome == 'forward-publish'",
    "timeout-minutes": 1,
    env: {
      RUNNER_TEMP_VALUE: "${{ runner.temp }}",
      EXPECTED_VERSION_VALUE: "${{ needs.build-development.outputs.version }}",
      EXPECTED_GIT_REF_VALUE: "${{ github.sha }}",
      GUARD_OUTCOME_VALUE: "${{ steps.registry-guard.outputs.outcome }}",
      GITHUB_WORKFLOW_REF_VALUE: "${{ github.workflow_ref }}",
      GITHUB_REPOSITORY_VALUE: "${{ github.repository }}",
      GITHUB_SERVER_URL_VALUE: "${{ github.server_url }}",
      GITHUB_REF_VALUE: "${{ github.ref }}",
      GITHUB_SHA_VALUE: "${{ github.sha }}",
      GITHUB_EVENT_NAME_VALUE: "${{ github.event_name }}",
      GITHUB_REPOSITORY_ID_VALUE: "${{ github.repository_id }}",
      GITHUB_REPOSITORY_OWNER_ID_VALUE: "${{ github.repository_owner_id }}",
      RUNNER_ENVIRONMENT_VALUE: "${{ runner.environment }}",
      GITHUB_RUN_ID_VALUE: "${{ github.run_id }}",
      GITHUB_RUN_ATTEMPT_VALUE: "${{ github.run_attempt }}",
    },
    run: "sha256:6efc8b29ff3a86b880675b7fffbe9e0c1317110a4a58c427e03194a9093c169f",
  },
  {
    name: "Verify registry convergence without OIDC",
    if: "steps.registry-guard.outputs.outcome == 'forward-publish'",
    "timeout-minutes": 1,
    env: {
      RUNNER_TEMP_VALUE: "${{ runner.temp }}",
      EXPECTED_VERSION_VALUE: "${{ needs.build-development.outputs.version }}",
      EXPECTED_GIT_REF_VALUE: "${{ github.sha }}",
      EXPECTED_OUTCOME_VALUE: "${{ needs.build-development.outputs.outcome }}",
      GUARD_OUTCOME_VALUE: "${{ steps.registry-guard.outputs.outcome }}",
    },
    run: "sha256:3735be7aea3a55197d09de3c6123d0609ae5002db4cdccbbfe4b2ed8a5e6bbcc",
  },
];

function requireReviewedOidcPublicationSteps(workflow: any) {
  const steps = workflow.jobs["publish-development"].steps.map((step: Record<string, unknown>) => ({
    ...step,
    ...(typeof step.run === "string"
      ? {
          run: `sha256:${crypto.createHash("sha256").update(step.run).digest("hex")}`,
        }
      : {}),
  }));
  if (canonicalJson(steps) !== canonicalJson(reviewedOidcPublicationSteps)) {
    throw new Error("OIDC publication steps do not match the fixed reviewed step set");
  }
}

describe("package publication orchestration", () => {
  it("prepares only the first checked-in development package version", () => {
    expect(developmentPackage.version).toBe("3.0.0-dev.84");
    expect(developmentPackage.agentera.suiteVersion).toBe("3.0.0");
    expect(registry.skills[0].version).toBe("3.0.0");
    expect(skill).toMatch(/^version: "3\.0\.0"$/m);
    expect(stablePackage).toMatchObject({
      version: "0.0.2",
      agentera: {
        suiteVersion: "2.7.7",
        gitRef: "ce4a7054a8438b8b0aac013bac4b86ba1a9de3dd",
      },
    });
  });

  it("documents deterministic allocation and development version recovery", () => {
    expect(packagingGuide).toContain("GITHUB_RUN_NUMBER + 89");
    expect(packagingGuide).toContain("Failed runs leave gaps");
    expect(packagingGuide).toContain("exact replay");
    expect(packagingGuide).toContain("npm already contains");
    expect(packagingGuide).toMatch(/do not\s+overwrite or retag it/);
    expect(packagingGuide).toContain("obtain fresh authorization");
  });

  it("documents the job-level OIDC boundary without stale publication guidance", () => {
    for (const surface of [agentsGuide, releaseSkill, packagingGuide, changelog, publicationContract.invariants.credentials]) {
      const prose = surface.replace(/\s+/g, " ");
      expect(prose).toMatch(/entire (?:dependent )?checkout-free, action-free (?:publication )?job has OIDC capability/);
      expect(prose).toContain("fixed reviewed workflow logic");
      expect(prose).not.toMatch(/OIDC-only job|only (?:the )?(?:npm publish|publish step) has OIDC/i);
    }
    for (const surface of [agentsGuide, releaseSkill, verificationSkill, packagingGuide, changelog]) {
      expect(surface).not.toMatch(/publish-(?:next|stable)\.yml|GITHUB_RUN_NUMBER (?:\+|plus) 80|AGENTERA_NEXT_BRANCH/);
    }
  });

  it("routes preparation, verification, approval, staging, and promotion through explicit scripts", () => {
    expect(rootPackage.scripts).toMatchObject({
      "cli:prepare:dev": "pnpm -C packages/cli run release:prepare",
      "cli:qualify:source": "pnpm -C packages/cli run release:qualify:source",
      "cli:ready:dev": "pnpm -C packages/cli run release:ready",
      "cli:qualify:dev": "pnpm -C packages/cli run release:qualify:candidate",
      "cli:benchmark:qualification": "pnpm -C packages/cli run release:benchmark:qualification",
      "cli:publish:qualified:dev": "pnpm -C packages/cli run release:publish:qualified",
      "cli:approve:dev": "pnpm -C packages/cli run release:approve",
      "cli:stage:dev": "pnpm -C packages/cli run release:stage",
      "cli:promote:dev": "pnpm -C packages/cli run release:promote",
    });
    expect(developmentPackage.scripts["release:prepare"]).toContain("publication-transaction.mjs prepare development");
    expect(developmentPackage.scripts["release:ready"]).toBe("node scripts/release-readiness.mjs development");
    expect(developmentPackage.scripts["release:stage"]).toContain("publication-transaction.mjs stage development --approve");
    expect(developmentPackage.scripts["release:promote"]).toContain("publication-transaction.mjs promote development --approve");
    expect(developmentPackage.scripts["release:benchmark:qualification"]).toContain("release-benchmark.mjs qualification");
    expect(developmentPackage.scripts["release:publish:qualified"]).toContain("release-benchmark.mjs publication --adapter development");
    expect(stablePackage.scripts["release:stage"]).toContain("publication-transaction.mjs stage stable --approve");
    expect(stablePackage.scripts["release:publish:qualified"]).toContain("release-benchmark.mjs publication --adapter stable");
    expect(developmentPackage.scripts).not.toHaveProperty("publish:dev");
    expect(stablePackage.scripts).not.toHaveProperty("publish:stable");
  });

  it("separates allocated CI construction from receipt-bound manual preparation", () => {
    expect(publicationContract.invariants.preparation).toContain("allocates a candidate version from GITHUB_RUN_NUMBER plus 89");
    expect(publicationContract.invariants.preparation).toContain("manual readiness preparation path first validates a current normalized source receipt");
    expect(publicationContract.qualification.source.reuseCheck.scope).toContain("Manual readiness preparation uses the check as a source-readiness prerequisite");
    expect(publicationContract.invariants.preparation).toContain("Stable preparation retains its separate source-provenance contract");
  });

  it("keeps canonical development publication instructions on deterministic allocation authority", () => {
    for (const [label, instructions] of [
      ["packaging guide", packagingGuide],
      ["release skill", releaseSkill],
      ["agent bootstrap", agentsGuide],
    ] as const) {
      expect(instructions, label).toContain("GITHUB_RUN_NUMBER");
      expect(instructions, label).toMatch(/(?:plus|\+) 89/);
      expect(instructions, label).toContain("GITHUB_SHA");
      expect(instructions, label).toContain("queue: max");
      expect(instructions, label).toContain("explicit push authorization");
      expect(instructions, label).toMatch(/stable preparation\s+continues to require explicit\s+`--target-version`/);
      expect(instructions, label).not.toMatch(/offset 82/i);
    }

    for (const instructions of [packagingGuide, releaseSkill]) {
      const developmentBlocks = [...instructions.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]).filter((block) => block.includes("cli:ready:dev") || block.includes("cli:prepare:dev"));
      expect(developmentBlocks.length).toBeGreaterThan(0);
      for (const block of developmentBlocks) expect(block).not.toContain("--target-version");
    }

    expect(releaseSkill).toContain(["pnpm cli:prepare:stable -- \\", "  --target-version X.Y.Z --source-commit COMMIT"].join("\n"));

    for (const [label, instructions] of [
      ["release skill", releaseSkill],
      ["verification skill", verificationSkill],
    ] as const) {
      const normalizedInstructions = instructions.replace(/\s+/g, " ");
      expect(normalizedInstructions, label).toContain("GITHUB_RUN_NUMBER + 89");
      expect(normalizedInstructions, label).toContain("runs 1, 2, and 3 map to");
      expect(normalizedInstructions, label).toContain("`3.0.0-dev.90`, `3.0.0-dev.91`, and `3.0.0-dev.92`");
      expect(normalizedInstructions, label).toContain("Only copied manifest `version` and `agentera.gitRef` change");
      expect(normalizedInstructions, label).toContain("no pre-push development version bump or metadata-only release commit");
      expect(normalizedInstructions, label).toContain("Failed runs can leave gaps");
      expect(normalizedInstructions, label).toContain("rerun reuses the same run number, `GITHUB_SHA`, and candidate version");

      const normalPushGuidance = instructions
        .split(/\n\s*\n/)
        .filter((paragraph) => /(?:normal|development|queued) push/i.test(paragraph))
        .join("\n");
      expect(normalPushGuidance, label).not.toMatch(/checked-in (?:candidate |package )?version/i);
      expect(normalPushGuidance, label).not.toMatch(/(?:changes|sets) only\s+`agentera\.gitRef`/i);
    }

    expect(changelog).toContain("preserves deterministic allocation");
  });

  it("passes the allocated candidate through construction, classification, and guarded publication", () => {
    expect(qualificationYaml).toContain("allocateDevelopmentVersion");
    expect(qualificationYaml).toContain("process.env.GITHUB_RUN_NUMBER");
    expect(qualificationYaml).toContain('--package-version "${{ steps.version.outputs.value }}"');
    expect(qualificationYaml.match(/--package-version "\$\{\{ steps\.version\.outputs\.value \}\}"/g)).toHaveLength(2);
    expect(qualificationYaml).not.toContain("require('./packages/cli/package.json').version");
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
    expect(publicationContract.qualification.readiness.metadataReview).toContain("never prepares metadata, changes a version, commits, approves");
    expect(publicationContract.qualification.readiness.reuse).toContain("validated instead of invoking package verification");
  });

  it("keeps credentials out of package scripts and ordinary CI pushes", () => {
    expect(JSON.stringify(developmentPackage.scripts)).not.toContain(".env");
    expect(JSON.stringify(stablePackage.scripts)).not.toContain(".env");
    expect(ciYaml).not.toContain("NPM_TOKEN");
    expect(ciYaml).not.toContain("publish-next");
    expect(ciYaml).not.toContain("publish-latest");
    expect(ciYaml).not.toContain("npm publish");
    const ciWorkflow = YAML.parse(ciYaml);
    expect(ciWorkflow.on.push.branches).toEqual(["main"]);
    expect(ciWorkflow.on).toHaveProperty("pull_request");
    expect(ciWorkflow.jobs.cli).not.toHaveProperty("if");
    expect(ciWorkflow.jobs["source-migration"].if).toBe("github.ref == 'refs/heads/feat/v3' || github.event_name == 'pull_request'");
  });

  it("selects the development branch and separates immutable build from OIDC publication", () => {
    const selectedRef = publicationContract.ci.developmentPush.ref;
    expect(qualificationYaml).not.toContain("AGENTERA_" + "NEXT_BRANCH");
    expect(qualificationYaml).not.toContain(selectedRef.slice("refs/heads/".length));
    expect(qualificationYaml).not.toMatch(/fallback/i);
    expect([qualificationYaml, JSON.stringify(publicationContract.ci)].reduce((count, surface) => count + surface.split(selectedRef).length - 1, 0)).toBe(1);
    expect(qualificationYaml).not.toContain("workflow_dispatch");
    expect(qualificationYaml).toContain("group: publish-agentera");
    expect(qualificationYaml).toContain("queue: max");
    expect(qualificationYaml).not.toContain("cancel-in-progress");
    expect(qualificationYaml).not.toContain("github.run_number");
    expect(qualificationYaml).toContain("GITHUB_RUN_NUMBER");
    expect(qualificationYaml).not.toContain("require('./packages/cli/package.json').version");
    expect(qualificationYaml).toContain("GITHUB_SHA");
    expect(qualificationYaml).toContain("pack-package.mjs");
    expect(qualificationYaml).toContain("publish-development.mjs classify");
    expect(qualificationYaml).not.toContain("publish-development.mjs mutate");
    expect(qualificationYaml.match(/--package-version "\$\{\{ steps\.version\.outputs\.value \}\}"/g)).toHaveLength(2);
    expect(qualificationYaml).toContain('--git-ref "${GITHUB_SHA}"');
    expect(qualificationYaml).toContain("agentera-development-candidate");
    expect(qualificationYaml).not.toContain("secrets.NPM_TOKEN");
    expect(qualificationYaml).not.toContain(":_authToken");
    expect(qualificationYaml).not.toContain("--auth-config");
    const workflow = YAML.parse(qualificationYaml);
    requireReviewedOidcPublicationSteps(workflow);
    expect(workflow).not.toHaveProperty("permissions");
    const route = workflow.jobs["route-development"];
    expect(route.permissions).toEqual({ contents: "read" });
    expect(route.permissions).not.toHaveProperty("id-token");
    expect(route.outputs).toEqual({
      selected: "${{ steps.route.outputs.selected }}",
      ref: "${{ steps.route.outputs.ref }}",
    });
    const routeCheckout = route.steps.find((step: { uses?: string }) => step.uses === "actions/checkout@v5");
    expect(routeCheckout.with).toMatchObject({
      ref: "${{ github.event.repository.default_branch }}",
      path: "publication-authority",
      "sparse-checkout": "references/adapters/package-publication.json",
    });
    expect(JSON.stringify(routeCheckout.with)).not.toContain("github.sha");
    const routeStep = route.steps.find((step: { id?: string }) => step.id === "route");
    expect(routeStep.run).toContain("configuredRef.startsWith('refs/heads/')");
    expect(routeStep.run).toContain("['check-ref-format', configuredRef]");
    expect(routeStep.run).toContain("configuredRef === 'refs/heads/main'");
    expect(routeStep.run).toContain("configuredRef === process.env.GITHUB_REF");
    expect(routeStep.run).toContain("selected=${selected}");
    const verification = workflow.jobs["verify-development"];
    expect(verification.permissions).toEqual({ contents: "read" });
    expect(verification.permissions).not.toHaveProperty("id-token");
    expect(verification.needs).toBe("route-development");
    expect(verification.if).toBe("needs.route-development.outputs.selected == 'true'");
    expect(verification["timeout-minutes"]).toBeGreaterThanOrEqual(45);
    expect(verification.steps.find((step: { uses?: string }) => step.uses === "actions/checkout@v5").with.ref).toBe("${{ github.sha }}");
    expect(verification.steps.find((step: { name?: string }) => step.name === "Check static project policy").run).toBe("vp check");
    const requireParityPrerequisite = (steps: { uses?: string; run?: string; if?: string; "continue-on-error"?: boolean }[]) => {
      const checkoutIndex = steps.findIndex((step) => step.uses === "actions/checkout@v5");
      const fetchIndex = steps.findIndex((step) => step.run === "git fetch origin refs/heads/main:refs/remotes/origin/main --depth=1");
      const verifyIndex = steps.findIndex((step) => step.run === "vp run verify");
      expect(fetchIndex).toBeGreaterThan(checkoutIndex);
      expect(fetchIndex).toBeLessThan(verifyIndex);
      for (const step of [steps[fetchIndex], steps[verifyIndex]]) {
        expect(step).not.toHaveProperty("if");
        expect(step).not.toHaveProperty("continue-on-error");
      }
    };
    expect(() => requireParityPrerequisite(verification.steps)).not.toThrow();
    const fetch = verification.steps.find((step: { name?: string }) => step.name === "Fetch main for source-owned py-ts parity");
    const withoutFetch = verification.steps.filter((step: unknown) => step !== fetch);
    expect(() => requireParityPrerequisite(withoutFetch)).toThrow();
    expect(() => requireParityPrerequisite([...withoutFetch, fetch])).toThrow();
    expect(() => requireParityPrerequisite(verification.steps.map((step: unknown) => (step === fetch ? { ...fetch, run: "git fetch origin refs/heads/main --depth=1" } : step)))).toThrow();
    expect(verification).not.toHaveProperty("continue-on-error");
    const sourceVerification = verification.steps.find((step: { name?: string }) => step.name === "Verify release source without receipt");
    expect(sourceVerification.run).toBe("vp run verify");
    expect(sourceVerification["timeout-minutes"] * 60_000).toBeGreaterThanOrEqual(publicationContract.benchmark.timeouts.sourceQualificationMs);
    expect(JSON.stringify(verification)).not.toMatch(/--receipt-file|release-qualification\.mjs|candidate|upload-artifact|npm publish|id-token/i);
    expect(workflow.jobs["build-development"].permissions).toEqual({ contents: "read" });
    expect(workflow.jobs["build-development"].permissions).not.toHaveProperty("id-token");
    expect(workflow.jobs["build-development"].needs).toBe("verify-development");
    expect(workflow.jobs["build-development"]).not.toHaveProperty("if");
    expect(workflow.jobs["publish-development"].permissions).toEqual({
      actions: "read",
      "id-token": "write",
    });
    expect(workflow.jobs["publish-development"].needs).toBe("build-development");
    const buildSteps = workflow.jobs["build-development"].steps;
    const publishSteps = workflow.jobs["publish-development"].steps;
    const construction = buildSteps.find((step: { name?: string }) => step.name === "Build one isolated package tarball");
    expect(construction.run).toContain("--package-version");
    expect(publishSteps.some((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(JSON.stringify(publishSteps)).not.toContain("packages/cli/scripts");
    const upload = buildSteps.find((step: { uses?: string }) => step.uses === "actions/upload-artifact@v4");
    expect(upload.with).toMatchObject({
      name: "agentera-development-candidate",
      "retention-days": 1,
    });
    expect(upload.with.path.trim().split("\n")).toEqual(["${{ runner.temp }}/agentera-development/agentera-${{ steps.version.outputs.value }}.tgz", "${{ runner.temp }}/agentera-development/publication-classification.json"]);
    const classification = buildSteps.find((step: { id?: string }) => step.id === "classification");
    expect(classification).not.toHaveProperty("env.NPM_TOKEN");
    expect(classification.run).toContain('env -i PATH="${PATH}" node packages/cli/scripts/publish-development.mjs classify');
    expect(classification.run).toContain("publication-classification.json");
    expect(classification.run).toContain("exact-replay|superseded-replay|forward-publish|forward-retag");

    const toolchain = publishSteps.find((step: { name?: string }) => step.name === "Select fixed runner toolchain");
    const download = publishSteps.find((step: { name?: string }) => step.name === "Download and validate current-run candidate");
    const writeGuard = publishSteps.find((step: { name?: string }) => step.name === "Write fixed registry guard");
    const guard = publishSteps.find((step: { id?: string }) => step.id === "registry-guard");
    const publish = publishSteps.find((step: { name?: string }) => step.name === "Publish exact tarball with Trusted Publishing");
    const convergence = publishSteps.find((step: { name?: string }) => step.name === "Verify registry convergence without OIDC");
    expect(publishSteps.every((step: { uses?: string }) => !step.uses)).toBe(true);
    expect(toolchain.run).toContain("/opt/hostedtoolcache/node/24.*/x64/bin");
    expect(toolchain.run).toContain("Exactly one preinstalled Node.js 24 toolchain is required");
    expect(toolchain.run).toContain("npm 11.5.1 or later is required");
    expect(download.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      API_URL_VALUE: "${{ github.api_url }}",
      REPOSITORY_VALUE: "${{ github.repository }}",
      RUN_ID_VALUE: "${{ github.run_id }}",
      RUNNER_TEMP_VALUE: "${{ runner.temp }}",
      EXPECTED_VERSION_VALUE: "${{ needs.build-development.outputs.version }}",
      EXPECTED_GIT_REF_VALUE: "${{ github.sha }}",
      EXPECTED_OUTCOME_VALUE: "${{ needs.build-development.outputs.outcome }}",
    });
    for (const step of publishSteps) {
      expect(step.run ?? "").not.toContain("${{");
      const syntax = spawnSync("bash", ["--noprofile", "--norc", "-n"], {
        encoding: "utf8",
        input: step.run ?? "",
      });
      expect(syntax.status, `${step.name}: ${syntax.stderr}`).toBe(0);
    }
    const dynamicEnvironmentValues = new Set(publishSteps.flatMap((step: { env?: Record<string, string> }) => Object.values(step.env ?? {})));
    expect([...dynamicEnvironmentValues]).toEqual(
      expect.arrayContaining([
        "${{ github.token }}",
        "${{ github.api_url }}",
        "${{ github.repository }}",
        "${{ github.run_id }}",
        "${{ runner.temp }}",
        "${{ needs.build-development.outputs.version }}",
        "${{ github.sha }}",
        "${{ needs.build-development.outputs.outcome }}",
        "${{ steps.registry-guard.outputs.outcome }}",
      ]),
    );
    expect(download.run).toContain("/actions/runs/{run_id}/artifacts?name={artifact_name}&per_page=100");
    expect(download.run).toContain('document.get("total_count") != 1');
    expect(download.run).toContain('artifact.get("workflow_run", {}).get("id") != int(run_id)');
    expect(download.run).toContain('artifact.get("archive_download_url") != expected_download');
    expect(download.run).toContain('artifact["size_in_bytes"] > 26_214_400');
    expect(download.run).toContain("artifact archive entries do not match the candidate contract");
    expect(download.run).toContain('".." in path.parts');
    expect(download.run).toContain("mode & 0o111");
    expect(download.run).toContain("artifact entry exceeds its size bound");
    const downloaderSource = download.run.match(/<<'PYTHON'\n([\s\S]*?)\n\s*PYTHON/)?.[1];
    expect(downloaderSource).toBeTruthy();
    const downloaderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-workflow-download-test-"));
    try {
      const downloaderFile = path.join(downloaderRoot, "download.py");
      fs.writeFileSync(downloaderFile, downloaderSource!);
      const syntax = spawnSync("python3", ["-m", "py_compile", downloaderFile], {
        encoding: "utf8",
      });
      expect(syntax.status, syntax.stderr).toBe(0);
    } finally {
      fs.rmSync(downloaderRoot, { recursive: true, force: true });
    }
    expect(writeGuard.run).toContain("AGENTERA_GUARD");
    expect(writeGuard.run).toContain('spawnSync("tar", ["-xOzf", tarball, "package/package.json"]');
    expect(writeGuard.run).toContain("downloaded artifact content must be regular and non-executable");
    expect(writeGuard.run).toContain("classification.outcome !== expectedOutcome");
    expect(writeGuard.run).toContain("tarball integrity does not match the classification");
    expect(writeGuard.run).toContain("manifest.agentera?.gitRef !== expectedGitRef");
    expect(writeGuard.run).toContain("tarball publishConfig conflicts with fixed publication policy");
    expect(writeGuard.run).toContain("`--registry=${registry}`");
    expect(writeGuard.run).toContain("npm Trusted Publishing requires npm 11.5.1 or later");
    expect(writeGuard.run).toContain('if (outcome === "forward-retag")');
    expect(writeGuard.run).toContain("registry converged as");
    expect(writeGuard.run).not.toMatch(/from ["']\.\//);
    expect(writeGuard.run).not.toContain("dist/bin/agentera");
    const guardSource = writeGuard.run.match(/<<'AGENTERA_GUARD'\n([\s\S]*?)\n\s*AGENTERA_GUARD/)?.[1];
    expect(guardSource).toBeTruthy();
    const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-workflow-guard-test-"));
    try {
      const guardFile = path.join(guardRoot, "guard.mjs");
      fs.writeFileSync(guardFile, guardSource!);
      const syntax = spawnSync(process.execPath, ["--check", guardFile], { encoding: "utf8" });
      expect(syntax.status, syntax.stderr).toBe(0);
    } finally {
      fs.rmSync(guardRoot, { recursive: true, force: true });
    }

    for (const step of [guard, convergence]) {
      expect(step.run).toContain("env -i");
      expect(step.run).toContain("-u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u GITHUB_ACTIONS");
      expect(step.run).toContain("-u NPM_TOKEN -u NODE_AUTH_TOKEN -u NPM_CONFIG_USERCONFIG");
      expect(step.run).not.toContain('ACTIONS_ID_TOKEN_REQUEST_URL="${ACTIONS_ID_TOKEN_REQUEST_URL}"');
      expect(step.run).not.toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN="${ACTIONS_ID_TOKEN_REQUEST_TOKEN}"');
      expect(step.run).not.toContain('GITHUB_ACTIONS="${GITHUB_ACTIONS}"');
    }
    expect(guard.run).toContain("GUARD_MODE=pre");
    expect(convergence.run).toContain("GUARD_MODE=post");
    expect(publish.if).toBe("steps.registry-guard.outputs.outcome == 'forward-publish'");
    expect(convergence.if).toBe("steps.registry-guard.outputs.outcome == 'forward-publish'");
    expect(publish.run).toContain("env -i \\");
    expect(publish.run).toContain('GITHUB_ACTIONS="${GITHUB_ACTIONS}"');
    expect(publish.run).toContain('ACTIONS_ID_TOKEN_REQUEST_URL="${ACTIONS_ID_TOKEN_REQUEST_URL}"');
    expect(publish.run).toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN="${ACTIONS_ID_TOKEN_REQUEST_TOKEN}"');
    expect(publish.run).toContain("NPM_CONFIG_USERCONFIG=");
    expect(publish.run).toContain('npm publish "${tarball}" --access public --tag next --ignore-scripts --registry=https://registry.npmjs.org/');
    expect(publish.run).not.toContain("node ");
    expect(qualificationYaml.match(/ACTIONS_ID_TOKEN_REQUEST_URL="\$\{ACTIONS_ID_TOKEN_REQUEST_URL\}"/g)).toHaveLength(1);
    expect(qualificationYaml.match(/ACTIONS_ID_TOKEN_REQUEST_TOKEN="\$\{ACTIONS_ID_TOKEN_REQUEST_TOKEN\}"/g)).toHaveLength(1);
    expect(qualificationYaml.match(/GITHUB_ACTIONS="\$\{GITHUB_ACTIONS\}"/g)).toHaveLength(1);
    expect(qualificationYaml).not.toContain("NPM_TOKEN:");
    expect(qualificationYaml).not.toContain("environment: npm-publish");
  });

  it("constructs complete npm 11.17 GitHub provenance from the bounded publish environment", () => {
    const statement = npm1117GithubProvenance([{ name: "pkg:npm/agentera@3.0.0-dev.93", digest: { sha512: "digest" } }], githubProvenance);
    expect(statement.predicate).toEqual({
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: "refs/heads/feat/v3",
            repository: "https://github.com/jgabor/agentera",
            path: ".github/workflows/publish.yml",
          },
        },
        internalParameters: {
          github: {
            event_name: "push",
            repository_id: "123456789",
            repository_owner_id: "987654321",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/jgabor/agentera@refs/heads/feat/v3",
            digest: { gitCommit: "a".repeat(40) },
          },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: "https://github.com/jgabor/agentera/actions/runs/33746838768/attempts/1",
        },
      },
    });
  });

  it("rejects every missing or malformed provenance binding before npm publish", () => {
    const workflow = YAML.parse(qualificationYaml);
    const publish = workflow.jobs["publish-development"].steps.find((step: { name?: string }) => step.name === "Publish exact tarball with Trusted Publishing");
    const validation = publish.run.slice(0, publish.run.indexOf("shopt -s nullglob"));
    const environment = {
      RUNNER_TEMP_VALUE: "/tmp/runner",
      EXPECTED_VERSION_VALUE: "3.0.0-dev.93",
      EXPECTED_GIT_REF_VALUE: githubProvenance.GITHUB_SHA,
      GUARD_OUTCOME_VALUE: "forward-publish",
      GITHUB_ACTIONS: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/request?id=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc.token-value",
      ...Object.fromEntries(Object.entries(githubProvenance).map(([key, value]) => [`${key}_VALUE`, value])),
    };
    const malformed = {
      GITHUB_WORKFLOW_REF_VALUE: "jgabor/agentera/.github/workflows/other.yml@refs/heads/feat/v3",
      GITHUB_REPOSITORY_VALUE: "other/repository",
      GITHUB_SERVER_URL_VALUE: "https://example.com",
      GITHUB_REF_VALUE: "refs/pull/1/merge",
      GITHUB_SHA_VALUE: "b".repeat(40),
      GITHUB_EVENT_NAME_VALUE: "pull_request",
      GITHUB_REPOSITORY_ID_VALUE: "0",
      GITHUB_REPOSITORY_OWNER_ID_VALUE: "owner",
      RUNNER_ENVIRONMENT_VALUE: "self-hosted",
      GITHUB_RUN_ID_VALUE: "0",
      GITHUB_RUN_ATTEMPT_VALUE: "0",
    };
    for (const [key, value] of Object.entries(malformed)) {
      for (const replacement of ["", value]) {
        const result = spawnSync("bash", ["--noprofile", "--norc"], {
          encoding: "utf8",
          input: validation,
          env: { ...environment, [key]: replacement },
        });
        expect(result.status, `${key}=${JSON.stringify(replacement)}`).not.toBe(0);
        expect(result.stderr).toContain("Invalid publish binding");
      }
    }
  });

  it("passes only the reviewed OIDC, npm, and provenance variables to the publish child", () => {
    const workflow = YAML.parse(qualificationYaml);
    const publish = workflow.jobs["publish-development"].steps.find((step: { name?: string }) => step.name === "Publish exact tarball with Trusted Publishing");
    const child = publish.run.slice(publish.run.indexOf("env -i \\"), publish.run.indexOf("npm publish"));
    const passed = [...child.matchAll(/\b([A-Z][A-Z0-9_]*)=/g)].map((match) => match[1]);
    expect(passed).toEqual(["PATH", "HOME", "GITHUB_ACTIONS", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", ...Object.keys(githubProvenance), "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG", "NPM_CONFIG_CACHE", "NPM_CONFIG_AUDIT", "NPM_CONFIG_FUND", "NPM_CONFIG_IGNORE_SCRIPTS"]);
    for (const prohibited of ["GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_EVENT_PATH", "GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH", "GITHUB_STEP_SUMMARY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_OPTIONS", "npm_config_registry", "npm_config_userconfig"]) {
      expect(passed, prohibited).not.toContain(prohibited);
      const isolated = spawnSync("env", ["-i", ...passed.map((key) => `${key}=fixture`), "/usr/bin/env"], {
        encoding: "utf8",
        env: { ...process.env, [prohibited]: "injected-secret" },
      });
      expect(isolated.status).toBe(0);
      expect(isolated.stdout).not.toContain(`${prohibited}=`);
    }
    expect(passed).not.toContain("GITHUB_WORKFLOW_SHA");
  });

  it("rejects repository-controlled commands added to the OIDC job", () => {
    const workflow = YAML.parse(qualificationYaml);
    for (const command of ["node scripts/evil.mjs", "node packages/cli/scripts/evil.mjs", "node ./scripts/evil.mjs", "node /home/runner/work/agentera/agentera/scripts/evil.mjs", "source scripts/evil.sh", ". ./scripts/evil.sh", "bash scripts/evil.sh"]) {
      const mutated = structuredClone(workflow);
      mutated.jobs["publish-development"].steps[0].run += `\n${command}`;
      expect(() => requireReviewedOidcPublicationSteps(mutated), command).toThrow("OIDC publication steps do not match the fixed reviewed step set");
    }
  });

  it("rejects an added arbitrary run step in the OIDC job", () => {
    const workflow = YAML.parse(qualificationYaml);
    workflow.jobs["publish-development"].steps.push({
      name: "Arbitrary command",
      run: "printf 'not reviewed\\n'",
    });
    expect(() => requireReviewedOidcPublicationSteps(workflow)).toThrow("OIDC publication steps do not match the fixed reviewed step set");
  });

  it("fails routing closed for missing, malformed, main, pointer, or duplicated ref authority", () => {
    const workflow = YAML.parse(qualificationYaml);
    const run = workflow.jobs["route-development"].steps.find((step: { id?: string }) => step.id === "route").run;
    const source = run.match(/<<'NODE'\n([\s\S]*?)\n\s*NODE/)?.[1];
    expect(source).toBeTruthy();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-route-test-"));
    try {
      const authorityPath = path.join(root, "authority.json");
      const outputPath = path.join(root, "output");
      const execute = (document: string) => {
        fs.rmSync(outputPath, { force: true });
        fs.writeFileSync(authorityPath, document);
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", source!], {
          encoding: "utf8",
          env: {
            ...process.env,
            AUTHORITY_PATH: authorityPath,
            GITHUB_OUTPUT: outputPath,
            GITHUB_REF: publicationContract.ci.developmentPush.ref,
            GITHUB_REPOSITORY: "jgabor/agentera",
          },
        });
        return {
          result,
          output: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "",
        };
      };
      const expectClosed = (document: string) => {
        const execution = execute(document);
        expect(execution.result.status, execution.result.stderr).not.toBe(0);
        expect(execution.output).toBe("");
      };
      const selectedRef = publicationContract.ci.developmentPush.ref;
      const valid = execute(JSON.stringify(publicationContract));
      expect(valid.result.status, valid.result.stderr).toBe(0);
      expect(valid.output).toBe(`selected=true\nref=${selectedRef}\n`);
      for (const broken of [
        (copy: any) => {
          delete copy.ci.developmentPush.ref;
        },
        (copy: any) => {
          copy.ci.developmentPush.ref = "development/topic";
        },
        (copy: any) => {
          copy.ci.developmentPush.ref = "refs/heads/main";
        },
        (copy: any) => {
          copy.ci.developmentPublicationWorkflow.refAuthority = "other.ref";
        },
      ]) {
        const copy = structuredClone(publicationContract);
        broken(copy);
        expectClosed(JSON.stringify(copy));
      }

      const escapedRef = selectedRef.replaceAll("/", "\\/");
      const escapedDuplicate = JSON.stringify(publicationContract).replace(`"ref":"${selectedRef}"`, `"ref":"${selectedRef}","escapedDuplicate":"${escapedRef}"`);
      expect(escapedDuplicate.split(JSON.stringify(selectedRef))).toHaveLength(2);
      expect(JSON.parse(escapedDuplicate).ci.developmentPush.escapedDuplicate).toBe(selectedRef);
      expectClosed(escapedDuplicate);

      const duplicateLocation = structuredClone(publicationContract);
      duplicateLocation.trust.duplicateDevelopmentRef = selectedRef;
      expectClosed(JSON.stringify(duplicateLocation));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("downloads the exact current-run artifact without forwarding GitHub credentials", async () => {
    const workflow = YAML.parse(qualificationYaml);
    const step = workflow.jobs["publish-development"].steps.find((candidate: { name?: string }) => candidate.name === "Download and validate current-run candidate");
    const source = step.run.match(/<<'PYTHON'\n([\s\S]*?)\n\s*PYTHON/)?.[1];
    expect(source).toBeTruthy();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-artifact-api-test-"));
    const zip = path.join(root, "candidate.zip");
    const makeZip = (entry = "agentera-3.0.0-dev.90.tgz") => {
      const result = spawnSync(
        "python3",
        [
          "-c",
          ["import stat, sys, zipfile", "with zipfile.ZipFile(sys.argv[1], 'w') as z:", " for name, data in [(sys.argv[2], b'tarball'), ('publication-classification.json', b'{}')]:", "  entry = zipfile.ZipInfo(name); entry.external_attr = (stat.S_IFREG | 0o600) << 16", "  z.writestr(entry, data)"].join("\n"),
          zip,
          entry,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      return fs.readFileSync(zip);
    };
    let archive = makeZip();
    let response: unknown;
    let apiStatus = 302;
    let apiLocations: string | string[] | undefined;
    let storageStatus = 200;
    const apiRequests: http.IncomingMessage[] = [];
    const storageRequests: http.IncomingMessage[] = [];
    const apiServer = http.createServer((request, reply) => {
      apiRequests.push(request);
      if (request.url?.endsWith("/zip")) {
        reply.writeHead(apiStatus, apiLocations === undefined ? {} : { location: apiLocations }).end(apiStatus === 200 ? archive : undefined);
      } else {
        reply.writeHead(200, { "content-type": "application/json" }).end(typeof response === "string" ? response : JSON.stringify(response));
      }
    });
    const storageServer = http.createServer((request, reply) => {
      storageRequests.push(request);
      reply.writeHead(storageStatus, storageStatus === 302 ? { location: "https://untrusted.example/next?sig=private-redirect" } : { "content-type": "application/zip" }).end(storageStatus === 200 ? archive : undefined);
    });
    await Promise.all([new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve)), new Promise<void>((resolve) => storageServer.listen(0, "127.0.0.1", resolve))]);
    const apiAddress = apiServer.address();
    const storageAddress = storageServer.address();
    if (!apiAddress || typeof apiAddress === "string" || !storageAddress || typeof storageAddress === "string") {
      throw new Error("test servers did not bind");
    }
    const api = `http://127.0.0.1:${apiAddress.port}`;
    const storage = `http://127.0.0.1:${storageAddress.port}`;
    const storageHost = "https://artifact.blob.core.windows.net";
    const exactStorageHost = "https://blob.core.windows.net";
    const run = step.run.replace('"https://api.github.com"', JSON.stringify(api)).replace("urllib.request.Request(location)", `urllib.request.Request(location.replace(${JSON.stringify(storageHost)}, ${JSON.stringify(storage)})` + `.replace(${JSON.stringify(exactStorageHost)}, ${JSON.stringify(storage)}))`);
    const artifact = (overrides: Record<string, unknown> = {}) => ({
      id: 7,
      name: "agentera-development-candidate",
      expired: false,
      workflow_run: { id: 42 },
      archive_download_url: `${api}/repos/jgabor/agentera/actions/artifacts/7/zip`,
      size_in_bytes: archive.length,
      ...overrides,
    });
    const fakeBin = path.join(root, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "npm"), '#!/bin/sh\n: > "$NPM_MUTATION_MARKER"\n', {
      mode: 0o755,
    });
    const execute = (appendPublish = false) =>
      new Promise<{
        code: number | null;
        stderr: string;
        marker: string;
        temp: string;
        apiRequests: http.IncomingMessage[];
        storageRequests: http.IncomingMessage[];
      }>((resolve) => {
        const temp = fs.mkdtempSync(path.join(root, "run-"));
        const marker = path.join(temp, "npm-invoked");
        const apiRequestStart = apiRequests.length;
        const storageRequestStart = storageRequests.length;
        const child = spawn("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${run}${appendPublish ? "\nnpm publish ignored" : ""}`], {
          env: {
            PATH: `${fakeBin}:/usr/bin:/bin`,
            API_URL_VALUE: api,
            REPOSITORY_VALUE: "jgabor/agentera",
            RUN_ID_VALUE: "42",
            GH_TOKEN: "test-token",
            EXPECTED_VERSION_VALUE: "3.0.0-dev.90",
            EXPECTED_GIT_REF_VALUE: "a".repeat(40),
            EXPECTED_OUTCOME_VALUE: "forward-publish",
            RUNNER_TEMP_VALUE: temp,
            NPM_MUTATION_MARKER: marker,
          },
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (code) =>
          resolve({
            code,
            stderr,
            marker,
            temp,
            apiRequests: apiRequests.slice(apiRequestStart),
            storageRequests: storageRequests.slice(storageRequestStart),
          }),
        );
      });
    const signedUrl = `${storageHost}/candidate.zip?sig=private-query`;
    const expectRejected = async () => {
      const result = await execute(true);
      expect(result.code).not.toBe(0);
      expect(fs.existsSync(result.marker)).toBe(false);
      expect(result.stderr).not.toContain("test-token");
      expect(result.stderr).not.toContain("private-query");
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_024);
    };
    try {
      response = { total_count: 1, artifacts: [artifact()] };
      apiLocations = signedUrl;
      for (const validLocation of [signedUrl, `${exactStorageHost}/candidate.zip?sig=private-query`]) {
        apiLocations = validLocation;
        const valid = await execute();
        expect(valid.code, valid.stderr).toBe(0);
        expect(valid.apiRequests).toHaveLength(2);
        expect(valid.apiRequests.every((request) => request.headers.authorization === "Bearer test-token")).toBe(true);
        expect(valid.storageRequests).toHaveLength(1);
        expect(valid.storageRequests[0].headers.authorization).toBeUndefined();
        expect(valid.storageRequests[0].headers.accept).toBeUndefined();
        expect(valid.storageRequests[0].headers["x-github-api-version"]).toBeUndefined();
        expect(Object.keys(valid.storageRequests[0].headers).some((name) => name.startsWith("npm"))).toBe(false);
        expect(fs.existsSync(path.join(valid.temp, "agentera-development", "agentera-3.0.0-dev.90.tgz"))).toBe(true);
      }

      for (const invalid of ["not json", { total_count: 2, artifacts: [artifact(), artifact({ id: 8 })] }, { total_count: 1, artifacts: [artifact({ workflow_run: { id: 41 } })] }, { total_count: 1, artifacts: [artifact({ size_in_bytes: 26_214_401 })] }]) {
        response = invalid;
        await expectRejected();
      }

      response = { total_count: 1, artifacts: [artifact()] };
      for (const location of [
        "http://artifact.blob.core.windows.net/candidate.zip?sig=private-query",
        "https://artifact.blob.core.windows.net.evil.example/candidate.zip?sig=private-query",
        "https://evilblob.core.windows.net/candidate.zip?sig=private-query",
        "https://artifact.blob.core.windows.net:444/candidate.zip?sig=private-query",
        "https://user:pass@artifact.blob.core.windows.net/candidate.zip?sig=private-query",
        "https://artifact.blob.core.windows.net/candidate.zip?sig=private-query#fragment",
      ]) {
        apiStatus = 302;
        apiLocations = location;
        await expectRejected();
      }
      apiStatus = 200;
      apiLocations = signedUrl;
      await expectRejected();
      apiStatus = 302;
      for (const location of [undefined, "", [signedUrl, signedUrl], `${storageHost}/${"x".repeat(2_049)}`]) {
        apiLocations = location;
        await expectRejected();
      }
      apiLocations = signedUrl;
      storageStatus = 302;
      await expectRejected();
      storageStatus = 200;

      archive = makeZip("../agentera-3.0.0-dev.90.tgz");
      response = { total_count: 1, artifacts: [artifact()] };
      apiLocations = signedUrl;
      const unsafeArchive = await execute(true);
      expect(unsafeArchive.stderr).toContain("entries do not match");
      expect(fs.existsSync(unsafeArchive.marker)).toBe(false);
    } finally {
      await Promise.all(
        [apiServer, storageServer].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats hostile job outputs as inert data and stops before npm mutation", () => {
    const workflow = YAML.parse(qualificationYaml);
    const step = workflow.jobs["publish-development"].steps.find((candidate: { name?: string }) => candidate.name === "Download and validate current-run candidate");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-hostile-output-test-"));
    try {
      const fakeBin = path.join(root, "bin");
      fs.mkdirSync(fakeBin);
      const fakeNpm = path.join(fakeBin, "npm");
      fs.writeFileSync(fakeNpm, '#!/bin/sh\n: > "$NPM_MUTATION_MARKER"\n', { mode: 0o755 });
      const cases = [
        ["EXPECTED_VERSION_VALUE", (marker: string) => `3.0.0-dev.90$(touch "${marker}")`],
        ["EXPECTED_VERSION_VALUE", (marker: string) => `3.0.0-dev.90\`touch "${marker}"\``],
        ["EXPECTED_VERSION_VALUE", (marker: string) => `3.0.0-dev.90"; touch "${marker}"; #`],
        ["EXPECTED_OUTCOME_VALUE", (marker: string) => `forward-publish\ntouch "${marker}"`],
        ["EXPECTED_OUTCOME_VALUE", () => "../../../*?[hostile]"],
      ] as const;
      for (const [key, payload] of cases) {
        const marker = path.join(root, `side-effect-${crypto.randomUUID()}`);
        const environment = {
          PATH: `${fakeBin}:/usr/bin:/bin`,
          API_URL_VALUE: "https://api.github.com",
          REPOSITORY_VALUE: "jgabor/agentera",
          RUN_ID_VALUE: "42",
          RUNNER_TEMP_VALUE: path.join(root, `runner-${crypto.randomUUID()}`),
          EXPECTED_VERSION_VALUE: "3.0.0-dev.90",
          EXPECTED_GIT_REF_VALUE: "a".repeat(40),
          EXPECTED_OUTCOME_VALUE: "forward-publish",
          GH_TOKEN: "test-token",
          NPM_MUTATION_MARKER: marker,
          [key]: payload(marker),
        };
        const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${step.run}\nnpm publish ignored`], { encoding: "utf8", env: environment });
        expect(result.status, result.stderr).not.toBe(0);
        expect(fs.existsSync(marker)).toBe(false);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting candidate registry before invoking npm", () => {
    const workflow = YAML.parse(qualificationYaml);
    const step = workflow.jobs["publish-development"].steps.find((candidate: { name?: string }) => candidate.name === "Write fixed registry guard");
    const source = step.run.match(/<<'AGENTERA_GUARD'\n([\s\S]*?)\n\s*AGENTERA_GUARD/)?.[1];
    expect(source).toBeTruthy();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-publish-config-test-"));
    try {
      const artifactDir = path.join(root, "agentera-development");
      const packageDir = path.join(root, "source", "package");
      const fakeBin = path.join(root, "bin");
      fs.mkdirSync(artifactDir);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.mkdirSync(fakeBin);
      const version = "3.0.0-dev.90";
      const gitRef = "a".repeat(40);
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "agentera",
          version,
          agentera: { gitRef },
          publishConfig: { access: "public", tag: "next", registry: "https://evil.example/" },
        }),
      );
      const tarball = path.join(artifactDir, `agentera-${version}.tgz`);
      const packed = spawnSync("tar", ["-czf", tarball, "-C", path.join(root, "source"), "package"], {
        encoding: "utf8",
      });
      expect(packed.status, packed.stderr).toBe(0);
      const integrity = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
      const classification = path.join(artifactDir, "publication-classification.json");
      fs.writeFileSync(
        classification,
        JSON.stringify({
          schemaVersion: "agentera.developmentPublicationClassification.v1",
          outcome: "forward-publish",
          package: "agentera",
          version,
          gitRef,
          integrity,
        }),
      );
      const guard = path.join(root, "guard.mjs");
      fs.writeFileSync(guard, source!);
      const npmMarker = path.join(root, "npm-invoked");
      fs.writeFileSync(path.join(fakeBin, "npm"), `#!/bin/sh\n: > "${npmMarker}"\nexit 97\n`, {
        mode: 0o755,
      });
      const result = spawnSync(process.execPath, [guard], {
        encoding: "utf8",
        env: {
          PATH: `${fakeBin}:/usr/bin:/bin`,
          RUNNER_TEMP: root,
          GUARD_MODE: "pre",
          ARTIFACT_DIR: artifactDir,
          TARBALL: tarball,
          CLASSIFICATION: classification,
          EXPECTED_VERSION: version,
          EXPECTED_GIT_REF: gitRef,
          EXPECTED_OUTCOME: "forward-publish",
          GITHUB_OUTPUT: path.join(root, "github-output"),
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("publishConfig conflicts with fixed publication policy");
      expect(fs.existsSync(npmMarker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reserves the unified workflow for future protected stable publication", () => {
    expect(publicationContract.ci.developmentPublicationWorkflow).toEqual({
      name: "Publish Agentera",
      path: ".github/workflows/publish.yml",
      refAuthority: "ci.developmentPush.ref",
    });
    expect(publicationContract.ci.stablePublicationWorkflow).toMatchObject({
      path: ".github/workflows/publish.yml",
      ref: "refs/heads/main",
      status: "not implemented",
      environment: "npm-publish",
    });
    expect(packagingGuide).toMatch(/no-OIDC stable\s+build job/);
    expect(packagingGuide).toContain("OIDC-enabled publication job");
    expect(packagingGuide).toContain("environment claim remains blank");
  });

  it("keeps package verification benchmarking local after workflow removal", () => {
    expect(rootPackage.scripts["cli:benchmark:qualification"]).toBe("pnpm -C packages/cli run release:benchmark:qualification");
    expect(developmentPackage.scripts["release:benchmark:qualification"]).toContain("release-benchmark.mjs qualification");
    expect(publicationContract.benchmark).not.toHaveProperty("workflow");
  });

  it("binds stable attestation identity to the default-branch publication workflow", () => {
    expect(publicationWorkflowIdentity("stable")).toEqual({
      repository: "jgabor/agentera",
      workflow: "Future protected stable jobs in Publish Agentera",
      workflowPath: ".github/workflows/publish.yml",
      ref: "refs/heads/main",
      branch: "main",
      workflowRef: "jgabor/agentera/.github/workflows/publish.yml@refs/heads/main",
    });
  });

  it("issues stable attestations with the default-branch workflow identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-stable-attestation-test-"));
    try {
      const candidateDirectory = path.join(root, "candidate");
      fs.mkdirSync(candidateDirectory);
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).stdout.trim();
      const receipt = {
        metadataCommit: head,
        sourceCommit: "b".repeat(40),
        receiptSha256: "c".repeat(64),
      };
      const attestation = issueCiAttestation({
        repo: REPO_ROOT,
        candidateDirectory,
        adapterName: "stable",
        candidate: { receipt, artifact: "unused" },
        receipt,
        environment: {
          GITHUB_ACTIONS: "true",
          GITHUB_SHA: head,
          GITHUB_REPOSITORY: "jgabor/agentera",
          GITHUB_WORKFLOW: "Future protected stable jobs in Publish Agentera",
          GITHUB_WORKFLOW_REF: "jgabor/agentera/.github/workflows/publish.yml@refs/heads/main",
          GITHUB_RUN_ID: "123",
        },
      });
      expect(attestation).toMatchObject({
        workflow: "Future protected stable jobs in Publish Agentera",
        workflowRef: "jgabor/agentera/.github/workflows/publish.yml@refs/heads/main",
        metadataCommit: head,
        sourceCommit: "b".repeat(40),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

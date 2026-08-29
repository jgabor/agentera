import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  canonicalJson,
  issueCiAttestation,
  publicationWorkflowIdentity,
  sha256,
} from "../../scripts/release-qualification.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const ciYaml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/verify-changes.yml"), "utf8");
const qualificationYaml = fs.readFileSync(
  path.join(REPO_ROOT, ".github/workflows/publish-next.yml"),
  "utf8",
);
const publicationYaml = fs.readFileSync(
  path.join(REPO_ROOT, ".github/workflows/publish-stable.yml"),
  "utf8",
);
const rootPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const developmentPackage = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"),
);
const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "registry.json"), "utf8"));
const skill = fs.readFileSync(path.join(REPO_ROOT, "skills/agentera/SKILL.md"), "utf8");
const stablePackage = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "packages/cli/shim/package.json"), "utf8"),
);
const publicationContract = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "references/adapters/package-publication.json"), "utf8"),
);
const packagingGuide = fs.readFileSync(
  path.join(REPO_ROOT, "docs/packaging/v3-packaging.md"),
  "utf8",
);
const releaseSkill = fs.readFileSync(
  path.join(REPO_ROOT, ".opencode/skills/agentera-release/SKILL.md"),
  "utf8",
);
const agentsGuide = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");

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

  it("documents bump-before-push and development version recovery", () => {
    expect(packagingGuide).toContain("Before each later `feat/v3` push");
    expect(packagingGuide).toContain("commit a new development version");
    expect(packagingGuide).toContain("exact replay");
    expect(packagingGuide).toContain("already contains different bytes");
    expect(packagingGuide).toContain("do not overwrite or retag it");
    expect(packagingGuide).toContain("obtain fresh push authorization");
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

  it("separates manifest-owned CI construction from receipt-bound manual preparation", () => {
    expect(publicationContract.invariants.preparation).toContain(
      "CI copies the checked-in development package version into an isolated construction tree",
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

  it("keeps canonical development publication instructions on manifest authority", () => {
    for (const [label, instructions] of [
      ["packaging guide", packagingGuide],
      ["release skill", releaseSkill],
      ["agent bootstrap", agentsGuide],
    ] as const) {
      expect(instructions, label).toContain("packages/cli/package.json#version");
      expect(instructions, label).toContain("GITHUB_SHA");
      expect(instructions, label).toContain("queue: max");
      expect(instructions, label).toContain("explicit push authorization");
      expect(instructions, label).toMatch(
        /stable preparation\s+continues to require explicit\s+`--target-version`/,
      );
      expect(instructions, label).not.toMatch(/GITHUB_RUN_NUMBER|run[- ]number|offset 82/i);
    }

    for (const instructions of [packagingGuide, releaseSkill]) {
      const developmentBlocks = [...instructions.matchAll(/```bash\n([\s\S]*?)```/g)]
        .map((match) => match[1])
        .filter((block) => block.includes("cli:ready:dev") || block.includes("cli:prepare:dev"));
      expect(developmentBlocks.length).toBeGreaterThan(0);
      for (const block of developmentBlocks) expect(block).not.toContain("--target-version");
    }

    expect(releaseSkill).toContain([
      "pnpm cli:prepare:stable -- \\",
      "  --target-version X.Y.Z --source-commit COMMIT",
    ].join("\n"));

    expect(changelog).toContain("publishes the checked-in development version");
    expect(changelog).not.toContain("CI-allocated rolling");
  });

  it("rejects the retired development allocation command", () => {
    const result = spawnSync(process.execPath, [
      "packages/cli/scripts/release-qualification.mjs", "allocate", "--run-number", "2",
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("<verify|source|source-check|candidate|approval|attest>");
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
      "validated instead of invoking package verification",
    );
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
    expect(ciWorkflow.jobs["source-migration"].if).toBe(
      "github.ref == 'refs/heads/feat/v3' || github.event_name == 'pull_request'",
    );
  });

  it("classifies without credentials and mutates only a forward development outcome", () => {
    expect(qualificationYaml).toMatch(/push:\n\s+branches:\n\s+- feat\/v3/);
    expect(qualificationYaml).not.toContain("workflow_dispatch");
    expect(qualificationYaml).toContain("queue: max");
    expect(qualificationYaml).not.toContain("cancel-in-progress");
    expect(qualificationYaml).not.toContain("github.run_number");
    expect(qualificationYaml).not.toContain("GITHUB_RUN_NUMBER");
    expect(qualificationYaml).toContain("require('./packages/cli/package.json').version");
    expect(qualificationYaml).toContain("GITHUB_SHA");
    expect(qualificationYaml).toContain("pack-package.mjs");
    expect(qualificationYaml).toContain("publish-development.mjs classify");
    expect(qualificationYaml).toContain("publish-development.mjs mutate");
    expect(qualificationYaml).not.toContain("publish-development.mjs publish");
    expect(qualificationYaml.match(/--package-version \"\$\{\{ steps\.version\.outputs\.value \}\}\"/g)).toHaveLength(2);
    expect(qualificationYaml).toContain("--git-ref \"${GITHUB_SHA}\"");
    expect(qualificationYaml.match(/agentera-\$\{\{ steps\.version\.outputs\.value \}\}\.tgz/g)).toHaveLength(2);
    expect(qualificationYaml).toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(qualificationYaml).toContain("timeout-minutes: 8");
    expect(qualificationYaml.match(/timeout-minutes:/g)).toHaveLength(8);
    const workflow = YAML.parse(qualificationYaml);
    const setupNode = workflow.jobs["publish-development"].steps.find(
      (step: { uses?: string }) => step.uses === "actions/setup-node@v5",
    );
    expect(setupNode.with["package-manager-cache"]).toBe(false);
    const construction = workflow.jobs["publish-development"].steps.find(
      (step: { name?: string }) => step.name === "Build one isolated package tarball",
    );
    expect(construction.run).not.toContain("--package-version");
    const steps = workflow.jobs["publish-development"].steps;
    const credentialSteps = steps.filter((step: { env?: Record<string, string> }) => step.env?.NPM_TOKEN);
    expect(credentialSteps).toHaveLength(1);
    expect(credentialSteps[0].name).toBe("Mutate npm only for a forward outcome");
    expect(credentialSteps[0].if).toBe(
      "steps.classification.outputs.outcome == 'forward-publish' || steps.classification.outputs.outcome == 'forward-retag'",
    );
    const classification = steps.find((step: { id?: string }) => step.id === "classification");
    expect(classification).not.toHaveProperty("env.NPM_TOKEN");
    expect(classification.run).toContain('env -i PATH="${PATH}" node packages/cli/scripts/publish-development.mjs classify');
    expect(classification.run).toContain("publication-classification.json");
    expect(classification.run).toContain("exact-replay|superseded-replay|forward-publish|forward-retag");
    const mutation = credentialSteps[0];
    expect(mutation.run).toContain("publication-classification.json");
    expect(mutation.run).toContain("umask 077");
    expect(mutation.run).toContain("_authToken=%s");
    expect(mutation.run).toContain("trap 'rm -f");
    expect(mutation.run).toContain("unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG");
    expect(mutation.run).toContain('env -i PATH="${PATH}" node packages/cli/scripts/publish-development.mjs mutate');
    expect(mutation.run).toContain('--auth-config "${auth_config}"');
    expect(mutation.run.indexOf("unset NPM_TOKEN")).toBeLessThan(mutation.run.indexOf("env -i"));
    expect(publicationYaml).toContain("workflow_dispatch");
    expect(publicationYaml).toContain("candidate --adapter stable");
    for (const excluded of [
      "cli:qualify:source", "cli:qualify:dev", "release-qualification", "release-benchmark",
      "upload-artifact", "download-artifact", "receipt", "attestation", "performance", "capacity", "migration",
    ]) expect(qualificationYaml).not.toContain(excluded);
  });

  it("prepares and revalidates one stable candidate before protected publication", () => {
    expect(publicationYaml).not.toContain("inputs:");
    expect(publicationYaml).toContain("ADAPTER: stable");
    expect(publicationYaml).toContain("publication --adapter stable");
    expect(publicationYaml).toContain("environment: npm-publish");
    expect(publicationYaml).toContain("needs: prepare");
    expect(publicationYaml).toContain("github.ref != 'refs/heads/main'");
    expect(publicationYaml).toContain("actions/upload-artifact@v4");
    expect(publicationYaml).toContain("actions/download-artifact@v4");
    expect(publicationYaml).toContain("packages/cli/scripts/release-qualification.mjs");
    expect(publicationContract.ci.developmentPublicationWorkflow).toEqual({
      name: "Publish development package (@next)",
      path: ".github/workflows/publish-next.yml",
      ref: "refs/heads/feat/v3",
    });
    expect(publicationContract.ci.stablePublicationWorkflow).toEqual({
      name: "Publish stable package (@latest)",
      path: ".github/workflows/publish-stable.yml",
      ref: "refs/heads/main",
    });
    expect(publicationYaml).toContain("validateCandidateReceipt");
    expect(publicationYaml).not.toContain("actions/github-script");
    expect(publicationYaml).not.toContain("run-id:");
    expect(publicationYaml.match(/release-candidate-\$\{\{ github\.run_id \}\}/g)).toHaveLength(2);
    expect(publicationYaml).toContain("release-qualification.mjs approval");
    expect(publicationYaml.match(/--source-run-id "\$\{GITHUB_RUN_ID\}"/g)).toHaveLength(2);
    expect(publicationYaml).toContain("release-benchmark.mjs publication");
    expect(publicationYaml).toContain("coordinator enforces <120s");
    expect(publicationYaml).toContain("timeout-minutes: 3");
    expect(publicationYaml).toContain("qualified-publication-receipt.json");
    expect(publicationYaml).toContain('chmod 0444 "${RUNNER_TEMP}"/agentera-package/*.tgz');
    expect(publicationYaml.indexOf("Verify committed source"))
      .toBeLessThan(publicationYaml.indexOf("Verify stable package"));
    expect(publicationYaml.indexOf("Attest stable package"))
      .toBeLessThan(publicationYaml.indexOf("Upload stable release candidate"));
    expect(publicationYaml.indexOf("Upload stable release candidate"))
      .toBeLessThan(publicationYaml.indexOf("environment: npm-publish"));
    expect(publicationYaml.indexOf("Recheck package receipt"))
      .toBeLessThan(publicationYaml.indexOf("NPM_TOKEN"));
    expect(publicationYaml.indexOf("Restore package file mode"))
      .toBeLessThan(publicationYaml.indexOf("Recheck package receipt"));
    expect(publicationYaml.indexOf("release-qualification.mjs approval"))
      .toBeLessThan(publicationYaml.indexOf("release-benchmark.mjs publication"));
    expect(publicationYaml).not.toContain("release-benchmark.mjs qualification --adapter");
    expect(publicationYaml.match(/node-version-file: \.node-version/g)).toHaveLength(2);
    expect(publicationYaml).toContain("COREPACK_HOME: ${{ runner.temp }}/corepack");
  });

  it("keeps package verification benchmarking local after workflow removal", () => {
    expect(rootPackage.scripts["cli:benchmark:qualification"]).toBe(
      "pnpm -C packages/cli run release:benchmark:qualification",
    );
    expect(developmentPackage.scripts["release:benchmark:qualification"])
      .toContain("release-benchmark.mjs qualification");
    expect(publicationContract.benchmark).not.toHaveProperty("workflow");
  });

  it("binds stable attestation identity to the default-branch publication workflow", () => {
    expect(publicationWorkflowIdentity("stable")).toEqual({
      repository: "jgabor/agentera",
      workflow: "Publish stable package (@latest)",
      workflowPath: ".github/workflows/publish-stable.yml",
      ref: "refs/heads/main",
      branch: "main",
      workflowRef: "jgabor/agentera/.github/workflows/publish-stable.yml@refs/heads/main",
    });
  });

  it("issues stable attestations with the default-branch workflow identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-stable-attestation-test-"));
    try {
      const candidateDirectory = path.join(root, "candidate");
      fs.mkdirSync(candidateDirectory);
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
      const receipt = { metadataCommit: head, sourceCommit: "b".repeat(40), receiptSha256: "c".repeat(64) };
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
          GITHUB_WORKFLOW: "Publish stable package (@latest)",
          GITHUB_WORKFLOW_REF: "jgabor/agentera/.github/workflows/publish-stable.yml@refs/heads/main",
          GITHUB_RUN_ID: "123",
        },
      });
      expect(attestation).toMatchObject({
        workflow: "Publish stable package (@latest)",
        workflowRef: "jgabor/agentera/.github/workflows/publish-stable.yml@refs/heads/main",
        metadataCommit: head,
        sourceCommit: "b".repeat(40),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

});

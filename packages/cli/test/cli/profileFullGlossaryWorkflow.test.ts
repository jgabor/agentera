import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { expect, it } from "vitest";

import {
  invokeInProcess,
  runServedProfileFullWorkflow,
} from "../helpers/profileFullGlossaryWorkflow.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

it("drives Profile Full behavior from a transient local executable's served instruction order", { timeout: 120_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-full-source-workflow-"));
  try {
    const buildRoot = path.join(root, "local-build");
    const build = spawnSync(
      process.execPath,
      [path.join(PACKAGE_ROOT, "scripts/build-package.mjs"), "--output-root", buildRoot],
      { cwd: PACKAGE_ROOT, encoding: "utf8" },
    );
    expect(build.status, build.stderr || build.stdout).toBe(0);
    fs.symlinkSync(path.join(PACKAGE_ROOT, "node_modules"), path.join(buildRoot, "node_modules"), "dir");
    const executable = path.join(buildRoot, "dist/bin/agentera.js");
    expect(fs.statSync(executable).isFile()).toBe(true);

    const workflowRoot = path.join(root, "workflow");
    const observation = runServedProfileFullWorkflow(executable, workflowRoot);
    expect(observation).toMatchObject({
      initialBaseHasNoGlossary: true,
      preservedOwnedSection: true,
      malformedCasesRejected: 4,
      missingGenerationPreserved: true,
      miningFailurePreserved: true,
      noCandidatesPreserved: true,
      degradedGenerationPreserved: true,
      perCandidateGetFailurePreserved: true,
      perCandidateDecisionFailurePreserved: true,
      publisherFailurePreserved: true,
      mixedCandidateReads: 1,
      mixedExplicitPublications: 1,
      mixedReviewsQueued: 2,
      mixedAbstentions: 1,
      fallbackUsedDurableQueue: true,
      replayed: true,
      projectGlossaryTrapSurvived: true,
    });
    expect(observation.questionPrompts).toBe(observation.questionPromptMaximum);

    const authorityPath = path.join(
      buildRoot,
      "bundle/references/artifacts/glossary-entry-contract.yaml",
    );
    const authority = YAML.parse(fs.readFileSync(authorityPath, "utf8")) as Record<string, any>;
    authority.personal_mining_authority.profile_full.existing_generation.list_limit = 0;
    fs.writeFileSync(authorityPath, YAML.stringify(authority), "utf8");
    const isolationRoot = path.join(root, "profile-authority-isolation");
    fs.mkdirSync(path.join(isolationRoot, ".agentera"), { recursive: true });
    fs.writeFileSync(
      path.join(isolationRoot, ".agentera", "state-mode.yaml"),
      "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
    );
    const schema = invokeInProcess(["schema", "--format", "json"], isolationRoot);
    expect(schema.status, schema.stderr || schema.stdout).toBe(0);
    const buildPrime = invokeInProcess(
      ["prime", "--context", "build", "--format", "json"],
      isolationRoot,
    );
    expect(buildPrime.status, buildPrime.stderr || buildPrime.stdout).toBe(0);
    expect(JSON.parse(buildPrime.stdout)).toMatchObject({ capability_context: { capability: "build" } });
    const malformed = spawnSync(
      process.execPath,
      [executable, "prime", "--context", "profile", "--format", "json"],
      { cwd: isolationRoot, encoding: "utf8" },
    );
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr + malformed.stdout).toContain(
      "personal glossary Profile Full contract is unavailable",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

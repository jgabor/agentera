#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encode } from "gpt-tokenizer/model/gpt-5";
import YAML from "yaml";

export const GPT5_TOKENIZER = Object.freeze({
  package: "gpt-tokenizer",
  version: "4.0.0",
  model: "gpt-5",
  implementation: "gpt-tokenizer/model/gpt-5#encode",
});

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, "../../..");

function budgetAuthority(repoRoot) {
  const manifest = YAML.parse(fs.readFileSync(path.join(repoRoot, "scripts/json_output_surface_manifest.yaml"), "utf8"));
  const surface = manifest.surfaces.find(({ id }) => id === "prime-briefing");
  const packageManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages/cli/package.json"), "utf8"));
  if (
    JSON.stringify(manifest.measurement?.tokens) !==
    JSON.stringify({
      ...GPT5_TOKENIZER,
      count: "encode(stdout).length",
    })
  ) {
    throw new Error("prime token measurement metadata does not match the pinned GPT-5 tokenizer");
  }
  if (packageManifest.devDependencies?.[GPT5_TOKENIZER.package] !== GPT5_TOKENIZER.version) {
    throw new Error("prime token measurement dependency is not pinned exactly");
  }
  if (!surface || surface.enforcement_tier !== "enforce") {
    throw new Error("prime-briefing is not an enforced output surface");
  }
  return {
    bytes: surface.byte_budget,
    gpt5_tokens: surface.token_budget,
  };
}

export function measurePrimeOutput(stdout, budget) {
  const measurement = {
    bytes: Buffer.byteLength(stdout, "utf8"),
    gpt5_tokens: encode(stdout).length,
  };
  const violations = [];
  if (measurement.bytes > budget.bytes) violations.push("bytes");
  if (measurement.gpt5_tokens > budget.gpt5_tokens) violations.push("gpt5_tokens");
  return { measurement, violations };
}

export function createPrimeBudgetFixture(repoRoot, temporaryRoot) {
  const appHome = path.join(temporaryRoot, "app");
  const home = path.join(temporaryRoot, "home");
  const profile = path.join(temporaryRoot, "profile");
  const project = path.join(temporaryRoot, "project");
  for (const directory of [appHome, home, profile, project]) fs.mkdirSync(directory, { recursive: true });
  fs.cpSync(path.join(repoRoot, "skills"), path.join(appHome, "skills"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "references"), path.join(appHome, "references"), { recursive: true });
  const registry = fs.readFileSync(path.join(repoRoot, "registry.json"), "utf8");
  fs.writeFileSync(path.join(appHome, "registry.json"), registry);
  fs.writeFileSync(path.join(appHome, ".agentera-npx-bundle.json"), `${JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: JSON.parse(registry).skills[0].version }, null, 2)}\n`);
  const writeEntity = (artifact, boundary, id, record) => {
    const directory = path.join(project, ".agentera/entities", artifact, boundary);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}.yaml`), `${JSON.stringify({ id, artifact, record }, null, 2)}\n`);
  };
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  writeEntity("plan", "plan", "abcdefghij", {
    header: { level: "full", created: "2026-09-04", status: "open", title: "Prime fixture" },
    what: "Bound Prime routing.",
    why: "Avoid live state.",
    scope: { included: ["budget"], excluded: ["live state"] },
  });
  writeEntity("plan", "plan_task", "bcdefghijk", {
    plan: "abcdefghij",
    name: "Verify Prime",
    status: "pending",
    depends_on: [],
    acceptance: ["Required routes remain within budget."],
  });
  writeEntity("progress", "progress_cycle", "cdefghijkl", {
    timestamp: "2026-09-04 12:00",
    type: "test",
    phase: "build",
    what: "Seed Prime evidence.",
    next: "Verify Prime.",
    publication_order: 1,
  });
  return { appHome, home, profile, project };
}

export function runPrimeBudget(repoRoot = defaultRepoRoot) {
  const budget = budgetAuthority(repoRoot);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-prime-budget-"));
  try {
    const { appHome, home, profile, project } = createPrimeBudgetFixture(repoRoot, temporaryRoot);

    const result = spawnSync(process.execPath, [path.join(repoRoot, "packages/cli/dist/bin/agentera.js"), "prime"], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        AGENTERA_HOME: appHome,
        AGENTERA_PROFILE_DIR: profile,
        PROFILERA_PROFILE_DIR: profile,
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: appHome,
      },
    });
    if (result.status !== 0 || result.stderr !== "") {
      throw new Error(`prime measurement failed: exit=${result.status} stderr=${result.stderr.trim()}`);
    }
    const { measurement, violations } = measurePrimeOutput(result.stdout, budget);
    return {
      schemaVersion: "agentera.primeBudgetMeasurement.v1",
      status: violations.length === 0 ? "pass" : "fail",
      surface: "prime-briefing",
      command: "agentera prime",
      fixture: "bounded_state_with_disposable_bundle",
      tokenizer: GPT5_TOKENIZER,
      measurement,
      budget,
      violations,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  try {
    const result = runPrimeBudget();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "pass" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

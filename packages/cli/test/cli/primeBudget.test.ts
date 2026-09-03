import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { GPT5_TOKENIZER, measurePrimeOutput } from "../../scripts/measure-prime-budget.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

describe("prime GPT-5 token budget", () => {
  it("pins the tokenizer package, version, model, and manifest method", () => {
    const packageManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"));
    const manifest = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts/json_output_surface_manifest.yaml"), "utf8"));

    expect(packageManifest.devDependencies[GPT5_TOKENIZER.package]).toBe(GPT5_TOKENIZER.version);
    expect(manifest.measurement.tokens).toEqual({
      ...GPT5_TOKENIZER,
      count: "encode(stdout).length",
    });
  });

  it("keeps the live source prime briefing within its byte and GPT-5 token budgets", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prime-token-budget-"));
    const previousCwd = process.cwd();
    const previous = {
      HOME: process.env.HOME,
      AGENTERA_HOME: process.env.AGENTERA_HOME,
      AGENTERA_PROFILE_DIR: process.env.AGENTERA_PROFILE_DIR,
      PROFILERA_PROFILE_DIR: process.env.PROFILERA_PROFILE_DIR,
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT,
    };
    try {
      const home = path.join(temporaryRoot, "home");
      const appHome = path.join(temporaryRoot, "app");
      const profile = path.join(temporaryRoot, "profile");
      for (const directory of [home, appHome, profile]) fs.mkdirSync(directory, { recursive: true });
      process.env.HOME = home;
      process.env.AGENTERA_HOME = appHome;
      process.env.AGENTERA_PROFILE_DIR = profile;
      process.env.PROFILERA_PROFILE_DIR = profile;
      process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
      process.chdir(REPO_ROOT);

      let out = "";
      let err = "";
      const rc = cmdPrime(
        { command: "prime" },
        {
          out: (text) => {
            out += text;
          },
          err: (text) => {
            err += text;
          },
        },
      );
      const manifest = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts/json_output_surface_manifest.yaml"), "utf8"));
      const surface = manifest.surfaces.find(({ id }: { id: string }) => id === "prime-briefing");
      const result = measurePrimeOutput(out, {
        bytes: surface.byte_budget,
        gpt5_tokens: surface.token_budget,
      });

      expect(rc).toBe(0);
      expect(err).toBe("");
      expect(JSON.parse(out)).toMatchObject({ command: "prime" });
      expect(result.violations).toEqual([]);
    } finally {
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

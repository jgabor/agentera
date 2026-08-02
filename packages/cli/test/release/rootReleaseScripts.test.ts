import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseReleaseFlags } from "../../scripts/release-arguments.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

describe("root release script argument forwarding", () => {
  it("accepts each documented pnpm argv shape and rejects extra separators or unknown flags", () => {
    expect(parseReleaseFlags([
      "--adapter", "development", "--", "--candidate-dir", "/external/candidate", "--json",
    ], {
      boolean: ["--json"],
      value: ["--adapter", "--candidate-dir"],
    })).toEqual(new Map([
      ["--adapter", "development"],
      ["--candidate-dir", "/external/candidate"],
      ["--json", true],
    ]));
    expect(() => parseReleaseFlags(["--", "--", "--json"], { boolean: ["--json"] }))
      .toThrow("duplicate pnpm argument separator");
    expect(() => parseReleaseFlags(["--", "--unknown"], { boolean: ["--json"] }))
      .toThrow("unexpected argument '--unknown'");
    expect(() => parseReleaseFlags(["--candidate-dir", "--", "/external"], {
      value: ["--candidate-dir"],
    })).toThrow("--candidate-dir requires a value");
  });

  it("passes the standalone separator and JSON flag through every root release recipe", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-root-release-argv-"));
    const missingCandidate = path.join(temporary, "missing-candidate");
    const missingBenchmark = path.join(temporary, "missing-benchmark");
    const developmentManifest = path.join(REPO_ROOT, "packages/cli/package.json");
    const stableManifest = path.join(REPO_ROOT, "packages/cli/shim/package.json");
    const before = [fs.readFileSync(developmentManifest), fs.readFileSync(stableManifest)];
    const recipes = [
      ["cli:prepare:dev", "--target-version", "invalid", "--source-commit", "not-a-commit", "--json"],
      ["cli:prepare:stable", "--target-version", "invalid", "--source-commit", "not-a-commit", "--json"],
      ["cli:qualify:source", "--candidate-dir", missingCandidate, "--json"],
      ["cli:qualify:dev", "--candidate-dir", missingCandidate, "--json"],
      ["cli:approve:dev", "--candidate-dir", missingCandidate, "--approved-by", "test", "--json"],
      ["cli:benchmark:qualification", "--adapter", "development", "--candidate-root", missingBenchmark, "--json"],
      ["cli:publish:qualified:dev", "--candidate-dir", missingCandidate, "--json"],
      ["cli:publish:qualified:stable", "--candidate-dir", missingCandidate, "--json"],
      ["cli:stage:dev", "--candidate-dir", missingCandidate, "--json"],
      ["cli:promote:dev", "--candidate-dir", missingCandidate, "--json"],
      ["cli:stage:stable", "--candidate-dir", missingCandidate, "--json"],
      ["cli:promote:stable", "--candidate-dir", missingCandidate, "--json"],
    ];

    try {
      for (const [script, ...flags] of recipes) {
        const invocation = spawnSync("pnpm", [script, "--", ...flags], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: Object.fromEntries(Object.entries(process.env).filter(
            ([key]) => !["NPM_TOKEN", "NODE_AUTH_TOKEN"].includes(key),
          )),
          timeout: 15_000,
        });
        const output = `${invocation.stdout}\n${invocation.stderr}`;
        expect(invocation.status, `${script}: ${output}`).not.toBe(0);
        expect(output).not.toContain("-- requires a value");
        expect(output).not.toContain("unexpected argument '--'");
        expect(output).not.toContain("invalid argument '--'");
      }
      expect(fs.readFileSync(developmentManifest)).toEqual(before[0]);
      expect(fs.readFileSync(stableManifest)).toEqual(before[1]);
      expect(fs.existsSync(missingCandidate)).toBe(false);
      expect(fs.existsSync(missingBenchmark)).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 30_000);
});

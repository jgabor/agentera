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

  it("accepts the exact separator and JSON shape forwarded by every root release recipe", () => {
    const rootScripts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).scripts;
    const prepare = {
      boolean: ["--check", "--json", "--verbose"],
      value: ["--target-version", "--source-commit"],
    };
    const qualification = {
      boolean: ["--json", "--verbose"],
      value: ["--candidate-dir", "--adapter"],
    };
    const approval = {
      boolean: qualification.boolean,
      value: [...qualification.value, "--approved-by", "--source-run-id"],
    };
    const qualificationBenchmark = {
      boolean: ["--json"],
      value: ["--adapter", "--candidate-root"],
    };
    const publicationBenchmark = {
      boolean: ["--json"],
      value: ["--adapter", "--candidate-dir", "--source-run-id", "--receipt-file"],
    };
    const transaction = {
      boolean: ["--approve", "--json", "--verbose"],
      value: ["--candidate-dir", "--source-run-id"],
    };
    const recipes = [
      ["cli:prepare:dev", prepare, ["--", "--target-version", "next", "--source-commit", "commit", "--json"]],
      ["cli:prepare:stable", prepare, ["--", "--target-version", "next", "--source-commit", "commit", "--json"]],
      ["cli:qualify:source", qualification, ["--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:qualify:dev", qualification, ["--adapter", "development", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:approve:dev", approval, ["--adapter", "development", "--", "--candidate-dir", "/external/candidate", "--approved-by", "test", "--json"]],
      ["cli:benchmark:qualification", qualificationBenchmark, ["--", "--adapter", "development", "--candidate-root", "/external/benchmark", "--json"]],
      ["cli:publish:qualified:dev", publicationBenchmark, ["--adapter", "development", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:publish:qualified:stable", publicationBenchmark, ["--adapter", "stable", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:stage:dev", transaction, ["--approve", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:promote:dev", transaction, ["--approve", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:stage:stable", transaction, ["--approve", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:promote:stable", transaction, ["--approve", "--", "--candidate-dir", "/external/candidate", "--json"]],
    ] as const;

    for (const [script, options, forwarded] of recipes) {
      expect(rootScripts[script]).toMatch(/^pnpm -C packages\/cli/);
      const flags = parseReleaseFlags([...forwarded], options);
      expect(flags.get("--json"), script).toBe(true);
      expect([...flags.keys()], script).not.toContain("--");
    }
  });

  it("runs one cheap source command with the forwarded separator and JSON output", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-root-release-argv-"));
    const missingCandidate = path.join(temporary, "missing-candidate");
    const developmentManifest = path.join(REPO_ROOT, "packages/cli/package.json");
    const stableManifest = path.join(REPO_ROOT, "packages/cli/shim/package.json");
    const before = [fs.readFileSync(developmentManifest), fs.readFileSync(stableManifest)];

    try {
      const invocation = spawnSync(process.execPath, [
        "packages/cli/scripts/release-qualification.mjs",
        "source",
        "--",
        "--candidate-dir",
        missingCandidate,
        "--json",
      ], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: Object.fromEntries(Object.entries(process.env).filter(
          ([key]) => !["NPM_TOKEN", "NODE_AUTH_TOKEN"].includes(key),
        )),
        timeout: 5_000,
      });
      const output = `${invocation.stdout}\n${invocation.stderr}`;
      const receipts = invocation.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(invocation.error, output).toBeUndefined();
      expect(invocation.status, output).toBe(1);
      expect(receipts).toMatchObject([
        { phase: "source-qualification", outcome: "started" },
        { phase: "source-qualification", outcome: "failed" },
      ]);
      expect(output).not.toContain("-- requires a value");
      expect(output).not.toContain("unexpected argument '--'");
      expect(fs.readFileSync(developmentManifest)).toEqual(before[0]);
      expect(fs.readFileSync(stableManifest)).toEqual(before[1]);
      expect(fs.existsSync(missingCandidate)).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 10_000);
});

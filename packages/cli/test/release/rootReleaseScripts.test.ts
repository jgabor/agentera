import fs from "node:fs";
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
});

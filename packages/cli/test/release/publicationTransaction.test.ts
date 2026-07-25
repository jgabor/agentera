import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PACKAGE_ADAPTERS,
  constructPackage,
  prepareMetadata,
  preflightPublication,
  validateResult,
} from "../../scripts/publication-transaction.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

const manifest = (adapter: "development" | "stable") => ({
  name: "agentera",
  version: adapter === "development" ? "3.0.0-dev.32" : "0.0.2",
  agentera: { gitRef: "abcdef0123456789abcdef0123456789abcdef01" },
});

describe("publication contract", () => {
  it("shares transaction invariants while retaining adapter-specific behavior", () => {
    expect(PACKAGE_ADAPTERS.development).toMatchObject({
      expectedTag: "next",
      preparation: "incrementDevPrerelease",
      construction: "isolatedTypeScriptPackage",
    });
    expect(PACKAGE_ADAPTERS.stable).toMatchObject({
      expectedTag: "latest",
      preparation: "incrementPatch",
      construction: "stableShim",
    });
    expect(PACKAGE_ADAPTERS.development.smoke).toEqual([
      "npx", "-y", "agentera@{version}", "--version",
    ]);
    expect(PACKAGE_ADAPTERS.stable.smoke).toEqual(PACKAGE_ADAPTERS.development.smoke);
  });

  it("runs the canonical stable construction tests successfully", () => {
    const invocation = spawnSync("pnpm", ["-C", "packages/cli/shim", "test"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(invocation.status, invocation.stderr || invocation.stdout).toBe(0);
    expect(invocation.stdout).toContain("test/shim/runBackend.test.ts");
  });

  it("stops stable construction before packing when its canonical tests fail", () => {
    const calls: string[] = [];

    expect(() =>
      constructPackage("stable", PACKAGE_ADAPTERS.stable, "/unused", {
        run: (command: string, args: string[]) => {
          calls.push(`${command} ${args.join(" ")}`);
          throw new Error("canonical stable tests failed");
        },
        npmJson: () => {
          calls.push("npm pack");
          return [];
        },
      }),
    ).toThrow("canonical stable tests failed");
    expect(calls).toEqual(["pnpm test"]);
  });
});

describe.each(["development", "stable"] as const)(
  "%s publication adapter",
  (adapterName) => {
    const adapter = PACKAGE_ADAPTERS[adapterName];

    it("prepares reviewable metadata without a registry operation", () => {
      const result = prepareMetadata(adapterName, manifest(adapterName), HEAD);

      expect(result.manifest.agentera.gitRef).toBe(HEAD);
      expect(result.manifest.version).toBe(
        adapterName === "development" ? "3.0.0-dev.33" : "0.0.3",
      );
      expect(result.receipt).toMatchObject({
        package: adapterName,
        expectedTag: adapter.expectedTag,
        phase: "preparation",
        outcome: "prepared",
      });
    });

    it("rejects malformed preparation metadata without a registry operation", () => {
      expect(() =>
        prepareMetadata(adapterName, { ...manifest(adapterName), version: "bad" }, HEAD),
      ).toThrow(/version/);
    });

    it("passes preflight for authorized, clean, committed metadata", () => {
      expect(
        preflightPublication(adapterName, manifest(adapterName), {
          authorized: true,
          dirty: false,
          metadataCommitted: true,
          gitRefExists: true,
        }),
      ).toMatchObject({ phase: "preflight", outcome: "passed" });
    });

    it("fails preflight before mutation with a working correction", () => {
      const result = preflightPublication(adapterName, manifest(adapterName), {
        authorized: false,
        dirty: true,
        metadataCommitted: false,
        gitRefExists: false,
      });

      expect(result).toMatchObject({ phase: "preflight", outcome: "failed" });
      expect(result.nextAction).toContain("--authorize");
      expect(result.nextAction).toContain("commit");
    });

    it("accepts the complete bounded output shape", () => {
      expect(
        validateResult({
          package: adapterName,
          version: manifest(adapterName).version,
          expectedTag: adapter.expectedTag,
          phase: "smoke",
          outcome: "passed",
          nextAction: "none",
        }),
      ).toEqual([]);
    });

    it("rejects an incomplete bounded output shape", () => {
      expect(
        validateResult({
          package: adapterName,
          version: manifest(adapterName).version,
          expectedTag: adapter.expectedTag,
          phase: "smoke",
          outcome: "failed",
        }),
      ).toContain("nextAction");
    });
  },
);

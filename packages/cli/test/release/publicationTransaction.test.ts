import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PACKAGE_ADAPTERS,
  constructPackage,
  prepareMetadata,
  preflightPublication,
  validateResult,
  withNpmCredentials,
} from "../../scripts/publication-transaction.mjs";
import {
  formatConstruction,
  normalizeConstruction,
  projectConstruction,
} from "../../scripts/package-construction.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

const manifest = (adapter: "development" | "stable") => ({
  name: "agentera",
  version: adapter === "development" ? "3.0.0-dev.32" : "0.0.2",
  agentera: { gitRef: "abcdef0123456789abcdef0123456789abcdef01" },
});

const packedManifest = (version: string) => ({
  id: `agentera@${version}`,
  name: "agentera",
  version,
  size: 1200,
  unpackedSize: 4800,
  shasum: "0123456789abcdef0123456789abcdef01234567",
  integrity: "sha512-package-integrity",
  filename: `agentera-${version}.tgz`,
  files: [
    { path: "package.json", size: 500, mode: 0o644 },
    { path: "dist/bin/agentera.js", size: 4300, mode: 0o755 },
  ],
});

function withTemporaryConstruction<T>(callback: (temporary: string) => T): T {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-construction-test-"));
  try {
    return callback(temporary);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

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
      "npx",
      "-y",
      "agentera@{version}",
      "--version",
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
      constructPackage("stable", PACKAGE_ADAPTERS.stable, manifest("stable"), "/unused", {
        run: (command: string, args: string[]) => {
          calls.push(`${command} ${args.join(" ")}`);
          throw new Error("canonical stable tests failed");
        },
        npmPack: () => {
          calls.push("npm pack");
          return { manifest: [], warnings: [] };
        },
      }),
    ).toThrow("canonical stable tests failed");
    expect(calls).toEqual(["pnpm test"]);
  });
});

describe.each(["development", "stable"] as const)("%s publication adapter", (adapterName) => {
  const adapter = PACKAGE_ADAPTERS[adapterName];

  it("prepares reviewable metadata without a registry operation", () => {
    const result = prepareMetadata(adapterName, manifest(adapterName), HEAD);

    expect(result.manifest.agentera.gitRef).toBe(HEAD);
    expect(result.manifest.version).toBe(adapterName === "development" ? "3.0.0-dev.33" : "0.0.3");
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

  it("constructs the exact governed package manifest and artifact", () => {
    const expected = manifest(adapterName);
    const packed = packedManifest(expected.version);
    const calls: string[] = [];
    const result = withTemporaryConstruction((temporary) =>
      constructPackage(adapterName, adapter, expected, temporary, {
        run: (command: string, args: string[]) => {
          calls.push(`${command} ${args.join(" ")}`);
          return adapterName === "development"
            ? JSON.stringify({
                ...packed,
                expectedTag: adapter.expectedTag,
                artifact: path.join(temporary, packed.filename),
                fileCount: packed.files.length,
                packedSize: packed.size,
                warnings: [],
              })
            : "";
        },
        npmPack: () => ({ manifest: [packed], warnings: ["npm warning example"] }),
      }),
    );

    expect(result).toMatchObject({
      name: expected.name,
      version: expected.version,
      fileCount: 2,
      packedSize: 1200,
      unpackedSize: 4800,
      shasum: packed.shasum,
      integrity: packed.integrity,
      expectedTag: adapter.expectedTag,
      artifact: expect.stringMatching(new RegExp(`${packed.filename}$`)),
    });
    expect(result.files).toEqual(packed.files);
    expect(calls[0]).toContain(adapterName === "development" ? "pack-package.mjs" : "pnpm test");
  });

  it("rejects a constructed package whose identity differs from committed metadata", () => {
    const expected = manifest(adapterName);
    const packed = { ...packedManifest(expected.version), name: "not-agentera" };

    expect(() =>
      withTemporaryConstruction((temporary) =>
        constructPackage(adapterName, adapter, expected, temporary, {
          run: () =>
            adapterName === "development"
              ? JSON.stringify({
                  ...packed,
                  expectedTag: adapter.expectedTag,
                  artifact: path.join(temporary, packed.filename),
                  fileCount: packed.files.length,
                  packedSize: packed.size,
                  warnings: [],
                })
              : "",
          npmPack: () => ({ manifest: [packed], warnings: [] }),
        }),
      ),
    ).toThrow(/constructed package identity/);
  });
});

describe("construction output projection", () => {
  const construction = normalizeConstruction(packedManifest("3.0.0-dev.32"), {
    expectedName: "agentera",
    expectedVersion: "3.0.0-dev.32",
    expectedTag: "next",
    artifact: "/tmp/agentera-3.0.0-dev.32.tgz",
    warnings: ["npm warning example"],
  });

  it("keeps default output bounded while JSON and verbose retain every file", () => {
    const bounded = projectConstruction(construction);
    const human = formatConstruction(construction);

    expect(bounded).not.toHaveProperty("files");
    expect(bounded).toMatchObject({ fileCount: 2, packedSize: 1200, unpackedSize: 4800 });
    expect(human).toContain("agentera@3.0.0-dev.32");
    expect(human).toContain("2 files");
    expect(human).toContain("warnings 1");
    expect(formatConstruction(construction, "json")).toContain("dist/bin/agentera.js");
    expect(formatConstruction(construction, "verbose")).toContain("dist/bin/agentera.js");
  });

  it("rejects projection input without a complete npm manifest", () => {
    expect(() =>
      normalizeConstruction(
        { ...packedManifest("3.0.0-dev.32"), integrity: "" },
        {
          expectedName: "agentera",
          expectedVersion: "3.0.0-dev.32",
          expectedTag: "next",
          artifact: "/tmp/package.tgz",
        },
      ),
    ).toThrow(/integrity/);
  });
});

describe("npm credential lifecycle", () => {
  it("scopes credentials to a restricted config and sanitizes inherited npm settings", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-auth-test-"));
    let npmrc = "";
    try {
      withNpmCredentials(
        temporary,
        (environment) => {
          npmrc = environment.NPM_CONFIG_USERCONFIG;
          expect(environment).not.toHaveProperty("NPM_TOKEN");
          expect(environment).not.toHaveProperty("npm_config_recursive");
          expect(environment).not.toHaveProperty("pnpm_config_verify_deps_before_run");
          expect(fs.statSync(npmrc).mode & 0o777).toBe(0o600);
          expect(fs.readFileSync(npmrc, "utf8")).toContain("secret-token");
        },
        {
          PATH: process.env.PATH,
          NPM_TOKEN: "secret-token",
          npm_config_recursive: "true",
          pnpm_config_verify_deps_before_run: "true",
        },
      );
      expect(fs.existsSync(npmrc)).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("removes credentials when the npm child fails and creates none when auth setup fails", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-auth-test-"));
    const npmrc = path.join(temporary, "npmrc");
    try {
      expect(() =>
        withNpmCredentials(
          temporary,
          () => {
            throw new Error("npm publish failed");
          },
          { NPM_TOKEN: "secret-token" },
        ),
      ).toThrow("npm publish failed");
      expect(fs.existsSync(npmrc)).toBe(false);
      expect(() => withNpmCredentials(temporary, () => undefined, {})).toThrow(
        /NPM_TOKEN is absent/,
      );
      expect(fs.existsSync(npmrc)).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});

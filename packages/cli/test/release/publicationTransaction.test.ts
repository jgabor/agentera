import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PACKAGE_ADAPTERS,
  constructPackage,
  executePublication,
  formatPublicationResult,
  normalizeRegistryField,
  normalizeRegistryTag,
  parseNpmRegistryJson,
  prepareMetadata,
  preflightPublication,
  publicationFailureResult,
  registryState,
  stageQualifiedCandidate,
  validateResult,
  withNpmCredentials,
} from "../../scripts/publication-transaction.mjs";
import {
  formatConstruction,
  normalizeConstruction,
  npmChildEnvironment,
  projectConstruction,
} from "../../scripts/package-construction.mjs";
import { isolatedNpmState } from "../../scripts/release-qualification.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const PUBLISHED_VERSION = "3.0.0-dev.39";
const PUBLISHED_INTEGRITY =
  "sha512-cWRi+6n8XJdumtwTVvZLXCTKIXZvnjRuE6P33XT7VpmqrDGP9Hec4ZiAx4SZHDJejtJD2qfO3pMWt+Ws5cAN4w==";

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
  it("isolates npm children from caller tokens and configuration", () => {
    const environment = npmChildEnvironment({
      HOME: "/private/home",
      NPM_TOKEN: "secret",
      NODE_AUTH_TOKEN: "secret",
      npm_config_registry: "https://hostile.invalid/",
      PNPM_HOME: "/private/pnpm",
      AGENTERA_VERIFICATION_RESULT: "/private/outer-result.json",
      AGENTERA_VERIFICATION_BARRIER: "/private/outer-barrier",
    }, "/tmp/user-npmrc", "/tmp/global-npmrc");

    expect(environment).toMatchObject({
      HOME: "/private/home",
      NPM_CONFIG_USERCONFIG: "/tmp/user-npmrc",
      NPM_CONFIG_GLOBALCONFIG: "/tmp/global-npmrc",
    });
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(environment).not.toHaveProperty("npm_config_registry");
    expect(environment).not.toHaveProperty("PNPM_HOME");
    expect(environment).not.toHaveProperty("AGENTERA_VERIFICATION_RESULT");
    expect(environment).not.toHaveProperty("AGENTERA_VERIFICATION_BARRIER");
  });

  it("gives a token-bearing mutation child only an isolated mode-0600 config", () => {
    withTemporaryConstruction((temporary) => {
      const state = isolatedNpmState("agentera-token-validation-test-");
      try {
        const child = withNpmCredentials(
          temporary,
          (environment: NodeJS.ProcessEnv) => ({
            environment,
            mode: fs.statSync(environment.NPM_CONFIG_USERCONFIG!).mode & 0o777,
          }),
          {
            HOME: "/hostile/home",
            NPM_TOKEN: "secret",
            NODE_AUTH_TOKEN: "secret",
            NPM_CONFIG_CACHE: "/hostile/cache",
            npm_config_registry: "https://hostile.invalid/",
          },
          state.environment,
        );
        expect(child.mode).toBe(0o600);
        expect(child.environment).toMatchObject({
          HOME: state.environment.HOME,
          NPM_CONFIG_CACHE: state.environment.NPM_CONFIG_CACHE,
          NPM_CONFIG_GLOBALCONFIG: state.environment.NPM_CONFIG_GLOBALCONFIG,
        });
        expect(child.environment).not.toHaveProperty("NPM_TOKEN");
        expect(child.environment).not.toHaveProperty("NODE_AUTH_TOKEN");
        expect(child.environment).not.toHaveProperty("npm_config_registry");
      } finally {
        fs.rmSync(state.root, { recursive: true, force: true });
      }
    });
  });

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

  it("declares the canonical stable construction tests", () => {
    const shim = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/shim/package.json"), "utf8"));
    expect(shim.scripts.test).toBe("pnpm -C .. test test/shim/runBackend.test.ts && node --test test/*.test.mjs");
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

  it("runs stable construction children in an isolated npm state", () => {
    const environments: NodeJS.ProcessEnv[] = [];
    expect(() => constructPackage("stable", PACKAGE_ADAPTERS.stable, manifest("stable"), "/unused", {
      run: (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        environments.push(options.env!);
        throw new Error("stop after isolated test setup");
      },
    })).toThrow("stop after isolated test setup");
    expect(environments[0]).toMatchObject({
      HOME: expect.stringContaining("agentera-stable-construction-"),
      NPM_CONFIG_USERCONFIG: expect.any(String),
      NPM_CONFIG_GLOBALCONFIG: expect.any(String),
      NPM_CONFIG_CACHE: expect.any(String),
    });
    expect(environments[0]).not.toHaveProperty("NPM_TOKEN");
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
        elapsedMs: 1,
        executed: "ordered",
        reused: false,
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

  it("rejects a constructed package whose identity differs from expected metadata", () => {
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

describe("npm registry response normalization", () => {
  it.each([
    ["scalar", PUBLISHED_INTEGRITY],
    ["legacy object", { "dist.integrity": PUBLISHED_INTEGRITY }],
    ["nested object", { dist: { integrity: PUBLISHED_INTEGRITY } }],
    ["npm 12 scalar array", [PUBLISHED_INTEGRITY]],
    ["npm 12 object array", [{ "dist.integrity": PUBLISHED_INTEGRITY }]],
  ])("accepts the %s exact-version fixture", (_name, fixture) => {
    expect(normalizeRegistryField(fixture, "dist.integrity")).toBe(PUBLISHED_INTEGRITY);
  });

  it.each([
    ["scalar", PUBLISHED_VERSION],
    ["legacy object", { next: PUBLISHED_VERSION }],
    ["npm 12 scalar array", [PUBLISHED_VERSION]],
    ["npm 12 object array", [{ next: PUBLISHED_VERSION }]],
  ])("accepts the %s dist-tag fixture", (_name, fixture) => {
    expect(normalizeRegistryField(fixture, "next")).toBe(PUBLISHED_VERSION);
  });

  it("treats an absent first-use staging tag as untagged", () => {
    expect(normalizeRegistryTag(
      { latest: "0.0.2", next: "3.0.0-dev.41" },
      "candidate-3.0.0-dev.45",
    )).toBeNull();
  });

  it.each([
    ["empty array", []],
    ["multi-result array", [PUBLISHED_INTEGRITY, PUBLISHED_INTEGRITY]],
    ["nested array", [[PUBLISHED_INTEGRITY]]],
    ["null", null],
    ["wrong scalar", 12],
    ["missing field", { integrity: PUBLISHED_INTEGRITY }],
    ["malformed field", { "dist.integrity": { value: PUBLISHED_INTEGRITY } }],
    ["malformed nested field", { "dist.integrity": PUBLISHED_INTEGRITY, dist: "invalid" }],
    [
      "contradictory duplicate fields",
      { "dist.integrity": PUBLISHED_INTEGRITY, dist: { integrity: "sha512-conflict" } },
    ],
  ])("rejects the %s fixture as a registry-shape error", (_name, fixture) => {
    expect(() => normalizeRegistryField(fixture, "dist.integrity")).toThrow(
      /npm registry shape error for dist\.integrity/,
    );
  });

  it("replays the observed npm 12 exact-version and dist-tag objects through smoke", async () => {
    const committed = { ...manifest("development"), version: PUBLISHED_VERSION };
    const packed = normalizeConstruction(
      { ...packedManifest(PUBLISHED_VERSION), integrity: PUBLISHED_INTEGRITY },
      {
        expectedName: "agentera",
        expectedVersion: PUBLISHED_VERSION,
        expectedTag: "next",
        artifact: `/tmp/agentera-${PUBLISHED_VERSION}.tgz`,
        warnings: [],
      },
    );
    const queries: string[] = [];
    const state = registryState(committed, PACKAGE_ADAPTERS.development, (args: string[]) => {
      queries.push(args.join(" "));
      return args.at(-1) === "dist.integrity"
        ? [{ "dist.integrity": PUBLISHED_INTEGRITY }]
        : [{ next: PUBLISHED_VERSION }];
    });
    let publishes = 0;
    let smokes = 0;

    const receipts = await executePublication("development", committed, packed, {
      inspectRegistry: () => state,
      publishPackage: () => publishes++,
      smokePackage: () => {
        smokes++;
        return PUBLISHED_VERSION;
      },
    });

    expect(queries).toEqual([
      `view agentera@${PUBLISHED_VERSION} dist.integrity`,
      "view agentera dist-tags",
    ]);
    expect(publishes).toBe(0);
    expect(smokes).toBe(1);
    expect(receipts.map(({ phase, outcome }) => `${phase}:${outcome}`)).toEqual([
      "publication:replayed",
      "smoke:passed",
      "complete:passed",
    ]);
  });

  it("does not classify unmarked lookup errors as registry absence", () => {
    const committed = { ...manifest("development"), version: PUBLISHED_VERSION };
    expect(() =>
      registryState(committed, PACKAGE_ADAPTERS.development, () => {
        throw new Error("parser or dependency error containing E404");
      }),
    ).toThrow("parser or dependency error containing E404");
  });

  it("fails malformed E404 JSON before publication with a bounded shape diagnostic", async () => {
    const committed = { ...manifest("development"), version: PUBLISHED_VERSION };
    const packed = normalizeConstruction(
      { ...packedManifest(PUBLISHED_VERSION), integrity: PUBLISHED_INTEGRITY },
      {
        expectedName: "agentera",
        expectedVersion: PUBLISHED_VERSION,
        expectedTag: "next",
        artifact: `/tmp/agentera-${PUBLISHED_VERSION}.tgz`,
        warnings: [],
      },
    );
    let publishes = 0;

    await expect(
      executePublication("development", committed, packed, {
        inspectRegistry: () =>
          registryState(committed, PACKAGE_ADAPTERS.development, () =>
            parseNpmRegistryJson("malformed stdout containing E404"),
          ),
        publishPackage: () => publishes++,
      }),
    ).rejects.toThrow(/^npm registry shape error: invalid JSON response$/);
    expect(publishes).toBe(0);
  });
});

describe.each([
  ["development", "3.0.0-dev.42"],
  ["stable", "2.7.8"],
] as const)("%s qualified stage public-tag conflict", (adapterName, version) => {
  it("fails before candidate query, credentials, publish, or candidate-tag effect", async () => {
    const adapter = PACKAGE_ADAPTERS[adapterName];
    const committed = { ...manifest(adapterName), version };
    const candidate = {
      manifest: committed,
      adapter,
      artifact: `/external/agentera-${version}.tgz`,
      receipt: {
        candidateTag: `candidate-${version}`,
        artifact: { integrity: PUBLISHED_INTEGRITY },
      },
    };
    const publicState = Object.freeze({
      exists: false,
      integrity: null,
      expectedTagVersion: version,
      tagged: true,
    });
    let candidateQueries = 0;
    let publishOrTagEffects = 0;
    let smokes = 0;
    let failure: any;

    try {
      await stageQualifiedCandidate(adapterName, "/external/candidate", {
        candidate,
        environment: {},
        inspectPublic: () => publicState,
        inspectCandidate: () => {
          candidateQueries += 1;
          throw new Error("staging tag must not be queried");
        },
        publishPackage: () => { publishOrTagEffects += 1; },
        smokePackage: () => { smokes += 1; return version; },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      publicationPhase: "staging",
      message: `@${adapter.expectedTag} already points to ${version}, but that exact version is absent`,
      nextAction: expect.stringContaining("without moving the public tag backward; No registry mutation was attempted"),
    });
    expect(candidateQueries).toBe(0);
    expect(publishOrTagEffects).toBe(0);
    expect(smokes).toBe(0);
    expect(publicState).toEqual({ exists: false, integrity: null, expectedTagVersion: version, tagged: true });

    const jsonFailure = publicationFailureResult(adapterName, version, "stage", failure);
    expect(JSON.parse(JSON.stringify(jsonFailure))).toMatchObject({
      package: adapterName,
      version,
      expectedTag: adapter.expectedTag,
      phase: "staging",
      outcome: "failed",
      nextAction: expect.stringContaining("No registry mutation was attempted"),
    });
    expect(formatPublicationResult(jsonFailure)).toContain(
      `${adapter.expectedTag} staging: failed`,
    );
    expect(formatPublicationResult(jsonFailure)).not.toContain("NPM_TOKEN");
  });
});

describe.each([
  ["development", "3.0.0-dev.33"],
  ["stable", "2.7.8"],
] as const)("%s bounded publication verification", (adapterName, version) => {
  const adapter = PACKAGE_ADAPTERS[adapterName];
  const committed = { ...manifest(adapterName), version };
  const packed = normalizeConstruction(packedManifest(version), {
    expectedName: "agentera",
    expectedVersion: version,
    expectedTag: adapter.expectedTag,
    artifact: `/tmp/agentera-${version}.tgz`,
    warnings: [],
  });

  function registry(exact: string | null, tag: string | null) {
    return {
      exists: exact !== null,
      integrity: exact,
      expectedTagVersion: tag,
      tagged: tag === version,
    };
  }

  it("publishes an absent exact version once and smokes after delayed convergence", async () => {
    const states = [
      registry(null, adapterName === "development" ? "3.0.0-dev.32" : "2.7.7"),
      registry(null, adapterName === "development" ? "3.0.0-dev.32" : "2.7.7"),
      registry(packed.integrity, version),
    ];
    let publishes = 0;
    let smokes = 0;
    const receipts = await executePublication(adapterName, committed, packed, {
      inspectRegistry: () => states.shift()!,
      publishPackage: () => publishes++,
      smokePackage: () => {
        smokes++;
        return version;
      },
      sleep: async () => undefined,
      registryAttempts: 3,
    });

    expect(publishes).toBe(1);
    expect(smokes).toBe(1);
    expect(receipts.map(({ phase, outcome }) => `${phase}:${outcome}`)).toEqual([
      "publication:published",
      "convergence:passed",
      "smoke:passed",
      "complete:passed",
    ]);
  });

  it("replays matching registry state without publishing", async () => {
    let publishes = 0;
    const receipts = await executePublication(adapterName, committed, packed, {
      inspectRegistry: () => registry(packed.integrity, version),
      publishPackage: () => publishes++,
      smokePackage: () => version,
    });

    expect(publishes).toBe(0);
    expect(receipts[0]).toMatchObject({ phase: "publication", outcome: "replayed" });
    expect(receipts.at(-1)).toMatchObject({ phase: "complete", outcome: "passed" });
  });

  it("polls inconsistent exact-version visibility before deciding to publish", async () => {
    const states = [registry(null, version), registry(packed.integrity, version)];
    let publishes = 0;
    const receipts = await executePublication(adapterName, committed, packed, {
      inspectRegistry: () => states.shift()!,
      publishPackage: () => publishes++,
      smokePackage: () => version,
      sleep: async () => undefined,
      registryAttempts: 2,
    });

    expect(publishes).toBe(0);
    expect(receipts[0]).toMatchObject({ phase: "publication", outcome: "replayed" });
  });

  it("fails conflicting integrity before publication", async () => {
    let publishes = 0;
    await expect(
      executePublication(adapterName, committed, packed, {
        inspectRegistry: () => registry("sha512-conflict", version),
        publishPackage: () => publishes++,
        smokePackage: () => version,
      }),
    ).rejects.toThrow(/conflicting integrity/);
    expect(publishes).toBe(0);
  });

  it("fails an expected tag already ahead before publication", async () => {
    const ahead = adapterName === "development" ? "3.0.0-dev.34" : "2.7.9";
    let publishes = 0;
    await expect(
      executePublication(adapterName, committed, packed, {
        inspectRegistry: () => registry(null, ahead),
        publishPackage: () => publishes++,
        smokePackage: () => version,
      }),
    ).rejects.toThrow(new RegExp(`@${adapter.expectedTag} already points to ${ahead}`));
    expect(publishes).toBe(0);
  });

  it("times out actionably when registry metadata never converges", async () => {
    let publishes = 0;
    await expect(
      executePublication(adapterName, committed, packed, {
        inspectRegistry: () => registry(null, null),
        publishPackage: () => publishes++,
        smokePackage: () => version,
        sleep: async () => undefined,
        registryAttempts: 2,
      }),
    ).rejects.toMatchObject({
      publicationPhase: "convergence",
      nextAction: expect.stringContaining("Retry the same verified version"),
    });
    expect(publishes).toBe(1);
  });

  it("does not treat a registry lookup failure as an unpublished version", async () => {
    let publishes = 0;
    await expect(
      executePublication(adapterName, committed, packed, {
        inspectRegistry: () => {
          throw new Error("npm view failed: registry unavailable");
        },
        publishPackage: () => publishes++,
        smokePackage: () => version,
      }),
    ).rejects.toThrow(/registry unavailable/);
    expect(publishes).toBe(0);
  });

  it("reports smoke failure without claiming rollback", async () => {
    let publishes = 0;
    await expect(
      executePublication(adapterName, committed, packed, {
        inspectRegistry: () => registry(packed.integrity, version),
        publishPackage: () => publishes++,
        smokePackage: () => {
          throw new Error("bootstrap failed");
        },
      }),
    ).rejects.toMatchObject({
      publicationPhase: "smoke",
      nextAction: expect.stringContaining("No rollback was attempted"),
    });
    expect(publishes).toBe(0);
  });
});

describe("publication version preflight", () => {
  const state = {
    authorized: true,
    dirty: false,
    metadataCommitted: true,
    gitRefExists: true,
  };

  it("rejects adapter-incompatible local versions before mutation", () => {
    expect(
      preflightPublication("development", { ...manifest("development"), version: "3.0.0" }, state),
    ).toMatchObject({ outcome: "failed", nextAction: expect.stringContaining("X.Y.Z-dev.N") });
    expect(
      preflightPublication("stable", { ...manifest("stable"), version: "2.7.8-dev.1" }, state),
    ).toMatchObject({ outcome: "failed", nextAction: expect.stringContaining("X.Y.Z") });
  });

  it.each([
    ["development", "999999999999999999999999.0.0-dev.1"],
    ["stable", "999999999999999999999999.0.0"],
    ["development", "0.0.0-dev.01"],
    ["development", `0.0.0-dev.${"1".repeat(247)}`],
    ["stable", "0.0.01"],
  ] as const)("rejects the adapter-invalid %s boundary %s", (adapter, version) => {
    expect(preflightPublication(adapter, { ...manifest(adapter), version }, state)).toMatchObject({
      outcome: "failed",
    });
  });

  it.each([
    ["development", "3.0.0-dev.32"],
    ["stable", "2.7.8"],
    ["development", "9007199254740991.0.0-dev.1"],
    ["stable", "9007199254740991.0.0"],
    ["development", "0.0.0-dev.0"],
    ["stable", "0.0.0"],
    ["development", "0.0.0-dev.9007199254740992"],
    ["development", `0.0.0-dev.${"1".repeat(246)}`],
  ] as const)("accepts the npm-publishable %s boundary %s", (adapter, version) => {
    expect(preflightPublication(adapter, { ...manifest(adapter), version }, state)).toMatchObject({
      outcome: "passed",
    });
  });

  it.each([
    ["3.0.0-dev.9007199254740992", "3.0.0-dev.9007199254740993"],
    [`0.0.0-dev.${"1".repeat(245)}2`, `0.0.0-dev.${"1".repeat(245)}3`],
  ])(
    "rejects precision-sensitive advanced next tag %s before publication",
    async (version, ahead) => {
      const committed = { ...manifest("development"), version };
      const packed = normalizeConstruction(packedManifest(version), {
        expectedName: "agentera",
        expectedVersion: version,
        expectedTag: "next",
        artifact: `/tmp/agentera-${version}.tgz`,
        warnings: [],
      });
      let publishes = 0;

      await expect(
        executePublication("development", committed, packed, {
          inspectRegistry: () => ({
            exists: false,
            integrity: null,
            expectedTagVersion: ahead,
            tagged: false,
          }),
          publishPackage: () => publishes++,
          smokePackage: () => version,
          sleep: async () => undefined,
          registryAttempts: 1,
        }),
      ).rejects.toThrow(
        `@next already points to ${ahead}, which is incompatible with committed ${version}`,
      );
      expect(publishes).toBe(0);
    },
  );

  it.each([
    ["development", "0.0.0-dev.01"],
    ["development", "9007199254740992.0.0-dev.1"],
    ["stable", "0.0.01"],
    ["stable", "9007199254740992.0.0"],
  ] as const)("rejects %s version %s before any registry mutation", async (adapter, version) => {
    let inspections = 0;
    let publishes = 0;

    await expect(
      executePublication(adapter, { ...manifest(adapter), version }, packedManifest(version), {
        inspectRegistry: () => {
          inspections++;
          throw new Error("registry inspection must not run");
        },
        publishPackage: () => publishes++,
      }),
    ).rejects.toMatchObject({ publicationPhase: "preflight" });
    expect(inspections).toBe(0);
    expect(publishes).toBe(0);
  });
});

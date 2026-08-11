import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const PACKAGE_ROOT = path.join(REPO_ROOT, "packages/cli");
const RUNNER = path.join(PACKAGE_ROOT, "scripts/verify-lane.mjs");
const PRODUCTION_POLICY = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml"), "utf8"));
const PERFORMANCE_FORWARDING = PRODUCTION_POLICY.owners.performance.forwarding;
const FIXTURE_OVERLAP = PRODUCTION_POLICY.overlap;
const OWNER_NAMES = ["source", "stress", "performance", "package"] as const;
const POLICY_OWNERS = {
  targeted: ["source"],
  precommit: ["source"],
  fast: ["source"],
  local: ["source"],
  merge: ["source", "package"],
  scheduled: ["source", "stress", "performance"],
  release: ["source", "stress", "performance", "package"],
} as const;

function fixture(overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-lanes-"));
  for (const relative of [
    "packages/cli/test/source.test.ts",
    FIXTURE_OVERLAP.allowed_pending_assertion.path,
    "packages/cli/test/stress.test.ts",
    "packages/cli/test/performance-analytics.test.ts",
    "packages/cli/test/performance.test.ts",
    "packages/cli/test/packaging/package.test.ts",
  ]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative === FIXTURE_OVERLAP.allowed_pending_assertion.path
      ? [
        `describe(${JSON.stringify(FIXTURE_OVERLAP.allowed_pending_assertion.suite)}, () => { `,
        "it.runIf(",
        'process.platform === "darwin"',
        `)(${JSON.stringify(FIXTURE_OVERLAP.allowed_pending_assertion.title)}, () => {}); });\n`,
      ].join("")
      : "// fixture\n");
  }
  const contract = {
    schemaVersion: "agentera.verificationPolicy.v1",
    inventory: {
      root: "packages/cli/test",
      suffix: ".test.ts",
      default_owner: "source",
      rules: [
        { owner: "stress", path: "packages/cli/test/stress.test.ts" },
        { owner: "performance", path: "packages/cli/test/performance-analytics.test.ts" },
        { owner: "performance", path: "packages/cli/test/performance.test.ts", evidence_producer: true },
        { owner: "package", prefix: "packages/cli/test/packaging/" },
      ],
    },
    owners: Object.fromEntries(OWNER_NAMES.map((owner) => [owner, {
      config: `packages/cli/${owner}.config.ts`,
      correction: `run ${owner} correction`,
      ...(owner === "performance" ? {
        forwarding: {
          safe_options: PERFORMANCE_FORWARDING.safe_options,
          forbidden_options: PERFORMANCE_FORWARDING.forbidden_options,
        },
      } : {}),
    }])),
    mixed_files: [],
    overlap: FIXTURE_OVERLAP,
    policies: POLICY_OWNERS,
    conservative_routing: { exact: ["central.yaml"], prefixes: ["schemas/"] },
    ...overrides,
  };
  const contractPath = path.join(root, "policy.yaml");
  fs.writeFileSync(contractPath, JSON.stringify(contract));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const record = path.join(root, "runs.jsonl");
  const vp = path.join(bin, "vp");
  fs.writeFileSync(vp, `#!/bin/sh\nprintf '{"owner":"%s","args":"%s","resultChannel":"%s","maxWorkers":"%s"}\\n' "$AGENTERA_VERIFICATION_OWNER" "$*" "$AGENTERA_VERIFICATION_RESULT" "$VITEST_MAX_WORKERS" >> "${record}"\n[ "$AGENTERA_VERIFICATION_OWNER" != "$FAIL_OWNER" ]\n`);
  fs.chmodSync(vp, 0o755);
  return { root, contractPath, record, bin };
}

function fixtureWithPerformanceIntegration() {
  const setup = fixture();
  const integration = path.join(setup.root, "packages/cli/test/integration/performanceOwner.integration.mjs");
  fs.mkdirSync(path.dirname(integration), { recursive: true });
  fs.writeFileSync(integration, `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(setup.record)}, JSON.stringify({ owner: "performance-integration", args: "supported-owner-command" }) + "\\n");\n`);
  const contract = JSON.parse(fs.readFileSync(setup.contractPath, "utf8"));
  contract.owners.performance.integration = {
    path: "packages/cli/test/integration/performanceOwner.integration.mjs",
    command: [process.execPath, integration],
  };
  fs.writeFileSync(setup.contractPath, JSON.stringify(contract));
  return setup;
}

function run(args: string[], setup = fixture(), extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${setup.bin}${path.delimiter}${process.env.PATH ?? ""}`,
      AGENTERA_VERIFICATION_ROOT: setup.root,
      AGENTERA_VERIFICATION_CONTRACT: setup.contractPath,
      ...extraEnv,
    },
  });
  const runs = fs.existsSync(setup.record)
    ? fs.readFileSync(setup.record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { result, runs, setup };
}

function productionRoute(...paths: string[]): string {
  const result = spawnSync(process.execPath, [RUNNER, "route", "--policy-only", ...paths], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("verification lane ownership", () => {
  it.each([
    "packages/cli/test/helpers/runtimeBootstrapMatrix.ts",
    "packages/cli/test/helpers/preCutoverBootstrapDispatcher.mjs",
    "packages/cli/test/helpers/runtimeProofCliBoundary.mjs",
  ])("routes critical runtime-matrix helper %s through every release owner", (helper) => {
    expect(productionRoute(helper)).toBe("release");
  });

  it("keeps the combined runtime-matrix helper change on release without broadening other helpers", () => {
    expect(productionRoute(
      "packages/cli/test/helpers/runtimeBootstrapMatrix.ts",
      "packages/cli/test/helpers/preCutoverBootstrapDispatcher.mjs",
      "packages/cli/test/helpers/runtimeProofCliBoundary.mjs",
    )).toBe("release");
    expect(productionRoute("packages/cli/test/helpers/entityAuthorityFixture.ts")).toBe("precommit");
  });

  it.each(OWNER_NAMES)("runs the independently owned %s files headlessly", (owner) => {
    const { result, runs } = run([owner]);
    expect(result.status, result.stderr).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ owner });
    expect(runs[0].args).toContain(`${owner}.config.ts`);
    expect(runs[0].args).toContain(owner === "package" ? "test/packaging/package.test.ts" : `test/${owner}.test.ts`);
  });

  it("emits a structured full-owner result without replacing the owned inventory", () => {
    const setup = fixture();
    const output = path.join(setup.root, "source-result.json");
    const { result, runs } = run(["source"], setup, { AGENTERA_VERIFICATION_RESULT: output });
    expect(result.status, result.stderr).toBe(0);
    expect(runs[0].args).toContain("test/source.test.ts");
    expect(runs[0].args).toContain("--reporter=json");
    expect(runs[0].args).toContain(`--outputFile=${output}`);
    expect(runs[0].resultChannel).toBe("");
  });

  it.each(Object.entries(POLICY_OWNERS))("composes policy %s from its named owners", (policy, owners) => {
    const { result, runs } = run(["policy", policy]);
    expect(result.status, result.stderr).toBe(0);
    expect(runs.map(({ owner }) => owner)).toEqual(owners);
  });

  it("composes scheduled performance through its explicit integration surface", () => {
    const { result, runs } = run(["policy", "scheduled"], fixtureWithPerformanceIntegration());
    expect(result.status, result.stderr).toBe(0);
    expect(runs.map(({ owner }) => owner)).toEqual(["source", "stress", "performance-integration"]);
  });

  it("forwards targeted filters only to the source owner", () => {
    const { result, runs } = run(["policy", "targeted", "--", "test/source.test.ts"]);
    expect(result.status, result.stderr).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toContain("test/source.test.ts");
  });

  it("preserves reviewed observability flags while validating positional owner filters", () => {
    const { result, runs } = run([
      "performance",
      "--no-color",
      "--logHeapUsage",
      "test/performance.test.ts",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toContain("--no-color --logHeapUsage");
    expect(runs[0].args).toContain("test/performance.test.ts");
  });

  it.each([
    ["zero delimiters", ["--no-color", "test/performance.test.ts"]],
    ["one delimiter", ["--", "--no-color", "test/performance.test.ts"]],
    ["package-manager and owner delimiters", ["--", "--", "--no-color", "test/performance.test.ts"]],
  ])("forwards one canonical argv for %s", (_, args) => {
    const { result, runs } = run(["performance", ...args]);
    expect(result.status, result.stderr).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0].args.split(" ")).not.toContain("--");
    expect(runs[0].args).toContain("--no-color test/performance.test.ts");
    expect(runs[0].args).not.toContain("performance-analytics.test.ts");
  });

  it("keeps the owner inventory selected when only reviewed flags are forwarded", () => {
    const { result, runs } = run(["performance", "--no-color"]);
    expect(result.status, result.stderr).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toContain("--no-color");
    expect(runs[0].args).toContain("test/performance.test.ts");
    expect(runs[0].args).not.toContain("test/source.test.ts");
  });

  it("runs performance-owned files serially inside the isolated owner", () => {
    const { result, runs } = run(["performance"], fixture(), { VITEST_MAX_WORKERS: "8" });
    expect(result.status, result.stderr).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ owner: "performance", maxWorkers: "1" });
    expect(runs[0].args).toContain("test/performance-analytics.test.ts");
    expect(runs[0].args).toContain("test/performance.test.ts");
  });

  it.runIf(process.platform === "linux")("rejects performance evidence while another marked owner is active", () => {
    const setup = fixture();
    const contract = JSON.parse(fs.readFileSync(setup.contractPath, "utf8"));
    contract.owners.performance.evidence = {
      schema_version: "agentera.entityAuthorityPerformanceEvidence.v1",
      authority: "fixture",
      stdout_format: "fixture",
      max_utf8_bytes: 65536,
    };
    fs.writeFileSync(setup.contractPath, JSON.stringify(contract));
    const competing = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      env: { ...process.env, AGENTERA_VERIFICATION_OWNER: "package" },
      stdio: "ignore",
    });
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      const { result, runs } = run(["performance"], setup);
      expect(result.status).toBe(1);
      expect(runs).toHaveLength(0);
      expect(result.stderr).toContain("performance owner rejected contended host");
      expect(result.stderr).toContain("machine-sensitive samples cannot share the host");
    } finally {
      competing.kill();
    }
  });

  it.each(Object.entries(PERFORMANCE_FORWARDING.forbidden_options))("rejects forbidden option %s before runner execution", (option, risk) => {
    const argument = option === "--exclude" ? `${option}=test/source.test.ts` : option;
    const { result, runs } = run(["performance", argument, "test/source.test.ts"]);
    expect(result.status).toBe(2);
    expect(runs).toHaveLength(0);
    expect(result.stderr).toContain(`forbidden option '${option}'`);
    expect(result.stderr).toContain(risk);
    expect(result.stderr).toContain("ownership risk");
    expect(result.stderr).toContain("run performance correction");
  });

  it.each([
    ["unknown option", ["--future-selector", "test/performance.test.ts"]],
    ["valued safe flag", ["--no-color=true", "test/performance.test.ts"]],
    ["delimiter option-like filter", ["--", "--exclude"]],
    ["literal glob", ["test/performance/*.test.ts"]],
    ["traversal", ["test/performance/../source.test.ts"]],
    ["directory", ["test"]],
    ["file URL", ["file:///tmp/performance.test.ts"]],
    ["selector", ["performance.test"]],
    ["selector equals form", ["--testNamePattern=matrix"]],
    ["configuration equals form", ["--config=other.config.ts"]],
    ["output equals form", ["--outputFile=result.json"]],
    ["mixed filters", ["test/performance.test.ts", "test/source.test.ts"]],
    ["ambiguous trailing delimiter", ["test/performance.test.ts", "--", "test/performance.test.ts"]],
  ])("fails closed for %s before runner execution", (_, args) => {
    const { result, runs } = run(["performance", ...args]);
    expect(result.status).toBe(2);
    expect(runs).toHaveLength(0);
    expect(result.stderr).toContain("ownership risk");
    expect(result.stderr).toContain("run performance correction");
  });

  it("normalizes aliases of the producer to its canonical inventory path", () => {
    const setup = fixture();
    const absolute = path.join(setup.root, "packages/cli/test/performance.test.ts");
    const { result, runs } = run(["performance", "./test/performance.test.ts", absolute], setup);
    expect(result.status, result.stderr).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toContain("test/performance.test.ts");
    expect(runs[0].args).not.toContain(absolute);
  });

  it("rejects a performance subset that omits the evidence producer before runner execution", () => {
    const { result, runs } = run(["performance", "test/performance-analytics.test.ts"]);
    expect(result.status).toBe(2);
    expect(runs).toHaveLength(0);
    expect(result.stderr).toContain("omits required evidence producer");
    expect(result.stderr).toContain("test/performance.test.ts");
    expect(result.stderr).toContain("run performance correction");
  });

  it("rejects a symlink alias whose target is outside the canonical inventory", () => {
    const setup = fixture();
    const external = path.join(setup.root, "external.test.ts");
    const alias = path.join(setup.root, "packages/cli/test/performance-alias.test.ts");
    fs.writeFileSync(external, "// external\n");
    fs.symlinkSync(external, alias);
    const { result, runs } = run(["performance", "test/performance-alias.test.ts"], setup);
    expect(result.status).toBe(2);
    expect(runs).toHaveLength(0);
    expect(result.stderr).toContain("canonical inventory file");
  });

  it("rejects reporter environment redirection before runner execution", () => {
    const setup = fixture();
    const output = path.join(setup.root, "result.json");
    const { result, runs } = run(["performance"], setup, { AGENTERA_VERIFICATION_RESULT: output });
    expect(result.status).toBe(2);
    expect(runs).toHaveLength(0);
    expect(result.stderr).toContain("AGENTERA_VERIFICATION_RESULT");
    expect(result.stderr).toContain("ownership risk");
  });

  it.each([
    ["source", "test/source.test.ts"],
    ["stress", "test/stress.test.ts"],
    ["package", "test/packaging/package.test.ts"],
    ["unowned fixture", "test/fixtures/performanceOwnerOutput.fixture.ts"],
  ])("rejects a performance filter owned by %s before test execution", (_, filter) => {
    const { result, runs } = run(["performance", filter]);
    expect(result.status).toBe(2);
    expect(runs).toHaveLength(0);
    expect(result.stderr).toContain(`performance owner rejected filter ${JSON.stringify(filter)}`);
    expect(result.stderr).toContain("select only performance-owned files");
    expect(result.stderr).toContain("run performance correction");
  });

  it("rejects an ownership gap", () => {
    const setup = fixture({ inventory: {
      root: "packages/cli/test", suffix: ".test.ts", default_owner: null, rules: [],
    } });
    const { result } = run(["validate"], setup);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ownership gap");
    expect(result.stderr).toContain("packages/cli/test/source.test.ts");
  });

  it("rejects overlapping primary owners", () => {
    const setup = fixture({ inventory: {
      root: "packages/cli/test", suffix: ".test.ts", default_owner: "source", rules: [
        { owner: "stress", path: "packages/cli/test/stress.test.ts" },
        { owner: "performance", path: "packages/cli/test/stress.test.ts" },
      ],
    } });
    const { result } = run(["validate"], setup);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ownership overlap");
    expect(result.stderr).toContain("stress, performance");
  });

  it("reports the failed owner and its correction path", () => {
    const { result, runs } = run(["policy", "release"], fixture(), { FAIL_OWNER: "performance" });
    expect(result.status).toBe(1);
    expect(runs.map(({ owner }) => owner)).toEqual(["source", "stress", "performance"]);
    expect(result.stderr).toContain("performance owner failed");
    expect(result.stderr).toContain("run performance correction");
  });

  it("validates exclusive real ownership after lock evidence separation", () => {
    const result = spawnSync(process.execPath, [RUNNER, "inventory", "--json"], {
      cwd: PACKAGE_ROOT, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const inventory = JSON.parse(result.stdout);
    expect(inventory.counts.total).toBeGreaterThan(190);
    expect(inventory.counts).toMatchObject({ stress: 1, performance: 3 });
    expect(inventory.files.source).toHaveLength(inventory.counts.source);
    expect(inventory.files.package).toEqual([
      "packages/cli/test/packaging/copyBundleSafety.test.ts",
      "packages/cli/test/packaging/packageVerification.test.ts",
      "packages/cli/test/packaging/runtimeBootstrapMatrix.test.ts",
    ]);
    expect(inventory.integrations).toEqual({
      performance: "packages/cli/test/integration/performanceOwner.integration.mjs",
    });
    expect(inventory.evidence_producers).toEqual({
      performance: "packages/cli/test/performance/entityAuthorityPerformance.test.ts",
    });
    expect(inventory.mixed_files).toEqual([]);
  });

  it("keeps one canonical generated-output and packaging authority", () => {
    const authority = fs.readFileSync(path.join(REPO_ROOT, "docs/packaging/v3-packaging.md"), "utf8");
    const contributor = fs.readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8");
    const testPolicy = fs.readFileSync(path.join(PACKAGE_ROOT, "test/README.md"), "utf8");
    const characterization = fs.readFileSync(path.join(REPO_ROOT, "references/adapters/package-surface-characterization.md"), "utf8");
    const releaseMetadata = fs.readFileSync(path.join(PACKAGE_ROOT, "src/release/releaseMetadata.ts"), "utf8");
    const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const shimReadme = fs.readFileSync(path.join(PACKAGE_ROOT, "shim/README.md"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(authority).toContain("canonical authority for checkout generated output");
    expect(authority).toContain("The four test owners are");
    expect(authority).toContain("| Performance | `pnpm -C packages/cli run test:performance`");
    expect(authority).toContain("| `release` | Source, stress, performance, package |");
    expect(authority).toContain("Conservative authority and verification surfaces route to `release`");
    expect(authority).toContain("Checkout `prepack` is a guard that rejects direct");
    expect(authority).toContain("generated:cleanup -- --force --json");
    expect(authority).toContain("singly linked regular");
    expect(authority).toContain("`LC_ALL=C LANG=C TZ=UTC0 ps -o lstart`");
    expect(authority).toContain("mutation mutex serializes cleanup");
    expect(contributor).toContain("../../docs/packaging/v3-packaging.md");
    expect(testPolicy).toContain("../../../docs/packaging/v3-packaging.md");
    expect(characterization).toContain("../../docs/packaging/v3-packaging.md");
    expect(characterization).toContain("isolated package fixture");
    expect(releaseMetadata).toContain("docs/packaging/v3-packaging.md");
    expect(releaseMetadata).not.toContain("at `prepack` time");
    expect(changelog).not.toContain("bundling app data at pack time via `prepack`");
    expect(shimReadme).toContain("../../../docs/packaging/v3-packaging.md");
    expect(shimReadme).toContain("pnpm cli:publish:qualified:stable");
    expect(shimReadme).not.toMatch(/^npm (?:pack|publish)/m);
    expect(contributor).not.toContain("Staging directories encode their owner PID");
    expect(packageJson.scripts["generated:cleanup"]).toBe("node scripts/build-package.mjs --cleanup");
  });

  it("keeps package construction separate and fast policy owner-free", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    const contract = fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml"), "utf8");
    const performanceIntegration = fs.readFileSync(path.join(PACKAGE_ROOT, "test/integration/performanceOwner.integration.mjs"), "utf8");
    expect(packageJson.scripts.test).toBe("pnpm run test:source");
    expect(packageJson.scripts["test:performance:integration"]).toBe("node test/integration/performanceOwner.integration.mjs");
    expect(packageJson.scripts["verify:package"]).toBe("node scripts/verify-lane.mjs package");
    expect(PRODUCTION_POLICY.policies).toEqual(POLICY_OWNERS);
    expect(contract).toContain("fast: [source]");
    expect(contract).toContain("path: packages/cli/test/performance/analyticsEvidenceTierCap.test.ts");
    expect(contract).toContain("path: packages/cli/test/performance/entityMigrationPreviewCap.test.ts");
    expect(contract).toContain("path: packages/cli/test/performance/entityAuthorityPerformance.test.ts");
    expect(contract).toContain("authority: references/artifacts/state-storage-authority.yaml#entity_target.measurement_contract");
    expect(contract).toContain("stdout_format: newline_delimited_json_record_amid_runner_output");
    expect(contract).toContain("path: packages/cli/test/integration/performanceOwner.integration.mjs");
    expect(contract).toContain("path: packages/cli/test/stress/entityStorageStress.test.ts");
    expect(contract).toContain("merge: [source, package]");
    expect(contract).toContain("scheduled: [source, stress, performance]");
    expect(contract).toContain("release: [source, stress, performance, package]");
    expect(contract).not.toMatch(/^  fast:\n/m);
    expect(performanceIntegration).toContain('spawnSync("pnpm", ["run", "test:performance"]');
    expect(performanceIntegration).not.toContain('"test:performance:integration"');
    expect(performanceIntegration).toContain("delete ownerEnv.AGENTERA_VERIFICATION_RESULT");
  });

  it("keeps the source smoke fixture free of cold measurement dependencies", () => {
    const sourceSmoke = fs.readFileSync(path.join(PACKAGE_ROOT, "test/cli/primeProjectionContract.test.ts"), "utf8");
    const fixtureHelper = fs.readFileSync(path.join(PACKAGE_ROOT, "test/helpers/entityAuthorityFixture.ts"), "utf8");
    const testPolicy = fs.readFileSync(path.join(PACKAGE_ROOT, "test/README.md"), "utf8");
    expect(sourceSmoke).toContain('../helpers/entityAuthorityFixture.js');
    expect(sourceSmoke).not.toContain("coldCliMeasurement");
    expect(fixtureHelper).not.toMatch(/node:child_process|node:perf_hooks|sourceSubprocess|--inspect/);
    expect(fs.readFileSync(path.join(PACKAGE_ROOT, "vite.config.ts"), "utf8")).not.toContain("AGENTERA_PERFORMANCE_OUTPUT_FIXTURE");
    expect(fs.existsSync(path.join(PACKAGE_ROOT, "test/fixtures/performanceOwnerOutput.fixture.ts"))).toBe(false);
    expect(testPolicy).toContain("Performance stdout is not JSON-only");
    expect(testPolicy).toContain("exactly one");
    expect(testPolicy).toContain("schemaVersion");
  });
});

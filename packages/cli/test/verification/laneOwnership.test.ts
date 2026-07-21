import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const PACKAGE_ROOT = path.join(REPO_ROOT, "packages/cli");
const RUNNER = path.join(PACKAGE_ROOT, "scripts/verify-lane.mjs");
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
    "packages/cli/test/stress.test.ts",
    "packages/cli/test/performance.test.ts",
    "packages/cli/test/packaging/package.test.ts",
  ]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "// fixture\n");
  }
  const contract = {
    schemaVersion: "agentera.verificationPolicy.v1",
    inventory: {
      root: "packages/cli/test",
      suffix: ".test.ts",
      default_owner: "source",
      rules: [
        { owner: "stress", path: "packages/cli/test/stress.test.ts" },
        { owner: "performance", path: "packages/cli/test/performance.test.ts" },
        { owner: "package", prefix: "packages/cli/test/packaging/" },
      ],
    },
    owners: Object.fromEntries(OWNER_NAMES.map((owner) => [owner, {
      config: `packages/cli/${owner}.config.ts`,
      correction: `run ${owner} correction`,
    }])),
    mixed_files: [],
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
  fs.writeFileSync(vp, `#!/bin/sh\nif [ "$*" = "test run --help" ]; then\n  printf '  --run  Run tests\\n  --maxWorkers <workers>  Maximum workers\\n  --testNamePattern <pattern>  Test name\\n'\n  exit 0\nfi\nprintf '{"owner":"%s","args":"%s"}\\n' "$AGENTERA_VERIFICATION_OWNER" "$*" >> "${record}"\n[ "$AGENTERA_VERIFICATION_OWNER" != "$FAIL_OWNER" ]\n`);
  fs.chmodSync(vp, 0o755);
  return { root, contractPath, record, bin };
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

describe("verification lane ownership", () => {
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
  });

  it.each(Object.entries(POLICY_OWNERS))("composes policy %s from its named owners", (policy, owners) => {
    const { result, runs } = run(["policy", policy]);
    expect(result.status, result.stderr).toBe(0);
    expect(runs.map(({ owner }) => owner)).toEqual(owners);
  });

  it("forwards targeted filters only to the source owner", () => {
    const { result, runs } = run(["policy", "targeted", "--", "test/source.test.ts"]);
    expect(result.status, result.stderr).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toContain("test/source.test.ts");
  });

  it("preserves Vitest options while validating only positional owner filters", () => {
    const { result, runs } = run([
      "performance",
      "--maxWorkers",
      "1",
      "--testNamePattern",
      "test/source.test.ts",
      "test/performance.test.ts",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toContain("--maxWorkers 1");
    expect(runs[0].args).toContain("--testNamePattern test/source.test.ts");
    expect(runs[0].args).toContain("test/performance.test.ts");
  });

  it("keeps the owner inventory selected when only Vitest options are forwarded", () => {
    const { result, runs } = run(["performance", "--maxWorkers", "1"]);
    expect(result.status, result.stderr).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toContain("--maxWorkers 1");
    expect(runs[0].args).toContain("test/performance.test.ts");
    expect(runs[0].args).not.toContain("test/source.test.ts");
  });

  it.each([
    ["source", "test/source.test.ts"],
    ["stress", "test/stress.test.ts"],
    ["package", "test/packaging/package.test.ts"],
    ["unowned fixture", "test/fixtures/performanceOwnerOutput.fixture.ts"],
  ])("rejects a performance filter owned by %s before test execution", (_, filter) => {
    const { result, runs } = run(["performance", "--run", filter]);
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
    ]);
    expect(inventory.mixed_files).toEqual([]);
  });

  it("keeps one canonical generated-output and packaging authority", () => {
    const authority = fs.readFileSync(path.join(REPO_ROOT, "docs/packaging/v3-packaging.md"), "utf8");
    const contributor = fs.readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8");
    const testPolicy = fs.readFileSync(path.join(PACKAGE_ROOT, "test/README.md"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(authority).toContain("canonical authority for checkout generated output");
    expect(authority).toContain("Checkout `prepack` is a guard that rejects direct");
    expect(authority).toContain("generated:cleanup -- --force --json");
    expect(authority).toContain("singly linked regular");
    expect(authority).toContain("`ps -o lstart` on");
    expect(authority).toContain("mutation mutex serializes cleanup");
    expect(contributor).toContain("../../docs/packaging/v3-packaging.md");
    expect(testPolicy).toContain("../../../docs/packaging/v3-packaging.md");
    expect(contributor).not.toContain("Staging directories encode their owner PID");
    expect(packageJson.scripts["generated:cleanup"]).toBe("node scripts/build-package.mjs --cleanup");
  });

  it("keeps package construction separate and fast policy owner-free", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    const contract = fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml"), "utf8");
    expect(packageJson.scripts.test).toBe("pnpm run test:source");
    expect(packageJson.scripts["verify:package"]).toBe("node scripts/verify-lane.mjs package");
    expect(contract).toContain("fast: [source]");
    expect(contract).toContain("path: packages/cli/test/performance/analyticsEvidenceTierCap.test.ts");
    expect(contract).toContain("path: packages/cli/test/performance/entityMigrationPreviewCap.test.ts");
    expect(contract).toContain("path: packages/cli/test/performance/entityAuthorityPerformance.test.ts");
    expect(contract).toContain("authority: references/artifacts/state-storage-authority.yaml#entity_target.measurement_contract");
    expect(contract).toContain("stdout_format: newline_delimited_json_record_amid_runner_output");
    expect(contract).toContain("path: packages/cli/test/stress/entityStorageStress.test.ts");
    expect(contract).toContain("merge: [source, package]");
    expect(contract).toContain("scheduled: [source, stress, performance]");
    expect(contract).toContain("release: [source, stress, performance, package]");
    expect(contract).not.toMatch(/^  fast:\n/m);
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

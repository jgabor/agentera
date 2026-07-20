import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const RUNNER = path.join(PACKAGE_ROOT, "scripts/verify-lane.mjs");

function failedLane(lane: "source" | "package", forwarded: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentera-${lane}-lane-`));
  const vp = path.join(root, "vp");
  const record = path.join(root, "args.json");
  fs.writeFileSync(vp, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nexit 23\n`);
  fs.chmodSync(vp, 0o755);
  const result = spawnSync(process.execPath, [RUNNER, lane, ...forwarded], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  const args = fs.readFileSync(record, "utf8").trim().split("\n");
  fs.rmSync(root, { recursive: true, force: true });
  return { result, args };
}

describe("verification lane ownership", () => {
  it.each([
    ["source", "vite.config.ts", "package"],
    ["package", "vite.package.config.ts", "source"],
  ] as const)("labels an independently failing %s boundary without invoking %s", (lane, config, other) => {
    const { result, args } = failedLane(lane);
    expect(result.status).toBe(23);
    expect(result.stderr).toContain(`${lane} verification boundary failed`);
    expect(result.stderr).toContain(`the ${other} lane was not invoked`);
    expect(args).toEqual(["test", "run", "--config", config]);
  });

  it("assigns package construction to one setup and package-only test glob", () => {
    const sourceConfig = fs.readFileSync(path.join(PACKAGE_ROOT, "vite.config.ts"), "utf8");
    const sourceSetup = fs.readFileSync(path.join(PACKAGE_ROOT, "test/sourceSetup.ts"), "utf8");
    const packageConfig = fs.readFileSync(path.join(PACKAGE_ROOT, "vite.package.config.ts"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));

    expect(sourceConfig).toContain('exclude: ["test/packaging/**"]');
    expect(sourceConfig).toContain('globalSetup: ["./test/sourceSetup.ts"]');
    expect(sourceSetup).toContain('"--outDir", root');
    expect(sourceSetup).not.toMatch(/pnpm[^\n]*build|copy-bundle|npm["'], \["(?:pack|install)/);
    expect(packageConfig).toContain('include: ["test/packaging/*.test.ts"]');
    expect(packageConfig).toContain('globalSetup: ["./test/packaging/packageSetup.ts"]');
    expect(packageJson.scripts.test).toBe("pnpm run test:source");
    expect(packageJson.scripts["verify:package"]).toBe("node scripts/verify-lane.mjs package");
  });

  it("forwards pnpm's argument separator as a source test filter", () => {
    const { args } = failedLane("source", ["--", "test/cli/schema.test.ts"]);
    expect(args).toEqual([
      "test", "run", "--config", "vite.config.ts", "test/cli/schema.test.ts",
    ]);
  });

  it("keeps source subprocess isolation helpers free of argument pass-through wrappers", () => {
    const helper = fs.readFileSync(
      path.join(PACKAGE_ROOT, "test/helpers/sourceSubprocess.ts"),
      "utf8",
    );
    expect(helper).not.toContain("sourceSubprocessArgs");
    expect(helper).toContain("AGENTERA_SOURCE_TEST_BUILD");
  });

  it("keeps detailed command and failure matrices source-owned", () => {
    for (const relative of [
      "test/cli/activeProtocolSurface.test.ts",
      "test/upgrade/upgradeOrchestrator.test.ts",
      "test/upgrade/upgradeVerify.test.ts",
    ]) expect(fs.existsSync(path.join(PACKAGE_ROOT, relative)), relative).toBe(true);
    const packageTest = fs.readFileSync(
      path.join(PACKAGE_ROOT, "test/packaging/packageVerification.test.ts"),
      "utf8",
    );
    expect(packageTest).not.toContain("it.each");
    expect(packageTest).not.toMatch(/FAIL \(regression\)|failure matrix|command parity/i);
  });
});

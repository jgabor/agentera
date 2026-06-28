import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const SCRIPT = path.join(PKG_ROOT, "scripts", "py_ts_parity.sh");
const FIXTURE = path.join(
  PKG_ROOT,
  "test/cli/fixtures/oracle/parity-remaining-families.json",
);

function runCheck(extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [SCRIPT, "--check"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runCheckJson(extraEnv: NodeJS.ProcessEnv = {}): {
  status: number | null;
  payload: Record<string, unknown>;
} {
  const result = spawnSync("bash", [SCRIPT, "--check", "--json"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  const line = (result.stdout || "").trim().split("\n").pop() ?? "{}";
  return { status: result.status, payload: JSON.parse(line) as Record<string, unknown> };
}

describe("packages/cli/scripts/py_ts_parity.sh --check", () => {
  it("exits 0 when python_commit matches origin/main HEAD", () => {
    const mainRef = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "origin/main"], {
      encoding: "utf8",
    });
    expect(mainRef.status, mainRef.stderr).toBe(0);
    const mainHead = mainRef.stdout.trim();

    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as {
      python_commit: string;
      families: Record<string, { python_commit: string }>;
    };
    expect(fixture.python_commit).toBe(mainHead);

    const { status, stdout } = runCheck();
    expect(status).toBe(0);
    expect(stdout).toContain("drift: none");
  });

  it("exits 1 with drift:detected and rebase procedure for a divergent pin", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "py-ts-parity-"));
    const divergentFixture = path.join(tmpDir, "parity-remaining-families.json");
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    const divergentPin = "0".repeat(40);
    fixture.python_commit = divergentPin;
    const families = fixture.families as Record<string, { python_commit: string }>;
    for (const family of Object.values(families)) {
      family.python_commit = divergentPin;
    }
    fs.writeFileSync(divergentFixture, JSON.stringify(fixture, null, 2));

    const { status, stdout } = runCheck({ PY_TS_PARITY_FIXTURE: divergentFixture });
    expect(status).toBe(1);
    expect(stdout).toContain("drift: detected");
    expect(stdout).toContain("Rebase procedure:");
    expect(stdout).toContain("pnpm -C packages/cli test -- npmParityMatrix");
    expect(stdout).toContain("version_break: true");
  });

  it("emits drift:detected in --json mode for a divergent pin", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "py-ts-parity-json-"));
    const divergentFixture = path.join(tmpDir, "parity-remaining-families.json");
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    fixture.python_commit = "1".repeat(40);
    fs.writeFileSync(divergentFixture, JSON.stringify(fixture, null, 2));

    const { status, payload } = runCheckJson({ PY_TS_PARITY_FIXTURE: divergentFixture });
    expect(status).toBe(1);
    expect(payload.drift).toBe("detected");
    expect(payload.pinned).toBe("1".repeat(40));
    expect(typeof payload.main).toBe("string");
    expect(Array.isArray(payload.diff_paths)).toBe(true);
  });
});

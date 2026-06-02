import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      status: 0,
      signal: null,
      error: undefined,
      output: [Buffer.from(""), Buffer.from(""), Buffer.from("")],
      pid: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    })),
  };
});

const { runBackend } = await import("../../shim/lib/exec.mjs");
const spawnSyncMock = childProcess.spawnSync as unknown as ReturnType<typeof vi.fn>;

let tmpAppHome: string;
let tmpUserCwd: string;
let tmpRepoRoot: string;

beforeEach(() => {
  tmpAppHome = fs.mkdtempSync(path.join(os.tmpdir(), "shim-app-home-"));
  tmpUserCwd = fs.mkdtempSync(path.join(os.tmpdir(), "shim-user-cwd-"));
  tmpRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shim-repo-root-"));
  spawnSyncMock.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpAppHome, { recursive: true, force: true });
  fs.rmSync(tmpUserCwd, { recursive: true, force: true });
  fs.rmSync(tmpRepoRoot, { recursive: true, force: true });
});

/**
 * The 0.0.0 npm shim is the only published `npx -y agentera` entry point until
 * the 3.0 TypeScript CLI ships. When it spawns the installed Python CLI from
 * `$AGENTERA_HOME/app/scripts/agentera`, it MUST inherit the user's working
 * directory — the Python CLI resolves `.agentera/` artifacts from `os.getcwd()`.
 * Earlier versions spawned with `cwd` set to the app home's `app/` subdir, so
 * every `state plan`, `state todo`, `hej`, and `prime` call read from the app
 * home instead of the user's project.
 */
describe("shim runBackend cwd preservation", () => {
  it("spawns the app-home Python CLI from the user's cwd, not the app home", () => {
    const backend = {
      kind: "app-home" as const,
      scriptPath: path.join(tmpAppHome, "app", "scripts", "agentera"),
    };
    // The original buggy code derived `cwd` as `path.dirname(path.dirname(scriptPath))`,
    // which points at the app home's `app/` subdir. Anchor the test against that path
    // so the regression is unambiguous.
    const legacyAppDir = path.dirname(path.dirname(backend.scriptPath));
    expect(legacyAppDir).toBe(path.join(tmpAppHome, "app"));

    const rc = runBackend(backend, ["state", "plan", "--format", "json"], {
      cwd: tmpUserCwd,
    });

    expect(rc).toBe(0);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string },
    ];
    expect(command).toBe("uv");
    expect(args[0]).toBe("run");
    expect(args[1]).toBe(backend.scriptPath);
    expect(args.slice(2)).toEqual(["state", "plan", "--format", "json"]);
    expect(options.cwd).toBe(tmpUserCwd);
    expect(options.cwd).not.toBe(legacyAppDir);
    expect(options.cwd).not.toBe(tmpAppHome);
  });

  it("does not pass the app-home path as cwd when meta.cwd is omitted", () => {
    const backend = {
      kind: "app-home" as const,
      scriptPath: path.join(tmpAppHome, "app", "scripts", "agentera"),
    };

    const rc = runBackend(backend, ["state", "plan"]);

    expect(rc).toBe(0);
    const options = (spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string },
    ])[2];
    // The shim must never derive cwd from the script path; spawnSync falls back
    // to process.cwd() when cwd is undefined.
    expect(options.cwd).toBeUndefined();
    expect(options.cwd).not.toBe(tmpAppHome);
    expect(options.cwd).not.toBe(path.dirname(path.dirname(backend.scriptPath)));
  });

  it("keeps the repo backend anchored to its repo root, not the user cwd", () => {
    const backend = {
      kind: "repo" as const,
      repoRoot: tmpRepoRoot,
    };

    const rc = runBackend(backend, ["state", "plan"], { cwd: tmpUserCwd });

    expect(rc).toBe(0);
    const [command, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string },
    ];
    expect(command).toBe("uv");
    expect(args).toEqual(["run", "scripts/agentera", "state", "plan"]);
    expect(options.cwd).toBe(tmpRepoRoot);
    expect(options.cwd).not.toBe(tmpUserCwd);
  });
});

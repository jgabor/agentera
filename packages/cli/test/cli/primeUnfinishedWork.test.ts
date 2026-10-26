import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createEntityAuthorityFixture } from "../helpers/entityAuthorityFixture.js";
import { main } from "../../src/cli/dispatch/index.js";
import { readUnfinishedWork } from "../../src/cli/orientation/unfinishedWork.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUTHORITY = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8"));
const SECRET_NAME = "zebra-unfinished-name.txt";
const SECRET_CONTENT = "kumquat-unfinished-content-9431";

let tmp: string;
let project: string;
let home: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-unfinished-"));
  project = path.join(tmp, "project");
  home = path.join(tmp, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  previousCwd = process.cwd();
  previousEnv = {
    AGENTERA_BOOTSTRAP_SOURCE_ROOT: process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT,
    AGENTERA_HOME: process.env.AGENTERA_HOME,
    HOME: process.env.HOME,
  };
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.AGENTERA_HOME = path.join(home, "agentera");
  process.env.HOME = home;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
  expect(result.status, result.stderr).toBe(0);
}

function committedProject(): void {
  createEntityAuthorityFixture(project, 25, AUTHORITY);
  fs.writeFileSync(path.join(project, "notes.md"), "notes\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
}

function run(args: string[], stdin?: string): string {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], {
    out: (text) => (out += text),
    err: (text) => (err += text),
    ...(stdin === undefined ? {} : { stdin: () => stdin }),
  });
  expect(rc, err || out).toBe(0);
  return out;
}

const statusNextAction = () => JSON.parse(run(["prime", "--context", "status"])).capability_context.context.status_context.next_action;

describe("prime suggests resuming unfinished work", () => {
  it("leads with resuming uncommitted work on a feature branch, naming branch, count, capability and reason", () => {
    committedProject();
    const clean = statusNextAction();
    git("checkout", "-q", "-b", "feat/resume-me");
    fs.appendFileSync(path.join(project, "notes.md"), "more\n");
    fs.writeFileSync(path.join(project, SECRET_NAME), SECRET_CONTENT);

    const next = statusNextAction();
    expect(next).toMatchObject({
      object: "Resume unfinished work on feat/resume-me",
      capability: "build",
      phase: "build",
      reason: "2 changed files are uncommitted on feat/resume-me; finish or commit them before starting new work.",
      unfinished_work: { branch: "feat/resume-me", changed_files: 2 },
    });
    const bare = JSON.parse(run(["prime"])).next_action;
    expect(bare.unfinished_work).toEqual({ branch: "feat/resume-me", changed_files: 2 });
    expect(bare.object).toBe(next.object);
    expect(next.alternatives.length).toBeGreaterThan(0);
    expect(next.alternatives[0].object).toBe(clean.object);
  });

  it("ignores changes under .agentera, which capabilities write routinely", () => {
    committedProject();
    git("checkout", "-q", "-b", "feat/state-only");
    fs.mkdirSync(path.join(project, ".agentera", "entities"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agentera", "entities", "routine.yaml"), "id: routine\n");

    expect(statusNextAction()).not.toHaveProperty("unfinished_work");
  });

  it("routes a clean working tree exactly as a project outside Git", () => {
    createEntityAuthorityFixture(project, 25, AUTHORITY);
    const outsideGit = statusNextAction();
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");

    const clean = statusNextAction();
    expect(clean).toEqual(outsideGit);
    expect(clean).not.toHaveProperty("unfinished_work");
  });

  it("emits no changed file name or content in bare, status or routed starts", () => {
    committedProject();
    git("checkout", "-q", "-b", "feat/private");
    fs.writeFileSync(path.join(project, SECRET_NAME), SECRET_CONTENT);
    const outputs = [run(["prime"]), run(["prime", "--context", "status"]), run(["prime", "--input", "-"], JSON.stringify({ version: "agentera.route_request.v1", request: "/agentera" }))];
    for (const output of outputs) {
      expect(output).toContain("feat/private");
      expect(output).not.toContain("zebra-unfinished");
      expect(output).not.toContain(SECRET_CONTENT);
    }
  });

  it("counts a rename once and an untracked directory as one change", () => {
    committedProject();
    git("mv", "notes.md", "renamed.md");
    fs.mkdirSync(path.join(project, "scratch"));
    for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(project, "scratch", name), name);
    expect(readUnfinishedWork(project)).toEqual({ branch: "main", changed_files: 2 });
  });

  it("reports no unfinished work outside a Git repository", () => {
    fs.writeFileSync(path.join(project, SECRET_NAME), SECRET_CONTENT);
    expect(readUnfinishedWork(project)).toBeNull();
  });

  it("reports no unfinished work before the first commit", () => {
    createEntityAuthorityFixture(project, 25, AUTHORITY);
    git("init", "-q", "-b", "main");
    expect(readUnfinishedWork(project)).toBeNull();
  });

  it("names a detached HEAD", () => {
    committedProject();
    git("checkout", "-q", "--detach");
    fs.writeFileSync(path.join(project, SECRET_NAME), SECRET_CONTENT);
    expect(readUnfinishedWork(project)).toEqual({ branch: "detached HEAD", changed_files: 1 });
  });

  it("keeps a start with many changed files within the startup latency target", { timeout: 60_000 }, () => {
    createEntityAuthorityFixture(project, 25, AUTHORITY);
    const bulk = path.join(project, "bulk");
    fs.mkdirSync(bulk);
    for (let index = 0; index < 3000; index += 1) fs.writeFileSync(path.join(bulk, `file-${index}.txt`), "before\n");
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    for (let index = 0; index < 3000; index += 1) fs.writeFileSync(path.join(bulk, `file-${index}.txt`), "after\n");

    const started = performance.now();
    const next = statusNextAction();
    const elapsed = performance.now() - started;
    expect(next.unfinished_work).toEqual({ branch: "main", changed_files: 3000 });
    expect(elapsed).toBeLessThan(AUTHORITY.entity_target.measurement_contract.targets.startup_small.max_latency_ms);
  });
});

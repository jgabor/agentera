import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { EntityPublicationContext } from "../../src/state/entityPublicationContext.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import { detectStateMode } from "../../src/state/stateMode.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const roots: string[] = [];
let previousEnvironment: Record<string, string | undefined>;

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-fresh-plan-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function snapshot(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      hash.update(path.relative(root, target)).update(entry.isDirectory() ? "directory" : "file");
      if (entry.isDirectory()) visit(target);
      else hash.update(fs.readFileSync(target));
    }
  };
  visit(root);
  return hash.digest("hex");
}

function planInput(title = "Initialize fresh project"): string {
  return JSON.stringify({
    header: { level: "light", created: "2026-08-10", status: "open", title },
    what: "Establish canonical Plan state without adopting project-owned documents.",
    why: "Fresh Plan creation must publish one complete entity graph.",
    scope: { included: ["fresh Plan initialization"], excluded: ["legacy migration"] },
    tasks: [
      {
        number: 1,
        name: "Publish first task",
        status: "pending",
        depends_on: [],
        acceptance: ["GIVEN fresh state WHEN Plan publishes THEN entities are canonical"],
      },
      {
        number: 2,
        name: "Verify marker",
        status: "pending",
        depends_on: [1],
        acceptance: ["GIVEN entities publish WHEN marker activates THEN Plan is operable"],
      },
    ],
  });
}

function capture(root: string, args: string[], stdin = ""): { rc: number; out: string; err: string; json: Record<string, any> | null } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...args], {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      stdin: () => stdin,
    });
    return { rc, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
  } finally {
    process.chdir(previous);
  }
}

function userFiles(root: string): Map<string, Buffer> {
  const files = new Map([
    ["README.md", Buffer.from("# Existing project\n")],
    ["config.json", Buffer.from('{"enabled":true}\n')],
  ]);
  for (const [name, bytes] of files) fs.writeFileSync(path.join(root, name), bytes);
  return files;
}

beforeEach(() => {
  previousEnvironment = Object.fromEntries(["AGENTERA_BOOTSTRAP_SOURCE_ROOT", "AGENTERA_HOME", "AGENTERA_PROFILE_DIR", "PROFILERA_PROFILE_DIR", "HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].map((name) => [name, process.env[name]]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-fresh-plan-home-"));
  roots.push(home);
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.AGENTERA_HOME = path.join(home, "agentera");
  process.env.AGENTERA_PROFILE_DIR = path.join(home, "profile");
  process.env.PROFILERA_PROFILE_DIR = path.join(home, "profile");
  process.env.HOME = home;
  process.env.XDG_CACHE_HOME = path.join(home, "cache");
  process.env.XDG_CONFIG_HOME = path.join(home, "config");
  process.env.XDG_DATA_HOME = path.join(home, "data");
  process.env.XDG_STATE_HOME = path.join(home, "state");
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("fresh Plan initialization", () => {
  it("keeps unrelated user files unchanged through read-only startup and atomic Plan publication", () => {
    const root = project();
    const existingFiles = userFiles(root);
    const before = snapshot(root);

    const startup = capture(root, ["prime", "--context", "plan", "--format", "json"]);
    expect(startup.rc, startup.err).toBe(0);
    expect(startup.json?.capability_context.startup).toMatchObject({
      outcome: "ok",
      state_cutover: {
        status: "fresh_uninitialized",
        project_state: "fresh_uninitialized",
        recovery_command: null,
      },
    });
    expect(startup.out).not.toContain("upgrade --yes");
    expect(snapshot(root)).toBe(before);

    const dryRun = capture(root, ["state", "plan", "create", "--input", "-", "--dry-run", "--format", "json"], planInput());
    expect(dryRun.rc, dryRun.err).toBe(0);
    expect(dryRun.json).toMatchObject({
      operation: { dry_run: true },
      initialization: {
        atomic: true,
        marker: {
          path: path.join(root, ".agentera", "state-mode.yaml"),
          record: { schemaVersion: "agentera.stateMode.v1", mode: "entities" },
        },
      },
      tasks: expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^[a-z]{10}$/) })]),
    });
    expect(snapshot(root)).toBe(before);

    const applied = capture(root, ["state", "plan", "create", "--input", "-", "--format", "json"], planInput());
    expect(applied.rc, applied.err || applied.out).toBe(0);
    expect(applied.json?.initialization.marker.record).toEqual({
      schemaVersion: "agentera.stateMode.v1",
      mode: "entities",
    });
    expect(detectStateMode(root)).toBe("entities");
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 3 });
    for (const [name, bytes] of existingFiles) expect(fs.readFileSync(path.join(root, name))).toEqual(bytes);

    const initialized = capture(root, ["prime", "--context", "plan", "--format", "json"]);
    expect(initialized.rc, initialized.err).toBe(0);
    expect(initialized.json?.capability_context.startup.outcome).toBe("ok");
    expect(initialized.json?.capability_context.startup.state_cutover).toMatchObject({
      status: "complete",
      project_state: "v3",
    });
    expect(initialized.out).not.toContain("upgrade --yes");
  });

  it("leaves no marker or entities after validation or publication failure", () => {
    const invalidRoot = project();
    const invalidBefore = snapshot(invalidRoot);
    const invalid = capture(invalidRoot, ["state", "plan", "create", "--input", "-", "--format", "json"], "{}");
    expect(invalid.rc).not.toBe(0);
    expect(snapshot(invalidRoot)).toBe(invalidBefore);

    const failingRoot = project();
    const failingBefore = snapshot(failingRoot);
    const original = EntityPublicationContext.prototype.publishImmutable;
    let publications = 0;
    vi.spyOn(EntityPublicationContext.prototype, "publishImmutable").mockImplementation(function (target, bytes) {
      publications += 1;
      if (publications === 2) throw new Error("injected fresh Plan publication failure");
      return original.call(this, target, bytes);
    });
    const failed = capture(failingRoot, ["state", "plan", "create", "--input", "-", "--format", "json"], planInput("Rollback fresh Plan"));
    expect(failed.rc).not.toBe(0);
    expect(failed.err).toContain("injected fresh Plan publication failure");
    expect(snapshot(failingRoot)).toBe(failingBefore);
  });

  it("keeps legacy and unknown marker-absent recovery distinct and other writers uninitialized", () => {
    const fresh = project();
    const freshBefore = snapshot(fresh);
    const otherWriter = capture(
      fresh,
      ["state", "progress", "append", "--input", "-", "--format", "json"],
      JSON.stringify({
        type: "test",
        phase: "build",
        what: "blocked",
        context: { intent: "prove Plan-only initialization" },
      }),
    );
    expect(otherWriter.rc).toBe(1);
    expect(otherWriter.json?.error).toMatchObject({
      class: "fresh_initialization_required",
      recovery: expect.stringContaining("state plan create"),
    });
    expect(snapshot(fresh)).toBe(freshBefore);

    const legacy = project();
    fs.mkdirSync(path.join(legacy, ".agentera"));
    fs.writeFileSync(path.join(legacy, ".agentera", "plan.yaml"), "header: {}\n");
    fs.writeFileSync(path.join(legacy, ".agentera", "progress.yaml"), "cycles: []\n");
    const legacyBefore = snapshot(legacy);
    const legacyResult = capture(legacy, ["prime", "--context", "plan", "--format", "json"]);
    expect(legacyResult.rc).toBe(1);
    expect(legacyResult.json?.error).toMatchObject({
      class: "migration_required",
      recovery: expect.stringContaining("upgrade"),
    });
    expect(legacyResult.json?.error.recovery).toContain("--yes");
    expect(snapshot(legacy)).toBe(legacyBefore);

    const unknown = project();
    fs.mkdirSync(path.join(unknown, ".agentera"));
    fs.writeFileSync(path.join(unknown, ".agentera", "unrecognized.yaml"), "retain: true\n");
    const unknownBefore = snapshot(unknown);
    const unknownResult = capture(unknown, ["state", "plan", "create", "--input", "-", "--format", "json"], planInput("Must not adopt unknown state"));
    expect(unknownResult.rc).toBe(1);
    expect(unknownResult.json?.error).toMatchObject({
      class: "migration_required",
      recovery: expect.stringContaining("upgrade"),
    });
    expect(unknownResult.json?.error.recovery).toContain("--dry-run");
    expect(unknownResult.out).not.toContain("upgrade --yes");
    expect(snapshot(unknown)).toBe(unknownBefore);
  });
});

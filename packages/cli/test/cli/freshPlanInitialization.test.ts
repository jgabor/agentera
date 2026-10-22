import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
    expect(otherWriter.json?.error.recovery).toContain("init --project");
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

function stateFiles(root: string): string[] {
  const agentera = path.join(root, ".agentera");
  if (!fs.existsSync(agentera)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      found.push(path.relative(root, target) + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) visit(target);
    }
  };
  visit(agentera);
  return found.sort();
}

const VISION = [
  "project_name: Reading list",
  "north_star: |",
  "  `reading-list add URL` saves a link in under 200 ms so readers on the train keep one list.",
  "personas:",
  "  - name: The busy reader",
  "    description: Reads on the train and runs `reading-list add` from the phone terminal.",
  "principles:",
  "  - name: Fast over complete",
  "    description: A 200 ms save beats a perfect catalog.",
  "direction: Ship `reading-list add` and `reading-list show` first, then sync.",
  "",
].join("\n");

describe("init", () => {
  it("previews every write without writing, then applies exactly those writes after --yes", () => {
    const root = project();
    const existingFiles = userFiles(root);
    const before = snapshot(root);

    const preview = capture(root, ["init"]);
    expect(preview.rc, preview.out).toBe(0);
    expect(preview.json).toMatchObject({ command: "init", status: "preview", changed: false, project_state: "fresh_uninitialized", apply_command: expect.stringContaining("init --project") });
    expect(preview.json?.apply_command).toMatch(/--yes$/);
    expect(preview.json?.writes).toEqual([{ path: ".agentera/state-mode.yaml", action: "create", content: { schemaVersion: "agentera.stateMode.v1", mode: "entities" } }]);
    expect(snapshot(root)).toBe(before);

    const applied = capture(root, ["init", "--yes"]);
    expect(applied.rc, applied.out).toBe(0);
    expect(applied.json).toMatchObject({ status: "initialized", changed: true, project_state: "v3", writes: preview.json?.writes, next_step: { capability: "vision" } });
    expect(stateFiles(root)).toEqual([".agentera/state-mode.yaml"]);
    expect(fs.readFileSync(path.join(root, ".agentera", "state-mode.yaml"), "utf8")).toBe("schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    expect(detectStateMode(root)).toBe("entities");
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 0 });
    for (const [name, bytes] of existingFiles) expect(fs.readFileSync(path.join(root, name))).toEqual(bytes);
  });

  it("refuses initialized, legacy, partial, unknown, corrupt and non-Git-root projects without writing", () => {
    const cases: Array<{ name: string; setup: (root: string) => string; error: string; recovery: string }> = [
      { name: "initialized", setup: (root) => (capture(root, ["init", "--yes"]), root), error: "already_initialized", recovery: "prime" },
      {
        name: "legacy",
        setup: (root) => {
          fs.mkdirSync(path.join(root, ".agentera"));
          fs.writeFileSync(path.join(root, ".agentera", "plan.yaml"), "header: {}\n");
          fs.writeFileSync(path.join(root, ".agentera", "progress.yaml"), "cycles: []\n");
          return root;
        },
        error: "migration_required",
        recovery: "--dry-run",
      },
      { name: "partial", setup: (root) => (fs.mkdirSync(path.join(root, ".agentera", "entities"), { recursive: true }), root), error: "partial_state", recovery: "--dry-run" },
      { name: "unknown", setup: (root) => (fs.mkdirSync(path.join(root, ".agentera")), fs.writeFileSync(path.join(root, ".agentera", "vision.yaml"), VISION), root), error: "unknown_state", recovery: "--dry-run" },
      { name: "corrupt", setup: (root) => (fs.mkdirSync(path.join(root, ".agentera")), fs.writeFileSync(path.join(root, ".agentera", "state-mode.yaml"), "schemaVersion: wrong\n"), root), error: "corrupt_state", recovery: "doctor" },
      { name: "git subdirectory", setup: (root) => (fs.mkdirSync(path.join(root, "sub")), path.join(root, "sub")), error: "not_git_root", recovery: "init --project" },
    ];
    for (const item of cases) {
      const root = project();
      const cwd = item.setup(root);
      const before = snapshot(root);
      const refused = capture(cwd, ["init", "--yes"]);
      expect(refused.rc, item.name).toBe(1);
      expect(refused.json?.error, item.name).toMatchObject({ class: item.error, recovery: expect.stringContaining(item.recovery) });
      expect(snapshot(root), item.name).toBe(before);
      if (item.name === "git subdirectory") {
        expect(refused.json?.error.recovery).toContain(fs.realpathSync(root));
        expect(refused.json?.error.recovery).not.toContain("git init");
      }
    }
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-init-nongit-"));
    roots.push(nonGit);
    const nonGitResult = capture(nonGit, ["init", "--yes"]);
    expect(nonGitResult.json?.error).toMatchObject({ class: "not_git_root", recovery: expect.stringContaining("git init") });
    expect(fs.readdirSync(nonGit)).toEqual([]);

    const invalid = capture(project(), ["init", "--force"]);
    expect(invalid.rc).toBe(2);
    expect(invalid.json?.error).toMatchObject({ class: "unrecognized_argument" });
  });

  it("resolves a race with plan creation to one complete state and one refusal", () => {
    const original = EntityPublicationContext.prototype.publishImmutable;
    const marker = EntityPublicationContext.prototype.publishStateMarker;
    const createPlan = (root: string, title: string) => capture(root, ["state", "plan", "create", "--input", "-", "--format", "json"], planInput(title));

    // init checked freshness first and links its marker while plan creation publishes entities.
    const initFirst = project();
    let losingPlan: ReturnType<typeof capture> | undefined;
    let initMarker: ReturnType<typeof marker> | undefined;
    const markerSpy = vi.spyOn(EntityPublicationContext.prototype, "publishStateMarker").mockImplementation(function (this: EntityPublicationContext, bytes) {
      if (losingPlan || initMarker) return marker.call(this, bytes);
      const publishInitMarker = marker.bind(this, bytes);
      const immutable = vi.spyOn(EntityPublicationContext.prototype, "publishImmutable").mockImplementation(function (this: EntityPublicationContext, target, entityBytes) {
        initMarker ??= publishInitMarker();
        return original.call(this, target, entityBytes);
      });
      losingPlan = createPlan(initFirst, "Lose the race");
      immutable.mockRestore();
      return initMarker ?? marker.call(this, bytes);
    });
    const winningInit = capture(initFirst, ["init", "--yes"]);
    markerSpy.mockRestore();
    expect(winningInit.rc, winningInit.out).toBe(0);
    expect(losingPlan?.rc).not.toBe(0);
    expect(`${losingPlan?.out}${losingPlan?.err}`).toContain("init and state plan create are the two initializers");
    expect(stateFiles(initFirst)).toEqual([".agentera/state-mode.yaml"]);
    expect(validateEntityState(initFirst)).toMatchObject({ valid: true, entityCount: 0 });
    expect(createPlan(initFirst, "Plan after init").rc).toBe(0);

    // plan creation publishes its marker after init checked freshness.
    const planFirst = project();
    let winningPlan: ReturnType<typeof capture> | undefined;
    const lateMarker = vi.spyOn(EntityPublicationContext.prototype, "publishStateMarker").mockImplementation(function (this: EntityPublicationContext, bytes) {
      winningPlan ??= createPlan(planFirst, "Win the race");
      return marker.call(this, bytes);
    });
    const losingInit = capture(planFirst, ["init", "--yes"]);
    lateMarker.mockRestore();
    expect(winningPlan?.rc, winningPlan?.out).toBe(0);
    expect(losingInit.rc).toBe(1);
    expect(losingInit.json?.error).toMatchObject({ class: "initialization_conflict", recovery: expect.stringContaining("prime") });
    expect(validateEntityState(planFirst)).toMatchObject({ valid: true, entityCount: 3 });

    // init starts while plan creation holds the project writer lock.
    const locked = project();
    let lockedInit: ReturnType<typeof capture> | undefined;
    const during = vi.spyOn(EntityPublicationContext.prototype, "publishImmutable").mockImplementation(function (this: EntityPublicationContext, target, bytes) {
      lockedInit ??= capture(locked, ["init", "--yes"]);
      return original.call(this, target, bytes);
    });
    const lockedPlan = createPlan(locked, "Hold the lock");
    during.mockRestore();
    expect(lockedPlan.rc, lockedPlan.out).toBe(0);
    expect(lockedInit?.rc).toBe(1);
    expect(lockedInit?.json?.error.class).toBe("initialization_conflict");
    expect(validateEntityState(locked)).toMatchObject({ valid: true, entityCount: 3 });
  });

  it("lets vision start, self-check and save after init, and status and plan creation read the project", () => {
    const fresh = project();
    const refusedVision = capture(fresh, ["prime", "--context", "vision", "--format", "json"]);
    expect(refusedVision.rc).toBe(1);
    expect(refusedVision.json?.error).toMatchObject({ class: "fresh_initialization_required", recovery: expect.stringContaining("init --project") });
    expect(refusedVision.json?.error.recovery).toContain("state plan create");

    const root = project();
    expect(capture(root, ["init", "--yes"]).rc).toBe(0);
    const vision = capture(root, ["prime", "--context", "vision", "--format", "json"]);
    expect(vision.rc, vision.err).toBe(0);
    expect(vision.json?.capability_context.startup.outcome).toBe("ok");
    const draft = path.join(root, "vision-draft.yaml");
    fs.writeFileSync(draft, VISION);
    const lint = capture(root, ["check", "lint", "--artifact", "vision", "--file", draft, "--format", "json"]);
    expect(lint.rc, lint.out).toBe(0);
    expect(lint.json?.status).toBe("pass");
    fs.renameSync(draft, path.join(root, ".agentera", "vision.yaml"));
    expect(capture(root, ["state", "query", "vision", "--format", "json"]).json?.status).toBe("ok");
    const status = capture(root, ["prime", "--context", "status", "--format", "json"]);
    expect(status.rc, status.err).toBe(0);
    expect(status.json?.capability_context.startup.outcome).toBe("ok");
    const plan = capture(root, ["state", "plan", "create", "--input", "-", "--format", "json"], planInput("Plan after vision"));
    expect(plan.rc, plan.out).toBe(0);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 3 });
  });

  it("is listed in help, schema and its own help", () => {
    const root = project();
    const help = capture(root, ["--help"]);
    expect(help.out).toMatch(/\{prime,init,/);
    const own = capture(root, ["init", "--help"]);
    expect(own.rc).toBe(0);
    expect(own.out).toContain("usage: agentera init [-h] [--project PROJECT] [--yes]");
    const schema = capture(root, ["schema", "--format", "json"]);
    expect(schema.json?.dispatcher_top_level.commands).toContain("init");
    expect(schema.json?.commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: "init", kind: "initialization" })]));
  });
});
